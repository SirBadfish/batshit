import { api } from './api'
import { calculateZipActivation } from '$lib/utils/zipActivation'
import { canonicalToolName } from '$lib/utils/toolRenderMap'
import {
  extractAllReferences,
  createReference
} from './universalResolver'
import { normalizeId } from '$lib/utils/idNormalizer'
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import { getActiveInterruptedReasoningRecoveryBlock } from '$lib/utils/reasoningRecovery'
import { isConcreteZipId } from '$lib/utils/zipReferenceSafety'
import {
  buildCoolToolAiContent,
  estimateCoolToolAiTokens,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import {
  escapeAttributeValue,
  escapeStructuredTextContent
} from '$lib/utils/htmlEntities'
import { logger } from '$lib/utils/logger'

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
  message?: any
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

const escapeScriptContent = (value: string) => value.replace(/<\/script/gi, '<\\/script')

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

function getCoolToolPromptTokens(zipData: ZipData): number | null {
  const candidates = [
    (zipData as any).promptTokens,
    (zipData as any).aiTokens,
    zipData.metadata?.promptTokens,
    zipData.metadata?.aiTokens,
    zipData.metadata?.tokenBasis === 'ai_expanded' ? zipData.tokens : undefined,
    zipData.metadata?.tokenBasis === 'ai_expanded' ? zipData.metadata?.tokens : undefined
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.ceil(candidate)
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
  if (zipData.type !== 'cool_tool' || getCoolToolPromptTokens(zipData) !== null) {
    return zipData
  }

  const mainPayload = parseCoolToolPayload(zipData.content)
  if (!mainPayload) return zipData

  const rawSidecarZipId = getCoolToolRawSidecarZipId(zipData, mainPayload)
  const rawSidecarZip =
    rawSidecarZipId && shouldPreferRawSidecarForAiExpansion(mainPayload)
      ? await resolveZipData(rawSidecarZipId, fetchImpl, zipResolver)
      : null
  const payloadContent =
    rawSidecarZip?.type === 'tool_raw' && typeof rawSidecarZip.content === 'string'
      ? rawSidecarZip.content
      : zipData.content
  const promptPayload = parseCoolToolPayload(payloadContent) || mainPayload
  const promptTokens = estimateCoolToolAiTokens(zip.id, zipData, promptPayload)

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

export function extractZips(content: string): ExtractedZip[] {
  const references = extractAllReferences(content)
  const zips: ExtractedZip[] = []
  
  // Find each reference in the content to get its position
  references.forEach(ref => {
    if (ref.type === 'zip') {
      if (!isLikelyZipId(ref.id)) {
        return
      }
      const index = content.indexOf(ref.fullMatch)
      if (index !== -1) {
        zips.push({
          raw: ref.fullMatch,
          id: ref.id,
          type: 'zip',
          tokens: '0',
          name: '',
          description: ref.optionalContent || '',
          optionalContent: ref.optionalContent,
          index,
          length: ref.fullMatch.length
        })
      }
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

function isToolSharedForGroup(
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
    /** See calculateRecoveryHoldByIndex — blocks automatic zip compression for failed/interrupted trailing runs. */
    recoveryHold?: boolean
    /** Replays one stored, byte-stable reasoning block until the same agent completes a later successful turn. */
    interruptedReasoningRecoveryActive?: boolean
  }
): Promise<string> {
  // Import zipping service to check unzipped status
  const { zippingService } = await import('$lib/services/zipping')
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
  const validZipIdsRaw = Array.isArray((_message as any)?.metadata?.zipIds)
    ? (_message as any)?.metadata?.zipIds
    : null
  const validZipIds = validZipIdsRaw
    ? new Set(validZipIdsRaw.map((id: string) => normalizeId(id)))
    : null

  if (content) {
    content = stripZipControlBlocks(content)
  }

  const zips = extractZips(content).filter((zip) => {
    if (!validZipIds) return true
    return validZipIds.has(normalizeId(zip.id))
  })
  let compiled = content
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
      const isUnzipped = zippingService.isUnzipped(checkZipId)
      const isRezipped = zippingService.isRezipped(checkZipId)
      const messagesFromEnd =
        options?.agentMessagesFromEnd ?? totalMessages - messageIndex - 1
      
      const toolNameForZip =
        zipData.metadata?.operationKind || zipData.metadata?.toolName || zipData.name

      const activation = calculateZipActivation({
        zipType: zipData.type,
        messagesFromEnd,
        zipData,
        agentSettings: agent,
        globalSettings: globalZipSettings,
        toolName: toolNameForZip,
        fallbackTokens: zipData.tokens,
        isUnzipped,
        isRezipped,
        recoveryHold: options?.recoveryHold === true
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

      const buildExpandedContent = async () => {
        let expandedContent = zipData.content

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
          const alreadyWrapped = payloadContent.includes('<cool_tool')
          if (payloadForAi) {
            expandedContent = buildCoolToolAiContent(zip.id, zipData, payloadForAi)
          } else if (alreadyWrapped) {
            expandedContent = payloadContent
          } else {
            // Wrap JSON payload once as a cool_tool tag so messageFormatter can parse it
            const payloadStr = typeof payloadContent === 'string'
              ? payloadContent
              : JSON.stringify(payloadContent)
            const scriptContent = escapeScriptContent(payloadStr)
            expandedContent = `<cool_tool data-zip-id='${zip.id}' data-zip-type='cool_tool'><script type="application/json" class="cool-tool-payload">${scriptContent}<\/script></cool_tool>`
          }
        }

        return expandedContent
      }

      if (shouldAppend && shouldExpose) {
        const expandedContent = await buildExpandedContent()
        options?.onZipExposure?.({
          zipId: zip.id,
          zip,
          zipData,
          expandedContent,
          message: _message
        })
      }

      if (shouldCompress || (shouldAppend && shouldExpose)) {
        const optionalContent = zip.optionalContent || zip.description
        const compressedZip = createReference('zip', zip.id, optionalContent)
        compiled = compiled.substring(0, start) +
          compressedZip +
          compiled.substring(start + zip.length)
        offset += compressedZip.length - zip.length
      } else {
        // When expanding zips that are within the buffer zone OR manually unzipped
        const expandedContent = await buildExpandedContent()
        
        compiled = compiled.substring(0, start) +
          expandedContent +
          compiled.substring(start + zip.length)
        offset += expandedContent.length - zip.length
      }
    } catch (error) {
      console.warn('[compileForAI] Failed to resolve zip during AI history compilation:', {
        zipId: zip.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
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
    const note = reason
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
    compiled = compiled.trim().length > 0
      ? `${preservedReasoningHistory}\n\n${compiled}`
      : preservedReasoningHistory
  }
  if (interruptedReasoningRecovery) {
    compiled = compiled.trim().length > 0
      ? `${compiled}\n\n${interruptedReasoningRecovery}`
      : interruptedReasoningRecovery
  }

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

export async function compileForUserBatch(content: string): Promise<string> {
  const zips = extractZips(content)
  if (zips.length === 0) return content
  
  const zipIds = zips.map(t => t.id)
  logger.debug('[compileForUserBatch] Resolving zip IDs:', zipIds)
  const zipDataMap = await batchGetZips(zipIds)
  
  let compiled = content
  
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
    
    compiled = compiled.substring(0, zip.index) +
      expandedContent +
      compiled.substring(zip.index + zip.length)
  }
  
  return compiled
}
