// Database service for Redis operations - Re-export layer
// Maintains the existing API while delegating to focused service clients.

// Import focused service clients and remaining store facades.
import { sessionApiClient } from './sessionApiClient'
import { messageApiClient } from './messageApiClient'
import { agentStore } from './agentStore'
import { slashCommandStore } from './slashCommandStore'
import { userStore } from './userStore'
import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import {
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities
} from '$lib/server/services/slashCommandCapabilities'
import { normalizeSubagentType } from '$lib/utils/subagentType'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import type { UnzippedItem } from '$lib/services/zipping'

// Import types
import type { ChatSessionRow, ChatMemoryRow, AgentRow, UserSettingsRow, ClipRow, SessionClipRow, ChatFolderRow, SubagentRow } from '$lib/types/database'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'
import type { DesktopGoonPresentationMode } from '$lib/goons/desktopGoonPresentation'
import type { Message } from '$lib/stores/messages.svelte'
import type { GroupChatAgentSettings } from '$lib/types/groupChat'
import { compileForAI, type ZipExposure } from '$lib/services/messageCompiler'
import { normalizeId } from '$lib/utils/idNormalizer'
import { replacePromptVariables } from '$lib/utils/promptVariables'
import { createReference, extractAllReferences } from '$lib/services/universalResolver'
import { buildFileReferenceBlock, type FileReferencePayload } from '$lib/utils/fileMentions'
import { buildDynamicMcpIndex } from '$lib/server/services/dynamicMcpIndex'
import {
  buildGoonDcmLines as formatGoonDcmLines,
  shouldIncludeGoonSpokenCues
} from '$lib/goons/dcm'
import {
  buildDynamicMcpPromptBlock,
  buildMemoryPromptBlock,
  buildToolGuidanceZipPromptBlock,
  normalizeDynamicMcpPromptContent
} from '$lib/utils/toolPromptInjection'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import {
  computeMemoryCompileContext,
  type MemoryCompileContext
} from '$lib/server/services/memory/memoryRecall'
import {
  applyPromptRuntimeScope,
  brokerToolNamesForScope,
  runtimeFlavorToScope
} from '$lib/utils/promptRuntimeScope'
import {
  isBrokerAvailable,
  resolveBrokerFamilies,
  resolveBrokerToolToggles
} from '$lib/utils/brokerAvailability'
import {
  resolveClipDataUrlFromStoredUpload,
  resolveClipPreferredUrl
} from '$lib/server/services/clipUploadPayload'
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
import {
  applyContextCompactionToMessages,
  getContextCompactionState
} from '$lib/utils/contextCompaction'
import { applyFixedSessionGraduationToMessages } from '$lib/utils/fixedSessionGraduation'
import { buildControlErrorDcmLines } from '$lib/utils/controlTags'
import { summarizeControlInputSchema } from '$lib/services/controlSchemaSummary'
import {
  appendManagedSubagentDynamicInfo,
  buildManagedSubagentDynamicInfo
} from '$lib/server/services/subagentRuntimeScope'
import { buildCliSubagentMcpToolReference } from '$lib/utils/cliSubagentToolNames'
import { buildSubagentRuntimePrompt } from '$lib/utils/subagentRuntimePrompt'
import { buildSkillSessionContextLines } from '$lib/server/services/skillSessionContext'
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

export type PrecompiledHistory = {
  formattedMessages: string[]
  currentDay: string | null
  chatHistory: string
  globalZipSettings?: Record<string, any>
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
  isN8n: boolean
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

type SpeakerMap = {
  userLabel: string
  assistantLabelsById: Record<string, string>
  fallbackAssistantLabel: string
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
      const error = await response.text()
      throw new Error(`API error: ${error}`)
    }

    return response.json()
  }

  private async getRedisStringValue(key: string): Promise<string> {
    try {
      // Prefer direct Redis on the server to avoid auth/rate limits
      const redisClient = await this.getRedisClient()
      if (redisClient) {
        const value = await redisClient.get(key)
        return value ?? ''
      }
      const response = await this.apiCall(`/redis/get/${key}`)
      return response?.value || ''
    } catch (error) {
      console.error(`[databaseRedis] Failed to load Redis key ${key}`, error)
      return ''
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

  async touchSession(sessionId: string) {
    return sessionApiClient.touchSession(sessionId)
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

  async deleteFolder(folderId: string, options: { deleteSessions?: boolean } = {}) {
    return userStore.deleteFolder(folderId, options)
  }

  private async loadSystemPrompts(
    agent: AgentRow,
    userId?: string,
    promptOptions?: {
      runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
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

    const runtimeFlavor = promptOptions?.runtimeFlavor ?? 'vercel'

    const primaryPromptKey =
      primaryAgentType === 'api' && (runtimeFlavor === 'codex' || runtimeFlavor === 'claude')
        ? getPrimaryAgentSystemPromptRedisKey('cli')
        : getPrimaryAgentSystemPromptRedisKey(primaryAgentType)

    primarySystemPrompt = await this.getRedisStringValue(primaryPromptKey)

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

  private formatRoleLabel(role: string) {
    if (!role) return 'User'
    return role.charAt(0).toUpperCase() + role.slice(1)
  }

  private buildSpeakerMap(
    messages: Message[],
    groupContext?: GroupChatDcmContext
  ): SpeakerMap {
    const userLabel = 'U'
    const assistantLabelsById: Record<string, string> = {}
    const agentOrder = Array.isArray(groupContext?.agentOrder)
      ? groupContext?.agentOrder?.filter(Boolean)
      : []

    if (agentOrder && agentOrder.length > 0) {
      agentOrder.forEach((id, index) => {
        assistantLabelsById[id] = `A${index + 1}`
      })
      return {
        userLabel,
        assistantLabelsById,
        fallbackAssistantLabel: 'A1'
      }
    }

    const seenAgentIds: string[] = []
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const agentId =
        (message as any)?.agent_id ||
        (message as any)?.agentId ||
        (message as any)?.metadata?.agentId
      if (typeof agentId === 'string' && agentId.trim() && !seenAgentIds.includes(agentId)) {
        seenAgentIds.push(agentId)
      }
    }

    if (seenAgentIds.length <= 1) {
      if (seenAgentIds[0]) {
        assistantLabelsById[seenAgentIds[0]] = 'A'
      }
      return {
        userLabel,
        assistantLabelsById,
        fallbackAssistantLabel: 'A'
      }
    }

    seenAgentIds.forEach((id, index) => {
      assistantLabelsById[id] = `A${index + 1}`
    })

    return {
      userLabel,
      assistantLabelsById,
      fallbackAssistantLabel: 'A'
    }
  }

  private resolveSpeakerLabel(message: Message, speakerMap?: SpeakerMap) {
    if (!speakerMap) {
      return this.formatRoleLabel(message.role)
    }

    if (message.role === 'user') {
      return speakerMap.userLabel
    }

    if (message.role === 'assistant') {
      const agentId =
        (message as any)?.agent_id ||
        (message as any)?.agentId ||
        (message as any)?.metadata?.agentId
      if (typeof agentId === 'string' && speakerMap.assistantLabelsById[agentId]) {
        return speakerMap.assistantLabelsById[agentId]
      }
      return speakerMap.fallbackAssistantLabel
    }

    return this.formatRoleLabel(message.role)
  }

  private decorateCompiledMessage(
    compiled: string,
    message: Message,
    timestamp: Date | undefined,
    lastMessageDay: string | null,
    messageIndex: number,
    totalMessages: number,
    speakerMap?: SpeakerMap
  ) {
    if (!timestamp) {
      const role = this.resolveSpeakerLabel(message, speakerMap)
      return { formatted: `${role}: ${compiled}`, currentDay: lastMessageDay }
    }

    const messageDay = timestamp.toLocaleDateString('en-US')
    const includeDate = messageIndex === 0 || messageDay !== lastMessageDay
    const timestampLabel = this.formatTimestamp(timestamp, includeDate)
    const role = this.resolveSpeakerLabel(message, speakerMap)
    const formatted = includeDate
      ? `**${timestampLabel}**\n${role}: ${compiled}`
      : `${role}: ${compiled}`

    return {
      formatted,
      currentDay: includeDate ? messageDay : lastMessageDay
    }
  }

  private fallbackFormattedMessage(message: Message, speakerMap?: SpeakerMap) {
    const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : ''
    const role = this.resolveSpeakerLabel(message, speakerMap)
    return `${timestamp ? `**${timestamp}**\n` : ''}${role}: ${message.content || '[No content]'}`
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

  private async getClipData(
    userId: string | undefined,
    clipId: string,
    fetcher?: typeof fetch
  ) {
    try {
      const redisClient = await this.getRedisClient()
      const userKey = userId ? `clip:${userId}:${clipId}` : null
      const systemKey = `clip:system:${clipId}`

      if (redisClient) {
        if (userKey) {
          const userClip = await redisClient.get(userKey)
          if (userClip) {
            const enriched = await this.ensureTextContent(userClip as any, userKey, redisClient)
            return enriched
          }
        }

        const systemClip = await redisClient.get(systemKey)
        if (systemClip) {
          const enriched = await this.ensureTextContent(systemClip as any, systemKey, redisClient)
          return { ...(enriched as any), systemClip: true }
        }
      }

      // Fallback to API (browser/client)
      return await this.apiCall(`/clips/${clipId}`, { fetcher })
    } catch (error) {
      console.error('[databaseRedis] Failed to load clip:', error)
      return null
    }
  }

  /**
   * For text-like clips created before text-first storage, decode base64 once
   * and persist a `content` field to Redis to avoid repeated decoding.
   */
  private async ensureTextContent(clip: any, redisKey?: string, redisClient?: any) {
    const isText = (clip?.mimeType?.startsWith('text/') || clip?.fileType === 'text' || clip?.mimeType === 'application/json')
    if (!isText) return clip

    if (!clip?.content && clip?.localBase64) {
      const base64Part = clip.localBase64.startsWith('data:')
        ? clip.localBase64.split(',')[1] || ''
        : clip.localBase64
      const decoded = this.decodeBase64ToText(base64Part)
      const updatedTokens = clip.localTokens ?? (decoded ? Math.ceil(decoded.length / 4) : undefined)
      const updated = { ...clip, content: decoded, localTokens: updatedTokens }
      if (redisKey && redisClient) {
        try {
          await redisClient.set(redisKey, updated)
        } catch (err) {
          console.warn('[databaseRedis] Failed to persist decoded clip content', redisKey, err)
        }
      }
      return updated
    }

    return clip
  }

  private resolveZipControlPermission(
    agent: any,
    globalZipSettings?: Record<string, any>
  ): boolean {
    const agentPermission =
      typeof agent?.zip_agent_control_enabled === 'boolean'
        ? agent.zip_agent_control_enabled
        : agent?.zip_control_mode === 'agent'
          ? true
          : agent?.zip_control_mode === 'user'
            ? false
            : undefined
    if (typeof agentPermission === 'boolean') return agentPermission

    const globalPermission =
      typeof globalZipSettings?.zip_agent_control_enabled === 'boolean'
        ? globalZipSettings.zip_agent_control_enabled
        : globalZipSettings?.zip_control_mode === 'agent'
          ? true
          : globalZipSettings?.zip_control_mode === 'user'
            ? false
            : undefined

    return globalPermission ?? false
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
    runtimeFlavor: 'codex' | 'claude' | 'vercel' | 'n8n'
  }): Promise<string> {
    const promptKey = options.hasPermission
      ? 'batshit:tool_guidance_zip_enabled_prompt'
      : 'batshit:tool_guidance_zip_disabled_prompt'
    const storedPrompt = await this.getRedisStringValue(promptKey)
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
      isN8n: isN8nPrimaryAgentType(primaryAgentType),
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

    if (state.isN8n) {
      const policyHint =
        state.mode === 'plan'
          ? 'Plan-mode bash policy enforced'
          : state.mode === 'dangerous'
            ? 'Dangerous mode skips agent allow-list prompts; hard-deny rules remain enforced'
            : 'Agent-mode allow-list policy enforced'
      return `native_bash: enabled | mode=non_interactive | access_mode=${state.mode} | backend=${state.backend} | ${policyHint} | allow_list_rules=${state.automationAllowListCount} (+defaults) | deny_list_rules=${state.automationDenyListCount} | hard_deny_rules=enforced`
    }

    if (state.mode === 'plan') {
      return `native_bash: enabled | mode=plan | backend=${state.backend} | read/search + .md edits only | command chaining blocked | prefer apply_patch when available; otherwise use safe native edit commands`
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

  private buildNativeAutomationPackDcmLines(agent: any): string[] {
    const agentType =
      typeof agent?.agentType === 'string'
        ? agent.agentType.trim().toLowerCase()
        : typeof agent?.agent_type === 'string'
          ? agent.agent_type.trim().toLowerCase()
          : ''
    if (agentType !== 'n8n') return []

    const providerSettings = this.getAgentProviderSettings(agent)
    const nested =
      providerSettings?.nativeTools && typeof providerSettings.nativeTools === 'object'
        ? providerSettings.nativeTools
        : providerSettings?.batshitNativeTools && typeof providerSettings.batshitNativeTools === 'object'
          ? providerSettings.batshitNativeTools
          : {}

    // SA-096: broker toggles and families come from the shared rules so this DCM block, the
    // broker-guidance gate, and n8n's registered actions cannot disagree.
    const brokerToggles = resolveBrokerToolToggles(providerSettings)
    const { fetchZipEnabled, batshitToolsEnabled } = brokerToggles
    const webSearchEnabled =
      this.parseBooleanSetting(
        nested.webSearchEnabled ??
          nested.nativeWebSearchEnabled ??
          providerSettings.webSearchEnabled ??
          providerSettings.nativeWebSearchEnabled
      ) ?? true
    const bashEnabled =
      this.parseBooleanSetting(
        nested.bashEnabled ??
          nested.nativeBashEnabled ??
          providerSettings.bashEnabled ??
          providerSettings.nativeBashEnabled
      ) ?? true

    const enabledActions: string[] = []
    const brokerFamilies: string[] = resolveBrokerFamilies({
      runtime: 'n8n',
      toggles: brokerToggles
    })
    if (bashEnabled) enabledActions.push('bash_execute')
    enabledActions.push('native_skill')
    if (brokerFamilies.length > 0) enabledActions.push('batshit_tool_search', 'batshit_tool_use')
    if (batshitToolsEnabled) {
      enabledActions.push(
        'runtime_addon_list',
        'runtime_addon_status',
        'runtime_addon_prepare',
        'runtime_addon_start',
        'runtime_addon_stop'
      )
    }
    if (webSearchEnabled) enabledActions.push('web_search')

    const actionHints: string[] = []
    if (webSearchEnabled) {
      actionHints.push('web_search input: required query:string; optional maxResults:number')
    }
    if (fetchZipEnabled) {
      actionHints.push('fabric:sys.zip.fetch input: required zipId:string; optional includeContent:boolean, maxChars:number')
    }
    if (brokerFamilies.length > 0) {
      actionHints.push('batshit_tool_search input: optional family/query/limit/schemaMode; batshit_tool_use input: exact ref + input object')
    }

    return [
      'native_tools_pack: required node="Batshit Tools" | request shape=action + input + context',
      `native_tools_actions_enabled: ${
        enabledActions.length > 0 ? enabledActions.join(', ') : '(none)'
      }`,
      `native_tools_broker_families: ${brokerFamilies.length > 0 ? brokerFamilies.join(', ') : '(none)'}`,
      `native_tools_action_hints: ${actionHints.length > 0 ? actionHints.join(' | ') : '(none)'}`,
      'native_tools_broker_usage: call batshit_tool_search with optional family, then batshit_tool_use with the exact returned ref; refs look like mcp:..., cli:..., artifact:..., fabric:..., agent_browser:...',
      fetchZipEnabled
        ? 'native_tools_fetch_zip: use batshit_tool_use ref="fabric:sys.zip.fetch" from n8n primary calls; blocked for subagent calls'
        : ''
    ].filter((line) => line.length > 0)
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
    if (
      !isN8nPrimaryAgentType(primaryAgentType) &&
      !isManagedPrimaryAgentType(primaryAgentType)
    ) {
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
    if (
      !isN8nPrimaryAgentType(primaryAgentType) &&
      !isManagedPrimaryAgentType(primaryAgentType)
    ) {
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
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (isN8nPrimaryAgentType(primaryAgentType)) return true
    return this.isBatshitPrimaryAgent(agent)
  }

  private resolveCliToolsEnabled(agent: any): boolean {
    const nativeToggle = this.resolveNativeCliToolsEnabled(agent)
    if (typeof nativeToggle === 'boolean') return nativeToggle
    const primaryAgentType = normalizePrimaryAgentType(agent)
    if (isN8nPrimaryAgentType(primaryAgentType)) return true
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
   * overridden per chat and the n8n twin is client-side, so neither twin can read it
   * reliably. Unresolved counts as reachable, which keeps this gate from ever being
   * narrower than registration — withholding guidance from an agent that has the tools is
   * the failure this packet exists to prevent.
   */
  private hasBrokerAccess(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel' | 'n8n'
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
    runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
  }): boolean {
    const runtimeFlavor = context.runtimeFlavor ?? 'vercel'
    if (runtimeFlavor === 'codex' || runtimeFlavor === 'claude') return true
    if (runtimeFlavor === 'vercel') return true

    const selections = this.getMcpToolSelections(context.agent)
    if (selections.length > 0) return true

    if (Array.isArray(context.assignedSubagents) && context.assignedSubagents.length > 0) {
      return true
    }

    return false
  }

  /**
   * SA-104 P3: the Memory guidance block for memory-enabled agents. Mirrored in the
   * client twin (`databaseRedis.client.ts`) — keep both call sites and gating identical.
   */
  private async resolveMemoryGuidancePrompt(
    agent: any,
    runtimeFlavor: 'codex' | 'claude' | 'vercel' | 'n8n'
  ) {
    const storedPrompt = await this.getRedisStringValue('batshit:tool_guidance_memory_prompt')
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
    runtimeFlavor: 'codex' | 'claude' | 'vercel' | 'n8n'
  ) {
    const storedPrompt = await this.getRedisStringValue('batshit:dynamic_mcp_prompt')
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

  private shouldInjectToolGuidance(context: {
    agent: any
    assignedSubagents?: any[]
    runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
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
      runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
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

  private buildZipAppend(entries: ZipExposure[]): string {
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
    }

    if (!indexLines.length) return ''

    return [
      '==== UNZIP INDEX (chronological) ====',
      indexLines.join('\n'),
      '',
      '==== UNZIPPED ZIP CONTENT (chronological) ====',
      contentBlocks.join('\n\n')
    ].join('\n')
  }

  private async compileChatHistory(
    messages: Message[],
    agent: any,
    globalZipSettings?: Record<string, any>,
    options?: {
      fetch?: typeof fetch
      groupToolSharing?: {
        currentAgentId?: string | null
        sharedTools?: string[]
      }
    },
    speakerMap?: SpeakerMap
  ) {
    const formattedMessages: string[] = []
    let currentDay: string | null = null
    const totalMessages = messages.length
    const zipViewMode = this.resolveZipAiViewMode(agent, globalZipSettings)
    const zipToolNotesEnabled = this.resolveZipToolNotesEnabled(agent, globalZipSettings)
    const agentMessagesFromEndByIndex = calculateAgentMessagesFromEndByIndex(messages)
    const recoveryHoldByIndex = calculateRecoveryHoldByIndex(messages)
    const zipExposures: ZipExposure[] = []
    const zipCompilationCache = new Map<string, Promise<any | null>>()
    const resolveZipForCompilation = (zipId: string) => {
      if (!zipCompilationCache.has(zipId)) {
        zipCompilationCache.set(zipId, redis.getZip(zipId))
      }
      return zipCompilationCache.get(zipId)!
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]

      if (
        message.role === 'assistant' &&
        !message.content?.trim() &&
        (!message.toolResults || message.toolResults.length === 0)
      ) {
        continue
      }

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
              zipResolver: resolveZipForCompilation,
              zipViewMode,
              onZipExposure:
                zipViewMode === 'appended'
                  ? (exposure) => zipExposures.push(exposure)
                  : undefined
            }
          )

          const toolSummaryBlock = this.formatToolResultsSummaryForContext(
            message,
            zipToolNotesEnabled
          )
          if (toolSummaryBlock) {
            compiled = `${compiled}\n\n${toolSummaryBlock}`.trim()
          }
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
          totalMessages,
          speakerMap
        )

        formattedMessages.push(formatted)
        currentDay = nextDay
      } catch (error) {
        formattedMessages.push(this.fallbackFormattedMessage(message, speakerMap))
      }
    }

    const baseHistory = formattedMessages.join('\n\n---\n\n').trim()
    const zipAppend =
      zipViewMode === 'appended' ? this.buildZipAppend(zipExposures) : ''
    const chatHistory = zipAppend
      ? baseHistory
        ? `${baseHistory}\n\n${zipAppend}`
        : zipAppend
      : baseHistory

    return { formattedMessages, currentDay, chatHistory }
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

    const { globalZipSettings: loadedGlobalZipSettings } = await this.loadSystemPrompts(
      agent,
      userId
    )
    const globalZipSettings =
      options?.globalZipSettingsOverride ?? loadedGlobalZipSettings
    const agentForHistory =
      options?.zipSettingsAgentOverride !== undefined
        ? options.zipSettingsAgentOverride
        : agent

    const { zippingService } = await import('$lib/services/zipping')
    const [serverUnzipped, serverRezipped] = await Promise.all([
      this.loadUnzippedFromRedis(sessionId),
      this.loadRezippedFromRedis(sessionId)
    ])

    if (serverUnzipped.length > 0 || serverRezipped.length > 0) {
      zippingService.hydrate(sessionId, serverUnzipped, serverRezipped)
    } else {
      await zippingService.ensureSessionLoaded(sessionId, fetchImpl)
    }

    const speakerMap = this.buildSpeakerMap(messages, options?.groupContext)

    const { formattedMessages, currentDay, chatHistory } = await this.compileChatHistory(
      messages,
      agentForHistory,
      globalZipSettings,
      options,
      speakerMap
    )

    return {
      formattedMessages,
      currentDay,
      chatHistory: chatHistory ?? formattedMessages.join('\n\n---\n\n').trim(),
      globalZipSettings
    }
  }

  private formatCurrentUserMessage(
    currentUserMessage: string,
    lastMessageDay: string | null,
    hasHistory: boolean,
    speakerMap?: SpeakerMap
  ) {
    const now = new Date()
    const nowDay = now.toLocaleDateString('en-US')
    const includeDate = !hasHistory || nowDay !== lastMessageDay
    const timestamp = this.formatTimestamp(now, includeDate)
    const label = speakerMap?.userLabel ?? 'User'
    return `**${timestamp}**\n${label}: ${currentUserMessage}`
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

  private buildZipStateSnapshot(messages: Message[], unzipped: UnzippedItem[]) {
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
      unzipped
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
    userId?: string | null
    agentId?: string | null
    projectPath?: string | null
    nativeDynamicMcpEnabled?: boolean | null
    nativeCliToolsEnabled?: boolean | null
    isCodexMode?: boolean
  }): Promise<string> {
    const userId = options.userId?.trim()
    const agentId = options.agentId?.trim()
    if (!userId || !agentId) return ''

    try {
      const result = await buildDynamicMcpIndex({
        userId,
        agentId,
        projectPath: options.projectPath ?? null,
        nativeDynamicMcpEnabled: options.nativeDynamicMcpEnabled,
        cliToolsEnabled:
          typeof options.nativeCliToolsEnabled === 'boolean'
            ? options.nativeCliToolsEnabled
            : undefined,
        isCodexMode: options.isCodexMode === true
      })
      return typeof result.text === 'string' ? result.text : ''
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to build MCP DCM index:', error)
      return ''
    }
  }

  private async buildSkillsCommandsDcm(options: {
    userId?: string | null
    agentId?: string | null
  }): Promise<string[]> {
    const userId = options.userId?.trim()
    const agentId = options.agentId?.trim()
    if (!userId || !agentId) return []

    try {
      const capabilities = await getEnabledAgentSlashCapabilities(userId, agentId)
      return buildSkillsCommandsDcmLines(capabilities)
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to load skills/commands DCM index:', error)
      return []
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
    userId?: string | null
    currentUserMessage?: string | null
    agentRecord?: any
    agentId?: string | null
    projectPath?: string | null
    agentDefaultProjectPath?: string | null
    projectRules?: Record<string, any> | null
    fileReferences?: FileReferencePayload[]
    subagentDescriptions?: Record<string, string>
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
    }
    autoZipContent?: string[]
    autoZipTools?: string[]
    zipControlPermission?: boolean
    zipAiViewMode?: 'inline' | 'appended'
    isCodexMode?: boolean
    controlErrorLines?: string[]
    /** SA-104 P4: preformatted "Memory context:" lines from the recall engine. */
    memoryDcmLines?: string[]
  }) {
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

      const speakerParts = [
        `U=${userName}`,
        ...agentOrder.map((id, index) => `A${index + 1}=${agentNames[id] ?? id}`)
      ]
      lines.push(`Speakers: ${speakerParts.join(', ')}`)

      const presets = agentOrder.map((id, index) => {
        const settings = groupContext.speakPolicies?.[id]
        const policy = settings?.speak_policy ?? 'balanced'
        const topics = Array.isArray(settings?.speak_topics) ? settings?.speak_topics : []
        const topicSuffix =
          policy === 'topic_only'
            ? `(${topics.length > 0 ? topics.join(', ') : 'no topics'})`
            : ''
        return `A${index + 1}=${policy}${topicSuffix}`
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
        lines.push(cleanedDescription ? `- ${label}: ${cleanedDescription}` : `- ${label}`)
      }
    } else {
      lines.push('- (none)')
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
    const nativeAutomationPackLines = this.buildNativeAutomationPackDcmLines(options.agentRecord)
    if (nativeAutomationPackLines.length > 0) {
      lines.push(
        ...nativeAutomationPackLines.map((entry, index) =>
          index === 0 ? `${statusIcons.current} ${entry}` : `  ${entry}`
        )
      )
    }

    const skillsCommandsLines = await this.buildSkillsCommandsDcm({
      userId: options.userId,
      agentId: options.agentId
    })
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

    // SA-104 P4: the recall engine's memory-insert section (time awareness, Current /
    // Lingering grouping, more-available honesty) — preformatted server-side so both
    // twins render byte-identical lines (DL-104-17).
    if (options.memoryDcmLines && options.memoryDcmLines.length > 0) {
      lines.push('', ...options.memoryDcmLines)
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
          const sourceLabel = item?.source === 'user' ? 'user-locked' : 'agent'
          const permanence = item?.permanent
            ? 'permanent'
            : `temp ${item?.messageCount ?? 0}/${item?.duration ?? '?'}`
          const nameLabel = item?.name || item?.description || 'zip'
          lines.push(`- ${nameLabel} | ${item.zipId} | ${sourceLabel} | ${permanence}`)
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

    if (options.agentRecord) {
      const mcpDcm = await this.buildDynamicMcpDcm({
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

      if (mcpDcm) {
        lines.push('', ...mcpDcm.split('\n'))
      }
    }

    if (!lines.length) return ''
    return `==== DYNAMIC INFO (ephemeral - not stored) ====\n\n${lines.join('\n')}`
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
      fetch?: typeof fetch
      runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
      projectPath?: string | null
      projectRules?: Record<string, any> | null
      fileReferences?: FileReferencePayload[]
      precompiledHistory?: PrecompiledHistory
      groupContext?: GroupChatDcmContext
      voiceState?: VoiceState
      goonsSettings?: GoonsSettings | null
      goonsEnabled?: boolean
      goonPresentationMode?: DesktopGoonPresentationMode | null
    }
  ): Promise<{
    structuredInput: any
    primarySystemPrompt?: string
    subagentPrompts?: Record<string, string>
    subagentDescription?: Record<string, string>
    resolvedProjectPath?: string | null
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
        historyMessageIds: messages.map((message) => message?.id).filter(Boolean) as string[]
      })
    }

    // CRITICAL: Ensure unzip state is loaded BEFORE compiling history so compileForAI
    // can expand user-unzipped zips for the server-side API/CLI compilation path.
    const { zippingService } = await import('$lib/services/zipping')

    const [serverUnzipped, serverRezipped] = await Promise.all([
      this.loadUnzippedFromRedis(sessionId),
      this.loadRezippedFromRedis(sessionId)
    ])

    zippingService.hydrate(sessionId, serverUnzipped, serverRezipped)

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
    const speakerMap = this.buildSpeakerMap(contextMessages, options?.groupContext)

    const { formattedMessages, currentDay, chatHistory } = precompiledHistory
      ? {
          formattedMessages: precompiledHistory.formattedMessages,
          currentDay: precompiledHistory.currentDay,
          chatHistory: precompiledHistory.chatHistory
        }
      : await this.compileChatHistory(
          contextMessages,
          agent,
          globalZipSettings,
          options,
          speakerMap
        )

    const resolvedChatHistory =
      chatHistory ?? formattedMessages.join('\n\n---\n\n').trim()

    // 4. Format current user message if provided
    const currentMessageFormatted = currentUserMessage
      ? this.formatCurrentUserMessage(
          currentUserMessage,
          currentDay,
          formattedMessages.length > 0,
          speakerMap
        )
      : ''

    // 5. Count unzipped pins without fetching their bodies (G-0029): only the count
    // reaches the compiled output — the bodies are resolved independently inside
    // compileForAI — and unzipped zips are by definition the large expanded ones.
    const unzippedItemsCount = zippingService.getAllUnzipped().length
    
    // 6. Get clipped items from SESSION STATE (NEW approach - no more embedding in messages!)
    const clippedContent = []
    const clipsFromMessage: string[] = []
    const trustedClipIds = new Set<string>()
    
    // NEW: Check session state for clips instead of parsing from message
    // This eliminates the need to embed clips in every message, saving 43 tokens per message!
    if (sessionId) {
      const sessionState = await this.getSessionClipState(sessionId, fetchImpl)
      if (sessionState?.clips && sessionState.clips.length > 0) {
        for (const clipState of sessionState.clips) {
          if (clipState?.clipId && !clipsFromMessage.includes(clipState.clipId)) {
            clipsFromMessage.push(clipState.clipId)
            trustedClipIds.add(clipState.clipId)
          }
        }
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

    // SA-104 P4: clip media carried by inserted memories rides the same structured
    // image path as session clips (DL-104-17 single channel; Maggie's photo). A memory
    // clip that no longer resolves degrades to a loud DCM note instead of failing the
    // send — a deleted clip is stale memory media, not broken infrastructure.
    const memoryClipNotes: string[] = []
    if (memoryCompileContext?.memoryClipIds?.length) {
      const presentClipIds = new Set(dedupedClippedContent.map((item) => item?.clipId))
      const clipUserSettings = userId ? await this.getUserSettings(userId).catch(() => null) : null
      for (const memoryClipId of memoryCompileContext.memoryClipIds) {
        if (presentClipIds.has(memoryClipId)) continue
        const sourceMemoryId = memoryCompileContext.memoryClipSources[memoryClipId] ?? 'unknown'
        try {
          const clip = await this.getClipData(userId, memoryClipId, fetchImpl)
          if (!clip) {
            throw new Error('clip record not found')
          }
          const isText =
            clip.mimeType?.startsWith('text/') ||
            clip.fileType === 'text' ||
            clip.mimeType === 'application/json'
          const isImage = clip.mimeType?.startsWith('image/')
          const tokenEstimate = isImage
            ? clip.externalTokens ?? 765
            : clip.localTokens ??
              clip.externalTokens ??
              (clip.content ? Math.ceil(clip.content.length / 4) : undefined)
          const preferredUrl = await resolveClipPreferredUrl(clip as ClipRow, clipUserSettings, {
            allowAutoStart: true
          })
          if (isImage) {
            const dataUrl = await resolveClipDataUrlFromStoredUpload(clip as ClipRow)
            if (!dataUrl) {
              throw new Error('image payload could not be resolved from local upload storage')
            }
            dedupedClippedContent.push({
              clipId: clip.id,
              content: dataUrl,
              contentType: 'image',
              description: clip.filename,
              tokens: tokenEstimate,
              storageMode: 'local',
              url: preferredUrl,
              filename: clip.filename,
              fileSize: clip.fileSize,
              mimeType: clip.mimeType,
              memorySource: sourceMemoryId
            } as (typeof dedupedClippedContent)[number])
          } else if (isText) {
            const decoded =
              clip.content ??
              (clip.localBase64
                ? this.decodeBase64ToText(
                    clip.localBase64.startsWith('data:')
                      ? clip.localBase64.split(',')[1] || ''
                      : clip.localBase64
                  )
                : '')
            dedupedClippedContent.push({
              clipId: clip.id,
              content: decoded,
              contentType: 'text',
              description: clip.filename,
              tokens: tokenEstimate,
              storageMode: 'local',
              url: preferredUrl,
              filename: clip.filename,
              fileSize: clip.fileSize,
              mimeType: clip.mimeType,
              memorySource: sourceMemoryId
            } as (typeof dedupedClippedContent)[number])
          } else if (preferredUrl) {
            dedupedClippedContent.push({
              clipId: clip.id,
              content: preferredUrl,
              contentType: clip.fileType || 'file',
              description: clip.filename,
              tokens: tokenEstimate,
              storageMode: 'local',
              url: preferredUrl,
              filename: clip.filename,
              fileSize: clip.fileSize,
              mimeType: clip.mimeType,
              memorySource: sourceMemoryId
            } as (typeof dedupedClippedContent)[number])
          }
          presentClipIds.add(memoryClipId)
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unavailable'
          memoryClipNotes.push(
            `- Media unavailable: clip ${memoryClipId} (from memory ${sourceMemoryId}) could not be loaded (${reason}).`
          )
        }
      }
    }
    const memoryDcmLines = (() => {
      const base = memoryCompileContext?.dcmLines ?? []
      if (memoryClipNotes.length === 0) return base
      return base.length > 0
        ? [...base, ...memoryClipNotes]
        : ['Memory context:', ...memoryClipNotes]
    })()

    // 6. Create clean structured input for Chat Model
    // This will be passed directly to the AI without any parsing needed
    
    // Build the messages array exactly as the Chat Model expects
    const chatMessages: any[] = []
    
    // System prompts are delivered separately via n8n expressions
    // Do NOT add system prompts to the messages array
    
    // Merge all system prompts into one message (for Anthropic compatibility)
    let mergedSystemPrompt = ''
    
    
    // Add primary Batshit system prompt (with variable replacement)
    if (primarySystemPrompt) {
      const processedPrimary = replacePromptVariables(primarySystemPrompt, agent, agent?.settings)
      const promptLabel = getPrimaryAgentSystemPromptLabel(
        normalizePrimaryAgentType(agent)
      )
      mergedSystemPrompt += `==== ${promptLabel} ====\n\n${processedPrimary}`
    }

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

    // SA-104 P3: memory guidance is gated on per-agent memory enablement alone — the
    // inline <batshit-memory> save works without any broker family. Part of the stable
    // compiled prefix (DL-104-04): it changes only when enablement or the stored prompt
    // changes. Mirrored in the client twin.
    if (resolveAgentMemoryEnabled(agent)) {
      const memoryPrompt = await this.resolveMemoryGuidancePrompt(agent, runtimeFlavor)
      if (memoryPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== MEMORY (AGENT MEMORY ENABLED) ====\n\n${memoryPrompt}`
      }
    }

    // SA-104 P4: the agent-authored on-my-mind section compiles at the END of the
    // stable prefix, directly after the memory guidance (DL-104-04 / P0 §1.2 locked
    // position). Byte-stable ordering inside the recall engine keeps provider cache
    // anchoring; entry edits/expiry are bounded deliberate resets. Mirrored in the
    // client twin.
    if (memoryCompileContext?.onMyMindBlock) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      mergedSystemPrompt += memoryCompileContext.onMyMindBlock
    }

    // SA-104 P6: the open episode's whiteboard (Infinite Sessions) rides directly after
    // AWARENESS — awareness-layer working facts, byte-stable between deliberate
    // edits. Mirrored in the client twin.
    if (memoryCompileContext?.whiteboardBlock) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      mergedSystemPrompt += memoryCompileContext.whiteboardBlock
    }

    // Artifact guidance is now skill-led.
    // Build context still controls tool availability and DCM visibility,
    // but artifact prompt addons are retired and no longer injected here.

    // Compile system prompts and instructions for each subagent
    const subagentPrompts: Record<string, string> = {}
    const subagentDescription: Record<string, string> = {}
    const subagentModels: Record<string, { provider?: string | null; model?: string | null }> = {}

    if (assignedSubagents && assignedSubagents.length > 0) {

      const subAgentPrompt = await this.getRedisStringValue('batshit:sub_system_prompt')

      // SA-008 Phase 5: Simplified SA compilation
      // All SAs use the same compilation pattern - specialty-based logic removed
      // Specialty knowledge is now injected via Edit Mode into PA's SP instead

      // Compile prompt for each subagent
      for (const swf of assignedSubagents) {
        let subagentSystemPrompt = ''

        // All SAs get the same base prompt
        if (subAgentPrompt) {
          const processedSubAgent = replacePromptVariables(subAgentPrompt, swf, swf.settings)
          subagentSystemPrompt = `==== BATSHIT SUB-AGENT SYSTEM PROMPT ====\n\n${processedSubAgent}`
        }
        
        // Add global custom prompt if enabled
        if (swf.include_global_prompt && globalCustomPrompt) {
          if (subagentSystemPrompt) subagentSystemPrompt += '\n\n'
          const processedGlobal = replacePromptVariables(globalCustomPrompt, swf, swf.settings)
          subagentSystemPrompt += `==== GLOBAL CUSTOM SYSTEM PROMPT ====\n\n${processedGlobal}`
        }
        
        // Add subagent-specific custom prompt
        if (swf.system_prompt) {
          if (subagentSystemPrompt) subagentSystemPrompt += '\n\n'
          const processedCustom = replacePromptVariables(swf.system_prompt, swf, swf.settings)
          subagentSystemPrompt += `==== SUBAGENT CUSTOM SYSTEM PROMPT ====\n\n${processedCustom}`
        }

        const runtimePrompt = buildSubagentRuntimePrompt(swf)
        if (runtimePrompt.trim()) {
          if (subagentSystemPrompt) subagentSystemPrompt += '\n\n'
          subagentSystemPrompt += runtimePrompt
        }

        const subagentSkillsCommandsLines = await this.buildSkillsCommandsDcm({
          userId,
          agentId: swf.id
        })
        const hasSubagentSkillsCommands = subagentSkillsCommandsLines.some((line) =>
          line.startsWith('- /')
        )
        if (hasSubagentSkillsCommands) {
          if (subagentSystemPrompt) subagentSystemPrompt += '\n\n'
          subagentSystemPrompt +=
            `==== SKILLS & PROMPTS (AGENT ACCESS) ====\n\n${subagentSkillsCommandsLines.join('\n')}`
        }

        const subagentDynamicInfo = await buildManagedSubagentDynamicInfo({
          userId: userId ?? '',
          subagent: swf,
          sessionId,
          projectPath: options?.projectPath ?? agentDefaultProjectPath ?? null,
        })
        subagentSystemPrompt = appendManagedSubagentDynamicInfo(
          subagentSystemPrompt,
          subagentDynamicInfo,
        )

        const safeKey = resolveSubagentSlug(swf)

        if (subagentSystemPrompt) {
          subagentPrompts[safeKey] = subagentSystemPrompt
        }

        const saDescription = swf.description || `Subagent ${swf.displayName || swf.name || safeKey}`
        subagentDescription[safeKey] = saDescription
        subagentModels[safeKey] = {
          provider: swf.primary_model_provider ?? swf.settings?.primary_model_provider ?? null,
          model: swf.primary_model_name ?? swf.settings?.primary_model_name ?? null
        }
      }

    }

    // Hook for future shared inserts (voice/SST/TTS, buffer summaries, etc.)
    const sharedInsert = this.buildSharedInsert()
    if (sharedInsert) {
      mergedSystemPrompt += sharedInsert
    }

    // Store the compiled system prompt separately (not in messages anymore)
    const compiledMainSystemPrompt = mergedSystemPrompt

    // User message - build content array for vision support
    const userContent: any[] = []
    
    // Text content (previous conversation + current message)
    let textContent = ''

    const previousSnapshot = this.getPreviousDynamicSnapshot(contextMessages)
    const zipState = this.buildZipStateSnapshot(contextMessages, zippingService.getAllUnzipped())
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
    const resolvedProjectPath =
      options?.projectPath?.trim() ||
      agentDefaultProjectPath?.trim() ||
      defaultWorkspacePath?.trim() ||
      null
    const controlErrorLines = buildControlErrorDcmLines(contextMessages as any[])
    const dynamicInfo = currentMessageFormatted
        ? await this.buildDynamicInfoBlock({
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
          assignedSubagents,
          nativeDynamicMcpEnabled,
          previousSnapshot,
          goonId: agent?.goon_id ?? null,
          goonsEnabled,
          goonsSettings: options?.goonsSettings ?? null,
          goonPresentationMode: options?.goonPresentationMode ?? null,
          groupContext: options?.groupContext,
          voiceState: options?.voiceState,
          zipState,
          autoZipContent: autoZipSummary.autoZipContent,
          autoZipTools: autoZipSummary.autoZipTools,
          zipControlPermission: zipPermission,
          zipAiViewMode: zipViewMode,
          isCodexMode: options?.runtimeFlavor === 'codex' || options?.runtimeFlavor === 'claude',
          memoryDcmLines
        })
      : ''
    const currentMessageForLLM = currentMessageFormatted
      ? dynamicInfo
        ? `${currentMessageFormatted}\n\n${dynamicInfo}`
        : currentMessageFormatted
      : ''
    
    // Add previous conversation with label
    if (resolvedChatHistory) {
      textContent += `==== PREVIOUS CONVERSATION ====\n\n${resolvedChatHistory}`
    }
    
    // Add current message with label
    if (currentMessageForLLM) {
      if (textContent) textContent += '\n\n'
      textContent += `==== CURRENT USER MESSAGE ====\n\n${currentMessageForLLM}`
    }
    
    // Add text as first content item
    userContent.push({
      type: 'text',
      text: textContent
    })
    
    // Agent-managed zips append a structured Unzip block inside chatHistory.
    // User-managed zips expand inline during compileForAI.
    
    // Add clipped items (user uploads) - KEEP THIS!
    // SA-104 P4: memory-carried clips (memorySource set) render under their own
    // REMEMBERED MEDIA header — they are recalled media, not this message's uploads.
    const sessionClippedItems = dedupedClippedContent.filter(
      (item) => !(item as Record<string, any>).memorySource
    )
    const memoryClippedItems = dedupedClippedContent.filter(
      (item) => (item as Record<string, any>).memorySource
    )
    const appendClippedItems = (items: typeof dedupedClippedContent, header: string) => {
      if (items.length === 0) return
      if (userContent[0].text) {
        userContent[0].text += `\n\n==== ${header} ====`
      }
      for (const item of items) {
        // For text clips, inline the content for the AI
        if (item.contentType === 'text' && typeof item.content === 'string') {
          userContent[0].text += `\n\nCONTENT:\n${item.content}`
        }

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
    appendClippedItems(sessionClippedItems, 'CLIPPED ITEMS (USER UPLOADS)')
    appendClippedItems(memoryClippedItems, 'REMEMBERED MEDIA (MEMORY)')

    // Add user message with proper content format
    chatMessages.push({
      role: 'user',
      // If only text (no images), just send the string. Otherwise send array.
      content: userContent.length === 1 ? userContent[0].text : userContent
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
        resolvedProjectPath,
        assignedSubagents: assignedSubagentMetadata,
        subagentModels,
        // SA-104 P4: inserted-memory visibility for the Execution Viewer (rides the
        // recorded snapshot's structuredInput untouched on every lane).
        ...(memoryCompileContext?.memoryContext
          ? { memoryContext: memoryCompileContext.memoryContext }
          : {}),
        messageStructure: {
          systemMessages: chatMessages.filter(m => m.role === 'system').length,
          userMessages: chatMessages.filter(m => m.role === 'user').length,
          hasVisionContent: chatMessages.some(m => Array.isArray(m.content))
        }
      }
    }
    return {
      structuredInput,  // The actual structured data
      primarySystemPrompt: compiledMainSystemPrompt || undefined,
      subagentPrompts: subagentPrompts,
      subagentDescription: subagentDescription,
      resolvedProjectPath
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
