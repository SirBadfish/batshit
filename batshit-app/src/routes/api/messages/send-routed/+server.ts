import { open, unlink } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { json } from '@sveltejs/kit'
import { logger } from '$lib/utils/logger'
import type { RequestHandler } from './$types'
import { messageRouter } from '$lib/server/services/messageRouter'
import {
  DatabaseService,
  type PrecompiledHistory,
} from '$lib/services/databaseRedis.server'
import type {
  AgentRow,
  ChatMessage,
  UserSettingsRow,
} from '$lib/types/database'
import type { ModelCapabilities, SavedModel } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import { redis } from '$lib/server/redis'
import { InvalidToolInputError, NoSuchToolError, type ModelMessage } from 'ai'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import {
  createZipFromContent,
  reserveZipId,
  type ZipReference,
} from '$lib/server/zipService'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import type { ExecutionRuntimeDetails } from '$lib/types/executionViewer'
import { getTypeZipSettings } from '$lib/utils/toolRenderMap'
import { normalizeAgentBrowserCommandName } from '$lib/utils/toolNameNormalization'
import { bytesToBlob } from '$lib/utils/binary'
import {
  isCliPrimaryAgentType,
  isManagedPrimaryAgentType,
  isN8nPrimaryAgentType,
  normalizePrimaryAgentType,
} from '$lib/utils/primaryAgentType'
import {
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
} from '$lib/utils/subagentType'
import {
  buildClaudeLlmCapture,
  buildCodexLlmCapture,
  buildTokenStat,
  buildTokenUsage,
  buildVercelLlmCapture,
} from '$lib/server/services/executionViewerLlmCapture'
import {
  StreamEventAdapter,
  type CanonicalStreamEvent,
  type VoiceMetadata,
} from '$lib/server/services/streamEventAdapter'
import { resolveVoiceConfigForMetadata } from '$lib/server/services/voiceService'
import { buildVoiceRuntimeGuidanceForProvider } from '$lib/server/services/voiceRuntimeGuidance'
import { prepareManagedHistoryMessages } from '$lib/server/services/sendRoutedHistory'
import { parseJsonLike, normalizeToolArgs } from '$lib/server/services/sseToolNormalization'
import { isContextExhaustionError } from '$lib/server/services/contextExhaustion'
import {
  extractUsageFromRawPayload as extractUsageFromRawChunk,
  hasUsageValues,
  mergeUsageLike,
  outputTokensForUsage,
  type ApiUsageLike,
} from '$lib/server/services/apiProviderUsage'
import type { NativeModeRequest } from '$lib/server/services/vercelBrain'
import {
  initializeKeyspaceNotifications,
  setupSessionMonitoring,
  cleanupSessionMonitoring,
  type VisualIndicatorEvent,
} from '$lib/server/visualIndicatorService'
import { generateMessageId } from '$lib/utils/messageId'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import {
  collectReasoningTextFromFinish,
  extractReasoningTextFromRawChunk,
  resolveTaggedReasoningTagName,
  withReasoningProviderOptions,
} from '$lib/utils/reasoningDisplay'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import { N8N_ONLY_CONNECTION_IDS } from '$lib/server/constants/modelConnections'
import { N8N_ONLY_PROVIDER_IDS } from '$lib/data/model-compatibility-registry'
import { listLocalAiServers } from '$lib/server/services/localAiServers'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import { buildAgentProfileId } from '$lib/server/services/codexProfileManager'
import type { CodexRuntimeSettings } from '$lib/types/codex'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import type { ClaudeRuntimeSettings } from '$lib/types/claude'
import { replacePromptVariables } from '$lib/utils/promptVariables'
import { THINKING_INDICATOR } from '$lib/utils/thinkingIndicator'
import { resolveMCPSelections } from '$lib/server/services/mcpSelectionResolver'
import type { MCPSelectionResolution } from '$lib/server/services/mcpSelectionResolver'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import {
	  getActiveSessionTurn,
	  registerSessionTurn,
	  clearSessionTurn,
	  registerN8nPrimaryRun,
	  clearN8nPrimaryRun,
	  registerStreamAbort,
  clearStreamAbort,
  registerGroupAbort,
  clearGroupAbort,
} from '$lib/server/services/streamAbortRegistry'
import type {
  GroupChatSessionConfig,
  GroupChatSpeakPolicy,
} from '$lib/types/groupChat'
import { GROUP_CHAT_SESSION_DEFAULTS } from '$lib/types/groupChat'
import type {
  ToolApprovalMode,
  ToolApprovalEntry,
  ToolApprovalResponse,
  ToolApprovalSummary,
} from '$lib/types/tool-approvals'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl
} from '$lib/server/services/batshitServerUrls'
import {
  resolveScreenshotUploadModelUrl,
  resolveUploadConfigForScreenshot,
  type ScreenshotUploadConfig,
} from '$lib/server/services/clipUrlResolver'
import {
  buildGroupSystemPromptAddendum,
  buildInterAgentPrompt,
  isAgentAddressed,
  matchesTopic,
  normalizeGroupChatConfig,
  parseLeadingGroupControlFromBuffer,
  stripGroupChatPresentationControls,
  stripRepeatedLeadingGroupControlBlocks,
} from '$lib/server/services/groupChatUtils'
import { resolveNativeBashMapping } from '$lib/server/services/bashCommandMapper'
import {
  MODE4_PRELAUNCH_STYLE,
  resolveMode4MemoryOwner,
} from '$lib/constants/mode4'
import {
  applyImageTransportOverrides,
  classifyLocalImageUrlRuntimeFailure,
  type ImageTransportOverride,
  isLocalProviderId,
} from '$lib/server/services/localImageTransportPolicy'
import {
  IMAGE_INPUT_UNSUPPORTED_CODE,
  buildImageInputUnsupportedMessage,
  classifyImageInputUnsupportedRuntimeFailure,
  modelAllowsImageInput,
} from '$lib/server/services/modelInputCapabilities'
import {
  decrementSessionClipDurations,
  listActiveClipIds,
  normalizeSessionClipState,
  tickTemporaryClipReattach,
} from '$lib/server/services/sessionClipState'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import { selectFinishZipInput } from '$lib/server/services/managedStreamFinalization'
import { applyUnavailableWebSearchMetadata } from '$lib/utils/webSearchAvailability'
import { nativeToolService } from '$lib/server/services/nativeTools'
import { normalizeAssignedSubagent } from '$lib/server/services/assignedSubagentNormalization'
import {
  internalServiceHeaders,
  isTrustedInternalRequest,
} from '$lib/server/services/internalRequestAuth'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  resolveRuntimeN8nBaseUrl,
  rewriteBatshitCallbackUrlsForN8nRuntime,
  rewriteLoopbackUrlForRuntimeBase,
} from '$lib/server/services/runtimeUrlRewrites'
import {
  collectTrustedClipIdsFromMetadata,
  neutralizeAllClipReferenceSyntax,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax,
} from '$lib/utils/zipReferenceSafety'
import {
  buildPromptBudgetReport,
  resolveBudgetOutputReserve,
} from '$lib/server/services/contextBudgetPreflight'
import {
  CODEX_NATIVE_BASE_OVERHEAD_TOKENS,
  estimateCodexProjectInstructionTokens,
  estimateCodexProjectInstructionChars,
} from '$lib/server/services/contextTokenPreview'
import { CLI_WRAPPER_OVERHEAD_TOKENS } from '$lib/utils/tokenPanel'
import {
  resolveAutoCompactTriggerTokens,
  resolveEffectiveAutoCompactSettings,
} from '$lib/utils/contextCompaction'

type UsageLike = NonNullable<ApiUsageLike>

const PRIMARY_CODEX_PROVIDER_ID = 'openai-codex'
const PRIMARY_CLAUDE_PROVIDER_ID = 'anthropic-claude-cli'
const CODEX_PROVIDER_IDS = new Set(['codex', PRIMARY_CODEX_PROVIDER_ID])
const CLAUDE_PROVIDER_IDS = new Set(['claude-cli', PRIMARY_CLAUDE_PROVIDER_ID])
const CODEX_CONNECTION_ID = 'codex-cli'
const CLAUDE_CONNECTION_ID = 'claude-cli'
const SIMULATED_STREAM_DELAY_MS = 22
const SIMULATED_STREAM_CHUNK_TARGET = 36
const TOOL_APPROVAL_TIMEOUT_MS = 180_000
const TOOL_APPROVAL_TIMEOUT_SECONDS = TOOL_APPROVAL_TIMEOUT_MS / 1000
// Hard cap on automatic continuations after mid-run context-window exhaustion,
// per user request, so a pathological task can never loop forever.
const MAX_CONTEXT_CONTINUATIONS = 3

async function consumePostCompileSessionClips(sessionId: string) {
  const stateKey = `session:${sessionId}:clip_state`
  const existingState = await redis.get(stateKey)
  if (!existingState) return

  const nextState = tickTemporaryClipReattach(
    decrementSessionClipDurations(normalizeSessionClipState(sessionId, existingState))
  )

  await redis.set(stateKey, nextState)

  const activeKey = `session:${sessionId}:active_clips`
  const activeClipIds = listActiveClipIds(nextState)
  await redis.del(activeKey)
  for (const activeClipId of activeClipIds) {
    await redis.sAdd(activeKey, activeClipId)
  }
}

async function collectTrustedClipIdsForSession(
  sessionId: string,
  metadata: unknown,
): Promise<string[]> {
  const ids = new Set(collectTrustedClipIdsFromMetadata(metadata))

  try {
    const state = normalizeSessionClipState(
      sessionId,
      await redis.get(`session:${sessionId}:clip_state`),
    )
    for (const clipId of listActiveClipIds(state)) {
      ids.add(clipId)
    }
  } catch (error) {
    console.warn('[send-routed] Failed to load trusted session clip ids', {
      sessionId,
      error,
    })
  }

  return Array.from(ids)
}

type ApprovalHistoryMessage = {
  id?: string
  created_at?: string
  timestamp?: string
  metadata?: Record<string, any> | null
}

type ApprovalStateRecord = {
  approvalId: string
  status: ToolApprovalEntry['status']
  toolName?: string
  expiresAt?: string
  expiresAtMs: number | null
  messageId?: string
}

type ApprovalStateSnapshot = {
  byId: Map<string, ApprovalStateRecord>
  newlyExpired: Array<{
    approvalId: string
    toolName?: string
    expiredAt: string
    timeoutSeconds: number
  }>
  updates: Array<{
    messageId: string
    metadata: Record<string, any>
  }>
}

function shouldEnableTools(
  providerId: string | null | undefined,
  capabilities?: ModelCapabilities | null,
): boolean {
  const normalized = providerId?.toLowerCase().trim() ?? ''
  if (capabilities?.tools === false) return false
  if (isLocalProviderId(normalized)) {
    return capabilities?.tools === true
  }
  return true
}

function normalizeImageTransport(value: unknown): ImageTransportOverride {
  if (value === 'url' || value === 'auto') {
    return value
  }
  return 'auto'
}

const DATA_IMAGE_URL_IN_TEXT_REGEX =
  /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi

function createRoutedInputError(
  message: string,
  code: string,
  status = 400,
): Error & { code: string; status: number } {
  const err = new Error(message) as Error & { code: string; status: number }
  err.code = code
  err.status = status
  return err
}

function getFailureStatus(error: unknown): number | null {
  const status = (error as any)?.status ?? (error as any)?.statusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function getFailureCode(error: unknown): string | null {
  const code = (error as any)?.code
  return typeof code === 'string' && code.trim().length > 0
    ? code.trim()
    : null
}

function getFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }
  const message = String(error ?? '').trim()
  return message || 'The response failed before streaming started.'
}

async function extractFailurePayload(response: Response): Promise<{
  message: string
  details: string | null
  code: string | null
}> {
  const payload = await response.clone().json().catch(() => null)
  const error =
    payload && typeof payload?.error === 'string'
      ? payload.error.trim()
      : ''
  const details =
    payload && typeof payload?.details === 'string'
      ? payload.details.trim()
      : ''
  const code =
    payload && typeof payload?.code === 'string' ? payload.code.trim() : ''

  return {
    message:
      (details && details !== error ? details : error) ||
      'The response failed before streaming started.',
    details: details || null,
    code: code || null,
  }
}

async function persistFailedAssistantTurn(options: {
  sessionId?: string | null
  userId?: string | null
  agentId?: string | null
  messageId?: string | null
  message: string
  details?: string | null
  code?: string | null
  status?: number | null
  metadata?: Record<string, any> | null
}) {
  const sessionId =
    typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  const userId = typeof options.userId === 'string' ? options.userId.trim() : ''
  const agentId =
    typeof options.agentId === 'string' ? options.agentId.trim() : ''
  const messageId =
    typeof options.messageId === 'string' ? options.messageId.trim() : ''

  if (!sessionId || !userId || !agentId || !messageId) return

  const now = new Date().toISOString()
  const cleanMessage =
    redactDataImageUrlsInText(
      options.message?.trim() ||
        options.details?.trim() ||
        'The response failed before streaming started.',
    ).value || 'The response failed before streaming started.'
  const cleanDetails =
    typeof options.details === 'string' && options.details.trim().length > 0
      ? redactDataImageUrlsInText(options.details.trim()).value
      : null

  try {
    await redis.saveMessage({
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      agent_id: agentId,
      role: 'assistant',
      status: 'error',
      content: cleanMessage,
      created_at: now,
      metadata: {
        ...(options.metadata ?? {}),
        error_message: cleanMessage,
        response_failed: true,
        failed_at: now,
        ...(cleanDetails && cleanDetails !== cleanMessage
          ? { error_details: cleanDetails }
          : {}),
        ...(options.code ? { error_code: options.code } : {}),
        ...(typeof options.status === 'number'
          ? { http_status: options.status }
          : {}),
      },
    } as Partial<ChatMessage>)
  } catch (persistError) {
    console.error('[send-routed] Failed to persist assistant error message:', {
      sessionId,
      messageId,
      error: persistError,
    })
  }
}

function redactDataImageUrlsInText(value: string): {
  value: string
  redactions: number
} {
  if (!value || !value.toLowerCase().includes('data:image/')) {
    return { value, redactions: 0 }
  }

  let redactions = 0
  const sanitized = value.replace(
    DATA_IMAGE_URL_IN_TEXT_REGEX,
    (_fullMatch, mediaType: string, base64Data: string) => {
      redactions += 1
      const approxBytes = Math.max(0, Math.floor((base64Data.length * 3) / 4))
      return `[redacted ${mediaType} data URL (${approxBytes} bytes)]`
    },
  )

  return { value: sanitized, redactions }
}

function findDataImageUrlInTextMessages(
  messages: any[],
): { messageIndex: number; role: string | null } | null {
  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const message = messages[messageIndex]
    const role = typeof message?.role === 'string' ? message.role : null
    const content = message?.content

    if (typeof content === 'string') {
      if (DATA_IMAGE_URL_IN_TEXT_REGEX.test(content)) {
        DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
        return { messageIndex, role }
      }
      DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
      continue
    }

    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part === 'string') {
        if (DATA_IMAGE_URL_IN_TEXT_REGEX.test(part)) {
          DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
          return { messageIndex, role }
        }
        DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
        continue
      }

      if (part?.type !== 'text' || typeof part?.text !== 'string') continue
      if (DATA_IMAGE_URL_IN_TEXT_REGEX.test(part.text)) {
        DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
        return { messageIndex, role }
      }
      DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    }
  }

  return null
}

function hasDataImageUrlInUserTurnContent(content: unknown): boolean {
  if (typeof content === 'string') {
    const result = DATA_IMAGE_URL_IN_TEXT_REGEX.test(content)
    DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    return result
  }

  if (Array.isArray(content)) {
    return content.some((entry) => hasDataImageUrlInUserTurnContent(entry))
  }

  if (!content || typeof content !== 'object') return false
  const candidate = content as Record<string, unknown>

  if (typeof candidate.text === 'string') {
    const result = DATA_IMAGE_URL_IN_TEXT_REGEX.test(candidate.text)
    DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    if (result) return true
  }

  if (typeof candidate.content === 'string') {
    const result = DATA_IMAGE_URL_IN_TEXT_REGEX.test(candidate.content)
    DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    if (result) return true
  }

  return false
}

function sanitizeDataImageUrlsInTextMessages(messages: any[]): {
  redactions: number
} {
  let redactions = 0

  for (const message of messages) {
    const content = message?.content

    if (typeof content === 'string') {
      const sanitized = redactDataImageUrlsInText(content)
      if (sanitized.redactions > 0) {
        message.content = sanitized.value
        redactions += sanitized.redactions
      }
      continue
    }

    if (!Array.isArray(content)) continue
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex]
      if (typeof part === 'string') {
        const sanitized = redactDataImageUrlsInText(part)
        if (sanitized.redactions > 0) {
          content[partIndex] = sanitized.value
          redactions += sanitized.redactions
        }
        continue
      }

      if (part?.type !== 'text' || typeof part?.text !== 'string') continue
      const sanitized = redactDataImageUrlsInText(part.text)
      if (sanitized.redactions > 0) {
        part.text = sanitized.value
        redactions += sanitized.redactions
      }
    }
  }

  return { redactions }
}

function sanitizePayloadForLogs<T>(value: T, keyHint?: string): T {
  const seen = new WeakSet<object>()

  const sanitizeString = (input: string, key?: string): string => {
    const dataUrlSanitized = redactDataImageUrlsInText(input)
    let next = dataUrlSanitized.value
    const base64Key = key
      ? /(base64|localbase64|b64|b64_json|image_data)/i.test(key)
      : false

    if (base64Key) {
      const trimmed = next.trim()
      if (
        trimmed.length > 0 &&
        (isLikelyBase64(trimmed) || trimmed.startsWith('data:'))
      ) {
        const approxBytes = Math.max(0, Math.floor((trimmed.length * 3) / 4))
        return `[redacted base64 payload (${approxBytes} bytes)]`
      }
    }

    return next
  }

  const visit = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      return sanitizeString(node, key)
    }
    if (!node || typeof node !== 'object') {
      return node
    }
    if (seen.has(node as object)) {
      return node
    }
    seen.add(node as object)

    if (Array.isArray(node)) {
      return node.map((entry) => visit(entry, key))
    }

    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(
      node as Record<string, unknown>,
    )) {
      output[childKey] = visit(childValue, childKey)
    }
    return output
  }

  return visit(value, keyHint) as T
}

async function resolveImageTransportConfig(options: {
  userId: string
  providerId: string | null
  presetId?: string | null
  localServers?: Awaited<ReturnType<typeof listLocalAiServers>> | null
}): Promise<{
  transport: ImageTransportOverride
  imageBaseUrl?: string | null
}> {
  const { userId, providerId, presetId } = options
  if (!providerId || !isLocalProviderId(providerId)) {
    return { transport: 'auto' }
  }

  const localServers =
    options.localServers ??
    (userId ? await listLocalAiServers(userId).catch(() => null) : null)
  const server = localServers?.find((entry) => entry.id === providerId) ?? null
  const defaultTransport = server?.imageTransport ?? 'auto'
  const imageBaseUrl = server?.imageBaseUrl ?? null

  let presetTransport: ImageTransportOverride = 'auto'
  if (presetId) {
    try {
      const preset = (await redis.get(`model:${presetId}`)) as SavedModel | null
      presetTransport = normalizeImageTransport(preset?.imageTransport)
    } catch (error) {
      console.warn(
        '[Send-Routed] Failed to load model preset image transport:',
        error,
      )
    }
  }

  const transport =
    presetTransport !== 'auto' ? presetTransport : defaultTransport

  return { transport, imageBaseUrl }
}

function createRouteError(message: string, status: number, code: string): Error {
  const error = new Error(message) as Error & {
    status?: number
    code?: string
  }
  error.status = status
  error.code = code
  return error
}

async function loadRuntimeModelPreset(
  presetId: string | null | undefined,
  label: 'primary' | 'fallback',
): Promise<SavedModel | null> {
  const normalized = typeof presetId === 'string' ? presetId.trim() : ''
  if (!normalized) {
    return null
  }

  try {
    const preset = (await redis.get(`model:${normalized}`)) as SavedModel | null
    if (!preset) {
      throw createRouteError(
        `Selected ${label} model preset no longer exists. Pick the model again in Agent settings.`,
        400,
        'model_preset_missing',
      )
    }
    return preset
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as any).status === 'number'
    ) {
      throw error
    }
    console.error(
      `[Send-Routed] Failed to load selected ${label} model preset:`,
      error,
    )
    throw createRouteError(
      `Failed to load selected ${label} model preset.`,
      500,
      'model_preset_load_failed',
    )
  }
}

function normalizeToolApprovalMode(value: unknown): ToolApprovalMode {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'all') return 'all'
    if (normalized === 'off' || normalized === 'none' || normalized === 'never')
      return 'off'
  }
  if (value === true) return 'all'
  return 'off'
}

function normalizeToolApprovalResponses(
  value: unknown,
): ToolApprovalResponse[] {
  if (!Array.isArray(value)) return []
  const responses: ToolApprovalResponse[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const approvalId = (entry as any).approvalId || (entry as any).approval_id
    const approved = (entry as any).approved
    if (typeof approvalId !== 'string' || approvalId.trim().length === 0)
      continue
    if (typeof approved !== 'boolean') continue
    const response: ToolApprovalResponse = {
      type: 'tool-approval-response',
      approvalId: approvalId.trim(),
      approved,
    }
    if (typeof (entry as any).reason === 'string') {
      response.reason = (entry as any).reason
    }
    responses.push(response)
  }
  return responses
}

function providerMessagesContainApprovalRequest(
  providerMessages: ModelMessage[],
  approvalIds: Set<string>,
): boolean {
  if (approvalIds.size === 0) return true

  for (const message of providerMessages) {
    const content = (message as any)?.content
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (part?.type !== 'tool-approval-request') continue
      const approvalId =
        typeof part?.approvalId === 'string'
          ? part.approvalId.trim()
          : typeof part?.approval_id === 'string'
            ? part.approval_id.trim()
            : ''
      if (approvalId && approvalIds.has(approvalId)) {
        return true
      }
    }
  }

  return false
}

async function loadProviderMessagesForApprovalsFromRedis(
  sessionId: string,
  criteria: ProviderMessageSource,
  approvalIds: Set<string>,
): Promise<ModelMessage[]> {
  const persisted = await redis.getMessages(sessionId, 300)
  if (!Array.isArray(persisted) || persisted.length === 0) {
    return []
  }

  for (let i = persisted.length - 1; i >= 0; i -= 1) {
    const message = persisted[i] as any
    if (!message || message.role !== 'assistant') continue

    if (criteria.agentId) {
      const messageAgentId =
        message.agent_id ||
        message.agentId ||
        message?.metadata?.agentId ||
        message?.metadata?.agent_id ||
        null
      if (messageAgentId !== criteria.agentId) continue
    }

    const metadata = message.metadata ?? {}
    const providerMessages = coerceModelMessages(metadata.providerMessages)
    if (!providerMessages.length) continue

    const source = metadata.providerMessageSource ?? {}
    if (
      criteria.providerId &&
      source.providerId &&
      source.providerId !== criteria.providerId
    ) {
      continue
    }
    if (
      criteria.connectionId &&
      source.connectionId &&
      source.connectionId !== criteria.connectionId
    ) {
      continue
    }
    // For approval resumes we only need the exact pending approval request context.
    // Model IDs can drift (aliases/versioned IDs), so do not hard-reject on modelId here.

    if (providerMessagesContainApprovalRequest(providerMessages, approvalIds)) {
      return providerMessages
    }
  }

  return []
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeApprovalStatus(value: unknown): ToolApprovalEntry['status'] {
  if (value === 'approved' || value === 'denied' || value === 'expired')
    return value
  return 'pending'
}

function extractApprovalToolName(
  entry: Record<string, any>,
): string | undefined {
  const direct = typeof entry.toolName === 'string' ? entry.toolName.trim() : ''
  if (direct) return direct

  const toolCall = entry.toolCall
  if (toolCall && typeof toolCall === 'object') {
    const nestedName =
      typeof (toolCall as any).toolName === 'string'
        ? (toolCall as any).toolName.trim()
        : typeof (toolCall as any).tool_name === 'string'
          ? (toolCall as any).tool_name.trim()
          : ''
    if (nestedName) return nestedName
  }

  return undefined
}

function countApprovalEntries(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object') return 0
  const summary = (metadata as Record<string, any>).toolApprovals
  if (!summary || typeof summary !== 'object') return 0
  const approvals = (summary as Record<string, any>).approvals
  return Array.isArray(approvals) ? approvals.length : 0
}

function buildApprovalHistoryMessages(
  requestMessages: unknown,
  persistedMessages: ChatMessage[],
): ApprovalHistoryMessage[] {
  const byId = new Map<string, ApprovalHistoryMessage>()
  const insertionOrder: string[] = []
  const idless: ApprovalHistoryMessage[] = []

  const register = (raw: unknown, preferExisting = false) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, any>
    const messageId = typeof message.id === 'string' ? message.id : ''
    const normalized: ApprovalHistoryMessage = {
      ...(messageId ? { id: messageId } : {}),
      ...(typeof message.created_at === 'string'
        ? { created_at: message.created_at }
        : {}),
      ...(typeof message.timestamp === 'string'
        ? { timestamp: message.timestamp }
        : {}),
      metadata:
        message.metadata && typeof message.metadata === 'object'
          ? (message.metadata as Record<string, any>)
          : undefined,
    }

    if (!messageId) {
      idless.push(normalized)
      return
    }

    const existing = byId.get(messageId)
    if (!existing) {
      byId.set(messageId, normalized)
      insertionOrder.push(messageId)
      return
    }

    if (preferExisting) {
      const existingApprovalCount = countApprovalEntries(existing.metadata)
      const incomingApprovalCount = countApprovalEntries(normalized.metadata)
      if (existingApprovalCount > 0 || incomingApprovalCount === 0) {
        return
      }
    }

    byId.set(messageId, {
      ...existing,
      ...normalized,
      metadata: normalized.metadata ?? existing.metadata,
    })
  }

  if (Array.isArray(persistedMessages)) {
    for (const message of persistedMessages) {
      register(message)
    }
  }

  if (Array.isArray(requestMessages)) {
    for (const message of requestMessages) {
      register(message, true)
    }
  }

  const combined = [
    ...insertionOrder.map((id) => byId.get(id)).filter(Boolean),
    ...idless,
  ] as ApprovalHistoryMessage[]

  combined.sort((a, b) => {
    const aMs = parseTimestampMs(a.created_at ?? a.timestamp)
    const bMs = parseTimestampMs(b.created_at ?? b.timestamp)
    if (aMs === null && bMs === null) return 0
    if (aMs === null) return 1
    if (bMs === null) return -1
    return aMs - bMs
  })

  return combined
}

function analyzeApprovalState(
  messages: ApprovalHistoryMessage[],
  nowMs = Date.now(),
): ApprovalStateSnapshot {
  const byId = new Map<string, ApprovalStateRecord>()
  const newlyExpired: ApprovalStateSnapshot['newlyExpired'] = []
  const updates: ApprovalStateSnapshot['updates'] = []
  const nowIso = new Date(nowMs).toISOString()

  for (const message of messages) {
    const metadata =
      message.metadata && typeof message.metadata === 'object'
        ? (message.metadata as Record<string, any>)
        : null
    const summary =
      metadata?.toolApprovals && typeof metadata.toolApprovals === 'object'
        ? (metadata.toolApprovals as Record<string, any>)
        : null
    if (!summary) continue

    const approvals = Array.isArray(summary.approvals) ? summary.approvals : []
    if (approvals.length === 0) continue

    const messageCreatedAtMs = parseTimestampMs(
      message.created_at ?? message.timestamp,
    )
    let nextApprovals: any[] | null = null

    for (let idx = 0; idx < approvals.length; idx += 1) {
      const rawEntry = approvals[idx]
      if (!rawEntry || typeof rawEntry !== 'object') continue

      const entry = rawEntry as Record<string, any>
      const approvalId =
        typeof entry.approvalId === 'string' ? entry.approvalId.trim() : ''
      if (!approvalId) continue

      const requestedAtMs = parseTimestampMs(entry.requestedAt)
      const fallbackRequestedAtMs = requestedAtMs ?? messageCreatedAtMs
      const explicitExpiresAtMs = parseTimestampMs(entry.expiresAt)
      const expiresAtMs =
        explicitExpiresAtMs ??
        (fallbackRequestedAtMs !== null
          ? fallbackRequestedAtMs + TOOL_APPROVAL_TIMEOUT_MS
          : null)

      const requestedAt =
        requestedAtMs !== null
          ? new Date(requestedAtMs).toISOString()
          : fallbackRequestedAtMs !== null
            ? new Date(fallbackRequestedAtMs).toISOString()
            : undefined
      const expiresAt =
        expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : undefined

      let status = normalizeApprovalStatus(entry.status)
      let expiredAt =
        parseTimestampMs(entry.expiredAt) !== null
          ? new Date(parseTimestampMs(entry.expiredAt) as number).toISOString()
          : undefined
      let changed = false

      if (
        status === 'pending' &&
        expiresAtMs !== null &&
        nowMs >= expiresAtMs
      ) {
        status = 'expired'
        expiredAt = nowIso
        changed = true
        newlyExpired.push({
          approvalId,
          toolName: extractApprovalToolName(entry),
          expiredAt: nowIso,
          timeoutSeconds: TOOL_APPROVAL_TIMEOUT_SECONDS,
        })
      }

      if (!entry.requestedAt && requestedAt) changed = true
      if (!entry.expiresAt && expiresAt) changed = true
      if (entry.status !== status) changed = true
      if (status === 'expired' && !entry.expiredAt && expiredAt) changed = true

      const normalizedEntry = changed
        ? {
            ...entry,
            status,
            ...(status === 'expired' ? { submitted: false } : {}),
            ...(requestedAt ? { requestedAt } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            ...(status === 'expired' && expiredAt ? { expiredAt } : {}),
          }
        : entry

      if (changed) {
        if (!nextApprovals) {
          nextApprovals = [...approvals]
        }
        nextApprovals[idx] = normalizedEntry
      }

      byId.set(approvalId, {
        approvalId,
        status,
        toolName: extractApprovalToolName(normalizedEntry),
        expiresAt,
        expiresAtMs,
        messageId: typeof message.id === 'string' ? message.id : undefined,
      })
    }

    if (
      nextApprovals &&
      typeof message.id === 'string' &&
      message.id.trim().length > 0
    ) {
      updates.push({
        messageId: message.id.trim(),
        metadata: {
          ...(metadata ?? {}),
          toolApprovals: {
            ...summary,
            approvals: nextApprovals,
          },
        },
      })
    }
  }

  return { byId, newlyExpired, updates }
}

function buildToolApprovalTimeoutAddendum(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return null

  const notices = raw
    .filter((entry): entry is { approvalId: string; toolName?: string } => {
      return Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof (entry as any).approvalId === 'string' &&
        (entry as any).approvalId.trim().length > 0,
      )
    })
    .map((entry) => ({
      approvalId: entry.approvalId.trim(),
      toolName:
        typeof entry.toolName === 'string' && entry.toolName.trim().length > 0
          ? entry.toolName.trim()
          : undefined,
    }))

  if (notices.length === 0) return null

  const lines = [
    '==== TOOL APPROVAL TIMEOUT ====',
    `One or more tool approvals expired after ${TOOL_APPROVAL_TIMEOUT_SECONDS / 60} minutes, so those tool calls were not executed.`,
    'In your next reply, briefly explain the timeout and ask the user to tell you when to run the tool again.',
    'Suggested phrasing: "The tool I tried requires your approval, but approvals expire after 3 minutes. Tell me when you are back and I will run it again."',
  ]

  const sample = notices.slice(0, 3)
  if (sample.length > 0) {
    lines.push('Expired approvals:')
    for (const entry of sample) {
      lines.push(`- ${entry.toolName ?? `approval ${entry.approvalId}`}`)
    }
  }

  return lines.join('\n')
}

function buildInterruptionAddendum(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, any>
  const note = typeof record.note === 'string' ? record.note.trim() : ''
  const previousMessageId =
    typeof record.previousMessageId === 'string' &&
    record.previousMessageId.trim().length > 0
      ? record.previousMessageId.trim()
      : null

  const lines = [
    '==== INTERRUPTION NOTE ====',
    'The previous response was interrupted by the user while streaming.',
    'Partial output (if any) is preserved in the chat history above.',
  ]

  if (previousMessageId) {
    lines.push(`Previous message id: ${previousMessageId}.`)
  }

  if (note) {
    lines.push(note)
  }

  return lines.join('\n')
}

function buildContextContinuationAddendum(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, any>
  const attempt = Number.isFinite(record.attempt) ? Number(record.attempt) : null
  const maxAttempts = Number.isFinite(record.maxAttempts)
    ? Number(record.maxAttempts)
    : null
  const previousMessageId =
    typeof record.previousMessageId === 'string' &&
    record.previousMessageId.trim().length > 0
      ? record.previousMessageId.trim()
      : null

  const lines = [
    '==== CONTEXT LIMIT CONTINUATION ====',
    'Your previous response hit the model context window limit mid-task and was stopped.',
    'The partial work, including every completed tool call, is preserved in the chat history above. Do not redo steps that already completed.',
    'Pick the original task back up from exactly where it stopped and continue working. If only a final summary remained, provide it now.',
  ]

  if (previousMessageId) {
    lines.push(`Interrupted message id: ${previousMessageId}.`)
  }

  if (attempt && maxAttempts) {
    lines.push(
      `This is automatic continuation ${attempt} of at most ${maxAttempts} for this user request. Be efficient with remaining context: prefer summarizing over re-reading large files.`,
    )
  }

  return lines.join('\n')
}

async function extractToolApprovalRequests(
  result: any,
): Promise<ToolApprovalEntry[]> {
  try {
    const approvals: ToolApprovalEntry[] = []
    const seenApprovalIds = new Set<string>()
    const resolvedApprovalIds = new Set<string>()
    const partCollections: any[][] = []

    const addParts = (parts: unknown) => {
      if (Array.isArray(parts) && parts.length > 0) {
        partCollections.push(parts as any[])
      }
    }

    const addMessageContents = (messages: unknown) => {
      if (!Array.isArray(messages)) return
      for (const message of messages) {
        addParts((message as any)?.content)
      }
    }

    addParts(await Promise.resolve((result as any)?.content))
    addMessageContents(
      await Promise.resolve((result as any)?.response?.messages),
    )
    addMessageContents(await Promise.resolve((result as any)?.responseMessages))
    addMessageContents(await Promise.resolve((result as any)?.providerMessages))
    addMessageContents(
      await Promise.resolve((result as any)?.providerResponse?.messages),
    )

    const steps = await Promise.resolve((result as any)?.steps)
    if (Array.isArray(steps)) {
      for (const step of steps) {
        addParts((step as any)?.content)
        addMessageContents((step as any)?.response?.messages)
      }
    }

    const resolveToolCallId = (part: any): string => {
      if (typeof part?.toolCallId === 'string') return part.toolCallId
      if (typeof part?.tool_call_id === 'string') return part.tool_call_id
      if (typeof part?.toolCall?.toolCallId === 'string')
        return part.toolCall.toolCallId
      if (typeof part?.tool_call?.toolCallId === 'string')
        return part.tool_call.toolCallId
      return ''
    }

    const resolveApprovalId = (part: any): string => {
      if (typeof part?.approvalId === 'string') return part.approvalId.trim()
      if (typeof part?.approval_id === 'string') return part.approval_id.trim()
      return ''
    }

    const extractToolName = (toolCall: any): string | undefined => {
      return typeof toolCall?.toolName === 'string'
        ? toolCall.toolName
        : typeof toolCall?.tool_name === 'string'
          ? toolCall.tool_name
          : typeof toolCall?.name === 'string'
            ? toolCall.name
            : undefined
    }

    for (const parts of partCollections) {
      for (const part of parts) {
        if (
          part?.type !== 'tool-approval-response' &&
          part?.type !== 'tool_approval_response'
        ) {
          continue
        }
        const approvalId = resolveApprovalId(part)
        if (approvalId) {
          resolvedApprovalIds.add(approvalId)
        }
      }
    }

    for (const parts of partCollections) {
      const toolCallsById = new Map<string, any>()
      for (const part of parts) {
        if (part?.type !== 'tool-call') continue
        const callId = resolveToolCallId(part)
        if (!callId) continue
        toolCallsById.set(callId, {
          toolCallId: callId,
          toolName: part.toolName ?? part.tool_name ?? part.name,
          input: part.input ?? part.args ?? part.parameters,
        })
      }

      for (const part of parts) {
        if (part?.type !== 'tool-approval-request') continue

        const approvalId = resolveApprovalId(part)
        if (
          !approvalId ||
          seenApprovalIds.has(approvalId) ||
          resolvedApprovalIds.has(approvalId)
        )
          continue

        const callId = resolveToolCallId(part)
        const explicitToolCall =
          part.toolCall && typeof part.toolCall === 'object'
            ? part.toolCall
            : part.tool_call && typeof part.tool_call === 'object'
              ? part.tool_call
              : undefined
        const fallbackToolCall = callId ? toolCallsById.get(callId) : undefined
        const toolCall = explicitToolCall ?? fallbackToolCall
        const toolName = extractToolName(toolCall)
        const input =
          toolCall?.input ?? toolCall?.args ?? toolCall?.parameters ?? undefined
        const requestedAt =
          typeof part?.requestedAt === 'string' &&
          part.requestedAt.trim().length > 0
            ? part.requestedAt.trim()
            : new Date().toISOString()
        const requestedAtMs = parseTimestampMs(requestedAt)
        const expiresAtMs =
          typeof part?.expiresAt === 'string' &&
          part.expiresAt.trim().length > 0
            ? parseTimestampMs(part.expiresAt.trim())
            : requestedAtMs !== null
              ? requestedAtMs + TOOL_APPROVAL_TIMEOUT_MS
              : Date.now() + TOOL_APPROVAL_TIMEOUT_MS
        const expiresAt =
          typeof part?.expiresAt === 'string' &&
          part.expiresAt.trim().length > 0
            ? part.expiresAt.trim()
            : new Date(
                expiresAtMs ?? Date.now() + TOOL_APPROVAL_TIMEOUT_MS,
              ).toISOString()

        approvals.push({
          approvalId,
          status: 'pending',
          requestedAt,
          expiresAt,
          toolName,
          toolCall:
            toolCall && typeof toolCall === 'object' ? toolCall : undefined,
          input,
          source: 'vercel',
        })
        seenApprovalIds.add(approvalId)
      }
    }

    return approvals
  } catch (error) {
    console.warn('[Send-Routed] Failed to parse tool approval requests', error)
    return []
  }
}

type RawSubagent = Record<string, any>

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripToolPartOnlyText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const normalized = trimmed.replace(/\s+/g, '')
  const toolPartOnlyPattern =
    /^(?:\[(?:tool-call|tool_call|tool-result|tool_result|tool-approval-request|tool_approval_request|tool-approval-response|tool_approval_response)\])+$/i
  if (toolPartOnlyPattern.test(normalized)) {
    return ''
  }
  return value
}

function isEmptyModelMessageContent(content: unknown): boolean {
  if (content === null || content === undefined) return true
  if (typeof content === 'string') return content.trim().length === 0
  if (Array.isArray(content)) {
    return content.every((part: any) => {
      if (typeof part === 'string') return part.trim().length === 0
      if (!part || typeof part !== 'object') return true
      if (typeof part.text === 'string') return part.text.trim().length === 0
      if (typeof part.content === 'string')
        return part.content.trim().length === 0
      return false
    })
  }
  if (typeof content === 'object') {
    const record = content as Record<string, any>
    if (typeof record.text === 'string') return record.text.trim().length === 0
    if (typeof record.content === 'string')
      return record.content.trim().length === 0
  }
  return false
}

type ProviderMessageSource = {
  providerId?: string | null
  connectionId?: string | null
  modelId?: string | null
  agentId?: string | null
}

function coerceModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  const messages: ModelMessage[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const role = (entry as any).role
    const content = (entry as any).content
    if (typeof role !== 'string' || content === undefined) continue
    messages.push(entry as ModelMessage)
  }

  return messages
}

function extractProviderMessages(
  history: ChatMessage[],
  criteria: ProviderMessageSource,
): ModelMessage[] {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i] as any
    if (!message || message.role !== 'assistant') continue
    const metadata = message.metadata ?? {}
    if (criteria.agentId) {
      const messageAgentId =
        (message as any).agent_id ||
        (message as any).agentId ||
        metadata.agentId ||
        metadata.agent_id ||
        null
      if (messageAgentId !== criteria.agentId) {
        continue
      }
    }
    const providerMessages = coerceModelMessages(metadata.providerMessages)
    if (!providerMessages.length) continue
    const source = metadata.providerMessageSource ?? {}

    if (
      criteria.providerId &&
      source.providerId &&
      source.providerId !== criteria.providerId
    ) {
      continue
    }
    if (
      criteria.connectionId &&
      source.connectionId &&
      source.connectionId !== criteria.connectionId
    ) {
      continue
    }
    if (
      criteria.modelId &&
      source.modelId &&
      source.modelId !== criteria.modelId
    ) {
      continue
    }

    return providerMessages
  }

  return []
}

function hasToolParts(message: ModelMessage): boolean {
  if (message.role === 'tool') return true
  const raw = message as any
  if (Array.isArray(raw?.tool_calls) && raw.tool_calls.length > 0) return true
  if (Array.isArray(raw?.content)) {
    return raw.content.some(
      (part: any) =>
        part?.type === 'tool-call' ||
        part?.type === 'tool-result' ||
        part?.type === 'tool-approval-request' ||
        part?.type === 'tool-approval-response',
    )
  }
  return false
}

function buildProviderContinuation(
  providerMessages: ModelMessage[],
): ModelMessage[] {
  if (!providerMessages.length) return []

  const cleaned = providerMessages.filter((msg) => msg?.role !== 'system')
  if (!cleaned.length) return []

  let lastToolIndex = -1
  for (let i = cleaned.length - 1; i >= 0; i -= 1) {
    if (hasToolParts(cleaned[i]!)) {
      lastToolIndex = i
      break
    }
  }

  if (lastToolIndex === -1) return []

  let startIndex = -1
  for (let i = lastToolIndex; i >= 0; i -= 1) {
    if (cleaned[i]?.role === 'user') {
      startIndex = i
      break
    }
  }

  // Some providers only return the assistant tool-call block for approval flows.
  // Keep that tail so a follow-up tool-approval-response is not orphaned.
  if (startIndex === -1) {
    const lastToolMessage = cleaned[lastToolIndex]
    if (lastToolMessage?.role === 'tool' && lastToolIndex > 0) {
      startIndex = lastToolIndex - 1
    } else {
      startIndex = lastToolIndex
    }
  }

  const continuation = cleaned.slice(startIndex)

  // Providers (notably Anthropic) reject tool_result blocks when there is no
  // corresponding prior assistant tool_use in the immediate continuation.
  // Some saved providerMessages can begin with an orphan tool message
  // (e.g. [tool_result, assistant text]). Drop any leading tool-only blocks
  // before replaying continuation context.
  while (continuation.length > 0 && continuation[0]?.role === 'tool') {
    continuation.shift()
  }

  return continuation
}

function sanitizeProviderMessagesForPersistence(
  providerMessages: ModelMessage[],
): ModelMessage[] {
  let hasChanges = false

  const sanitized = providerMessages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !Array.isArray((message as any).content)
    ) {
      return message
    }

    const rawContent = (message as any).content as any[]
    let messageChanged = false
    const nextContent = rawContent.map((part) => {
      if (!part || typeof part !== 'object' || part.type !== 'tool-result') {
        return part
      }

      const toolName = typeof part.toolName === 'string' ? part.toolName : null
      if (
        !isNativeBashExecuteToolName(toolName) &&
        !isNativeAgentBrowserUseToolName(toolName)
      ) {
        return part
      }

      const output = part.output
      const outputParts = Array.isArray(output?.value) ? output.value : null
      const hasImagePayload =
        output?.type === 'content' &&
        Array.isArray(outputParts) &&
        outputParts.some((entry: any) => {
          const type = typeof entry?.type === 'string' ? entry.type : ''
          return (
            type === 'image-data' ||
            type === 'image-url' ||
            type === 'image-file-id'
          )
        })

      if (!hasImagePayload) {
        return part
      }

      messageChanged = true
      hasChanges = true
      return {
        ...part,
        output: {
          type: 'text',
          value:
            '[Agent Browser screenshot omitted from persisted provider context after this loop.]',
        },
      }
    })

    if (!messageChanged) return message
    return {
      ...message,
      content: nextContent,
    } as ModelMessage
  })

  return hasChanges ? sanitized : providerMessages
}

function normalizeToolResult(
  raw: any,
  toolName: string | undefined,
  input: Record<string, any>,
) {
  const parsed = parseJsonLike(raw)
  const lowerName = toolName?.toLowerCase() ?? ''

  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0]

    if (first?.type === 'coolToolResult' && first?.toolResult !== undefined) {
      return normalizeToolResult(first.toolResult, toolName, input)
    }

    if (first?.type === 'text' && typeof first.text === 'string') {
      return normalizeToolResult(first.text, toolName, input)
    }

    return parsed
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const normalized: Record<string, any> = { ...parsed }

    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      normalized.Prompt__User_Message_ === undefined &&
      typeof (input as any).Prompt__User_Message_ === 'string'
    ) {
      normalized.Prompt__User_Message_ = (input as any).Prompt__User_Message_
    }

    if (!normalized.filePath) {
      if (typeof normalized.file_path === 'string') {
        normalized.filePath = normalized.file_path
      } else if (typeof normalized.path === 'string') {
        normalized.filePath = normalized.path
      } else if (typeof input.filePath === 'string') {
        normalized.filePath = input.filePath
      }
    }

    if (!normalized.content && typeof normalized.newContent === 'string') {
      normalized.content = normalized.newContent
    }

    if (!normalized.content && typeof normalized.updatedContent === 'string') {
      normalized.content = normalized.updatedContent
    }

    if (
      normalized.input === undefined &&
      input &&
      Object.keys(input).length > 0
    ) {
      normalized.input = input
    }

    return lowerName.includes('web_search')
      ? applyUnavailableWebSearchMetadata(normalized)
      : normalized
  }

  if (typeof parsed === 'string') {
    if (lowerName.endsWith('read_file')) {
      return {
        content: parsed,
        filePath: input.filePath,
      }
    }
  }

  return parsed
}

type ImageOutput = {
  dataUrl?: string
  filePath?: string
  mediaType: string
}

const DEFAULT_IMAGE_MEDIA_TYPE = 'image/png'
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_LOCAL_IMAGE_OUTPUT_BYTES = 15 * 1024 * 1024
const AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS = 24 * 60 * 60
const LOCAL_IMAGE_EXT_TO_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

async function readLocalImageOutputWithinLimit(filePath: string): Promise<Buffer | null> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(MAX_LOCAL_IMAGE_OUTPUT_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, MAX_LOCAL_IMAGE_OUTPUT_BYTES + 1, 0)
    if (bytesRead <= 0 || bytesRead > MAX_LOCAL_IMAGE_OUTPUT_BYTES) return null
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function isLikelyBase64(value: string) {
  if (!value) return false
  const trimmed = value.trim()
  if (trimmed.length < 100) return false
  return BASE64_REGEX.test(trimmed)
}

function inferImageMediaTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  return LOCAL_IMAGE_EXT_TO_MEDIA[ext] ?? null
}

function isLikelyLocalImagePath(value: string): boolean {
  const mediaType = inferImageMediaTypeFromPath(value)
  return Boolean(mediaType)
}

function normalizeLocalImagePath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://'))
    return null
  if (trimmed.startsWith('data:')) return null

  if (trimmed.startsWith('attachment:')) {
    const attachmentPath = trimmed.slice('attachment:'.length).trim()
    if (!attachmentPath) return null
    if (
      path.isAbsolute(attachmentPath) ||
      attachmentPath.startsWith('./') ||
      attachmentPath.startsWith('../')
    ) {
      return path.resolve(attachmentPath)
    }
    if (isLikelyLocalImagePath(attachmentPath)) {
      return path.resolve(attachmentPath)
    }
    return null
  }

  if (trimmed.startsWith('file://')) {
    try {
      const parsed = new URL(trimmed)
      const decoded = decodeURIComponent(parsed.pathname)
      return path.resolve(decoded)
    } catch {
      return null
    }
  }

  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return path.resolve(trimmed)
  }

  // Agent Browser can return relative screenshot paths like "example.com.png".
  if (isLikelyLocalImagePath(trimmed)) {
    return path.resolve(trimmed)
  }

  return null
}

function extractMediaTypeFromDataUrl(value: string) {
  const match = /^data:([^;]+);/i.exec(value)
  return match?.[1] || null
}

function ensureDataUrl(value: string, mediaType?: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith('data:')) {
    return trimmed
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  const resolvedType = mediaType || DEFAULT_IMAGE_MEDIA_TYPE
  return `data:${resolvedType};base64,${trimmed}`
}

function isImageToolName(toolName?: string | null) {
  if (!toolName) return false
  const lowered = toolName.toLowerCase()
  return (
    lowered.includes('image_generation') ||
    lowered.includes('image-generation') ||
    lowered.includes('generate_image')
  )
}

function isNativeAgentBrowserUseToolName(toolName?: string | null): boolean {
  if (!toolName) return false
  const normalized = toolName.toLowerCase().trim()
  return (
    normalized === 'native_agent_browser_use' ||
    normalized === 'agent_browser_use'
  )
}

function isNativeBashExecuteToolName(toolName?: string | null): boolean {
  if (!toolName) return false
  const normalized = toolName.toLowerCase().trim()
  return normalized === 'native_bash_execute' || normalized === 'bash_execute'
}

function toolResultIndicatesFailure(result: unknown): boolean {
  const parsed = parseJsonLike(result)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }

  const record = parsed as Record<string, any>
  return record.success === false || record.blocked === true
}

function extractToolResultErrorMessage(result: unknown): string | undefined {
  const parsed = parseJsonLike(result)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  const record = parsed as Record<string, any>
  if (!toolResultIndicatesFailure(record)) {
    return undefined
  }

  const error = record.error
  if (typeof record.reason === 'string' && record.reason.trim()) {
    return record.reason.trim()
  }
  if (typeof record.failureMessage === 'string' && record.failureMessage.trim()) {
    return record.failureMessage.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message.trim() || undefined
  }
  if (typeof record.errorCode === 'string' && record.errorCode.trim()) {
    return record.errorCode.trim()
  }
  return 'Tool execution failed.'
}

function inferToolStepSuccess(
  result: unknown,
  fallback: boolean,
): boolean {
  if (toolResultIndicatesFailure(result)) {
    return false
  }

  return fallback
}

const AGENT_BROWSER_BASH_CHAIN_OPERATOR_REGEX = /\s(?:&&|\|\||;)\s/
const AGENT_BROWSER_BASH_FLAGS_WITH_VALUE = new Set([
  '--cdp',
  '--provider',
  '-p',
  '--executable-path',
  '--session',
  '--profile',
])

type AgentBrowserBashCommandParts = {
  rest: string
}

function unquoteAgentBrowserShellToken(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isShellIdentifierStart(char: string): boolean {
  return (
    (char >= 'A' && char <= 'Z') ||
    (char >= 'a' && char <= 'z') ||
    char === '_'
  )
}

function isShellIdentifierChar(char: string): boolean {
  return isShellIdentifierStart(char) || (char >= '0' && char <= '9')
}

function skipShellWhitespace(value: string, start: number): number {
  let index = start
  while (index < value.length && /\s/.test(value[index] ?? '')) index += 1
  return index
}

function readShellTokenSpan(
  value: string,
  start: number,
): { token: string; start: number; end: number } | null {
  const tokenStart = skipShellWhitespace(value, start)
  if (tokenStart >= value.length) return null

  let index = tokenStart
  let quote: string | null = null
  while (index < value.length) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (/\s/.test(char)) break
    index += 1
  }

  return {
    token: unquoteAgentBrowserShellToken(value.slice(tokenStart, index)),
    start: tokenStart,
    end: index,
  }
}

function isEnvironmentAssignmentToken(token: string): boolean {
  const equalsIndex = token.indexOf('=')
  if (equalsIndex <= 0) return false
  const name = token.slice(0, equalsIndex)
  if (!isShellIdentifierStart(name[0] ?? '')) return false
  for (const char of name.slice(1)) {
    if (!isShellIdentifierChar(char)) return false
  }
  return true
}

function parseAgentBrowserBashCommand(
  command: string,
): AgentBrowserBashCommandParts | null {
  let index = 0
  while (index < command.length) {
    const token = readShellTokenSpan(command, index)
    if (!token) return null
    if (!isEnvironmentAssignmentToken(token.token)) break
    index = token.end
  }

  const launcherStartToken = readShellTokenSpan(command, index)
  if (!launcherStartToken) return null

  let launcherEnd = launcherStartToken.end
  if (launcherStartToken.token.toLowerCase() === 'npx') {
    let nextToken = readShellTokenSpan(command, launcherEnd)
    if (nextToken?.token === '-y') {
      launcherEnd = nextToken.end
      nextToken = readShellTokenSpan(command, launcherEnd)
    }
    if (nextToken?.token.toLowerCase() !== 'agent-browser') return null
    launcherEnd = nextToken.end
  } else if (launcherStartToken.token.toLowerCase() !== 'agent-browser') {
    return null
  }

  return {
    rest: command.slice(launcherEnd).trim(),
  }
}

function splitShellWordsForAgentBrowser(value: string): string[] {
  const tokens = value.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  return tokens.map((token) => unquoteAgentBrowserShellToken(token)).filter((token) => token.length > 0)
}

function splitAgentBrowserCommandAtChainForDetection(commandSegment: string): {
  primary: string
} {
  const trimmed = commandSegment.trim()
  if (!trimmed) return { primary: '' }
  const match = AGENT_BROWSER_BASH_CHAIN_OPERATOR_REGEX.exec(trimmed)
  if (!match || typeof match.index !== 'number' || match.index <= 0) {
    return { primary: trimmed }
  }
  return {
    primary: trimmed.slice(0, match.index).trim(),
  }
}

function findAgentBrowserSubcommandIndexForDetection(tokens: string[]): number {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token) return -1
    if (token === '--') {
      return index + 1 < tokens.length ? index + 1 : -1
    }
    if (token.startsWith('--')) {
      const [flag] = token.split('=', 1)
      if (
        AGENT_BROWSER_BASH_FLAGS_WITH_VALUE.has(flag) &&
        !token.includes('=')
      ) {
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      if (token === '-p') {
        index += 2
      } else {
        index += 1
      }
      continue
    }
    return index
  }
  return -1
}

function resolveAgentBrowserBashSubcommand(command: string): string | null {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) return null
  const rest = parsedCommand.rest
  if (!rest) return null
  const { primary } = splitAgentBrowserCommandAtChainForDetection(rest)
  const tokens = splitShellWordsForAgentBrowser(primary)
  if (tokens.length === 0) return null
  const subcommandIndex = findAgentBrowserSubcommandIndexForDetection(tokens)
  if (subcommandIndex < 0) return null
  const subcommand = tokens[subcommandIndex]?.trim().toLowerCase()
  return subcommand || null
}

function extractAgentBrowserBashCommandCandidate(
  payload: any,
  toolInput?: Record<string, any>,
): string | null {
  const candidates = [
    toolInput?.command,
    toolInput?.innerCommand,
    payload?.requestedCommand,
    payload?.command,
    payload?.innerCommand,
    payload?.mappedToolInput?.command,
    payload?.mappedToolInput?.innerCommand,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return null
}

function extractAgentBrowserScreenshotModelVisibility(
  payload: any,
): boolean | null {
  const parsed = parseJsonLike(payload)
  const queue: any[] = [parsed]
  const seen = new Set<any>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)

    if (typeof current !== 'object') continue

    const visibilityCandidates = [
      (current as any).modelVisibleInLoop,
      (current as any).model_visible_in_loop,
      (current as any).modelVisibility,
      (current as any).model_visibility,
    ]

    for (const candidate of visibilityCandidates) {
      if (typeof candidate === 'boolean') {
        return candidate
      }
    }

    queue.push((current as any).agentBrowser)
    queue.push((current as any).screenshot)
    queue.push((current as any).result)
    queue.push((current as any).output)
    queue.push((current as any).data)
    queue.push((current as any).content)
    queue.push((current as any).value)
  }

  return null
}

function isAgentBrowserScreenshotInvocation(
  toolName: string | undefined,
  payload: any,
  toolInput?: Record<string, any>,
): boolean {
  if (isNativeAgentBrowserUseToolName(toolName)) {
    const candidates = [
      toolInput?.toolName,
      payload?.toolName,
      payload?.command,
      payload?.result?.toolName,
      payload?.result?.command,
    ]

    return candidates.some(
      (candidate) =>
        normalizeAgentBrowserCommandName(candidate) === 'screenshot',
    )
  }

  if (!isNativeBashExecuteToolName(toolName)) return false

  const agentBrowserCommandCandidates = [
    payload?.agentBrowser?.command,
    payload?.agentBrowser?.screenshot?.command,
  ]
  if (
    agentBrowserCommandCandidates.some(
      (candidate) =>
        normalizeAgentBrowserCommandName(candidate) === 'screenshot',
    )
  ) {
    return true
  }

  const bashCandidate = extractAgentBrowserBashCommandCandidate(
    payload,
    toolInput,
  )
  if (!bashCandidate) return false
  return (
    normalizeAgentBrowserCommandName(
      resolveAgentBrowserBashSubcommand(bashCandidate),
    ) === 'screenshot'
  )
}

function isHttpImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  return trimmed.startsWith('https://') || trimmed.startsWith('http://')
}

function extractAgentBrowserScreenshotExternalUrl(payload: any): string | null {
  const parsed = parseJsonLike(payload)
  const queue: any[] = [parsed]
  const seen = new Set<any>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)

    if (typeof current === 'string') {
      if (isHttpImageUrl(current)) {
        return current.trim()
      }
      continue
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry)
      }
      continue
    }

    if (typeof current !== 'object') continue

    const directCandidates = [
      (current as any).url,
      (current as any).externalUrl,
      (current as any).external_url,
      (current as any).modelImageUrl,
      (current as any).model_image_url,
      (current as any).imageUrl,
      (current as any).image_url,
      (current as any).screenshotUrl,
      (current as any).screenshot_url,
      (current as any).agentBrowser?.modelImageUrl,
      (current as any).agentBrowser?.screenshot?.modelImageUrl,
    ]

    for (const candidate of directCandidates) {
      if (isHttpImageUrl(candidate)) {
        return candidate.trim()
      }
    }

    queue.push((current as any).result)
    queue.push((current as any).output)
    queue.push((current as any).data)
    queue.push((current as any).content)
    queue.push((current as any).value)
    queue.push((current as any).agentBrowser)
    queue.push((current as any).screenshot)
  }

  return null
}

const TOOL_CALL_ID_PREFIXES = ['call_', 'tool_', 'toolcall_', 'tc_']

function isLikelyToolCallId(value?: string | null) {
  if (!value) return false
  return TOOL_CALL_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
}

function resolveToolCallIdFromEvent(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const direct =
    typeof payload.toolCallId === 'string'
      ? payload.toolCallId
      : typeof payload.tool_call_id === 'string'
        ? payload.tool_call_id
        : typeof payload.callId === 'string'
          ? payload.callId
          : typeof payload.call_id === 'string'
            ? payload.call_id
            : undefined
  if (direct) return direct
  const fallback = typeof payload.id === 'string' ? payload.id : undefined
  if (fallback && isLikelyToolCallId(fallback)) {
    return fallback
  }
  return undefined
}

function looksLikeImagePayload(payload: any) {
  if (!payload || typeof payload !== 'object') return false
  return (
    'b64_json' in payload ||
    'base64' in payload ||
    'image' in payload ||
    'images' in payload ||
    'data' in payload
  )
}

function collectImageOutputs(
  payload: any,
  outputs: ImageOutput[],
  mediaType?: string,
) {
  if (payload === null || payload === undefined) return

  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) return
    if (trimmed.startsWith('data:image/')) {
      outputs.push({
        dataUrl: trimmed,
        mediaType:
          extractMediaTypeFromDataUrl(trimmed) ||
          mediaType ||
          DEFAULT_IMAGE_MEDIA_TYPE,
      })
      return
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      outputs.push({
        dataUrl: trimmed,
        mediaType: mediaType || DEFAULT_IMAGE_MEDIA_TYPE,
      })
      return
    }
    const localPath = normalizeLocalImagePath(trimmed)
    if (localPath && isLikelyLocalImagePath(localPath)) {
      outputs.push({
        filePath: localPath,
        mediaType:
          mediaType ||
          inferImageMediaTypeFromPath(localPath) ||
          DEFAULT_IMAGE_MEDIA_TYPE,
      })
      return
    }
    if (isLikelyBase64(trimmed)) {
      outputs.push({
        dataUrl: ensureDataUrl(trimmed, mediaType),
        mediaType: mediaType || DEFAULT_IMAGE_MEDIA_TYPE,
      })
    }
    return
  }

  if (Array.isArray(payload)) {
    payload.forEach((entry) => collectImageOutputs(entry, outputs, mediaType))
    return
  }

  if (typeof payload !== 'object') return

  const nextMediaType =
    typeof payload.mediaType === 'string'
      ? payload.mediaType
      : typeof payload.mimeType === 'string'
        ? payload.mimeType
        : typeof payload.content_type === 'string'
          ? payload.content_type
          : mediaType

  if (payload.b64_json) {
    collectImageOutputs(payload.b64_json, outputs, nextMediaType)
  }
  if (payload.base64) {
    collectImageOutputs(payload.base64, outputs, nextMediaType)
  }
  if (payload.image) {
    collectImageOutputs(payload.image, outputs, nextMediaType)
  }
  if (payload.result) {
    collectImageOutputs(payload.result, outputs, nextMediaType)
  }
  if (payload.output) {
    collectImageOutputs(payload.output, outputs, nextMediaType)
  }
  if (payload.url) {
    collectImageOutputs(payload.url, outputs, nextMediaType)
  }
  if (payload.path) {
    collectImageOutputs(payload.path, outputs, nextMediaType)
  }
  if (Array.isArray(payload.images)) {
    collectImageOutputs(payload.images, outputs, nextMediaType)
  }
  if (Array.isArray(payload.data)) {
    collectImageOutputs(payload.data, outputs, nextMediaType)
  }
}

function extractImageOutputs(
  toolName: string | undefined,
  payload: any,
  toolInput?: Record<string, any>,
): ImageOutput[] {
  const shouldInspect =
    isImageToolName(toolName) ||
    looksLikeImagePayload(payload) ||
    isAgentBrowserScreenshotInvocation(toolName, payload, toolInput)
  if (!shouldInspect) return []
  const outputs: ImageOutput[] = []
  collectImageOutputs(payload, outputs)
  const seen = new Set<string>()
  return outputs.filter((output) => {
    const key = output.filePath
      ? `path:${output.filePath}`
      : output.dataUrl
        ? `data:${output.dataUrl.slice(0, 64)}`
        : ''
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const ATTACHMENT_IMAGE_LINK_REGEX = /!\[[^\]]*]\(\s*attachment:[^)]+\s*\)/gi
const ATTACHMENT_LINK_REGEX = /\[([^\]]+)\]\(\s*attachment:[^)]+\s*\)/gi
const ATTACHMENT_URL_REGEX = /\battachment:[^\s)]+/gi
const MARKDOWN_IMAGE_LINK_REGEX = /!\[[^\]]*]\(\s*([^)]+)\s*\)/gi
const WINDOWS_ABSOLUTE_PATH_REGEX = /^[a-z]:[\\/]/i
const AGENT_BROWSER_TEMP_FILE_PREFIX = 'batshit-agent-browser-'
const BATSHIT_RUNTIME_TMP_DIR = path.join(os.homedir(), '.batshit', 'tmp')

function extractMarkdownUrlTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim()
  if (!trimmed) return ''

  let withoutTitle = trimmed
  const firstSpaceIdx = withoutTitle.search(/\s/)
  if (firstSpaceIdx >= 0) {
    withoutTitle = withoutTitle.slice(0, firstSpaceIdx)
  }

  let target = withoutTitle.trim()
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim()
  }
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1).trim()
  }

  return target
}

function isLikelyFilesystemImageTarget(target: string): boolean {
  if (!target) return false
  const normalized = target.trim()
  if (!normalized) return false

  const lower = normalized.toLowerCase()
  if (lower.startsWith('attachment:') || lower.startsWith('file://'))
    return true
  if (WINDOWS_ABSOLUTE_PATH_REGEX.test(normalized)) return true
  if (lower.startsWith('\\\\')) return true

  if (
    lower.startsWith('/var/') ||
    lower.startsWith('/private/') ||
    lower.startsWith('/tmp/') ||
    lower.startsWith('/users/') ||
    lower.startsWith('/volumes/') ||
    lower.startsWith('/home/') ||
    lower.startsWith('/root/')
  ) {
    return true
  }

  const looksRelativeLocalPath =
    lower.startsWith('./') ||
    lower.startsWith('../') ||
    (!lower.startsWith('/') && !lower.includes('://'))

  if (!looksRelativeLocalPath) return false

  const withoutQueryOrFragment = normalized.split(/[?#]/, 1)[0] ?? normalized
  return Boolean(inferImageMediaTypeFromPath(withoutQueryOrFragment))
}

function shouldCleanupAgentBrowserTempScreenshot(
  localPath: string | null,
): boolean {
  if (!localPath) return false
  const normalizedPath = path.resolve(localPath)
  const batshitTempRoot = path.resolve(BATSHIT_RUNTIME_TMP_DIR)
  if (normalizedPath.startsWith(`${batshitTempRoot}${path.sep}`)) {
    return true
  }

  const fileName = path.basename(normalizedPath)
  if (!fileName.startsWith(AGENT_BROWSER_TEMP_FILE_PREFIX)) return false
  const tempRoot = path.resolve(os.tmpdir())
  if (normalizedPath === tempRoot) return false
  return normalizedPath.startsWith(`${tempRoot}${path.sep}`)
}

function stripUnrenderableMarkdownImageReferences(content: string): string {
  if (!content || !content.includes('![')) return content

  const stripped = content.replace(
    MARKDOWN_IMAGE_LINK_REGEX,
    (match, targetRaw) => {
      const target = extractMarkdownUrlTarget(String(targetRaw ?? ''))
      if (!isLikelyFilesystemImageTarget(target)) return match
      return ''
    },
  )

  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripAttachmentReferences(content: string): string {
  if (!content) return content

  const strippedAttachmentUrls = content
    .replace(ATTACHMENT_IMAGE_LINK_REGEX, '')
    .replace(ATTACHMENT_LINK_REGEX, '$1')
    .replace(ATTACHMENT_URL_REGEX, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return stripUnrenderableMarkdownImageReferences(strippedAttachmentUrls)
}

function fileToImageOutput(file: any): ImageOutput | null {
  if (!file || typeof file !== 'object') return null
  const mediaType =
    typeof file.mediaType === 'string'
      ? file.mediaType
      : typeof file.mimeType === 'string'
        ? file.mimeType
        : DEFAULT_IMAGE_MEDIA_TYPE

  if (!mediaType.startsWith('image/')) {
    return null
  }

  if (file.uint8Array) {
    const buffer = Buffer.from(file.uint8Array)
    return {
      dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
      mediaType,
    }
  }

  if (file.base64) {
    return {
      dataUrl: ensureDataUrl(file.base64, mediaType),
      mediaType,
    }
  }

  return null
}

type PlanItem = { text: string; completed?: boolean }
const PLAN_TOOL_NAME = 'codex_plan_update'

function isPlanUpdateTool(toolName?: string | null): boolean {
  return (toolName || '').toLowerCase() === PLAN_TOOL_NAME
}

function normalizePlanItems(raw: any): PlanItem[] {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.item?.items)
        ? raw.item.items
        : Array.isArray(raw?.todo)
          ? raw.todo
          : Array.isArray(raw?.list)
            ? raw.list
            : []

  if (!Array.isArray(source)) return []

  return source
    .map((entry: any) => {
      const text =
        typeof entry?.text === 'string'
          ? entry.text
          : typeof entry?.content === 'string'
            ? entry.content
            : typeof entry?.title === 'string'
              ? entry.title
              : ''
      if (!text) return null
      return {
        text,
        completed: Boolean(entry?.completed),
      }
    })
    .filter(Boolean) as PlanItem[]
}

function formatPlanSummary(items: PlanItem[]): string {
  return items
    .map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`)
    .join('\n')
}

function resolveAssignedSubagentIds(agent: AgentRow): string[] {
  if (
    Array.isArray(agent.assignedSubagents) &&
    agent.assignedSubagents.length > 0
  ) {
    return agent.assignedSubagents
  }
  if (
    Array.isArray((agent as any).assigned_subagent_ids) &&
    (agent as any).assigned_subagent_ids.length > 0
  ) {
    return (agent as any).assigned_subagent_ids
  }
  return []
}

async function emitSimulatedChunks(
  content: string,
  emitter: (chunk: string) => Promise<void>,
) {
  if (content.length <= SIMULATED_STREAM_CHUNK_TARGET) {
    await emitter(content)
    return
  }

  const tokens = content.split(/(\s+)/).filter((token) => token.length > 0)
  let buffer = ''

  for (const token of tokens) {
    buffer += token
    if (buffer.length >= SIMULATED_STREAM_CHUNK_TARGET) {
      await emitter(buffer)
      buffer = ''
      await sleep(SIMULATED_STREAM_DELAY_MS)
    }
  }

  if (buffer) {
    await emitter(buffer)
  }
}

async function loadAssignedSubagents(agent: AgentRow): Promise<any[]> {
  const ids = resolveAssignedSubagentIds(agent)
  if (ids.length === 0) {
    return []
  }

  const subagents: any[] = []
  await redis.execute(async (client) => {
    for (const id of ids) {
      try {
        const raw = await client.json.get(`subagent:${id}`)
        if (raw) {
          subagents.push(normalizeAssignedSubagent(raw as RawSubagent))
        }
      } catch (error) {
        console.error(`[send-routed] Failed to load subagent ${id}:`, error)
      }
    }
  })

  const primaryAgentType = normalizePrimaryAgentType(agent)
  const compatibleSubagents = subagents.filter((subagent) =>
    isSubagentCompatibleWithPrimaryAgent(primaryAgentType, subagent)
  )

  if (compatibleSubagents.length !== subagents.length) {
    console.warn('[send-routed] Ignoring incompatible assigned subagents', {
      agentId: agent.id,
      primaryAgentType,
      requested: subagents.length,
      compatible: compatibleSubagents.length,
    })
  }

  return compatibleSubagents
}

interface ParsedToolSteps {
  intermediateSteps: any[]
  accumulatedText: string
}

function isPrecompiledToolStep(step: any): boolean {
  if (!step || typeof step !== 'object') {
    return false
  }
  if (Array.isArray(step.content)) {
    return false
  }
  return Boolean(
    step.toolName ||
    step.tool ||
    step.action?.tool ||
    step.toolInput ||
    step.toolArgs ||
    step.toolResult ||
    step.toolOutput ||
    step.result,
  )
}

function normalizePrecompiledToolStep(step: any): any | null {
  if (!isPrecompiledToolStep(step)) {
    return null
  }

  const toolName = step.toolName || step.tool || step.action?.tool || step.name
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    return null
  }

  const rawInput =
    step.toolInput ??
    step.toolArgs ??
    step.input ??
    step.args ??
    step.tool_input ??
    null
  const normalizedInput =
    rawInput !== undefined && rawInput !== null
      ? normalizeToolArgs(rawInput)
      : {}

  const rawResult =
    step.toolResult ??
    step.toolOutput ??
    step.output ??
    step.result ??
    step.tool_result ??
    step.tool_output
  const normalizedResult =
    rawResult !== undefined
      ? normalizeToolResult(rawResult, toolName, normalizedInput)
      : rawResult

  return {
    ...step,
    toolName,
    toolInput: normalizedInput,
    toolArgs: normalizedInput,
    toolResult: normalizedResult,
    error: step.error ?? extractToolResultErrorMessage(normalizedResult),
    timestamp: step.timestamp ?? Date.now(),
    success:
      typeof step.success === 'boolean'
        ? inferToolStepSuccess(normalizedResult, step.success)
        : inferToolStepSuccess(
            normalizedResult,
            normalizedResult !== undefined && normalizedResult !== null,
          ),
  }
}

function buildIntermediateStepsFromSteps(
  steps: any[] | undefined | null,
): ParsedToolSteps {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { intermediateSteps: [], accumulatedText: '' }
  }

  if (steps.some((step) => isPrecompiledToolStep(step))) {
    const normalized = steps
      .map((step) => normalizePrecompiledToolStep(step))
      .filter((step): step is any => Boolean(step))
    return {
      intermediateSteps: normalized,
      accumulatedText: '',
    }
  }

  let accumulatedText = ''
  const toolCalls: any[] = []
  const toolResults: any[] = []

  for (const step of steps) {
    if (Array.isArray(step?.toolCalls)) {
      toolCalls.push(...step.toolCalls)
    }

    if (Array.isArray(step?.toolResults)) {
      toolResults.push(...step.toolResults)
    }

    if (step?.content && Array.isArray(step.content)) {
      for (const item of step.content) {
        if (item?.type === 'tool-call') {
          toolCalls.push(item)
        } else if (item?.type === 'tool-result') {
          toolResults.push(item)
        } else if (item?.type === 'text') {
          accumulatedText += item.text || ''
        }
      }
    }
  }

  const intermediateSteps: any[] = []

  // Deduplicate tool calls/results by toolCallId (or a stable fallback) to avoid
  // multiple cool_tool zips for a single execution.
  const safeKey = (obj: any) => {
    try {
      return JSON.stringify(obj ?? {})
    } catch {
      return String(obj)
    }
  }

  const seenCallKeys = new Set<string>()
  const uniqueToolCalls: any[] = []
  for (const call of toolCalls) {
    const key =
      call?.toolCallId ||
      `${call?.toolName || 'tool'}:${safeKey(call?.input ?? call?.args)}`
    if (seenCallKeys.has(key)) continue
    seenCallKeys.add(key)
    uniqueToolCalls.push(call)
  }

  const seenResultKeys = new Set<string>()
  const uniqueToolResults: any[] = []
  for (const res of toolResults) {
    const key =
      res?.toolCallId ||
      `${res?.toolName || 'tool'}:${safeKey(res?.output ?? res?.result ?? res?.data ?? res?.content)}`
    if (seenResultKeys.has(key)) continue
    seenResultKeys.add(key)
    uniqueToolResults.push(res)
  }

  uniqueToolCalls.forEach((call) => {
    const matchingResult = uniqueToolResults.find(
      (r) => r.toolCallId === call.toolCallId,
    )
    // Approval-gated runs can end with a tool-call but no tool-result yet.
    // Skip unresolved calls so we don't render a premature cool_tool card/zip
    // that looks like a failed execution before the user responds.
    if (!matchingResult) {
      return
    }

    let metadata = {}
    for (const step of steps) {
      if (Array.isArray(step?.toolCalls)) {
        const matchingToolCall = step.toolCalls.find(
          (tc: any) => tc.toolCallId === call.toolCallId,
        )
        if (matchingToolCall?.metadata) {
          metadata = matchingToolCall.metadata
          break
        }
      }
    }

    const rawInput =
      call.input ??
      call.args ??
      matchingResult?.input ??
      matchingResult?.args ??
      {}

    const input = normalizeToolArgs(rawInput)

    let toolResultRaw =
      matchingResult?.output ??
      matchingResult?.result ??
      matchingResult?.data ??
      matchingResult?.content

    let toolResult = normalizeToolResult(toolResultRaw, call.toolName, input)

    if (
      Array.isArray(toolResult) &&
      toolResult.length > 0 &&
      toolResult[0]?.type === 'coolToolResult' &&
      toolResult[0]?.toolResult
    ) {
      toolResult = normalizeToolResult(
        toolResult[0].toolResult,
        call.toolName,
        input,
      )
    }

    const nativeBashMapping = resolveNativeBashMapping({
      toolName: call.toolName,
      args: input,
      result: toolResult,
    })
    const mappedToolName = nativeBashMapping?.mappedToolName || call.toolName
    const mappedInput = nativeBashMapping?.mappedArgs || input
    const mappedResult =
      nativeBashMapping &&
      toolResult &&
      typeof toolResult === 'object' &&
      !Array.isArray(toolResult)
        ? {
            ...toolResult,
            originalToolName: call.toolName,
            mappedToolName: nativeBashMapping.mappedToolName,
            mappedReason: nativeBashMapping.reason,
          }
        : toolResult

    intermediateSteps.push({
      toolName: mappedToolName,
      originalToolName: call.toolName,
      toolInput: mappedInput,
      toolArgs: mappedInput,
      toolResult: mappedResult,
      ...(call?.toolCallId ? { toolCallId: call.toolCallId } : {}),
      timestamp: Date.now(),
      ...(metadata as any),
      error: extractToolResultErrorMessage(mappedResult),
      success: inferToolStepSuccess(mappedResult, mappedResult !== undefined),
    })
  })

  return { intermediateSteps, accumulatedText }
}

interface BatshitStreamParams {
  content: string
  sessionId: string
  agent: AgentRow
  agentId: string
  messageId?: string
  messages: any[]
  metadata: any
  batshitInput: any
  abortSignal?: AbortSignal
  globalZipSettings?: Record<string, any>
  precompiledHistory?: PrecompiledHistory
  streamMetadata?: Record<string, any>
  systemPromptAddendum?: string
  groupContext?: Record<string, any>
  voiceState?: {
    tts?: boolean
    stt?: boolean
    voiceMode?: string
    provider?: string
    guidance?: string[]
  }
  userSettings?: UserSettingsRow | null
  userId: string
  eventFetch: typeof fetch
  request: Request
  consumeSessionClips?: boolean
}

interface BatshitStreamResult {
  response: Response
  messageId: string
  content: string
  metadata: Record<string, any>
  usage?: Record<string, any>
  /** The run failed but the partial message was already finalized (content + zip refs persisted). Callers must not re-persist an error-only message over it. */
  failureHandled?: boolean
  /** The failure was classified as model context-window exhaustion (eligible for auto-continue). */
  contextExhausted?: boolean
}

async function handleBatshitAgentStream({
  content,
  sessionId,
  agent,
  agentId,
  messageId: providedMessageId,
  messages,
  metadata,
  batshitInput,
  abortSignal: externalAbortSignal,
  globalZipSettings,
  precompiledHistory,
  streamMetadata,
  systemPromptAddendum,
  groupContext,
  voiceState,
  userSettings,
  userId,
  eventFetch,
  request,
  consumeSessionClips = true,
}: BatshitStreamParams): Promise<BatshitStreamResult> {
  const zipDetection = new ZipDetectionService()
  let zipSettingsAgent: Record<string, unknown> | null =
    agent as unknown as Record<string, unknown>

  let messageId = providedMessageId ?? null
  if (!messageId) {
    messageId = await generateMessageId(sessionId)
  }
  if (!messageId) {
    return {
      response: json(
        { error: 'Failed to generate message ID' },
        { status: 500 },
      ),
      messageId: '',
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  const streamAbortController = new AbortController()
  const streamAbortSignal = streamAbortController.signal

  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) {
      streamAbortController.abort('external')
    } else {
      externalAbortSignal.addEventListener(
        'abort',
        () => {
          streamAbortController.abort('external')
        },
        { once: true },
      )
    }
  }

  if (request.signal?.aborted) {
    streamAbortController.abort('request')
  } else if (request.signal) {
    request.signal.addEventListener(
      'abort',
      () => {
        streamAbortController.abort('request')
      },
      { once: true },
    )
  }

  zipDetection.setContext(sessionId, messageId, {
    agent: zipSettingsAgent,
    globalSettings: globalZipSettings,
    messagesFromEnd: 0,
  })

  let selectedTools: string[] | undefined =
    metadata?.selectedTools ?? batshitInput?.metadata?.selectedTools
  let selectedGateways: string[] | undefined =
    metadata?.selectedGateways ??
    metadata?.selectedMCPs ??
    batshitInput?.metadata?.selectedGateways
  let mcpToolSelections =
    metadata?.mcpToolSelections ?? batshitInput?.metadata?.mcpToolSelections

  const assignedSubagents = await loadAssignedSubagents(agent)
  const rawToolApprovalResponse = normalizeToolApprovalResponses(
    metadata?.toolApprovalResponse ??
      metadata?.tool_approval_response ??
      batshitInput?.metadata?.toolApprovalResponse ??
      batshitInput?.metadata?.tool_approval_response,
  )
  const hasUserTurnContent =
    (typeof content === 'string' && content.trim().length > 0) ||
    (Array.isArray(content) && content.length > 0) ||
    (content != null && typeof content !== 'string' && !Array.isArray(content))
  const interruptionContextRaw = (metadata?.interruption ??
    batshitInput?.metadata?.interruption) as Record<string, any> | null
  const interruptionReason =
    typeof interruptionContextRaw?.reason === 'string'
      ? interruptionContextRaw.reason.trim().toLowerCase()
      : ''
  const interruptionHasPreviousMessage =
    typeof interruptionContextRaw?.previousMessageId === 'string' &&
    interruptionContextRaw.previousMessageId.trim().length > 0
  const shouldIgnoreToolApprovalResponse =
    rawToolApprovalResponse.length > 0 && hasUserTurnContent
  if (shouldIgnoreToolApprovalResponse) {
    console.warn(
      '[Send-Routed] Ignoring stale tool approval payload on user turn',
      {
        sessionId,
        messageId,
        approvalCount: rawToolApprovalResponse.length,
      },
    )
  }
  const toolApprovalResponse = shouldIgnoreToolApprovalResponse
    ? []
    : rawToolApprovalResponse
  const toolApprovalMode = normalizeToolApprovalMode(
    metadata?.toolApprovalMode ??
      metadata?.tool_approval_mode ??
      (agent as any)?.tool_approval_mode ??
      (agent as any)?.toolApprovalMode,
  )
  const hasToolApprovalResponse = toolApprovalResponse.length > 0
  const isApprovalResumeWithoutUserTurn =
    hasToolApprovalResponse && !hasUserTurnContent
  const contextContinuationRaw = (metadata?.contextContinuation ??
    batshitInput?.metadata?.contextContinuation) as Record<string, any> | null
  const isContextContinuationRun =
    Boolean(contextContinuationRaw) && !hasUserTurnContent
  const previousMessages = prepareManagedHistoryMessages({
    messages,
    currentUserMessage: content,
    assistantMessageId: providedMessageId,
    preserveAllMessages: hasToolApprovalResponse,
  })
  const historyForCompilation = previousMessages
  const messageForCompilation =
    isApprovalResumeWithoutUserTurn || isContextContinuationRun
      ? undefined
      : content

  const primaryAgentType = normalizePrimaryAgentType(agent)
  const connectionHint =
    agent?.primary_model_connection?.id ||
    agent?.primary_model_connection?.service ||
    null
  const providerHint = (
    agent?.primary_model_provider ||
    ''
  )
    .toLowerCase()
    .trim()
  const isCodexProviderHint =
    CODEX_PROVIDER_IDS.has(providerHint) ||
    connectionHint === CODEX_CONNECTION_ID
  const isClaudeProviderHint =
    CLAUDE_PROVIDER_IDS.has(providerHint) ||
    connectionHint === CLAUDE_CONNECTION_ID
  const runtimeFlavor = isCliPrimaryAgentType(primaryAgentType) && isCodexProviderHint
    ? 'codex'
    : isCliPrimaryAgentType(primaryAgentType) && isClaudeProviderHint
      ? 'claude'
      : isCliPrimaryAgentType(primaryAgentType)
        ? 'codex'
        : 'vercel'

  const databaseService = new DatabaseService(eventFetch)

  const formattedInput = await databaseService.buildFormattedChatInput(
    sessionId,
    historyForCompilation,
    agent,
    messageForCompilation,
    assignedSubagents,
    userId,
    {
      fetch: eventFetch,
      runtimeFlavor,
      projectPath:
        metadata?.projectPath ?? batshitInput?.metadata?.projectPath ?? null,
      projectRules:
        metadata?.projectRules ?? batshitInput?.metadata?.projectRules ?? null,
      fileReferences:
        metadata?.fileReferences ??
        batshitInput?.metadata?.fileReferences ??
        [],
      precompiledHistory,
      groupContext,
      voiceState,
      goonsEnabled:
        typeof metadata?.goonsEnabled === 'boolean'
          ? metadata.goonsEnabled
          : undefined,
      goonPresentationMode: metadata?.goonPresentationMode ?? null,
      goonsSettings: userSettings?.goons_settings ?? null,
    },
  )

  if (!formattedInput) {
    throw new Error('Failed to build formatted chat input for API or CLI agent')
  }

  const collectImages = () => {
    const urls = new Set<string>()

    // From clipped items
    const clipped = formattedInput?.structuredInput?.clippedItems || []
    for (const item of clipped) {
      const candidate =
        (typeof item.content === 'string' ? item.content : null) ||
        item.url ||
        null
      if (
        candidate &&
        (candidate.startsWith('http') || candidate.startsWith('data:'))
      ) {
        urls.add(candidate)
      }
    }

    // From compiled message parts
    for (const msg of formattedInput?.structuredInput?.messages || []) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const candidate = part?.image_url?.url || part?.image
          if (
            candidate &&
            (candidate.startsWith('http') || candidate.startsWith('data:'))
          ) {
            urls.add(candidate)
          }
        }
      }
    }

    return Array.from(urls).map((url) => ({ url }))
  }
  let images: Array<{ url: string }> = []
  try {
    images = collectImages()
  } catch (imageCollectError) {
    console.warn(
      '[Send-Routed] Failed to collect image references from compiled input:',
      imageCollectError,
    )
    images = []
  }

  const interruptionAddendum = buildInterruptionAddendum(interruptionContextRaw)
  const contextContinuationAddendum = buildContextContinuationAddendum(
    contextContinuationRaw,
  )
  const toolApprovalTimeoutAddendum = buildToolApprovalTimeoutAddendum(
    metadata?.expiredToolApprovals ??
      batshitInput?.metadata?.expiredToolApprovals,
  )
  const mergedSystemPromptAddendum = [
    systemPromptAddendum,
    interruptionAddendum,
    contextContinuationAddendum,
    toolApprovalTimeoutAddendum,
  ]
    .filter(Boolean)
    .join('\n\n')

  let compiledMessages: any[] = []

  if (formattedInput.primarySystemPrompt || mergedSystemPromptAddendum) {
    const basePrompt = formattedInput.primarySystemPrompt ?? ''
    const mergedPrompt = mergedSystemPromptAddendum
      ? `${basePrompt}\n\n${mergedSystemPromptAddendum}`.trim()
      : basePrompt
    compiledMessages.push({
      role: 'system',
      content: mergedPrompt,
    })
  }

  if (formattedInput.structuredInput?.messages?.length) {
    for (const msg of formattedInput.structuredInput.messages) {
      compiledMessages.push({
        role: msg.role || 'user',
        content: msg.content,
      })
    }
  }

  const compileMetadataBase = formattedInput.structuredInput?.metadata || {}
  const compileMetadata = { ...compileMetadataBase }

  if (!compiledMessages.length) {
    throw new Error('Unable to compile chat messages for Batshit agent')
  }

  const dataImageInTextContext =
    findDataImageUrlInTextMessages(compiledMessages)
  if (dataImageInTextContext) {
    const userTurnHasInlineDataImage = hasDataImageUrlInUserTurnContent(content)
    if (userTurnHasInlineDataImage) {
      throw createRoutedInputError(
        'Inline image data URLs are not allowed in message text. Re-attach the image as an image clip/input so it stays out of text tokens.',
        'IMAGE_DATA_URL_IN_TEXT',
      )
    }

    const sanitizeResult = sanitizeDataImageUrlsInTextMessages(compiledMessages)
    if (sanitizeResult.redactions > 0) {
      console.warn(
        `[send-routed] Redacted ${sanitizeResult.redactions} image data URL(s) from compiled text context.`,
      )
    }

    const remainingDataImageInText =
      findDataImageUrlInTextMessages(compiledMessages)
    if (remainingDataImageInText) {
      throw createRoutedInputError(
        `Image data URLs are not allowed in text context (message ${remainingDataImageInText.messageIndex + 1}${remainingDataImageInText.role ? `, role ${remainingDataImageInText.role}` : ''}). Re-attach the image as an image clip/input so it stays out of text tokens.`,
        'IMAGE_DATA_URL_IN_TEXT',
      )
    }
  }

  const metadataForLogs =
    compileMetadata || metadata || batshitInput?.metadata || {}
  const executionMetadata = {
    ...(compileMetadata || {}),
    ...(metadata || {}),
    ...(batshitInput?.metadata || {}),
  }
  const resolvedCompiledProjectPath =
    formattedInput.resolvedProjectPath ??
    formattedInput.structuredInput?.metadata?.resolvedProjectPath ??
    null
  if (resolvedCompiledProjectPath) {
    executionMetadata.projectPath = resolvedCompiledProjectPath
  }
  if (streamMetadata?.groupChat) {
    executionMetadata.groupChat = {
      groupTurnId:
        streamMetadata?.groupTurnId ?? streamMetadata?.group_turn_id ?? null,
      eventIndex:
        streamMetadata?.eventIndex ??
        streamMetadata?.event_index ??
        streamMetadata?.group_event_index ??
        null,
      groupLayout:
        streamMetadata?.groupLayout ?? streamMetadata?.group_layout ?? null,
      speakPolicy: streamMetadata?.speakPolicy ?? null,
      speakTopics: Array.isArray(streamMetadata?.speakTopics)
        ? streamMetadata.speakTopics
        : null,
      eventType:
        streamMetadata?.eventType ?? streamMetadata?.event_type ?? null,
      eventSourceAgentId:
        streamMetadata?.eventSourceAgentId ??
        streamMetadata?.event_source_agent_id ??
        null,
      eventSourceAgentName:
        streamMetadata?.eventSourceAgentName ??
        streamMetadata?.event_source_agent_name ??
        null,
      driverMode:
        streamMetadata?.driverMode ?? streamMetadata?.driver_mode ?? null,
      driverAgentId:
        streamMetadata?.driverAgentId ??
        streamMetadata?.driver_agent_id ??
        null,
    }
  }

  selectedTools = selectedTools ?? executionMetadata?.selectedTools
  selectedGateways = selectedGateways ?? executionMetadata?.selectedGateways
  mcpToolSelections = mcpToolSelections ?? executionMetadata?.mcpToolSelections

  const requestAgentMetadata =
    executionMetadata?.agent && typeof executionMetadata.agent === 'object'
      ? executionMetadata.agent
      : {}
  const agentMetadata = agent as Record<string, any>
  executionMetadata.agent = {
    ...requestAgentMetadata,
    ...agentMetadata,
  }
  let gatewayToolMap: Record<string, string[]> = {}
  let defaultGateways: string[] | null = null
  const selectedCliToolIds = Array.isArray(agentMetadata.defaultTools)
    ? agentMetadata.defaultTools
    : Array.isArray(agentMetadata.default_tools)
      ? agentMetadata.default_tools
      : Array.isArray(agent.defaultTools)
        ? agent.defaultTools
        : Array.isArray((agent as any).default_tools)
          ? (agent as any).default_tools
          : undefined
  let preloadedGatewayTools: MCPSelectionResolution['tools'] | null = null
  let preloadedGatewayMetadata: MCPSelectionResolution['toolMetadata'] | null =
    null

  try {
    const selectionResolution = await resolveMCPSelections({
      userId,
      agentId,
      agent,
      agentMetadata,
      selectedGateways,
      toolSelections: mcpToolSelections,
      includeGatewayToolMap: isCliPrimaryAgentType(primaryAgentType),
      // CLI runs use the managed helper bridge instead of direct native tool injection.
      isCodexMode: isCliPrimaryAgentType(primaryAgentType),
    })

    selectedGateways = selectionResolution.resolvedGateways
    defaultGateways = selectionResolution.defaultGateways
    mcpToolSelections = selectionResolution.resolvedToolSelections
    gatewayToolMap = selectionResolution.gatewayToolMap
    preloadedGatewayTools = selectionResolution.tools
    preloadedGatewayMetadata = selectionResolution.toolMetadata
  } catch (resolverError) {
    console.error(
      '[Send-Routed] Failed to resolve MCP selections:',
      resolverError,
    )
    defaultGateways = Array.isArray(agentMetadata.defaultMCPGateways)
      ? agentMetadata.defaultMCPGateways
      : Array.isArray(agentMetadata.default_mcp_gateways)
        ? agentMetadata.default_mcp_gateways
        : Array.isArray(agent.defaultMCPGateways)
          ? agent.defaultMCPGateways
          : null
  }

  executionMetadata.gatewayToolMap = gatewayToolMap

  const primaryPresetId =
    agentMetadata.primary_model_preset_id ??
    agent.primary_model_preset_id ??
    null
  const fallbackEnabled = Boolean(
    agentMetadata.fallback_model_enabled ??
    agent.fallback_model_enabled ??
    false,
  )
  const fallbackPresetId =
    fallbackEnabled
      ? (agentMetadata.fallback_model_preset_id ??
        agent.fallback_model_preset_id ??
        null)
      : null
  const [primaryPreset, fallbackPreset] = await Promise.all([
    loadRuntimeModelPreset(primaryPresetId, 'primary'),
    fallbackEnabled
      ? loadRuntimeModelPreset(fallbackPresetId, 'fallback')
      : Promise.resolve(null),
  ])
  const primarySelection = resolveRuntimeModelSelection({
    preset: primaryPreset,
    presetId: primaryPresetId,
    provider:
      agentMetadata.primary_model_provider ?? agent.primary_model_provider,
    modelId: agentMetadata.primary_model_name ?? agent.primary_model_name,
    connection:
      agentMetadata.primary_model_connection ??
      agent.primary_model_connection ??
      null,
    capabilities:
      agentMetadata.primary_model_capabilities ??
      agent.primary_model_capabilities ??
      null,
    settings: (agentMetadata.provider_specific_settings ??
      agent.provider_specific_settings ??
      null) as Record<string, any> | null,
  })
  const fallbackSelection = resolveRuntimeModelSelection({
    preset: fallbackPreset,
    presetId: fallbackPresetId,
    provider:
      agentMetadata.fallback_model_provider ?? agent.fallback_model_provider,
    modelId: agentMetadata.fallback_model_name ?? agent.fallback_model_name,
    connection:
      agentMetadata.fallback_model_connection ??
      agent.fallback_model_connection ??
      null,
    capabilities:
      agentMetadata.fallback_model_capabilities ??
      agent.fallback_model_capabilities ??
      null,
    settings: (agentMetadata.fallback_provider_specific_settings ??
      agent.fallback_provider_specific_settings ??
      null) as Record<string, any> | null,
  })
  const providerSpecificSettings = primarySelection.settings
  const connectionInfo = primarySelection.connection
  const connectionIdentifier =
    connectionInfo?.id || connectionInfo?.service || null
  const providerIdentifier = (primarySelection.provider ?? '')
    .toLowerCase()
    .trim()
  const isCodexSelection =
    CODEX_PROVIDER_IDS.has(providerIdentifier) ||
    connectionIdentifier === CODEX_CONNECTION_ID
  const isClaudeSelection =
    CLAUDE_PROVIDER_IDS.has(providerIdentifier) ||
    connectionIdentifier === CLAUDE_CONNECTION_ID
  const isCliMode = isCliPrimaryAgentType(primaryAgentType)
  const isCliProvider = isCliMode && (isCodexSelection || isClaudeSelection)
  const isCodexProvider = isCliProvider && isCodexSelection
  const isClaudeProvider = isCliProvider && isClaudeSelection
  const primaryModelHint = (primarySelection.modelId ?? '')
    .toLowerCase()
    .trim()
  const hasModelSelection = Boolean(
    providerIdentifier || connectionIdentifier || primaryModelHint,
  )
  const isCodexModelHint =
    isCodexSelection || primaryModelHint.includes('codex')
  const isClaudeCliModelHint =
    isClaudeSelection || primaryModelHint.includes('claude-cli')
  const isCliModelHint = isCodexModelHint || isClaudeCliModelHint

  if (isCliMode && hasModelSelection && !isCliModelHint) {
    return {
      response: json(
        {
          error: 'CLI agents only support CLI model presets.',
          code: 'cli_mode_only',
        },
        { status: 400 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  if (!isCliMode && isCliModelHint) {
    return {
      response: json(
        {
          error: 'CLI model presets are only available for CLI agents.',
          code: 'cli_mode_only',
        },
        { status: 400 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  const nativeRuntime: {
    streamNativeMode: (request: NativeModeRequest) => Promise<any>
  } = await (async () => {
    if (isCodexProvider) {
      const { CodexBridge } = await import('$lib/server/services/codexBridge')
      return new CodexBridge()
    }
    if (isClaudeProvider) {
      const { ClaudeBridge } = await import('$lib/server/services/claudeBridge')
      return new ClaudeBridge()
    }
    const { VercelAIBrain } = await import('$lib/server/services/vercelBrain')
    return new VercelAIBrain()
  })()
  const isN8NOnlyModel =
    (connectionIdentifier &&
      N8N_ONLY_CONNECTION_IDS.has(connectionIdentifier)) ||
    (providerIdentifier && N8N_ONLY_PROVIDER_IDS.has(providerIdentifier))

  if (isN8NOnlyModel) {
    return {
      response: json(
        {
          error:
            'This model preset is limited to n8n agents. Switch the Primary Agent to n8n mode or pick a different model.',
          code: 'n8n_only_model',
        },
        { status: 400 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  const runtimeSettings = buildRuntimeModelSettings({
    provider: primarySelection.provider,
    modelId: primarySelection.modelId,
    vercelId: null,
    connection: primarySelection.connection,
    contextWindow: primarySelection.contextWindow,
    capabilities: primarySelection.capabilities,
    settings: providerSpecificSettings as Record<string, ParameterValue> | null,
    fallbacks: {
      temperature:
        agentMetadata.primary_model_temperature ??
        agent.primary_model_temperature,
      maxTokens:
        agentMetadata.primary_model_max_tokens ??
        agent.primary_model_max_tokens,
      topP: agentMetadata.primary_model_top_p ?? agent.primary_model_top_p,
      topK: agentMetadata.primary_model_top_k ?? agent.primary_model_top_k,
      presencePenalty:
        agentMetadata.primary_model_presence_penalty ??
        agent.primary_model_presence_penalty,
      frequencyPenalty:
        agentMetadata.primary_model_frequency_penalty ??
        agent.primary_model_frequency_penalty,
      seed: agentMetadata.primary_model_seed ?? agent.primary_model_seed,
      stopSequences:
        agentMetadata.primary_model_stop_sequences ??
        agent.primary_model_stop_sequences ??
        undefined,
    },
  })
  const primaryCapabilities = primarySelection.capabilities
  const primaryProviderId = primarySelection.provider
  const primaryToolsEnabled = shouldEnableTools(
    primaryProviderId,
    primaryCapabilities,
  )

  if (images.length > 0 && !modelAllowsImageInput(primaryCapabilities)) {
    throw createRoutedInputError(
      buildImageInputUnsupportedMessage({
        imageCount: images.length,
        providerId: primaryProviderId,
        modelId: primarySelection.modelId,
      }),
      IMAGE_INPUT_UNSUPPORTED_CODE,
      422,
    )
  }

  const fallbackProviderSpecificSettings = fallbackSelection.settings
  const fallbackConnection = fallbackSelection.connection
  const fallbackResolvedIds = resolveModelIds({
    developerId: fallbackSelection.provider,
    modelId: fallbackSelection.modelId,
    connection: fallbackConnection,
  })
  const fallbackEffectiveModelId = fallbackResolvedIds?.effectiveModelId ?? null
  const fallbackRuntimeSettings = fallbackResolvedIds
    ? buildRuntimeModelSettings({
        provider: fallbackResolvedIds.developerId,
        modelId: fallbackResolvedIds.modelId,
        vercelId: null,
        connection: fallbackConnection,
        contextWindow: fallbackSelection.contextWindow,
        capabilities: fallbackSelection.capabilities,
        settings: fallbackProviderSpecificSettings as Record<string, ParameterValue> | null,
        fallbacks: {
          temperature:
            agentMetadata.fallback_model_temperature ??
            agent.fallback_model_temperature,
          maxTokens:
            agentMetadata.fallback_model_max_tokens ??
            agent.fallback_model_max_tokens,
          topP:
            agentMetadata.fallback_model_top_p ??
            agent.fallback_model_top_p ??
            undefined,
          topK:
            agentMetadata.fallback_model_top_k ??
            agent.fallback_model_top_k ??
            undefined,
          presencePenalty:
            agentMetadata.fallback_model_presence_penalty ??
            agent.fallback_model_presence_penalty ??
            undefined,
          frequencyPenalty:
            agentMetadata.fallback_model_frequency_penalty ??
            agent.fallback_model_frequency_penalty ??
            undefined,
          seed:
            agentMetadata.fallback_model_seed ??
            agent.fallback_model_seed ??
            undefined,
          stopSequences:
            agentMetadata.fallback_model_stop_sequences ??
            agent.fallback_model_stop_sequences ??
            undefined,
        },
      })
    : null
  const fallbackCapabilities = fallbackSelection.capabilities
  const fallbackProviderId = fallbackSelection.provider
  const fallbackToolsEnabled = shouldEnableTools(
    fallbackProviderId,
    fallbackCapabilities,
  )

  const resolvedVoiceConfig = await resolveVoiceConfigForMetadata({
    userSettings,
    agent,
    metadata: metadataForLogs ?? metadata,
  })

  const voiceMetadata: VoiceMetadata = {
    stt: Boolean(metadata?.stt ?? metadataForLogs?.stt ?? false),
    tts: Boolean(metadata?.tts ?? metadataForLogs?.tts ?? false),
    voiceMode: (metadata?.voiceMode ??
      metadataForLogs?.voiceMode ??
      (metadata?.tts ? 'voice' : 'text')) as VoiceMetadata['voiceMode'],
    realtime: Boolean(metadata?.realtime ?? metadataForLogs?.realtime ?? false),
    provider: resolvedVoiceConfig.provider ?? undefined,
    model: resolvedVoiceConfig.model ?? undefined,
    voiceId: resolvedVoiceConfig.voiceId ?? undefined,
    profileId: resolvedVoiceConfig.profileId ?? undefined,
    common: resolvedVoiceConfig.common ?? undefined,
    providerOptions: resolvedVoiceConfig.providerOptions ?? undefined,
    style: resolvedVoiceConfig.style ?? undefined,
  }

  const runtimeProviderId = isCodexProvider
    ? providerIdentifier && CODEX_PROVIDER_IDS.has(providerIdentifier)
      ? providerIdentifier
      : PRIMARY_CODEX_PROVIDER_ID
    : isClaudeProvider
      ? providerIdentifier && CLAUDE_PROVIDER_IDS.has(providerIdentifier)
        ? providerIdentifier
        : PRIMARY_CLAUDE_PROVIDER_ID
      : providerIdentifier || null
  const showReasoning =
    typeof (agent as any)?.show_reasoning === 'boolean'
      ? Boolean((agent as any).show_reasoning)
      : true
  const codexRuntimeSettings: CodexRuntimeSettings | null = isCodexProvider
    ? buildCodexRuntimeSettings(
        (agent as any)?.codex_settings ?? providerSpecificSettings,
        {
          permissionMode: metadata?.codexPermissionMode,
        },
      )
    : null
  const claudeRuntimeSettings: ClaudeRuntimeSettings | null = isClaudeProvider
    ? buildClaudeRuntimeSettings(
        (agent as any)?.claude_settings ?? providerSpecificSettings,
        {
          permissionMode: metadata?.claudePermissionMode,
        },
      )
    : null
  if (codexRuntimeSettings && agent?.id) {
    codexRuntimeSettings.profileId = buildAgentProfileId(agent.id)
  }
  if (codexRuntimeSettings && showReasoning) {
    codexRuntimeSettings.reasoningSummary = 'auto'
    codexRuntimeSettings.modelSupportsReasoningSummaries = true
  }
  const mode4Style =
    isCodexProvider || isClaudeProvider
      ? (codexRuntimeSettings?.mode4Style ??
        claudeRuntimeSettings?.mode4Style ??
        MODE4_PRELAUNCH_STYLE)
      : null
  const shouldSimulateStreamingEffect = Boolean(
    isCodexProvider && codexRuntimeSettings?.streamingEffect,
  )

  const runtimeSnapshot: ExecutionRuntimeDetails = {
    runtimeId: isCodexProvider
      ? 'codex'
      : isClaudeProvider
        ? 'claude'
        : 'vercel',
    providerId: runtimeProviderId,
    connectionId: connectionIdentifier || null,
    modelName: null,
    transport: isCodexProvider || isClaudeProvider ? null : 'vercel-sdk',
    status: 'pending',
  }
  if (mode4Style) {
    runtimeSnapshot.metadata = {
      mode4Style,
      mode4MemoryOwner: resolveMode4MemoryOwner(mode4Style),
      providerSession: {
        configScope:
          codexRuntimeSettings?.configScope ??
          claudeRuntimeSettings?.configScope ??
          null,
        historyPersistence: codexRuntimeSettings?.historyPersistence ?? null,
      },
    }
  }

  const resolvedModelIds = resolveModelIds({
    developerId: primarySelection.provider,
    modelId: primarySelection.modelId,
    connection: primarySelection.connection,
  })
  const effectiveModelId =
    resolvedModelIds?.effectiveModelId ||
    primarySelection.modelId ||
    null
  runtimeSnapshot.modelName = effectiveModelId

  const providerContinuationCriteria: ProviderMessageSource = {
    providerId: providerIdentifier || null,
    connectionId: connectionIdentifier || null,
    modelId: effectiveModelId ? effectiveModelId.toLowerCase() : null,
    agentId: agentId || null,
  }
  const approvalIds = new Set(
    toolApprovalResponse
      .map((entry) =>
        typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : '',
      )
      .filter(Boolean),
  )
  let continuationSourceMessages = extractProviderMessages(
    previousMessages,
    providerContinuationCriteria,
  )

  if (
    hasToolApprovalResponse &&
    (!continuationSourceMessages.length ||
      !providerMessagesContainApprovalRequest(
        continuationSourceMessages,
        approvalIds,
      ))
  ) {
    const persistedProviderMessages =
      await loadProviderMessagesForApprovalsFromRedis(
        sessionId,
        providerContinuationCriteria,
        approvalIds,
      )
    if (persistedProviderMessages.length > 0) {
      continuationSourceMessages = persistedProviderMessages
      logger.debug(
        '[Send-Routed] Restored provider approval context from Redis',
        {
          sessionId,
          messageId,
          approvalCount: approvalIds.size,
        },
      )
    }
  }

  const shouldAttachProviderContinuation = hasToolApprovalResponse
  const providerContinuation = shouldAttachProviderContinuation
    ? buildProviderContinuation(continuationSourceMessages)
    : []
  const isStrictApprovalResume =
    isApprovalResumeWithoutUserTurn && toolApprovalResponse.length > 0

  if (isStrictApprovalResume) {
    // Approval resumes must end with a tool message that contains
    // tool-approval-response parts. If an empty user turn is left at the end,
    // AI SDK won't collect approvals and providers reject the request.
    const preservedContext = compiledMessages.filter((msg) => {
      if (msg?.role !== 'user') return true
      return !isEmptyModelMessageContent(msg?.content)
    })

    compiledMessages.length = 0
    if (preservedContext.length > 0) {
      compiledMessages.push(...preservedContext)
    }
    if (providerContinuation.length > 0) {
      compiledMessages.push(...providerContinuation)
    }
    compiledMessages.push({
      role: 'tool',
      content: toolApprovalResponse,
    })
  } else {
    const insertIndex = compiledMessages.findIndex((msg) => msg.role === 'user')
    const insertAt = insertIndex === -1 ? compiledMessages.length : insertIndex
    if (providerContinuation.length > 0) {
      compiledMessages.splice(insertAt, 0, ...providerContinuation)
    }
    if (toolApprovalResponse.length > 0) {
      const toolInsertAt = insertAt + providerContinuation.length
      compiledMessages.splice(toolInsertAt, 0, {
        role: 'tool',
        content: toolApprovalResponse,
      })
    }
  }

  const effectiveAutoCompactForPreflight = resolveEffectiveAutoCompactSettings({
    global: userSettings?.global_auto_compact_settings,
    agent: (agent as any)?.auto_compact_settings,
  })
  const promptBudgetContextLimit = primarySelection.contextWindow ?? null
  const promptBudgetAutoCompactTriggerTokens = resolveAutoCompactTriggerTokens(
    effectiveAutoCompactForPreflight,
    promptBudgetContextLimit,
  )
  const promptBudgetOutputReserveTokens = resolveBudgetOutputReserve({
    maxOutputTokens:
      runtimeSettings.standard.maxTokens ??
      agentMetadata.primary_model_max_tokens ??
      agent.primary_model_max_tokens ??
      null,
    contextLimit: promptBudgetContextLimit,
    reasoningModel: Boolean(primaryCapabilities?.reasoning),
  })
  const [codexProjectInstructionTokens, codexProjectInstructionChars] =
    isCodexProvider
      ? await Promise.all([
          estimateCodexProjectInstructionTokens({
            agent: agent as Record<string, any>,
            projectPath: resolvedCompiledProjectPath,
          }),
          estimateCodexProjectInstructionChars({
            agent: agent as Record<string, any>,
            projectPath: resolvedCompiledProjectPath,
          }),
        ])
      : [0, 0]
  const promptBudget = buildPromptBudgetReport({
    runtime: isCodexProvider ? 'codex' : isClaudeProvider ? 'claude' : 'vercel',
    messages: compiledMessages,
    images,
    contextLimit: promptBudgetContextLimit,
    nativeOverheadTokens: isCodexProvider
      ? CODEX_NATIVE_BASE_OVERHEAD_TOKENS + codexProjectInstructionTokens
      : isClaudeProvider
        ? CLI_WRAPPER_OVERHEAD_TOKENS
        : 0,
    outputReserveTokens: promptBudgetOutputReserveTokens,
    autoCompactTriggerTokens: promptBudgetAutoCompactTriggerTokens,
    extraRuntimeInputChars: codexProjectInstructionChars,
  })
  executionMetadata.promptBudget = promptBudget

  if (!promptBudget.canSend) {
    throw createRoutedInputError(
      promptBudget.reason,
      'PROMPT_BUDGET_EXCEEDED',
      422,
    )
  }

  let runtimeEventLogBuffer: any[] | null = null
  let runtimeSnapshotPersisted = false

  const persistRuntimeSnapshot = async (
    status: 'succeeded' | 'failed',
    errorMessage?: string,
  ) => {
    if (runtimeSnapshotPersisted) return
    runtimeSnapshotPersisted = true
    runtimeSnapshot.status = status
    runtimeSnapshot.error = errorMessage ?? null

    if (runtimeEventLogBuffer) {
      runtimeSnapshot.eventLog = runtimeEventLogBuffer
      runtimeSnapshot.eventCount = runtimeEventLogBuffer.length
    }

    try {
      await executionViewerService.updateSnapshot(sessionId, messageId, {
        runtime: runtimeSnapshot,
      })
    } catch (persistError) {
      console.error(
        '[Send-Routed] Failed to persist runtime metadata for execution snapshot:',
        persistError,
      )
    }
  }

  try {
    await executionViewerService.recordSnapshot({
      id: messageId,
      sessionId,
      userId,
      agentId,
      agentName: agent.displayName ?? (agent as any).name ?? agent.id,
      agentType: primaryAgentType,
      createdAt: new Date().toISOString(),
      userMessage: content,
      structuredInput: formattedInput.structuredInput,
      primarySystemPrompt: formattedInput.primarySystemPrompt,
      subagentPrompts: formattedInput.subagentPrompts,
      subagentDescription: formattedInput.subagentDescription,
      compiledMessages,
      compileMetadata,
      executionMetadata,
      selectedGateways: selectedGateways ?? null,
      selectedTools: selectedTools ?? null,
      mcpToolSelections: mcpToolSelections ?? null,
      defaultGateways,
      gatewayToolMap,
      voiceMetadata,
      assignedSubagents,
      runtime: runtimeSnapshot,
    })
  } catch (viewerError) {
    console.error(
      '[Send-Routed] Failed to record execution snapshot:',
      viewerError,
    )
  }

  const sseEndpointUrl = new URL('/api/sse', request.url).toString()
  let forwardedTextChunkToActiveSse = false

  const forwardStreamEvent = async (event: CanonicalStreamEvent) => {
    if (!event?.type) {
      return
    }

    const body = {
      ...event,
      sessionId,
      messageId: event.messageId ?? messageId,
    }

    try {
      const response = await eventFetch(sseEndpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-sse-forward': '1',
          ...internalServiceHeaders(),
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => '<failed to read body>')
        console.error('[Send-Routed] SSE forward returned non-OK response', {
          type: event.type,
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        })
      } else {
        const responseBody = (await response
          .json()
          .catch(() => null)) as { success?: unknown } | null
        if (event.type === 'chunk' && responseBody?.success === true) {
          forwardedTextChunkToActiveSse = true
        }
      }
    } catch (err) {
      console.error(
        '[Send-Routed] Failed to forward managed AI stream event to SSE:',
        {
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        },
      )
    }
  }

  let detectToolSource = (_toolName: string) => ({
    toolProvider: 'unknown',
    toolSource: 'unknown',
  })

  const streamAdapter = new StreamEventAdapter({
    sessionId,
    forward: forwardStreamEvent,
    defaultMetadata: {
      agentId,
      agentType: primaryAgentType,
      agentDisplayName: agent.displayName ?? (agent as any).name ?? agent.id,
      ...(streamMetadata ?? {}),
    },
    toolMetadataResolver: (toolName) => detectToolSource(toolName),
  })
  streamAdapter.setVoiceMetadata(voiceMetadata)

  const preserveReasoning =
    typeof (agent as any)?.preserve_reasoning === 'boolean'
      ? Boolean((agent as any).preserve_reasoning)
      : false

  let visualCleanup: (() => void) | undefined
  try {
    await initializeKeyspaceNotifications()
    visualCleanup = await setupSessionMonitoring(
      sessionId,
      async (event: VisualIndicatorEvent) => {
        await forwardStreamEvent({
          type: 'zip_activity_change',
          event,
          sessionId,
          timestamp: new Date().toISOString(),
        } as CanonicalStreamEvent)
      },
    )
  } catch (monitorError) {
    console.error(
      '[Send-Routed] Error setting up Redis monitoring:',
      monitorError,
    )
  }

  const finishSummary: {
    text: string
    content: string
    intermediateSteps: any[]
    zipReferences: ZipReference[]
    metadata: Record<string, any>
    usage?: Record<string, any>
  } = {
    text: '',
    content: '',
    intermediateSteps: [],
    zipReferences: [],
    metadata: {},
  }

  let finalMessagePersisted = false
  let finalizePromise: Promise<void> | null = null
  let onFinishResolved = false
  let resolveOnFinish: (() => void) | null = null
  const onFinishPromise = new Promise<void>((resolve) => {
    resolveOnFinish = resolve
  })

  const finalizeAssistantMessage = async (
    context: 'onFinish' | 'postStream' | 'error' = 'onFinish',
  ) => {
    if (finalMessagePersisted) {
      logger.debug('[Send-Routed] Finalize skipped - already persisted', {
        sessionId,
        messageId,
        context,
      })
      return
    }

    if (finalizePromise) {
      await finalizePromise
      return
    }

    finalizePromise = (async () => {
      logger.debug('[Send-Routed] Finalizing assistant message', {
        sessionId,
        messageId,
        context,
        hasContent: Boolean(finishSummary.content),
        hasText: Boolean(finishSummary.text),
        steps: finishSummary.intermediateSteps?.length || 0,
      })

      let endContent = finishSummary.content || finishSummary.text || ''
      if (typeof endContent === 'string') {
        const sanitizedEndContent = stripAttachmentReferences(endContent)
        if (sanitizedEndContent !== endContent) {
          endContent = sanitizedEndContent
          if (finishSummary.content) {
            finishSummary.content = endContent
          } else if (finishSummary.text) {
            finishSummary.text = endContent
          }
        }
      }
      if (!endContent) {
        console.warn(
          '[Send-Routed] Finalizing assistant message with empty content',
          {
            sessionId,
            messageId,
            context,
            hasFinishSummary: Boolean(
              finishSummary.text || finishSummary.content,
            ),
          },
        )
      }
      const endMetadataBase =
        Object.keys(finishSummary.metadata).length > 0
          ? finishSummary.metadata
          : {
              model: effectiveModelId ?? primarySelection.modelId,
              agentType: primaryAgentType,
              voice: voiceMetadata,
              selectedTools,
              selectedGateways,
            }
      if (finishSummary.zipReferences.length > 0) {
        const trustedZipIds = Array.from(
          new Set(
            finishSummary.zipReferences
              .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
              .filter((id): id is string => Boolean(id)),
          ),
        )
        if (trustedZipIds.length > 0) {
          endMetadataBase.zipIds = Array.from(
            new Set([
              ...(Array.isArray(endMetadataBase.zipIds) ? endMetadataBase.zipIds : []),
              ...trustedZipIds,
            ]),
          )
          endMetadataBase.zipReferences = finishSummary.zipReferences
        }
      }
      const sanitizedEndMetadata = sanitizePayloadForLogs(endMetadataBase)
      const sanitizedIntermediateSteps = sanitizePayloadForLogs(
        finishSummary.intermediateSteps.length > 0
          ? finishSummary.intermediateSteps
          : [],
      )
      const sanitizedEndContent =
        typeof endContent === 'string'
          ? redactDataImageUrlsInText(endContent).value
          : endContent

      await streamAdapter.emitEnd({
        content: sanitizedEndContent,
        intermediateSteps: sanitizedIntermediateSteps as any[],
        zipReferences: finishSummary.zipReferences.filter(
          (ref): ref is ZipReference =>
            typeof ref?.reference === 'string' && ref.reference.length > 0,
        ),
        metadata: sanitizedEndMetadata as Record<string, any>,
      })

      const finalMessage: ChatMessage = {
        id: messageId,
        session_id: sessionId,
        user_id: userId,
        agent_id: agentId,
        role: 'assistant',
        content: sanitizedEndContent,
        created_at: new Date().toISOString(),
        intermediateSteps:
          (sanitizedIntermediateSteps as any[]).length > 0
            ? (sanitizedIntermediateSteps as any[])
            : undefined,
        metadata: sanitizedEndMetadata as Record<string, any>,
      }

      await redis.saveMessage(finalMessage)

      zipDetection.deleteSessionBuffers(sessionId)
      finalMessagePersisted = true
    })()

    try {
      await finalizePromise
    } finally {
      finalizePromise = null
    }
  }

  // SA-018 (revised): Reasoning summaries stream as metadata (not zips / not message content)
  let streamedMessageContent = ''
  let reasoningActive = false
  let reasoningCaptured = ''
  let thinkingIndicatorEmitted = false
  let planItems: PlanItem[] = []
  let planSummary = ''
  const streamedToolSteps: any[] = []
  const streamedApprovalRequests = new Map<string, ToolApprovalEntry>()
  const streamedToolCallIds = new Set<string>()
  const streamedToolZipCallIds = new Set<string>()
  const streamedToolZipReferences: ZipReference[] = []
  const reservedToolZipIdsByCallId = new Map<string, string>()
  const streamedToolZipRefsByCallId = new Map<
    string,
    ZipReference[]
  >()
  const imageZipRefsByCallId = new Map<
    string,
    ZipReference[]
  >()
  const imageZipRefsByToolName = new Map<
    string,
    ZipReference[]
  >()
  const imageZipIdsForUi = new Set<string>()
  const toolCallIdByName = new Map<string, string>()
  const toolCallPayloadById = new Map<
    string,
    { toolName?: string; input?: any; toolCall?: Record<string, any> }
  >()
  const emittedImageToolResultIds = new Set<string>()
  let coolToolZipAdapterModule:
    | typeof import('$lib/server/coolToolZipAdapter')
    | null = null
  const RESERVED_TOOL_ZIP_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*_\d{10,17}_[a-z0-9]{5,12}$/
  const reserveToolZipIdForCall = (params: {
    toolCallId?: string | null
    toolName?: string | null
    zipId?: string | null
  }): string | undefined => {
    const toolCallId =
      typeof params.toolCallId === 'string' ? params.toolCallId.trim() : ''
    if (!toolCallId) return undefined

    const existing = reservedToolZipIdsByCallId.get(toolCallId)
    if (existing) return existing

    const explicitZipId =
      typeof params.zipId === 'string' && RESERVED_TOOL_ZIP_ID_PATTERN.test(params.zipId.trim())
        ? params.zipId.trim()
        : undefined
    const zipId = explicitZipId ?? reserveZipId('cool_tool')
    reservedToolZipIdsByCallId.set(toolCallId, zipId)
    return zipId
  }
  let ensureStartEmitted: (() => Promise<void>) | null = null
  let controlsEnabled = false
  let controlsResolved = false
  let controlsMode: string = 'responding'
  let controlsPayload: Record<string, any> | null = null
  let controlsBuffer = ''
  let pendingControlText = ''
  let silentResponse = false
  let rawUsageFromStream: UsageLike | null = null
  let lastStreamSteps: any[] | null = null
  let lastStreamText: string | null = null
  let lastResolvedUsage: UsageLike | null = null
  let streamRuntimeError: Error | null = null
  let shouldBreakStream = false

  const emitTextChunk = async (
    content: string,
    options: { allowZipReferences?: boolean } = {},
  ) => {
    if (!content) return
    const safeContent = options.allowZipReferences
      ? content
      : neutralizeAllClipReferenceSyntax(neutralizeAllZipReferenceSyntax(content))
    if (ensureStartEmitted) {
      await ensureStartEmitted()
    }
    streamedMessageContent += safeContent
    if (shouldSimulateStreamingEffect) {
      await emitSimulatedChunks(safeContent, async (simulated) => {
        await streamAdapter.emitChunk({ content: simulated })
      })
    } else {
      await streamAdapter.emitChunk({ content: safeContent })
    }
  }

  const emitPlanUpdate = async (raw: any) => {
    const normalizedItems = normalizePlanItems(raw)
    if (normalizedItems.length === 0) return
    planItems = normalizedItems
    planSummary = formatPlanSummary(normalizedItems)
    await streamAdapter.emitPlanUpdate({
      content: planSummary,
      items: normalizedItems,
      metadata: { source: 'codex', type: 'plan_update' },
    })
  }

  const appendToolZipReference = (reference: string) => {
    if (!reference) return
    if (streamedMessageContent && !streamedMessageContent.endsWith('\n')) {
      streamedMessageContent += '\n\n'
    }
    streamedMessageContent += reference
  }

  const extractZipIdFromReference = (reference: string): string | null => {
    if (!reference) return null
    const match = reference.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
    return match ? match[1] : null
  }

  const imageZipSettings = getTypeZipSettings(
    'image',
    zipSettingsAgent,
    globalZipSettings,
  )
  let screenshotUploadConfigCache: ScreenshotUploadConfig | null | undefined = undefined

  const resolveScreenshotUploadConfig = async () => {
    if (screenshotUploadConfigCache !== undefined) {
      return screenshotUploadConfigCache
    }

    screenshotUploadConfigCache = await resolveUploadConfigForScreenshot(
      userSettings,
      {
        onManagedTunnelUnavailable(details) {
          console.warn(
            '[Send-Routed] Managed Cloudflare tunnel unavailable for screenshot upload:',
            {
              sessionId,
              messageId,
              targetUrl: details.targetUrl,
              reason: details.reason,
            },
          )
        },
      },
    )

    return screenshotUploadConfigCache
  }

  const materializeImageOutput = async (
    output: ImageOutput,
  ): Promise<{ content: string; mediaType: string } | null> => {
    if (
      typeof output.dataUrl === 'string' &&
      output.dataUrl.trim().length > 0
    ) {
      const trimmed = output.dataUrl.trim()
      const mediaType =
        extractMediaTypeFromDataUrl(trimmed) ||
        output.mediaType ||
        DEFAULT_IMAGE_MEDIA_TYPE
      return {
        content: trimmed,
        mediaType,
      }
    }

    if (
      typeof output.filePath === 'string' &&
      output.filePath.trim().length > 0
    ) {
      const localPath = path.resolve(output.filePath.trim())
      try {
        const bytes = await readLocalImageOutputWithinLimit(localPath)
        if (!bytes) {
          console.warn('[Send-Routed] Skipping unavailable local image output')
          return null
        }
        const mediaType =
          output.mediaType ||
          inferImageMediaTypeFromPath(localPath) ||
          DEFAULT_IMAGE_MEDIA_TYPE
        return {
          content: `data:${mediaType};base64,${bytes.toString('base64')}`,
          mediaType,
        }
      } catch (error) {
        console.warn('[Send-Routed] Failed to read local image output:', {
          path: localPath,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    }

    return null
  }

  const createImageZipReference = async (
    output: ImageOutput,
    metadata: Record<string, any> = {},
  ): Promise<{ zipId: string; reference: string } | null> => {
    const screenshotTempPath =
      metadata?.source === 'agent_browser_screenshot' &&
      typeof output.filePath === 'string' &&
      output.filePath.trim().length > 0
        ? path.resolve(output.filePath.trim())
        : null
    try {
      let content: string | null = null
      let mediaType = output.mediaType || DEFAULT_IMAGE_MEDIA_TYPE
      let screenshotMetadata: Record<string, any> = {}

      if (metadata?.source === 'agent_browser_screenshot') {
        const uploadConfig = await resolveScreenshotUploadConfig()
        if (uploadConfig) {
          const localPath =
            typeof output.filePath === 'string' &&
            output.filePath.trim().length > 0
              ? path.resolve(output.filePath.trim())
              : null

          if (localPath) {
            try {
              const bytes = await readLocalImageOutputWithinLimit(localPath)
              if (bytes) {
                const fileName = path.basename(localPath)
                const resolvedMediaType =
                  output.mediaType ||
                  inferImageMediaTypeFromPath(localPath) ||
                  DEFAULT_IMAGE_MEDIA_TYPE

                const formData = new FormData()
                const blob = bytesToBlob(bytes, { type: resolvedMediaType })
                formData.append('file', blob, fileName)
                formData.append('sessionId', sessionId)
                formData.append('userId', userId)
                formData.append(
                  'compressionSettings',
                  JSON.stringify({
                    compress_images: false,
                    force_jpeg: false,
                  }),
                )
                formData.append(
                  'uploadSettings',
                  JSON.stringify({
                    strategy: uploadConfig.strategy,
                    storage_mode: uploadConfig.storageMode,
                    tunnel_url: uploadConfig.tunnelUrl,
                    use_https: uploadConfig.useHttps,
                    tunnel_provider: uploadConfig.tunnelProvider,
                    cloudflared_auto_start: uploadConfig.cloudflaredAutoStart,
                    cloudflared_target_url: uploadConfig.cloudflaredTargetUrl,
                    artifact_source: 'agent_browser_screenshot',
                    skip_clip_persistence: true,
                    artifact_ttl_seconds:
                      AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                    strategyConfig: {
                      ttlSeconds: AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                      ephemeral: true,
                    },
                  }),
                )

                const uploadResponse = await fetch(
                  `${getInternalBatshitServerUrl()}/api/upload/single`,
                  {
                    method: 'POST',
                    headers: getInternalBatshitServerAuthHeaders(),
                    body: formData,
                  },
                )
                const uploadPayload = await uploadResponse
                  .json()
                  .catch(() => null)

                if (uploadResponse.ok) {
                  const uploadedFile = uploadPayload?.file
                  const storageMode = String(
                    uploadedFile?.storageMode || '',
                  ).toLowerCase()
                  const resolvedExternalUrl = resolveScreenshotUploadModelUrl(
                    uploadedFile,
                    uploadConfig,
                  )

                  if (resolvedExternalUrl) {
                    content = resolvedExternalUrl
                    mediaType =
                      typeof uploadedFile?.mimetype === 'string'
                        ? uploadedFile.mimetype
                        : resolvedMediaType
                    screenshotMetadata = {
                      artifactTtlSeconds:
                        AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                      uploadStrategyUsed:
                        uploadedFile?.uploadStrategy || uploadConfig.strategy,
                      uploadStorageMode:
                        storageMode || uploadConfig.storageMode,
                      uploadDisplayUrl:
                        typeof uploadedFile?.displayUrl === 'string'
                          ? uploadedFile.displayUrl
                          : null,
                      uploadExternalUrl: resolvedExternalUrl,
                      fallbackMode: 'url',
                    }
                  } else {
                    screenshotMetadata = {
                      artifactTtlSeconds:
                        AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                      uploadStrategyUsed:
                        uploadedFile?.uploadStrategy || uploadConfig.strategy,
                      uploadStorageMode:
                        storageMode || uploadConfig.storageMode,
                      fallbackMode: 'data_url',
                    }
                  }
                } else {
                  console.warn(
                    '[Send-Routed] Screenshot upload failed; falling back to data URL zip',
                    {
                      sessionId,
                      messageId,
                      status: uploadResponse.status,
                      error:
                        uploadPayload?.error || uploadPayload?.details || null,
                    },
                  )
                }
              }
            } catch (uploadError) {
              console.warn(
                '[Send-Routed] Screenshot upload path failed; falling back to data URL zip',
                {
                  sessionId,
                  messageId,
                  error:
                    uploadError instanceof Error
                      ? uploadError.message
                      : String(uploadError),
                },
              )
            }
          }
        }
      }

      if (!content) {
        const materialized = await materializeImageOutput(output)
        if (!materialized?.content) return null
        content = materialized.content
        mediaType = materialized.mediaType
        if (metadata?.source === 'agent_browser_screenshot') {
          screenshotMetadata = {
            ...screenshotMetadata,
            artifactTtlSeconds: AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
            fallbackMode: screenshotMetadata?.fallbackMode ?? 'data_url',
          }
        }
      }

      const created = await createZipFromContent(
        content,
        'image',
        sessionId,
        messageId,
        {
          description: 'Generated image',
          mimeType: mediaType,
          bufferSize: imageZipSettings.bufferSize,
          threshold: imageZipSettings.zipThreshold,
          ...metadata,
          ...screenshotMetadata,
        },
      )
      return created || null
    } catch (error) {
      console.error('[Send-Routed] Failed to create image zip:', error)
      return null
    } finally {
      if (shouldCleanupAgentBrowserTempScreenshot(screenshotTempPath)) {
        try {
          await unlink(screenshotTempPath as string)
        } catch (cleanupError) {
          const code =
            cleanupError &&
            typeof cleanupError === 'object' &&
            'code' in cleanupError
              ? String((cleanupError as any).code)
              : null
          if (code !== 'ENOENT') {
            console.warn(
              '[Send-Routed] Failed to cleanup Agent Browser temp screenshot',
              {
                path: screenshotTempPath,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
            )
          }
        }
      }
    }
  }

  const emitReasoningAppend = async (content: string) => {
    if (!showReasoning) return
    if (!content) return
    await streamAdapter.emitThinking({
      content,
      metadata: {
        op: 'append',
        kind: 'reasoning_summary',
      },
    })
  }

  const emitReasoningReplace = async (content: string) => {
    if (!showReasoning) return
    await streamAdapter.emitThinking({
      content,
      metadata: {
        op: 'replace',
        kind: 'reasoning_summary',
      },
    })
  }

  const ensureReasoningSegmentBoundary = async () => {
    if (!showReasoning) return
    if (!reasoningActive) return
    // Treat any boundary (text/tool/finish) as the end of a reasoning segment.
    reasoningActive = false
  }

  const emitThinkingIndicator = async () => {
    if (thinkingIndicatorEmitted) return
    if (streamedMessageContent) return
    await streamAdapter.emitThinking({
      content: THINKING_INDICATOR,
      metadata: {
        kind: 'reasoning_indicator',
        op: 'start',
      },
    })
    thinkingIndicatorEmitted = true
  }

  const emitThinkingIndicatorStop = async () => {
    if (!thinkingIndicatorEmitted) return
    await streamAdapter.emitThinking({
      content: '',
      metadata: {
        kind: 'reasoning_indicator',
        op: 'stop',
      },
    })
    thinkingIndicatorEmitted = false
  }

  const handleReasoningIndicator = async () => {
    if (showReasoning) return false
    if (controlsEnabled && !controlsResolved) {
      if (ensureStartEmitted) {
        await ensureStartEmitted()
      }
      await emitThinkingIndicator()
      return true
    }
    if (controlsMode === 'listening') {
      silentResponse = true
      shouldBreakStream = true
      return true
    }
    if (pendingControlText) {
      await emitTextChunk(pendingControlText)
      pendingControlText = ''
    }
    if (ensureStartEmitted) {
      await ensureStartEmitted()
    }
    await emitThinkingIndicator()
    return true
  }

  type StreamRuntimeSettings = ReturnType<typeof buildRuntimeModelSettings>
  type StreamOverrideSettings = {
    temperature?: number | null
    maxTokens?: number | null
    topP?: number | null
    topK?: number | null
    presencePenalty?: number | null
    frequencyPenalty?: number | null
    seed?: number | null
    stopSequences?: string[] | null
  }

  const buildStreamRequest = (
    modelId: string,
    connection: NativeModeRequest['connection'],
    requestProviderId: string | null,
    settings: StreamRuntimeSettings,
    providerSettingsOverride: Record<string, any> | null,
    capabilities: ModelCapabilities | null,
    overrides: StreamOverrideSettings,
    toolsEnabled: boolean,
    streamMessages: any[] = compiledMessages,
    streamImages: Array<{ url: string }> = images,
  ): NativeModeRequest => {
    const providerOptions = withReasoningProviderOptions(
      Object.keys(settings.providerOptions).length > 0
        ? settings.providerOptions
        : undefined,
      {
        provider: requestProviderId,
        modelId,
        connection,
        capabilities,
        showReasoning,
      },
    )
    const taggedReasoningTagName = resolveTaggedReasoningTagName({
      provider: requestProviderId,
      modelId,
      connection,
      capabilities,
      showReasoning,
    })

    return {
      sessionId,
    messageId,
    agentId,
    agentSlug: agent.slug ?? null,
    messages: streamMessages,
    model: modelId,
    mode4Style: mode4Style ?? undefined,
    connection,
    images: streamImages,
    availableTools: selectedTools?.map((name: string) => ({
      name,
      description: `Tool: ${name}`,
      schema: {},
    })),
    maxToolRounds: 100,
    temperature: settings.standard.temperature ?? overrides.temperature ?? 0.7,
    maxTokens: settings.standard.maxTokens ?? overrides.maxTokens ?? 16384,
    topP: settings.standard.topP ?? overrides.topP ?? undefined,
    topK: settings.standard.topK ?? overrides.topK ?? undefined,
    presencePenalty:
      settings.standard.presencePenalty ??
      overrides.presencePenalty ??
      undefined,
    frequencyPenalty:
      settings.standard.frequencyPenalty ??
      overrides.frequencyPenalty ??
      undefined,
    seed: settings.standard.seed ?? overrides.seed ?? undefined,
    stopSequences:
      settings.standard.stopSequences ?? overrides.stopSequences ?? undefined,
    providerOptions,
    providerSettings: providerSettingsOverride ?? null,
    codexSettings: codexRuntimeSettings ?? undefined,
    claudeSettings: claudeRuntimeSettings ?? undefined,
    toolsEnabled,
    projectPath:
      resolvedCompiledProjectPath ??
      metadata?.projectPath ??
      metadataForLogs?.projectPath ??
      batshitInput?.metadata?.projectPath ??
      null,
    toolSelections: mcpToolSelections,
    selectedCliToolIds,
    selectedGateways,
    preloadedGatewayTools: preloadedGatewayTools ?? undefined,
    preloadedGatewayMetadata: preloadedGatewayMetadata ?? undefined,
    gatewayToolMap,
    assignedSubagents,
    defaultGateways,
    toolApprovalMode,
    userId,
    reserveToolZipId: ({ toolCallId, toolName }) =>
      reserveToolZipIdForCall({ toolCallId, toolName }),
    registerReservedToolZipId: ({ toolCallId, toolName, zipId }) =>
      reserveToolZipIdForCall({ toolCallId, toolName, zipId }),
    abortSignal: streamAbortSignal,
    simulateStreamingEffect: shouldSimulateStreamingEffect,
    taggedReasoningTagName,
    onFinish: async ({
      text,
      steps,
      totalUsage,
      usage,
      reasoning,
      responseMessages,
    }) => {
      const sanitizedFinishText = stripToolPartOnlyText(text)

      const resolvedUsage =
        (totalUsage || usage || rawUsageFromStream) ?? undefined
      lastStreamSteps = Array.isArray(steps) ? steps : []
      lastResolvedUsage = resolvedUsage ?? null

      logger.debug('[Send-Routed] Stream finished', {
        sessionId,
        messageId,
        totalTokens: resolvedUsage?.totalTokens,
      })

      if (silentResponse) {
        finishSummary.usage = resolvedUsage
        onFinishResolved = true
        resolveOnFinish?.()
        return
      }

      const parsed = buildIntermediateStepsFromSteps(steps)
      const intermediateSteps =
        streamedToolSteps.length > 0
          ? streamedToolSteps
          : parsed.intermediateSteps
      const filteredSteps = Array.isArray(intermediateSteps)
        ? intermediateSteps.filter(
            (step) =>
              !isPlanUpdateTool(
                step?.toolName ??
                  step?.tool ??
                  step?.originalToolName ??
                  step?.action?.tool,
              ),
          )
        : intermediateSteps
      const subagentEchoCandidates = [
        ...(Array.isArray(parsed.intermediateSteps)
          ? parsed.intermediateSteps
          : []),
        ...(Array.isArray(filteredSteps) ? filteredSteps : []),
      ]
      const normalizedFinishText = stripLeadingSubagentEchoText(
        sanitizedFinishText,
        subagentEchoCandidates,
      )

      lastStreamText = normalizedFinishText || null
      finishSummary.text = normalizedFinishText
      finishSummary.intermediateSteps = filteredSteps

      // Safety: if a reasoning segment is still open, treat it as complete now.
      reasoningActive = false

      // Some providers expose reasoning only in the final SDK result.
      if (showReasoning && !reasoningCaptured) {
        const finishReasoning = collectReasoningTextFromFinish(reasoning)
        if (finishReasoning) {
          reasoningCaptured = finishReasoning
          await emitReasoningReplace(finishReasoning)
        }
      }

      // Some providers expose reasoning summaries via steps rather than streaming events.
      // If we didn't capture anything in-stream, try to collect and emit once here.
      if (showReasoning && !reasoningCaptured && Array.isArray(steps)) {
        const collected: string[] = []

        for (const step of steps) {
          const direct =
            typeof (step as any)?.reasoningText === 'string'
              ? String((step as any).reasoningText).trim()
              : ''
          if (direct) {
            collected.push(direct)
            continue
          }

          const parts = (step as any)?.reasoning
          if (Array.isArray(parts)) {
            const joined = parts
              .map((part: any) =>
                typeof part?.text === 'string' ? part.text.trim() : '',
              )
              .filter(Boolean)
              .join('\n')
            if (joined.trim()) {
              collected.push(joined.trim())
            }
          }
        }

        const combined = collected.join('\n\n').trim()
        if (combined) {
          reasoningCaptured = combined
          await emitReasoningReplace(combined)
        }
      }

      const fileOutputs = Array.isArray(streamResult?.files)
        ? streamResult.files
        : []
      if (fileOutputs.length > 0) {
        let fileIndex = 0
        for (const file of fileOutputs) {
          const imageOutput = fileToImageOutput(file)
          if (!imageOutput) continue
          const created = await createImageZipReference(imageOutput, {
            source: 'result_files',
            fileIndex,
          })
          if (!created?.reference) continue
          const refEntry = { reference: created.reference }
          streamedToolZipReferences.push(refEntry)
          const prefix =
            streamedMessageContent && !streamedMessageContent.endsWith('\n')
              ? '\n\n'
              : ''
          await emitTextChunk(`${prefix}${created.reference}`, {
            allowZipReferences: true,
          })
          fileIndex += 1
        }
      }

      const finishZipInput = selectFinishZipInput({
        streamedMessageContent,
        sanitizedFinishText,
        forwardedToActiveSse: forwardedTextChunkToActiveSse
      })
      const baseTextForZipping = stripToolPartOnlyText(finishZipInput.content)

      const inlineProcessed = finishZipInput.processXmlZips
        ? await zipDetection.processFullContent(
            sessionId,
            messageId,
            baseTextForZipping,
            {
              agent: zipSettingsAgent,
              globalSettings: globalZipSettings,
              messagesFromEnd: 0,
            },
          )
        : { content: baseTextForZipping, references: [] }

      let finalContent = inlineProcessed.content
      const inlineZipRefs = inlineProcessed.references

      let coolToolZips: ZipReference[] = []
      const pendingToolSteps = Array.isArray(filteredSteps)
        ? filteredSteps.filter((step) => {
            const callId =
              typeof step?.toolCallId === 'string'
                ? step.toolCallId
                : typeof step?.id === 'string'
                  ? step.id
                  : undefined
            if (!callId) return true
            return !streamedToolZipCallIds.has(callId)
          })
        : []
      if (pendingToolSteps.length > 0) {
        const { adaptCoolToolsToZipSystem } =
          await import('$lib/server/coolToolZipAdapter')
        coolToolZips = await adaptCoolToolsToZipSystem(
          pendingToolSteps,
          sessionId,
          messageId,
          zipSettingsAgent || {},
          globalZipSettings,
          {
            reservedZipIdsByToolCallId: reservedToolZipIdsByCallId,
          },
        )
      }

      const allZipRefs = [
        ...inlineZipRefs,
        ...streamedToolZipReferences,
        ...coolToolZips,
      ]

      for (const ref of allZipRefs) {
        if (!finalContent) {
          finalContent = ref.reference
          continue
        }

        if (ref.placeholder && finalContent.includes(ref.placeholder)) {
          finalContent = finalContent.replace(ref.placeholder, ref.reference)
        } else if (ref.reference && !finalContent.includes(ref.reference)) {
          finalContent = `${finalContent} ${ref.reference}`.trim()
        }
      }

      // Providers sometimes emit attachment: URLs that browsers cannot resolve.
      // Strip them from persisted assistant content to avoid render errors/spam.
      if (typeof finalContent === 'string') {
        finalContent = stripAttachmentReferences(finalContent)
        const trustedFinalZipIds = allZipRefs
          .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
          .filter((id): id is string => Boolean(id))
        finalContent = neutralizeUntrustedZipReferenceSyntax(finalContent, {
          trustedZipIds: trustedFinalZipIds,
        })
        finalContent = neutralizeAllClipReferenceSyntax(finalContent)
        if (streamMetadata?.groupChat === true) {
          finalContent = stripGroupChatPresentationControls(finalContent)
        }
      }

      finishSummary.content = finalContent
      finishSummary.zipReferences = allZipRefs
      finishSummary.metadata = {
        model: usedModelId,
        agentType: primaryAgentType,
        usage: totalUsage || usage,
        steps: steps?.length || 0,
        voice: voiceMetadata,
        selectedTools,
        selectedGateways,
        ...(fallbackUsed
          ? {
              fallbackUsed: true,
              primaryModel: primaryModelId,
              fallbackModel: usedModelId,
            }
          : {}),
        ...(imageZipIdsForUi.size > 0
          ? { imageZipIds: Array.from(imageZipIdsForUi) }
          : {}),
      }
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        const persistedProviderMessages =
          sanitizeProviderMessagesForPersistence(responseMessages)
        finishSummary.metadata = {
          ...finishSummary.metadata,
          providerMessages: persistedProviderMessages,
          providerMessageSource: {
            providerId: providerIdentifier || null,
            connectionId: connection?.id || connection?.service || null,
            modelId: typeof modelId === 'string' ? modelId.toLowerCase() : null,
          },
        }
      }

      if (streamMetadata && Object.keys(streamMetadata).length > 0) {
        finishSummary.metadata = {
          ...finishSummary.metadata,
          ...streamMetadata,
        }
      }

      if (controlsEnabled && controlsResolved) {
        const controlsMeta = controlsPayload ?? { mode: controlsMode }
        finishSummary.metadata = {
          ...finishSummary.metadata,
          controls: controlsMeta,
        }
      }

      if (preserveReasoning && (planSummary || planItems.length > 0)) {
        finishSummary.metadata = {
          ...finishSummary.metadata,
          ...(planSummary ? { planSummary } : {}),
          ...(planItems.length > 0 ? { planItems } : {}),
        }
      }

      if (showReasoning && preserveReasoning && reasoningCaptured) {
        finishSummary.metadata = {
          ...finishSummary.metadata,
          reasoningSummary: reasoningCaptured,
        }
      }

      finishSummary.usage = resolvedUsage

      onFinishResolved = true
      resolveOnFinish?.()

      try {
        if (isCodexProvider || isClaudeProvider) {
          const {
            buildCodexPromptFromMessages,
            buildCodexPromptPackageFromMessages,
          } =
            await import('$lib/server/services/codexBridge')
          const sanitizedStreamMessages = sanitizePayloadForLogs(streamMessages)
          const sanitizedStreamImages = sanitizePayloadForLogs(streamImages)
          const sanitizedToolSteps = sanitizePayloadForLogs(
            Array.isArray(intermediateSteps) ? intermediateSteps : [],
          )
          const promptInput = {
            messages: sanitizedStreamMessages as Array<{
              role?: string
              content: any
              name?: string
            }>,
            images: sanitizedStreamImages as Array<{
              url: string
              alt?: string
            }>,
          }
          const codexPromptPackage = isCodexProvider
            ? buildCodexPromptPackageFromMessages(promptInput)
            : null
          const prompt =
            codexPromptPackage?.prompt ??
            buildCodexPromptFromMessages(promptInput)

          const capture = isCodexProvider
            ? buildCodexLlmCapture({
                prompt,
                developerInstructions:
                  codexPromptPackage?.developerInstructions ?? null,
                images: sanitizedStreamImages as Array<{
                  url: string
                  alt?: string
                }>,
                tools: preloadedGatewayTools ?? null,
                toolMetadata: preloadedGatewayMetadata ?? null,
                totalUsage: resolvedUsage ?? null,
              })
            : buildClaudeLlmCapture({
                prompt,
                images: sanitizedStreamImages as Array<{
                  url: string
                  alt?: string
                }>,
                tools: preloadedGatewayTools ?? null,
                toolMetadata: preloadedGatewayMetadata ?? null,
                totalUsage: resolvedUsage ?? null,
              })

          const responseUsageSource = isCodexProvider ? 'codex' : 'claude'
          const responseNotes = isCodexProvider
            ? [
                'Codex CLI totals are exact when the CLI reports usage, but per-step on-wire payload breakdown is unavailable.',
              ]
            : [
                'Claude Code CLI totals are exact when the CLI reports usage, but per-step on-wire payload breakdown is unavailable.',
                ...(typeof resolvedUsage?.cachedInputTokens === 'number' ||
                typeof resolvedUsage?.cacheCreationInputTokens === 'number'
                  ? [
                      'Claude prompt caching is active for this run. Input/Total include fresh input plus cache-read and cache-creation tokens.',
                    ]
                  : []),
              ]

          await executionViewerService.updateSnapshot(sessionId, messageId, {
            llmSummary: capture.llmSummary,
            llmCalls: capture.llmCalls,
            intermediateSteps:
              Array.isArray(sanitizedToolSteps) && sanitizedToolSteps.length > 0
                ? (sanitizedToolSteps as any[])
                : null,
            responseSummary: {
              content: { value: finalContent, confidence: 'exact' },
              usage: buildTokenUsage(
                resolvedUsage ?? null,
                'exact',
                responseUsageSource,
              ),
              toolCallsCount: buildTokenStat(
                intermediateSteps.length,
                intermediateSteps.length > 0 ? 'near' : 'exact',
                responseUsageSource,
              ),
              notes: responseNotes,
            },
          })
        } else {
          const sanitizedSteps = sanitizePayloadForLogs(
            Array.isArray(steps) ? steps : [],
          )
          const sanitizedToolSteps = sanitizePayloadForLogs(
            Array.isArray(intermediateSteps) ? intermediateSteps : [],
          )
          const capture = buildVercelLlmCapture({
            steps: sanitizedSteps as any[],
            totalUsage: resolvedUsage ?? null,
            finalText: typeof text === 'string' ? text : null,
          })

          const toolCallsTotal = Array.isArray(steps)
            ? steps.reduce((sum: number, step: any) => {
                const count = Array.isArray(step?.toolCalls)
                  ? step.toolCalls.length
                  : 0
                return sum + count
              }, 0)
            : intermediateSteps.length

          await executionViewerService.updateSnapshot(sessionId, messageId, {
            llmSummary: capture.llmSummary,
            llmCalls: capture.llmCalls,
            intermediateSteps:
              Array.isArray(sanitizedToolSteps) && sanitizedToolSteps.length > 0
                ? (sanitizedToolSteps as any[])
                : null,
            responseSummary: {
              content: { value: finalContent, confidence: 'exact' },
              usage: buildTokenUsage(
                resolvedUsage ?? null,
                'exact',
                'provider',
              ),
              toolCallsCount: buildTokenStat(
                toolCallsTotal,
                'exact',
                'vercel ai sdk',
              ),
            },
          })
        }
      } catch (viewerPatchError) {
        console.error(
          '[Send-Routed] Failed to enrich execution snapshot with LLM payload details:',
          viewerPatchError,
        )
      }
    },
    onAbort: ({ steps }) => {
      logger.debug('[Send-Routed] Stream aborted', {
        sessionId,
        messageId,
        stepsCompleted: steps?.length || 0,
      })
    },
    }
  }

  const primaryConnection = primarySelection.connection
  const primaryModelId = isCodexProvider
    ? 'codex/codex-cli'
    : isClaudeProvider
      ? 'claude/claude-cli'
      : effectiveModelId || 'claude-3-5-sonnet-20241022'
  const primaryOverrides: StreamOverrideSettings = {
    temperature:
      agentMetadata.primary_model_temperature ??
      agent.primary_model_temperature ??
      null,
    maxTokens:
      agentMetadata.primary_model_max_tokens ??
      agent.primary_model_max_tokens ??
      null,
    topP:
      agentMetadata.primary_model_top_p ?? agent.primary_model_top_p ?? null,
    topK:
      agentMetadata.primary_model_top_k ?? agent.primary_model_top_k ?? null,
    presencePenalty:
      agentMetadata.primary_model_presence_penalty ??
      agent.primary_model_presence_penalty ??
      null,
    frequencyPenalty:
      agentMetadata.primary_model_frequency_penalty ??
      agent.primary_model_frequency_penalty ??
      null,
    seed: agentMetadata.primary_model_seed ?? agent.primary_model_seed ?? null,
    stopSequences:
      agentMetadata.primary_model_stop_sequences ??
      agent.primary_model_stop_sequences ??
      null,
  }

  const fallbackOverrides: StreamOverrideSettings = {
    temperature:
      agentMetadata.fallback_model_temperature ??
      agent.fallback_model_temperature ??
      null,
    maxTokens:
      agentMetadata.fallback_model_max_tokens ??
      agent.fallback_model_max_tokens ??
      null,
    topP:
      agentMetadata.fallback_model_top_p ?? agent.fallback_model_top_p ?? null,
    topK:
      agentMetadata.fallback_model_top_k ?? agent.fallback_model_top_k ?? null,
    presencePenalty:
      agentMetadata.fallback_model_presence_penalty ??
      agent.fallback_model_presence_penalty ??
      null,
    frequencyPenalty:
      agentMetadata.fallback_model_frequency_penalty ??
      agent.fallback_model_frequency_penalty ??
      null,
    seed:
      agentMetadata.fallback_model_seed ?? agent.fallback_model_seed ?? null,
    stopSequences:
      agentMetadata.fallback_model_stop_sequences ??
      agent.fallback_model_stop_sequences ??
      null,
  }

  const clippedItemsForImages =
    formattedInput.structuredInput?.clippedItems ?? []
  const primaryResolvedForImages = resolveModelIds({
    developerId: primarySelection.provider,
    modelId: primarySelection.modelId,
    connection: primaryConnection,
  })
  const primaryProviderIdForImages =
    primaryResolvedForImages?.providerId ??
    providerIdentifier ??
    primaryConnection?.service ??
    null
  const fallbackProviderIdForImages =
    fallbackResolvedIds?.providerId ??
    fallbackProviderId ??
    fallbackConnection?.service ??
    null
  const needsLocalImageConfig =
    isLocalProviderId(primaryProviderIdForImages) ||
    isLocalProviderId(fallbackProviderIdForImages)
  const localServerConfigs = needsLocalImageConfig
    ? await listLocalAiServers(userId).catch(() => null)
    : null
  const primaryImageConfig = await resolveImageTransportConfig({
    userId,
    providerId: primaryProviderIdForImages,
    presetId: primaryPresetId,
    localServers: localServerConfigs,
  })
  const fallbackImageConfig = await resolveImageTransportConfig({
    userId,
    providerId: fallbackProviderIdForImages,
    presetId: fallbackPresetId,
    localServers: localServerConfigs,
  })

  let streamResult: any
  let usedModelId = primaryModelId
  let usedConnection = primaryConnection
  let usedRuntimeSettings = runtimeSettings
  let usedProviderSettings = providerSpecificSettings ?? null
  let fallbackUsed = false

  const fallbackAvailable =
    !isCliProvider &&
    fallbackEnabled &&
    Boolean(fallbackEffectiveModelId) &&
    Boolean(fallbackRuntimeSettings) &&
    fallbackEffectiveModelId !== primaryModelId

  if (consumeSessionClips) {
    await consumePostCompileSessionClips(sessionId)
  }

  registerStreamAbort(sessionId, messageId, streamAbortController)

  try {
    const primaryImagePayload = await applyImageTransportOverrides({
      messages: compiledMessages,
      images,
      clippedItems: clippedItemsForImages,
      transport: primaryImageConfig.transport,
      imageBaseUrl: primaryImageConfig.imageBaseUrl,
      preferRemoteUrl: !isLocalProviderId(primaryProviderIdForImages),
    })
    streamResult = await nativeRuntime.streamNativeMode(
      buildStreamRequest(
        primaryModelId,
        primaryConnection,
        primaryProviderId ?? null,
        runtimeSettings,
        providerSpecificSettings ?? null,
        primaryCapabilities,
        primaryOverrides,
        primaryToolsEnabled,
        primaryImagePayload.messages,
        primaryImagePayload.images,
      ),
    )
  } catch (primaryError) {
    if (!fallbackAvailable) {
      clearStreamAbort(sessionId, messageId)
      throw primaryError
    }

    fallbackUsed = true
    usedModelId = fallbackEffectiveModelId!
    usedConnection = fallbackConnection ?? null
    usedRuntimeSettings = fallbackRuntimeSettings!
    usedProviderSettings = fallbackProviderSpecificSettings ?? null
    runtimeSnapshot.metadata = {
      ...(runtimeSnapshot.metadata ?? {}),
      fallbackUsed: true,
      primaryModel: primaryModelId,
      fallbackModel: usedModelId,
    }

    try {
      const fallbackImagePayload = await applyImageTransportOverrides({
        messages: compiledMessages,
        images,
        clippedItems: clippedItemsForImages,
        transport: fallbackImageConfig.transport,
        imageBaseUrl: fallbackImageConfig.imageBaseUrl,
        preferRemoteUrl: !isLocalProviderId(fallbackProviderIdForImages),
      })
      streamResult = await nativeRuntime.streamNativeMode(
        buildStreamRequest(
          usedModelId,
          usedConnection,
          fallbackResolvedIds?.developerId ?? null,
          usedRuntimeSettings,
          usedProviderSettings,
          fallbackResolvedIds
            ? fallbackCapabilities
            : null,
          fallbackOverrides,
          fallbackToolsEnabled,
          fallbackImagePayload.messages,
          fallbackImagePayload.images,
        ),
      )
    } catch (fallbackError) {
      clearStreamAbort(sessionId, messageId)
      throw fallbackError
    }
  }

  try {
    const result = streamResult
    const runtimeInfo = (result as any).__runtimeInfo
    if (runtimeInfo && typeof runtimeInfo === 'object') {
      runtimeSnapshot.transport =
        runtimeInfo.transport ?? runtimeSnapshot.transport
      runtimeSnapshot.sandboxMode =
        runtimeInfo.sandboxMode ?? runtimeSnapshot.sandboxMode
      runtimeSnapshot.allowFileEdits =
        runtimeInfo.allowFileEdits ?? runtimeSnapshot.allowFileEdits
      runtimeSnapshot.allowNetwork =
        runtimeInfo.allowNetwork ?? runtimeSnapshot.allowNetwork
      runtimeSnapshot.workingDirectory =
        runtimeInfo.workingDirectory ?? runtimeSnapshot.workingDirectory
      const runtimeInfoMetadata =
        runtimeInfo.metadata && typeof runtimeInfo.metadata === 'object'
          ? (runtimeInfo.metadata as Record<string, any>)
          : null
      if (runtimeInfoMetadata) {
        runtimeSnapshot.metadata = {
          ...(runtimeSnapshot.metadata ?? {}),
          ...runtimeInfoMetadata,
        }
      }
      runtimeSnapshot.providerId =
        runtimeInfo.providerId ?? runtimeSnapshot.providerId
      runtimeSnapshot.connectionId =
        runtimeInfo.connectionId ?? runtimeSnapshot.connectionId
      runtimeSnapshot.modelName =
        runtimeInfo.modelName ?? runtimeSnapshot.modelName
    } else if (
      (isCodexProvider || isClaudeProvider) &&
      (result as any).__transport &&
      !runtimeSnapshot.transport
    ) {
      const transportHint = (result as any).__transport
      if (isCodexProvider) {
        runtimeSnapshot.transport =
          transportHint === 'sdk'
            ? 'codex-sdk'
            : transportHint === 'app-server'
              ? 'codex-app-server'
              : transportHint === 'exec'
                ? 'codex-exec'
            : transportHint === 'cli'
              ? 'codex-cli'
              : 'unknown'
      } else if (isClaudeProvider) {
        runtimeSnapshot.transport =
          transportHint === 'sdk'
            ? 'claude-sdk'
            : transportHint === 'cli'
              ? 'claude-cli'
              : 'unknown'
      }
    }

    try {
      await executionViewerService.updateSnapshot(sessionId, messageId, {
        runtime: runtimeSnapshot,
      })
    } catch (runtimePatchError) {
      console.error(
        '[Send-Routed] Failed to persist resolved runtime details before streaming:',
        runtimePatchError,
      )
    }

    if (Array.isArray((result as any).__rawEvents)) {
      runtimeEventLogBuffer = (result as any).__rawEvents
    }

    detectToolSource =
      typeof (result as any).__detectToolSource === 'function'
        ? (result as any).__detectToolSource
        : (_toolName: string) => ({
            toolProvider: 'unknown',
            toolSource: 'unknown',
          })

    const startPayload = {
      messageId,
      metadata: {
        model: usedModelId,
        selectedTools,
        selectedGateways,
        ...(fallbackUsed
          ? {
              fallbackUsed: true,
              primaryModel: primaryModelId,
              fallbackModel: usedModelId,
            }
          : {}),
      },
    }

    let startEmitted = false
    ensureStartEmitted = async () => {
      if (startEmitted) return
      await streamAdapter.emitStart(startPayload)
      startEmitted = true
    }

    controlsEnabled = streamMetadata?.groupChat === true
    controlsResolved = !controlsEnabled
    controlsMode = 'responding'
    controlsPayload = null
    controlsBuffer = ''
    pendingControlText = ''
    silentResponse = false

    // Codex CLI can take a while before the first chunk; show a UI-only
    // indicator until real reasoning/text/tool events arrive.
    if (isCodexProvider) {
      await ensureStartEmitted()
      await emitThinkingIndicator()
    }

    const resolveControlsFromBuffer = () => {
      if (controlsResolved) return

      const result = parseLeadingGroupControlFromBuffer(controlsBuffer)
      if (result.kind === 'pending') {
        return
      }

      if (result.kind === 'passthrough') {
        controlsResolved = true
        pendingControlText = result.content
        controlsBuffer = ''
        return
      }

      controlsPayload = result.payload
      controlsMode = result.mode
      controlsResolved = true
      pendingControlText = result.remaining
      controlsBuffer = ''
    }

    const stripRepeatedLeadingGroupControls = (content: string) => {
      if (!controlsEnabled || !controlsResolved || !content) return content
      return stripRepeatedLeadingGroupControlBlocks(content)
    }

    shouldBreakStream = false
    for await (const chunk of result.stream) {
      switch (chunk.type) {
        case 'text-delta': {
          const textChunk = stripRepeatedLeadingGroupControls((chunk as any).text || '')
          if (textChunk) {
            if (controlsEnabled && !controlsResolved) {
              controlsBuffer += textChunk
              resolveControlsFromBuffer()
              if (!controlsResolved) {
                break
              }

              if (controlsMode === 'listening') {
                silentResponse = true
                shouldBreakStream = true
                break
              }

              if (pendingControlText) {
                await ensureReasoningSegmentBoundary()
                await emitTextChunk(pendingControlText)
                pendingControlText = ''
              }
              break
            }

            await ensureReasoningSegmentBoundary()
            await emitTextChunk(textChunk)
          }
          break
        }
        case 'reasoning': {
          // OpenAI reasoning summaries stream via `part.type === 'reasoning'`
          // with `textDelta` (Vercel AI SDK).
          if (await handleReasoningIndicator()) break
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          const delta =
            (chunk as any).textDelta ??
            (chunk as any).text ??
            (chunk as any).delta ??
            (chunk as any).content ??
            ''
          if (typeof delta === 'string' && delta) {
            if (!reasoningActive && reasoningCaptured) {
              reasoningCaptured += '\n\n'
              await emitReasoningAppend('\n\n')
            }
            reasoningActive = true
            reasoningCaptured += delta
            await emitReasoningAppend(delta)
          }
          break
        }
        case 'reasoning-start':
        case 'reasoning_start': {
          if (await handleReasoningIndicator()) break
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          if (!reasoningActive && reasoningCaptured) {
            reasoningCaptured += '\n\n'
            await emitReasoningAppend('\n\n')
          }
          reasoningActive = true
          const initial = (chunk as any).text || (chunk as any).content || ''
          if (typeof initial === 'string' && initial) {
            reasoningCaptured += initial
            await emitReasoningAppend(initial)
          }
          break
        }
        case 'reasoning-delta':
        case 'reasoning_delta': {
          if (await handleReasoningIndicator()) break
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          const delta =
            (chunk as any).text ??
            (chunk as any).delta ??
            (chunk as any).content ??
            ''
          if (typeof delta === 'string' && delta) {
            if (!reasoningActive && reasoningCaptured) {
              reasoningCaptured += '\n\n'
              await emitReasoningAppend('\n\n')
            }
            reasoningActive = true
            reasoningCaptured += delta
            await emitReasoningAppend(delta)
          }
          break
        }
        case 'reasoning-end':
        case 'reasoning_end': {
          if (!showReasoning) break
          reasoningActive = false
          break
        }
        case 'thinking': {
          const thinkingChunk = chunk as any
          if (await handleReasoningIndicator()) break
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          const content =
            typeof thinkingChunk?.content === 'string'
              ? thinkingChunk.content
              : ''
          if (!content) break

          // Codex emits full reasoning content on each update. Stream as replace events.
          reasoningCaptured = content
          reasoningActive = Boolean(!thinkingChunk?.final)
          await emitReasoningReplace(content)
          break
        }
        case 'tool-call': {
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          await ensureReasoningSegmentBoundary()
          const toolCall = chunk as any
          const rawArgs = toolCall.input ?? toolCall.args ?? {}
          const args = normalizeToolArgs(rawArgs)
          const nativeBashMapping = resolveNativeBashMapping({
            toolName: toolCall.toolName,
            args,
          })
          const emittedToolName =
            nativeBashMapping?.mappedToolName ??
            toolCall.toolName ??
            'unknown_tool'
          const emittedArgs = nativeBashMapping?.mappedArgs ?? args
          const resolvedToolCallId =
            resolveToolCallIdFromEvent(toolCall) ||
            `tool_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
          if (isPlanUpdateTool(toolCall.toolName)) {
            await emitPlanUpdate(rawArgs)
            break
          }
          if (isImageToolName(toolCall.toolName)) {
            logger.debug('[Send-Routed] Image tool call', {
              sessionId,
              messageId,
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              tool_call_id: toolCall.tool_call_id,
              callId: toolCall.callId,
              id: toolCall.id,
              resolvedToolCallId,
            })
          }
          if (typeof toolCall.toolName === 'string' && resolvedToolCallId) {
            toolCallIdByName.set(toolCall.toolName, resolvedToolCallId)
            if (typeof emittedToolName === 'string') {
              toolCallIdByName.set(emittedToolName, resolvedToolCallId)
            }
          }
          if (resolvedToolCallId) {
            reserveToolZipIdForCall({
              toolCallId: resolvedToolCallId,
              toolName: emittedToolName,
            })
            toolCallPayloadById.set(resolvedToolCallId, {
              toolName: toolCall.toolName ?? emittedToolName,
              input: emittedArgs,
              toolCall: {
                type: 'tool-call',
                toolCallId: resolvedToolCallId,
                toolName: toolCall.toolName ?? emittedToolName,
                input: emittedArgs,
              },
            })
          }
          await streamAdapter.emitToolStart({
            toolCallId: resolvedToolCallId,
            toolName: emittedToolName,
          })
          await streamAdapter.emitToolCall({
            toolCallId: resolvedToolCallId,
            toolName: emittedToolName,
            args: emittedArgs,
          })
          break
        }
        case 'tool-approval-request':
        case 'tool_approval_request': {
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          await ensureReasoningSegmentBoundary()

          const approval = chunk as any
          const approvalId =
            typeof approval?.approvalId === 'string'
              ? approval.approvalId.trim()
              : typeof approval?.approval_id === 'string'
                ? approval.approval_id.trim()
                : ''
          if (!approvalId) {
            break
          }

          const resolvedToolCallId =
            resolveToolCallIdFromEvent(approval) ||
            (typeof approval?.toolCallId === 'string'
              ? approval.toolCallId
              : undefined) ||
            (typeof approval?.tool_call_id === 'string'
              ? approval.tool_call_id
              : undefined)
          const knownToolCall = resolvedToolCallId
            ? toolCallPayloadById.get(resolvedToolCallId)
            : undefined
          const toolName =
            (typeof approval?.toolName === 'string' &&
            approval.toolName.trim().length > 0
              ? approval.toolName.trim()
              : typeof approval?.tool_name === 'string' &&
                  approval.tool_name.trim().length > 0
                ? approval.tool_name.trim()
                : knownToolCall?.toolName) || undefined
          const input =
            approval?.input ??
            approval?.args ??
            approval?.parameters ??
            knownToolCall?.input
          const toolCall =
            approval?.toolCall ??
            approval?.tool_call ??
            knownToolCall?.toolCall ??
            (toolName
              ? {
                  type: 'tool-call',
                  ...(resolvedToolCallId
                    ? { toolCallId: resolvedToolCallId }
                    : {}),
                  toolName,
                  ...(input !== undefined ? { input } : {}),
                }
              : undefined)
          const requestedAt =
            typeof approval?.requestedAt === 'string' &&
            approval.requestedAt.trim().length > 0
              ? approval.requestedAt.trim()
              : new Date().toISOString()
          const requestedAtMs = parseTimestampMs(requestedAt)
          const expiresAt =
            typeof approval?.expiresAt === 'string' &&
            approval.expiresAt.trim().length > 0
              ? approval.expiresAt.trim()
              : new Date(
                  (requestedAtMs ?? Date.now()) + TOOL_APPROVAL_TIMEOUT_MS,
                ).toISOString()

          await streamAdapter.emitToolApprovalRequest({
            approvalId,
            toolCallId: resolvedToolCallId,
            toolName,
            input,
            toolCall,
            requestedAt,
            expiresAt,
            source: 'vercel',
          })

          streamedApprovalRequests.set(approvalId, {
            approvalId,
            status: 'pending',
            requestedAt,
            expiresAt,
            ...(toolName ? { toolName } : {}),
            ...(toolCall && typeof toolCall === 'object' ? { toolCall } : {}),
            ...(input !== undefined ? { input } : {}),
            source: 'vercel',
          })
          break
        }
        case 'tool-result': {
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          if (pendingControlText) {
            await emitTextChunk(pendingControlText)
            pendingControlText = ''
          }
          await ensureStartEmitted()
          await ensureReasoningSegmentBoundary()
          const toolResult = chunk as any
          if (toolResult?.dynamic) {
            if (isImageToolName(toolResult.toolName)) {
              logger.debug('[Send-Routed] Image tool-result skipped (dynamic)', {
                sessionId,
                messageId,
                toolName: toolResult.toolName,
                toolCallId: toolResult.toolCallId,
              })
            }
            break
          }
          const rawArgs = toolResult.input ?? toolResult.args ?? {}
          const args = normalizeToolArgs(rawArgs)
          if (isPlanUpdateTool(toolResult.toolName)) {
            const planPayload =
              toolResult.output ??
              toolResult.result ??
              toolResult.data ??
              toolResult.content ??
              toolResult.items ??
              rawArgs ??
              args
            await emitPlanUpdate(planPayload)
            break
          }
          let resultPayload = normalizeToolResult(
            toolResult.output ??
              toolResult.result ??
              toolResult.data ??
              toolResult.content,
            toolResult.toolName,
            args,
          )
          const nativeBashMapping = resolveNativeBashMapping({
            toolName: toolResult.toolName,
            args,
            result: resultPayload,
          })
          const emittedToolName =
            nativeBashMapping?.mappedToolName ??
            toolResult.toolName ??
            'unknown_tool'
          const emittedArgs = nativeBashMapping?.mappedArgs ?? args
          if (
            nativeBashMapping &&
            resultPayload &&
            typeof resultPayload === 'object' &&
            !Array.isArray(resultPayload)
          ) {
            resultPayload = {
              ...resultPayload,
              originalToolName: toolResult.toolName,
              mappedToolName: nativeBashMapping.mappedToolName,
              mappedReason: nativeBashMapping.reason,
            }
          }
          const rawToolCallId =
            resolveToolCallIdFromEvent(toolResult) ||
            (typeof toolResult.toolName === 'string'
              ? toolCallIdByName.get(toolResult.toolName) ||
                (typeof emittedToolName === 'string'
                  ? toolCallIdByName.get(emittedToolName)
                  : undefined)
              : undefined)
          const fallbackToolCallId =
            rawToolCallId ||
            `tool_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`

          const resolvedMetadata = detectToolSource(toolResult.toolName)
          let toolZipReferences:
            | ZipReference[]
            | undefined = streamedToolZipRefsByCallId.get(fallbackToolCallId)
          let imageZipReferences:
            | ZipReference[]
            | undefined = imageZipRefsByCallId.get(fallbackToolCallId)

          const isImageTool = isImageToolName(toolResult.toolName)
          const isAgentBrowserScreenshot = isAgentBrowserScreenshotInvocation(
            toolResult.toolName,
            resultPayload,
            args,
          )
          const isImageLikeToolResult = isImageTool || isAgentBrowserScreenshot
          if (
            isImageLikeToolResult &&
            emittedImageToolResultIds.has(fallbackToolCallId)
          ) {
            logger.debug('[Send-Routed] Duplicate image tool-result ignored', {
              sessionId,
              messageId,
              toolName: toolResult.toolName,
              toolCallId: fallbackToolCallId,
            })
            break
          }
          const imageOutputs = isAgentBrowserScreenshot
            ? []
            : extractImageOutputs(toolResult.toolName, resultPayload, args)
          const screenshotDisplayUrl = isAgentBrowserScreenshot
            ? extractAgentBrowserScreenshotExternalUrl(resultPayload)
            : null
          const screenshotModelVisibility = isAgentBrowserScreenshot
            ? extractAgentBrowserScreenshotModelVisibility(resultPayload)
            : null
          const screenshotModelVisibleInLoop =
            isAgentBrowserScreenshot &&
            (typeof screenshotModelVisibility === 'boolean'
              ? screenshotModelVisibility
              : Boolean(screenshotDisplayUrl))
          let sanitizedResultPayload: any = resultPayload

          if (isAgentBrowserScreenshot) {
            sanitizedResultPayload = {
              screenshotCaptured: true,
              screenshotUrl: screenshotDisplayUrl,
              command: 'screenshot',
              toolName: toolResult.toolName,
              ephemeral: true,
              historyRetention: 'none',
              modelVisibleInLoop: screenshotModelVisibleInLoop,
              ...(screenshotModelVisibleInLoop
                ? {}
                : {
                    warning:
                      'No screenshot image payload was available for model vision in this loop.',
                  }),
            }
          } else if (imageOutputs.length > 0) {
            if (!imageZipReferences) {
              const createdImageZips: ZipReference[] = []
              for (let i = 0; i < imageOutputs.length; i += 1) {
                const output = imageOutputs[i]
                const created = await createImageZipReference(output, {
                  source: isAgentBrowserScreenshot
                    ? 'agent_browser_screenshot'
                    : 'image_generation',
                  description: isAgentBrowserScreenshot
                    ? 'Agent Browser screenshot'
                    : 'AI-generated image',
                  toolName: toolResult.toolName,
                  toolCallId: fallbackToolCallId,
                  imageIndex: i,
                })
                if (created?.reference) {
                  createdImageZips.push({
                    zipId: created.zipId,
                    reference: created.reference,
                  })
                }
              }

              if (createdImageZips.length > 0) {
                imageZipReferences = createdImageZips
                imageZipRefsByCallId.set(fallbackToolCallId, createdImageZips)
                if (typeof toolResult.toolName === 'string') {
                  imageZipRefsByToolName.set(
                    toolResult.toolName,
                    createdImageZips,
                  )
                }
                streamedToolZipReferences.push(...createdImageZips)
                for (const ref of createdImageZips) {
                  if (isImageTool) {
                    const zipId = ref.zipId || extractZipIdFromReference(ref.reference)
                    if (zipId) imageZipIdsForUi.add(zipId)
                  }
                }
              }
            }

            if (isImageTool) {
              sanitizedResultPayload = {
                imageCount: imageOutputs.length,
                imageZipReferences:
                  imageZipReferences?.map((ref) => ref.reference) ?? [],
                toolName: toolResult.toolName,
              }
            } else if (isAgentBrowserScreenshot) {
              sanitizedResultPayload = {
                screenshotCount: imageOutputs.length,
                screenshotZipReferences:
                  imageZipReferences?.map((ref) => ref.reference) ?? [],
                command: 'screenshot',
                toolName: toolResult.toolName,
              }
            } else {
              sanitizedResultPayload = {
                imageCount: imageOutputs.length,
                imageReferences:
                  imageZipReferences?.map((ref) => ref.reference) ?? [],
                toolName: toolResult.toolName,
              }
            }
          } else if (isImageTool) {
            const fallbackRefs =
              imageZipReferences ??
              (typeof toolResult.toolName === 'string'
                ? imageZipRefsByToolName.get(toolResult.toolName)
                : undefined)
            if (fallbackRefs && fallbackRefs.length > 0) {
              imageZipReferences = fallbackRefs
              sanitizedResultPayload = {
                imageCount: fallbackRefs.length,
                imageZipReferences: fallbackRefs.map((ref) => ref.reference),
                toolName: toolResult.toolName,
              }
              for (const ref of fallbackRefs) {
                const zipId = ref.zipId || extractZipIdFromReference(ref.reference)
                if (zipId) imageZipIdsForUi.add(zipId)
              }
            }
          }

          if (isImageTool) {
            logger.debug('[Send-Routed] Image tool-result processed', {
              sessionId,
              messageId,
              toolName: toolResult.toolName,
              toolCallId: fallbackToolCallId,
              toolCallIdRaw: rawToolCallId,
              tool_call_id: toolResult.tool_call_id,
              toolCallIdField: toolResult.toolCallId,
              id: toolResult.id,
              imageOutputs: imageOutputs.length,
              zipRefs: toolZipReferences?.length ?? 0,
              usedCoolTool:
                !toolZipReferences &&
                !streamedToolZipCallIds.has(fallbackToolCallId),
            })
          } else if (isAgentBrowserScreenshot) {
            logger.debug(
              '[Send-Routed] Agent Browser screenshot tool-result processed',
              {
                sessionId,
                messageId,
                toolName: toolResult.toolName,
                toolCallId: fallbackToolCallId,
                imageOutputs: imageOutputs.length,
                hasExternalUrl: Boolean(screenshotDisplayUrl),
                zipRefs: imageZipReferences?.length ?? 0,
              },
            )
          }

          if (
            !toolZipReferences &&
            !streamedToolZipCallIds.has(fallbackToolCallId)
          ) {
            if (!coolToolZipAdapterModule) {
              coolToolZipAdapterModule =
                await import('$lib/server/coolToolZipAdapter')
            }

            const stepForZip = {
              toolName: emittedToolName,
              originalToolName: toolResult.toolName,
              toolInput: emittedArgs,
              toolArgs: emittedArgs,
              toolResult: sanitizedResultPayload,
              toolCallId: fallbackToolCallId,
              timestamp: new Date().toISOString(),
              metadata: {
                sessionId,
              },
              ...(resolvedMetadata ?? {}),
              ...(toolResult.metadata ?? {}),
            }

            const created =
              await coolToolZipAdapterModule.adaptCoolToolsToZipSystem(
                [stepForZip],
                sessionId,
                messageId,
                zipSettingsAgent || {},
                globalZipSettings,
                {
                  reservedZipIdsByToolCallId: reservedToolZipIdsByCallId,
                },
              )

            if (created.length > 0) {
              toolZipReferences = created
              streamedToolZipReferences.push(...created)
              streamedToolZipCallIds.add(fallbackToolCallId)
              streamedToolZipRefsByCallId.set(fallbackToolCallId, created)
              for (const ref of created) {
                if (typeof ref?.reference === 'string' && ref.reference) {
                  appendToolZipReference(ref.reference)
                }
              }
            }
          }

          const toolResultEvent = await streamAdapter.emitToolResult({
            toolCallId: fallbackToolCallId,
            toolName: emittedToolName,
            args: emittedArgs,
            result: sanitizedResultPayload,
            metadata: toolResult.metadata,
            zipReferences: toolZipReferences,
          })
          if (isImageLikeToolResult) {
            emittedImageToolResultIds.add(fallbackToolCallId)
          }
          const streamedCallId = toolResultEvent.toolCallId
          if (streamedCallId && !streamedToolCallIds.has(streamedCallId)) {
            streamedToolCallIds.add(streamedCallId)
            streamedToolSteps.push({
              toolName: emittedToolName,
              originalToolName: toolResult.toolName,
              toolInput: emittedArgs,
              toolArgs: emittedArgs,
              toolResult: sanitizedResultPayload,
              toolCallId: streamedCallId,
              timestamp: Date.now(),
              ...(resolvedMetadata ?? {}),
              ...(toolResultEvent.metadata ?? {}),
              ...(toolResult.metadata ?? {}),
              error: extractToolResultErrorMessage(sanitizedResultPayload),
              success: inferToolStepSuccess(
                sanitizedResultPayload,
                sanitizedResultPayload !== undefined,
              ),
            })
          }
          await streamAdapter.emitToolEnd({
            toolCallId: streamedCallId,
          })
          break
        }
        case 'raw': {
          const rawChunk = chunk as any
          const extracted = extractUsageFromRawChunk(rawChunk?.rawValue)
          if (extracted) {
            rawUsageFromStream = mergeUsageLike(rawUsageFromStream, extracted)
          }
          const rawReasoning = extractReasoningTextFromRawChunk(
            rawChunk?.rawValue,
          )
          if (showReasoning && rawReasoning) {
            if (!reasoningActive && reasoningCaptured) {
              reasoningCaptured += '\n\n'
              await emitReasoningAppend('\n\n')
            }
            reasoningActive = true
            reasoningCaptured += rawReasoning
            await emitReasoningAppend(rawReasoning)
          }
          break
        }
        case 'error': {
          const errorChunk = chunk as any
          const rawError =
            errorChunk?.error ??
            errorChunk?.value ??
            errorChunk?.data ??
            errorChunk?.cause ??
            null
          let normalizedError: Error
          if (rawError instanceof Error) {
            normalizedError = rawError
          } else {
            const candidateMessage =
              typeof rawError === 'string' && rawError.trim().length > 0
                ? rawError.trim()
                : typeof rawError?.message === 'string' &&
                    rawError.message.trim().length > 0
                  ? rawError.message.trim()
                  : typeof errorChunk?.error === 'string' &&
                      errorChunk.error.trim().length > 0
                    ? errorChunk.error.trim()
                    : 'Stream failed before producing output'
            normalizedError = new Error(candidateMessage)
          }
          streamRuntimeError = normalizedError
          shouldBreakStream = true
          break
        }
        case 'finish': {
          await ensureReasoningSegmentBoundary()
          const finishChunk = chunk as any
          const usage =
            finishChunk.totalUsage || finishChunk.usage || rawUsageFromStream
          if (usage) {
            if (!silentResponse) {
              await ensureStartEmitted()
            }
            await streamAdapter.emitFinish({ usage })
          }
          shouldBreakStream = true
          break
        }
        default:
          break
      }

      if (shouldBreakStream) {
        break
      }
    }

    if (!onFinishResolved) {
      await Promise.race([
        onFinishPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ])
    }

    if (streamRuntimeError) {
      throw streamRuntimeError
    }

    const respondedApprovalIds = new Set(
      toolApprovalResponse
        .map((entry) =>
          typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : '',
        )
        .filter(Boolean),
    )
    const toolApprovalRequests = (
      await extractToolApprovalRequests(result)
    ).filter((entry) => {
      const approvalId =
        typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : ''
      return !approvalId || !respondedApprovalIds.has(approvalId)
    })
    if (toolApprovalRequests.length > 0) {
      const approvalSummary: ToolApprovalSummary = {
        mode: toolApprovalMode,
        approvals: toolApprovalRequests,
        source: 'vercel',
      }
      finishSummary.metadata = {
        ...(finishSummary.metadata ?? {}),
        toolApprovals: approvalSummary,
      }
    } else if (streamedApprovalRequests.size > 0) {
      const pendingStreamedApprovals = Array.from(
        streamedApprovalRequests.values(),
      ).filter((entry) => {
        const approvalId =
          typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : ''
        return !approvalId || !respondedApprovalIds.has(approvalId)
      })
      if (pendingStreamedApprovals.length > 0) {
        const approvalSummary: ToolApprovalSummary = {
          mode: toolApprovalMode,
          approvals: pendingStreamedApprovals,
          source: 'vercel',
        }
        finishSummary.metadata = {
          ...(finishSummary.metadata ?? {}),
          toolApprovals: approvalSummary,
        }
      }
    } else if (respondedApprovalIds.size > 0) {
      // Redis saveMessage merges existing + incoming metadata for same message id.
      // Explicitly clear stale approval cards after a successful response so
      // previously pending entries cannot reappear on refresh.
      finishSummary.metadata = {
        ...(finishSummary.metadata ?? {}),
        toolApprovals: null,
      }
    }

    if (
      !hasUsageValues(lastResolvedUsage) &&
      hasUsageValues(rawUsageFromStream)
    ) {
      const fallbackUsage = rawUsageFromStream as UsageLike
      if (!finishSummary.usage) {
        finishSummary.usage = fallbackUsage
      }

      if (!isCliProvider) {
        try {
          const sanitizedToolSteps = sanitizePayloadForLogs(
            Array.isArray(finishSummary.intermediateSteps)
              ? finishSummary.intermediateSteps
              : [],
          )
          const capture = buildVercelLlmCapture({
            steps: lastStreamSteps ?? [],
            totalUsage: fallbackUsage ?? null,
            finalText: lastStreamText,
          })

          const stepsForCount = Array.isArray(lastStreamSteps)
            ? lastStreamSteps
            : streamedToolSteps
          const toolCallsTotal = stepsForCount.reduce(
            (sum: number, step: any) => {
              const count = Array.isArray(step?.toolCalls)
                ? step.toolCalls.length
                : 0
              return sum + count
            },
            0,
          )

          await executionViewerService.updateSnapshot(sessionId, messageId, {
            llmSummary: capture.llmSummary,
            llmCalls: capture.llmCalls,
            intermediateSteps:
              Array.isArray(sanitizedToolSteps) && sanitizedToolSteps.length > 0
                ? (sanitizedToolSteps as any[])
                : null,
            responseSummary: {
              content: {
                value: finishSummary.content || finishSummary.text || '',
                confidence: 'exact',
              },
              usage: buildTokenUsage(
                fallbackUsage ?? null,
                'near',
                'raw-chunk',
              ),
              toolCallsCount: buildTokenStat(
                toolCallsTotal,
                'exact',
                'vercel ai sdk',
              ),
              notes: [
                'Usage totals sourced from raw stream chunk (provider did not return usage in the finish event).',
              ],
            },
          })
        } catch (viewerPatchError) {
          console.error(
            '[Send-Routed] Failed to backfill execution snapshot usage from raw chunk:',
            viewerPatchError,
          )
        }
      }
    }

    const hasVisibleAssistantOutput =
      Boolean(
        (
          finishSummary.content ||
          finishSummary.text ||
          streamedMessageContent ||
          ''
        ).trim(),
      ) ||
      finishSummary.zipReferences.length > 0 ||
      streamedToolZipReferences.length > 0 ||
      finishSummary.intermediateSteps.length > 0 ||
      streamedToolSteps.length > 0 ||
      streamedApprovalRequests.size > 0 ||
      Boolean(finishSummary.metadata?.toolApprovals)

    if (!silentResponse && !hasVisibleAssistantOutput) {
      const emptyCompletionUsage =
        finishSummary.usage ??
        lastResolvedUsage ??
        rawUsageFromStream ??
        streamAdapter.getUsage() ??
        null
      const typedEmptyCompletionUsage = hasUsageValues(emptyCompletionUsage)
        ? (emptyCompletionUsage as UsageLike)
        : null
      if (!finishSummary.usage && typedEmptyCompletionUsage) {
        finishSummary.usage = typedEmptyCompletionUsage
      }
      const outputTokens = outputTokensForUsage(typedEmptyCompletionUsage)
      const tokenNote =
        outputTokens === 0
          ? ' The provider reported 0 output tokens.'
          : ''
      throw createRoutedInputError(
        `The model provider returned an empty response.${tokenNote}`,
        'PROVIDER_EMPTY_RESPONSE',
        502,
      )
    }

    if (silentResponse) {
      await emitThinkingIndicatorStop()
      await streamAdapter.emitComplete({
        metadata: {
          silent: true,
          ...(controlsMode ? { controlsMode } : {}),
          ...(controlsMode === 'listening'
            ? { silentReason: 'listening' }
            : {}),
        },
      })
    } else {
      await finalizeAssistantMessage('postStream')
      await streamAdapter.emitComplete()
    }

    await persistRuntimeSnapshot('succeeded')

    const response = json({
      success: true,
      messageId,
      silent: silentResponse,
      usage: finishSummary.usage ?? streamAdapter.getUsage(),
    })

    return {
      response,
      messageId,
      content: silentResponse
        ? ''
        : finishSummary.content || finishSummary.text || '',
      metadata: finishSummary.metadata ?? {},
      usage: finishSummary.usage ?? streamAdapter.getUsage(),
    }
  } catch (error: any) {
    console.error('[Send-Routed] Batshit agent streaming error:', error)

    const normalizedErrorMessage =
      error instanceof Error ? error.message : String(error ?? 'Unknown error')
    const localImageFailure = classifyLocalImageUrlRuntimeFailure({
      errorMessage: normalizedErrorMessage,
      providerId: providerIdentifier || null,
      connectionId: connectionIdentifier || null,
    })
    const imageInputFailure = classifyImageInputUnsupportedRuntimeFailure({
      errorMessage: normalizedErrorMessage,
      providerId: providerIdentifier || null,
      modelId: effectiveModelId || null,
    })
    const surfacedErrorMessage =
      localImageFailure?.userMessage ??
      imageInputFailure?.userMessage ??
      normalizedErrorMessage
    const contextExhausted = isContextExhaustionError(normalizedErrorMessage)

    const isAbortError =
      error?.name === 'AbortError' ||
      streamAbortSignal?.aborted === true ||
      request.signal?.aborted === true

    if (isAbortError) {
      const interruptedAt = new Date().toISOString()

      try {
        if (ensureStartEmitted) {
          await ensureStartEmitted()
        }

        if (
          !finishSummary.content &&
          !finishSummary.text &&
          streamedMessageContent
        ) {
          finishSummary.content =
            streamMetadata?.groupChat === true
              ? stripGroupChatPresentationControls(streamedMessageContent)
              : streamedMessageContent
        }

        if (
          finishSummary.zipReferences.length === 0 &&
          streamedToolZipReferences.length > 0
        ) {
          finishSummary.zipReferences = [...streamedToolZipReferences]
        }

        const baseAbortMetadata = {
          model: effectiveModelId ?? primarySelection.modelId,
          agentType: primaryAgentType,
          voice: voiceMetadata,
          selectedTools,
          selectedGateways,
        }

        finishSummary.metadata = {
          ...baseAbortMetadata,
          ...(finishSummary.metadata ?? {}),
          interrupted: true,
          interruptionReason: 'user',
          interruptedAt,
        }

        await finalizeAssistantMessage('error')
        await streamAdapter.emitComplete({
          metadata: {
            interrupted: true,
            interruptedAt,
          },
        })
      } catch (abortFinalizeError) {
        console.error(
          '[Send-Routed] Failed to finalize interrupted stream:',
          abortFinalizeError,
        )
      }

      await persistRuntimeSnapshot('failed', 'Stream interrupted by user')

      return {
        response: json(
          { error: 'Stream interrupted by user' },
          { status: 499 },
        ),
        messageId,
        content: finishSummary.content || finishSummary.text || '',
        metadata: finishSummary.metadata ?? {},
        usage: finishSummary.usage ?? undefined,
      }
    }

    const errorStatus = getFailureStatus(error)
    const errorCode =
      localImageFailure?.code ??
      imageInputFailure?.code ??
      getFailureCode(error) ??
      null
    const failureUsage =
      finishSummary.usage ??
      lastResolvedUsage ??
      rawUsageFromStream ??
      null
    const failureRuntimeMetadata = {
      provider: providerIdentifier || null,
      connection: connectionIdentifier || null,
      model: effectiveModelId || null,
      runtimeId: isCodexProvider
        ? 'codex'
        : isClaudeProvider
          ? 'claude'
          : 'api',
      agentType: primaryAgentType,
      voice: voiceMetadata,
      selectedTools,
      selectedGateways,
      ...(hasUsageValues(failureUsage) ? { usage: failureUsage } : {}),
    }

    // A failed stream must never erase work the user already received. When the
    // run produced any content or tool results before dying (e.g. context-window
    // exhaustion mid-task), finalize the partial message exactly like the
    // user-interrupt path does — content, tool zips, and zipIds intact — and
    // carry the failure in metadata instead of replacing the message body.
    const redactedErrorMessage =
      redactDataImageUrlsInText(surfacedErrorMessage).value || surfacedErrorMessage
    const redactedErrorDetails =
      normalizedErrorMessage && normalizedErrorMessage !== surfacedErrorMessage
        ? redactDataImageUrlsInText(normalizedErrorMessage).value
        : null
    const hasPartialStreamedWork =
      Boolean(streamedMessageContent.trim()) ||
      streamedToolZipReferences.length > 0 ||
      Boolean(finishSummary.content) ||
      Boolean(finishSummary.text) ||
      finishSummary.zipReferences.length > 0

    let partialWorkPersisted = false
    if (hasPartialStreamedWork) {
      try {
        if (ensureStartEmitted) {
          await ensureStartEmitted()
        }

        if (
          !finishSummary.content &&
          !finishSummary.text &&
          streamedMessageContent
        ) {
          finishSummary.content =
            streamMetadata?.groupChat === true
              ? stripGroupChatPresentationControls(streamedMessageContent)
              : streamedMessageContent
        }

        if (
          finishSummary.zipReferences.length === 0 &&
          streamedToolZipReferences.length > 0
        ) {
          finishSummary.zipReferences = [...streamedToolZipReferences]
        }

        finishSummary.metadata = {
          ...(finishSummary.metadata ?? {}),
          ...failureRuntimeMetadata,
          model: effectiveModelId ?? primarySelection.modelId,
          response_failed: true,
          error_message: redactedErrorMessage,
          failed_at: new Date().toISOString(),
          ...(contextExhausted ? { failure_kind: 'context_exhausted' } : {}),
          ...(redactedErrorDetails ? { error_details: redactedErrorDetails } : {}),
          ...(errorCode ? { error_code: errorCode } : {}),
          ...(typeof errorStatus === 'number' ? { http_status: errorStatus } : {}),
        }

        await finalizeAssistantMessage('error')
        partialWorkPersisted = true
      } catch (partialFinalizeError) {
        console.error(
          '[Send-Routed] Failed to finalize partial content for failed stream:',
          partialFinalizeError,
        )
      }
    }

    try {
      await streamAdapter.emitError({
        error: surfacedErrorMessage,
        metadata: {
          provider: providerIdentifier || null,
          connection: connectionIdentifier || null,
          model: effectiveModelId || null,
          ...(localImageFailure || imageInputFailure
            ? { code: (localImageFailure ?? imageInputFailure)?.code }
            : {}),
        },
      })
    } catch (emitError) {
      console.error(
        '[Send-Routed] Failed to broadcast stream error event:',
        emitError,
      )
    }

    if (!partialWorkPersisted) {
      await persistFailedAssistantTurn({
        sessionId,
        userId,
        agentId,
        messageId,
        message: surfacedErrorMessage,
        details: normalizedErrorMessage,
        code: errorCode,
        status: errorStatus,
        metadata: failureRuntimeMetadata,
      })
    }

    if (errorCode === 'PROVIDER_EMPTY_RESPONSE') {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
          {
            error: surfacedErrorMessage,
            code: errorCode,
          },
          { status: errorStatus ?? 502 },
        ),
        messageId,
        content: '',
        metadata: {},
        usage: hasUsageValues(failureUsage)
          ? (failureUsage as UsageLike)
          : undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    if (error instanceof Error && error.message?.includes('API key')) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
        { error: 'AI provider API key not configured for API or CLI agents' },
          { status: 500 },
        ),
        messageId,
        content: '',
        metadata: {},
        usage: undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    if (localImageFailure) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
          {
            error: 'Local image URL rejected by runtime',
            details: surfacedErrorMessage,
            code: localImageFailure.code,
          },
          { status: 422 },
        ),
        messageId,
        content: '',
        metadata: {},
        usage: undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    if (imageInputFailure) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
          {
            error: surfacedErrorMessage,
            details: normalizedErrorMessage,
            code: imageInputFailure.code,
          },
          { status: 422 },
        ),
        messageId,
        content: '',
        metadata: {},
        usage: undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    await persistRuntimeSnapshot('failed', normalizedErrorMessage)
    return {
      response: json(
        {
          error: 'Failed to stream response',
          details: surfacedErrorMessage,
        },
        { status: 500 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
      failureHandled: partialWorkPersisted,
      contextExhausted,
    }
  } finally {
    zipDetection.deleteSessionBuffers(sessionId)
    clearStreamAbort(sessionId, messageId)
    if (visualCleanup) {
      try {
        await visualCleanup()
      } finally {
        await cleanupSessionMonitoring(sessionId)
      }
    }
  }
}

async function handleGroupChatStream({
  content,
  sessionId,
  agent,
  agentId,
  messages,
  metadata,
  batshitInput,
  globalZipSettings,
  voiceState,
  userSettings,
  userDisplayName,
  userId,
  eventFetch,
  request,
  groupConfig,
}: BatshitStreamParams & {
  groupConfig: GroupChatSessionConfig
  userDisplayName?: string
}): Promise<Response> {
  const normalizedConfig = normalizeGroupChatConfig(groupConfig)
  if (!normalizedConfig?.enabled) {
    const result = await handleBatshitAgentStream({
      content,
      sessionId,
      agent,
      agentId,
      messages,
      metadata,
      batshitInput,
      globalZipSettings,
      voiceState,
      userSettings,
      userId,
      eventFetch,
      request,
    })
    return result.response
  }

  await consumePostCompileSessionClips(sessionId)

  const groupAbortController = new AbortController()
  registerGroupAbort(sessionId, groupAbortController)

  try {
    const allAgents = await redis.getAgents(userId)
    const agentById = new Map(allAgents.map((row) => [row.id, row]))
    const maxAgents =
      normalizedConfig.max_agents ?? GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4
    const uniqueAgentIds = Array.from(
      new Set(normalizedConfig.agent_ids),
    ).slice(0, maxAgents)

    const groupAgents = uniqueAgentIds
      .map((id) => agentById.get(id))
      .filter((row): row is AgentRow => Boolean(row))

    if (!groupAgents.some((row) => row.id === agentId)) {
      groupAgents.unshift(agent)
      if (groupAgents.length > maxAgents) {
        groupAgents.pop()
      }
    }

    const eligibleAgents = groupAgents.filter((row) =>
      isManagedPrimaryAgentType(normalizePrimaryAgentType(row)),
    )

    if (eligibleAgents.length < 2) {
      return json(
        { error: 'Group chat requires at least 2 API or CLI agents.' },
        { status: 400 },
      )
    }

    const groupTurnId = crypto.randomUUID()
    const maxFollowupsTotal =
      normalizedConfig.max_followups_total ??
      GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ??
      5
    const driverMode = normalizedConfig.driver_mode === true
    const driverAgentId =
      driverMode &&
      normalizedConfig.driver_agent_id &&
      eligibleAgents.some((row) => row.id === normalizedConfig.driver_agent_id)
        ? normalizedConfig.driver_agent_id
        : driverMode
          ? (eligibleAgents[0]?.id ?? null)
          : null
    const resolvedUserName = userDisplayName?.trim() || userId
    const agentOrder = eligibleAgents.map((row) => row.id)
    const agentDisplayNames = Object.fromEntries(
      eligibleAgents.map((row) => [row.id, row.displayName || row.id]),
    )
    const speakPolicies: Record<
      string,
      { speak_policy: GroupChatSpeakPolicy; speak_topics: string[] }
    > = {}
    for (const agentRow of eligibleAgents) {
      const settings = normalizedConfig.agent_settings?.[agentRow.id] ?? {}
      speakPolicies[agentRow.id] = {
        speak_policy: (settings.speak_policy ??
          'balanced') as GroupChatSpeakPolicy,
        speak_topics: Array.isArray(settings.speak_topics)
          ? settings.speak_topics
          : [],
      }
    }
    const groupContextBase = {
      agentOrder,
      agentDisplayNames,
      currentAgentId: null,
      userDisplayName: resolvedUserName,
      speakPolicies,
      driverMode,
      driverAgentId,
      maxFollowupsTotal,
    }
    const normalizeSharedTools = (value: unknown) => {
      if (!Array.isArray(value)) return []
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    }

    const groupSharedTools = normalizeSharedTools(normalizedConfig.shared_tools)
    const sharedGlobalZipSettings = globalZipSettings

    const fullMessages = Array.isArray(messages) ? messages : []
    const baseHistoryMessages = fullMessages.slice(0, -1)
    const initialUserMessage = fullMessages[fullMessages.length - 1] ?? {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      session_id: sessionId,
      agent_id: agentId,
      user_id: userId,
      created_at: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    }

    const assistantHistory: ChatMessage[] = []

    const sanitizeGroupHistoryMessage = (message: ChatMessage): ChatMessage => {
      if (message?.role !== 'assistant') return message
      const rawContent = typeof message.content === 'string' ? message.content : ''
      const cleanedContent = stripGroupChatPresentationControls(rawContent)
      return cleanedContent === rawContent ? message : { ...message, content: cleanedContent }
    }

    type GroupChatEvent = {
      type: 'user' | 'agent'
      content: string
      eventIndex: number
      sourceAgentId?: string
      sourceAgentName?: string
    }

    const pendingEvents: GroupChatEvent[] = [
      { type: 'user', content, eventIndex: 1 },
    ]
    let totalFollowups = 0
    let scheduledFollowups = 0
    let eventIndex = 1
    let queueRunning = false

    const buildHistoryMessages = () => [
      ...baseHistoryMessages.map(sanitizeGroupHistoryMessage),
      initialUserMessage,
      ...assistantHistory,
    ]

    const buildEventPrompt = (event: GroupChatEvent) =>
      event.type === 'user'
        ? event.content
        : buildInterAgentPrompt({
            sourceAgentName: event.sourceAgentName,
            message: event.content,
          })

    const canScheduleFollowup = () => {
      if (maxFollowupsTotal <= 0) {
        return true
      }
      if (maxFollowupsTotal > 0 && totalFollowups >= maxFollowupsTotal) {
        return false
      }
      if (
        maxFollowupsTotal > 0 &&
        totalFollowups + scheduledFollowups >= maxFollowupsTotal
      ) {
        return false
      }
      return true
    }

    const scheduleEvent = async (event: GroupChatEvent) => {
      if (groupAbortController.signal.aborted) {
        return
      }

      const historyMessages = buildHistoryMessages()
      const eventPrompt = buildEventPrompt(event)

      const assistantContextText = assistantHistory
        .map((message) => message.content)
        .filter(Boolean)
        .join('\n\n')

      const candidates: Array<{
        agent: AgentRow
        agentName: string
        speakPolicy: GroupChatSpeakPolicy
        speakTopics: string[]
        isDriver: boolean
        isFollowupEvent: boolean
      }> = []

      for (const agentRow of eligibleAgents) {
        if (event.type === 'agent' && event.sourceAgentId === agentRow.id) {
          continue
        }

        const isFollowupEvent = event.type === 'agent'
        const policyRecord = speakPolicies[agentRow.id] ?? {
          speak_policy: 'balanced' as GroupChatSpeakPolicy,
          speak_topics: [],
        }
        const speakPolicy = policyRecord.speak_policy
        const speakTopics = policyRecord.speak_topics
        const agentName = agentRow.displayName || agentRow.id
        const isDriver = driverMode && driverAgentId === agentRow.id

        const topicContext = [eventPrompt, assistantContextText]
          .filter(Boolean)
          .join('\n\n')
        if (!isDriver) {
          if (
            speakPolicy === 'only_when_asked' &&
            !isAgentAddressed(topicContext, agentName, [
              agentRow.id,
              agentRow.slug ?? '',
            ])
          ) {
            continue
          }
          if (
            speakPolicy === 'topic_only' &&
            !matchesTopic(topicContext, speakTopics)
          ) {
            continue
          }
        }
        if (isFollowupEvent && !canScheduleFollowup()) {
          continue
        }

        candidates.push({
          agent: agentRow,
          agentName,
          speakPolicy,
          speakTopics,
          isDriver,
          isFollowupEvent,
        })
      }

      if (candidates.length === 0) return

      const pickRandom = <T>(list: T[]) => list[randomInt(list.length)]
      let selected = candidates.length === 1 ? candidates[0] : null

      if (!selected && event.type === 'user') {
        const addressed = candidates.filter((candidate) =>
          isAgentAddressed(eventPrompt, candidate.agentName, [
            candidate.agent.id,
            candidate.agent.slug ?? '',
          ]),
        )
        if (addressed.length === 1) {
          selected = addressed[0]
        }
      }

      const driverCandidate =
        driverMode && driverAgentId
          ? (candidates.find(
              (candidate) => candidate.agent.id === driverAgentId,
            ) ?? null)
          : null

      if (!selected && driverCandidate) {
        selected = driverCandidate
      }

      if (!selected) {
        selected = pickRandom(candidates)
      }

      const agentRow = selected.agent
      const agentName = selected.agentName
      const speakPolicy = selected.speakPolicy
      const speakTopics = selected.speakTopics
      const isDriver = selected.isDriver
      const isFollowupEvent = selected.isFollowupEvent
      const selectedMessageId =
        (await generateMessageId(sessionId)) ?? `msg_${crypto.randomUUID()}`

      const perAgentMetadata = {
        ...(metadata ?? {}),
        agent: agentRow,
      }
      const groupPromptRaw = normalizedConfig.group_system_prompt?.trim()
      const groupPromptBlock = groupPromptRaw
        ? `==== GROUP CHAT CUSTOM PROMPT ====\n\n${replacePromptVariables(
            groupPromptRaw,
            agentRow,
          )}`.trim()
        : null
      const systemPromptAddendum = [
        groupPromptBlock,
        buildGroupSystemPromptAddendum({
          agentName,
          policy: speakPolicy,
          topics: speakTopics,
          eventIndex: event.eventIndex,
          driverMode,
          driverAgentName: driverAgentId
            ? (eligibleAgents.find((row) => row.id === driverAgentId)
                ?.displayName ?? driverAgentId)
            : null,
          isDriver,
        }),
      ]
        .filter(Boolean)
        .join('\n\n')

      const syntheticUserMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: eventPrompt,
        session_id: sessionId,
        agent_id: agentRow.id,
        user_id: userId,
        created_at: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        metadata: {
          group_turn_id: groupTurnId,
          group_event_index: event.eventIndex,
          group_event_type: event.type,
        },
      }

      const agentMessages = [...historyMessages, syntheticUserMessage]

      const streamMetadata = {
        groupChat: true,
        groupTurnId,
        group_turn_id: groupTurnId,
        eventIndex: event.eventIndex,
        group_event_index: event.eventIndex,
        groupLayout: normalizedConfig.layout,
        group_layout: normalizedConfig.layout,
        speakPolicy,
        speakTopics,
        eventType: event.type,
        eventSourceAgentId: event.sourceAgentId ?? null,
        eventSourceAgentName: event.sourceAgentName ?? null,
        driverMode,
        driverAgentId,
        driver_mode: driverMode,
        driver_agent_id: driverAgentId,
      }

      if (isFollowupEvent) {
        scheduledFollowups += 1
      }

      const groupContext = {
        ...groupContextBase,
        currentAgentId: agentRow.id,
      }

      const databaseService = new DatabaseService(eventFetch)
      const sharedHistory = await databaseService.prepareGroupHistory(
        sessionId,
        historyMessages,
        agentRow,
        userId,
        {
          fetch: eventFetch,
          groupContext,
          groupToolSharing: {
            currentAgentId: agentRow.id,
            sharedTools: groupSharedTools,
          },
        },
      )
      const sharedZipSettings =
        sharedHistory.globalZipSettings ?? sharedGlobalZipSettings

      const streamPromise = handleBatshitAgentStream({
        content: eventPrompt,
        sessionId,
        agent: agentRow,
        agentId: agentRow.id,
        messageId: selectedMessageId,
        messages: agentMessages,
        metadata: perAgentMetadata,
        batshitInput,
        abortSignal: groupAbortController.signal,
        globalZipSettings: sharedZipSettings,
        precompiledHistory: sharedHistory,
        streamMetadata,
        systemPromptAddendum,
        groupContext,
        voiceState,
        userSettings,
        userId,
        eventFetch,
        request,
        consumeSessionClips: false,
      })

      try {
        const result = await streamPromise
        const groupContent = stripGroupChatPresentationControls(result?.content ?? '')
        if (groupContent.trim()) {
          assistantHistory.push({
            id: result.messageId,
            session_id: sessionId,
            user_id: userId,
            agent_id: result.metadata?.agentId ?? agentId,
            role: 'assistant',
            content: groupContent,
            created_at: new Date().toISOString(),
            metadata: result.metadata,
          })

          if (isFollowupEvent) {
            totalFollowups += 1
          }

          if (maxFollowupsTotal <= 0 || totalFollowups < maxFollowupsTotal) {
            eventIndex += 1
            pendingEvents.push({
              type: 'agent',
              content: groupContent,
              eventIndex,
              sourceAgentId: agentRow.id,
              sourceAgentName: agentName,
            })
          }
        }
      } catch (error) {
        console.warn('[GroupChat] Agent stream failed.', {
          agentId: agentRow.id,
          agentName,
          messageId: selectedMessageId,
          error,
        })
        if (!groupAbortController.signal.aborted) {
          await persistFailedAssistantTurn({
            sessionId,
            userId,
            agentId: agentRow.id,
            messageId: selectedMessageId,
            message: getFailureMessage(error),
            details:
              error instanceof Error
                ? error.stack || error.message
                : String(error ?? ''),
            code: getFailureCode(error),
            status: getFailureStatus(error),
            metadata: {
              agentType: normalizePrimaryAgentType(agentRow),
              groupChat: true,
              groupTurnId,
              group_turn_id: groupTurnId,
              group_event_index: event.eventIndex,
              eventType: event.type,
              failedSpeakerAgentId: agentRow.id,
              failedSpeakerName: agentName,
            },
          })
        }
      } finally {
        if (isFollowupEvent) {
          scheduledFollowups = Math.max(0, scheduledFollowups - 1)
        }
      }
    }

    const drainQueue = async () => {
      if (queueRunning) return
      queueRunning = true
      while (pendingEvents.length > 0) {
        if (groupAbortController.signal.aborted) {
          break
        }
        const nextEvent = pendingEvents.shift()
        if (nextEvent) {
          await scheduleEvent(nextEvent)
        }
      }
      queueRunning = false
    }

    await drainQueue()

    return json({
      success: true,
      groupTurnId,
      eventsProcessed: eventIndex,
      followupsCompleted: totalFollowups,
    })
  } finally {
    clearGroupAbort(sessionId)
  }
}

export const POST: RequestHandler = async ({
  request,
  fetch: eventFetch,
  locals,
}) => {
  try {
    const body = await request.json()
    const {
      content: rawContent,
      sessionId,
      agentId,
      messageId: requestedMessageId = null,
      messages,
      agentType, // Story 6.8d: Extract agentType instead of mode
      webhookUrl,
      batshitInput = null,
      metadata = null,
      userId: requestedUserId = null,
    } = body
    let content =
      typeof rawContent === 'string'
        ? neutralizeAllZipReferenceSyntax(rawContent)
        : rawContent

    const internalRequest = isTrustedInternalRequest(request)
    const internalUserId =
      internalRequest && typeof requestedUserId === 'string'
        ? requestedUserId.trim()
        : ''
    const resolvedUserId = locals.user?.id ?? internalUserId

    if (!resolvedUserId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    const approvalResponse = normalizeToolApprovalResponses(
      metadata?.toolApprovalResponse ?? metadata?.tool_approval_response,
    )
    const hasApprovalResponse = approvalResponse.length > 0
    let approvalResponseForStream = approvalResponse

    if ((!content && !hasApprovalResponse) || !sessionId || !agentId) {
      return json(
        {
          error:
            'Missing required fields: content (or tool approval response), sessionId, and agentId are required',
        },
        { status: 400 },
      )
    }

    // Get the agent to verify ownership and get agentType
    // Use Redis directly instead of DatabaseService to avoid circular API calls
    const agents = await redis.getAgents(resolvedUserId)
    const agent = agents.find((a) => a.id === agentId)

    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    if (agent.user_id !== resolvedUserId) {
      return json({ error: 'Unauthorized to use this agent' }, { status: 403 })
    }

    let globalZipSettings: Record<string, any> | undefined
    let userDisplayName: string | undefined
    let userSettings: UserSettingsRow | null = null
    try {
      userSettings = await redis.getUserSettings(resolvedUserId)
      globalZipSettings = userSettings?.global_zip_settings || undefined
      userDisplayName =
        typeof userSettings?.displayName === 'string'
          ? userSettings.displayName.trim()
          : undefined
    } catch (error) {
      console.error('[send-routed] Failed to load user zip settings:', error)
    }

    // Story 6.8d: Use agentType from request or fall back to agent's agentType (default: n8n)
    const finalAgentType = normalizePrimaryAgentType(agent, agentType)

    // Load session metadata for group chat configuration
    const session = await redis.getSession(sessionId)
    if (!session || session.user_id !== resolvedUserId) {
      return json(
        { error: 'Session not found or unauthorized' },
        { status: 404 },
      )
    }
    if (typeof content === 'string') {
      content = neutralizeUntrustedClipReferenceSyntax(content, {
        trustedClipIds: await collectTrustedClipIdsForSession(sessionId, metadata),
      })
    }
    const rawGroupMeta = session?.metadata?.group_chat ?? null
    let groupConfig: GroupChatSessionConfig | null = null
    const groupId =
      rawGroupMeta &&
      typeof rawGroupMeta === 'object' &&
      typeof rawGroupMeta.group_id === 'string'
        ? rawGroupMeta.group_id
        : null

    if (groupId) {
      const group = await redis.getGroup(groupId)
      if (group && group.user_id === resolvedUserId) {
        groupConfig = normalizeGroupChatConfig({
          enabled: true,
          agent_ids: group.agent_ids,
          agent_settings: group.agent_settings,
          group_system_prompt: group.group_system_prompt,
          max_followups_total: group.max_followups_total,
          max_agents: group.max_agents,
          driver_mode: group.driver_mode,
          driver_agent_id: group.driver_agent_id,
          shared_tools: group.shared_tools,
          zip_settings: group.zip_settings,
        })
      }
    }

	    let n8nPrimaryRunRegistered = false
	    const sessionTurnKind = groupConfig ? 'group' : 'single'
    const activeSessionTurn = getActiveSessionTurn(sessionId)
    if (activeSessionTurn) {
      return json(
        {
          error: 'Another response is already in progress for this session.',
          code: 'session_turn_in_progress',
          details:
            activeSessionTurn.kind === 'group'
              ? 'A group-chat turn is still running for this chat.'
              : 'A response is still running for this chat.',
        },
        { status: 409 },
      )
    }

    const sessionTurnRegistration = registerSessionTurn(
      sessionId,
      sessionTurnKind,
      typeof requestedMessageId === 'string' && requestedMessageId.trim().length > 0
        ? requestedMessageId.trim()
        : null,
    )
	    if (!sessionTurnRegistration.ok) {
	      return json(
        {
          error: 'Another response is already in progress for this session.',
          code: 'session_turn_in_progress',
          details:
            sessionTurnRegistration.existing.kind === 'group'
              ? 'A group-chat turn is still running for this chat.'
              : 'A response is still running for this chat.',
        },
        { status: 409 },
	      )
	    }

	    if (isN8nPrimaryAgentType(finalAgentType)) {
	      const n8nPrimaryRegistration = registerN8nPrimaryRun({
	        userId: resolvedUserId,
	        sessionId,
	        messageId: typeof requestedMessageId === 'string' ? requestedMessageId : null,
	        agentId,
	      })
	      if (!n8nPrimaryRegistration.ok) {
	        clearSessionTurn(sessionId)
	        return json(
	          {
	            error: 'An n8n agent is already running in another chat.',
	            code: 'n8n_primary_in_progress',
	            details:
	              'n8n Primary Agent chats need to run by themselves right now. Stop or finish the active chat first, then send this n8n message.',
	            activeRun: n8nPrimaryRegistration.existing,
	          },
	          { status: 409 },
	        )
	      }
	      n8nPrimaryRunRegistered = true
	    }

    try {
      try {
        const sandboxCleanupWarnings =
          await nativeToolService.cleanupExecutionSandboxesForSession(sessionId)
        if (sandboxCleanupWarnings.length > 0) {
          console.warn(
            '[Send-Routed] sandbox pre-run cleanup warnings:',
            {
              sessionId,
              warnings: sandboxCleanupWarnings,
            },
          )
        }
      } catch (sandboxCleanupError) {
        console.error(
          '[Send-Routed] sandbox pre-run cleanup failed:',
          sandboxCleanupError,
        )
      }

      const hasUserTurnContent =
        (typeof content === 'string' && content.trim().length > 0) ||
        (Array.isArray(content) && content.length > 0) ||
        (content != null &&
          typeof content !== 'string' &&
          !Array.isArray(content))

      let approvalTimeoutNotices: ApprovalStateSnapshot['newlyExpired'] = []
      let expiredApprovalNoticesFromResponses: Array<{
        approvalId: string
        toolName?: string
        expiredAt: string
        timeoutSeconds: number
      }> = []

      if (
        isManagedPrimaryAgentType(finalAgentType) &&
        (hasApprovalResponse || hasUserTurnContent)
      ) {
        let persistedMessages: ChatMessage[] = []
        try {
          persistedMessages = await redis.getMessages(sessionId, 300)
        } catch (error) {
          console.warn(
            '[Send-Routed] Failed to load persisted messages for approval timeout checks',
            {
              sessionId,
              error,
            },
          )
        }

        const approvalHistoryMessages = buildApprovalHistoryMessages(
          Array.isArray(messages) ? messages : [],
          persistedMessages,
        )
        const approvalState = analyzeApprovalState(approvalHistoryMessages)
        approvalTimeoutNotices = approvalState.newlyExpired

        if (approvalState.updates.length > 0) {
          for (const update of approvalState.updates) {
            try {
              await redis.updateMessage(
                update.messageId,
                sessionId,
                { metadata: update.metadata },
                resolvedUserId,
              )
            } catch (error) {
              console.warn(
                '[Send-Routed] Failed to persist expired approval metadata update',
                {
                  sessionId,
                  messageId: update.messageId,
                  error,
                },
              )
            }
          }
        }

        if (hasApprovalResponse) {
          const expiredApprovalRecordMap = new Map<
            string,
            { approvalId: string; toolName?: string; expiresAt?: string }
          >()

          for (const response of approvalResponse) {
            const approvalId =
              typeof response.approvalId === 'string'
                ? response.approvalId.trim()
                : ''
            if (!approvalId) continue
            const record = approvalState.byId.get(approvalId)
            if (!record || record.status !== 'expired') continue
            expiredApprovalRecordMap.set(approvalId, {
              approvalId,
              toolName: record.toolName,
              expiresAt: record.expiresAt,
            })
          }

          const expiredApprovalRecords = Array.from(
            expiredApprovalRecordMap.values(),
          )
          expiredApprovalNoticesFromResponses = expiredApprovalRecords.map(
            (entry) => ({
              approvalId: entry.approvalId,
              toolName: entry.toolName,
              expiredAt: new Date().toISOString(),
              timeoutSeconds: TOOL_APPROVAL_TIMEOUT_SECONDS,
            }),
          )

          if (expiredApprovalRecordMap.size > 0) {
            approvalResponseForStream = approvalResponse.map((entry) => {
              const approvalId =
                typeof entry.approvalId === 'string'
                  ? entry.approvalId.trim()
                  : ''
              if (!approvalId || !expiredApprovalRecordMap.has(approvalId)) {
                return entry
              }

              return {
                ...entry,
                approved: false,
                reason: 'Approval expired after 3 minutes',
              }
            })
          }

          const hasLateApproveAttempt = approvalResponse.some((entry) => {
            const approvalId =
              typeof entry.approvalId === 'string'
                ? entry.approvalId.trim()
                : ''
            if (!approvalId) return false
            return (
              expiredApprovalRecordMap.has(approvalId) &&
              entry.approved === true
            )
          })

          if (hasLateApproveAttempt) {
            console.warn(
              '[Send-Routed] Late approval converted to deny due to timeout',
              {
                sessionId,
                agentId,
                expiredApprovalIds: expiredApprovalRecords.map(
                  (entry) => entry.approvalId,
                ),
              },
            )
          }
        }
      }

      const expiredToolApprovalsForAddendum = (() => {
        const combined = [
          ...approvalTimeoutNotices,
          ...expiredApprovalNoticesFromResponses,
        ]
        if (combined.length === 0) return []
        const byId = new Map<string, (typeof combined)[number]>()
        for (const entry of combined) {
          if (!entry?.approvalId) continue
          byId.set(entry.approvalId, entry)
        }
        return Array.from(byId.values())
      })()

      const metadataForStream =
        isManagedPrimaryAgentType(finalAgentType)
          ? {
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              ...(hasApprovalResponse
                ? { toolApprovalResponse: approvalResponseForStream }
                : {}),
              ...(expiredToolApprovalsForAddendum.length > 0
                ? { expiredToolApprovals: expiredToolApprovalsForAddendum }
                : {}),
            }
          : metadata
      const resolvedVoiceState =
        isManagedPrimaryAgentType(finalAgentType)
          ? await (async () => {
              const resolvedVoiceConfig = await resolveVoiceConfigForMetadata({
                userSettings,
                agent,
                metadata: metadataForStream ?? metadata,
              })
              const tts = Boolean(
                (metadataForStream as Record<string, any> | null | undefined)
                  ?.tts ??
                metadata?.tts ??
                false,
              )
              const stt = Boolean(
                (metadataForStream as Record<string, any> | null | undefined)
                  ?.stt ??
                metadata?.stt ??
                false,
              )
              const guidance = resolvedUserId
                ? await buildVoiceRuntimeGuidanceForProvider(
                    resolvedUserId,
                    resolvedVoiceConfig.provider,
                    userSettings?.voice_settings,
                  )
                : []
              return {
                stt,
                tts,
                voiceMode: ((
                  metadataForStream as Record<string, any> | null | undefined
                )?.voiceMode ??
                  metadata?.voiceMode ??
                  (tts ? 'voice' : 'text')) as string,
                provider: resolvedVoiceConfig.provider ?? undefined,
                guidance: guidance.length > 0 ? guidance : undefined,
              }
            })()
          : undefined

      // API and CLI agents use the managed streaming path.
      if (isManagedPrimaryAgentType(finalAgentType)) {
        const hasGroupConfig = Boolean(
          groupConfig &&
          Array.isArray(groupConfig.agent_ids) &&
          groupConfig.agent_ids.length >= 2,
        )
        const shouldUseGroup = hasGroupConfig

        if (shouldUseGroup && groupConfig) {
          return await handleGroupChatStream({
            content,
            sessionId,
            agent,
            agentId,
            messages: Array.isArray(messages) ? messages : [],
            metadata: metadataForStream,
            batshitInput,
            globalZipSettings,
            voiceState: resolvedVoiceState,
            userSettings,
            userDisplayName,
            userId: resolvedUserId,
            eventFetch,
            request,
            groupConfig,
          })
        }

        const managedAssistantMessageId =
          typeof requestedMessageId === 'string' &&
          requestedMessageId.trim().length > 0
            ? requestedMessageId.trim()
            : undefined
        try {
          let streamResult = await handleBatshitAgentStream({
            content,
            sessionId,
            agent,
            agentId,
            messageId: managedAssistantMessageId,
            messages: Array.isArray(messages) ? messages : [],
            metadata: metadataForStream,
            batshitInput,
            globalZipSettings,
            voiceState: resolvedVoiceState,
            userSettings,
            userId: resolvedUserId,
            eventFetch,
            request,
          })

          // Auto-continue after mid-run context-window exhaustion: the failed
          // run's partial message (content + tool zips) is already finalized in
          // history, so a fresh run — recompiled from persisted history where
          // tool results live as compact zip refs — can pick the task back up.
          // Bounded by MAX_CONTEXT_CONTINUATIONS per user request; single-agent
          // managed sends only (group chat keeps its own turn semantics).
          let continuationAttempt = 0
          while (
            streamResult.contextExhausted === true &&
            streamResult.failureHandled === true &&
            continuationAttempt < MAX_CONTEXT_CONTINUATIONS &&
            request.signal?.aborted !== true
          ) {
            continuationAttempt++
            const previousMessageId = streamResult.messageId
            logger.debug(
              '[Send-Routed] Auto-continuing after context-window exhaustion',
              {
                sessionId,
                agentId,
                attempt: continuationAttempt,
                maxAttempts: MAX_CONTEXT_CONTINUATIONS,
                previousMessageId,
              },
            )

            let persistedHistory: ChatMessage[] = []
            try {
              persistedHistory = await redis.getMessages(sessionId, 300)
            } catch (historyError) {
              console.error(
                '[Send-Routed] Auto-continue stopped: could not reload persisted history',
                { sessionId, error: historyError },
              )
              break
            }

            const baseContinuationMetadata = (() => {
              if (!metadataForStream || typeof metadataForStream !== 'object') {
                return {}
              }
              const {
                toolApprovalResponse: _approvals,
                tool_approval_response: _approvalsSnake,
                expiredToolApprovals: _expired,
                interruption: _interruption,
                ...rest
              } = metadataForStream as Record<string, any>
              return rest
            })()

            streamResult = await handleBatshitAgentStream({
              content: '',
              sessionId,
              agent,
              agentId,
              messages: persistedHistory,
              metadata: {
                ...baseContinuationMetadata,
                contextContinuation: {
                  attempt: continuationAttempt,
                  maxAttempts: MAX_CONTEXT_CONTINUATIONS,
                  previousMessageId,
                },
              },
              batshitInput,
              globalZipSettings,
              voiceState: resolvedVoiceState,
              userSettings,
              userId: resolvedUserId,
              eventFetch,
              request,
              consumeSessionClips: false,
            })
          }

          if (
            !streamResult.response.ok &&
            streamResult.response.status !== 499 &&
            streamResult.failureHandled !== true
          ) {
            const failurePayload = await extractFailurePayload(
              streamResult.response,
            )
            await persistFailedAssistantTurn({
              sessionId,
              userId: resolvedUserId,
              agentId,
              messageId: streamResult.messageId || managedAssistantMessageId,
              message: failurePayload.message,
              details: failurePayload.details,
              code: failurePayload.code,
              status: streamResult.response.status,
              metadata: {
                agentType: finalAgentType,
              },
            })
          }
          return streamResult.response
        } catch (streamError) {
          const isAbortError =
            (streamError as any)?.name === 'AbortError' ||
            request.signal?.aborted === true
          if (!isAbortError) {
            await persistFailedAssistantTurn({
              sessionId,
              userId: resolvedUserId,
              agentId,
              messageId: managedAssistantMessageId,
              message: getFailureMessage(streamError),
              details:
                streamError instanceof Error
                  ? streamError.stack || streamError.message
                  : String(streamError ?? ''),
              code: getFailureCode(streamError),
              status: getFailureStatus(streamError),
              metadata: {
                agentType: finalAgentType,
              },
            })
          }
          throw streamError
        }
      }

      const rawN8nWebhookUrl = webhookUrl || agent.webhook_url
      let routedN8nWebhookUrl = rawN8nWebhookUrl
      let n8nRuntimeBaseUrl: string | null = null
      if (rawN8nWebhookUrl) {
        let savedN8nApiUrl: string | null = null
        try {
          savedN8nApiUrl = await apiKeyService.retrieve(
            'n8n_api_url',
            resolvedUserId,
          )
        } catch (error) {
          console.warn('[send-routed] Failed to load n8n API URL', error)
        }
        n8nRuntimeBaseUrl = resolveRuntimeN8nBaseUrl(savedN8nApiUrl)
        routedN8nWebhookUrl = rewriteLoopbackUrlForRuntimeBase(
          rawN8nWebhookUrl,
          n8nRuntimeBaseUrl,
        )
      }

      const routedBatshitInput = rewriteBatshitCallbackUrlsForN8nRuntime(
        batshitInput,
        n8nRuntimeBaseUrl,
      )

      await consumePostCompileSessionClips(sessionId)

      // n8n Primary Agents use the existing non-streaming router path.
      const result = await messageRouter.route({
        sessionId,
        agentId,
        agent, // Pass the full agent object (Story 6.8d - router needs agentType field)
        messages: messages as ChatMessage[],
        webhookUrl: routedN8nWebhookUrl,
        batshitInput: routedBatshitInput,
      })

      if (!result.success) {
        return json(
          {
            error: result.error || 'Failed to process message',
            agentType: result.agentType,
          },
          { status: 500 },
        )
      }

      return json({
        success: true,
        data: result.data,
        agentType: result.agentType,
        message: 'Message routed successfully',
      })
    } finally {
      try {
        const sandboxCleanupWarnings =
          await nativeToolService.cleanupExecutionSandboxesForSession(sessionId)
        if (sandboxCleanupWarnings.length > 0) {
          console.warn(
            '[Send-Routed] sandbox post-run cleanup warnings:',
            {
              sessionId,
              warnings: sandboxCleanupWarnings,
            },
          )
        }
      } catch (sandboxCleanupError) {
        console.error(
          '[Send-Routed] sandbox post-run cleanup failed:',
          sandboxCleanupError,
        )
      }
	      clearSessionTurn(sessionId)
	      if (n8nPrimaryRunRegistered) {
	        clearN8nPrimaryRun(resolvedUserId, sessionId)
	      }
	    }
  } catch (error) {
    console.error('Error in send-routed endpoint:', error)
    const status =
      typeof (error as any)?.status === 'number' &&
      Number.isFinite((error as any).status)
        ? (error as any).status
        : 500
    const details = error instanceof Error ? error.message : String(error)
    const code =
      typeof (error as any)?.code === 'string' ? (error as any).code : null
    const errorMessage = status >= 500 ? 'Failed to send message' : details

    return json(
      {
        error: errorMessage,
        ...(code ? { code } : {}),
        details,
      },
      { status },
    )
  }
}
