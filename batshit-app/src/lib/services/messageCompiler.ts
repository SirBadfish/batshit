import { api } from './api'
import { projectRemovedTextRanges, replaceTextRanges, type TextRange } from '$lib/utils/hydratedTextRanges'
import { replaceAddressSourceRanges, type PositionedAddressSource } from '$lib/utils/addressSourceRanges'
import { calculateZipActivation, describeReadCompressHint } from '$lib/utils/zipActivation'
import { classifyToolResultSize, resolveToolResultPromptTokens, TOOL_RESULT_SIZE_REASON_TEXT, type ToolResultSizeGuard } from '$lib/utils/toolResultSizeGuard'
import { describeHeldReadHint } from '$lib/utils/zipHoldWords'
import { DEAD_COPY_REASON_TEXT, type DeadCopyReason, type DeadCopyToolResult } from '$lib/utils/zipDeadCopies'
import { canonicalToolName } from '$lib/utils/toolRenderMap'
import {
  extractAllReferences,
  createReference
} from './universalResolver'
import { normalizeId } from '$lib/utils/idNormalizer'
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import {
  expandSteerPlaceholders,
  formatSteerForModel,
  formatSteerForUser,
  readMessageSteers,
  type DeliveredSteer
} from '$lib/utils/steerControl'
import { getActiveInterruptedReasoningRecoveryBlock } from '$lib/utils/reasoningRecovery'
import { isConcreteZipId } from '$lib/utils/zipReferenceSafety'
import {
  buildMalformedCoolToolAiContent,
  buildCoolToolAiContentWithSources,
  estimateCoolToolAiTokens,
  estimateMalformedCoolToolAiTokens,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import {
  escapeAttributeValue,
  escapeStructuredTextContent
} from '$lib/utils/htmlEntities'
import { logger } from '$lib/utils/logger'
import type { ZipStateView } from './zipping'
import type { AddressSourcePiece } from '$lib/utils/imageAddressOrigin'

const ZIP_COMPILATION_BATCH_SIZE = 100

interface ExtractedZip {
  raw: string
  id: string
  type: string
  tokens: string
  name: string
  description: string
  index: number
  length: number
  optionalContent?: string
}

interface ZipData {
  id: string
  content: string
  type: string
  tokens: number
  description?: string
  name?: string
  metadata?: Record<string, any>
}

export interface ZipExposure {
  zipId: string
  zip: ExtractedZip
  zipData: ZipData
  expandedContent: string
  /** BL-1014: the exact expanded Cool Tool body with its structural provenance. */
  expandedContentParts?: AddressSourcePiece[]
  message?: any
}

/**
 * SA-120 P5: one zip this compile left COMPRESSED for the model, reported through
 * `onZipCompressed`. Observation only — the decision was already made and applied by
 * the time the callback runs. The canonical compiler hands these to the Judge Juice
 * smart-zip hint lane as its candidates, so the lane judges exactly what the agent
 * cannot see rather than re-deriving zip activation on its own.
 */
export interface ZipCompression {
  zipId: string
  zipType: string
  /** The compact description the model reads inside the compressed reference. */
  description: string
  /**
   * The stored parts of that description (`metadata.zipDescriptionLabel` / `Target` /
   * `Status`), when the zip has any; a part it lacks is `''`. Facts only: what a reader
   * does with a repeat of the same tool call, or with a result that names no target, is
   * that reader's policy.
   */
  descriptionParts?: { label: string; target: string; status: string }
  /** Prompt-facing tokens the expanded result would cost. */
  tokens: number
  operationKind?: string
  toolName?: string
  /** The size rule reported by activation, never the stored forceCompress stamp. */
  sizeGuard: ToolResultSizeGuard
  /** Someone zipped it by hand (`rezipped_item`). */
  rezipped: boolean
  /**
   * Whose rezip it is, when the compile's zip state carries rezip sources (the canonical
   * compiler loads them only for a smart-zip turn). Unknown reads as `user`, the strongest,
   * so a reader that must not override an explicit zip stays safe by default.
   */
  rezippedBy: 'user' | 'agent' | 'inferred' | null
  /** Compressed only because the tool is not shared with this group agent. */
  groupUnshared: boolean
  /**
   * SA-129 P1 (DL-01): a dead copy of a file read (superseded or stale). Such a zip cannot be
   * reopened by an `inferred` (Judge Juice) unzip, so the smart-zip lane never offers it.
   */
  deadCopy: DeadCopyReason | null
  messagesFromEnd: number
}

/**
 * SA-120 P5: one zip this compile left EXPANDED for the model, reported through
 * `onZipExposed` in every view mode (unlike `onZipExposure`, which carries the expanded body
 * for the appended block). Facts only, after the fact. The Judge Juice smart-zip lane asks,
 * once the reply is finished, whether the agent is done with the ones that would otherwise
 * stay open.
 */
export interface ZipExposed {
  zipId: string
  zipType: string
  description: string
  descriptionParts?: { label: string; target: string; status: string }
  /** Prompt-facing tokens it costs while it stays open. */
  tokens: number
  operationKind?: string
  toolName?: string
  /** Who holds it open by hand; `null` when only buffer rules or a recovery hold keep it open. */
  unzippedBy: 'user' | 'agent' | 'inferred' | null
  recoveryHold: boolean
  messagesFromEnd: number
  bufferSize: number
  autoZip: boolean
  zipDisabled: boolean
}

const PRESERVED_REASONING_HEADER = '==== PRESERVED REASONING FROM THIS RESPONSE ===='
const PRESERVED_PLAN_HEADER = '==== PRESERVED PLAN FROM THIS RESPONSE ===='

function resolveMessageAgentId(message?: any): string | null {
  const value =
    message?.agent_id ??
    message?.agentId ??
    message?.metadata?.agentId ??
    message?.metadata?.agent_id
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Builds the exact prior-reasoning block that enters the canonical model history.
 * The saved metadata remains user-visible regardless of this setting; this function
 * is only the model-context gate for the agent that authored the response.
 */
export function buildPreservedReasoningHistory(agent: any, message?: any): string {
  if (agent?.preserve_reasoning !== true) return ''

  const currentAgentId =
    typeof agent?.id === 'string' && agent.id.trim().length > 0 ? agent.id.trim() : null
  const messageAgentId = resolveMessageAgentId(message)
  if (currentAgentId && messageAgentId && currentAgentId !== messageAgentId) {
    return ''
  }

  const reasoningSummary =
    typeof message?.metadata?.reasoningSummary === 'string'
      ? message.metadata.reasoningSummary.trim()
      : ''
  const planSummary =
    typeof message?.metadata?.planSummary === 'string'
      ? message.metadata.planSummary.trim()
      : ''

  const blocks: string[] = []
  if (reasoningSummary) {
    blocks.push(`${PRESERVED_REASONING_HEADER}\n${reasoningSummary}`)
  }
  if (planSummary) {
    blocks.push(`${PRESERVED_PLAN_HEADER}\n${planSummary}`)
  }
  return blocks.join('\n\n')
}

function getCoolToolRawSidecarZipId(zipData: ZipData, payload: Record<string, any> | null): string | null {
  const candidates = [
    zipData.metadata?.rawSidecarZipId,
    payload?.rawSidecar?.zipId,
    payload?.metadata?.rawSidecarZipId
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isConcreteZipId(candidate)) {
      return candidate
    }
  }

  return null
}

async function ensureCoolToolPromptTokens(
  zip: ExtractedZip,
  zipData: ZipData,
  fetchImpl?: typeof fetch,
  zipResolver?: (zipId: string) => Promise<ZipData | null>
): Promise<ZipData> {
  if (zipData.type !== 'cool_tool' || resolveToolResultPromptTokens(zipData) !== null) {
    return zipData
  }

  const mainPayload = parseCoolToolPayload(zipData.content)
  if (!mainPayload && typeof zipData.content !== 'string') return zipData

  const rawSidecarZipId = getCoolToolRawSidecarZipId(zipData, mainPayload)
  const rawSidecarZip =
    rawSidecarZipId && shouldPreferRawSidecarForAiExpansion(mainPayload)
      ? await resolveZipData(rawSidecarZipId, fetchImpl, zipResolver)
      : null
  const payloadContent =
    rawSidecarZip?.type === 'tool_raw' && typeof rawSidecarZip.content === 'string'
      ? rawSidecarZip.content
      : zipData.content
  const promptPayload = parseCoolToolPayload(payloadContent)
  const promptTokens = promptPayload
    ? estimateCoolToolAiTokens(zip.id, zipData, promptPayload)
    : estimateMalformedCoolToolAiTokens(zip.id, payloadContent)

  return {
    ...zipData,
    tokens: promptTokens,
    metadata: {
      ...(zipData.metadata || {}),
      tokens: promptTokens,
      promptTokens,
      aiTokens: promptTokens,
      tokenBasis: 'ai_expanded',
      storageTokens: zipData.metadata?.storageTokens ?? zipData.tokens
    }
  }
}

async function resolveZipData(
  id: string,
  fetchImpl?: typeof fetch,
  zipResolver?: (id: string) => Promise<ZipData | null>
): Promise<ZipData | null> {
  return zipResolver ? zipResolver(id) : api.getZip(id, fetchImpl)
}

function isLikelyZipId(id: string): boolean {
  return isConcreteZipId(id)
}

function extractedZipAt(ref: ReturnType<typeof extractAllReferences>[number], index: number): ExtractedZip {
  return {
    raw: ref.fullMatch,
    id: ref.id,
    type: 'zip',
    tokens: '0',
    name: '',
    description: ref.optionalContent || '',
    optionalContent: ref.optionalContent,
    index,
    length: ref.fullMatch.length
  }
}

export function extractZips(content: string): ExtractedZip[] {
  const references = extractAllReferences(content)
  const zips: ExtractedZip[] = []
  
  // The resolver returns source order. Advance across clips too, so a matching marker in an
  // earlier reference's label cannot steal the later occurrence (including interleaved A/B/A).
  let cursor = 0
  references.forEach(ref => {
    const index = content.indexOf(ref.fullMatch, cursor)
    if (index < 0) throw new Error('The compiled reference has no source position.')
    cursor = index + ref.fullMatch.length
    if (ref.type === 'zip') {
      if (!isLikelyZipId(ref.id)) {
        return
      }
      zips.push(extractedZipAt(ref, index))
    }
  })
  
  return zips.sort((a, b) => a.index - b.index)
}


function normalizeSharedTools(sharedTools?: unknown): string[] {
  if (!Array.isArray(sharedTools)) return []
  return sharedTools
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
}

function getGroupShareKeysForZip(options: {
  zipType?: string
  toolCandidates?: Array<string | undefined>
}): { keys: string[]; usesAllOtherFallback: boolean } {
  const keys = new Set<string>()
  let usesAllOtherFallback = true

  if (options.zipType === 'image') {
    keys.add('image')
    usesAllOtherFallback = false
  }

  for (const candidate of options.toolCandidates ?? []) {
    if (!candidate) continue
    const raw = candidate.trim()
    if (!raw) continue
    keys.add(raw.toLowerCase())

    const canonical = canonicalToolName(raw).trim().toLowerCase()
    if (canonical && canonical !== 'unknown') {
      keys.add(canonical)
      if (canonical !== 'all_other_tools') {
        usesAllOtherFallback = false
      }
    }
  }

  return {
    keys: Array.from(keys),
    usesAllOtherFallback
  }
}

export function isToolSharedForGroup(
  options: {
    zipType?: string
    toolCandidates?: Array<string | undefined>
  },
  sharedTools: string[]
): boolean {
  if (sharedTools.length === 0) return false

  const normalized = new Set(sharedTools.map((entry) => entry.toLowerCase()))
  const shareKeys = getGroupShareKeysForZip(options)

  if (shareKeys.keys.some((key) => normalized.has(key))) return true
  if (shareKeys.usesAllOtherFallback && normalized.has('all_other_tools')) return true
  return false
}

/**
 * The zip references `compileForAI` resolves in one message, in order: control blocks stripped
 * first, then the message's `metadata.zipIds` allow-list. SA-129 P1's dead-copy ledger reads the
 * same list, so it sees exactly the results the compile does.
 */
export function listCompilableZips(content: string, message?: any): ExtractedZip[] {
  const validZipIdsRaw = Array.isArray(message?.metadata?.zipIds) ? message.metadata.zipIds : null
  const validZipIds = validZipIdsRaw
    ? new Set(validZipIdsRaw.map((id: string) => normalizeId(id)))
    : null
  return extractZips(content ? stripZipControlBlocks(content) : content).filter((zip) => {
    if (!validZipIds) return true
    return validZipIds.has(normalizeId(zip.id))
  })
}

/**
 * SA-129: every tool result among `messages`, in chat order, as the dead-copy ledger reads it:
 * the references `compileForAI` resolves (`listCompilableZips`), read through `resolveZip`, with
 * the author of each message. A zip that cannot be read is left out, so it can neither die nor
 * kill another copy. The compile (P1) and the chat's badges (P2, BL-333) read this one list.
 */
export async function collectDeadCopyToolResults(
  messages: any[],
  resolveZip: (zipId: string) => Promise<any | null>
): Promise<{ results: DeadCopyToolResult[]; messageIndexByZip: Map<string, number> }> {
  const results: DeadCopyToolResult[] = []
  const messageIndexByZip = new Map<string, number>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as any
    if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content) continue
    const authorId =
      typeof message.agent_id === 'string' && message.agent_id.trim()
        ? message.agent_id.trim()
        : typeof message.agentId === 'string' && message.agentId.trim()
          ? message.agentId.trim()
          : null
    for (const zip of listCompilableZips(message.content, message)) {
      const zipId = normalizeId(zip.id)
      if (messageIndexByZip.has(zipId)) continue
      let zipData: any = null
      try {
        zipData = await resolveZip(zip.id)
      } catch {
        zipData = null
      }
      if (!zipData || zipData.type !== 'cool_tool') continue
      messageIndexByZip.set(zipId, index)
      results.push({
        zipId,
        authorId,
        messageIndex: index,
        operationKind: typeof zipData.metadata?.operationKind === 'string' ? zipData.metadata.operationKind : null,
        payload: parseCoolToolPayload(zipData.content)
      })
    }
  }
  return { results, messageIndexByZip }
}

/** SA-129 P1: one dead copy as a compile sees it (`findDeadCopies` plus its author's reply count). */
export interface CompileDeadCopy {
  reason: DeadCopyReason
  /** How many of the author's replies had finished when the copy died. */
  repliesUntilDead: number
}

function isReadTranscriptLane(zipData: ZipData): boolean {
  const kind = zipData.metadata?.operationKind
  return kind === 'read_file' || kind === 'skill_read'
}

// Compile content for AI (respect buffer/threshold)
export async function compileForAI(
  content: string,
  messageIndex: number,
  totalMessages: number,
  agent: any,
  _message?: any,
  globalZipSettings?: Record<string, any>,
  options?: {
    fetch?: typeof fetch
    zipResolver?: (zipId: string) => Promise<ZipData | null>
    groupToolSharing?: {
      currentAgentId?: string | null
      sharedTools?: string[]
    }
    zipViewMode?: 'inline' | 'appended'
    agentMessagesFromEnd?: number
    onZipExposure?: (exposure: ZipExposure) => void
    /** SA-120 P5: told about each zip left compressed, AFTER the fact. Must not throw; a throw is logged and ignored. */
    onZipCompressed?: (compression: ZipCompression) => void
    /** SA-120 P5: told about each zip left expanded, in every view mode, AFTER the fact. Same rule. */
    onZipExposed?: (exposed: ZipExposed) => void
    /** See calculateRecoveryHoldByIndex — blocks automatic zip compression for failed/interrupted trailing runs. */
    recoveryHold?: boolean
    /** Replays one stored, byte-stable reasoning block until the same agent completes a later successful turn. */
    interruptedReasoningRecoveryActive?: boolean
    /**
     * The zip state this compile reads (unzips, rezips, and whose they are). The server
     * always passes the one it built for this compile: compiles overlap in one process, and
     * the zip reads below await in between. Absent, a browser caller reads its tab's
     * singleton, which holds only the current chat.
     */
    zipState?: ZipStateView
    /**
     * SA-129 P1 (DL-01): this compile's dead copies by normalized zip id, built once per
     * compile from its own messages (never shared between compiles, like `zipState`).
     */
    deadCopies?: ReadonlyMap<string, CompileDeadCopy>
    /**
     * BL-474 step 2: told about each piece of this message that is not the agent's own words
     * (a tool result it expanded in place, a steer it expanded), with its source, AFTER the text
     * is written. Read only: it can never change or interrupt the compile; a throw is logged and
     * ignored. A tool result in the appended view is told by the zip index that holds it.
     */
    onDeliveredSource?: (piece: PositionedAddressSource) => void
  }
): Promise<string> {
  const zipState: ZipStateView =
    options?.zipState ?? (await import('$lib/services/zipping')).zippingService
  const fetchImpl = options?.fetch
  const groupToolSharing = options?.groupToolSharing
  const sharedTools = normalizeSharedTools(groupToolSharing?.sharedTools)
  const currentAgentId =
    typeof groupToolSharing?.currentAgentId === 'string'
      ? groupToolSharing.currentAgentId
      : null
  const messageAgentId =
    typeof (_message as any)?.agent_id === 'string'
      ? String((_message as any).agent_id)
      : typeof (_message as any)?.agentId === 'string'
        ? String((_message as any).agentId)
        : null
  const shouldLimitSharedTools =
    Boolean(groupToolSharing) && Boolean(currentAgentId) && Boolean(messageAgentId) &&
    currentAgentId !== messageAgentId

  const zipViewMode = options?.zipViewMode === 'appended' ? 'appended' : 'inline'
  // SA-129 P1 (DL-03): the compression hint speaks to the agent this compile is for, so a group
  // compile gives none to another agent's results (they age by that agent's replies).
  const compressHintsForThisAgent = !shouldLimitSharedTools
  // SA-129 P2: the agent this compile is for, which "Held by you" means.
  const compilingAgentId = currentAgentId ?? (typeof agent?.id === 'string' ? agent.id : null)
  const reportDelivered = (piece: PositionedAddressSource) => {
    if (!options?.onDeliveredSource) return
    try {
      options.onDeliveredSource(piece)
    } catch (error) {
      console.error('[compileForAI] onDeliveredSource observer threw; ignored:', error)
    }
  }

  const zips = listCompilableZips(content, _message)
  if (content) {
    content = stripZipControlBlocks(content)
  }
  let compiled = content
  let delivered: PositionedAddressSource[] = []
  let offset = 0

  zips.sort((a, b) => a.index - b.index)

  for (const zip of zips) {
    try {
      const resolvedZipData = await resolveZipData(zip.id, fetchImpl, options?.zipResolver)
      if (!resolvedZipData) {
        continue
      }
      const zipData = await ensureCoolToolPromptTokens(
        zip,
        resolvedZipData,
        fetchImpl,
        options?.zipResolver
      )
      
      // Check if this zip is unzipped by the user
      const checkZipId = normalizeId(zip.id)
      const isUnzipped = zipState.isUnzipped(checkZipId)
      const isRezipped = zipState.isRezipped(checkZipId)
      const messagesFromEnd =
        options?.agentMessagesFromEnd ?? totalMessages - messageIndex - 1
      
      const toolNameForZip =
        zipData.metadata?.operationKind || zipData.metadata?.toolName || zipData.name
      // An unzip whose source cannot be read is the user's, the strongest.
      const unzippedSource = isUnzipped ? zipState.getUnzippedInfo(checkZipId)?.source : undefined
      const isUserUnzipped = isUnzipped && unzippedSource !== 'agent' && unzippedSource !== 'inferred'

      const activation = calculateZipActivation({
        zipType: zipData.type,
        messagesFromEnd,
        zipData,
        agentSettings: agent,
        globalSettings: globalZipSettings,
        toolName: toolNameForZip,
        fallbackTokens: zipData.tokens,
        isUnzipped,
        isInferredUnzipped: unzippedSource === 'inferred',
        isRezipped,
        recoveryHold: options?.recoveryHold === true,
        deadCopy: options?.deadCopies?.get(checkZipId) ?? null,
        isUserUnzipped
      })

      const start = zip.index + offset

      const shouldForceCompress =
        shouldLimitSharedTools &&
        isToolSharedForGroup(
          {
            zipType: zipData.type,
            toolCandidates: [
              typeof zipData.metadata?.toolName === 'string' ? zipData.metadata.toolName : undefined,
              typeof zipData.metadata?.operationKind === 'string'
                ? zipData.metadata.operationKind
                : undefined,
              typeof zipData.name === 'string' ? zipData.name : undefined,
              toolNameForZip
            ]
          },
          sharedTools
        ) === false

      const shouldCompress = shouldForceCompress ? true : activation.shouldCompress
      const shouldExpose = !shouldCompress
      const shouldAppend = zipViewMode === 'appended'

      const buildExpandedContent = async (): Promise<{ text: string; parts?: AddressSourcePiece[] }> => {
        let expandedContent = zipData.content
        let expandedContentParts: AddressSourcePiece[] | undefined

        // For Cool Tools, we need to handle them specially
        if (zipData.type === 'cool_tool') {
          const parsedPayload = parseCoolToolPayload(zipData.content)
          const rawSidecarZipId = getCoolToolRawSidecarZipId(zipData, parsedPayload)
          const rawSidecarZip =
            rawSidecarZipId && shouldPreferRawSidecarForAiExpansion(parsedPayload)
              ? await resolveZipData(rawSidecarZipId, fetchImpl, options?.zipResolver)
              : null
          const payloadContent =
            rawSidecarZip?.type === 'tool_raw' && typeof rawSidecarZip.content === 'string'
              ? rawSidecarZip.content
              : zipData.content
          const payloadForAi = parseCoolToolPayload(payloadContent)
          if (payloadForAi) {
            const formatted = buildCoolToolAiContentWithSources(zip.id, zipData, payloadForAi)
            expandedContent = formatted.text
            expandedContentParts = formatted.parts
            // SA-129 P2 (DL-03): an open read says when it compresses, or who holds it open. A
            // held copy the dead-copy rule compressed anyway (an agent's hold on a copy it edited
            // since) is never expanded, so it never reaches here.
            const compressHint =
              compressHintsForThisAgent && isReadTranscriptLane(zipData)
                ? isUnzipped
                  ? describeHeldReadHint(zipState.getUnzippedInfo(checkZipId), compilingAgentId)
                  : describeReadCompressHint(activation, { isUnzipped })
                : null
            if (compressHint) {
              expandedContent += `\n${compressHint}`
              expandedContentParts = [
                ...(expandedContentParts ?? []),
                { source: 'agent_words', text: `\n${compressHint}` }
              ]
            }
          } else {
            // Keep malformed legacy fallback and its size estimate byte-identical.
            expandedContent = buildMalformedCoolToolAiContent(zip.id, payloadContent)
            // A malformed transcript has no trustworthy structural source boundaries.
            expandedContentParts = [{ source: 'agent_words', text: expandedContent }]
          }
        }

        return { text: expandedContent, parts: expandedContentParts }
      }

      const descriptionPart = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
      const reportExposed = () => {
        if (!options?.onZipExposed) return
        try {
          const label = descriptionPart(zipData.metadata?.zipDescriptionLabel)
          const target = descriptionPart(zipData.metadata?.zipDescriptionTarget)
          options.onZipExposed({
            zipId: zip.id,
            zipType: zipData.type,
            description: zip.optionalContent || zip.description || zipData.description || '',
            ...(label || target
              ? { descriptionParts: { label, target, status: descriptionPart(zipData.metadata?.zipDescriptionStatus) } }
              : {}),
            tokens: activation.tokens,
            operationKind:
              typeof zipData.metadata?.operationKind === 'string' ? zipData.metadata.operationKind : undefined,
            toolName: activation.toolName,
            // An unzip whose source cannot be read is the user's, the strongest.
            unzippedBy: !isUnzipped
              ? null
              : unzippedSource === 'agent' || unzippedSource === 'inferred'
                ? unzippedSource
                : 'user',
            recoveryHold: activation.recoveryHold,
            messagesFromEnd: activation.messagesFromEnd,
            bufferSize: activation.bufferSize,
            autoZip: activation.autoZip,
            zipDisabled: activation.zipDisabled
          })
        } catch (error) {
          console.error('[compileForAI] onZipExposed observer threw; ignored:', error)
        }
      }

      if (shouldAppend && shouldExpose) {
        const expanded = await buildExpandedContent()
        options?.onZipExposure?.({
          zipId: zip.id,
          zip,
          zipData,
          expandedContent: expanded.text,
          ...(expanded.parts ? { expandedContentParts: expanded.parts } : {}),
          message: _message
        })
      }

      if (shouldCompress || (shouldAppend && shouldExpose)) {
        const optionalContent = zip.optionalContent || zip.description
        // SA-129 P1: a copy the dead-copy rule compressed says why after its description.
        const deadCopyText =
          shouldCompress && !shouldForceCompress && activation.deadCopy && activation.deadCopyNamed
            ? DEAD_COPY_REASON_TEXT[activation.deadCopy]
            : ''
        // A large result already carried this reference before a later read made it
        // a dead copy. Keep its size reason stable; activation still reports the
        // winning rule separately for Holds, UI and Judge Juice.
        const referenceSize = zipData.type === 'cool_tool' ? classifyToolResultSize(activation.tokens) : null
        const sizeGuardText = shouldCompress && !shouldForceCompress && referenceSize
          ? TOOL_RESULT_SIZE_REASON_TEXT[referenceSize]
          : ''
        const reasonText = sizeGuardText || deadCopyText
        const referenceText = reasonText
          ? optionalContent
            ? `${optionalContent} - ${reasonText}`
            : reasonText
          : optionalContent
        const compressedZip = createReference('zip', zip.id, referenceText)
        delivered = replaceAddressSourceRanges(delivered,start,start+zip.length,compressedZip)
        compiled = compiled.substring(0, start) +
          compressedZip +
          compiled.substring(start + zip.length)
        offset += compressedZip.length - zip.length

        // SA-120 P5: report after the reference is written, so an observer can never
        // change or interrupt what this compile produced.
        if (!shouldCompress) reportExposed()
        if (shouldCompress && options?.onZipCompressed) {
          try {
            const part = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
            const label = part(zipData.metadata?.zipDescriptionLabel)
            const target = part(zipData.metadata?.zipDescriptionTarget)
            options.onZipCompressed({
              zipId: zip.id,
              zipType: zipData.type,
              description: optionalContent || zipData.description || '',
              ...(label || target
                ? { descriptionParts: { label, target, status: part(zipData.metadata?.zipDescriptionStatus) } }
                : {}),
              tokens: activation.tokens,
              operationKind:
                typeof zipData.metadata?.operationKind === 'string'
                  ? zipData.metadata.operationKind
                  : undefined,
              toolName: activation.toolName,
              sizeGuard: activation.sizeGuard,
              rezipped: isRezipped,
              rezippedBy: isRezipped ? (zipState.getRezippedSource(checkZipId) ?? 'user') : null,
              groupUnshared: shouldForceCompress,
              deadCopy: activation.deadCopy,
              messagesFromEnd: activation.messagesFromEnd
            })
          } catch (error) {
            console.error('[compileForAI] onZipCompressed observer threw; ignored:', error)
          }
        }
      } else {
        // When expanding zips that are within the buffer zone OR manually unzipped
        const expanded = await buildExpandedContent()
        
        delivered = replaceAddressSourceRanges(delivered,start,start+zip.length,expanded.text)
        compiled = compiled.substring(0, start) +
          expanded.text +
          compiled.substring(start + zip.length)
        offset += expanded.text.length - zip.length
        reportExposed()
        // Only a tool's own result is a tool result; any other zip family holds the agent's
        // own words (an `<error>` block the reply wrote), which stay in its message.
        if (zipData.type === 'cool_tool') {
          let at = start
          for (const piece of expanded.parts ?? [{ source: 'agent_words' as const, text: expanded.text }]) {
            delivered.push({...piece,start:at,end:at+piece.text.length})
            at += piece.text.length
          }
        }
      }
    } catch (error) {
      console.warn('[compileForAI] Failed to resolve zip during AI history compilation:', {
        zipId: zip.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // SA-114 (DL-114-04) — expand `{{batshit-steer:id}}` into the mid-reply line.
  //
  // AFTER the zip loop on purpose: `extractZips` records each zip's index against the
  // ORIGINAL content, and the loop tracks its own offset, so replacing anything else first
  // would move every zip out from under those indices.
  //
  // The text lives in `metadata.steers[]` rather than in the marker — the same split the
  // zip family uses, and what lets one assistant record carry it without the compiled
  // history ever changing after it is written.
  const beforeSteers = compiled
  const steerEdits: Array<{start:number;end:number;replacement:string;piece:AddressSourcePiece}> = []
  compiled = expandSteerPlaceholders(compiled,readMessageSteers(_message),formatSteerForModel,
    (start,end,replacement,steer,line)=>{
      steerEdits.push({start,end,replacement,piece:{source:steer ? (steer.source==='dm'?'agent_note':'user') : 'batshit',text:line}})
    })
  let untrimmedSteers = beforeSteers
  for(const edit of steerEdits.reverse()) {
    delivered=replaceAddressSourceRanges(delivered,edit.start,edit.end,edit.replacement)
    const within=edit.replacement.indexOf(edit.piece.text)
    delivered.push({...edit.piece,start:edit.start+within,end:edit.start+within+edit.piece.text.length})
    untrimmedSteers=untrimmedSteers.slice(0,edit.start)+edit.replacement+untrimmedSteers.slice(edit.end)
  }
  const leadingTrim=untrimmedSteers.length-untrimmedSteers.trimStart().length
  // expandSteerPlaceholders removes only the new edge newlines; preserve caller whitespace.
  const removedLeading=untrimmedSteers.length>compiled.length && !/^\s/.test(beforeSteers)?leadingTrim:0
  if(removedLeading) delivered=replaceAddressSourceRanges(delivered,0,removedLeading,'')
  if(untrimmedSteers.length-removedLeading>compiled.length) {
    delivered=replaceAddressSourceRanges(delivered,compiled.length,untrimmedSteers.length-removedLeading,'')
  }

  // Tell the model when this response never completed, so it does not treat
  // the partial work as a finished turn (mirrors the user-facing failure
  // banner; the auto-continue addendum covers only the automatic relay case).
  if ((_message as any)?.metadata?.response_failed === true) {
    const reasonRaw =
      typeof (_message as any)?.metadata?.error_message === 'string'
        ? (_message as any).metadata.error_message.trim()
        : ''
    const reason = reasonRaw.length > 200 ? `${reasonRaw.slice(0, 200)}…` : reasonRaw
    // BL-239: an output-limit stop is not an error, and its stored message is advice for the
    // user (continue, or raise Max Tokens), so the model gets the plain fact instead.
    const note = (_message as any)?.metadata?.failure_kind === 'output_limit'
      ? "[This response stopped at the model's output limit before it was finished.]"
      : reason
        ? `[This response was cut short by an error before completing: ${reason}]`
        : '[This response was cut short by an error before completing.]'
    compiled = compiled.trim().length > 0 ? `${compiled}\n\n${note}` : note
  }

  const interruptedReasoningRecovery = getActiveInterruptedReasoningRecoveryBlock({
    message: _message,
    currentAgentId: typeof agent?.id === 'string' ? agent.id : null,
    active: options?.interruptedReasoningRecoveryActive === true
  })
  const preservedReasoningHistory = interruptedReasoningRecovery
    ? ''
    : buildPreservedReasoningHistory(agent, _message)
  if (preservedReasoningHistory) {
    const prefix=compiled.trim().length>0?`${preservedReasoningHistory}\n\n`:preservedReasoningHistory
    delivered=replaceAddressSourceRanges(delivered,0,0,prefix)
    compiled = compiled.trim().length > 0
      ? `${preservedReasoningHistory}\n\n${compiled}`
      : preservedReasoningHistory
  }
  if (interruptedReasoningRecovery) {
    compiled = compiled.trim().length > 0
      ? `${compiled}\n\n${interruptedReasoningRecovery}`
      : interruptedReasoningRecovery
  }

  for(const piece of delivered) reportDelivered({...piece,text:compiled.slice(piece.start,piece.end)})
  return compiled
}

export function getMessageZips(content: string) {
  return extractZips(content).map(zip => ({
    id: zip.id,
    type: zip.type,
    description: zip.optionalContent || zip.description
  }))
}

export async function batchGetZips(zipIds: string[]): Promise<Map<string, ZipData>> {
  const zipMap = new Map<string, ZipData>()
  const uniqueIds = Array.from(new Set(zipIds.filter(Boolean)))
  if (uniqueIds.length === 0) return zipMap

  try {
    for (let i = 0; i < uniqueIds.length; i += ZIP_COMPILATION_BATCH_SIZE) {
      const batch = uniqueIds.slice(i, i + ZIP_COMPILATION_BATCH_SIZE)
      const data = await api.getZips(batch)
      for (const id of batch) {
        const zip = data.get(id)
        if (zip) {
          zipMap.set(id, zip)
        }
      }
    }
  } catch (error) {
    console.warn('[compileForUserBatch] Failed to batch resolve zip IDs:', {
      count: uniqueIds.length,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  return zipMap
}

/**
 * SA-114 (DL-114-04) — the user twin of the steer expansion.
 *
 * `steers` comes from the message's own `metadata.steers[]`; the caller passes it because
 * this function takes content, not a message. P1 renders each one as a markdown blockquote
 * so the chat is honest the moment a steer can land; P3 replaces that rendering with the
 * inset bubble, and neither the marker nor the metadata changes when it does.
 */
export async function compileForUserBatch(
  content: string,
  options?: { steers?: DeliveredSteer[]; trustedZipIds?: ReadonlySet<string>; onHydratedRanges?: (content: string, ranges: TextRange[]) => void }
): Promise<string> {
  const steers = options?.steers ?? []
  const zips = extractZips(content)
  if (zips.length === 0) {
    const expanded = expandSteerPlaceholders(content, steers, formatSteerForUser)
    options?.onHydratedRanges?.(expanded, [])
    return expanded
  }
  
  const zipIds = zips.map(t => t.id)
  logger.debug('[compileForUserBatch] Resolving zip IDs:', zipIds)
  const zipDataMap = await batchGetZips(zipIds)
  
  let compiled = content
  let hydrated: TextRange[] = []
  
  zips.sort((a, b) => b.index - a.index)
  
  for (const zip of zips) {
    const zipData = zipDataMap.get(zip.id)
    if (!zipData) continue
    
    let expandedContent = zipData.content
    switch (zipData.type) {
      case 'terminal':
        expandedContent = `<terminal data-zip-id="${escapeAttributeValue(zip.id)}" data-zip-type="${escapeAttributeValue(zipData.type)}">${escapeStructuredTextContent(zipData.content)}</terminal>`
        break
      case 'diff':
        let filepath = zipData.name || ''
        expandedContent = `<diff path="${escapeAttributeValue(filepath)}" data-zip-id="${escapeAttributeValue(zip.id)}" data-zip-type="${escapeAttributeValue(zipData.type)}">${escapeStructuredTextContent(zipData.content)}</diff>`
        break
      case 'error':
        expandedContent = `<error data-zip-id="${escapeAttributeValue(zip.id)}" data-zip-type="${escapeAttributeValue(zipData.type)}">${escapeStructuredTextContent(zipData.content)}</error>`
        break
      case 'cool_tool':
        // Keep cool_tool as zip references in batch compile mode.
        // MessageContent hydrates cool_tool segments directly from zip IDs, which avoids
        // transient parser failures from partially-available inline payload wrappers.
        expandedContent = zip.raw
        break
      case 'image':
        const altText = zip.optionalContent || 'Image'
        expandedContent = `<image src="${escapeAttributeValue(zipData.content)}" alt="${escapeAttributeValue(altText)}" data-zip-id="${escapeAttributeValue(zip.id)}" data-zip-type="${escapeAttributeValue(zipData.type)}"></image>`
        break
      case 'file':
        const path = zipData.name || zip.optionalContent || 'file'
        expandedContent = `<file path="${escapeAttributeValue(path)}" url="${escapeAttributeValue(zipData.content)}" data-zip-id="${escapeAttributeValue(zip.id)}" data-zip-type="${escapeAttributeValue(zipData.type)}"></file>`
        break
      default:
        expandedContent = zipData.content
    }
    
    hydrated = replaceTextRanges(hydrated, zip.index, zip.index + zip.length, expandedContent.length)
    if (zipData.type !== 'cool_tool' && options?.trustedZipIds?.has(normalizeId(zip.id))) {
      hydrated.push({ start: zip.index, end: zip.index + expandedContent.length })
    }
    compiled = compiled.substring(0, zip.index) +
      expandedContent +
      compiled.substring(zip.index + zip.length)
  }
  
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const expanded = expandSteerPlaceholders(compiled, steers, formatSteerForUser, (start, end, text) => {
    replacements.push({ start, end, text })
  })
  let beforeTrim = compiled
  for (const replacement of replacements.reverse()) {
    hydrated = replaceTextRanges(hydrated, replacement.start, replacement.end, replacement.text.length)
    beforeTrim = beforeTrim.slice(0, replacement.start) + replacement.text + beforeTrim.slice(replacement.end)
  }
  options?.onHydratedRanges?.(expanded, projectRemovedTextRanges(beforeTrim, expanded, hydrated))
  return expanded
}
