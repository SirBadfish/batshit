// Database service for Redis operations - Re-export layer
// Maintains the existing API while delegating to focused service clients.

// Import focused service clients and remaining store facades.
import { sessionApiClient } from './sessionApiClient'
import { messageApiClient } from './messageApiClient'
import { agentStore } from './agentStore'
import { slashCommandStore } from './slashCommandStore'
import { userStore, type DeleteFolderOptions } from './userStore'
import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { readPackagedCoreSystemPromptDefault } from '$lib/server/services/systemPromptRegistry'
import {
  type AgentSlashCapability,
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities
} from '$lib/server/services/slashCommandCapabilities'
import { normalizeSubagentType } from '$lib/utils/subagentType'
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
  compileForAI,
  type CompileDeadCopy,
  type ZipCompression,
  type ZipExposed,
  type ZipExposure
} from '$lib/services/messageCompiler'
import { replaceAddressSourceRanges, materializeAddressSources, type PositionedAddressSource } from '$lib/utils/addressSourceRanges'
import { findDeadCopies, type DeadCopyReason } from '$lib/utils/zipDeadCopies'
import { classifyToolResultSize, type ToolResultSizeGuard } from '$lib/utils/toolResultSizeGuard'
import { describeUnzippedItemForDcm } from '$lib/utils/zipHoldWords'
import { normalizeId } from '$lib/utils/idNormalizer'
import { replacePromptVariables } from '$lib/utils/promptVariables'
import { createReference, extractAllReferences } from '$lib/services/universalResolver'
import { buildFileReferenceBlock, type FileReferencePayload } from '$lib/utils/fileMentions'
import {
  type DynamicMcpDiscoverableRef, buildDynamicMcpIndex } from '$lib/server/services/dynamicMcpIndex'
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
  normalizeDynamicMcpPromptContent
} from '$lib/utils/toolPromptInjection'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import { resolveAgentJevJudgeToolEnabled } from '$lib/utils/jevJuiceControl'
import { buildDmRosterDcmLines } from '$lib/utils/dmRoster'
import {
  WORKERS_FEATURE_ENABLED,
  WORKERS_MAX_CONCURRENT,
  WORKERS_MAX_RUNS_PER_TURN,
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
  brokerToolNamesForScope,
  runtimeFlavorToScope
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
import {
  getToolSettings,
  getTypeZipSettings,
  shouldPreferFieldSettingsForTool
} from '$lib/utils/toolRenderMap'
import {
  calculateAgentMessagesFromEndByIndex,
  calculateRecoveryHoldByIndex
} from '$lib/utils/zipMessageAge'
import { resolveZipAgentControlPermission } from '$lib/utils/zipAgentControlPermission'
import {
  calculateInterruptedReasoningRecoveryActiveByIndex,
  getActiveInterruptedReasoningRecoveryBlock
} from '$lib/utils/reasoningRecovery'
import {
  applyContextCompactionToMessages,
  getContextCompactionState
} from '$lib/utils/contextCompaction'
import { applyFixedSessionGraduationToMessages } from '$lib/utils/fixedSessionGraduation'
import { buildControlErrorDcmLines } from '$lib/utils/controlTags'
import { summarizeControlInputSchema } from '$lib/services/controlSchemaSummary'
import { resolveManagedSubagentScope } from '$lib/server/services/subagentRuntimeScope'
import { buildSubagentRosterCapabilityFragment } from '$lib/server/services/subagentRosterCapabilities'
import { buildSubagentThreadStateKey } from '$lib/server/services/subagentThreads'
import {
  buildCliSubagentMcpToolReference,
  buildCliWorkerSpawnToolReference
} from '$lib/utils/cliSubagentToolNames'
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
  isManagedPrimaryAgentType,
  isN8nPrimaryAgentType,
  normalizePrimaryAgentType,
  primaryAgentAllowsAgentBrowser,
  primaryAgentAllowsNativeBash
} from '$lib/utils/primaryAgentType'
import {
  normalizeNativeExecutionBackend,
  type NativeExecutionBackend
} from '$lib/utils/nativeExecutionBackend'

import {
  COMPILED_TAG,
  compiledConversation,
  compiledElement,
  isBatshitWrittenUserMessage,
  type CompiledMessageTag,
  type CurrentMessageFrom
} from '$lib/utils/compiledChatTags'
import { isOutsideNote, type AddressSourceKind, type AddressSourcePiece } from '$lib/utils/imageAddressOrigin'

export type PrecompiledHistory = {
  formattedMessages: string[]
  currentDay: string | null
  chatHistory: string
  globalZipSettings?: Record<string, any>
  /** BL-474 step 2: the source of each piece of `chatHistory` (`compileChatHistory`). */
  addressSources?: AddressSourcePiece[]
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

type NativeAgentBrowserRuntimeMode = 'chromium' | 'chrome-cdp'

type NativeAgentBrowserProvider = 'local' | 'browserbase' | 'browseruse' | 'kernel'

type NativeAgentBrowserDcmState = {
  enabled: boolean
  liveViewEnabled: boolean
  runtimeMode: NativeAgentBrowserRuntimeMode
  provider: NativeAgentBrowserProvider
  cdpPort: number
  timeoutMs: number
  session: string | null
  profilePath: string | null
  executablePath: string | null
  extraFlagsCount: number
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
  private async loadUnzippedFromRedis(sessionId: string): Promise<UnzippedItem[]> {
    try {
      const ids = await redis.sMembers(`unzipped:${sessionId}`)
      if (!ids || ids.length === 0) return []

      const items: UnzippedItem[] = []

      for (const zipId of ids) {
        const raw = await redis.get(`unzipped_item:${sessionId}:${zipId}`)
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
      console.error('[buildFormattedChatInput] Failed to load unzipped items from Redis:', error)
      return []
    }
  }

  private async loadRezippedFromRedis(sessionId: string): Promise<string[]> {
    try {
      const ids = await redis.sMembers(`rezipped:${sessionId}`)
      return ids || []
    } catch (error) {
      console.error('[buildFormattedChatInput] Failed to load rezipped items from Redis:', error)
      return []
    }
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

  private async loadSystemPrompts(
    agent: AgentRow,
    userId?: string,
    promptOptions?: {
      runtimeFlavor?: 'codex' | 'claude' | 'vercel'
    }
  ) {
    let primarySystemPrompt = ''
    let globalCustomPrompt = ''
    let globalZipSettings: Record<string, any> | undefined
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
          if (shouldIncludeGlobalPrompt) {
            globalCustomPrompt = cached.settings.global_custom_system_prompt || ''
          }
          globalZipSettings = cached.settings.global_zip_settings || undefined
          defaultWorkspacePath = cached.settings.default_workspace_path || undefined
        } else {
          invalidateUserSettingsCache(userId)
        }
      }
    }

    const primaryAgentType = normalizePrimaryAgentType(agent)

    if (!isManagedPrimaryAgentType(primaryAgentType)) {
      throw new Error('The n8n Primary Agent type was removed from Batshit.')
    }

    const runtimeFlavor = promptOptions?.runtimeFlavor ?? 'vercel'

    const primaryPromptKey =
      primaryAgentType === 'api' && (runtimeFlavor === 'codex' || runtimeFlavor === 'claude')
        ? getPrimaryAgentSystemPromptRedisKey('cli')
        : getPrimaryAgentSystemPromptRedisKey(primaryAgentType)

    primarySystemPrompt = await this.loadPrimarySystemPrompt(primaryPromptKey)

    if (userId && !hasFreshCachedSettings) {
      // No error caching and no fabricated defaults here: every compile attempts a fresh
      // settings load, and a failure rejects the send loudly (USER_SETTINGS_UNAVAILABLE).
      // Compiling without the user's global prompt / zip settings / workspace path is a
      // silently corrupted send (G-0031/G-0152a).
      const userSettings = await this.getUserSettings(userId)
      if (userSettings) {
        USER_SETTINGS_CACHE.set(userId, { settings: userSettings, fetchedAt: now })
        if (shouldIncludeGlobalPrompt) {
          globalCustomPrompt = userSettings.global_custom_system_prompt || ''
        }
        globalZipSettings = userSettings.global_zip_settings || undefined
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

  /** BL-231: the one rule the Global Tool Grid shows too; OFF with nothing saved. */
  private resolveZipControlPermission(
    agent: any,
    globalZipSettings?: Record<string, any>
  ): boolean {
    return resolveZipAgentControlPermission(agent, globalZipSettings)
  }

  private resolveZipToolNotesEnabled(
    agent: any,
    globalZipSettings?: Record<string, any>
  ): boolean {
    if (typeof agent?.zip_tool_notes_enabled === 'boolean') {
      return agent.zip_tool_notes_enabled
    }

    if (typeof globalZipSettings?.zip_tool_notes_enabled === 'boolean') {
      return globalZipSettings.zip_tool_notes_enabled
    }

    return true
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
    hasPermission: boolean
    notesEnabled: boolean
    agent: any
    zipViewMode: 'inline' | 'appended'
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  }): Promise<string> {
    const promptKey = options.hasPermission
      ? 'batshit:tool_guidance_zip_enabled_prompt'
      : 'batshit:tool_guidance_zip_disabled_prompt'
    const storedPrompt = await this.readStoredPromptText(promptKey)
    const fallbackPrompt = buildToolGuidanceZipPromptBlock({
      runtimeFlavor: options.runtimeFlavor,
      zipControlPermission: options.hasPermission ? 'agent' : 'user',
      zipAiViewMode: options.zipViewMode,
      toolNotesEnabled: options.notesEnabled
    })
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    // SA-096 P1: the Fetch Zip instruction is the one place this block still names a broker
    // tool, so it resolves to the receiving agent's real tool name (DL-4).
    const brokerNames = brokerToolNamesForScope(runtimeFlavorToScope(options.runtimeFlavor))
    return replacePromptVariables(prompt, options.agent, {
      ...(options.agent?.settings ?? {}),
      runtime_flavor: options.runtimeFlavor,
      zip_ai_view_mode: options.zipViewMode,
      zip_control_permission: options.hasPermission ? 'agent' : 'user',
      zip_tool_notes_enabled: options.notesEnabled ? 'enabled' : 'disabled',
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
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
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (!normalized) return null
    if (['plan', 'read_only', 'readonly'].includes(normalized)) return 'plan'
    if (['agent', 'workspace'].includes(normalized)) return 'agent'
    if (['dangerous', 'unrestricted'].includes(normalized)) return 'dangerous'
    return null
  }

  private defaultNativeExecutionBackend(mode: NativeBashAccessMode): NativeExecutionBackend {
    if (mode === 'dangerous') return 'local'
    // Shared single source of truth with native tool dispatch and the settings route's
    // runtime-defaults rider, so all three surfaces agree on the install default (G-0027).
    return resolveDefaultNativeExecutionBackend()
  }

  private normalizeAgentBrowserRuntimeMode(value: unknown): NativeAgentBrowserRuntimeMode | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (!normalized) return null
    if (normalized === 'chromium' || normalized === 'separate-chromium' || normalized === 'separate_chromium') {
      return 'chromium'
    }
    if (normalized === 'chrome-cdp' || normalized === 'chrome_cdp' || normalized === 'cdp' || normalized === 'chrome') {
      return 'chrome-cdp'
    }
    return null
  }

  private normalizeAgentBrowserProvider(value: unknown): NativeAgentBrowserProvider | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (!normalized) return null
    if (normalized === 'local') return 'local'
    if (normalized === 'browserbase') return 'browserbase'
    if (normalized === 'browseruse' || normalized === 'browser_use' || normalized === 'browser-use') {
      return 'browseruse'
    }
    if (normalized === 'kernel') return 'kernel'
    return null
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

  private resolveNativeAgentBrowserDcmState(agent: any): NativeAgentBrowserDcmState | null {
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (!primaryAgentAllowsAgentBrowser(primaryAgentType)) return null

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
    const liveViewEnabled =
      this.parseBooleanSetting(
        nested.agentBrowserLiveViewEnabled ??
          nested.nativeAgentBrowserLiveViewEnabled ??
          providerSettings.agentBrowserLiveViewEnabled ??
          providerSettings.nativeAgentBrowserLiveViewEnabled
      ) ?? true
    const runtimeMode =
      this.normalizeAgentBrowserRuntimeMode(
        nested.agentBrowserRuntimeMode ??
          nested.nativeAgentBrowserRuntimeMode ??
          nested.agentBrowserMode ??
          providerSettings.agentBrowserRuntimeMode ??
          providerSettings.nativeAgentBrowserRuntimeMode
      ) ?? 'chromium'
    const provider =
      this.normalizeAgentBrowserProvider(
        nested.agentBrowserProvider ??
          nested.nativeAgentBrowserProvider ??
          providerSettings.agentBrowserProvider ??
          providerSettings.nativeAgentBrowserProvider
      ) ?? 'local'
    const cdpPort = Math.min(
      65535,
      Math.max(
        1,
        this.parseIntegerSetting(
          nested.agentBrowserCdpPort ??
            nested.nativeAgentBrowserCdpPort ??
            providerSettings.agentBrowserCdpPort ??
            providerSettings.nativeAgentBrowserCdpPort
        ) ?? 9222
      )
    )
    const timeoutMs = Math.min(
      120_000,
      Math.max(
        1_000,
        this.parseIntegerSetting(
          nested.agentBrowserTimeoutMs ??
            nested.nativeAgentBrowserTimeoutMs ??
            providerSettings.agentBrowserTimeoutMs ??
            providerSettings.nativeAgentBrowserTimeoutMs
        ) ?? 45_000
      )
    )
    const session = this.parseOptionalStringSetting(
      nested.agentBrowserSession ??
        nested.nativeAgentBrowserSession ??
        providerSettings.agentBrowserSession ??
        providerSettings.nativeAgentBrowserSession
    )
    const profilePath = this.parseOptionalStringSetting(
      nested.agentBrowserProfilePath ??
        nested.agentBrowserProfile ??
        nested.nativeAgentBrowserProfilePath ??
        nested.nativeAgentBrowserProfile ??
        providerSettings.agentBrowserProfilePath ??
        providerSettings.agentBrowserProfile ??
        providerSettings.nativeAgentBrowserProfilePath ??
        providerSettings.nativeAgentBrowserProfile
    )
    const executablePath = this.parseOptionalStringSetting(
      nested.agentBrowserExecutablePath ??
        nested.nativeAgentBrowserExecutablePath ??
        providerSettings.agentBrowserExecutablePath ??
        providerSettings.nativeAgentBrowserExecutablePath
    )
    const extraFlags = this.parseStringListSetting(
      nested.agentBrowserExtraFlags ??
        nested.nativeAgentBrowserExtraFlags ??
        providerSettings.agentBrowserExtraFlags ??
        providerSettings.nativeAgentBrowserExtraFlags
    )

    return {
      enabled,
      liveViewEnabled,
      runtimeMode,
      provider,
      cdpPort,
      timeoutMs,
      session,
      profilePath,
      executablePath,
      extraFlagsCount: extraFlags.length
    }
  }

  private buildNativeAgentBrowserDcmLines(agent: any): string[] | null {
    const state = this.resolveNativeAgentBrowserDcmState(agent)
    if (!state) return null
    if (!state.enabled) return ['native_agent_browser: disabled']

    const autoDefaults: string[] = []
    if (state.liveViewEnabled) autoDefaults.push('--headed')
    if (state.runtimeMode === 'chrome-cdp') {
      autoDefaults.push(`--cdp http://127.0.0.1:${state.cdpPort}`)
    }
    if (state.provider !== 'local') autoDefaults.push(`-p ${state.provider}`)
    if (state.session) autoDefaults.push(`--session ${state.session}`)
    if (state.profilePath) autoDefaults.push(`--profile ${state.profilePath}`)
    if (state.executablePath) autoDefaults.push('--executable-path <configured>')
    if (state.extraFlagsCount > 0) autoDefaults.push(`extra_flags=${state.extraFlagsCount}`)

    return [
      `native_agent_browser: enabled | via=native_bash_execute | run "agent-browser --help" first | workflow=open <url> -> snapshot -i -> click/fill @eN -> snapshot`,
      `native_agent_browser_defaults: ${autoDefaults.length > 0 ? autoDefaults.join(', ') : '(none)'} | timeout_ms=${state.timeoutMs}`
    ]
  }

  private resolveNativeDynamicMcpEnabled(agent: any): boolean | null {
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (!isManagedPrimaryAgentType(primaryAgentType)) {
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
    if (!isManagedPrimaryAgentType(primaryAgentType)) {
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
    return isManagedPrimaryAgentType(normalizePrimaryAgentType(agent))
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
  private hasBrokerAccess(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  ): boolean {
    return isBrokerAvailable({
      runtime: runtimeFlavorToScope(runtimeFlavor),
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

  private hasAnyToolAccess(context: {
    agent: any
    assignedSubagents?: any[]
    runtimeFlavor?: 'codex' | 'claude' | 'vercel'
  }): boolean {
    const runtimeFlavor = context.runtimeFlavor ?? 'vercel'
    return runtimeFlavor === 'codex' || runtimeFlavor === 'claude' || runtimeFlavor === 'vercel'
  }

  /**
   * SA-104 P3: the Memory guidance block for memory-enabled agents. Mirrored in the
   * one compile path (SA-106 retired the second, n8n-only implementation).
   */
  private async resolveMemoryGuidancePrompt(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  ) {
    const storedPrompt = await this.readStoredPromptText('batshit:tool_guidance_memory_prompt')
    const fallbackPrompt = buildMemoryPromptBlock({ runtimeFlavor })
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    const brokerNames = brokerToolNamesForScope(runtimeFlavorToScope(runtimeFlavor))
    return replacePromptVariables(prompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: runtimeFlavor,
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  private async resolveDynamicMcpPrompt(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  ) {
    const storedPrompt = await this.readStoredPromptText('batshit:dynamic_mcp_prompt')
    const fallbackPrompt = buildDynamicMcpPromptBlock({ runtimeFlavor })
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    const normalizedPrompt = normalizeDynamicMcpPromptContent(prompt)
    // SA-096: drop the other runtimes' tool names, call shapes, and examples before variable
    // substitution so an API agent is never taught a tool name it does not have.
    const scope = runtimeFlavorToScope(runtimeFlavor)
    const scopedPrompt = applyPromptRuntimeScope(normalizedPrompt, scope)
    const brokerNames = brokerToolNamesForScope(scope)
    return replacePromptVariables(scopedPrompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: runtimeFlavor,
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  /**
   * SA-111 P1 (DL-111-01) — the delegation guidance block. Same shape as the broker and
   * memory guidance resolvers: stored Redis prompt first, packaged/code fallback second,
   * runtime-scoped so an API primary is never taught the CLI call shape (or vice versa).
   */
  /**
   * SA-113 P2 (DL-113-04a) — the Agent DM guidance block.
   *
   * Same contract as memory's: the packaged Markdown is the default, Admin can override it
   * in Redis, and the code fallback compiles when neither exists. Gated on
   * `resolveAgentDmsEnabled` alone — an agent without DMs pays nothing.
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

  private async resolveDmGuidancePrompt(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  ) {
    const storedPrompt = await this.readStoredPromptText('batshit:dm_guidance')
    const prompt = storedPrompt?.trim() ? storedPrompt : buildDmGuidancePromptBlock()
    const brokerNames = brokerToolNamesForScope(runtimeFlavorToScope(runtimeFlavor))
    return replacePromptVariables(prompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: runtimeFlavor,
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  /**
   * SA-120 P2 (H1) — the Judge Juice judgment-tool guidance block. Same contract as the DM
   * block: stored Redis prompt first, code fallback second. Gated by the caller on
   * `resolveAgentJevJudgeToolEnabled` alone — the switch that opens `sys.judge.*` in the
   * broker — so an agent without the tool pays nothing and is never taught a control it
   * cannot call.
   */
  private async resolveJevJuiceGuidancePrompt(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  ) {
    const storedPrompt = await this.readStoredPromptText('batshit:jev_juice_guidance')
    const prompt = storedPrompt?.trim() ? storedPrompt : buildJevJuiceGuidancePromptBlock()
    const brokerNames = brokerToolNamesForScope(runtimeFlavorToScope(runtimeFlavor))
    return replacePromptVariables(prompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: runtimeFlavor,
      tool_search_tool: brokerNames.search,
      tool_use_tool: brokerNames.use
    })
  }

  private async resolveSubagentGuidancePrompt(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel'
  ) {
    const storedPrompt = await this.readStoredPromptText('batshit:subagent_guidance')
    const fallbackPrompt = buildSubagentGuidancePromptBlock({ runtimeFlavor })
    const prompt = storedPrompt?.trim() ? storedPrompt : fallbackPrompt
    const scope = runtimeFlavorToScope(runtimeFlavor)
    const scopedPrompt = applyPromptRuntimeScope(prompt, scope)
    return replacePromptVariables(scopedPrompt, agent, {
      ...(agent?.settings ?? {}),
      runtime_flavor: runtimeFlavor
    })
  }

  private shouldInjectToolGuidance(context: {
    agent: any
    assignedSubagents?: any[]
    runtimeFlavor?: 'codex' | 'claude' | 'vercel'
  }): boolean {
    return this.hasAnyToolAccess({
      agent: context.agent,
      assignedSubagents: context.assignedSubagents,
      runtimeFlavor: context.runtimeFlavor
    })
  }

  private shouldInjectZipGuidance(
    messages: Message[],
    agent: any,
    globalZipSettings?: Record<string, any>,
    context?: {
      assignedSubagents?: any[]
      runtimeFlavor?: 'codex' | 'claude' | 'vercel'
    }
  ): boolean {
    const hasPermission = this.resolveZipControlPermission(agent, globalZipSettings)
    if (hasPermission) return true

    const hasZipHistory = messages.some((message) => {
      const metadata = (message as any)?.metadata || {}
      if (Array.isArray(metadata?.zipIds) && metadata.zipIds.length > 0) return true
      if (Array.isArray(metadata?.zip_ids) && metadata.zip_ids.length > 0) return true
      if (typeof message?.content !== 'string') return false
      const refs = extractAllReferences(message.content)
      return refs.some((ref) => ref.type === 'zip')
    })
    if (hasZipHistory) return true

    return this.hasAnyToolAccess({
      agent,
      assignedSubagents: context?.assignedSubagents,
      runtimeFlavor: context?.runtimeFlavor
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
      const summary = noteSummary || fallbackSummary

      const summarySegment = summary ? ` | summary: "${summary}"` : ''

      indexLines.push(
        `${indexLines.length + 1}) ${messageId} | tool: ${toolName} | zipId (use in unzip/zip): ${zipId}${summarySegment}`
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
        'Unzipped content (chronological):',
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
              onDeliveredSource: (piece) => messagePieces.push(piece)
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

    return { formattedMessages, currentDay, chatHistory, compressedZips, exposedZips, addressSources }
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
    const messages = (await redis.getSessionMessages(sessionId)) as Message[]
    const newestUser = [...messages].reverse().find((message) => message.role === 'user')
    const newestReply = [...messages].reverse().find((message) => message.role === 'assistant' && message.agent_id)
    const requestedProjectPath =
      typeof (newestUser as any)?.metadata?.projectPath === 'string'
        ? ((newestUser as any).metadata.projectPath as string).trim()
        : ''
    let projectPath: string | null = requestedProjectPath || null
    if (!projectPath && newestReply?.agent_id) {
      const agent = (await redis.getAgents(userId)).find((row) => row.id === newestReply.agent_id) ?? null
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
    const reasons = new Map<string, DeadCopyReason>()
    for (const [zipId, dead] of findDeadCopies(results, { projectPath })) reasons.set(zipId, dead.reason)
    return reasons
  }

  /**
   * SA-129 P1 (DL-01): every tool result this pass will compile, in chat order, read through the
   * pass's own zip resolver, then `findDeadCopies`. Each dead copy carries how many of its
   * author's replies had finished when it died (`agentMessagesFromEndByIndex` at its message
   * minus at the message that killed it), which decides whether its reference names the reason.
   * A zip that cannot be read is left out, so it can neither die nor kill another copy.
   */
  private async findHistoryDeadCopies(
    messages: Message[],
    resolveZip: (zipId: string) => Promise<any | null>,
    projectPath: string | null,
    agentMessagesFromEndByIndex: number[]
  ): Promise<Map<string, CompileDeadCopy>> {
    const { results, messageIndexByZip } = await collectDeadCopyToolResults(messages, resolveZip)

    const deadCopies = new Map<string, CompileDeadCopy>()
    for (const [zipId, dead] of findDeadCopies(results, { projectPath })) {
      const readAt = messageIndexByZip.get(zipId) ?? dead.deadAtMessageIndex
      deadCopies.set(zipId, {
        reason: dead.reason,
        repliesUntilDead: Math.max(
          0,
          (agentMessagesFromEndByIndex[readAt] ?? 0) - (agentMessagesFromEndByIndex[dead.deadAtMessageIndex] ?? 0)
        )
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
    }
  ): Promise<PrecompiledHistory> {
    const fetchImpl = options?.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined)

    const {
      globalZipSettings: loadedGlobalZipSettings,
      agentDefaultProjectPath,
      defaultWorkspacePath
    } = await this.loadSystemPrompts(agent, userId)
    const globalZipSettings =
      options?.globalZipSettingsOverride ?? loadedGlobalZipSettings
    const agentForHistory =
      options?.zipSettingsAgentOverride !== undefined
        ? options.zipSettingsAgentOverride
        : agent

    // F-P5-11: this pass's own zip state, read from Redis. Server compiles overlap in one
    // process, so none of them reads or writes the browser's `zippingService` singleton.
    const [serverUnzipped, serverRezipped] = await Promise.all([
      this.loadUnzippedFromRedis(sessionId),
      this.loadRezippedFromRedis(sessionId)
    ])
    const zipState = createZipStateView(serverUnzipped, serverRezipped)

    const speakers = await this.buildSpeakerView(messages, agent, options?.groupContext)

    // SA-109: group runs compile history once and reuse it per speaker, so the
    // clip rewrite has to happen here too — no lane keeps raw clip syntax.
    const clipCompileState = await this.resolveSessionClipCompileState(
      sessionId,
      userId,
      fetchImpl
    )

    const { formattedMessages, currentDay, chatHistory, addressSources } = await this.compileChatHistory(
      messages,
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
      addressSources
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
        fileReferences: Array.isArray(metadata.fileReferences) ? metadata.fileReferences : [],
        subagentIds: Array.isArray(metadata.subagentSnapshot) ? metadata.subagentSnapshot : []
      }
    }
    return null
  }

  private buildZipStateSnapshot(
    messages: Message[],
    unzipped: UnzippedItem[],
    deadCopies: Map<string, DeadCopyReason> = new Map(),
    sizeGuards: Map<string, ToolResultSizeGuard> = new Map()
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
      sizeGuards
    }
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

    const resolveBooleanSetting = (key: string) => {
      if (typeof agent?.[key] === 'boolean') return agent[key]
      if (typeof globalZipSettings?.[key] === 'boolean') return globalZipSettings[key]
      return false
    }

    if (resolveBooleanSetting('auto_zip_all_other_tools')) {
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
    /** Server-resolved turn selection; undefined keeps non-turn preview defaults. */
    mcpGatewayScope?: string[]
    userId?: string | null
    agentId?: string | null
    projectPath?: string | null
    nativeDynamicMcpEnabled?: boolean | null
    nativeCliToolsEnabled?: boolean | null
    isCodexMode?: boolean
  }): Promise<{
    text: string
    /** SA-120 P1: the typed refs the agent can reach, for the Judge Juice hint provider. */
    discoverable: DynamicMcpDiscoverableRef[]
    resolvedGatewayIds: string[] | null
  }> {
    const empty = { text: '', discoverable: [] as DynamicMcpDiscoverableRef[], resolvedGatewayIds: null }
    const userId = options.userId?.trim()
    const agentId = options.agentId?.trim()
    if (!userId || !agentId) return empty

    try {
      const result = await buildDynamicMcpIndex({
        userId,
        agentId,
        selectedGateways: options.mcpGatewayScope,
        projectPath: options.projectPath ?? null,
        nativeDynamicMcpEnabled: options.nativeDynamicMcpEnabled,
        cliToolsEnabled:
          typeof options.nativeCliToolsEnabled === 'boolean'
            ? options.nativeCliToolsEnabled
            : undefined,
        isCodexMode: options.isCodexMode === true
      })
      return {
        text: typeof result.text === 'string' ? result.text : '',
        discoverable: Array.isArray(result.discoverable) ? result.discoverable : [],
        resolvedGatewayIds: result.resolvedGatewayIds ?? null
      }
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to build MCP DCM index:', error)
      return empty
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
      return { lines: [], capabilities: [] }
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

  private async buildDynamicInfoBlock(options: {
    /** Server-resolved turn selection; undefined keeps non-turn preview defaults. */
    mcpGatewayScope?: string[]
    userId?: string | null
    currentUserMessage?: string | null
    agentRecord?: any
    agentId?: string | null
    projectPath?: string | null
    agentDefaultProjectPath?: string | null
    projectRules?: Record<string, any> | null
    fileReferences?: FileReferencePayload[]
    subagentDescriptions?: Record<string, string>
    /** SA-111 P1 (DL-111-03): per-subagent `type; model; tools; skills; thread` facts. */
    subagentCapabilityFragments?: Record<string, string>
    assignedSubagents?: any[]
    defaultWorkspacePath?: string | null
    nativeDynamicMcpEnabled?: boolean | null
    previousSnapshot?: {
      projectPath?: string | null
      projectRules?: Record<string, any> | null
      fileReferences?: FileReferencePayload[]
      subagentIds?: string[]
    } | null
    goonId?: string | null
    goonsEnabled?: boolean
    goonsSettings?: GoonsSettings | null
    goonPresentationMode?: DesktopGoonPresentationMode | null
    groupContext?: GroupChatDcmContext
    voiceState?: VoiceState
    zipState?: {
      hasZipHistory: boolean
      unzipped: UnzippedItem[]
      /** SA-129 P2: the held items this compile compressed as dead copies, and why. */
      deadCopies?: Map<string, DeadCopyReason>
      sizeGuards?: Map<string, ToolResultSizeGuard>
    }
    autoZipContent?: string[]
    autoZipTools?: string[]
    zipControlPermission?: boolean
    zipAiViewMode?: 'inline' | 'appended'
    isCodexMode?: boolean
    controlErrorLines?: string[]
    /** SA-104 P4: preformatted "Memory context:" lines from the recall engine. */
    memoryDcmLines?: string[]
    /** SA-109 (DL-109-04): the general clip roster — all agents, groups included. */
    clipRosterDcmLines?: string[]
    /** SA-113 P2 (DL-113-04b): the `DMs:` roster — open inbox items only. */
    dmRosterDcmLines?: string[]
    /** SA-110 (DL-110-01): the episode whiteboard section (Infinite Sessions only). */
    whiteboardDcmLines?: string[]
    /** SA-110 P2 (DL-110-05): awareness changes newer than the stored fold snapshot. */
    awarenessPendingDcmLines?: string[]
    /**
     * SA-120 P1 (DL-120-05): the route-owned Judge Juice hint provider. Called once with the
     * agent's skills and discoverable refs after every other section is built; its lines
     * close the DCM (the cache-free tail). Absent on subagent and group compiles.
     */
    jevJuiceHintProvider?: JevJuiceHintProvider
  }): Promise<{ text: string; addressSourcePieces: AddressSourcePiece[] }> {
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

    const subagentDescriptions = options.subagentDescriptions || {}
    const subagentKeys = Object.keys(subagentDescriptions)
    const currentSubagentIds = normalizeList(
      (options.assignedSubagents || []).map((candidate) => String(candidate?.id || ''))
    )
    const previousSubagentIds = normalizeList(options.previousSnapshot?.subagentIds || [])
    const subagentStatus = resolveStatus(currentSubagentIds, previousSubagentIds)

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

    const agentId = options.agentId?.trim()
    if (agentId) {
      lines.push(`${statusIcons.current} agent_id: ${agentId}`)
    }
    lines.push(`${subagentStatus} subagents:`)

    if (subagentKeys.length > 0) {
      if (options.isCodexMode === true) {
        lines.push('CLI subagent delegation: call the MCP server/tool pair shown for the chosen subagent.')
      }
      for (const key of subagentKeys) {
        const subagent = options.assignedSubagents?.find((candidate) => {
          return resolveSubagentSlug(candidate) === key
        })
        const displayName = subagent?.displayName || subagent?.name || key
        const rawDescription = subagentDescriptions[key] || ''
        const cleanedDescription = rawDescription.replace(/\s+/g, ' ').trim()
        const cliToolReference =
          options.isCodexMode === true
            ? buildCliSubagentMcpToolReference(options.agentRecord, subagent)
            : null
        const toolSuffix = cliToolReference
          ? `; server: ${cliToolReference.serverName}; tool: ${cliToolReference.toolName}; full: ${cliToolReference.fullToolName}`
          : ''
        const label = displayName ? `${displayName} (${key}${toolSuffix})` : key
        // SA-111 P1 (DL-111-03): capability facts trail the description so the primary can
        // pick the right specialist instead of guessing from a name.
        const capabilityFragment = options.subagentCapabilityFragments?.[key]?.trim() || ''
        const capabilitySuffix = capabilityFragment ? ` \u2014 ${capabilityFragment}` : ''
        lines.push(
          cleanedDescription
            ? `- ${label}: ${cleanedDescription}${capabilitySuffix}`
            : `- ${label}${capabilitySuffix}`
        )
      }
    } else {
      lines.push('- (none)')
    }

    // SA-111 P4 (DL-111-03): the workers line and the `spawn_workers` tool ship together —
    // an agent told it has workers must actually have the tool, and an agent whose setting
    // is off must be told so rather than left guessing. On a managed CLI lane the line
    // carries the exact composed MCP name, the same AMD-111-01 rule the subagent lines use.
    if (WORKERS_FEATURE_ENABLED) {
      if (resolveWorkersEnabled(options.agentRecord)) {
        const workerToolReference =
          options.isCodexMode === true
            ? buildCliWorkerSpawnToolReference(options.agentRecord)
            : null
        const workerToolSuffix = workerToolReference
          ? `; tool: ${workerToolReference.fullToolName}`
          : ''
        lines.push(
          `workers: enabled (max ${WORKERS_MAX_CONCURRENT} parallel, ${WORKERS_MAX_RUNS_PER_TURN} per turn)${workerToolSuffix}`
        )
      } else {
        lines.push('workers: disabled')
      }
    }

    lines.push('')

    const previousProjectPath = options.previousSnapshot?.projectPath?.trim() || ''
    const projectStatus = resolveStatus(
      resolvedProjectPath || '(not set)',
      previousProjectPath || '(not set)'
    )

    lines.push(`${projectStatus} project_path: ${resolvedProjectPath || '(not set)'}`)
    const previousProjectRules =
      options.previousSnapshot?.projectRules &&
      typeof options.previousSnapshot.projectRules === 'object' &&
      !Array.isArray(options.previousSnapshot.projectRules)
        ? options.previousSnapshot.projectRules
        : null
    const currentProjectRulesKey = projectRules ? JSON.stringify(projectRules) : ''
    const previousProjectRulesKey = previousProjectRules ? JSON.stringify(previousProjectRules) : ''
    const projectRulesStatus = resolveStatus(currentProjectRulesKey, previousProjectRulesKey)
    if (projectRules) {
      lines.push(`${projectRulesStatus} project_rules_json:`)
      const serializedRules = JSON.stringify(projectRules, null, 2)
      for (const line of serializedRules.split('\n')) {
        lines.push(`  ${line}`)
      }
    }
    const nativeBashLine = this.buildNativeBashDcmLine(options.agentRecord)
    if (nativeBashLine) {
      lines.push(`${statusIcons.current} ${nativeBashLine}`)
    }
    const runtimeNetworkLine = this.buildRuntimeNetworkDcmLine(options.agentRecord)
    if (runtimeNetworkLine) {
      lines.push(`${statusIcons.current} ${runtimeNetworkLine}`)
    }
    const nativeAgentBrowserLines = this.buildNativeAgentBrowserDcmLines(options.agentRecord)
    if (nativeAgentBrowserLines?.length) {
      lines.push(`${statusIcons.current} ${nativeAgentBrowserLines[0]}`)
      for (const detailLine of nativeAgentBrowserLines.slice(1)) {
        lines.push(`  ${detailLine}`)
      }
    }
    const skillsCommandsDcm = await this.buildSkillsCommandsDcm({
      userId: options.userId,
      agentId: options.agentId
    })
    const skillsCommandsLines = skillsCommandsDcm.lines
    if (skillsCommandsLines.length > 0) {
      lines.push('', ...skillsCommandsLines)
    }

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

    // SA-110 (DL-110-01): the episode whiteboard rides here — a sibling directly
    // after the memory section, present even when that section is empty. Tail bytes
    // are cache-free by construction, so the board's by-design churn costs nothing.
    if (options.whiteboardDcmLines && options.whiteboardDcmLines.length > 0) {
      lines.push('', ...options.whiteboardDcmLines)
    }

    const zipState = options.zipState
    const autoZipContent = Array.isArray(options.autoZipContent) ? options.autoZipContent : []
    const autoZipTools = Array.isArray(options.autoZipTools) ? options.autoZipTools : []
    const hasAutoZip = autoZipContent.length > 0 || autoZipTools.length > 0
    if (zipState?.hasZipHistory || hasAutoZip) {
      const unzipped = Array.isArray(zipState?.unzipped) ? zipState.unzipped : []
      lines.push('', 'Current Zip State:')
      if (options.zipAiViewMode) {
        lines.push(`- zip_ai_view_mode: ${options.zipAiViewMode}`)
      }
      if (typeof options.zipControlPermission === 'boolean') {
        lines.push(
          `- zip_control_permission: ${options.zipControlPermission ? 'agent' : 'user-only'}`
        )
      }
      if (autoZipContent.length > 0) {
        lines.push(`- Auto-zipped content: ${autoZipContent.join(', ')}`)
      }
      if (autoZipTools.length > 0) {
        lines.push(`- Auto-zipped tools: ${autoZipTools.join(', ')}`)
      }
      if (unzipped.length === 0) {
        lines.push('- Unzipped: (none)')
      } else {
        for (const item of unzipped) {
          lines.push(
            describeUnzippedItemForDcm(item, {
              agentId: options.agentId ?? null,
              deadCopy: zipState?.deadCopies?.get(normalizeId(item.zipId)) ?? null,
              sizeGuard: zipState?.sizeGuards?.get(normalizeId(item.zipId)) ?? null
            })
          )
        }
      }
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

    let discoverable: DynamicMcpDiscoverableRef[] = []
    let resolvedGatewayIds: string[] | null = null
    if (options.agentRecord) {
      const mcpDcm = await this.buildDynamicMcpDcm({
        mcpGatewayScope: options.mcpGatewayScope,
        userId: options.userId,
        agentId: options.agentId,
        projectPath:
          options.projectPath ??
          options.agentDefaultProjectPath ??
          options.defaultWorkspacePath ??
          null,
        nativeDynamicMcpEnabled: options.nativeDynamicMcpEnabled,
        nativeCliToolsEnabled: this.resolveCliToolsEnabled(options.agentRecord),
        isCodexMode: options.isCodexMode
      })
      discoverable = mcpDcm.discoverable
      resolvedGatewayIds = mcpDcm.resolvedGatewayIds

      if (mcpDcm.text) {
        lines.push('', ...mcpDcm.text.split('\n'))
      }
    }

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

    if (!lines.length) return { text: '', addressSourcePieces: [] }
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
    return { text, addressSourcePieces }
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
      /** Same server-resolved turn scope used by execution and credentials. */
      mcpGatewayScope?: string[]
      fetch?: typeof fetch
      runtimeFlavor?: 'codex' | 'claude' | 'vercel'
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
    }
  ): Promise<{
    structuredInput: any
    primarySystemPrompt?: string
    subagentDescription?: Record<string, string>
    resolvedProjectPath?: string | null
    /** BL-474 step 2: what this compile delivered, piece by piece, with each piece's source. */
    addressSources: CompiledAddressSources
  }> {
    // Server compilation must not fall back to global fetch for relative app routes.
    // SvelteKit only allows request-scoped event.fetch for those URLs.
    const fetchImpl = options?.fetch

    const {
      primarySystemPrompt,
      globalCustomPrompt,
      globalZipSettings,
      defaultWorkspacePath,
      agentDefaultProjectPath,
      agentDefaultProjectRules
    } = await this.loadSystemPrompts(agent, userId, options)
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
    const [storedUnzipped, serverRezipped] = await Promise.all([
      this.loadUnzippedFromRedis(sessionId),
      this.loadRezippedFromRedis(sessionId)
    ])
    // SA-129 P2: a new user message counts once toward every temporary hold at the accepted-send
    // boundary; this compile already sees the state as it will be then (a hold that ends with
    // this message is gone, the others show one more message).
    const serverUnzipped = options?.countsPendingUserMessage
      ? countOneMoreMessage(storedUnzipped).kept
      : storedUnzipped
    // SA-120 P5: whose rezip each marker is. Only a smart-zip turn needs it (Jev may reopen
    // its own rezip and nobody else's), so every other compile skips these reads.
    const serverRezippedSources =
      options?.jevJuiceSmartZipProvider && serverRezipped.length > 0
        ? await loadRezippedSources(sessionId, serverRezipped)
        : {}

    let zipState = createZipStateView(serverUnzipped, serverRezipped, serverRezippedSources)

    const sessionRecord = await redis.getSession(sessionId).catch(() => null)
    const compactionState = getContextCompactionState(sessionRecord?.metadata ?? null)
    // SA-104 P6: Infinite-Session graduation applies at the same site as compaction
    // (idempotent; regular sessions pass through unchanged — DL-104-12). This server
    // application is load-bearing for approval resumes, which reload raw messages.
    const contextMessages = applyFixedSessionGraduationToMessages(
      applyContextCompactionToMessages(messages, compactionState.events),
      sessionRecord
    )
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
          addressSources: precompiledHistory.addressSources ?? []
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
      const zippedItems = compiledHistory.compressedZips.filter((zip) => !zip.deadCopy)
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
              !zip.sizeGuard &&
              !(zip.zipType === 'cool_tool' && classifyToolResultSize(zip.tokens)) &&
              !zip.groupUnshared &&
              (zip.rezippedBy === null || zip.rezippedBy === 'inferred')
          )
          .map((zip) => [zip.zipId, zip] as const)
      )
      const accepted = (Array.isArray(opens) ? opens : []).filter((open) => open && openable.has(open.zipId))
      if (accepted.length > 0) {
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
          [...serverUnzipped.filter((item) => !openedIds.has(normalizeId(item.zipId))), ...overlay],
          serverRezipped.filter((id) => !openedIds.has(normalizeId(id))),
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
      const promptLabel = getPrimaryAgentSystemPromptLabel(
        normalizePrimaryAgentType(agent) as 'api' | 'cli'
      )
      mergedSystemPrompt += `==== ${promptLabel} ====\n\n${processedPrimary}`
    }

    const runtimeFlavor = options?.runtimeFlavor ?? 'vercel'

    const zipPermission = this.resolveZipControlPermission(agent, globalZipSettings)
    const zipViewMode = this.resolveZipAiViewMode(agent, globalZipSettings)
    const zipToolNotesEnabled = this.resolveZipToolNotesEnabled(agent, globalZipSettings)
    const shouldInjectToolGuidance = this.shouldInjectToolGuidance({
      agent,
      assignedSubagents,
      runtimeFlavor
    })
    const shouldInjectZipGuidance = this.shouldInjectZipGuidance(contextMessages, agent, globalZipSettings, {
      assignedSubagents,
      runtimeFlavor
    })
    if (shouldInjectToolGuidance || shouldInjectZipGuidance) {
      const toolZipPrompt = await this.resolveToolZipGuidancePrompt({
        hasPermission: zipPermission,
        notesEnabled: zipToolNotesEnabled,
        agent,
        zipViewMode,
        runtimeFlavor
      })
      if (toolZipPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        const label = zipPermission
          ? 'TOOL + ZIP GUIDANCE (ZIP CONTROL ENABLED)'
          : 'TOOL + ZIP GUIDANCE (ZIP CONTROL USER-ONLY)'
        mergedSystemPrompt += `==== ${label} ====\n\n${toolZipPrompt}`
      }
    }

    // SA-096 P5: the broker block is gated on broker availability alone, not nested under
    // the tool + zip condition. `shouldInjectToolGuidance` is stricter than the broker on
    // the n8n lane (it wants MCP selections or subagents), so nesting hid the instructions
    // from n8n agents whose Batshit Tools node advertises broker families in their DCM.
    if (this.hasBrokerAccess(agent, runtimeFlavor)) {
      const dynamicMcpPrompt = await this.resolveDynamicMcpPrompt(agent, runtimeFlavor)
      if (dynamicMcpPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== DYNAMIC TOOL SEARCH / DISCOVERY (WHEN ENABLED) ====\n\n${dynamicMcpPrompt}`
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
      const delegationPrompt = await this.resolveSubagentGuidancePrompt(agent, runtimeFlavor)
      if (delegationPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== SUBAGENTS & WORKERS (DELEGATION) ====\n\n${delegationPrompt}`
      }
    }

    // SA-113 P2 (DL-113-04a): Agent DM guidance sits directly after the delegation block
    // and before MEMORY INSTRUCTIONS — both are "other things you can reach", and DMs are
    // the closer sibling of delegation. Stable-prefix bytes: they move only when the
    // agent's `dms_enabled` or the stored prompt changes.
    if (resolveAgentDmsEnabled(agent)) {
      const dmPrompt = await this.resolveDmGuidancePrompt(agent, runtimeFlavor)
      if (dmPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== AGENT DMS (MESSAGING) ====\n\n${dmPrompt}`
      }
    }

    // SA-120 P2 (H1): the Judge Juice judgment-tool guidance sits directly after the DM
    // block and before MEMORY INSTRUCTIONS — one more "thing you can reach". Gated on the
    // agent's `jev_juice_judge_tool` switch alone, the same switch that opens `sys.judge.*`
    // in the broker (DL-120-06), so a control the agent cannot call is never taught.
    // Stable-prefix bytes: they move only when the switch or the stored prompt changes.
    // Jev's ANSWERS never land here (DL-120-05); this only teaches how to ask.
    if (resolveAgentJevJudgeToolEnabled(agent)) {
      const jevPrompt = await this.resolveJevJuiceGuidancePrompt(agent, runtimeFlavor)
      if (jevPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== JUDGE JUICE (JUDGMENT TOOL) ====\n\n${jevPrompt}`
      }
    }

    // SA-104 P3: memory guidance is gated on per-agent memory enablement alone — the
    // inline <batshit-memory> save works without any broker family. Part of the stable
    // compiled prefix (DL-104-04): it changes only when enablement or the stored prompt
    // changes.
    if (resolveAgentMemoryEnabled(agent)) {
      const memoryPrompt = await this.resolveMemoryGuidancePrompt(agent, runtimeFlavor)
      if (memoryPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== MEMORY INSTRUCTIONS (AGENT MEMORY ENABLED) ====\n\n${memoryPrompt}`
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
        //
        // SA-111 P2: two owners, two keys. Batshit stores a managed API/CLI subagent's
        // exchanges itself, while an n8n Workflow Subagent's conversation lives in n8n's own
        // Redis — Batshit only holds the thread id that names it (DL-111-06). Reading the
        // managed key for an n8n subagent would report `none` whenever n8n runs on a
        // separate Redis, which is exactly the kind of confident-but-wrong roster fact the
        // primary would act on.
        let threadState: 'none' | 'resumable' = 'none'
        if (sessionId) {
          const threadKey = buildSubagentThreadStateKey(
            sessionId,
            safeKey,
            subagentScope.subagentType
          )
          try {
            threadState = (await redis.exists(threadKey)) ? 'resumable' : 'none'
          } catch (error) {
            console.warn('[buildDynamicInfoBlock] Failed to read subagent thread state:', error)
          }
        }

        const needsGatewayNames =
          subagentScope.subagentType !== 'n8n-workflow' &&
          subagentScope.nativeToolSettings.dynamicMcpEnabled &&
          subagentScope.resolvedGateways.length > 0
        subagentCapabilityFragments[safeKey] = buildSubagentRosterCapabilityFragment({
          scope: subagentScope,
          capabilities: subagentCapabilities,
          gatewayNames: needsGatewayNames ? await resolveGatewayNames() : new Map(),
          model: subagentModel.model,
          provider: subagentModel.provider,
          threadState
        })
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
    // edited since) says so in `Current Zip State`, so the agent is never surprised.
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
      heldSizeGuards
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
    const controlErrorLines = buildControlErrorDcmLines(contextMessages as any[])
    const dynamicInfoResult = currentMessageFormatted
        ? await this.buildDynamicInfoBlock({
          mcpGatewayScope: options?.mcpGatewayScope,
          userId: userId ?? null,
          controlErrorLines,
          currentUserMessage: currentUserMessage ?? null,
          agentRecord: agent,
          agentId: agent?.id ?? null,
          projectPath: options?.projectPath ?? null,
          agentDefaultProjectPath: agentDefaultProjectPath ?? null,
          projectRules,
          defaultWorkspacePath: defaultWorkspacePath ?? null,
          fileReferences: options?.fileReferences ?? [],
          subagentDescriptions: subagentDescription,
          subagentCapabilityFragments,
          assignedSubagents,
          nativeDynamicMcpEnabled,
          previousSnapshot,
          goonId: agent?.goon_id ?? null,
          goonsEnabled,
          goonsSettings: options?.goonsSettings ?? null,
          goonPresentationMode: options?.goonPresentationMode ?? null,
          jevJuiceHintProvider: options?.jevJuiceHintProvider,
          groupContext: options?.groupContext,
          voiceState: options?.voiceState,
          zipState: zipStateSnapshot,
          autoZipContent: autoZipSummary.autoZipContent,
          autoZipTools: autoZipSummary.autoZipTools,
          zipControlPermission: zipPermission,
          zipAiViewMode: zipViewMode,
          isCodexMode: options?.runtimeFlavor === 'codex' || options?.runtimeFlavor === 'claude',
          memoryDcmLines,
          clipRosterDcmLines,
          dmRosterDcmLines: dmRoster.lines,
          whiteboardDcmLines: memoryCompileContext?.whiteboardDcmLines ?? [],
          awarenessPendingDcmLines: memoryCompileContext?.awarenessPendingDcmLines ?? []
        })
      : { text: '', addressSourcePieces: [] }
    const dynamicInfo = dynamicInfoResult.text
    const currentMessageForLLM = currentMessageFormatted
      ? dynamicInfo
        ? `${currentMessageFormatted}\n\n${dynamicInfo}`
        : currentMessageFormatted
      : ''
    
    // SA-128 (DL-01): `<conversation>` (and the zip index), then the new message and its
    // `<dynamic_info>`. The tags carry the structure, so there are no section headers.
    if (resolvedChatHistory) {
      textContent += resolvedChatHistory
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
        previousConversationLength: resolvedChatHistory?.length || 0,
        currentMessageLength: currentMessageForLLM?.length || 0,
        unzippedItemsCount,
        clippedItemsCount: dedupedClippedContent.length,
        standingMediaCount: standingMediaItems.length,
        resolvedProjectPath,
        assignedSubagents: assignedSubagentMetadata,
        subagentModels,
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
          ...(memoryCompileContext?.whiteboardDcmLines ?? []),
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

    return {
      structuredInput,  // The actual structured data
      primarySystemPrompt: compiledMainSystemPrompt || undefined,
      subagentDescription: subagentDescription,
      resolvedProjectPath,
      addressSources
    }
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
