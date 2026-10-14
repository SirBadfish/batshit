/**
 * BL-474 step 2: the reply-end decision of where each outside picture address of a reply came from.
 * send-routed hands it what the turn delivered to the model (the compile's labelled pieces, its own
 * post-compile addenda, the run's tool results as delivered, the delivered steers) and the chat's
 * stored decisions; it builds the turn's record (`imageAddressOrigin.ts`) and decides every picture
 * address of the saved reply text. Pure apart from the reply parser; no Redis here.
 */
import * as cheerio from 'cheerio'
import { parseMessageContent } from '$lib/utils/messageFormatter'
import {
  buildImageAddressRecord,
  classifyImageAddressOrigins,
  toAddressMatchForms,
  type AddressSourcePiece
} from '$lib/utils/imageAddressOrigin'
import { formatSteerForModel, type SteerEntry } from '$lib/utils/steerControl'
import { isToolModelCutView } from '$lib/utils/toolModelTextSizeGuard'
import { sha256Hex } from '$lib/utils/sha256'
import type {
  DecidedImageOriginRecord,
  ImageOriginAddressDecision,
  ImageOriginLane,
  ImageOriginRecord
} from '$lib/utils/imageOriginRecord'
import { classifyImageSource, type ImageSourceContext } from '$lib/utils/imageSource'
import type { CompiledAddressSources } from '$lib/services/databaseRedis.server'

const CHEERIO_OPTIONS = { xml: { xmlMode: false, decodeEntities: true } } as const

/**
 * The one entity-decoding step for an address token of the record: the reply parser's own decoding
 * of an attribute value (Cheerio, as `messageFormatter.ts` loads a tag), so a record address and a
 * reply address are decoded alike.
 */
export function decodeAddressToken(token: string): string {
  if (!token.includes('&')) return token
  const $ = cheerio.load(`<root><img src="${token.replace(/"/g, '&quot;')}"></root>`, CHEERIO_OPTIONS)
  return $('img').attr('src') ?? ''
}

/**
 * Every picture address in a reply's own text, as the page's parser reads it (`parseMessageContent`,
 * entity-decoded once). A picture inside a zip, a tool card, or a Clip is not the reply's words
 * (gap 2 of the build note): it keeps step 1's box and is never judged here.
 */
export function replyPictureAddresses(content: string, context: ImageSourceContext = { baseUrl: 'http://127.0.0.1/', serverUrls: [] }): string[] {
  const addresses = new Set<string>()
  for (const segment of parseMessageContent(content, 'assistant')) {
    // This is the raw saved reply. A model-written zip attribute proves nothing; real zip
    // references are batshit/cool_tool segments and hydrated tool pictures are not in this scan.
    if (segment.type !== 'image') continue
    const src = typeof segment.src === 'string' ? segment.src.trim() : ''
    if (src && classifyImageSource(src, context).kind === 'outside') addresses.add(src)
  }
  return [...addresses]
}

/** What one run delivered to the model beyond its compile, and what Batshit could not account for. */
export type RunDelivery = {
  /** Actual dispatch input was observed, or a managed raw result event arrived. */
  observed: boolean
  pieces: AddressSourcePiece[]
  /** Image and file parts the model got in the run (tool-result pictures, a synthetic picture message). */
  nonTextInputs: number
  /** Tool results the in-turn guard cut before the model read them. */
  cutResults: number
  /** Tool calls the provider ran on its side (its own web search, say). */
  providerExecutedTools: number
  /** Unknown or unmatched input cannot make an API turn complete. */
  unaccountedInputs: number
}

export function emptyRunDelivery(observed = false): RunDelivery {
  return { observed, pieces: [], nonTextInputs: 0, cutResults: 0, providerExecutedTools: 0, unaccountedInputs: 0 }
}

/** The texts of one delivered tool output; a part that is not text is counted, never read. */
function textsOfToolOutput(output: any, delivery: RunDelivery): string[] {
  if (!output || typeof output !== 'object') { delivery.unaccountedInputs += 1; return [] }
  switch (output.type) {
    case 'text':
    case 'error-text':
      if (typeof output.value !== 'string') { delivery.unaccountedInputs += 1; return [] }
      return [output.value]
    case 'json':
    case 'error-json':
      if (!Object.hasOwn(output, 'value')) { delivery.unaccountedInputs += 1; return [] }
      return [JSON.stringify(output.value)]
    case 'execution-denied':
      return typeof output.reason === 'string' ? [output.reason] : []
    case 'content': {
      const texts: string[] = []
      if (!Array.isArray(output.value)) { delivery.unaccountedInputs += 1; return [] }
      for (const part of output.value) {
        if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
        else delivery.nonTextInputs += 1
      }
      return texts
    }
    default:
      // A shape this code does not know was delivered all the same: it cannot be accounted for.
      delivery.nonTextInputs += 1
      return []
  }
}

/**
 * The API lane: the actual V4 dispatch prompt, including converted approval replay and guarded
 * results. Assistant-authored text/reasoning/call arguments are not read; their nontext or unknown
 * parts still prevent completeness.
 */
export function readApiRunMessages(messages: readonly any[], options: {
  imageInputsRegistered: number
  /** Actual converted user-part positions, labelled by server-owned composition sidecars. */
  userPieces?: ReadonlyMap<string, AddressSourcePiece[] | null>
}): RunDelivery {
  const delivery = emptyRunDelivery(true)
  delivery.nonTextInputs += Math.max(0, options.imageInputsRegistered)
  const calls = new Set<string>()
  const results = new Set<string>()
  messages.forEach((message, messageIndex) => {
    const parts = typeof message?.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message?.content) ? message.content : null
    if (!parts) { delivery.unaccountedInputs += 1; return }
    if (message.role === 'system') {
      if (typeof message.content !== 'string') delivery.unaccountedInputs += 1
      return
    }
    parts.forEach((part: any, partIndex: number) => {
      if (part?.providerExecuted === true) delivery.providerExecutedTools += 1
      if (message.role === 'assistant') {
        if (part?.type === 'tool-call') {
          if (typeof part.toolCallId === 'string' && part.toolCallId) calls.add(part.toolCallId)
          else delivery.unaccountedInputs += 1
        } else if (part?.type === 'file' || part?.type === 'image' || part?.type === 'reasoning-file') {
          delivery.nonTextInputs += 1
        } else if ((part?.type !== 'text' && part?.type !== 'reasoning') || typeof part.text !== 'string') {
          delivery.unaccountedInputs += 1
        }
        return // text, reasoning and call arguments are the model's own words
      }
      if (message.role === 'user') {
        if (part?.type !== 'text') { delivery.nonTextInputs += 1; return }
        const labelled = options.userPieces?.get(`${messageIndex}:${partIndex}`)
        if (labelled === undefined || labelled === null) delivery.unaccountedInputs += 1
        else delivery.pieces.push(...labelled)
        return
      }
      if (message.role === 'tool' && part?.type === 'tool-result') {
        if (typeof part.toolCallId === 'string' && part.toolCallId) results.add(part.toolCallId)
        else delivery.unaccountedInputs += 1
        for (const text of textsOfToolOutput(part.output, delivery)) {
          if (isToolModelCutView(text)) delivery.cutResults += 1
          delivery.pieces.push({ source: 'tool_result', text })
        }
        return
      }
      delivery.unaccountedInputs += 1
    })
  })
  for (const call of calls) if (!results.has(call)) delivery.unaccountedInputs += 1
  for (const result of results) if (!calls.has(result)) delivery.unaccountedInputs += 1
  return delivery
}

/** Raw CLI events only: display-enriched steps are never delivery evidence. */
export function appendCliModelResult(delivery: RunDelivery, result: {
  callId: string; texts: readonly string[]; nonTextInputs: number; unaccountedInputs: number
}): void {
  delivery.observed = true
  delivery.nonTextInputs += result.nonTextInputs
  delivery.unaccountedInputs += result.unaccountedInputs
  for (const text of result.texts) {
    if (isToolModelCutView(text)) delivery.cutResults += 1
    delivery.pieces.push({ source: 'tool_result', text })
  }
}

/** The delivered steers, in the words the model read (`formatSteerForModel`). */
export function steerPieces(steers: readonly SteerEntry[]): AddressSourcePiece[] {
  return steers.map((steer) => ({
    // A DM steer is another agent's words (not read); the user's steer is the user's.
    source: steer.source === 'dm' ? 'agent_note' : 'user',
    text: formatSteerForModel(steer)
  }))
}

/** For each earlier reply, the match forms its server-decided record judged `as_read`. */
export function earlierAsReadAddresses(
  records: Record<string, ImageOriginRecord>,
  currentMessageId: string
): Map<string, Set<string>> {
  const vouched = new Map<string, Set<string>>()
  for (const [messageId, record] of Object.entries(records)) {
    if (messageId === currentMessageId || record.state !== 'decided') continue
    const forms = new Set<string>()
    for (const [address, decision] of Object.entries(record.addresses)) {
      if (decision.state === 'as_read') for (const form of toAddressMatchForms(address)) forms.add(form)
    }
    if (forms.size > 0) vouched.set(messageId, forms)
  }
  return vouched
}

export type ReplyImageOriginInput = {
  messageId: string
  version: number
  lane: ImageOriginLane
  /** The reply texts the page can show: as saved, and as `end` carries it when that differs. */
  replyTexts: readonly string[]
  imageSourceContext?: ImageSourceContext
  /** The compile's labelled pieces; null when the compile is not known (nothing is then read). */
  compiled: CompiledAddressSources | null
  /** send-routed's own text added to the system prompt after the compile. */
  addenda: readonly string[]
  run: RunDelivery
  steers: readonly SteerEntry[]
  /** The chat's stored records (for the earlier replies' as-read addresses). */
  storedRecords: Record<string, ImageOriginRecord>
}

/** Whether Batshit accounted for every input of the turn (only ever on the API lane). */
export function isTurnComplete(input: Pick<ReplyImageOriginInput, 'lane' | 'compiled' | 'run'>): boolean {
  return (
    input.lane === 'api' &&
    input.compiled !== null &&
    input.compiled.nonTextInputs === 0 &&
    input.compiled.unaccountedInputs === 0 &&
    input.run.observed &&
    input.run.nonTextInputs === 0 &&
    input.run.cutResults === 0 &&
    input.run.providerExecutedTools === 0 &&
    input.run.unaccountedInputs === 0
  )
}

/** The decided record of one reply end. */
export function decideReplyImageOrigins(input: ReplyImageOriginInput): DecidedImageOriginRecord {
  if (input.compiled && input.compiled.unaccountedInputs !== 0) {
    throw new Error('The compiled address-source ledger is missing; the reply remains pending.')
  }
  const complete = isTurnComplete(input)
  const texts = [...new Set(input.replyTexts)]
  const addresses = [...new Set(texts.flatMap((text) => replyPictureAddresses(text, input.imageSourceContext)))]
  const byAddress: Record<string, ImageOriginAddressDecision> = {}
  // Most replies have no outside pictures: keep their empty decision and text binding without
  // scanning and entity-decoding all the model's inputs (BL-1024).
  if (addresses.length > 0) {
    const pieces: AddressSourcePiece[] = [
      ...(input.compiled?.pieces ?? []),
      ...input.addenda.filter((text) => text.length > 0).map((text) => ({ source: 'batshit' as const, text })),
      ...input.run.pieces,
      ...steerPieces(input.steers)
    ]
    const record = buildImageAddressRecord(pieces, {
      complete,
      earlierAsRead: earlierAsReadAddresses(input.storedRecords, input.messageId),
      decode: decodeAddressToken
    })
    const context = input.imageSourceContext ?? { baseUrl: 'http://127.0.0.1/', serverUrls: [] }
    const decisions = classifyImageAddressOrigins(addresses.map((address) => {
      // Keep raw parsed src as the persisted key. Judge relative paths with the same resolved
      // browser request URL; protocol-relative addresses retain the approved dual-scheme rule.
      if (address.startsWith('//')) return address
      const source = classifyImageSource(address, context)
      return source.kind === 'outside' ? source.url : address
    }), record)
    addresses.forEach((address, index) => {
      byAddress[address] = { state: decisions[index].state, rule: decisions[index].rule, evidence: decisions[index].evidence }
    })
  }
  return {
    messageId: input.messageId,
    version: input.version,
    state: 'decided',
    textHashes: texts.map((text) => sha256Hex(text)),
    lane: input.lane,
    complete,
    addresses: byAddress
  }
}
