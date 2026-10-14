/** BL-474: provenance sidecars never alter or duplicate the SDK's replay transcript. */
import { sha256Hex } from '$lib/utils/sha256'
import { buildSteerInjectionText, formatSteerForModel, type SteerEntry } from '$lib/utils/steerControl'
import type { AddressSourcePiece } from '$lib/utils/imageAddressOrigin'
import { emptyRunDelivery, readApiRunMessages, type RunDelivery } from './imageAddressTurnRecord'

export type UserInputSource = {
  textHash: string
  spans: Array<{ start: number; end: number; source: 'user' | 'agent_note' }>
}
export type ApiInputObservation = {
  /** Frozen original cache-policy messages, never prepareStep's replacement list. */
  compiledMessages: readonly any[]
  promptMessages: unknown
  toolDefinitions?: readonly any[]
  compiledPrefixCount: number
  initialSystem: unknown
  userSources: readonly UserInputSource[]
}

/** Registered only while the server constructs a real steer injection. */
export function steerInputSource(steers: readonly SteerEntry[]): UserInputSource {
  const spans: UserInputSource['spans'] = []
  let at = 0
  for (const steer of steers) {
    const text = formatSteerForModel(steer)
    spans.push({ start: at, end: at + text.length, source: steer.source === 'dm' ? 'agent_note' : 'user' })
    at += text.length + 2 // buildSteerInjectionText's unchanged blank-line separator
  }
  return { textHash: sha256Hex(buildSteerInjectionText([...steers])), spans }
}

export function readUserInputSources(value: unknown): UserInputSource[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !/^[0-9a-f]{64}$/.test(entry.textHash) || !Array.isArray(entry.spans)) return []
    const spans = entry.spans
    if (!spans.every((span: any) => span && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
      span.start >= 0 && span.end > span.start && (span.source === 'user' || span.source === 'agent_note'))) return []
    return [{ textHash: entry.textHash, spans: spans.map((span: any) => ({ start: span.start, end: span.end, source: span.source })) }]
  })
}

function sourcePieces(text: string, sources: readonly UserInputSource[]): AddressSourcePiece[] | null {
  const hash = sha256Hex(text)
  const matches = sources.filter((source) => source.textHash === hash)
  if (!matches.length) return null
  if (matches.some((match) => JSON.stringify(match.spans) !== JSON.stringify(matches[0].spans))) return null
  const pieces: AddressSourcePiece[] = []
  let at = 0
  for (const span of matches[0].spans) {
    if (span.start < at || span.end > text.length || text.slice(at, span.start).trim()) return null
    pieces.push({ source: span.source, text: text.slice(span.start, span.end) })
    at = span.end
  }
  return text.slice(at).trim() ? null : pieces
}

function systemTexts(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return ['<unaccounted system shape>']
  return value.map((part) => typeof part?.content === 'string' ? part.content : '<unaccounted system part>').filter(Boolean)
}

/** Consumes the installed SDK's exact V4 prompt at its dispatch boundary, without reconversion. */
export class ApiImageInputCollector {
  readonly run: RunDelivery = emptyRunDelivery(false)
  compiledObserved = false
  private readonly seen = new Set<string>()

  poison(): void { this.run.unaccountedInputs += 1 }

  observe(input: ApiInputObservation): void {
    if (!Array.isArray(input.promptMessages) || !Number.isSafeInteger(input.compiledPrefixCount) || input.compiledPrefixCount < 0) {
      this.poison(); return
    }
    const prompt = input.promptMessages
    if (!Array.isArray(input.compiledMessages) || input.compiledPrefixCount > input.compiledMessages.length) { this.poison(); return }
    const expected: string[] = []
    input.compiledMessages.slice(0, input.compiledPrefixCount).forEach((message) => {
      if (message?.role !== 'user') return
      if (typeof message.content === 'string') {
        if (message.content.length) expected.push(message.content)
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string' && part.text.length) {
          expected.push(part.text)
        }
      }
    })
    const actualSystem = prompt.filter((message) => message?.role === 'system').map((message) => message.content)
    let compiledMatches = JSON.stringify(actualSystem) === JSON.stringify(systemTexts(input.initialSystem))
    const userPieces = new Map<string, AddressSourcePiece[] | null>()
    let next = 0
    prompt.forEach((message, messageIndex) => {
      if (message?.role !== 'user') return
      const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
      if (!Array.isArray(parts)) { this.poison(); compiledMatches = false; return }
      parts.forEach((part, partIndex) => {
        if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.length) return
        if (next < expected.length) {
          if (expected[next++] !== part.text) { this.poison(); compiledMatches = false; userPieces.set(`${messageIndex}:${partIndex}`, null); return }
          userPieces.set(`${messageIndex}:${partIndex}`, [])
        } else {
          userPieces.set(`${messageIndex}:${partIndex}`, sourcePieces(part.text, input.userSources))
        }
      })
    })
    if (next !== expected.length) { this.poison(); compiledMatches = false }
    if (!compiledMatches) this.poison()
    this.compiledObserved ||= compiledMatches
    if (!Object.hasOwn(input, 'toolDefinitions') || (input.toolDefinitions !== undefined && !Array.isArray(input.toolDefinitions))) this.poison()
    else for (const tool of input.toolDefinitions ?? []) {
      if (tool?.type !== 'function') { this.poison(); continue }
      // These are the exact dispatched tool definitions, not a registry/display copy.
      const text = JSON.stringify(tool)
      const key = `tool_definition:${sha256Hex(text)}`
      if (!this.seen.has(key)) { this.seen.add(key); this.run.pieces.push({ source: 'tool_result', text }) }
    }
    const observed = readApiRunMessages(prompt, { imageInputsRegistered: 0, userPieces })
    this.run.observed = true
    this.run.nonTextInputs += observed.nonTextInputs
    this.run.cutResults += observed.cutResults
    this.run.providerExecutedTools += observed.providerExecutedTools
    this.run.unaccountedInputs += observed.unaccountedInputs
    for (const piece of observed.pieces) {
      const key = `${piece.source}:${sha256Hex(piece.text)}`
      if (!this.seen.has(key)) { this.seen.add(key); this.run.pieces.push(piece) }
    }
  }
}
