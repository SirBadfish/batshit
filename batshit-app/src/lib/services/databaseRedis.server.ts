import { createSkillDcmUpdate, type SkillDcmUpdate } from '$lib/server/services/skillDcmUpdate'
import { classifyStoredSkillReadZip } from '$lib/utils/skillReadZip'
import { readOpenSkillSessions, previewOpenSkillSessions, readSkillSessionRecordForCompile, projectSkillSessionsForPendingMessage } from '$lib/server/services/skillSessions'
import { recoverOpenSkillReadMessages } from '$lib/server/services/skillSessionCompile'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import { buildOpenSkillsDcmLines, type OpenSkillSession } from '$lib/utils/skillSessions'
import { buildOpenSkillContext, replaceOpenSkillSectionBody, replaceOpenSkillSectionInDcm } from '$lib/server/services/openSkillContext'
// Database service for Redis operations - Re-export layer
// Maintains the existing API while delegating to focused service clients.

// Import focused service clients and remaining store facades.
import { sessionApiClient } from './sessionApiClient'
import { messageApiClient } from './messageApiClient'
import { agentStore } from './agentStore'
import { slashCommandStore } from './slashCommandStore'
import { userStore, type DeleteFolderOptions } from './userStore'
import { redis } from '$lib/server/redis'
import { agentSetupCache, renderAgentSetup, renderSetupChanges, setupMetadata, setupTokenEstimate, type AgentSetupBlock, type LiveAgentSetup, type PreparedAgentSetup } from '$lib/server/services/agentSetupCache'
import { assertSettingsLifecycle, captureSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { readPackagedCoreSystemPromptDefault } from '$lib/server/services/systemPromptRegistry'
import {
  type AgentSlashCapability,
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities
} from '$lib/server/services/slashCommandCapabilities'
import { isRetiredSubagentType, normalizeSubagentType } from '$lib/utils/subagentType'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { countOneMoreMessage, createZipStateView, type UnzippedItem, type ZipStateView } from '$lib/services/zipping'

// Import types
import type { ChatSessionRow, ChatMemoryRow, AgentRow, UserSettingsRow, ClipRow, SessionClipRow, ChatFolderRow, SubagentRow } from '$lib/types/database'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'
import type { DesktopGoonPresentationMode } from '$lib/goons/desktopGoonPresentation'
import type { Message } from '$lib/stores/messages.svelte'
import type { GroupChatAgentSettings } from '$lib/types/groupChat'
import {
  buildPreservedReasoningHistory,
  collectDeadCopyToolResults,
  collectLiveReadCandidates,
  compileForAI,
  type CompileDeadCopy,
  type ZipCompression,
  type ZipExposed,
  type ZipExposure
} from '$lib/services/messageCompiler'
import { replaceAddressSourceRanges, materializeAddressSources, type PositionedAddressSource } from '$lib/utils/addressSourceRanges'
import {
  describeDeadCopiesCompressedThisTurn,
  findDeadCopies,
  type DeadCopyFile,
  type DeadCopyReason
} from '$lib/utils/zipDeadCopies'
import { classifyToolResultSize, type ToolResultSizeGuard } from '$lib/utils/toolResultSizeGuard'
import { describeUnzippedItemForDcm, isAgentHold } from '$lib/utils/zipHoldWords'
import { normalizeId } from '$lib/utils/idNormalizer'
import { replacePromptVariables } from '$lib/utils/promptVariables'
import { createReference, extractAllReferences } from '$lib/services/universalResolver'
import { buildFileReferenceBlock, type FileReferencePayload } from '$lib/utils/fileMentions'
import {
  type DynamicMcpDiscoverableRef, type DynamicMcpIndexResult, buildDynamicMcpIndex } from '$lib/server/services/dynamicMcpIndex'
import { readApiUtilities, type ApiUtilityScope } from '$lib/server/services/apiUtilityRuntime'
import { API_UTILITY_CONTROL_IDS } from '$lib/utils/apiUtilityControls'
import {
  buildGoonDcmLines as formatGoonDcmLines,
  shouldIncludeGoonSpokenCues
} from '$lib/goons/dcm'
import {
  buildDmGuidancePromptBlock,
  buildDynamicMcpPromptBlock,
  buildJevJuiceGuidancePromptBlock,
  buildMemoryPromptBlock,
  buildSubagentGuidancePromptBlock,
  buildToolGuidanceZipPromptBlock,
  buildWorkingContextGuidance,
  normalizeDynamicMcpPromptContent
} from '$lib/utils/toolPromptInjection'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { resolveApiReasoningRetention } from '$lib/utils/reasoningRetention'
import { formatWhiteboardDcmLines } from '$lib/utils/whiteboard'
import { readAgentWhiteboard } from '$lib/server/services/whiteboard'
import type { WhiteboardContextSnapshot } from '$lib/server/services/approvalResumeReplay'
import type { LiveFileReadTurn } from '$lib/server/services/liveFileReadTurn.server'
import { readLiveFileReadOutcome, type LiveReadReceipt } from '$lib/server/services/liveFileReadOutcome.server'
import { buildLiveReadStateLines, describeLiveReadThisTurn, refreshedFileReadsUnavailableReason, resolveLiveFileReadsEnabled, resolveZipAiViewModeOf, type LiveReadThisTurn } from '$lib/utils/liveFileReads'
import { LIVE_FILE_READ_FACTS_MAX_COPIES, type SessionLiveReadFacts } from '$lib/utils/liveFileReadFacts'
import { estimateTokens } from '$lib/utils/tokens'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import { resolveAgentJevJudgeToolEnabled } from '$lib/utils/jevJuiceControl'
import { buildDmRosterDcmLines } from '$lib/utils/dmRoster'
import {
  WORKERS_FEATURE_ENABLED,
  WORKERS_MAX_CONCURRENT,
  resolveWorkersEnabled,
  shouldCompileDelegationGuidance
} from '$lib/utils/delegationCapabilities'
import {
  computeMemoryCompileContext,
  type MemoryCompileContext,
  type MemoryInferredRecallProvider
} from '$lib/server/services/memory/memoryRecall'
import {
  applyPromptRuntimeScope,
  applyPromptSessionScope,
  brokerToolNamesForScope
} from '$lib/utils/promptRuntimeScope'
import {
  isBrokerAvailable,
  resolveBrokerToolToggles
} from '$lib/utils/brokerAvailability'
import {
  resolveClipDataUrlFromStoredUpload,
  resolveClipPreferredUrl
} from '$lib/server/services/clipUploadPayload'
import { ApiCallError } from './redisCore'
import { loadClipRow } from '$lib/server/services/clipService'
import { loadMemoryMedia } from '$lib/server/services/memory/memoryMedia'
import {
  buildClipRosterDcmLines,
  buildClipRosterLines,
  compileClipReferencesForAiView,
  EMPTY_COMPILED_MESSAGE_TEXT,
  type ClipRosterEntryInput
} from '$lib/utils/clipAiView'
import { normalizeSessionClipState } from '$lib/server/services/sessionClipState'
import { resolveDefaultNativeExecutionBackend } from '$lib/server/services/nativeExecutionDefaults'
import { normalizeNativeBashAccessMode, nativeBashAfterPatchFromProvider } from '$lib/utils/nativeBashAfterPatch'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import { agentTypedFileToolsValue, globalTypedFileToolsValue, resolveTypedFileToolsGrant, typedFileToolsUnavailableReason } from '$lib/utils/typedFileToolsGrant'
import { readTypedFileToolsHost } from '$lib/server/services/typedFileToolsHost.server'
import { readToolOperationalSettings } from '$lib/server/toolOperationalSettingsOwner'
import { resolveToolOperationalSettings } from '$lib/utils/toolOperationalSettings'
import { resolveZipToolNotesEnabled as resolveSharedZipToolNotesEnabled } from '$lib/utils/replyControl'
import {
  categoryDefaults,
  getToolSettings,
  getTypeZipSettings,
  shouldPreferFieldSettingsForTool
} from '$lib/utils/toolRenderMap'
import {
  calculateAgentMessagesFromEndByIndex,
  calculateRecoveryHoldByIndex
} from '$lib/utils/zipMessageAge'
import {
  calculateInterruptedReasoningRecoveryActiveByIndex,
  getActiveInterruptedReasoningRecoveryBlock
} from '$lib/utils/reasoningRecovery'
import {
  applyContextCompactionToMessages,
  getContextCompactionState
} from '$lib/utils/contextCompaction'
import { applyFixedSessionGraduationToMessages } from '$lib/utils/fixedSessionGraduation'
import { isFixedSession } from '$lib/utils/fixedSession'
import { buildControlErrorDcmLines } from '$lib/utils/controlTags'
import { summarizeControlInputSchema } from '$lib/services/controlSchemaSummary'
import { resolveManagedSubagentScope } from '$lib/server/services/subagentRuntimeScope'
import { buildSubagentRosterCapabilityFragment } from '$lib/server/services/subagentRosterCapabilities'
import { buildSubagentThreadKey } from '$lib/server/services/subagentThreads'
import { buildSkillSessionContextLines } from '$lib/server/services/skillSessionContext'
import type {
  JevJuiceHintProvider,
  JevJuiceSmartZipProvider
} from '$lib/server/services/typesafe/jevJuiceHintContext'
import { loadRezippedSources } from '$lib/server/services/zipStateInferred'
import { zipBelongsToAnotherChat } from '$lib/utils/zipReferenceSafety'
import {
  getPrimaryAgentSystemPromptLabel,
  getPrimaryAgentSystemPromptRedisKey,
  isApiPrimaryAgentType,
  isN8nPrimaryAgentType,
  normalizePrimaryAgentType,
  primaryAgentAllowsAgentBrowser,
  primaryAgentAllowsNativeBash,
  retiredPrimaryAgentRefusal
} from '$lib/utils/primaryAgentType'
import {
  normalizeNativeExecutionBackend,
  type NativeExecutionBackend
} from '$lib/utils/nativeExecutionBackend'

import {
  COMPILED_TAG,
  compiledConversation,
  compiledCurrentMessage,
  compiledElement,
  disarmCompiledTags,
  isBatshitWrittenUserMessage,
  withZipIndexStatus,
  ZIP_INDEX_STATUS_HEADINGS,
  type CompiledMessageTag,
  type CurrentMessageFrom
} from '$lib/utils/compiledChatTags'
import { isOutsideNote, type AddressSourceKind, type AddressSourcePiece } from '$lib/utils/imageAddressOrigin'

/** SA-129 P1 / BL-1541: a dead copy as one history pass sees it (`findHistoryDeadCopies`). */
type HistoryDeadCopy = CompileDeadCopy & {
  files: DeadCopyFile[]
  /** It died in the reply that just finished (the newest assistant message and the failed parts it continues). */
  diedThisTurn: boolean
}

/** BL-1541: an older copy the dead-copy rule compressed this turn, for its Zipped this turn line. */
type DeadCopyThisTurn = { zipId: string; files: DeadCopyFile[] }

/** Decision 5 (Josh, 2026-10-23): what the Zip Index's status sections are written from (`buildZipStateSnapshot`). */
type ZipIndexStatusState = {
  hasZipHistory: boolean
  unzipped: UnzippedItem[]
  /** SA-129 P2: the held items this compile compressed as dead copies, and why. */
  deadCopies?: Map<string, DeadCopyReason>
  sizeGuards?: Map<string, ToolResultSizeGuard>
  /** BL-1541: the older copies the dead-copy rule compressed this turn, in chat order. */
  deadCopiesThisTurn?: DeadCopyThisTurn[]
  /** SA-137 Round 2: the Read File copies Refreshed File Reads zipped this turn, in chat order. */
  liveReadsThisTurn?: LiveReadThisTurn[]
}

export type PrecompiledHistory = {
  formattedMessages: string[]
  currentDay: string | null
  chatHistory: string
  globalZipSettings?: Record<string, any>
  /** BL-474 step 2: the source of each piece of `chatHistory` (`compileChatHistory`). */
  addressSources?: AddressSourcePiece[]
  /** SA-137 Round 2: the Read File copies Refreshed File Reads zipped for this speaker this turn. */
  liveReadsThisTurn?: LiveReadThisTurn[]
}

/**
 * BL-474 step 2: what a compile delivered to the model, piece by piece, with the source of each
 * (`imageAddressOrigin.ts`). Returned BESIDE `structuredInput`, never inside it, so no snapshot
 * stores it; nothing here changes a byte of what the model is sent.
 */
export type CompiledAddressSources = {
  pieces: AddressSourcePiece[]
  /** Missing server provenance is a failed decision input, not an empty history. */
  unaccountedInputs: number
  /** Image and file parts the model got (their pixels can show an address the text does not). */
  nonTextInputs: number
}

type GroupChatDcmContext = {
  agentOrder?: string[]
  agentDisplayNames?: Record<string, string>
  currentAgentId?: string | null
  userDisplayName?: string
  speakPolicies?: Record<string, GroupChatAgentSettings>
  driverMode?: boolean
  driverAgentId?: string | null
  maxFollowupsTotal?: number | null
}

type VoiceState = {
  tts?: boolean
  stt?: boolean
  voiceMode?: string
  provider?: string
  guidance?: string[]
}

type NativeBashAccessMode = 'plan' | 'agent' | 'dangerous'

type NativeBashDcmState = {
  enabled: boolean
  mode: NativeBashAccessMode
  backend: NativeExecutionBackend
  allowListCount: number
  neverAllowCount: number
  automationAllowListCount: number
  automationDenyListCount: number
}



/**
 * SA-128 (DL-02): who the compile is FOR, and the current display name of every other agent
 * in the history. That agent's own replies compile as `<assistant>`; any other agent's as
 * `<agent name="…">`, so a second agent joining a chat never rewrites the messages before it.
 */
type SpeakerView = {
  selfAgentId: string | null
  agentNames: Map<string, string>
}

type AgentSetupToolIndex = Pick<DynamicMcpIndexResult, 'text' | 'discoverable' | 'resolvedGatewayIds' | 'setupBlocks' | 'sources' | 'hintBudget' | 'apiUtilityProjection' | 'allowedSkillToolHints' | 'completeFeatureHintRefs'>
type SetupRuntimeAdmission = LiveAgentSetup & { brokerAvailable?: boolean; toolsRegistered?: boolean; apiUtilityScope?: ApiUtilityScope }
export interface FormattedChatInputResult {
  structuredInput: any
  primarySystemPrompt?: string
  subagentDescription?: Record<string, string>
  resolvedProjectPath?: string | null
  addressSources: CompiledAddressSources
  whiteboardContextSnapshot?: WhiteboardContextSnapshot
  refreshedFileReadsTurn: boolean
  agentSetup?: PreparedAgentSetup
  /** Read-only canonical DCM refresh, bound to this compile's exact original text span. */
  refreshOpenSkills?: () => Promise<SkillDcmUpdate | undefined>
  /** Same formatter/index for an actual native read's prospective delivery budget. */
  previewOpenSkillContext?: (skillId: string, result: Record<string, any>, messageId: string) => Promise<{ text: string; fingerprint: string }>
  readOpenSkillContext?: () => Promise<{ text: string; fingerprint: string }>
  /** Server-private second stage: no discovery, recall, Clip or Judge work repeats. */
  finalizeAgentSetup?: (fingerprint: string, additional?: SetupRuntimeAdmission) => Promise<FormattedChatInputResult>
}

// Simple in-memory cache to avoid hammering /api/users/:id/settings during SSR and hitting rate limits
const USER_SETTINGS_CACHE = new Map<string, { settings: UserSettingsRow; fetchedAt: number }>()
const USER_SETTINGS_CACHE_TTL_MS = 5_000
const GOON_DCM_CACHE = new Map<string, { goon: GoonRecord; fetchedAt: number }>()
const GOON_DCM_CACHE_TTL_MS = 30_000

export function invalidateUserSettingsCache(userId?: string) {
  if (userId) {
    USER_SETTINGS_CACHE.delete(userId)
    return
  }

  USER_SETTINGS_CACHE.clear()
}

/**
 * DatabaseService - Main service that delegates to focused stores
 * Maintains backward compatibility with existing code
 */
export class DatabaseService {
  private apiUrl = '/api'
  constructor(fetcher?: typeof fetch) {
    if (fetcher) {
      sessionApiClient.configureApi(fetcher, this.apiUrl)
      messageApiClient.configureApi(fetcher, this.apiUrl)
      agentStore.configureApi(fetcher, this.apiUrl)
      slashCommandStore.configureApi(fetcher, this.apiUrl)
      userStore.configureApi(fetcher, this.apiUrl)
    }
  }

  // Load unzipped items directly from Redis (server-side, no auth headers needed)
  private async loadUnzippedFromRedis(sessionId: string, strict = false): Promise<UnzippedItem[]> {
    try {
      const ids = await redis.sMembers(`unzipped:${sessionId}`)
      if (!ids || ids.length === 0) return []

      const items: UnzippedItem[] = []

      for (const zipId of ids) {
        const raw = strict ? await redis.json.get(`unzipped_item:${sessionId}:${zipId}`) : await redis.get(`unzipped_item:${sessionId}:${zipId}`)
        if (!raw) continue

        let parsed: any = raw
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
        }

        // Ensure zipId/sessionId are present
        const hydrated: UnzippedItem = {
          zipId,
          sessionId,
          permanent: false,
          unzippedAt: Date.now(),
          ...(typeof parsed === 'object' && parsed !== null ? parsed : {})
        }

        items.push(hydrated)
      }

      return items
    } catch (error) {
      if (strict) throw error
      console.error('[buildFormattedChatInput] Failed to load unzipped items from Redis:', error)
      return []
    }
  }

  private async loadRezippedFromRedis(sessionId: string, strict = false): Promise<string[]> {
    try {
      const ids = await redis.sMembers(`rezipped:${sessionId}`)
      return ids || []
    } catch (error) {
      if (strict) throw error
      console.error('[buildFormattedChatInput] Failed to load rezipped items from Redis:', error)
      return []
    }
  }

  private async loadSkillAwareZipState(sessionId: string, userId: string | undefined | null, pending: boolean) {
    return withZipStateLock(sessionId, async () => {
      const record = userId ? await readSkillSessionRecordForCompile({ userId, sessionId }) : undefined
      const strict = Boolean(record?.entries.some((entry) => entry.status === 'open'))
      const [stored, rezipped] = await Promise.all([
        this.loadUnzippedFromRedis(sessionId, strict), this.loadRezippedFromRedis(sessionId, strict)
      ])
      const projected = record ? projectSkillSessionsForPendingMessage(record, stored, pending) : {
        record: undefined, unzipped: pending ? countOneMoreMessage(stored).kept : stored, rezipped: [] as string[]
      }
      return { record: projected.record, sourceRecord: record, unzipped: projected.unzipped,
        rezipped: [...new Set([...rezipped, ...projected.rezipped])], expiryRezipped: projected.rezipped }
    })
  }

  // Decode base64 safely in both server and browser without importing Buffer in client bundle
  private decodeBase64ToText(base64: string): string {
    try {
      if (typeof atob === 'function') {
        return decodeURIComponent(
          Array.prototype.map
            .call(atob(base64), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        )
      }
    } catch (err) {
      // Non-UTF8-escapable payloads fall through to the Buffer path below.
    }

    // Node/SSR path without pulling the buffer module into the browser bundle.
    const bufferCtor = (globalThis as any)?.Buffer
    if (bufferCtor) {
      return bufferCtor.from(base64, 'base64').toString('utf-8')
    }

    // No decoder succeeded — fail loudly instead of silently dropping clip content (G-0032).
    throw new Error('CLIP_DECODE_FAILED: could not decode base64 clip content in this environment')
  }

  private async getRedisClient() {
    return redis
  }

  private resolveFetch(fetcher?: typeof fetch) {
    if (fetcher) {
      return fetcher
    }
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      return window.fetch.bind(window)
    }
    if (typeof fetch === 'function') {
      const base = process.env.PUBLIC_BASE_URL || process.env.ORIGIN || 'http://localhost:5620'
      return (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof input === 'string' && input.startsWith('/')) {
          return fetch(`${base}${input}`, init)
        }
        return fetch(input, init)
      }
    }
    throw new Error('Fetch API is not available in this environment')
  }

  // Helper method for API calls (for buildFormattedChatInput)
  private async apiCall(
    endpoint: string,
    options: (RequestInit & { fetcher?: typeof fetch }) = {}
  ) {
    const { fetcher, ...requestOptions } = options
    const fetchImpl = this.resolveFetch(fetcher)
    const response = await fetchImpl(`${this.apiUrl}${endpoint}`, {
      ...requestOptions,
      headers: {
        'Content-Type': 'application/json',
        ...requestOptions.headers
      },
      credentials: 'include'
    })

    if (!response.ok) {
      // The server's own sentence, never its raw JSON (`ApiCallError`, bug sweep 2026-09-18).
      throw new ApiCallError(response.status, await response.text())
    }

    return response.json()
  }

  /**
   * A stored prompt's text, or `null` when the key is absent (BL-230). A read that FAILS
   * throws `SYSTEM_PROMPT_UNAVAILABLE` and rejects the compile, like the user-settings read:
   * returning '' here sent agents with no base prompt, and silently swapped an Admin-edited
   * guidance prompt for its packaged fallback. It reads the raw string: the facade's
   * `redis.get` answers null for ANY error (a failed read looked like a missing key) and
   * parses text that starts with `{` or `[` as JSON.
   */
  private async readStoredPromptText(key: string): Promise<string | null> {
    try {
      const redisClient = await this.getRedisClient()
      const value = await redisClient.execute((client) => client.get(key))
      return value === null || value === undefined ? null : String(value)
    } catch (error) {
      throw new Error(
        `SYSTEM_PROMPT_UNAVAILABLE: failed to read ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /**
   * BL-230: the Primary Agent base prompt is never compiled empty. The stored value wins; an
   * absent or blank key (the boot seed is fire-and-forget, so a failed seed or a restore
   * without the key leaves nothing stored) compiles the packaged default, the same text the
   * seed stores, the way every guidance block falls back to its default. A failed read, or a
   * packaged default that cannot be read, rejects the compile with `SYSTEM_PROMPT_UNAVAILABLE`.
   */
  private async loadPrimarySystemPrompt(key: string): Promise<string> {
    const stored = await this.readStoredPromptText(key)
    if (stored?.trim()) return stored
    try {
      return await readPackagedCoreSystemPromptDefault(key)
    } catch (error) {
      throw new Error(
        `SYSTEM_PROMPT_UNAVAILABLE: ${key} is ${stored === null ? 'missing' : 'blank'} and its packaged default could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  // ========== Session Operations - Delegate to sessionApiClient ==========
  async getSessions(userId: string, includeArchived = false) {
    return sessionApiClient.getSessions(userId, includeArchived)
  }

  async createSession(session: Partial<ChatSessionRow>) {
    return sessionApiClient.createSession(session)
  }

  async updateSession(id: string, updates: Partial<ChatSessionRow>) {
    return sessionApiClient.updateSession(id, updates)
  }

  async deleteSession(id: string) {
    return sessionApiClient.deleteSession(id)
  }

  async archiveSession(id: string) {
    return sessionApiClient.archiveSession(id)
  }

  async unarchiveSession(id: string) {
    return sessionApiClient.unarchiveSession(id)
  }

  // ========== Message Operations - Delegate to messageApiClient ==========
  async getMessages(sessionId: string, limit = 100) {
    return messageApiClient.getMessages(sessionId, limit)
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return messageApiClient.getSessionMessages(sessionId)
  }

  async saveMessage(message: Message | Partial<ChatMemoryRow>, agent?: any) {
    return messageApiClient.saveMessage(message, agent)
  }

  async updateMessage(messageId: string, sessionId: string, updates: Partial<ChatMemoryRow>, userId: string) {
    return messageApiClient.updateMessage(messageId, sessionId, updates, userId)
  }

  async deleteMessage(messageId: string, sessionId: string, userId: string) {
    return messageApiClient.deleteMessage(messageId, sessionId, userId)
  }

  // ========== Agent Operations - Delegate to agentStore ==========
  async getAgents(userId: string) {
    return agentStore.getAgents(userId)
  }

  async createAgent(agent: Partial<AgentRow>) {
    return agentStore.createAgent(agent)
  }

  async updateAgent(id: string, updates: Partial<AgentRow>) {
    return agentStore.updateAgent(id, updates)
  }

  async deleteAgent(id: string) {
    return agentStore.deleteAgent(id)
  }

  async getSubagents(userId: string) {
    return agentStore.getSubagents(userId)
  }

  async createSubagent(subagent: Partial<SubagentRow>) {
    return agentStore.createSubagent(subagent)
  }

  async updateSubagent(id: string, updates: Partial<SubagentRow>) {
    return agentStore.updateSubagent(id, updates)
  }

  async deleteSubagent(id: string) {
    return agentStore.deleteSubagent(id)
  }

  // ========== Slash Command Operations - Delegate to slashCommandStore ==========
  async getSlashCommands(userId: string) {
    return slashCommandStore.getSlashCommands(userId)
  }

  async getSlashCommand(commandId: string) {
    return slashCommandStore.getSlashCommand(commandId)
  }

  async createSlashCommand(command: any) {
    return slashCommandStore.createSlashCommand(command)
  }

  async updateSlashCommand(id: string, updates: any) {
    return slashCommandStore.updateSlashCommand(id, updates)
  }

  async deleteSlashCommand(id: string) {
    return slashCommandStore.deleteSlashCommand(id)
  }

  async invokeSlashCommand(id: string, params?: Record<string, any>) {
    return slashCommandStore.invokeSlashCommand(id, params)
  }

  // ========== User Operations - Delegate to userStore ==========
  async getUserSettings(userId: string) {
    try {
      const settings = await redis.getUserSettings(userId)
      if (settings) return settings
    } catch (error) {
      // No fabricated defaults on failure: compiling without the user's real settings is
      // a silently corrupted send (G-0031). Callers fail loudly instead.
      throw new Error(
        `USER_SETTINGS_UNAVAILABLE: failed to load user settings: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    // No settings row saved yet (fresh install) — a real empty state, not an error fallback.
    const now = new Date().toISOString()
    return {
      id: `settings_${userId}`,
      user_id: userId,
      global_custom_system_prompt: '',
      theme: 'system',
      created_at: now,
      updated_at: now
    } as UserSettingsRow
  }

  async updateUserSettings(userId: string, updates: any) {
    const updatedSettings = await userStore.updateUserSettings(userId, updates)
    invalidateUserSettingsCache(userId)
    return updatedSettings
  }

  invalidateUserSettingsCache(userId?: string) {
    invalidateUserSettingsCache(userId)
  }

  async getProjects(userId: string) {
    return redis.getProjects(userId)
  }

  async saveProject(project: any) {
    return userStore.saveProject(project)
  }

  async updateProject(projectId: string, userId: string, updates: any) {
    return userStore.updateProject(projectId, userId, updates)
  }

  async deleteProject(projectId: string, userId: string) {
    return userStore.deleteProject(projectId, userId)
  }

  async getClips(userId: string) {
    return userStore.getClips(userId)
  }

  async getClip(clipId: string) {
    return userStore.getClip(clipId)
  }

  async createClip(clip: Partial<ClipRow>) {
    return userStore.createClip(clip)
  }

  async updateClip(clipId: string, updates: Partial<ClipRow>) {
    return userStore.updateClip(clipId, updates)
  }

  async deleteClip(clipId: string) {
    return userStore.deleteClip(clipId)
  }

  async getFolders() {
    return userStore.getFolders()
  }

  async createFolder(folder: Partial<ChatFolderRow>) {
    return userStore.createFolder(folder)
  }

  async updateFolder(folderId: string, updates: Partial<ChatFolderRow>) {
    return userStore.updateFolder(folderId, updates)
  }

  async deleteFolder(folderId: string, options: DeleteFolderOptions = {}) {
    return userStore.deleteFolder(folderId, options)
  }

  /**
   * SA-139 R4 (D14): a stored retired Primary type (the Claude Code CLI lane, Codex CLI, n8n)
   * compiles nothing, so no compile ever reads it as an API agent. Every model-facing compile
   * (`buildFormattedChatInput`, `prepareGroupHistory`) asks this first; the dispatch sites
   * refuse readably before they get here.
   */
  private assertCompilablePrimary(agent: any) {
    const retired = retiredPrimaryAgentRefusal(agent)
    if (retired) throw new Error(`${retired.error} ${retired.details}`)
  }

  private async loadSystemPrompts(
    agent: AgentRow,
    userId?: string
  ) {
    let primarySystemPrompt = ''
    let globalCustomPrompt = ''
    let globalZipSettings: Record<string, any> | undefined
    let globalTypedFileTools: boolean | null = null
    let globalToolOperationsSource: { value: unknown } | undefined
    let defaultWorkspacePath: string | undefined
    let agentDefaultProjectPath: string | undefined
    let agentDefaultProjectRules: Record<string, any> | undefined
    const now = Date.now()
    const shouldIncludeGlobalPrompt = agent?.include_global_prompt !== false
    let hasFreshCachedSettings = false

    if (userId) {
      const cached = USER_SETTINGS_CACHE.get(userId)
      if (cached) {
        if (now - cached.fetchedAt <= USER_SETTINGS_CACHE_TTL_MS) {
          hasFreshCachedSettings = true
          globalToolOperationsSource = { value: cached.settings }
          if (shouldIncludeGlobalPrompt) {
            globalCustomPrompt = cached.settings.global_custom_system_prompt || ''
          }
          globalZipSettings = cached.settings.global_zip_settings || undefined
          globalTypedFileTools = globalTypedFileToolsValue(cached.settings)
          defaultWorkspacePath = cached.settings.default_workspace_path || undefined
        } else {
          invalidateUserSettingsCache(userId)
        }
      }
    }

    // SA-139 R4 (D14): the one Primary prompt is the API one. A retired record never compiles
    // (`assertCompilablePrimary` runs before every compile); `findSessionZipFacts` reads only the
    // project paths here, so an old chat of a leftover record still reads.
    primarySystemPrompt = await this.loadPrimarySystemPrompt(getPrimaryAgentSystemPromptRedisKey('api'))

    if (userId && !hasFreshCachedSettings) {
      // No error caching and no fabricated defaults here: every compile attempts a fresh
      // settings load, and a failure rejects the send loudly (USER_SETTINGS_UNAVAILABLE).
      // Compiling without the user's global prompt / zip settings / workspace path is a
      // silently corrupted send (G-0031/G-0152a).
      const userSettings = await this.getUserSettings(userId)
      globalToolOperationsSource = { value: userSettings }
      if (userSettings) {
        USER_SETTINGS_CACHE.set(userId, { settings: userSettings, fetchedAt: now })
        if (shouldIncludeGlobalPrompt) {
          globalCustomPrompt = userSettings.global_custom_system_prompt || ''
        }
        globalZipSettings = userSettings.global_zip_settings || undefined
        globalTypedFileTools = globalTypedFileToolsValue(userSettings)
        defaultWorkspacePath = userSettings.default_workspace_path || undefined
      }
    }

    const defaultProjectId =
      typeof (agent as any)?.default_project_id === 'string'
        ? (agent as any).default_project_id.trim()
        : ''
    if (userId && defaultProjectId) {
      try {
        const projects = await this.getProjects(userId)
        const defaultProject = Array.isArray(projects)
          ? projects.find((project: any) => project?.id === defaultProjectId)
          : null
        if (defaultProject && typeof defaultProject === 'object') {
          const rootPath =
            typeof (defaultProject as any).root_path === 'string'
              ? (defaultProject as any).root_path.trim()
              : ''
          if (rootPath) {
            agentDefaultProjectPath = rootPath
          }
          const rulesCandidate = (defaultProject as any).rules_json
          if (
            rulesCandidate &&
            typeof rulesCandidate === 'object' &&
            !Array.isArray(rulesCandidate)
          ) {
            agentDefaultProjectRules = rulesCandidate as Record<string, any>
          }
        }
      } catch (error) {
        console.warn('[databaseRedis] Failed to resolve agent default project:', error)
      }
    }

    return {
      primarySystemPrompt,
      globalCustomPrompt,
      globalZipSettings,
      globalTypedFileTools,
      globalToolOperationsSource,
      defaultWorkspacePath,
      agentDefaultProjectPath,
      agentDefaultProjectRules
    }
  }

  private formatTimestamp(date: Date, includeDate: boolean) {
    if (includeDate) {
      return date.toLocaleString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      })
    }

    return date.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }

  private resolveMessageAgentId(message: Message): string | null {
    const candidate =
      (message as any)?.agent_id ||
      (message as any)?.agentId ||
      (message as any)?.metadata?.agentId
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
  }

  /**
   * SA-128 (DL-02): the agent this compile is for, and the current display name of every
   * other agent whose replies are in the history. A group run names its agents in the group
   * context; any other agent (a chat switched to a new agent, a member who left the group) is
   * read once from its `agent:` record, then the name its reply was stored with, then its id.
   */
  private async buildSpeakerView(
    messages: Message[],
    agent: any,
    groupContext?: GroupChatDcmContext
  ): Promise<SpeakerView> {
    const idOf = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null
    const selfAgentId = idOf(groupContext?.currentAgentId) ?? idOf(agent?.id)
    const agentNames = new Map<string, string>()
    for (const [id, name] of Object.entries(groupContext?.agentDisplayNames ?? {})) {
      if (typeof name === 'string' && name.trim()) agentNames.set(id, name.trim())
    }

    const storedNames = new Map<string, string>()
    const unnamed: string[] = []
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const agentId = this.resolveMessageAgentId(message)
      if (!agentId || agentId === selfAgentId || agentNames.has(agentId)) continue
      const metadata = (message as any)?.metadata ?? {}
      const stored = metadata.agentDisplayName ?? metadata.agentName
      if (typeof stored === 'string' && stored.trim()) storedNames.set(agentId, stored.trim())
      if (!unnamed.includes(agentId)) unnamed.push(agentId)
    }

    await Promise.all(
      unnamed.map(async (agentId) => {
        let name: string | null = null
        try {
          const record = await redis.get(`agent:${agentId}`)
          name = idOf(record?.displayName) ?? idOf(record?.name)
        } catch (error) {
          console.warn(`[databaseRedis] Could not read agent ${agentId} for its display name:`, error)
        }
        agentNames.set(agentId, name ?? storedNames.get(agentId) ?? agentId)
      })
    )

    return { selfAgentId, agentNames }
  }

  /**
   * SA-128 (DL-01, DP-1): the element a history message compiles as. `<user>` is only the
   * human, so a user-role message Batshit wrote for someone else (a woken turn's DM, webhook,
   * or schedule; an artifact share an agent started) is a `<note>`, like every system entry
   * (a Compact summary, a graduation gist, the Trim notice). A reply with no agent id is the
   * compile's own agent, today's single-agent rule (DP-4).
   */
  private resolveMessageElement(
    message: Message,
    speakers: SpeakerView
  ): { tag: CompiledMessageTag; name: string | null } {
    if (message.role === 'user') {
      const batshitWrote = isBatshitWrittenUserMessage((message as any)?.metadata)
      return { tag: batshitWrote ? COMPILED_TAG.note : COMPILED_TAG.user, name: null }
    }
    if (message.role === 'assistant') {
      const agentId = this.resolveMessageAgentId(message)
      if (!agentId || agentId === speakers.selfAgentId) {
        return { tag: COMPILED_TAG.assistant, name: null }
      }
      return { tag: COMPILED_TAG.agent, name: speakers.agentNames.get(agentId) ?? agentId }
    }
    return { tag: COMPILED_TAG.note, name: null }
  }

  private formatHistoryElement(
    compiled: string,
    message: Message,
    speakers: SpeakerView,
    time: string | null
  ) {
    const { tag, name } = this.resolveMessageElement(message, speakers)
    return compiledElement(tag, compiled, [
      ['name', name],
      ['time', time]
    ])
  }

  /**
   * DL-03: the first message of each day carries its full date and time, from the STORED
   * timestamp only, so the history stays byte-stable from send to send.
   */
  private decorateCompiledMessage(
    compiled: string,
    message: Message,
    timestamp: Date | undefined,
    lastMessageDay: string | null,
    messageIndex: number,
    speakers: SpeakerView
  ) {
    if (!timestamp) {
      return {
        formatted: this.formatHistoryElement(compiled, message, speakers, null),
        currentDay: lastMessageDay
      }
    }

    const messageDay = timestamp.toLocaleDateString('en-US')
    const includeDate = messageIndex === 0 || messageDay !== lastMessageDay
    const time = includeDate ? this.formatTimestamp(timestamp, true) : null

    return {
      formatted: this.formatHistoryElement(compiled, message, speakers, time),
      currentDay: includeDate ? messageDay : lastMessageDay
    }
  }

  private fallbackFormattedMessage(message: Message, speakers: SpeakerView) {
    const timestamp = message.timestamp ? new Date(message.timestamp) : null
    const time =
      timestamp && !Number.isNaN(timestamp.getTime()) ? this.formatTimestamp(timestamp, true) : null
    return this.formatHistoryElement(
      message.content || EMPTY_COMPILED_MESSAGE_TEXT,
      message,
      speakers,
      time
    )
  }

  private async getSessionClipState(sessionId: string, fetcher?: typeof fetch) {
    try {
      const state = await redis.get(`session:${sessionId}:clip_state`)
      if (state) return state
    } catch (error) {
      console.error('[databaseRedis] Failed to load session clip state from Redis:', error)
    }

    if (fetcher) {
      try {
        const response = await fetcher(`/api/session-clips/state/${sessionId}`)
        if (response.ok) {
          return await response.json()
        }
      } catch (error) {
        console.error('[databaseRedis] Failed to load session clip state via API:', error)
      }
    }

    return null
  }

  /**
   * SA-109: one clip-state read per compile, shared by the history rewrite, the
   * DCM roster, and content delivery so all three can never disagree.
   *
   * A clip is attached exactly while it is present in session clip state. There
   * is no third "hidden but still stored" state — the half-built temporary-
   * unclip lane was removed in SA-109 P4 because nothing could ever trigger it.
   */
  private async resolveSessionClipCompileState(
    sessionId: string,
    userId?: string,
    fetcher?: typeof fetch
  ): Promise<{
    entries: ClipRosterEntryInput[]
    attachedIds: string[]
    activeClipIds: Set<string>
    clipNames: Map<string, string>
  }> {
    const empty = {
      entries: [] as ClipRosterEntryInput[],
      attachedIds: [] as string[],
      activeClipIds: new Set<string>(),
      clipNames: new Map<string, string>()
    }
    if (!sessionId) return empty

    const raw = await this.getSessionClipState(sessionId, fetcher)
    const stateEntries = normalizeSessionClipState(sessionId, raw).clips
    if (stateEntries.length === 0) return empty

    const clipNames = new Map<string, string>()
    for (const entry of stateEntries) {
      // Clip records are user- or system-scoped (`clip:{userId}:{id}` /
      // `clip:system:{id}`); a bare `clip:{id}` read never resolves.
      const clip = await this.getClipData(userId, entry.clipId, fetcher).catch(() => null)
      const filename = typeof clip?.filename === 'string' ? clip.filename.trim() : ''
      if (filename) clipNames.set(entry.clipId, filename)
    }

    const attachedIds = stateEntries.map((entry) => entry.clipId)

    return {
      entries: stateEntries.map((entry) => ({
        clipId: entry.clipId,
        name: clipNames.get(entry.clipId) ?? null,
        attachedToMessageId: entry.attachedToMessageId ?? null,
        messagesUntilUnclip: entry.messagesUntilUnclip ?? null
      })),
      attachedIds,
      activeClipIds: new Set(attachedIds),
      clipNames
    }
  }

  private async getClipData(
    userId: string | undefined,
    clipId: string,
    fetcher?: typeof fetch
  ) {
    try {
      const stored = await loadClipRow(userId, clipId)
      if (stored) return stored

      // Fallback to API (browser/client)
      return await this.apiCall(`/clips/${clipId}`, { fetcher })
    } catch (error) {
      console.error('[databaseRedis] Failed to load clip:', error)
      return null
    }
  }

  private resolveZipToolNotesEnabled(
    agent: any,
    globalZipSettings?: Record<string, any>
  ): boolean {
    // One rule with the reply end and the compression hint (BL-1785).
    return resolveSharedZipToolNotesEnabled(agent, globalZipSettings)
  }

  private resolveZipAiViewMode(
    agent: any,
    globalZipSettings?: Record<string, any>
  ): 'inline' | 'appended' {
    const agentMode =
      agent?.zip_ai_view_mode === 'appended' || agent?.zip_ai_view_mode === 'inline'
        ? agent.zip_ai_view_mode
        : null
    if (agentMode) return agentMode

    const globalMode =
      globalZipSettings?.zip_ai_view_mode === 'appended' ||
      globalZipSettings?.zip_ai_view_mode === 'inline'
        ? globalZipSettings.zip_ai_view_mode
        : null

    return globalMode === 'inline' ? 'inline' : 'appended'
  }

  private async resolveToolZipGuidancePrompt(options: {
    notesEnabled: boolean
    agent: any
    zipViewMode: 'inline' | 'appended'
    /** SA-136 D7: the agent's tool build offers `read_file`, `write_file` and `edit_file`. */
    typedFileTools?: boolean
    /** SA-137 P5: this turn refreshes open file reads at its start. */
    liveFileReads?: boolean
    bashCommandsAfterPatchRun?: boolean
  }): Promise<string> {
    // BL-1777: one record ("Tool Prompt: Zips"); its packaged default is the built block below.
    const storedPrompt = await this.readStoredPromptText('batshit:tool_guidance_zip_prompt')
    const fallbackPrompt = buildToolGuidanceZipPromptBlock({
      zipAiViewMode: options.zipViewMode,
      toolNotesEnabled: options.notesEnabled,
      typedFileTools: options.typedFileTools === true,
      liveFileReads: options.liveFileReads === true,
      bashCommandsAfterPatchRun: options.bashCommandsAfterPatchRun === true
    })
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    // SA-096 P1: the Fetch Zip instruction is the one place this block still names a broker
    // tool, so it resolves to the receiving agent's real tool name (DL-4).
    const brokerNames = brokerToolNamesForScope('api')
    return replacePromptVariables(applyPromptRuntimeScope(prompt, 'api'), options.agent, {
      ...(options.agent?.settings ?? {}),
      runtime_flavor: 'vercel',
      zip_ai_view_mode: options.zipViewMode,
      zip_tool_notes_enabled: options.notesEnabled ? 'enabled' : 'disabled',
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use,
      api_tool_zip_guidance: fallbackPrompt,
      // SA-139 R4: a saved custom prompt may still name the retired CLI placeholder outside a
      // `<!-- runtime:cli -->` section; it keeps compiling the agent's own (API) guidance.
      cli_tool_zip_guidance: fallbackPrompt
    })
  }

  private getMcpToolSelections(agent: any): string[] {
    if (Array.isArray(agent?.defaultMCPToolSelections)) return agent.defaultMCPToolSelections
    if (Array.isArray(agent?.default_mcp_tool_selections)) return agent.default_mcp_tool_selections
    return []
  }

  private parseBooleanSetting(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
      if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
    }
    return null
  }

  private parseIntegerSetting(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) return null
      const parsed = Number.parseInt(trimmed, 10)
      if (Number.isFinite(parsed)) return parsed
    }
    return null
  }

  private parseOptionalStringSetting(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  private parseStringListSetting(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
    }
    if (typeof value === 'string') {
      return value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    }
    return []
  }

  private normalizeBashAccessMode(value: unknown): NativeBashAccessMode | null {
    return normalizeNativeBashAccessMode(value)
  }

  private defaultNativeExecutionBackend(mode: NativeBashAccessMode): NativeExecutionBackend {
    if (mode === 'dangerous') return 'local'
    // Shared single source of truth with native tool dispatch and the settings route's
    // runtime-defaults rider, so all three surfaces agree on the install default (G-0027).
    return resolveDefaultNativeExecutionBackend()
  }

  private resolveNativeBashDcmState(agent: any): NativeBashDcmState | null {
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (!primaryAgentAllowsNativeBash(primaryAgentType)) return null

    const providerSettings =
      agent?.provider_specific_settings && typeof agent.provider_specific_settings === 'object'
        ? agent.provider_specific_settings
        : agent?.providerSpecificSettings && typeof agent.providerSpecificSettings === 'object'
          ? agent.providerSpecificSettings
          : {}
    const nested =
      providerSettings?.nativeTools && typeof providerSettings.nativeTools === 'object'
        ? providerSettings.nativeTools
        : providerSettings?.batshitNativeTools && typeof providerSettings.batshitNativeTools === 'object'
          ? providerSettings.batshitNativeTools
          : {}

    const mode =
      this.normalizeBashAccessMode(
        nested.bashAccessMode ??
          nested.nativeBashAccessMode ??
          nested.bashPolicyMode ??
          providerSettings.nativeBashPolicyMode ??
          providerSettings.bashPolicyMode
      ) ?? 'agent'
    const enabled =
      this.parseBooleanSetting(
        nested.bashEnabled ??
          nested.nativeBashEnabled ??
          providerSettings.bashEnabled ??
          providerSettings.nativeBashEnabled
      ) ?? true
    const backend =
      normalizeNativeExecutionBackend(
        nested.executionBackend ??
          nested.nativeExecutionBackend ??
          nested.bashExecutionBackend ??
          nested.nativeBashExecutionBackend ??
          providerSettings.executionBackend ??
          providerSettings.nativeExecutionBackend ??
          providerSettings.bashExecutionBackend ??
          providerSettings.nativeBashExecutionBackend
      ) ?? this.defaultNativeExecutionBackend(mode)
    const allowList = Array.isArray(nested.bashCommandAllowList)
      ? nested.bashCommandAllowList
      : Array.isArray(nested.nativeBashCommandAllowList)
        ? nested.nativeBashCommandAllowList
        : Array.isArray(providerSettings.nativeBashCommandAllowList)
          ? providerSettings.nativeBashCommandAllowList
          : []
    const neverAllowList = Array.isArray(nested.bashNeverAllowList)
      ? nested.bashNeverAllowList
      : Array.isArray(nested.nativeBashNeverAllowList)
        ? nested.nativeBashNeverAllowList
      : Array.isArray(providerSettings.nativeBashNeverAllowList)
          ? providerSettings.nativeBashNeverAllowList
          : []
    const automationAllowList = this.parseStringListSetting(
      nested.automationBashAllowList ??
        nested.nativeAutomationBashAllowList ??
        providerSettings.automationBashAllowList ??
        providerSettings.nativeAutomationBashAllowList
    )
    const automationDenyList = this.parseStringListSetting(
      nested.automationBashDenyList ??
        nested.nativeAutomationBashDenyList ??
        providerSettings.automationBashDenyList ??
        providerSettings.nativeAutomationBashDenyList
    )

    return {
      enabled,
      mode,
      backend,
      allowListCount: allowList.length,
      neverAllowCount: neverAllowList.length,
      automationAllowListCount: automationAllowList.length,
      automationDenyListCount: automationDenyList.length
    }
  }

  /**
   * SA-136 D7: whether this Primary API agent's tool build offers the typed file tools, by the
   * same rule as `buildMode3NativeTools`' Primary path (the agent's value, then the user's global
   * value, then the factory value; Bash on; a qualified host/backend, read as the DCM's Bash line reads
   * it), so the zip guidance names the typed tools only to an agent that has them and every other
   * agent's prompt stays byte-identical. Subagents and Workers do not compile through here.
   */
  private typedFileToolsOffered(agent: any, globalTypedFileTools: boolean | null): boolean {
    if (normalizePrimaryAgentType(agent) !== 'api') return false
    const state = this.resolveNativeBashDcmState(agent)
    if (!state?.enabled || typedFileToolsUnavailableReason(state.backend, readTypedFileToolsHost()) !== null) return false
    const providerSettings = agent?.provider_specific_settings ?? agent?.providerSpecificSettings ?? null
    return resolveTypedFileToolsGrant(agentTypedFileToolsValue(providerSettings), globalTypedFileTools)
  }

  private buildNativeBashDcmLine(agent: any): string | null {
    const state = this.resolveNativeBashDcmState(agent)
    if (!state) return null
    if (!state.enabled) return 'native_bash: disabled'

    if (state.mode === 'plan') {
      return `native_bash: enabled | mode=plan | backend=${state.backend} | proven read/search + .md edits only | hidden side effects and executor/writer pipeline stages blocked | command chaining blocked | prefer apply_patch when available; otherwise use safe native edit commands`
    }
    if (state.mode === 'dangerous') {
      return `native_bash: enabled | mode=dangerous | backend=${state.backend} | approval popups skipped | never_allow_rules=${state.neverAllowCount} still enforced`
    }
    return `native_bash: enabled | mode=agent | backend=${state.backend} | approval popups for non-allowlisted commands | allow_list_rules=${state.allowListCount} | never_allow_rules=${state.neverAllowCount}`
  }

  private buildRuntimeNetworkDcmLine(agent: any): string | null {
    const state = this.resolveNativeBashDcmState(agent)
    if (!state || !state.enabled) return null

    if (state.backend === 'docker_sandbox') {
      return 'runtime_network: backend=docker_sandbox | localhost is the sandbox; use host.docker.internal for host-published services; feature tools resolve runtime aliases internally.'
    }
    if (state.backend === 'apple_container') {
      return 'runtime_network: backend=apple_container | sandbox commands run in Apple Container with an internal deny-network policy; do not assume localhost reaches host services.'
    }

    return 'runtime_network: backend=local | localhost is this Batshit runtime; feature tools resolve runtime aliases internally.'
  }

  private async buildNativeAgentBrowserDcmLines(agent: any, userId?: string, confirmedSource?: { value: unknown }): Promise<string[] | null> {
    if (!primaryAgentAllowsAgentBrowser(normalizePrimaryAgentType(agent))) return null
    const providerSettings =
      agent?.provider_specific_settings && typeof agent.provider_specific_settings === 'object'
        ? agent.provider_specific_settings
        : agent?.providerSpecificSettings && typeof agent.providerSpecificSettings === 'object'
          ? agent.providerSpecificSettings
          : {}
    const nested =
      providerSettings?.nativeTools && typeof providerSettings.nativeTools === 'object'
        ? providerSettings.nativeTools
        : providerSettings?.batshitNativeTools && typeof providerSettings.batshitNativeTools === 'object'
          ? providerSettings.batshitNativeTools
          : {}

    const enabled =
      this.parseBooleanSetting(
        nested.agentBrowserEnabled ??
          nested.nativeAgentBrowserEnabled ??
          providerSettings.agentBrowserEnabled ??
          providerSettings.nativeAgentBrowserEnabled
      ) ?? true
    if (!enabled) return ['native_agent_browser: disabled']
    if (!confirmedSource && !userId) throw new Error('Agent Browser defaults require an authenticated user context.')
    const operational = confirmedSource
      ? resolveToolOperationalSettings(confirmedSource.value)
      : await readToolOperationalSettings(userId!)
    const state = operational.agentBrowser
    const containerized = readTypedFileToolsHost().containerized
    const autoDefaults: string[] = []
    if (containerized) {
      autoDefaults.push('desktop_launch_defaults=not_applied')
    } else {
      if (state.liveViewEnabled) autoDefaults.push('--headed')
      if (state.runtimeMode === 'chrome-cdp') autoDefaults.push(`--cdp http://127.0.0.1:${state.cdpPort}`)
      if (state.session) autoDefaults.push(`--session ${state.session}`)
      if (state.profilePath) autoDefaults.push(`--profile ${state.profilePath}`)
      if (state.executablePath) autoDefaults.push('--executable-path <configured>')
    }
    if (state.provider !== 'local') autoDefaults.push(`-p ${state.provider}`)
    if (state.extraFlags.length > 0) autoDefaults.push(`extra_flags=${state.extraFlags.length}`)
    return [
      containerized
        ? 'native_agent_browser: enabled | runtime=docker-sidecar'
        : `native_agent_browser: enabled | via=native_bash_execute | run "agent-browser --help" first | workflow=open <url> -> snapshot -i -> click/fill @eN -> snapshot`,
      `native_agent_browser_defaults: ${autoDefaults.length > 0 ? autoDefaults.join(', ') : '(none)'} | timeout_ms=${state.timeoutMs}`
    ]
  }

  private resolveNativeDynamicMcpEnabled(agent: any): boolean | null {
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (!isApiPrimaryAgentType(primaryAgentType)) {
      return null
    }

    const providerSettings =
      agent?.provider_specific_settings && typeof agent.provider_specific_settings === 'object'
        ? agent.provider_specific_settings
        : agent?.providerSpecificSettings && typeof agent.providerSpecificSettings === 'object'
          ? agent.providerSpecificSettings
          : {}
    const nested =
      providerSettings?.nativeTools && typeof providerSettings.nativeTools === 'object'
        ? providerSettings.nativeTools
        : providerSettings?.batshitNativeTools && typeof providerSettings.batshitNativeTools === 'object'
          ? providerSettings.batshitNativeTools
          : {}

    return this.parseBooleanSetting(
      nested.dynamicMcpEnabled ??
        nested.nativeDynamicMcpEnabled ??
        providerSettings.dynamicMcpEnabled ??
        providerSettings.nativeDynamicMcpEnabled
    )
  }

  private resolveNativeCliToolsEnabled(agent: any): boolean | null {
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (!isApiPrimaryAgentType(primaryAgentType)) {
      return null
    }

    const providerSettings =
      agent?.provider_specific_settings && typeof agent.provider_specific_settings === 'object'
        ? agent.provider_specific_settings
        : agent?.providerSpecificSettings && typeof agent.providerSpecificSettings === 'object'
          ? agent.providerSpecificSettings
          : {}
    const nested =
      providerSettings?.nativeTools && typeof providerSettings.nativeTools === 'object'
        ? providerSettings.nativeTools
        : providerSettings?.batshitNativeTools && typeof providerSettings.batshitNativeTools === 'object'
          ? providerSettings.batshitNativeTools
          : {}

    return this.parseBooleanSetting(
      nested.cliToolsEnabled ??
        nested.nativeCliToolsEnabled ??
        providerSettings.cliToolsEnabled ??
        providerSettings.nativeCliToolsEnabled
    )
  }

  private isBatshitPrimaryAgent(agent: any): boolean {
    return isApiPrimaryAgentType(normalizePrimaryAgentType(agent))
  }

  private resolveDynamicMcpEnabled(agent: any): boolean {
    const nativeToggle = this.resolveNativeDynamicMcpEnabled(agent)
    if (typeof nativeToggle === 'boolean') return nativeToggle
    return this.isBatshitPrimaryAgent(agent)
  }

  private resolveCliToolsEnabled(agent: any): boolean {
    const nativeToggle = this.resolveNativeCliToolsEnabled(agent)
    if (typeof nativeToggle === 'boolean') return nativeToggle
    return this.isBatshitPrimaryAgent(agent)
  }

  /**
   * SA-096 P5: does this agent actually have the Batshit Tool Search/Use broker?
   *
   * The broker guidance block used to ship on the Dynamic MCP toggle alone, which was wrong
   * in both directions: an agent with Dynamic MCP off but live Fabric or artifact families
   * got the broker tools and no instructions, while an agent with Dynamic MCP on and nothing
   * else reachable paid for instructions it could not use. The families are now derived from
   * the same shared rules the registration sites use (`$lib/utils/brokerAvailability`).
   *
   * `hasCliTools` is intentionally left unresolved. The saved CLI Tool selection can be
   * overridden per chat, so compilation cannot read it
   * reliably. Unresolved counts as reachable, which keeps this gate from ever being
   * narrower than registration — withholding guidance from an agent that has the tools is
   * the failure this packet exists to prevent.
   */
  private hasBrokerAccess(agent: any): boolean {
    return isBrokerAvailable({
      runtime: 'api',
      toggles: resolveBrokerToolToggles(this.getAgentProviderSettings(agent))
    })
  }

  private getAgentProviderSettings(agent: any): Record<string, any> {
    if (agent?.provider_specific_settings && typeof agent.provider_specific_settings === 'object') {
      return agent.provider_specific_settings
    }
    if (agent?.providerSpecificSettings && typeof agent.providerSpecificSettings === 'object') {
      return agent.providerSpecificSettings
    }
    return {}
  }

  /**
   * SA-104 P3: the Memory guidance block for memory-enabled agents. Mirrored in the
   * one compile path (SA-106 retired the second, n8n-only implementation).
   *
   * Decision 11 (option A): the packaged text is one text for both lanes and no longer holds
   * `{{ $api_memory_guidance }}`. The variable is still filled, with the lane-scoped fallback,
   * only for an Admin-customized copy saved before that change (a customized copy is never
   * refreshed); without it such a copy would send the placeholder literally.
   *
   * The `<!-- session:infinite -->` part is kept only when the compiled session is an Infinite
   * Session (`isFixedSession`); it is scoped before the runtime pass, like the runtime blocks.
   */
  private async resolveMemoryGuidancePrompt(
    agent: any,
    infiniteSession: boolean
  ) {
    const storedPrompt = await this.readStoredPromptText('batshit:tool_guidance_memory_prompt')
    const fallbackPrompt = buildMemoryPromptBlock({ infiniteSession })
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    const brokerNames = brokerToolNamesForScope('api')
    const sessionScoped = applyPromptSessionScope(prompt, { infiniteSession })
    return replacePromptVariables(applyPromptRuntimeScope(sessionScoped, 'api'), agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: 'vercel',
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use,
      api_memory_guidance: fallbackPrompt
    })
  }

  private async resolveDynamicMcpPrompt(agent: any) {
    const storedPrompt = await this.readStoredPromptText('batshit:dynamic_mcp_prompt')
    const fallbackPrompt = buildDynamicMcpPromptBlock()
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    const normalizedPrompt = normalizeDynamicMcpPromptContent(prompt)
    // SA-096: drop the other runtimes' tool names, call shapes, and examples before variable
    // substitution so an API agent is never taught a tool name it does not have.
    const scopedPrompt = applyPromptRuntimeScope(normalizedPrompt, 'api')
    const brokerNames = brokerToolNamesForScope('api')
    return replacePromptVariables(scopedPrompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: 'vercel',
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  /**
   * SA-111 P1 (DL-111-01) — the delegation guidance block. Same shape as the broker and
   * memory guidance resolvers: stored Redis prompt first, packaged/code fallback second,
   * runtime-scoped so a retired section (a saved `<!-- runtime:cli -->` one) never compiles.
   */
  /**
   * SA-113 P2 (DL-113-04a) — the Agent DM guidance block.
   *
   * Same contract as memory's: the packaged Markdown is the default, Admin can override it
   * in Redis, and the code fallback compiles when neither exists. Gated on
   * `resolveAgentDmsEnabled` alone (Agent DMs plus Fabric & Utilities) — an agent without
   * DMs pays nothing.
   */
  /**
   * SA-113 P2 (DL-113-04b) — the one DM store read a compile makes.
   *
   * Mirrors `resolveSessionClipCompileState`: read once at the compile site, hand the
   * formatter plain records, and let the formatter stay pure text. Failure is loud in the
   * log but not fatal — a compile that cannot read the inbox omits the roster rather than
   * failing the send, exactly like the clip roster, because the tools and the guidance are
   * still there and the agent can ask.
   */
  private async resolveDmRosterForCompile(
    agent: any,
    sessionId: string,
    messages: any[]
  ): Promise<{ lines: string[]; listedIds: string[]; totalOpen: number }> {
    const empty = { lines: [], listedIds: [], totalOpen: 0 }
    if (!agent?.id || !resolveAgentDmsEnabled(agent)) return empty
    try {
      const { listInbox } = await import('$lib/server/services/dm/dmStore')
      const records = await listInbox(agent.id)
      // The previous user message in THIS session is the ✅/🟢 boundary: anything created
      // after it is new to the agent this turn. A session with none yet — a woken
      // session's first turn — treats everything as new, which is true.
      const userMessages = messages.filter((message) => message?.role === 'user')
      const previous = userMessages[userMessages.length - 2] ?? null
      const previousTs = previous?.created_at ? Date.parse(previous.created_at) : null
      return buildDmRosterDcmLines({
        records,
        sessionId,
        previousUserMessageTs: Number.isFinite(previousTs) ? previousTs : null
      })
    } catch (error) {
      console.error('[Agent DMs] Could not read the inbox for the DCM roster:', error)
      return empty
    }
  }

  private async resolveDmGuidancePrompt(agent: any) {
    const storedPrompt = await this.readStoredPromptText('batshit:dm_guidance')
    const prompt = storedPrompt?.trim() ? storedPrompt : buildDmGuidancePromptBlock()
    const brokerNames = brokerToolNamesForScope('api')
    return replacePromptVariables(prompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: 'vercel',
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  /**
   * SA-120 P2 (H1) — the Judge Juice judgment-tool guidance block. Same contract as the DM
   * block: stored Redis prompt first, code fallback second. Gated by the caller on
   * `resolveAgentJevJudgeToolEnabled` alone — the switch plus Fabric & Utilities, the same
   * pair that opens `sys.judge.*` in the broker — so an agent without the tool pays nothing
   * and is never taught a control it cannot call.
   */
  private async resolveJevJuiceGuidancePrompt(agent: any) {
    const storedPrompt = await this.readStoredPromptText('batshit:jev_juice_guidance')
    const prompt = storedPrompt?.trim() ? storedPrompt : buildJevJuiceGuidancePromptBlock()
    const brokerNames = brokerToolNamesForScope('api')
    return replacePromptVariables(prompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: 'vercel',
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  private async resolveSubagentGuidancePrompt(agent: any) {
    const storedPrompt = await this.readStoredPromptText('batshit:subagent_guidance')
    const fallbackPrompt = buildSubagentGuidancePromptBlock()
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    const scopedPrompt = applyPromptRuntimeScope(prompt, 'api')
    return replacePromptVariables(scopedPrompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: 'vercel'
    })
  }

  private resolveToolSummary(message: Message | undefined, toolCallId?: string, toolName?: string): string {
    const zipControl = (message as any)?.metadata?.zipControl
    const notes = Array.isArray(zipControl?.toolResultsSummary)
      ? zipControl.toolResultsSummary
      : Array.isArray(zipControl?.toolNotes)
        ? zipControl.toolNotes
        : []
    if (!notes.length) return ''

    const normalizedToolName = toolName?.toLowerCase() ?? ''

    for (const note of notes) {
      const summary =
        typeof note?.summary === 'string'
          ? note.summary.replace(/\s+/g, ' ').trim()
          : ''
      if (!summary) continue

      const noteToolCallId =
        typeof note?.toolCallId === 'string'
          ? note.toolCallId
          : typeof note?.tool_call_id === 'string'
          ? note.tool_call_id
          : undefined
      const noteToolName =
        typeof note?.toolName === 'string'
          ? note.toolName
          : typeof note?.tool_name === 'string'
          ? note.tool_name
          : undefined

      if (toolCallId && noteToolCallId && noteToolCallId === toolCallId) {
        return summary
      }
      if (normalizedToolName && noteToolName && noteToolName.toLowerCase() === normalizedToolName) {
        return summary
      }
    }

    return ''
  }

  private buildZipAppend(entries: ZipExposure[], delivered?: AddressSourcePiece[]): string {
    if (!entries.length) return ''

    const seen = new Set<string>()
    const indexLines: string[] = []
    const contentBlocks: string[] = []

    for (const entry of entries) {
      const zipId = entry.zipId
      const normalized = normalizeId(zipId)
      if (seen.has(normalized)) continue
      seen.add(normalized)

      const zipData = entry.zipData as any
      const metadata = zipData?.metadata ?? {}
      const toolCallId = metadata.toolCallId || metadata.tool_call_id
      const toolName =
        metadata.operationKind ||
        metadata.toolName ||
        metadata.tool_name ||
        zipData?.name ||
        metadata?.name ||
        zipData?.type ||
        'unknown'
      const message = entry.message as Message | undefined
      const messageId = metadata.messageId || message?.id || 'unknown'
      const timestampRaw =
        message?.timestamp ||
        (message as any)?.created_at ||
        (zipData?.createdAt ? new Date(zipData.createdAt).toISOString() : '')
      const timestamp = timestampRaw ? new Date(timestampRaw).toISOString() : 'unknown'

      const noteSummary = this.resolveToolSummary(message, toolCallId, toolName)
      const fallbackSummary =
        entry.zip.optionalContent ||
        entry.zip.description ||
        (zipData?.type ? `${zipData.type} content` : '')
      // BL-1652: every part of a split multi-file read shares the call's Tool Note, so each part's
      // line starts with its own label (its path and line count); the note follows as the call's.
      const splitPart = metadata.shellReadSplitPart
      const ownLabel = typeof entry.zip.description === 'string' ? entry.zip.description : ''
      const summary =
        splitPart && Number(splitPart.of) > 1 && ownLabel
          ? noteSummary ? `${ownLabel}; note for the whole command: ${noteSummary}` : ownLabel
          : noteSummary || fallbackSummary

      const summarySegment = summary ? ` | summary: "${summary}"` : ''

      indexLines.push(
        `${indexLines.length + 1}) ${messageId} | tool: ${toolName} | zipId: ${zipId}${summarySegment}`
      )

      const blockLines = [
        `[${indexLines.length}]`,
        `zipId: ${zipId}`,
        `toolName: ${toolName}`,
        `messageId: ${messageId}`,
        `timestamp: ${timestamp}`,
        `contentType: ${zipData?.type || 'unknown'}`,
        `content:`,
        entry.expandedContent,
        `[/${indexLines.length}]`
      ]
      contentBlocks.push(blockLines.join('\n'))
      // BL-474: the same formatter partitions actual result text from echoed model arguments.
      // Never let a missing/mismatched decomposition grant read provenance to the whole body.
      if (zipData?.type === 'cool_tool' && typeof entry.expandedContent === 'string') {
        const parts = entry.expandedContentParts
        delivered?.push(...(parts && parts.map((part) => part.text).join('') === entry.expandedContent
          ? parts
          : [{ source: 'agent_words' as const, text: entry.expandedContent }]))
      }
    }

    if (!indexLines.length) return ''

    // SA-128 (DL-04): one `<zip_index>` element after the conversation, same contents and
    // order as the old two headers; the zip bodies inside it are disarmed like any content.
    return compiledElement(
      COMPILED_TAG.zipIndex,
      [
        'Index (chronological):',
        indexLines.join('\n'),
        '',
        'Zip Block (chronological):',
        contentBlocks.join('\n\n')
      ].join('\n')
    )
  }

  private async compileChatHistory(
    messages: Message[],
    agent: any,
    globalZipSettings: Record<string, any> | undefined,
    options: {
      fetch?: typeof fetch
      groupToolSharing?: {
        currentAgentId?: string | null
        sharedTools?: string[]
      }
      /** SA-109: clips attached right now — theirs get no history marker. */
      activeClipIds?: Set<string> | null
      /** SA-109: id → filename, for Clip Logs whose placeholder lost its name. */
      clipNames?: Map<string, string> | null
      /** F-P5-11: this pass's own zip state, never the browser singleton. */
      zipState: ZipStateView
      /** SA-129 P1: the chat's project path, which relative file paths in tool results resolve against. */
      deadCopyProjectPath?: string | null
      /** BL-490: the chat this pass compiles for; a zip of another chat is never read. */
      zipOwner: { sessionId: string; userId?: string | null }
      /**
       * SA-137: the actual API turn's live file reads, made by the route only (never a preview).
       * The first pass reads; every later pass of the same turn gets the same frozen snapshot.
       */
      liveFileReadTurn?: Pick<LiveFileReadTurn, 'snapshotFor'> & Partial<Pick<LiveFileReadTurn, 'replyMessageId' | 'replyMessageIds'>>
    },
    speakers: SpeakerView
  ) {
    const formattedMessages: string[] = []
    let currentDay: string | null = null
    const totalMessages = messages.length
    const zipViewMode = this.resolveZipAiViewMode(agent, globalZipSettings)
    const zipToolNotesEnabled = this.resolveZipToolNotesEnabled(agent, globalZipSettings)
    const agentMessagesFromEndByIndex = calculateAgentMessagesFromEndByIndex(messages)
    const recoveryHoldByIndex = calculateRecoveryHoldByIndex(messages)
    const interruptedReasoningRecoveryActiveByIndex =
      calculateInterruptedReasoningRecoveryActiveByIndex(messages)
    const zipExposures: ZipExposure[] = []
    // SA-120 P5: what this compile leaves compressed, in chat order. Observation only;
    // the only reader is the route-owned Judge Juice smart-zip hint provider.
    const compressedZips: ZipCompression[] = []
    // ...and what it leaves expanded, for the same lane's after-reply question.
    const exposedZips: ZipExposed[] = []
    const zipCompilationCache = new Map<string, Promise<any | null>>()
    // BL-474 step 2: the source of each piece this pass delivers, in chat order. Read only.
    const addressSources: AddressSourcePiece[] = []
    // BL-490: a zip that names another chat or user is read as missing, whatever allow-list
    // the message carries: the browser posts the history, and a page once trusted an echoed
    // reference. Read-time trust repair (`messageZipTrust.ts`) applies the same ownership rule.
    const zipOwner = options.zipOwner
    const resolveZipForCompilation = (zipId: string) => {
      if (!zipCompilationCache.has(zipId)) {
        zipCompilationCache.set(
          zipId,
          redis
            .getZip(zipId)
            .then((zip: any) => (zipBelongsToAnotherChat(zip, zipOwner) ? null : zip))
        )
      }
      return zipCompilationCache.get(zipId)!
    }
    // SA-137 (D6): the turn's one frozen live-read snapshot, asked for before the history loop from
    // this pass's provisional candidates. The dead-copy rules apply exactly as with the feature off
    // (Josh, 2026-11-04; D3 amended): a stale or superseded copy is a candidate only where the
    // feature-off compile keeps it open too, so a refresh never keeps more open than that compile.
    const liveSnapshot = options.liveFileReadTurn
      ? await options.liveFileReadTurn.snapshotFor(zipViewMode, () =>
          collectLiveReadCandidates({
            messages,
            agent,
            globalZipSettings,
            zipState: options.zipState,
            zipResolver: resolveZipForCompilation,
            agentMessagesFromEndByIndex,
            recoveryHoldByIndex,
            deadCopies: () => this.findHistoryDeadCopies(
              messages,
              resolveZipForCompilation,
              options.deadCopyProjectPath ?? null,
              agentMessagesFromEndByIndex
            ),
            groupToolSharing: options.groupToolSharing,
            replyMessageId: options.liveFileReadTurn?.replyMessageId ?? null,
            replyMessageIds: options.liveFileReadTurn?.replyMessageIds ?? null
          }), options.deadCopyProjectPath ?? null)
      : null
    // What `compileForAI` reads: the frozen outcomes plus every part of the turn's reply, read live
    // from the turn (a context continuation adds its id after the snapshot froze).
    const liveReads = liveSnapshot
      ? {
          copies: liveSnapshot.copies,
          strict: liveSnapshot.strict,
          replyMessageId: liveSnapshot.replyMessageId,
          ...(options.liveFileReadTurn?.replyMessageIds ? { replyMessageIds: options.liveFileReadTurn.replyMessageIds } : {}),
          missingReason: liveSnapshot.replayed ? 'not-in-replay' : 'not-refreshable'
        }
      : undefined
    // SA-129 P1 (DL-01): the dead copies among this pass's own tool results, built before the
    // history loop from the same zip reads it makes (the cache above), never shared.
    const deadCopies = await this.findHistoryDeadCopies(
      messages,
      resolveZipForCompilation,
      options.deadCopyProjectPath ?? null,
      agentMessagesFromEndByIndex
    )

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]

      if (
        message.role === 'assistant' &&
        !message.content?.trim() &&
        (!message.toolResults || message.toolResults.length === 0) &&
        !buildPreservedReasoningHistory(agent, message) &&
        !getActiveInterruptedReasoningRecoveryBlock({
          message,
          currentAgentId: typeof agent?.id === 'string' ? agent.id : null,
          active: interruptedReasoningRecoveryActiveByIndex[i] ?? false
        })
      ) {
        continue
      }

      // A message's pieces join the pass's list only when the message compiled: a fallback
      // delivers the stored text instead, not the tool results expanded before a throw.
      let messagePieces: PositionedAddressSource[] = []
      try {
        let compiled = ''

        if (message.role === 'user') {
          compiled = message.content || '[No content]'
        } else {
          compiled = await compileForAI(
            message.content || '',
            i,
            totalMessages,
            agent,
            message,
            globalZipSettings,
            {
              ...options,
              agentMessagesFromEnd: agentMessagesFromEndByIndex[i] ?? 0,
              recoveryHold: recoveryHoldByIndex[i] ?? false,
              interruptedReasoningRecoveryActive:
                interruptedReasoningRecoveryActiveByIndex[i] ?? false,
              zipResolver: resolveZipForCompilation,
              zipState: options.zipState,
              deadCopies,
              zipViewMode,
              onZipExposure:
                zipViewMode === 'appended'
                  ? (exposure) => zipExposures.push(exposure)
                  : undefined,
              onZipCompressed: (compression) => compressedZips.push(compression),
              onZipExposed: (exposed) => exposedZips.push(exposed),
              onDeliveredSource: (piece) => messagePieces.push(piece),
              liveReads
            }
          )

          const toolSummaryBlock = this.formatToolResultsSummaryForContext(
            message,
            zipToolNotesEnabled
          )
          if (toolSummaryBlock) {
            const withSummary = `${compiled}\n\n${toolSummaryBlock}`
            const leadingTrim = withSummary.length - withSummary.trimStart().length
            const trimmed = withSummary.trim()
            messagePieces = replaceAddressSourceRanges(messagePieces, 0, leadingTrim, '')
            messagePieces = replaceAddressSourceRanges(
              messagePieces, trimmed.length, withSummary.length - leadingTrim, ''
            )
            compiled = trimmed
          }
        }

        // SA-109: the ONE history site where clip placeholders reached the AI
        // view. Attached clips lose their marker (their content ships with the
        // send); departed clips leave a Clip Log where they rode. Runs for both
        // roles because artifact share-to-chat can write clip syntax too.
        const clipCompiled = compileClipReferencesForAiView(
          compiled,
          options?.activeClipIds,
          { clipNames: options?.clipNames, onReplace: (start,end,replacement)=>{
            messagePieces=replaceAddressSourceRanges(messagePieces,start,end,replacement,
              replacement ? {source:'batshit',text:replacement} : undefined)
          } }
        )
        if (clipCompiled !== compiled) {
          compiled = clipCompiled || EMPTY_COMPILED_MESSAGE_TEXT
        }

        const timestamp = message.timestamp
          ? new Date(message.timestamp)
          : (message as any).created_at
          ? new Date((message as any).created_at)
          : undefined

        const { formatted, currentDay: nextDay } = this.decorateCompiledMessage(
          compiled,
          message,
          timestamp,
          currentDay,
          i,
          speakers
        )

        // Built before the push, so nothing that can throw runs after the message is in the history
        // (a throw after it would push the fallback a second time).
        const messageSource: AddressSourcePiece = {
          source: this.resolveMessageAddressSource(message),
          text: compiled,
          messageId: message.id
        }
        formattedMessages.push(formatted)
        currentDay = nextDay
        addressSources.push(messageSource, ...materializeAddressSources(compiled,messagePieces))
      } catch (error) {
        formattedMessages.push(this.fallbackFormattedMessage(message, speakers))
        addressSources.push({
          source: this.resolveMessageAddressSource(message),
          text: message.content || EMPTY_COMPILED_MESSAGE_TEXT,
          messageId: message.id
        })
      }
    }

    // SA-128 (DL-01): the messages sit in `<conversation>`, one blank line apart; the tags are
    // the separator. The zip index follows the conversation as its own element.
    const baseHistory = compiledConversation(formattedMessages)
    const zipAppend =
      zipViewMode === 'appended' ? this.buildZipAppend(zipExposures, addressSources) : ''
    const chatHistory = zipAppend
      ? baseHistory
        ? `${baseHistory}\n\n${zipAppend}`
        : zipAppend
      : baseHistory

    // BL-1541: the older copies the dead-copy rule compressed in this pass because of the reply
    // that just finished. Their references never say why; the Zip Index does, this turn only.
    const deadCopiesThisTurn: DeadCopyThisTurn[] = []
    const listedDeadCopies = new Set<string>()
    for (const compression of compressedZips) {
      const zipId = normalizeId(compression.zipId)
      const dead = deadCopies.get(zipId)
      if (!compression.deadCopyNamed || !dead?.diedThisTurn || listedDeadCopies.has(zipId)) continue
      listedDeadCopies.add(zipId)
      deadCopiesThisTurn.push({ zipId, files: dead.files })
    }

    // SA-137 Round 2: the Read File copies Refreshed File Reads zipped this turn (grown past the size
    // guard, or not refreshed), each said once in the Zip Index, this turn only.
    const liveReadsThisTurn: LiveReadThisTurn[] = []
    const listedLiveReads = new Set<string>()
    for (const compression of compressedZips) {
      if (!compression.liveRead) continue
      const zipId = normalizeId(compression.zipId)
      if (listedLiveReads.has(zipId)) continue
      listedLiveReads.add(zipId)
      const readerName = compression.readerAgentId
        ? speakers.agentNames.get(compression.readerAgentId) ?? 'another agent'
        : null
      liveReadsThisTurn.push({
        zipId,
        file: compression.descriptionParts?.target || compression.description || 'a file read',
        liveRead: compression.liveRead,
        ...(readerName ? { readerName } : {})
      })
    }

    return { formattedMessages, currentDay, chatHistory, compressedZips, exposedZips, addressSources, deadCopiesThisTurn, liveReadsThisTurn }
  }

  /**
   * BL-474 step 2: the source of a history message as a whole. A user-role message Batshit wrote
   * for someone else is a note (as its `<note>` element says): from outside (a webhook) or another
   * agent's words (a DM, a schedule, an artifact share); every other non-assistant entry (a Compact
   * summary, a graduation gist, the Trim notice) is a summary; an assistant message is the agent's
   * words, its own or another agent's.
   */
  private resolveMessageAddressSource(message: Message): AddressSourceKind {
    if (message.role === 'user') {
      const metadata = (message as any)?.metadata
      if (!isBatshitWrittenUserMessage(metadata)) return 'user'
      return isOutsideNote(metadata) ? 'note' : 'agent_note'
    }
    return message.role === 'assistant' ? 'agent_words' : 'summary'
  }

  /**
   * SA-129 P2 (BL-333): the dead copies of a whole chat, for the badge and the Zip Manager, by the
   * rules and the project path a compile uses: the newest user message's project (what the browser
   * sent), else the agent's default project, else the default workspace; the agent is the newest
   * reply's. Each result is judged within its own author, as in every compile.
   */
  async findSessionDeadCopies(sessionId: string, userId: string): Promise<Map<string, DeadCopyReason>> {
    return (await this.findSessionZipFacts(sessionId, userId)).deadCopies
  }

  /**
   * SA-129 P2 and SA-137 P4 (D10): the chat's dead copies and what live file reads did for the
   * chat's newest reply, for the zip badges and the Zip Manager, from stored records only (no file is
   * read). The receipt (`live_file_reads:{sessionId}`) is `current` only while its reply is the
   * chat's newest reply and live file reads still resolve on for its agent; the dead copies are the
   * ledger's own, with no exemption (D3 amended, 2026-11-04), as every compile finds them. A receipt of an earlier reply is
   * `changed`. When the newest reply's agent has live file reads on but no usable receipt names that
   * reply (missing, expired, from an earlier app process, unreadable, or never prepared), the state is
   * `unknown` and that agent's own live-capable reads say so: never a guessed open or stale state.
   */
  async findSessionZipFacts(sessionId: string, userId: string): Promise<{ deadCopies: Map<string, DeadCopyReason>; liveReads: SessionLiveReadFacts | null }> {
    const messages = (await redis.getSessionMessages(sessionId)) as Message[]
    const newestUser = [...messages].reverse().find((message) => message.role === 'user')
    const newestReply = [...messages].reverse().find((message) => message.role === 'assistant' && message.agent_id)
    const agents = await redis.getAgents(userId)
    const requestedProjectPath =
      typeof (newestUser as any)?.metadata?.projectPath === 'string'
        ? ((newestUser as any).metadata.projectPath as string).trim()
        : ''
    let projectPath: string | null = requestedProjectPath || null
    if (!projectPath && newestReply?.agent_id) {
      const agent = agents.find((row) => row.id === newestReply.agent_id) ?? null
      if (agent) {
        const { agentDefaultProjectPath, defaultWorkspacePath } = await this.loadSystemPrompts(agent as AgentRow, userId)
        projectPath = agentDefaultProjectPath?.trim() || defaultWorkspacePath?.trim() || null
      }
    }
    const zipCache = new Map<string, Promise<any | null>>()
    const resolveZip = (zipId: string) => {
      if (!zipCache.has(zipId)) zipCache.set(zipId, redis.getZip(zipId))
      return zipCache.get(zipId)!
    }
    const { results } = await collectDeadCopyToolResults(messages, resolveZip)
    const liveReads = await this.findSessionLiveReadFacts(sessionId, userId, newestReply ?? null, agents, results)
    const reasons = new Map<string, DeadCopyReason>()
    for (const [zipId, dead] of findDeadCopies(results, { projectPath })) reasons.set(zipId, dead.reason)
    return { deadCopies: reasons, liveReads }
  }

  private async findSessionLiveReadFacts(
    sessionId: string,
    userId: string,
    newestReply: Message | null,
    agents: AgentRow[],
    results: Awaited<ReturnType<typeof collectDeadCopyToolResults>>['results']
  ): Promise<SessionLiveReadFacts | null> {
    if (!newestReply?.agent_id) return null
    let record: Awaited<ReturnType<typeof readLiveFileReadOutcome>> = null
    let unreadable = false
    try {
      record = await readLiveFileReadOutcome(sessionId, userId)
    } catch (error) {
      // A storage failure is unknown, never the OFF answer (D10).
      console.warn('[SA-137] The chat\'s live file read receipt could not be read; the badges say its state is unknown:', error instanceof Error ? error.message : error)
      unreadable = true
    }
    const receipts = [record?.pending ?? null, record?.delivered ?? null].filter(
      (receipt): receipt is LiveReadReceipt => Boolean(receipt) && (receipt!.delivery === 'prepared' || receipt!.delivery === 'issued')
    )
    const globalZipSettings = (await redis.getUserSettings(userId))?.global_zip_settings ?? null
    // Round 2: on, and available for that agent now (one rule with the route, R2-2).
    const host = readTypedFileToolsHost()
    const liveOnFor = (agentId: string) => {
      const agent = agents.find((row) => row.id === agentId) ?? null
      if (!agent || !resolveLiveFileReadsEnabled(agent as any, globalZipSettings as any)) return false
      return refreshedFileReadsUnavailableReason({
        primaryType: normalizePrimaryAgentType(agent),
        zipViewMode: resolveZipAiViewModeOf(agent as any, globalZipSettings as any),
        backend: this.resolveNativeBashDcmState(agent)?.backend ?? null,
        host
      }) === null
    }
    /**
     * The chat's Read File copies whose turn-start state a record would have said (strict freshness
     * decides every one: refreshed and shown, or zipped), minus `known`.
     */
    const liveCapableReads = (_agentId: string, known: Record<string, unknown> = {}) => results
      .filter((result) => result.operationKind === 'read_file' && !known[result.zipId])
      .map((result) => result.zipId)
      // Review N3: the newest copies first get a fact when the chat has more than the bound.
      .slice(-LIVE_FILE_READ_FACTS_MAX_COPIES)
    const at = (receipt: LiveReadReceipt) => receipt.issuedAt ?? receipt.preparedAt ?? receipt.reservedAt
    const receipt = receipts.find((candidate) => candidate.messageId === newestReply.id) ?? null
    if (!receipt) {
      if (liveOnFor(newestReply.agent_id)) {
        const copies: SessionLiveReadFacts['copies'] = {}
        for (const zipId of liveCapableReads(newestReply.agent_id)) copies[zipId] = { status: 'unknown' }
        return { state: 'unknown', replyId: newestReply.id, agentId: newestReply.agent_id, ...(unreadable ? { unknownReason: 'unreadable' } : { unknownReason: 'missing' }), copies, overflow: 0 }
      }
      const newest = receipts[0]
      return newest
        ? { state: 'changed', replyId: newest.messageId, agentId: newest.agentId, delivery: newest.delivery as 'prepared' | 'issued', at: at(newest), copies: {}, overflow: 0 }
        : null
    }
    const stillOn = liveOnFor(receipt.agentId)
    const copies: SessionLiveReadFacts['copies'] = {}
    if (stillOn) {
      for (const copy of receipt.copies ?? []) {
        copies[copy.zipId] = copy.status === 'refreshed'
          ? { status: 'refreshed', promptTokens: copy.promptTokens }
          : { status: 'static', reason: copy.reason }
      }
      // Copies the receipt could not hold: their outcome is unknown, never shown as live or stale.
      if ((receipt.overflow ?? 0) > 0) {
        for (const zipId of liveCapableReads(receipt.agentId, copies)) copies[zipId] = { status: 'unknown' }
      }
    }
    return {
      state: stillOn ? 'current' : 'changed',
      replyId: receipt.messageId,
      agentId: receipt.agentId,
      delivery: receipt.delivery as 'prepared' | 'issued',
      at: at(receipt),
      ...(receipt.replayUnavailable ? { replayUnavailable: receipt.replayUnavailable } : {}),
      ...(stillOn && receipt.strict === true ? { strict: true } : {}),
      copies,
      overflow: receipt.overflow ?? 0
    }
  }

  /**
   * SA-129 P1 (DL-01): every tool result this pass will compile, in chat order, read through the
   * pass's own zip resolver, then `findDeadCopies`. Each dead copy carries how many of its
   * author's replies had finished when it died (`agentMessagesFromEndByIndex` at its message
   * minus at the message that killed it), which decides whether the Zip Index names it
   * (BL-1541), its files, and whether it died in the reply that just finished (the newest
   * assistant message of `messages`, with the failed parts it continues). A zip that cannot be read is left out, so it can neither die nor
   * kill another copy.
   */
  private async findHistoryDeadCopies(
    messages: Message[],
    resolveZip: (zipId: string) => Promise<any | null>,
    projectPath: string | null,
    agentMessagesFromEndByIndex: number[]
  ): Promise<Map<string, HistoryDeadCopy>> {
    const { results, messageIndexByZip } = await collectDeadCopyToolResults(messages, resolveZip)
    // The reply that just finished: the newest assistant message and, when it continues a reply
    // that ran out of room, every failed part directly before it (`findContextContinuationTurn`);
    // a continuation run compiles no `<dynamic_info>`, so the next turn says it.
    const newestReplyIndex = messages.findLastIndex((message) => message?.role === 'assistant')
    let replyStartIndex = newestReplyIndex
    while (
      replyStartIndex > 0 &&
      messages[replyStartIndex - 1]?.role === 'assistant' &&
      (messages[replyStartIndex - 1] as any)?.metadata?.response_failed === true
    ) {
      replyStartIndex -= 1
    }

    const deadCopies = new Map<string, HistoryDeadCopy>()
    for (const [zipId, dead] of findDeadCopies(results, { projectPath })) {
      const readAt = messageIndexByZip.get(zipId) ?? dead.deadAtMessageIndex
      deadCopies.set(zipId, {
        reason: dead.reason,
        repliesUntilDead: Math.max(
          0,
          (agentMessagesFromEndByIndex[readAt] ?? 0) - (agentMessagesFromEndByIndex[dead.deadAtMessageIndex] ?? 0)
        ),
        files: dead.files,
        diedThisTurn: replyStartIndex >= 0 && dead.deadAtMessageIndex >= replyStartIndex
      })
    }
    return deadCopies
  }

  private formatToolResultsSummaryForContext(message: Message, notesEnabled = true): string {
    if (!notesEnabled) return ''
    const zipControl = (message as any)?.metadata?.zipControl
    const notes = Array.isArray(zipControl?.toolResultsSummary)
      ? zipControl.toolResultsSummary
      : Array.isArray(zipControl?.toolNotes)
        ? zipControl.toolNotes
        : []
    if (!notes.length) return ''

    const lines = notes
      .map((note: any) => {
        const summary =
          typeof note?.summary === 'string'
            ? note.summary.replace(/\s+/g, ' ').trim()
            : ''
        if (!summary) return ''
        const label = note?.toolName || note?.toolCallId || 'Tool'
        return `- ${label}: ${summary}`
      })
      .filter(Boolean)

    if (!lines.length) return ''
    return `==== TOOL RESULTS SUMMARY (for this message) ====\n${lines.join('\n')}`
  }

  async prepareGroupHistory(
    sessionId: string,
    messages: Message[],
    agent: any,
    userId?: string,
    options?: {
      fetch?: typeof fetch
      globalZipSettingsOverride?: Record<string, any>
      zipSettingsAgentOverride?: any
      groupContext?: GroupChatDcmContext
      groupToolSharing?: {
        currentAgentId?: string | null
        sharedTools?: string[]
      }
      /** SA-137: the speaker's live-read turn; its snapshot is the one the speaker's compile uses. */
      liveFileReadTurn?: Pick<LiveFileReadTurn, 'snapshotFor'> & Partial<Pick<LiveFileReadTurn, 'replyMessageId' | 'replyMessageIds'>>
    }
  ): Promise<PrecompiledHistory> {
    this.assertCompilablePrimary(agent)
    const fetchImpl = options?.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined)

    const {
      globalZipSettings: loadedGlobalZipSettings,
      agentDefaultProjectPath,
      defaultWorkspacePath
    } = await this.loadSystemPrompts(agent, userId)
    const globalZipSettings =
      options?.globalZipSettingsOverride ?? loadedGlobalZipSettings
    const historyAgent =
      options?.zipSettingsAgentOverride !== undefined
        ? options.zipSettingsAgentOverride
        : agent

    const agentForHistory = normalizePrimaryAgentType(agent) === 'api'
      ? { ...historyAgent, api_reasoning_retention: resolveApiReasoningRetention(agent).mode }
      : historyAgent

    // F-P5-11: this pass's own zip state, read from Redis. Server compiles overlap in one
    // process, so none of them reads or writes the browser's `zippingService` singleton.
    const skillZipState = await this.loadSkillAwareZipState(sessionId, userId, false)
    const zipState = createZipStateView(skillZipState.unzipped, skillZipState.rezipped)
    const groupMessages = skillZipState.record && agent?.id ? await recoverOpenSkillReadMessages({
      record: skillZipState.record, agentId: agent.id, messages, unzipped: skillZipState.unzipped,
      groupToolSharing: options?.groupToolSharing
    }) : messages
    const speakers = await this.buildSpeakerView(groupMessages, agent, options?.groupContext)

    // SA-109: group runs compile history once and reuse it per speaker, so the
    // clip rewrite has to happen here too — no lane keeps raw clip syntax.
    const clipCompileState = await this.resolveSessionClipCompileState(
      sessionId,
      userId,
      fetchImpl
    )

    const { formattedMessages, currentDay, chatHistory, addressSources, liveReadsThisTurn } = await this.compileChatHistory(
      groupMessages,
      agentForHistory,
      globalZipSettings,
      {
        ...options,
        zipState,
        // SA-129 P1: a group run has no per-send project path; the agent's default stands in.
        deadCopyProjectPath: agentDefaultProjectPath?.trim() || defaultWorkspacePath?.trim() || null,
        zipOwner: { sessionId, userId: userId ?? null },
        activeClipIds: clipCompileState.activeClipIds,
        clipNames: clipCompileState.clipNames
      },
      speakers
    )

    return {
      formattedMessages,
      currentDay,
      chatHistory: chatHistory ?? compiledConversation(formattedMessages),
      globalZipSettings,
      addressSources,
      liveReadsThisTurn
    }
  }

  /**
   * SA-128 (DL-01, DL-03, DP-1): the new message is a `<user>` element with the time (plus the
   * date when the day changed or there is no history). A current message Batshit wrote (a
   * woken turn, a group follow-up, the artifact share follow-up, the voice session seed) is a
   * `<note>`: nobody gets to put words in the user's mouth.
   */
  private formatCurrentUserMessage(
    currentUserMessage: string,
    lastMessageDay: string | null,
    hasHistory: boolean,
    from: CurrentMessageFrom = 'user',
    at?: Date
  ) {
    const now = at ?? new Date()
    const nowDay = now.toLocaleDateString('en-US')
    const includeDate = !hasHistory || nowDay !== lastMessageDay
    const timestamp = this.formatTimestamp(now, includeDate)
    return compiledElement(from === 'batshit' ? COMPILED_TAG.note : COMPILED_TAG.user, currentUserMessage, [
      ['time', timestamp]
    ])
  }

  private getPreviousDynamicSnapshot(messages: Message[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.role !== 'user') continue
      const metadata = (message as any)?.metadata || {}
      return {
        projectPath: typeof metadata.projectPath === 'string' ? metadata.projectPath : null,
        projectRules:
          metadata.projectRules && typeof metadata.projectRules === 'object'
            ? metadata.projectRules
            : null,
        fileReferences: Array.isArray(metadata.fileReferences) ? metadata.fileReferences : []
      }
    }
    return null
  }

  private buildZipStateSnapshot(
    messages: Message[],
    unzipped: UnzippedItem[],
    deadCopies: Map<string, DeadCopyReason> = new Map(),
    sizeGuards: Map<string, ToolResultSizeGuard> = new Map(),
    deadCopiesThisTurn: DeadCopyThisTurn[] = [],
    liveReadsThisTurn: LiveReadThisTurn[] = []
  ) {
    const hasZipHistory =
      unzipped.length > 0 ||
      messages.some((message) => {
        const metadata = (message as any)?.metadata || {}
        if (Array.isArray(metadata?.zipIds) && metadata.zipIds.length > 0) return true
        if (Array.isArray(metadata?.zip_ids) && metadata.zip_ids.length > 0) return true
        if (typeof message?.content !== 'string') return false
        const refs = extractAllReferences(message.content)
        return refs.some((ref) => ref.type === 'zip')
      })

    return {
      hasZipHistory,
      unzipped,
      deadCopies,
      sizeGuards,
      deadCopiesThisTurn,
      liveReadsThisTurn
    }
  }

  /**
   * Decision 5 (Josh, 2026-10-23): the Zip Index's status sections, which were the DCM's `Current
   * Zip State` until then: one home for every Zip fact. Each section is said only when it has
   * something (`withZipIndexStatus` places them at the top of `<zip_index>`). The Zip Index sits in
   * the tail after `</conversation>`, rewritten every turn like the DCM, so the live counts cost no
   * cache. A held copy is said once, on its Zip Holds line (BL-1541, BL-2042), never under Zipped
   * this turn as well.
   */
  private buildZipIndexStatusLines(options: {
    zipState: ZipIndexStatusState
    autoZipContent: string[]
    autoZipTools: string[]
    agentId: string | null
  }): string[] {
    const { zipState, autoZipContent, autoZipTools } = options
    const unzipped = Array.isArray(zipState.unzipped) ? zipState.unzipped : []
    const settings = [
      ...(autoZipContent.length > 0 ? [`- Auto-zipped content: ${autoZipContent.join(', ')}`] : []),
      ...(autoZipTools.length > 0 ? [`- Auto-zipped tools: ${autoZipTools.join(', ')}`] : [])
    ]
    // BL-1541: the one place the agent learns why an older copy compressed, on that turn
    // only; its reference keeps its plain label. A copy an agent holds keeps its hold line.
    // Both ids are state ids already; `normalizeId` is not safe to apply twice (BL-853).
    const agentHeld = new Set(unzipped.filter(isAgentHold).map((item) => item.zipId))
    const compressedThisTurn = describeDeadCopiesCompressedThisTurn(
      (zipState.deadCopiesThisTurn ?? []).filter((copy) => !agentHeld.has(copy.zipId))
    )
    // SA-137 Round 2: each Read File copy Refreshed File Reads zipped this turn, once; a held one
    // says it on its hold line, which it replaces the size words on (BL-2042: never "fetch it").
    const liveReadsThisTurn = new Map((zipState.liveReadsThisTurn ?? []).map((copy) => [copy.zipId, copy] as const))
    const heldIds = new Set(unzipped.map((item) => normalizeId(item.zipId)))
    const zippedThisTurn = [
      ...(compressedThisTurn ? [compressedThisTurn] : []),
      ...buildLiveReadStateLines(zipState.liveReadsThisTurn ?? [], heldIds)
    ]
    const describe = (item: UnzippedItem) => {
      const liveRead = liveReadsThisTurn.get(normalizeId(item.zipId))
      const line = describeUnzippedItemForDcm(item, {
        agentId: options.agentId,
        deadCopy: zipState.deadCopies?.get(normalizeId(item.zipId)) ?? null,
        sizeGuard: liveRead ? undefined : zipState.sizeGuards?.get(normalizeId(item.zipId)) ?? null
      })
      return liveRead ? `${line} | ${describeLiveReadThisTurn(liveRead.liveRead)}` : line
    }
    // A Judge Juice open is no hold (SA-120 P5), so it has its own heading.
    const holds = unzipped.filter((item) => item.source !== 'inferred').map(describe)
    const judgeJuice = unzipped.filter((item) => item.source === 'inferred').map(describe)
    const sections = [
      settings.length > 0 ? [`${ZIP_INDEX_STATUS_HEADINGS.settings}:`, ...settings] : [],
      zippedThisTurn.length > 0 ? [`${ZIP_INDEX_STATUS_HEADINGS.zippedThisTurn}:`, ...zippedThisTurn] : [],
      holds.length > 0 ? [`${ZIP_INDEX_STATUS_HEADINGS.holds}:`, ...holds] : [],
      judgeJuice.length > 0 ? [`${ZIP_INDEX_STATUS_HEADINGS.judgeJuice}:`, ...judgeJuice] : []
    ].filter((section) => section.length > 0)
    return sections.flatMap((section, index) => (index === 0 ? section : ['', ...section]))
  }

  private buildAutoZipSummary(options: {
    agent?: any
    globalZipSettings?: Record<string, any>
  }) {
    const agent = options.agent ?? {}
    const globalZipSettings = options.globalZipSettings ?? {}
    const autoZipContent = new Set<string>()
    const autoZipTools = new Set<string>()

    const contentTypes = ['error', 'image']
    for (const type of contentTypes) {
      const settings = getTypeZipSettings(type, agent, globalZipSettings)
      if (settings.autoZip) autoZipContent.add(type)
    }

    const subagentSettings = getToolSettings('subagent', agent, globalZipSettings)
    if (subagentSettings.auto_zip) autoZipTools.add('subagent')

    const commonTools = ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_files']
    for (const tool of commonTools) {
      const settings = getToolSettings(tool, agent, globalZipSettings, {
        ignoreCustomToolSettings: shouldPreferFieldSettingsForTool(tool)
      })
      if (settings.auto_zip) autoZipTools.add(tool)
    }

    const resolveBooleanSetting = (key: string): boolean | undefined => {
      if (typeof agent?.[key] === 'boolean') return agent[key]
      if (typeof globalZipSettings?.[key] === 'boolean') return globalZipSettings[key]
      return undefined
    }

    // An absent row inherits the factory default, as `getToolSettings` resolves it for an
    // unmapped tool; a new agent record carries no stored zip row (SA-126, 2026-10-19).
    const allOtherAutoZip =
      resolveBooleanSetting('auto_zip_all_other_tools') ?? categoryDefaults.allOther.auto_zip === true
    if (allOtherAutoZip && resolveBooleanSetting('zip_disabled_all_other_tools') !== true) {
      autoZipTools.add('all_other_tools')
    }

    const customNames = new Set<string>()
    const globalCustom = Array.isArray(globalZipSettings?.custom_tool_settings)
      ? globalZipSettings.custom_tool_settings
      : []
    const agentCustom = Array.isArray(agent?.custom_tool_settings)
      ? agent.custom_tool_settings
      : []
    for (const tool of [...globalCustom, ...agentCustom]) {
      if (tool?.tool_name) {
        customNames.add(tool.tool_name)
      }
    }

    for (const toolName of customNames) {
      if (shouldPreferFieldSettingsForTool(toolName)) continue
      const settings = getToolSettings(toolName, agent, globalZipSettings)
      if (settings.auto_zip) autoZipTools.add(toolName)
    }

    return {
      autoZipContent: Array.from(autoZipContent),
      autoZipTools: Array.from(autoZipTools)
    }
  }

  private buildVoiceRuntimeDcmLines(voiceState?: VoiceState): string[] {
    if (!voiceState) return []

    const ttsOn = Boolean(voiceState.tts)
    const sttOn = Boolean(voiceState.stt)
    const voiceMode = String(voiceState.voiceMode ?? '').toLowerCase()
    const spokenReply =
      ttsOn ||
      voiceMode === 'voice' ||
      voiceMode === 'hybrid' ||
      voiceMode === 'speech-to-speech'
    const guidance = spokenReply && Array.isArray(voiceState.guidance)
      ? voiceState.guidance.map((line) => line.trim()).filter(Boolean)
      : []
    const provider = spokenReply ? voiceState.provider?.trim() : ''

    if (!sttOn && !spokenReply) return []

    const lines: string[] = []
    if (sttOn) {
      lines.push(
        'Speech input: the user spoke this message and speech-to-text (STT) transcribed it; expect homophones/names/word-form errors (e.g., "Mike check" may mean "mic check") and ignore [BLANK AUDIO].'
      )
    }
    if (spokenReply) {
      lines.push(
        'Voice Mode: your reply will be spoken aloud; keep it conversational, usually 1-3 short sentences, and avoid bullets/long lists unless the user asks.'
      )
    }
    if (provider) {
      lines.push(`Provider: ${provider}`)
    }
    lines.push(...guidance)
    return lines
  }

  private async buildDynamicMcpDcm(options: {
    apiUtilityScope?: ApiUtilityScope
    /** Server-resolved turn selection; undefined keeps non-turn preview defaults. */
    mcpGatewayScope?: string[]
    p5McpOwner?: import('$lib/server/services/appActions/mcp/originalTask').P5OriginalPreparation
    userId?: string | null
    agentId?: string | null
    projectPath?: string | null
    nativeDynamicMcpEnabled?: boolean | null
    nativeCliToolsEnabled?: boolean | null
    whiteboardControlsEnabled?: boolean
    providerSettings?: unknown
    memoryControlsEnabled?: boolean
    dmControlsEnabled?: boolean
    scheduleControlsEnabled?: boolean
    judgeControlsEnabled?: boolean
    featureHintGates?: Parameters<typeof buildDynamicMcpIndex>[0]['featureHintGates']
  }): Promise<AgentSetupToolIndex> {
    const empty: AgentSetupToolIndex = { text: '', discoverable: [], resolvedGatewayIds: null, setupBlocks: [], sources: [], hintBudget: { limit: 3000, budgetedTokens: 0, featureTokens: 0 }, apiUtilityProjection: 'unprepared' }
    const userId = options.userId?.trim()
    const agentId = options.agentId?.trim()
    if (options.p5McpOwner) {
      const owner = await import('$lib/server/services/appActions/mcp/originalTask')
      const identity = owner.readP5ApiManagementIdentity(options.p5McpOwner)
      if (identity.userId !== userId || identity.agentId !== agentId) throw new Error('The original API discovery identity changed.')
    }
    if (!userId || !agentId) return empty

    try {
      const result = await buildDynamicMcpIndex({
        apiUtilityScope: options.apiUtilityScope,
        primarySettingsActor: true,
        providerSettings: options.providerSettings,
        memoryControlsEnabled: options.memoryControlsEnabled,
        dmControlsEnabled: options.dmControlsEnabled,
        scheduleControlsEnabled: options.scheduleControlsEnabled,
        judgeControlsEnabled: options.judgeControlsEnabled,
        featureHintGates: options.featureHintGates,
        userId,
        agentId,
        selectedGateways: options.mcpGatewayScope,
        p5McpOwner: options.p5McpOwner,
        projectPath: options.projectPath ?? null,
        nativeDynamicMcpEnabled: options.nativeDynamicMcpEnabled,
        cliToolsEnabled:
          typeof options.nativeCliToolsEnabled === 'boolean'
            ? options.nativeCliToolsEnabled
            : undefined,
        whiteboardControlsEnabled: options.whiteboardControlsEnabled
      })
      return {
        text: typeof result.text === 'string' ? result.text : '',
        discoverable: Array.isArray(result.discoverable) ? result.discoverable : [],
        resolvedGatewayIds: result.resolvedGatewayIds ?? null,
        setupBlocks: result.setupBlocks, sources: result.sources, hintBudget: result.hintBudget, apiUtilityProjection: result.apiUtilityProjection,
        allowedSkillToolHints: result.allowedSkillToolHints, completeFeatureHintRefs: result.completeFeatureHintRefs
      }
    } catch (error) {
      if (options.p5McpOwner) {
        const owner = await import('$lib/server/services/appActions/mcp/originalTask')
        const identity = owner.readP5ApiManagementIdentity(options.p5McpOwner)
        if (identity.userId !== userId || identity.agentId !== agentId) throw error
        if (owner.p5ApiHasVerifiedMcpSource(options.p5McpOwner)) throw error
      }
      console.warn('[buildDynamicInfoBlock] Failed to build MCP DCM index:', error)
      throw error
    }
  }

  private async buildSkillsCommandsDcm(options: {
    userId?: string | null
    agentId?: string | null
  }): Promise<{ lines: string[]; capabilities: AgentSlashCapability[] }> {
    const userId = options.userId?.trim()
    const agentId = options.agentId?.trim()
    if (!userId || !agentId) return { lines: [], capabilities: [] }

    try {
      const capabilities = await getEnabledAgentSlashCapabilities(userId, agentId)
      return { lines: buildSkillsCommandsDcmLines(capabilities), capabilities }
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to load skills/commands DCM index:', error)
      throw error
    }
  }

  private async fetchGoonRecord(options: {
    goonId?: string | null
    userId?: string | null
  }): Promise<GoonRecord | null> {
    const goonId = options.goonId?.trim()
    if (!goonId) return null
    const cacheKey = `${options.userId ?? 'anon'}:${goonId}`

    const cached = GOON_DCM_CACHE.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < GOON_DCM_CACHE_TTL_MS) {
      return cached.goon
    }

    try {
      const goon = await redis.execute(async (client) => {
        const data = await client.json.get(`goon:${goonId}`)
        return data as GoonRecord | null
      })
      if (goon && (!options.userId || goon.user_id === options.userId)) {
        GOON_DCM_CACHE.set(cacheKey, { goon, fetchedAt: Date.now() })
        return goon
      }
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to load goon record:', error)
    }

    return null
  }

  private async buildGoonDcmLines(options: {
    goonId?: string | null
    goonsEnabled?: boolean
    userId?: string | null
    goonsSettings?: GoonsSettings | null
    voiceState?: VoiceState
    goonPresentationMode?: DesktopGoonPresentationMode | null
  }): Promise<string[]> {
    const dockOpen =
      typeof options.goonsEnabled === 'boolean'
        ? options.goonsEnabled
        : Boolean(options.goonsSettings?.dockOpen)
    if (!dockOpen) return []
    const goon = await this.fetchGoonRecord({
      goonId: options.goonId,
      userId: options.userId
    })
    if (!goon) return []
    return formatGoonDcmLines(
      goon,
      {
        includeSpokenCues: shouldIncludeGoonSpokenCues(options.voiceState),
        presentationMode: options.goonPresentationMode
      },
      options.goonsSettings
    )
  }

  private buildWorkersSetupLine(agent: any): string {
    if (!WORKERS_FEATURE_ENABLED) return ''
    return resolveWorkersEnabled(agent)
      ? `workers: enabled (max ${WORKERS_MAX_CONCURRENT} parallel)`
      : 'workers: disabled'
  }

  private async buildDynamicInfoBlock(options: {
    sessionId?: string
    openSkillSessions?: OpenSkillSession[]
    allowUnpreparedSkillHints?: boolean
    toolIndex: AgentSetupToolIndex
    skillsCommandsDcm: { lines: string[]; capabilities: AgentSlashCapability[] }
    /** Server-resolved turn selection; undefined keeps non-turn preview defaults. */
    mcpGatewayScope?: string[]
    p5McpOwner?: import('$lib/server/services/appActions/mcp/originalTask').P5OriginalPreparation
    userId?: string | null
    currentUserMessage?: string | null
    agentId?: string | null
    projectPath?: string | null
    agentDefaultProjectPath?: string | null
    projectRules?: Record<string, any> | null
    fileReferences?: FileReferencePayload[]
    defaultWorkspacePath?: string | null
    nativeDynamicMcpEnabled?: boolean | null
    previousSnapshot?: {
      projectPath?: string | null
      projectRules?: Record<string, any> | null
      fileReferences?: FileReferencePayload[]
    } | null
    goonId?: string | null
    goonsEnabled?: boolean
    goonsSettings?: GoonsSettings | null
    goonPresentationMode?: DesktopGoonPresentationMode | null
    groupContext?: GroupChatDcmContext
    voiceState?: VoiceState
    controlErrorLines?: string[]
    /** SA-104 P4: preformatted "Memory context:" lines from the recall engine. */
    memoryDcmLines?: string[]
    /** SA-109 (DL-109-04): the general clip roster — all agents, groups included. */
    clipRosterDcmLines?: string[]
    /** SA-113 P2 (DL-113-04b): the `DMs:` roster — open inbox items only. */
    dmRosterDcmLines?: string[]
    /** SA-110 (DL-110-01): the episode whiteboard section (Infinite Sessions only). */
    whiteboardDcmLines?: string[]
    whiteboardControlsEnabled?: boolean
    /** SA-110 P2 (DL-110-05): awareness changes newer than the stored fold snapshot. */
    awarenessPendingDcmLines?: string[]
    /**
     * SA-120 P1 (DL-120-05): the route-owned Judge Juice hint provider. Called once with the
     * agent's skills and discoverable refs after every other section is built; its lines
     * close the DCM (the cache-free tail). Absent on subagent and group compiles.
     */
    jevJuiceHintProvider?: JevJuiceHintProvider
  }): Promise<{ text: string; addressSourcePieces: AddressSourcePiece[]; openSkillsText: string }> {
    const statusIcons = {
      new: '\u2705',
      updated: '\u2733\uFE0F',
      current: '\u{1F7E2}'
    }
    const statusKey = `Status key: ${statusIcons.new} new | ${statusIcons.updated} updated | ${statusIcons.current} unchanged`

    const normalizeList = (list: Array<string | null | undefined>) =>
      list
        .map((value) => (value ?? '').trim())
        .filter(Boolean)
        .sort()
        .join('|')

    const normalizeFileRefs = (refs: FileReferencePayload[] = []) =>
      normalizeList(
        refs.map((ref) =>
          [
            ref.path,
            ref.status ?? '',
            ref.type ?? '',
            typeof ref.size === 'number' ? String(ref.size) : ''
          ].join('::')
        )
      )

    const isEmptyValue = (value: string) => !value.trim()

    const resolveStatus = (current: string, previous: string) => {
      const currentEmpty = isEmptyValue(current)
      const previousEmpty = isEmptyValue(previous)

      if (currentEmpty && previousEmpty) return statusIcons.current
      if (!currentEmpty && previousEmpty) return statusIcons.new
      if (currentEmpty && !previousEmpty) return statusIcons.updated
      return current === previous ? statusIcons.current : statusIcons.updated
    }

    const lines: string[] = []
    const openContext = options.userId && options.agentId && options.sessionId
      ? await buildOpenSkillContext({ actor: { userId: options.userId, sessionId: options.sessionId, agentId: options.agentId },
        skills: options.openSkillSessions, toolIndex: options.toolIndex, allowUnprepared: options.allowUnpreparedSkillHints })
      : { lines: buildOpenSkillsDcmLines(options.openSkillSessions ?? []), text: buildOpenSkillsDcmLines(options.openSkillSessions ?? []).join('\n') }
    lines.push(...openContext.lines)
    const explicitProjectPath = options.projectPath?.trim()
    const agentDefaultProjectPath = options.agentDefaultProjectPath?.trim()
    const fallbackProjectPath = options.defaultWorkspacePath?.trim()
    const resolvedProjectPath =
      explicitProjectPath || agentDefaultProjectPath || fallbackProjectPath || ''
    const projectRules =
      options.projectRules &&
      typeof options.projectRules === 'object' &&
      !Array.isArray(options.projectRules)
        ? options.projectRules
        : null

    const groupContext = options.groupContext
    if (groupContext?.agentOrder && groupContext.agentOrder.length > 0) {
      const agentOrder = groupContext.agentOrder
      const agentNames = groupContext.agentDisplayNames ?? {}
      const currentAgentId = groupContext.currentAgentId ?? null
      const currentAgentName = currentAgentId ? agentNames[currentAgentId] ?? currentAgentId : ''
      const userName = groupContext.userDisplayName?.trim() || 'User'

      lines.push('Group chat: yes')
      if (currentAgentName) {
        lines.push(`You are: ${currentAgentName}`)
      }

      const participantParts = [
        `User (${userName})`,
        ...agentOrder.map((id) => {
          const name = agentNames[id] ?? id
          return id === currentAgentId ? `AI (you: ${name})` : `AI (${name})`
        })
      ]
      lines.push(`Participants: ${participantParts.join(', ')}`)

      // SA-128 (DP-3): the history names every agent (`<assistant>` is you, `<agent name>` is
      // anyone else), so the presets name them too; there is no letter map any more.
      const presets = agentOrder.map((id) => {
        const settings = groupContext.speakPolicies?.[id]
        const policy = settings?.speak_policy ?? 'balanced'
        const topics = Array.isArray(settings?.speak_topics) ? settings?.speak_topics : []
        const topicSuffix =
          policy === 'topic_only'
            ? `(${topics.length > 0 ? topics.join(', ') : 'no topics'})`
            : ''
        return `${agentNames[id] ?? id}=${policy}${topicSuffix}`
      })
      if (presets.length > 0) {
        lines.push(`Presets: ${presets.join(', ')}`)
      }

      if (groupContext.driverMode && groupContext.driverAgentId) {
        const driverName =
          agentNames[groupContext.driverAgentId] ?? groupContext.driverAgentId
        lines.push(`Driver: ${driverName}`)
        lines.push(
          'Driver behavior: default first responder unless one specific agent is explicitly addressed.'
        )
      }

      if (typeof groupContext.maxFollowupsTotal === 'number') {
        if (groupContext.maxFollowupsTotal <= 0) {
          lines.push('Follow-ups: unlimited (0)')
        } else {
          lines.push(`Follow-ups: max ${groupContext.maxFollowupsTotal} additional turns`)
        }
      }

      const voiceState = options.voiceState
      if (voiceState) {
        const ttsOn = Boolean(voiceState.tts)
        const sttOn = Boolean(voiceState.stt)
        const voiceOn = ttsOn || sttOn
        lines.push(
          `Voice: ${voiceOn ? 'on' : 'off'} (TTS: ${ttsOn ? 'on' : 'off'}, STT: ${sttOn ? 'on' : 'off'})`
        )
      }

      lines.push('')
    }

    const voiceState = options.voiceState
    const voiceRuntimeLines = this.buildVoiceRuntimeDcmLines(voiceState)
    if (voiceRuntimeLines.length > 0) {
      lines.push('Voice runtime context:')
      lines.push(...voiceRuntimeLines)
      lines.push('')
    }

    lines.push(statusKey, '')

    if (options.controlErrorLines && options.controlErrorLines.length > 0) {
      lines.push(...options.controlErrorLines, '')
    }

    const skillsCommandsDcm = options.skillsCommandsDcm

    const skillSessionContextLines = await buildSkillSessionContextLines({
      userId: options.userId,
      currentUserMessage: options.currentUserMessage
    })
    if (skillSessionContextLines.length > 0) {
      lines.push('', ...skillSessionContextLines)
    }

    const fileReferences = Array.isArray(options.fileReferences)
      ? options.fileReferences
      : []
    if (fileReferences.length > 0) {
      const currentFileRefsKey = normalizeFileRefs(fileReferences)
      const previousFileRefsKey = normalizeFileRefs(options.previousSnapshot?.fileReferences || [])
      const fileRefsStatus = resolveStatus(currentFileRefsKey, previousFileRefsKey)
      const fileReferenceBlock = buildFileReferenceBlock(fileReferences).trim()
      if (fileReferenceBlock) {
        const refLines = fileReferenceBlock.split('\n').filter(Boolean)
        if (refLines[0]?.toLowerCase().startsWith('file references')) {
          refLines.shift()
        }
        lines.push(`${fileRefsStatus} file_refs:`)
        lines.push(...refLines)
      }
    }

    // SA-109 (DL-109-04): the clip roster sits immediately ahead of the memory
    // section as its sibling, using the same Current / Lingering vocabulary.
    // Omitted entirely when nothing is attached, so clip-free sends pay nothing.
    if (options.clipRosterDcmLines && options.clipRosterDcmLines.length > 0) {
      lines.push('', ...options.clipRosterDcmLines)
    }

    // SA-113 P2 (DL-113-04b): the DM roster is the third member of the "durable
    // per-agent state you should act on" family — Clips, DMs, Memory, in that order.
    // Open items only, so a closed DM stops costing tokens the moment it is closed;
    // omitted entirely for every agent without DMs, which keeps their bytes identical.
    let dmRosterLineRange: { start: number; end: number } | null = null
    if (options.dmRosterDcmLines && options.dmRosterDcmLines.length > 0) {
      const start = lines.length + 1 // the blank line below separates this DCM section
      lines.push('', ...options.dmRosterDcmLines)
      dmRosterLineRange = { start, end: lines.length }
    }

    // SA-104 P4: the recall engine's memory-insert section (time awareness, Current /
    // Lingering grouping, more-available honesty) — preformatted server-side so both
    // compiled lines stay byte-stable (DL-104-17).
    if (options.memoryDcmLines && options.memoryDcmLines.length > 0) {
      lines.push('', ...options.memoryDcmLines)
    }

    // SA-110 P2 (DL-110-05): awareness changes newer than the stored fold snapshot
    // ride here — active immediately, folding into the SP block only at cache-dead
    // boundaries so mid-session awareness work never resets the prefix cache.
    if (options.awarenessPendingDcmLines && options.awarenessPendingDcmLines.length > 0) {
      lines.push('', ...options.awarenessPendingDcmLines)
    }

    // One current-board fragment after history, independent of a memory section.
    // It is frozen within the reply; a save changes only the next new-turn compile.
    if (options.whiteboardDcmLines && options.whiteboardDcmLines.length > 0) {
      lines.push('', ...options.whiteboardDcmLines)
    }

    const goonLines = await this.buildGoonDcmLines({
      goonId: options.goonId,
      goonsEnabled: options.goonsEnabled,
      userId: options.userId,
      goonsSettings: options.goonsSettings,
      voiceState: options.voiceState,
      goonPresentationMode: options.goonPresentationMode
    })
    if (goonLines.length > 0) {
      lines.push('', ...goonLines)
    }

    const { discoverable, resolvedGatewayIds } = options.toolIndex

    // SA-120 P1 (DL-120-05): Judge Juice hints close the DCM. The provider owns the network
    // call, its deadline, and its evidence; the compiler only appends what comes back.
    // A provider that throws is a bug — logged loudly, and the turn ships without hints.
    if (options.jevJuiceHintProvider) {
      try {
        const hintLines = await options.jevJuiceHintProvider({
          currentUserMessage: options.currentUserMessage ?? '',
          skills: skillsCommandsDcm.capabilities,
          discoverable,
          resolvedGatewayIds
        })
        if (Array.isArray(hintLines) && hintLines.length > 0) {
          lines.push('', ...hintLines)
        }
      } catch (error) {
        console.error('[buildDynamicInfoBlock] Judge Juice hint provider threw; no hint lines this turn:', error)
      }
    }

    if (!lines.length) return { text: '', addressSourcePieces: [], openSkillsText: '' }
    // SA-128 (DL-04): one `<dynamic_info>` element; the base prompts say it is Batshit's
    // context for this turn (never stored), not the user speaking.
    const text = compiledElement(COMPILED_TAG.dynamicInfo, lines.join('\n'))
    const addressSourcePieces = dmRosterLineRange
      ? [
          {
            source: 'batshit' as const,
            text: lines.slice(0, dmRosterLineRange.start - 1).join('\n')
          },
          {
            source: 'agent_note' as const,
            text: lines.slice(dmRosterLineRange.start, dmRosterLineRange.end).join('\n')
          },
          {
            source: 'batshit' as const,
            text: lines.slice(dmRosterLineRange.end).join('\n')
          }
        ]
      : [{ source: 'batshit' as const, text }]
    return { text, addressSourcePieces, openSkillsText: openContext.text }
  }

  // ========== Complex buildFormattedChatInput - Keep in main class for now ==========
  // Build formatted chat input using compilation
  async buildFormattedChatInput(
    sessionId: string,
    messages: Message[],
    agent: any,
    currentUserMessage?: string,
    assignedSubagents?: any[],
    userId?: string,
    options?: {
      /** Actual API send finalizes after its real tool bundle is prepared. */
      deferAgentSetup?: boolean
      agentSetupSend?: boolean
      /** Same server turn overrides supplied to native Bash registration. */
      groupMemberRun?: boolean
      toolApprovalMode?: ToolApprovalMode
      /** Same server-resolved turn scope used by execution and credentials. */
      mcpGatewayScope?: string[]
    p5McpOwner?: import('$lib/server/services/appActions/mcp/originalTask').P5OriginalPreparation
      fetch?: typeof fetch
      projectPath?: string | null
      projectRules?: Record<string, any> | null
      fileReferences?: FileReferencePayload[]
      precompiledHistory?: PrecompiledHistory
      groupContext?: GroupChatDcmContext
      voiceState?: VoiceState
      goonsSettings?: GoonsSettings | null
      goonsEnabled?: boolean
      goonPresentationMode?: DesktopGoonPresentationMode | null
      /** SA-120 P1: route-owned Judge Juice hint provider; primary lanes only. */
      jevJuiceHintProvider?: JevJuiceHintProvider
      /**
       * SA-120 P4b: route-owned Judge Juice recall-by-meaning provider, handed straight to
       * the recall engine. Absent (every caller but an eligible `send-routed` turn), the
       * memory section compiles exactly as it always has.
       */
      jevJuiceMemoryRecallProvider?: MemoryInferredRecallProvider
      /**
       * SA-120 P5: route-owned Judge Juice smart-zip provider. Called once, after the first
       * history pass, with the zips that pass left compressed; the zips it returns are
       * expanded for THIS compile through an in-memory overlay and one more history pass.
       * The compile writes nothing (the route stores the state at the accepted-send
       * boundary). Absent, history compiles exactly once, as it always has.
       */
      jevJuiceSmartZipProvider?: JevJuiceSmartZipProvider
      /** SA-120 P5: told what the final history pass left expanded (only beside the provider above). */
      jevJuiceSmartZipExposedObserver?: (exposed: ZipExposed[]) => void
      /**
       * SA-128 (DP-1): who wrote the current message. `batshit` compiles it as a `<note>` (a
       * woken turn, a group follow-up, the artifact share follow-up, the voice session seed);
       * absent, it is the user's own message.
       */
      currentMessageFrom?: CurrentMessageFrom
      /**
       * BL-322: when the current message was written. An approval resume compiles the paused
       * turn's message again and stamps its own time, not the click's; absent, it is now.
       */
      currentMessageAt?: Date
      /**
       * BL-474 step 2: where the words of a current message Batshit wrote came from: `note` for a
       * webhook's wake, `agent_note` for another agent's words (a DM, a schedule, an artifact). Absent,
       * a Batshit-written current message is `agent_note` (the careful default) and any other is
       * the user's.
       */
      currentMessageAddressSource?: 'note' | 'agent_note'
      /**
       * SA-129 P2 (DL-08): this compile is for a new user message that will count toward every
       * temporary hold's countdown once the send is accepted. The compile reads zip state as it
       * will be then (`countOneMoreMessage`), as the chat page's own count used to give it; it
       * writes nothing.
       */
      countsPendingUserMessage?: boolean
      /** Actual same-reply API provider replay already carries these admitted results. */
      skillSessionReplayMessageIds?: ReadonlySet<string>
      /** Server-owned same-reply snapshot. Never supplied by a browser. */
      whiteboardContextSnapshot?: WhiteboardContextSnapshot
      whiteboardMessageId?: string
      /** SA-137: the actual API turn's live file reads (made by the route, never by a preview). */
      liveFileReadTurn?: Pick<LiveFileReadTurn, 'snapshotFor'> & Partial<Pick<LiveFileReadTurn, 'snapshot' | 'replayUnavailable' | 'replyMessageId' | 'replyMessageIds'>>
    }
  ): Promise<FormattedChatInputResult> {
    this.assertCompilablePrimary(agent)
    // SA-139 R2/R5 (D14): a record of a removed Subagent type (n8n, or the CLI Subagent) is never on a roster, whatever
    // the caller loaded (its stored assignment is never cleaned), so it can never fail a compile.
    assignedSubagents = assignedSubagents?.filter(
      (subagent) => !isRetiredSubagentType(normalizeSubagentType(subagent, subagent?.subagentType))
    )
    if (options?.agentSetupSend && !options.deferAgentSetup) {
      throw new Error('An API send requires its actual registered tool preparation. Nothing was sent.')
    }
    // Server compilation must not fall back to global fetch for relative app routes.
    // SvelteKit only allows request-scoped event.fetch for those URLs.
    const fetchImpl = options?.fetch
    const setupIdentity = userId && agent?.id && sessionId ? { userId, agentId: agent.id as string, sessionId } : null
    const setupLifecycle = setupIdentity ? captureSettingsLifecycle([`agent:${setupIdentity.agentId}`, `session:${sessionId}`]) : null
    const setupGuard = () => { if (setupLifecycle) assertSettingsLifecycle(setupLifecycle) }
    if (options?.p5McpOwner) {
      const owner = await import('$lib/server/services/appActions/mcp/originalTask')
      for (const id of options.mcpGatewayScope ?? []) await owner.readP5ApiVerifiedMcpAuthority(options.p5McpOwner, id)
    }

    const {
      primarySystemPrompt,
      globalCustomPrompt,
      globalZipSettings,
      globalTypedFileTools,
      globalToolOperationsSource,
      defaultWorkspacePath,
      agentDefaultProjectPath,
      agentDefaultProjectRules
    } = await this.loadSystemPrompts(agent, userId)
    const apiRetention = normalizePrimaryAgentType(agent) === 'api'
      ? options?.whiteboardContextSnapshot?.settings ?? resolveApiReasoningRetention(agent)
      : null
    if (apiRetention) agent = { ...agent, api_reasoning_retention: apiRetention.mode }
    const whiteboardControlsEnabled = Boolean(apiRetention?.whiteboardEnabled &&
      !options?.groupContext && options?.voiceState?.voiceMode !== 'speech-to-speech' &&
      resolveBrokerToolToggles(agent?.provider_specific_settings).batshitToolsEnabled)
    const whiteboardDcmLines = apiRetention
      ? options?.whiteboardContextSnapshot?.dcmLines ?? (whiteboardControlsEnabled && userId && agent?.id
        ? formatWhiteboardDcmLines(await readAgentWhiteboard({ userId, sessionId, agentId: agent.id }), apiRetention)
        : [])
      : null
    const whiteboardContextSnapshot: WhiteboardContextSnapshot | undefined = apiRetention && userId && agent?.id && options?.whiteboardMessageId
      ? { schema_version: 1, userId, sessionId, agentId: agent.id, messageId: options.whiteboardMessageId,
          settings: apiRetention, dcmLines: [...(whiteboardDcmLines ?? [])] }
      : undefined
    // The DCM's project path, and (SA-129 P1) what relative file paths in tool results resolve against.
    const resolvedProjectPath =
      options?.projectPath?.trim() ||
      agentDefaultProjectPath?.trim() ||
      defaultWorkspacePath?.trim() ||
      null

    // 2. Get user's custom system prompt from agent
    const userSystemPrompt = agent?.system_prompt || ''

    // SA-104 P4: the recall engine computes everything prompt-visible about memory in
    // one server-side call (on-my-mind block, DCM insert lines, time awareness, memory
    // clip ids). Read-only — the linger commit happens in send-routed. Group runs get
    // no recall lanes in v1 (recorded limitation, p4-recall-engine.md §1.5). Failures
    // propagate: memory recall for an enabled agent must never silently degrade.
    let memoryCompileContext: MemoryCompileContext | null = null
    if (!options?.groupContext && agent?.id && userId && resolveAgentMemoryEnabled(agent)) {
      memoryCompileContext = await computeMemoryCompileContext({
        userId,
        agentId: agent.id,
        sessionId,
        currentUserMessage: currentUserMessage ?? '',
        ...(options?.jevJuiceMemoryRecallProvider
          ? { inferredRecallProvider: options.jevJuiceMemoryRecallProvider }
          : {})
      })
    }

    // F-P5-11: this compile's own zip state, read from Redis BEFORE the history pass and
    // handed to every reader explicitly (history passes, the unzipped count, the DCM).
    // Server compiles overlap in one process (parallel chats, a wake-up, a token preview),
    // so none of them reads or writes the browser's `zippingService` singleton.
    const skillZipState = await this.loadSkillAwareZipState(sessionId, userId, options?.countsPendingUserMessage === true)
    const serverUnzipped = skillZipState.unzipped
    const serverRezipped = skillZipState.rezipped
    const serverRezippedSources = {
      ...(options?.jevJuiceSmartZipProvider && serverRezipped.length > 0 ? await loadRezippedSources(sessionId, serverRezipped) : {}),
      ...Object.fromEntries(skillZipState.expiryRezipped.map((id) => [id, 'user' as const]))
    }

    let zipState = createZipStateView(serverUnzipped, serverRezipped, serverRezippedSources)

    // BL-2217: a failed read rejects the compile (`SESSION_UNAVAILABLE`); an absent record
    // (a speech-to-speech fallback id) compiles as a regular chat.
    const sessionRecord = await redis.getSessionForCompile(sessionId)
    const compactionState = getContextCompactionState(sessionRecord?.metadata ?? null)
    // SA-104 P6: Infinite-Session graduation applies at the same site as compaction
    // (idempotent; regular sessions pass through unchanged — DL-104-12). This server
    // application is load-bearing for approval resumes, which reload raw messages.
    let contextMessages = applyFixedSessionGraduationToMessages(
      applyContextCompactionToMessages(messages, compactionState.events),
      sessionRecord
    )
    if (skillZipState.record && agent?.id && !options?.precompiledHistory) contextMessages = await recoverOpenSkillReadMessages({
      record: skillZipState.record, agentId: agent.id, messages: contextMessages, unzipped: serverUnzipped,
      replayedMessageIds: options?.skillSessionReplayMessageIds,
      ...(options?.groupContext ? { groupToolSharing: { currentAgentId: agent.id, sharedTools: [] } } : {})
    })
    const precompiledHistory = options?.precompiledHistory
    // SA-128: read only when this compile builds its own history (a group run arrives with it
    // precompiled), and once even when the smart-zip turn runs the history pass twice.
    let speakersPromise: Promise<SpeakerView> | null = null
    const speakersForHistory = () =>
      (speakersPromise ??= this.buildSpeakerView(contextMessages, agent, options?.groupContext))

    // SA-109: resolved once, before the history compile, because the history
    // rewrite, the DCM roster, and content delivery all read the same answer.
    const clipCompileState = await this.resolveSessionClipCompileState(
      sessionId,
      userId,
      fetchImpl
    )

    const compileHistoryPass = async (passZipState: ZipStateView) =>
      this.compileChatHistory(
        contextMessages,
        agent,
        globalZipSettings,
        {
          ...options,
          zipState: passZipState,
          deadCopyProjectPath: resolvedProjectPath,
          zipOwner: { sessionId, userId: userId ?? null },
          activeClipIds: clipCompileState.activeClipIds,
          clipNames: clipCompileState.clipNames
        },
        await speakersForHistory()
      )
    const historyAddressSourcesMissing = Boolean(precompiledHistory && !Array.isArray(precompiledHistory.addressSources))
    if (historyAddressSourcesMissing) console.error('[BL-474] Group history has no address-source ledger; picture decisions remain pending')
    let compiledHistory = precompiledHistory
      ? {
          formattedMessages: precompiledHistory.formattedMessages,
          currentDay: precompiledHistory.currentDay,
          chatHistory: precompiledHistory.chatHistory,
          // Group runs compile history once and get no Judge Juice provider (DL-120-06).
          compressedZips: [] as ZipCompression[],
          exposedZips: [] as ZipExposed[],
          addressSources: precompiledHistory.addressSources ?? [],
          deadCopiesThisTurn: [] as DeadCopyThisTurn[],
          liveReadsThisTurn: precompiledHistory.liveReadsThisTurn ?? []
        }
      : await compileHistoryPass(zipState)

    // SA-120 P5: Judge Juice smart zip. The route-owned provider is told exactly which zips
    // the pass above left compressed and answers with the ones Batshit opens for THIS
    // message. They are expanded through an in-memory overlay on this compile's zip state
    // (source `inferred`) and ONE more history pass, so zip activation is still decided in
    // `compileForAI` and nowhere else. Nothing is written here: `send-routed` stores the
    // state at the accepted-send boundary. No provider, a precompiled history, a quiet
    // answer, or a provider that throws: history is what the first pass produced.
    if (options?.jevJuiceSmartZipProvider && !precompiledHistory && currentUserMessage) {
      let opens: Awaited<ReturnType<JevJuiceSmartZipProvider>> = []
      // SA-129 P1: a dead copy stays compressed through any `inferred` unzip, so it is never offered.
      // SA-137 Round 2: while Refreshed File Reads is strict, a Read File copy opens only when the
      // turn refreshed it, so none is offered (an `inferred` open could not show it).
      const strictLiveReads = options?.liveFileReadTurn?.snapshot?.strict === true
      const zippedItems = compiledHistory.compressedZips.filter((zip) => !zip.deadCopy && classifyStoredSkillReadZip({ type: zip.zipType, metadata: zip }) === 'non_skill' && !(strictLiveReads && zip.operationKind === 'read_file'))
      try {
        opens = await options.jevJuiceSmartZipProvider({
          currentUserMessage,
          zippedItems
        })
      } catch (error) {
        console.error('[buildFormattedChatInput] Judge Juice smart zip provider threw; nothing opened this turn:', error)
        opens = []
      }
      // Re-check every id: only a zip this compile really left compressed, and never one a
      // user or an agent zipped by hand or that is an oversized safety row, can be opened.
      const openable = new Map(
        zippedItems
          .filter(
            (zip) =>
              classifyStoredSkillReadZip({ type: zip.zipType, metadata: zip }) === 'non_skill' &&
              !zip.sizeGuard &&
              !(zip.zipType === 'cool_tool' && classifyToolResultSize(zip.tokens)) &&
              !zip.groupUnshared &&
              (zip.rezippedBy === null || zip.rezippedBy === 'inferred')
          )
          .map((zip) => [zip.zipId, zip] as const)
      )
      const accepted = (Array.isArray(opens) ? opens : []).filter((open) => open && openable.has(open.zipId))
      if (accepted.length > 0) {
        // BL-1515: an open names the message's raw zip id, the stored state its state id
        // (`normalizeId` of the raw id, BL-476). Only the raw side is normalized, once: a second
        // cut of a state id whose random part is all digits misses it.
        const openedIds = new Set(accepted.map((open) => normalizeId(open.zipId)))
        const overlay: UnzippedItem[] = accepted.map((open) => ({
          zipId: normalizeId(open.zipId),
          sessionId,
          permanent: false,
          duration: open.durationMessages,
          unzippedAt: Date.now(),
          messageCount: 0,
          name: openable.get(open.zipId)?.toolName,
          description: open.description,
          tokens: open.tokens,
          source: 'inferred'
        }))
        zipState = createZipStateView(
          [...serverUnzipped.filter((item) => !openedIds.has(item.zipId)), ...overlay],
          serverRezipped.filter((id) => !openedIds.has(id)),
          serverRezippedSources
        )
        compiledHistory = await compileHistoryPass(zipState)
      }
      // What the FINAL pass left expanded, for the lane's after-reply question (is the agent
      // done with it?). Facts only; the route owns what happens next.
      try {
        options.jevJuiceSmartZipExposedObserver?.(compiledHistory.exposedZips)
      } catch (error) {
        console.error('[buildFormattedChatInput] Judge Juice smart zip exposed-observer threw; ignored:', error)
      }
    }
    const { formattedMessages, currentDay, chatHistory } = compiledHistory

    const resolvedChatHistory = chatHistory ?? compiledConversation(formattedMessages)

    // 4. Format current user message if provided.
    // SA-109: the current turn carries the just-attached clip's placeholder too
    // (ChatInput appends it), so it runs through the same rewrite — one clip
    // vocabulary across history and the current message.
    const currentUserMessageForAi = currentUserMessage
      ? compileClipReferencesForAiView(currentUserMessage, clipCompileState.activeClipIds, {
          clipNames: clipCompileState.clipNames
        })
      : currentUserMessage
    const currentMessageFormatted = currentUserMessage
      ? this.formatCurrentUserMessage(
          currentUserMessageForAi || EMPTY_COMPILED_MESSAGE_TEXT,
          currentDay,
          formattedMessages.length > 0,
          options?.currentMessageFrom ?? 'user',
          options?.currentMessageAt
        )
      : ''

    // 5. Count unzipped pins without fetching their bodies (G-0029): only the count
    // reaches the compiled output — the bodies are resolved independently inside
    // compileForAI — and unzipped zips are by definition the large expanded ones.
    const unzippedItemsCount = zipState.getAllUnzipped().length
    
    // 6. Get clipped items from SESSION STATE (NEW approach - no more embedding in messages!)
    const clippedContent = []
    // Provenance belongs beside structuredInput, never inside its Clip/EV payload.
    const clipAddressSourceById = new Map<string, AddressSourceKind>()
    const clipsFromMessage: string[] = []
    const trustedClipIds = new Set<string>()
    
    // Session state is the authority on what is attached — clips are not embedded
    // in every message. A clip leaves state when it is unclipped or when its
    // next-message-only countdown burns; either way it stops shipping bytes.
    for (const clipId of clipCompileState.attachedIds) {
      if (!clipsFromMessage.includes(clipId)) {
        clipsFromMessage.push(clipId)
        trustedClipIds.add(clipId)
      }
    }
    
    // FALLBACK: Still check message for clips (during transition period)
    // This allows old messages with embedded clips to still work
    if (currentUserMessage) {
      const references = extractAllReferences(currentUserMessage)
      const clipReferences = references.filter((ref) => ref.type === 'clip')
      for (const clipRef of clipReferences) {
        if (
          clipRef.id &&
          trustedClipIds.has(clipRef.id) &&
          !clipsFromMessage.includes(clipRef.id)
        ) {
          clipsFromMessage.push(clipRef.id)
        }
      }
    }
    
    // Process clips from session state or message
    if (clipsFromMessage.length > 0) {
      try {
        const clipsToProcess = clipsFromMessage.map(id => ({ clip_id: id }))
        // Settings failures propagate: resolving hybrid clip URLs without tunnel settings
        // silently hands cloud models localhost URLs (G-0063 / FM Clip System contract).
        const clipUserSettings = userId ? await this.getUserSettings(userId) : null
        
        // For each clip, get the full clip data
        for (const clipRef of clipsToProcess) {
          try {
            const clip = await this.getClipData(userId, clipRef.clip_id, fetchImpl)
            
            if (clip) {
              const isText = (clip.mimeType?.startsWith('text/') || clip.fileType === 'text' || clip.mimeType === 'application/json')
              const isImage = clip.mimeType?.startsWith('image/')
              const tokenEstimate = isImage
                ? clip.externalTokens ?? 765
                : clip.localTokens ?? clip.externalTokens ?? (clip.content ? Math.ceil(clip.content.length / 4) : undefined)
              const baseDescription = clip.filename
              const preferredUrl = await resolveClipPreferredUrl(clip as ClipRow, clipUserSettings, {
                allowAutoStart: true
              })

              if (isText) {
                const decoded = clip.content
                  ?? (clip.localBase64
                    ? this.decodeBase64ToText(
                        clip.localBase64.startsWith('data:')
                          ? clip.localBase64.split(',')[1] || ''
                          : clip.localBase64
                      )
                    : '')

                clipAddressSourceById.set(clip.id,
                  (clip as any).uploadSettings?.source === 'artifact_share' ? 'agent_note' : 'user')
                clippedContent.push({
                  clipId: clip.id,
                  content: decoded,
                  contentType: 'text',
                  description: baseDescription,
                  tokens: tokenEstimate,
                  storageMode: 'local',
                  url: preferredUrl,
                  filename: clip.filename,
                  fileSize: clip.fileSize,
                  mimeType: clip.mimeType
                })
              } else if (isImage) {
                const dataUrl = await resolveClipDataUrlFromStoredUpload(clip as ClipRow)
                if (!dataUrl) {
                  throw new Error(`Clip image payload could not be resolved from local upload storage: ${clip.id}`)
                }

                clippedContent.push({
                  clipId: clip.id,
                  content: dataUrl,
                  contentType: 'image',
                  description: baseDescription,
                  tokens: tokenEstimate,
                  storageMode: 'local',
                  url: preferredUrl,
                  filename: clip.filename,
                  fileSize: clip.fileSize,
                  mimeType: clip.mimeType
                })
              } else if (preferredUrl) {
                clippedContent.push({
                  clipId: clip.id,
                  content: preferredUrl,
                  contentType: clip.fileType || 'file',
                  description: baseDescription,
                  tokens: tokenEstimate,
                  storageMode: 'local',
                  url: preferredUrl,
                  filename: clip.filename,
                  fileSize: clip.fileSize,
                  mimeType: clip.mimeType
                })
              }
            } // Close the if statement for clipDataResponse
          } catch (error) {
            console.error(`[databaseRedis] Failed to prepare clip ${clipRef.clip_id}:`, error)
            throw error
          }
        } // End of for loop
      } catch (error) {
        console.error('[databaseRedis] Failed to prepare clipped items:', error)
        throw error
      }
    }
    
    const dedupedClippedContent = (() => {
      const seen = new Set<string>()
      const deduped = []
      for (const item of clippedContent) {
        const clipId = item?.clipId
        if (!clipId || seen.has(clipId)) continue
        seen.add(clipId)
        deduped.push(item)
      }
      return deduped
    })()

    // Named media lanes (DL-105-18): standing = constant bytes at the head;
    // live = per-send media at the tail. Both read only memory-owned uploads.
    const memoryMediaNotes: string[] = []
    for (const entry of memoryCompileContext?.rememberedMedia ?? []) {
      try {
        const loaded = await loadMemoryMedia(agent?.id ?? '', entry.memoryId, entry.media)
        dedupedClippedContent.push({
          clipId: `memory:${entry.memoryId}:${entry.media.id}`,
          content: loaded.dataUrl,
          contentType: 'image',
          description: entry.media.display_name,
          tokens: entry.media.token_estimate,
          storageMode: 'local',
          url: loaded.url,
          filename: entry.media.display_name,
          fileSize: entry.media.bytes,
          mimeType: entry.media.mime_type,
          memorySource: entry.memoryId
        } as (typeof dedupedClippedContent)[number])
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unavailable'
        memoryMediaNotes.push(
          `- Media unavailable: image ${entry.media.id} from memory ${entry.memoryId} could not be loaded (${reason}).`
        )
      }
    }
    const standingMediaItems = [] as Array<{
      memoryId: string
      mediaId: string
      filename: string
      dataUrl: string
      bytes: number
      tokenEstimate: number
    }>
    for (const entry of memoryCompileContext?.standingMedia ?? []) {
      const loaded = await loadMemoryMedia(agent?.id ?? '', entry.memoryId, entry.media)
      standingMediaItems.push({
        memoryId: entry.memoryId,
        mediaId: entry.media.id,
        filename: entry.media.display_name,
        dataUrl: loaded.dataUrl,
        bytes: entry.media.bytes,
        tokenEstimate: entry.media.token_estimate
      })
    }
    const memoryDcmLines = (() => {
      const base = memoryCompileContext?.dcmLines ?? []
      if (memoryMediaNotes.length === 0) return base
      return base.length > 0
        ? [...base, ...memoryMediaNotes]
        : ['Memory context:', ...memoryMediaNotes]
    })()

    // SA-109 (DL-109-04): the general clip roster — every agent gets it,
    // including memory-off agents and group runs. It is the SOLE owner of clip
    // lines; the memory section no longer emits any, so there is never a double
    // listing. Newness is stated here rather than inferred from repeated syntax.
    const clipRosterDcmLines = buildClipRosterDcmLines(
      buildClipRosterLines({
        entries: clipCompileState.entries,
        // RAW (pre-compaction) ids on purpose: a clip must not flip back to
        // "new this message" just because the message it rode was compacted or
        // graduated out of the compiled window.
        historyMessageIds: new Set(
          messages.map((message) => message?.id).filter(Boolean) as string[]
        )
      })
    )

    // SA-113 P2 (DL-113-04b): ONE store read per compile, at the compile site, beside the
    // clip roster's — the same rule. The formatter itself is pure text with no Redis, and
    // returns [] on an empty inbox, so every agent without open DMs compiles unchanged.
    //
    // Served in group turns too (DL-113-11): the roster is read-only and needs no commit
    // boundary, unlike memory linger, and each speaker's own inbox is derivable because
    // `agent` is the speaking member.
    const dmRoster = await this.resolveDmRosterForCompile(agent, sessionId, messages)

    // 6. Create clean structured input for Chat Model
    // This will be passed directly to the AI without any parsing needed
    
    // Build the messages array exactly as the Chat Model expects
    const chatMessages: any[] = []
    
    // System prompts are delivered separately via n8n expressions
    // Do NOT add system prompts to the messages array
    
    // Merge all system prompts into one message (for Anthropic compatibility)
    //
    // SA-110 P3 (DL-110-07): the merged prompt is two zones, in this order.
    //   BATSHIT ZONE   — how to operate here: base prompt, tool + zip guidance,
    //                    dynamic tool search, memory instructions, shared insert.
    //   IDENTITY ZONE  — who you are: the user's global prompt, this agent's own
    //                    prompt, and the agent's own AWARENESS memories LAST,
    //                    sitting directly against the conversation that follows.
    // NOTHING may compile after AWARENESS (the episode whiteboard left for the
    // DCM in P1). Every conditional gate below is unchanged from the pre-P3
    // order — only position moved, which inside the SP is cache-free.
    let mergedSystemPrompt = ''

    // ---------- Batshit zone ----------

    // Add primary Batshit system prompt (with variable replacement)
    if (primarySystemPrompt) {
      const processedPrimary = replacePromptVariables(primarySystemPrompt, agent, agent?.settings)
      const promptLabel = getPrimaryAgentSystemPromptLabel('api')
      mergedSystemPrompt += `==== ${promptLabel} ====\n\n${processedPrimary}`
    }

    const setupFeatureGates = { memory: false, dm: false, schedule: false, judge: false, whiteboard: false, zip: false, skill: Boolean(primarySystemPrompt) }

    const zipViewMode = this.resolveZipAiViewMode(agent, globalZipSettings)
    const zipToolNotesEnabled = this.resolveZipToolNotesEnabled(agent, globalZipSettings)
    // SA-137 P5 (D12) and Round 2: only a turn the route gave a `LiveFileReadTurn` (an API Primary
    // turn with the setting on where it is available, `refreshedFileReadsUnavailableReason`, or the
    // approval resume of such a turn, even when its replay could not be used) in the appended
    // layout; every other prompt, previews included, keeps its text. One answer for the zip rules
    // and for `edit_file`'s text, which send-routed hands to the tools (Josh, 2026-10-22).
    const refreshedFileReadsTurn = Boolean(options?.liveFileReadTurn) && zipViewMode === 'appended'
    // Decision 11: the working-context section says "As discussed earlier" and names Tool Notes
    // only when this block really went out before it.
    let toolZipBlockSent = false
    const toolZipPrompt = await this.resolveToolZipGuidancePrompt({
      notesEnabled: zipToolNotesEnabled,
      agent,
      zipViewMode,
      typedFileTools: this.typedFileToolsOffered(agent, globalTypedFileTools),
      liveFileReads: refreshedFileReadsTurn,
      bashCommandsAfterPatchRun: this.resolveNativeBashDcmState(agent)?.enabled === true &&
        nativeBashAfterPatchFromProvider(agent?.provider_specific_settings ?? agent?.providerSpecificSettings ?? null, {
          groupMemberRun: options?.groupMemberRun ?? Boolean(options?.groupContext),
          toolApprovalMode: options?.toolApprovalMode
        })
    })
    if (toolZipPrompt.trim()) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      // Decision 7 (Josh, 2026-10-23): agent zip control is retired, so the label names no permission.
      mergedSystemPrompt += `==== TOOL + ZIP GUIDANCE ====\n\n${toolZipPrompt}`
      toolZipBlockSent = true
    }

    if (apiRetention) {
      const workingContext = buildWorkingContextGuidance({ settings: apiRetention,
        toolNotesEnabled: zipToolNotesEnabled && toolZipBlockSent,
        whiteboardAvailable: whiteboardControlsEnabled,
        toolZipBlockSent })
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      mergedSystemPrompt += `==== MAINTAINING YOUR WORKING CONTEXT ====\n\n${workingContext}`
    }

    // SA-096 P5: the broker block is gated on broker availability alone, never nested under
    // the tool + zip block: nesting once hid the instructions from agents whose broker
    // families were live (the n8n lane's stricter tool gate, retired since).
    const discoveryOffset = mergedSystemPrompt.length
    let discoveryAppend = ''
    if (this.hasBrokerAccess(agent)) {
      const dynamicMcpPrompt = await this.resolveDynamicMcpPrompt(agent)
      if (dynamicMcpPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== DYNAMIC TOOL SEARCH / DISCOVERY (WHEN ENABLED) ====\n\n${dynamicMcpPrompt}`
        discoveryAppend = mergedSystemPrompt.slice(discoveryOffset)
      }
    }

    // SA-111 P1 (DL-111-01): delegation guidance sits directly after the discovery block
    // and before MEMORY INSTRUCTIONS, inside the Batshit zone. Primary agents lost this
    // guidance at SA-008 (2025-12-04) when the specialty-based subagent description block
    // was removed and nothing replaced it — the "Subagent Addon" prompt kept its Admin
    // label but reached no compiler on any lane (F1/F2). Gated on having something to
    // delegate to, so an agent with no subagents pays no bytes; stable-prefix bytes that
    // move only when enablement or the stored prompt changes.
    if (
      shouldCompileDelegationGuidance({
        hasSubagents: Array.isArray(assignedSubagents) && assignedSubagents.length > 0,
        workersEnabled: resolveWorkersEnabled(agent)
      })
    ) {
      const delegationPrompt = await this.resolveSubagentGuidancePrompt(agent)
      if (delegationPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== SUBAGENTS & WORKERS (DELEGATION) ====\n\n${delegationPrompt}`
      }
    }

    // SA-113 P2 (DL-113-04a): Agent DM guidance sits directly after the delegation block
    // and before MEMORY INSTRUCTIONS — both are "other things you can reach", and DMs are
    // the closer sibling of delegation. Stable-prefix bytes: they move only when the
    // agent's `dms_enabled`, its Fabric & Utilities switch, or the stored prompt changes.
    if (resolveAgentDmsEnabled(agent)) {
      const dmPrompt = await this.resolveDmGuidancePrompt(agent)
      if (dmPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== AGENT DMS (MESSAGING) ====\n\n${dmPrompt}`
        setupFeatureGates.dm = true
      }
    }

    // SA-120 P2 (H1): the Judge Juice judgment-tool guidance sits directly after the DM
    // block and before MEMORY INSTRUCTIONS — one more "thing you can reach". Gated on the
    // agent's `jev_juice_judge_tool` switch plus Fabric & Utilities, the same pair that opens
    // `sys.judge.*` in the broker (DL-120-06), so a control the agent cannot call is never
    // taught. Stable-prefix bytes: they move only when either switch or the stored prompt
    // changes.
    // Jev's ANSWERS never land here (DL-120-05); this only teaches how to ask.
    if (resolveAgentJevJudgeToolEnabled(agent)) {
      const jevPrompt = await this.resolveJevJuiceGuidancePrompt(agent)
      if (jevPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== JUDGE JUICE (JUDGMENT TOOL) ====\n\n${jevPrompt}`
        setupFeatureGates.judge = true
      }
    }

    // SA-104 P3: memory guidance is gated on per-agent memory enablement alone — the
    // inline <batshit-memory> save works without any broker family. Part of the stable
    // compiled prefix (DL-104-04): it changes only when enablement or the stored prompt
    // changes.
    if (resolveAgentMemoryEnabled(agent)) {
      const memoryPrompt = await this.resolveMemoryGuidancePrompt(
        agent,
        isFixedSession(sessionRecord)
      )
      if (memoryPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== MEMORY INSTRUCTIONS (AGENT MEMORY ENABLED) ====\n\n${memoryPrompt}`
        setupFeatureGates.memory = true
      }
    }

    // Hook for future shared inserts (voice/SST/TTS, buffer summaries, agent setting
    // notes, etc.). SA-110 P3: it closes the BATSHIT ZONE. It used to append after
    // AWARENESS, which DL-110-07 forbids; it returns '' today so the move is
    // byte-invisible, but whoever fills this hook must land here, not at the end.
    const sharedInsert = this.buildSharedInsert()
    if (sharedInsert) {
      mergedSystemPrompt += sharedInsert
    }

    const setupPrefix = mergedSystemPrompt

    // ---------- Identity zone ----------

    // Add global custom prompt if enabled (with variable replacement)
    if (globalCustomPrompt) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      const processedGlobal = replacePromptVariables(globalCustomPrompt, agent, agent?.settings)
      mergedSystemPrompt += `==== GLOBAL CUSTOM SYSTEM PROMPT ====\n\n${processedGlobal}`
    }

    // Add user's agent-specific prompt (with variable replacement)
    if (userSystemPrompt) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      const processedUser = replacePromptVariables(userSystemPrompt, agent, agent?.settings)
      mergedSystemPrompt += `==== USER SYSTEM PROMPT ====\n\n${processedUser}`
    }

    // SA-104 P4 / SA-110 P3 (DL-110-07): the agent's own awareness memories are the
    // LAST thing in the system prompt — the close of the identity zone, sitting
    // directly against the conversation. Its bytes come verbatim from the stored
    // fold snapshot (SA-110 P2), so mid-session awareness churn never moves them.
    // Nothing may be appended to mergedSystemPrompt after this point.
    // BL-474 step 2: every block above is Batshit's text (the user's own prompts included);
    // Awareness is the agent's memories.
    const systemPromptBeforeAwareness = mergedSystemPrompt
    if (memoryCompileContext?.onMyMindBlock) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      mergedSystemPrompt += memoryCompileContext.onMyMindBlock
    }

    // SA-110 (DL-110-01): the episode whiteboard no longer compiles into the system
    // prompt. It rides the DCM (`whiteboardDcmLines` below) because it churns by
    // design and SP bytes sit ahead of the entire packed history — nothing may
    // compile after AWARENESS here.

    // Artifact guidance is now skill-led.
    // Build context still controls tool availability and DCM visibility,
    // but artifact prompt addons are retired and no longer injected here.

    // Each subagent's ROSTER facts, for the DCM. A delegated run compiles its own system
    // prompt when it starts (`subagentRunner.ts`). Until 2026-09-18 this loop built that prompt
    // here too and threw it away (nothing had read it since `3ef1c664f` retired the n8n
    // primary lane): its DYNAMIC INFO discovers every reachable MCP gateway's tools LIVE, so
    // each compile, sends and Token Panel previews alike, waited on every gateway once per
    // subagent (1 to 7 s per preview on the smoke stack).
    const subagentDescription: Record<string, string> = {}
    const subagentModels: Record<string, { provider?: string | null; model?: string | null }> = {}
    // SA-111 P1 (DL-111-03): the capability fragment appended to each DCM roster line.
    const subagentCapabilityFragments: Record<string, string> = {}
    const subagentThreads = new Map<string, 'none' | 'resumable' | 'unavailable'>()
    const subagentSetup = new Map<string, AgentSetupBlock>()

    if (assignedSubagents && assignedSubagents.length > 0) {
      // One gateway-registry read per compile, shared by every subagent's roster line, and
      // only when a subagent actually has gateways to name.
      let gatewayNames: Map<string, string> | null = null
      const resolveGatewayNames = async (): Promise<Map<string, string>> => {
        if (gatewayNames) return gatewayNames
        const names = new Map<string, string>()
        if (userId) {
          try {
            for (const gateway of await mcpGatewayService.list(userId)) {
              if (gateway?.id) names.set(gateway.id, gateway.name?.trim() || gateway.id)
            }
          } catch (error) {
            // A dangling id prints as the id itself, which is the honest thing to show.
            console.warn('[buildDynamicInfoBlock] Failed to load gateway names for roster:', error)
          }
        }
        gatewayNames = names
        return names
      }

      for (const swf of assignedSubagents) {
        if (isRetiredSubagentType(normalizeSubagentType(swf, swf?.subagentType))) continue
        const subagentScope = await resolveManagedSubagentScope({
          userId: userId ?? '',
          subagent: swf,
          sessionId,
          projectPath: options?.projectPath ?? agentDefaultProjectPath ?? null,
        })
        const subagentCapabilities = await getEnabledAgentSlashCapabilities(userId ?? '', swf.id)

        const safeKey = resolveSubagentSlug(swf)

        const saDescription = swf.description || `Subagent ${swf.displayName || swf.name || safeKey}`
        subagentDescription[safeKey] = saDescription
        const subagentModel = {
          provider: swf.primary_model_provider ?? swf.settings?.primary_model_provider ?? null,
          model: swf.primary_model_name ?? swf.settings?.primary_model_name ?? null
        }
        subagentModels[safeKey] = subagentModel

        // `thread: resumable` means this subagent already holds prior context in THIS chat
        // session, so a `thread: "resume"` call continues it instead of starting over.
        let threadState: 'none' | 'resumable' | 'unavailable' = 'none'
        if (sessionId) {
          const threadKey = buildSubagentThreadKey(sessionId, safeKey)
          try {
            threadState = (await redis.exists(threadKey)) ? 'resumable' : 'none'
          } catch (error) {
            threadState = 'unavailable'
            console.warn('[buildDynamicInfoBlock] Failed to read subagent thread state:', error)
          }
        }

        const needsGatewayNames =
          subagentScope.nativeToolSettings.dynamicMcpEnabled &&
          subagentScope.resolvedGateways.length > 0
        subagentThreads.set(safeKey, threadState)
        subagentCapabilityFragments[safeKey] = buildSubagentRosterCapabilityFragment({
          scope: subagentScope,
          capabilities: subagentCapabilities,
          gatewayNames: needsGatewayNames ? await resolveGatewayNames() : new Map(),
          model: subagentModel.model,
          provider: subagentModel.provider,
          threadState,
          // Delegation limits: named only when this Subagent sets one.
          timeoutSeconds: swf.timeout_seconds ?? swf.settings?.timeout_seconds,
          maxToolSteps: swf.max_tool_steps ?? swf.settings?.max_tool_steps
        }, { includeThread: false })
        const label = `${swf.displayName || swf.name || safeKey} (${safeKey})`
        const text = `- ${setupMetadata(label)}: ${setupMetadata(saDescription.replace(/\s+/g, ' ').trim())} — ${setupMetadata(subagentCapabilityFragments[safeKey])}`
        subagentSetup.set(safeKey, { key: `subagent:${swf.id}`, source: 'api-utilities', section: 'subagents', order: 0,
          text, items: [{ key: `subagent:${swf.id}`, label, text }] })
      }

    }

    // Store the compiled system prompt separately (not in messages anymore)
    const compiledMainSystemPrompt = mergedSystemPrompt

    // User message - build content array for vision support
    const standing: any[] = []
    const live: any[] = []
    if (standingMediaItems.length > 0) {
      // SA-128 (DL-04): the manifest is one `<awareness_media>` element; the image parts it
      // names follow it, exactly as before.
      standing.push({
        type: 'text',
        text: compiledElement(
          COMPILED_TAG.awarenessMedia,
          standingMediaItems.map((item) => `- ${item.filename} — image`).join('\n')
        )
      })
      for (const item of standingMediaItems) {
        standing.push({ type: 'image_url', image_url: { url: item.dataUrl } })
      }
    }
    const userContent: any[] = live
    
    // Text content (previous conversation + current message)
    let textContent = ''

    const previousSnapshot = this.getPreviousDynamicSnapshot(contextMessages)
    // SA-129 P2: a hold on a copy this compile compressed as dead (an agent's hold on a copy it
    // edited since) says so in the Zip Index, so the agent is never surprised.
    const heldDeadCopies = new Map<string, DeadCopyReason>()
    const heldSizeGuards = new Map<string, ToolResultSizeGuard>()
    for (const compression of compiledHistory.compressedZips) {
      if (compression.deadCopy) heldDeadCopies.set(normalizeId(compression.zipId), compression.deadCopy)
      if (compression.sizeGuard) heldSizeGuards.set(normalizeId(compression.zipId), compression.sizeGuard)
    }
    const zipStateSnapshot = this.buildZipStateSnapshot(
      contextMessages,
      zipState.getAllUnzipped(),
      heldDeadCopies,
      heldSizeGuards,
      compiledHistory.deadCopiesThisTurn,
      compiledHistory.liveReadsThisTurn
    )
    const autoZipSummary = this.buildAutoZipSummary({
      agent,
      globalZipSettings
    })
    const nativeDynamicMcpEnabled = this.resolveDynamicMcpEnabled(agent)
    const goonsEnabled = options?.goonsEnabled
    const projectRules =
      options?.projectRules &&
      typeof options.projectRules === 'object' &&
      !Array.isArray(options.projectRules)
        ? options.projectRules
        : agentDefaultProjectRules ?? null
    setupFeatureGates.whiteboard = Boolean(apiRetention && whiteboardControlsEnabled)
    setupFeatureGates.zip = toolZipBlockSent && resolveBrokerToolToggles(agent?.provider_specific_settings).fetchZipEnabled
    setupFeatureGates.schedule = setupFeatureGates.dm
    const skillsCommandsDcm = await this.buildSkillsCommandsDcm({ userId, agentId: agent?.id })
    const readToolIndex = (apiUtilityScope?: ApiUtilityScope) => this.buildDynamicMcpDcm({
      apiUtilityScope,
      userId, agentId: agent?.id, mcpGatewayScope: options?.mcpGatewayScope, p5McpOwner: options?.p5McpOwner,
      projectPath: resolvedProjectPath, nativeDynamicMcpEnabled,
      nativeCliToolsEnabled: this.resolveCliToolsEnabled(agent), whiteboardControlsEnabled,
      providerSettings: this.getAgentProviderSettings(agent),
      memoryControlsEnabled: resolveAgentMemoryEnabled(agent), dmControlsEnabled: resolveAgentDmsEnabled(agent),
      scheduleControlsEnabled: resolveAgentDmsEnabled(agent), judgeControlsEnabled: resolveAgentJevJudgeToolEnabled(agent),
      featureHintGates: setupFeatureGates
    })
    // The routed API path waits for its actual eligible registrations. Other
    // callers still read once here; previews never register tools to guess a scope.
    let toolIndex: AgentSetupToolIndex = options?.deferAgentSetup
      ? { text: '', discoverable: [], resolvedGatewayIds: null, setupBlocks: [], sources: [],
        hintBudget: { limit: 3000, budgetedTokens: 0, featureTokens: 0 }, apiUtilityProjection: 'unprepared' }
      : await readToolIndex()
    const setupBlocks: AgentSetupBlock[] = []
    const fact = (key: string, text: string, section: AgentSetupBlock['section'] = 'facts') => {
      if (!text) return
      setupBlocks.push({ key, source: 'runtime', section, order: setupBlocks.length,
        text, items: [{ key, label: key, text }] })
    }
    if (agent?.id) fact('agent_id', `agent_id: ${setupMetadata(agent.id)}`)
    fact('workers', this.buildWorkersSetupLine(agent))
    const network = this.buildRuntimeNetworkDcmLine(agent)
    if (network) fact('runtime_network', setupMetadata(network))
    const browser = await this.buildNativeAgentBrowserDcmLines(agent, userId, globalToolOperationsSource)
    if (browser?.length) fact('native_agent_browser', browser.map(setupMetadata).join('\n'))
    const bash = this.buildNativeBashDcmLine(agent)
    if (bash) fact('native_bash', setupMetadata(bash))
    if (skillsCommandsDcm.lines.length) setupBlocks.push({
      key: 'skills_commands', source: 'skills', section: 'skills', order: 0,
      text: skillsCommandsDcm.lines.join('\n'),
      items: skillsCommandsDcm.capabilities.map((capability, index) => ({
        key: `skill:${capability.id}`, label: capability.invocation,
        text: skillsCommandsDcm.lines[index + 1]
      }))
    })
    fact('project_path', `project_path: ${setupMetadata(resolvedProjectPath || '(not set)')}`, 'project')
    if (projectRules) fact('project_rules_json', `project_rules_json: ${setupMetadata(JSON.stringify(projectRules))}`, 'project')
    const liveSetup: LiveAgentSetup = {
      blocks: [...setupBlocks, ...toolIndex.setupBlocks],
      sources: [{ id: 'runtime', label: 'Agent runtime', available: true }, { id: 'skills', label: 'Skills', available: true }, ...toolIndex.sources]
    }
    const controlErrorLines = buildControlErrorDcmLines(contextMessages as any[])
    // A consumed MCP prerequisite is the same task with no new user message.
    // Only its genuine original owner can request fresh DCM before the child API
    // run; ordinary empty/context-limit compiles retain their existing path.
    let prerequisiteDcm = false
    if (!currentMessageFormatted && options?.p5McpOwner) {
      const owner = await import('$lib/server/services/appActions/mcp/originalTask')
      prerequisiteDcm = owner.p5ApiNeedsPrerequisiteDcm(options.p5McpOwner)
    }
    const initialOpenSkills = skillZipState.record && userId && agent?.id
      ? await readOpenSkillSessions({ userId, sessionId, agentId: agent.id }, skillZipState.record) : []
    const dynamicInfoResult = currentMessageFormatted || prerequisiteDcm
        ? await this.buildDynamicInfoBlock({
          toolIndex, skillsCommandsDcm, sessionId,
          openSkillSessions: initialOpenSkills,
          allowUnpreparedSkillHints: options?.deferAgentSetup === true,
          mcpGatewayScope: options?.mcpGatewayScope,
          p5McpOwner: options?.p5McpOwner,
          userId: userId ?? null,
          controlErrorLines,
          currentUserMessage: currentUserMessage ?? null,
          agentId: agent?.id ?? null,
          projectPath: options?.projectPath ?? null,
          agentDefaultProjectPath: agentDefaultProjectPath ?? null,
          projectRules,
          defaultWorkspacePath: defaultWorkspacePath ?? null,
          fileReferences: options?.fileReferences ?? [],
          nativeDynamicMcpEnabled,
          previousSnapshot,
          goonId: agent?.goon_id ?? null,
          goonsEnabled,
          goonsSettings: options?.goonsSettings ?? null,
          goonPresentationMode: options?.goonPresentationMode ?? null,
          jevJuiceHintProvider: currentMessageFormatted && !options?.deferAgentSetup ? options?.jevJuiceHintProvider : undefined,
          groupContext: options?.groupContext,
          voiceState: options?.voiceState,
          memoryDcmLines,
          clipRosterDcmLines,
          dmRosterDcmLines: dmRoster.lines,
          whiteboardDcmLines: whiteboardDcmLines ?? memoryCompileContext?.whiteboardDcmLines ?? [],
          whiteboardControlsEnabled,
          awarenessPendingDcmLines: memoryCompileContext?.awarenessPendingDcmLines ?? []
        })
      : { text: '', addressSourcePieces: [], openSkillsText: '' }
    const dynamicInfo = dynamicInfoResult.text
    // Decision 5 (Josh, 2026-10-23): the Zip Index carries what the DCM's `Current Zip State` did,
    // on the same compiles (the ones that build a DCM), whichever pass or group run made the history.
    const zipIndexStatusLines = currentMessageFormatted || prerequisiteDcm
      ? this.buildZipIndexStatusLines({
          zipState: zipStateSnapshot,
          autoZipContent: autoZipSummary.autoZipContent,
          autoZipTools: autoZipSummary.autoZipTools,
          agentId: agent?.id ?? null
        })
      : []
    const historyForLLM = withZipIndexStatus(resolvedChatHistory, zipIndexStatusLines)
    // Decision 11 (Josh, 2026-10-24): the message to answer now is labeled `<current_message>`, in
    // the place it always had: after `</conversation>` and any `<zip_index>`, before
    // `<dynamic_info>` and the clip elements. About 8 tokens, in the uncached tail.
    const currentMessageElement = currentMessageFormatted ? compiledCurrentMessage(currentMessageFormatted) : ''
    const currentMessageForLLM = currentMessageElement
      ? dynamicInfo
        ? `${currentMessageElement}\n\n${dynamicInfo}`
        : currentMessageElement
      : dynamicInfo
    
    // SA-128 (DL-01): `<conversation>` (and the zip index), then the new message and its
    // `<dynamic_info>`. The tags carry the structure, so there are no section headers.
    if (historyForLLM) {
      textContent += historyForLLM
    }

    if (currentMessageForLLM) {
      if (textContent) textContent += '\n\n'
      textContent += currentMessageForLLM
    }
    
    // Add text as first content item
    live.push({
      type: 'text',
      text: textContent
    })
    
    // Agent-managed zips append a structured Unzip block inside chatHistory.
    // User-managed zips expand inline during compileForAI.
    
    // Add clipped items (user uploads) - KEEP THIS!
    // SA-104 P4: memory-carried clips (memorySource set) render under their own
    // `<remembered_media>` element — they are recalled media, not this message's uploads.
    const sessionClippedItems = dedupedClippedContent.filter(
      (item) => !(item as Record<string, any>).memorySource
    )
    const memoryClippedItems = dedupedClippedContent.filter(
      (item) => (item as Record<string, any>).memorySource
    )
    const clippedSources: AddressSourcePiece[] = []
    const appendClippedItems = (
      items: typeof dedupedClippedContent,
      tag: typeof COMPILED_TAG.clippedItems | typeof COMPILED_TAG.rememberedMedia
    ) => {
      if (items.length === 0) return
      if (userContent[0].text) {
        // SA-109 (DL-109-05): one named manifest in delivery order replaces the
        // per-history `[CLIPPED ITEM: batshit-clip-id: …]` markers. It is what
        // actually correlates the image parts below with their filenames — the
        // old marker only ever existed on the no-image text path. SA-128 (DL-04): the
        // manifest and any text clip bodies are one element, disarmed like any content.
        const body: string[] = []
        const sourcedBody: Array<{ source: AddressSourceKind; text: string }> = []
        for (const item of items) {
          const label = item.filename || item.description || item.clipId
          const line = `- ${label} — ${item.contentType}`
          body.push(line)
          sourcedBody.push({
            source:
              item.contentType === 'text'
                ? clipAddressSourceById.get(item.clipId) ?? 'user'
                : 'user',
            text: line
          })
        }
        for (const item of items) {
          // For text clips, inline the content for the AI
          if (item.contentType === 'text' && typeof item.content === 'string') {
            const label = item.filename || item.description || item.clipId
            const content = `CONTENT (${label}):\n${item.content}`
            body.push('', content)
            sourcedBody.push({
              source: clipAddressSourceById.get(item.clipId) ?? 'user',
              text: content
            })
          }
        }
        const element = compiledElement(tag, body.join('\n'))
        userContent[0].text += `\n\n${element}`
        // BL-474 step 2: preserve each text Clip's maker. Memory-carried media keeps
        // its existing source and image bytes remain non-text inputs.
        clippedSources.push(
          ...(tag === COMPILED_TAG.rememberedMedia
            ? [{ source: 'memory' as const, text: element }]
            : sourcedBody)
        )
      }
      for (const item of items) {
        // Images go as separate content items for vision models
        if (item.contentType === 'image' && item.content) {
          userContent.push({
            type: 'image_url',
            image_url: {
              url: item.content
            }
          })
        }
      }
    }
    appendClippedItems(sessionClippedItems, COMPILED_TAG.clippedItems)
    appendClippedItems(memoryClippedItems, COMPILED_TAG.rememberedMedia)

    // Add user message with proper content format
    const compiledUserContent = standing.length > 0 ? [...standing, ...live] : live
    chatMessages.push({
      role: 'user',
      // If only text (no images), just send the string. Otherwise send array.
      content: compiledUserContent.length === 1 ? compiledUserContent[0].text : compiledUserContent
    })

    const assignedSubagentMetadata = Array.isArray(assignedSubagents)
      ? assignedSubagents.map((subagent) => ({
          id: subagent?.id,
          displayName: subagent?.displayName || subagent?.name,
          workflowName: subagent?.workflowName || undefined,
          webhookUrl: subagent?.webhookUrl || subagent?.workflowName || undefined,
          subagentType: normalizeSubagentType(subagent, subagent?.subagentType),
          defaultGateways:
            subagent?.defaultMCPGateways ??
            subagent?.defaultGateways ??
            subagent?.default_mcp_gateways ??
            [],
          defaultTools: subagent?.defaultTools ?? subagent?.default_tools ?? []
        }))
      : []

    // Create the structured input
    const structuredInput = {
      type: "batshit_chat_input",
      messages: chatMessages,  // Should only contain user/assistant messages
      // unzippedItems: removed (agent-managed uses chatHistory append; user-managed expands inline)
      clippedItems: dedupedClippedContent,  // User uploads (kept at bottom)
      metadata: {
        sessionId,
        agent,
        systemPromptLength: primarySystemPrompt?.length || 0,
        userSystemPromptLength: userSystemPrompt?.length || 0,
        globalCustomPromptLength: globalCustomPrompt?.length || 0,
        mergedSystemPromptLength: mergedSystemPrompt?.length || 0,
        previousConversationLength: historyForLLM?.length || 0,
        currentMessageLength: currentMessageForLLM?.length || 0,
        unzippedItemsCount,
        clippedItemsCount: dedupedClippedContent.length,
        standingMediaCount: standingMediaItems.length,
        resolvedProjectPath,
        assignedSubagents: assignedSubagentMetadata,
        subagentModels,
        ...(apiRetention ? { whiteboardContext: {
          enabled: whiteboardControlsEnabled, placement: 'dcm',
          renderedTokenEstimate: estimateTokens((whiteboardDcmLines ?? []).join('\n')),
          budgetTokens: apiRetention.whiteboardBudgetTokens,
          mode: apiRetention.mode
        } } : {}),
        // SA-104 P4: inserted-memory visibility for the Execution Viewer (rides the
        // recorded snapshot's structuredInput untouched on every lane).
        ...(memoryCompileContext?.memoryContext
          ? { memoryContext: memoryCompileContext.memoryContext }
          : {}),
        // SA-113 P2 (DL-113-04b): the structured twin of the DM roster, beside
        // memoryContext, so the Execution Viewer can show which inbox items this turn was
        // told about without re-reading the store.
        ...(dmRoster.totalOpen > 0
          ? {
              dmsContext: {
                listedIds: dmRoster.listedIds,
                totalOpen: dmRoster.totalOpen
              }
            }
          : {}),
        messageStructure: {
          systemMessages: chatMessages.filter(m => m.role === 'system').length,
          userMessages: chatMessages.filter(m => m.role === 'user').length,
          hasVisionContent: chatMessages.some(m => Array.isArray(m.content))
        }
      }
    }
    // BL-474 step 2: the source of every piece above, for the reply-end decision.
    const addressPieces: AddressSourcePiece[] = [
      { source: 'batshit', text: systemPromptBeforeAwareness },
      { source: 'memory', text: memoryCompileContext?.onMyMindBlock ?? '' },
      {
        source: 'memory',
        text: standingMediaItems.length > 0 ? standingMediaItems.map((item) => item.filename).join('\n') : ''
      },
      ...(compiledHistory.addressSources ?? []),
      // Decision 5: the Zip Index's status lines are Batshit's own words, as they were in the DCM.
      { source: 'batshit', text: zipIndexStatusLines.join('\n') },
      {
        source:
          options?.currentMessageFrom === 'batshit'
            ? (options.currentMessageAddressSource ?? 'agent_note')
            : 'user',
        text: currentMessageFormatted ? (currentUserMessageForAi ?? '') : ''
      },
      ...dynamicInfoResult.addressSourcePieces,
      {
        source: 'memory',
        text: [
          ...memoryDcmLines,
          ...(whiteboardDcmLines ?? memoryCompileContext?.whiteboardDcmLines ?? []),
          ...(memoryCompileContext?.awarenessPendingDcmLines ?? [])
        ].join('\n')
      },
      ...clippedSources
    ]
    const addressSources: CompiledAddressSources = {
      unaccountedInputs: historyAddressSourcesMissing ? 1 : 0,
      pieces: addressPieces.filter((piece) => typeof piece.text === 'string' && piece.text.length > 0),
      nonTextInputs:
        standingMediaItems.length +
        dedupedClippedContent.filter((item) => item.contentType !== 'text').length
    }

    const identitySuffix = mergedSystemPrompt.slice(setupPrefix.length).replace(/^\n\n/, '')
    const identityBeforeAwareness = systemPromptBeforeAwareness.slice(setupPrefix.length).replace(/^\n\n/, '')
    const clippedTextTail = String(live[0].text).slice(textContent.length)
    const finalize = async (fingerprint?: string, additional?: SetupRuntimeAdmission): Promise<FormattedChatInputResult> => {
      setupGuard()
      let baseLive = liveSetup
      if (options?.deferAgentSetup) {
        if (!additional?.apiUtilityScope) throw new Error('The actual API utility registration set is unavailable. Nothing was sent.')
        toolIndex = await readToolIndex(additional.apiUtilityScope)
        setupGuard()
        baseLive = { blocks: [...setupBlocks, ...toolIndex.setupBlocks],
          sources: [...liveSetup.sources, ...toolIndex.sources] }
      }
      const subagentTargets = additional?.apiUtilityScope ? readApiUtilities(additional.apiUtilityScope, { userId, agentId: agent?.id })
        .find(entry => entry.controlId === API_UTILITY_CONTROL_IDS.subagent)?.targets ?? [] : []
      const subagentBlocks = subagentTargets.map(target => subagentSetup.get(target.metadata.slug)).filter((block): block is AgentSetupBlock => !!block)
      if (subagentBlocks.length) subagentBlocks[0] = { ...subagentBlocks[0], text: `subagents:\n${subagentBlocks[0].text}` }
      baseLive = { ...baseLive, blocks: [...baseLive.blocks, ...subagentBlocks] }
      let completeLive: LiveAgentSetup = additional ? {
        blocks: [...baseLive.blocks, ...additional.blocks], sources: [...baseLive.sources, ...additional.sources]
      } : baseLive
      let prefix = setupPrefix
      if (additional?.brokerAvailable !== undefined && additional.brokerAvailable !== Boolean(discoveryAppend)) {
        const before = setupPrefix.slice(0, discoveryOffset)
        const after = setupPrefix.slice(discoveryOffset + discoveryAppend.length).replace(/^\n\n/, '')
        const guide = additional.brokerAvailable ? await this.resolveDynamicMcpPrompt(agent) : ''
        prefix = [before, guide.trim() ? `==== DYNAMIC TOOL SEARCH / DISCOVERY (WHEN ENABLED) ====\n\n${guide}` : '', after].filter(Boolean).join('\n\n')
      }
      if (additional?.toolsRegistered === false) {
        const keep = completeLive.blocks.filter(block => block.section !== 'tools' && !['native_bash', 'runtime_network', 'native_agent_browser'].includes(block.key))
          .map(block => block.key === 'workers' ? { ...block, text: 'workers: disabled (tool runtime unavailable for this model)',
            items: [{ key: 'workers', label: 'workers', text: 'workers: disabled (tool runtime unavailable for this model)' }] } : block)
        const sources = new Set(keep.map(block => block.source))
        completeLive = { blocks: keep, sources: completeLive.sources.filter(source => sources.has(source.id)) }
      }
      // This is the only deferred Judge hint call. It consumes the same live
      // actor/runtime projection, after the actual registrations are known.
      let finalizedDynamic = dynamicInfo
      let finalizedDynamicPieces = dynamicInfoResult.addressSourcePieces
      if (userId && agent?.id && (currentMessageFormatted || prerequisiteDcm)) {
        const skillIndex = additional?.toolsRegistered === false || additional?.brokerAvailable === false
          ? { ...toolIndex, allowedSkillToolHints: [], completeFeatureHintRefs: [] } : toolIndex
        const context = await buildOpenSkillContext({ actor: { userId, sessionId, agentId: agent.id },
          skills: initialOpenSkills, toolIndex: skillIndex })
        finalizedDynamic = replaceOpenSkillSectionInDcm(dynamicInfo, dynamicInfoResult.openSkillsText, context.text)
        if (finalizedDynamic !== dynamicInfo) {
          if (finalizedDynamicPieces.length === 1 && finalizedDynamicPieces[0].text === dynamicInfo) {
            finalizedDynamicPieces = finalizedDynamic ? [{ source: 'batshit', text: finalizedDynamic }] : []
          } else if (!finalizedDynamicPieces.length) {
            finalizedDynamicPieces = finalizedDynamic ? [{ source: 'batshit', text: finalizedDynamic }] : []
          } else {
            const [first, ...rest] = finalizedDynamicPieces
            if (first.source !== 'batshit') throw new Error('The original open skill provenance is unavailable. Nothing was sent.')
            finalizedDynamicPieces = [{ ...first, text: replaceOpenSkillSectionBody(first.text, dynamicInfoResult.openSkillsText, context.text) }, ...rest]
          }
        }
      }
      let openSkillSectionPrefix = ''
      if (subagentTargets.length) {
        const threads = 'subagent_threads:\n' + subagentTargets.map(target =>
          `- ${setupMetadata(target.metadata.slug)}: ${subagentThreads.get(target.metadata.slug) ?? 'unavailable'}`).join('\n')
        openSkillSectionPrefix = disarmCompiledTags(threads)
        const body = finalizedDynamic ? finalizedDynamic.slice('<dynamic_info>\n'.length, -'\n</dynamic_info>'.length) : ''
        finalizedDynamic = compiledElement(COMPILED_TAG.dynamicInfo, [threads, body].filter(Boolean).join('\n\n'))
        finalizedDynamicPieces = finalizedDynamicPieces.length === 1 && finalizedDynamicPieces[0].text === dynamicInfo
          ? [{ source: 'batshit', text: finalizedDynamic }]
          : [{ source: 'batshit', text: threads }, ...finalizedDynamicPieces]
      }
      if (options?.deferAgentSetup && currentMessageFormatted && options.jevJuiceHintProvider) {
        setupGuard()
        try {
          const hints = await options.jevJuiceHintProvider({ currentUserMessage: currentUserMessage ?? '',
            skills: additional?.toolsRegistered === false ? [] : skillsCommandsDcm.capabilities,
            discoverable: additional?.toolsRegistered === false ? [] : toolIndex.discoverable,
            resolvedGatewayIds: additional?.toolsRegistered === false ? null : toolIndex.resolvedGatewayIds })
          if (hints?.length) {
            const beforeHints = finalizedDynamic
            const body = finalizedDynamic ? finalizedDynamic.slice('<dynamic_info>\n'.length, -'\n</dynamic_info>'.length) : ''
            finalizedDynamic = compiledElement(COMPILED_TAG.dynamicInfo, [body, hints.join('\n')].filter(Boolean).join('\n\n'))
            finalizedDynamicPieces = finalizedDynamicPieces.length === 1 && finalizedDynamicPieces[0].text === beforeHints
              ? [{ source: 'batshit', text: finalizedDynamic }]
              : [...finalizedDynamicPieces, { source: 'batshit', text: hints.join('\n') }]
          }
        } catch (error) { console.error('[Agent Setup] Judge hint provider failed; no hint lines this turn:', error) }
      }
      const selection = setupIdentity ? agentSetupCache.prepare({
        identity: setupIdentity, live: completeLive, precedingBytes: prefix,
        toolFingerprint: fingerprint, preview: !options?.agentSetupSend, guard: setupGuard
      }) : undefined
      const setupText = selection?.text ?? renderAgentSetup(completeLive)
      const sentBlocks = selection?.snapshot.blocks ?? completeLive.blocks
      const sizeOf = (predicate: (block: AgentSetupBlock) => boolean) => setupTokenEstimate(sentBlocks.filter(predicate).map(block => block.text).join('\n'))
      const changes = selection?.changes ?? renderSetupChanges(undefined, completeLive)
      const prompt = [prefix, setupText, identitySuffix].filter(Boolean).join('\n\n')
      const beforeAwareness = [prefix, setupText, identityBeforeAwareness].filter(Boolean).join('\n\n')
      const dynamic = changes ? finalizedDynamic
        ? finalizedDynamic.slice(0, '<dynamic_info>\n'.length) + changes + '\n\n' + finalizedDynamic.slice('<dynamic_info>\n'.length)
        : compiledElement(COMPILED_TAG.dynamicInfo, changes)
        : finalizedDynamic
      const newCurrent = [currentMessageElement, dynamic].filter(Boolean).join('\n\n')
      const main = [historyForLLM, newCurrent].filter(Boolean).join('\n\n') + clippedTextTail
      const liveParts = live.map((part, index) => index === 0 ? { ...part, text: main } : part)
      const body = standing.length + liveParts.length === 1 ? main : [...standing, ...liveParts]
      const dynamicPieces = finalizedDynamicPieces
      const originalDynamic = new Set(dynamicInfoResult.addressSourcePieces)
      const updatedPieces = dynamicPieces.length === 1 && dynamicPieces[0].text === finalizedDynamic
        ? [{ source: 'batshit' as const, text: dynamic }]
        : [...(changes ? [{ source: 'batshit' as const, text: changes }] : []), ...dynamicPieces]
      const pieces: AddressSourcePiece[] = []
      let insertedDynamic = false
      const dynamicAddressStart = addressPieces.length - clippedSources.length - 1 - dynamicInfoResult.addressSourcePieces.length
      for (const [index, piece] of addressPieces.entries()) {
        if (index === 0) { pieces.push({ ...piece, text: beforeAwareness }); continue }
        if (!originalDynamic.size && index === dynamicAddressStart && dynamic) pieces.push(...updatedPieces)
        if (originalDynamic.has(piece)) {
          if (!insertedDynamic) { pieces.push(...updatedPieces); insertedDynamic = true }
        } else pieces.push(piece)
      }
      let currentMain = main
      let currentDynamic = dynamic
      let currentCoreDynamic = finalizedDynamic
      let currentOpenText = dynamicInfoResult.openSkillsText
      // Final API registration may have replaced the provisional section before dispatch.
      if (userId && agent?.id && sessionId) {
        const context = await buildOpenSkillContext({ actor: { userId, sessionId, agentId: agent.id },
          skills: initialOpenSkills, toolIndex: additional?.toolsRegistered === false || additional?.brokerAvailable === false
            ? { allowedSkillToolHints: [], completeFeatureHintRefs: [] } : toolIndex })
        currentOpenText = context.text
      }
      const contextIndex = additional?.toolsRegistered === false || additional?.brokerAvailable === false
        ? { allowedSkillToolHints: [], completeFeatureHintRefs: [] } : toolIndex
      // Keep the original pre-countdown identity, since a projected Close bumps revision.
      const projectedOut = new Set((skillZipState.sourceRecord?.entries ?? []).filter(entry => entry.status === 'open' &&
        !initialOpenSkills.some(open => open.agentId === entry.agentId && open.skillId === entry.skillId &&
          open.generation === entry.generation && open.revision === entry.revision))
        .map(entry => `${entry.agentId}:${entry.skillId}:${entry.generation}:${entry.revision}`))
      const visibleSkills = (skills: readonly OpenSkillSession[]) => skills.filter(entry =>
        !projectedOut.has(`${entry.agentId}:${entry.skillId}:${entry.generation}:${entry.revision}`))
      const readOpenSkillContext = userId && agent?.id && sessionId ? async () => buildOpenSkillContext({
        actor: { userId, sessionId, agentId: agent.id }, toolIndex: contextIndex,
        skills: visibleSkills(await readOpenSkillSessions({ userId, sessionId, agentId: agent.id })) }) : undefined
      const refreshOpenSkills = readOpenSkillContext ? async () => {
        setupGuard()
        const context = await readOpenSkillContext()
        if (context.text === currentOpenText) return undefined
        const replaced = replaceOpenSkillSectionInDcm(currentCoreDynamic, currentOpenText, context.text, openSkillSectionPrefix)
        const nextDynamic = changes ? replaced
          ? replaced.slice(0, '<dynamic_info>\n'.length) + changes + '\n\n' + replaced.slice('<dynamic_info>\n'.length)
          : compiledElement(COMPILED_TAG.dynamicInfo, changes) : replaced
        const prefix = [historyForLLM, currentMessageElement].filter(Boolean).join('\n\n')
        const start = prefix.length
        const removed = currentDynamic ? `${prefix ? '\n\n' : ''}${currentDynamic}` : ''
        const inserted = nextDynamic ? `${prefix ? '\n\n' : ''}${nextDynamic}` : ''
        const update = createSkillDcmUpdate(currentMain, start, removed, inserted, context.text)
        currentMain = currentMain.slice(0, start) + inserted + currentMain.slice(start + removed.length)
        currentDynamic = nextDynamic
        currentCoreDynamic = replaced
        currentOpenText = context.text
        return update
      } : undefined
      const previewOpenSkillContext = userId && agent?.id && sessionId ? async (skillId: string, result: Record<string, any>, messageId: string) => {
        const skills = await previewOpenSkillSessions({ userId, sessionId, agentId: agent.id }, skillId,
          result.skillName || result.skill?.name || skillId, messageId)
        return buildOpenSkillContext({ actor: { userId, sessionId, agentId: agent.id }, toolIndex: contextIndex, skills: visibleSkills(skills) })
      } : undefined
      return {
        refreshOpenSkills, readOpenSkillContext, previewOpenSkillContext,
        structuredInput: { ...structuredInput, messages: [{ ...chatMessages[0], content: body }],
          metadata: { ...structuredInput.metadata, mergedSystemPromptLength: prompt.length,
            currentMessageLength: newCurrent.length, agentSetup: {
              placement: 'batshit-zone-end', estimatedTokens: setupTokenEstimate(setupText),
              clock: 'observed-provider-request',
              snapshot: 'frozen',
              skillCatalogTokens: sizeOf(block => block.section === 'skills'),
              featureHintTokens: sizeOf(block => block.hintClass === 'fixed-feature'),
              budgetedToolHintTokens: sizeOf(block => block.hintClass === 'scalable-tools'),
              liveIndex: toolIndex.hintBudget,
              apiUtilityProjection: toolIndex.apiUtilityProjection,
              toolHintBudget: toolIndex.hintBudget.limit, changeNoteTokens: setupTokenEstimate(changes)
            } } },
        primarySystemPrompt: prompt || undefined, subagentDescription, resolvedProjectPath,
        whiteboardContextSnapshot, addressSources: { ...addressSources, pieces: pieces.filter(piece => piece.text) },
        refreshedFileReadsTurn, agentSetup: selection
      }
    }
    // The deferred result is private preparation only. The route finalizes it
    // from its actual registered bundle before budget/EV/provenance capture.
    if (options?.deferAgentSetup) {
      let finalized = false
      return {
        structuredInput, primarySystemPrompt: compiledMainSystemPrompt || undefined,
        subagentDescription, resolvedProjectPath, whiteboardContextSnapshot, addressSources, refreshedFileReadsTurn,
        finalizeAgentSetup(fingerprint, additional) {
          if (finalized) throw new Error('This Agent Setup compile was already finalized.')
          finalized = true
          return finalize(fingerprint, additional)
        }
      }
    }
    return finalize()

  }

  /**
   * Shared insert hook for future mode-agnostic context (voice/SST/TTS, buffer summaries, agent setting notes, etc.)
   * Currently returns empty string; extend as needed without duplicating per-mode logic.
   */
  private buildSharedInsert(_options: {
    voiceState?: any
    bufferSettings?: any
    agentSettings?: any
  } = {}): string {
    return ''
  }
}

// Export singleton instance
export const databaseService = new DatabaseService()
