// Database service for Redis operations - Re-export layer
// Maintains the existing API while delegating to focused service clients.

// Import focused service clients and remaining store facades.
import { sessionApiClient } from './sessionApiClient'
import { messageApiClient } from './messageApiClient'
import { agentStore } from './agentStore'
import { userStore } from './userStore'

// Import types
import type {
  AgentRow,
  ChatMemoryRow,
  ChatSessionRow,
  ChatFolderRow,
  ClipRow,
  SessionClipRow,
  SubagentRow,
  UserSettingsRow
} from '$lib/types/database'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'
import type { DesktopGoonPresentationMode } from '$lib/goons/desktopGoonPresentation'
import type { Message } from '$lib/stores/messages.svelte'
import type { GroupChatAgentSettings } from '$lib/types/groupChat'
import { compileForAI, extractZips, type ZipExposure } from '$lib/services/messageCompiler'
import { normalizeId } from '$lib/utils/idNormalizer'
import { replacePromptVariables } from '$lib/utils/promptVariables'
import { createReference, extractAllReferences } from '$lib/services/universalResolver'
import { buildFileReferenceBlock, type FileReferencePayload } from '$lib/utils/fileMentions'
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
  applyPromptRuntimeScope,
  brokerToolNamesForScope,
  runtimeFlavorToScope
} from '$lib/utils/promptRuntimeScope'
import {
  isBrokerAvailable,
  resolveBrokerFamilies,
  resolveBrokerToolToggles
} from '$lib/utils/brokerAvailability'
import { appendSkillsCommandsUsageLines } from '$lib/utils/skillsCommandsDcm'
import { buildControlErrorDcmLines } from '$lib/utils/controlTags'
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
  getPrimaryAgentSystemPromptLabel,
  getPrimaryAgentSystemPromptRedisKey,
  isApiPrimaryAgentType,
  isCliPrimaryAgentType,
  isManagedPrimaryAgentType,
  isN8nPrimaryAgentType,
  normalizePrimaryAgentType,
  primaryAgentAllowsAgentBrowser,
  primaryAgentAllowsNativeBash
} from '$lib/utils/primaryAgentType'
import type { UnzippedItem } from '$lib/services/zipping'
import { summarizeControlInputSchema } from '$lib/services/controlSchemaSummary'
import { normalizeSubagentType } from '$lib/utils/subagentType'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { buildCliSubagentMcpToolReference } from '$lib/utils/cliSubagentToolNames'
import { buildSubagentRuntimePrompt } from '$lib/utils/subagentRuntimePrompt'
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

/**
 * SA-104 P4: response shape of POST /api/memory/compile-context (the server-side recall
 * engine's `MemoryCompileContext`). Declared locally because this browser-safe module
 * must not import from `$lib/server` — the parity harness pins both lanes byte-equal.
 */
type MemoryClientCompileContext = {
  enabled: boolean
  onMyMindBlock: string
  /** SA-104 P6: preformatted EPISODE WHITEBOARD block (Infinite Sessions), '' when absent. */
  whiteboardBlock?: string
  dcmLines: string[]
  memoryClipIds: string[]
  memoryClipSources: Record<string, string>
  memoryContext: Record<string, any> | null
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

const ZIP_COMPILATION_BATCH_SIZE = 100

// Simple in-memory cache to avoid hammering /api/users/:id/settings during SSR and hitting rate limits
const USER_SETTINGS_CACHE = new Map<string, { settings: UserSettingsRow; fetchedAt: number }>()
const USER_SETTINGS_CACHE_TTL_MS = 5_000
// Server-computed runtime fact delivered on the settings envelope (G-0027): the browser
// must never guess this install's default sandbox backend, so DCM lines read this value.
let serverNativeExecutionBackend: NativeExecutionBackend | null = null
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
  private customFetch?: typeof fetch
  constructor(fetcher?: typeof fetch) {
    this.customFetch = fetcher
    if (fetcher) {
      sessionApiClient.configureApi(fetcher, this.apiUrl)
      messageApiClient.configureApi(fetcher, this.apiUrl)
      agentStore.configureApi(fetcher, this.apiUrl)
      userStore.configureApi(fetcher, this.apiUrl)
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
      const response = await this.apiCall(`/redis/get/${key}`, { fetcher: this.customFetch })
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

  // ========== User Operations - Delegate to userStore ==========
  async getUserSettings(userId: string) {
    return userStore.getUserSettings(userId)
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
    return userStore.getProjects(userId)
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
      const envelope = await userStore.getUserSettingsEnvelope(userId)
      if (envelope.runtimeDefaults.nativeExecutionBackend) {
        serverNativeExecutionBackend = envelope.runtimeDefaults.nativeExecutionBackend
      }
      const userSettings = envelope.settings
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
      // resolve_model_url=1 asks the route to run server-side late tunnel resolution and
      // attach `modelFacingUrl`, so the n8n compile lane uses the exact same resolver as
      // the API/CLI server twin instead of persisted localhost URLs (G-0063).
      return await this.apiCall(`/clips/${clipId}?resolve_model_url=1`, {
        fetcher: fetcher || this.customFetch
      })
    } catch (error) {
      console.error('[databaseRedis] Failed to load clip:', error)
      return null
    }
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
    // The effective default backend is a server fact (env + platform). It arrives on the
    // settings envelope during loadSystemPrompts; guessing it here told n8n agents on
    // Docker/Linux installs the wrong sandbox/networking story (G-0027).
    if (!serverNativeExecutionBackend) {
      throw new Error(
        'RUNTIME_DEFAULTS_UNAVAILABLE: server runtime defaults were not loaded before DCM compilation'
      )
    }
    return serverNativeExecutionBackend
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
   * overridden per chat and this twin is client-side, so neither twin can read it reliably.
   * Unresolved counts as reachable, which keeps this gate from ever being narrower than
   * registration — withholding guidance from an agent that has the tools is the failure this
   * packet exists to prevent.
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
   * SA-104 P3: the Memory guidance block for memory-enabled agents. Mirrors the server
   * twin's `resolveMemoryGuidancePrompt` — keep both call sites and gating identical.
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

  private collectZipIdsForCompilation(messages: Message[]): string[] {
    const ids = new Map<string, string>()

    for (const message of messages) {
      if (message.role === 'user') continue
      const content = message.content || ''
      if (!content.includes('{{batshit-zip:')) continue

      const validZipIdsRaw = Array.isArray((message as any)?.metadata?.zipIds)
        ? (message as any).metadata.zipIds
        : null
      const validZipIds = validZipIdsRaw
        ? new Set(
            validZipIdsRaw
              .filter((id: unknown): id is string => typeof id === 'string')
              .map((id: string) => normalizeId(id))
          )
        : null

      for (const zip of extractZips(content)) {
        const normalized = normalizeId(zip.id)
        if (validZipIds && !validZipIds.has(normalized)) continue
        if (!ids.has(normalized)) {
          ids.set(normalized, zip.id)
        }
      }
    }

    return Array.from(ids.values())
  }

  private async loadZipCompilationCache(
    messages: Message[],
    fetcher?: typeof fetch
  ): Promise<Map<string, any>> {
    const ids = this.collectZipIdsForCompilation(messages)
    const cache = new Map<string, any>()
    if (!ids.length) return cache

    const { api } = await import('$lib/services/api')
    for (let i = 0; i < ids.length; i += ZIP_COMPILATION_BATCH_SIZE) {
      const batch = ids.slice(i, i + ZIP_COMPILATION_BATCH_SIZE)
      try {
        const batchMap = await api.getZips(batch, fetcher)
        for (const [zipId, zipData] of batchMap) {
          cache.set(normalizeId(zipId), zipData)
        }
      } catch (error) {
        console.warn('[compileChatHistory] Failed to batch-load zips for AI compilation:', {
          count: batch.length,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return cache
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
    const zipCompilationCache = await this.loadZipCompilationCache(messages, options?.fetch)
    const resolveZipForCompilation = async (zipId: string) =>
      zipCompilationCache.get(normalizeId(zipId)) ?? null

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

  private async fetchGoonRecord(options: {
    goonId?: string | null
    fetcher?: typeof fetch
  }): Promise<GoonRecord | null> {
    const goonId = options.goonId?.trim()
    if (!goonId) return null

    const cached = GOON_DCM_CACHE.get(goonId)
    if (cached && Date.now() - cached.fetchedAt < GOON_DCM_CACHE_TTL_MS) {
      return cached.goon
    }

    try {
      const goon = (await this.apiCall(`/goons/${goonId}`, {
        fetcher: options.fetcher
      })) as GoonRecord
      if (goon && typeof goon === 'object') {
        GOON_DCM_CACHE.set(goonId, { goon, fetchedAt: Date.now() })
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
    fetcher?: typeof fetch
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
      fetcher: options.fetcher
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

  private async fetchDynamicMcpDcm(options: {
    agentId?: string | null
    projectPath?: string | null
    nativeDynamicMcpEnabled?: boolean | null
    nativeCliToolsEnabled?: boolean | null
    isCodexMode?: boolean
    fetcher?: typeof fetch
  }): Promise<string> {
    const agentId = options.agentId?.trim()
    if (!agentId) return ''

    try {
      const response = await this.apiCall('/mcp/tools/dcm', {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          projectPath: options.projectPath ?? null,
          nativeDynamicMcpEnabled: options.nativeDynamicMcpEnabled,
          nativeCliToolsEnabled: options.nativeCliToolsEnabled,
          isCodexMode: options.isCodexMode === true,
          // SA-096 P4: this twin only ever compiles the n8n lane.
          runtime: 'n8n'
        }),
        fetcher: options.fetcher
      })

      if (response && typeof response.text === 'string') {
        return response.text
      }
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to load MCP DCM index:', error)
    }

    return ''
  }

  private async fetchSkillsCommandsDcm(options: {
    agentId?: string | null
    fetcher?: typeof fetch
  }): Promise<string[]> {
    const agentId = options.agentId?.trim()
    if (!agentId) return []

    try {
      const response = await this.apiCall(
        `/slash-commands/agent-capabilities?agentId=${encodeURIComponent(agentId)}`,
        { fetcher: options.fetcher }
      )

      const capabilities = Array.isArray(response?.capabilities) ? response.capabilities : []
      const lines: string[] = ['skills_commands:']

      if (capabilities.length === 0) {
        lines.push('- (none enabled for this agent)')
      } else {
        const maxEntries = 16
        const visible = capabilities.slice(0, maxEntries)
        for (const capability of visible) {
          if (!capability || typeof capability !== 'object') continue
          const invocation = String((capability as any).invocation ?? '').trim()
          const type = (capability as any).type === 'skill' ? 'skill' : 'prompt'
          const skillId = String((capability as any).skillId ?? '').trim()
          const description = String((capability as any).description ?? '').trim()
          const suffix = type === 'skill' && skillId ? ` | skillId=${skillId}` : ''
          const summary = description ? ` — ${description}` : ''
          lines.push(`- ${invocation} | ${type}${suffix}${summary}`)
        }
        if (capabilities.length > maxEntries) {
          lines.push(`- ...and ${capabilities.length - maxEntries} more`)
        }
      }

      appendSkillsCommandsUsageLines(lines)
      return lines
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to load skills/commands DCM index:', error)
      return []
    }
  }

  private async fetchSkillSessionContextDcm(options: {
    currentUserMessage?: string | null
    fetcher?: typeof fetch
  }): Promise<string[]> {
    const currentUserMessage = options.currentUserMessage?.trim()
    if (!currentUserMessage) return []

    try {
      const response = await this.apiCall('/skills/session-context', {
        method: 'POST',
        body: JSON.stringify({ currentUserMessage }),
        fetcher: options.fetcher
      })

      return Array.isArray(response?.lines)
        ? response.lines.filter((line: unknown): line is string => typeof line === 'string')
        : []
    } catch (error) {
      console.warn('[buildDynamicInfoBlock] Failed to load skill session context:', error)
      return []
    }
  }

  private async buildDynamicInfoBlock(options: {
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
    /** SA-104 P4: preformatted "Memory context:" lines from the recall engine route. */
    memoryDcmLines?: string[]
    fetcher?: typeof fetch
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

    const skillsCommandsLines = await this.fetchSkillsCommandsDcm({
      agentId: options.agentId,
      fetcher: options.fetcher
    })
    if (skillsCommandsLines.length > 0) {
      lines.push('', ...skillsCommandsLines)
    }

    const skillSessionContextLines = await this.fetchSkillSessionContextDcm({
      currentUserMessage: options.currentUserMessage,
      fetcher: options.fetcher
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
      fetcher: options.fetcher,
      goonsSettings: options.goonsSettings,
      voiceState: options.voiceState,
      goonPresentationMode: options.goonPresentationMode
    })
    if (goonLines.length > 0) {
      lines.push('', ...goonLines)
    }

    if (options.agentRecord) {
      const mcpDcm = await this.fetchDynamicMcpDcm({
        agentId: options.agentId,
        projectPath:
          options.projectPath ??
          options.agentDefaultProjectPath ??
          options.defaultWorkspacePath ??
          null,
        nativeDynamicMcpEnabled: options.nativeDynamicMcpEnabled,
        nativeCliToolsEnabled: this.resolveCliToolsEnabled(options.agentRecord),
        isCodexMode: options.isCodexMode,
        fetcher: options.fetcher
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
    // Prefer caller-provided fetch (SSR) but fall back to global/window
    const fetchImpl = options?.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined)

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

    // SA-104 P4: memory compile context is computed ONCE server-side by the recall
    // engine; this twin fetches the identical preformatted strings from the
    // session-authed route (P0 §1.1: never implement ranking twice). Read-only — the
    // linger commit happens in send-routed. Group runs get no recall lanes in v1.
    // A non-OK response fails the compile loudly: memory recall for an enabled agent
    // must never silently degrade (DL-104-05).
    let memoryCompileContext: MemoryClientCompileContext | null = null
    if (!options?.groupContext && agent?.id && userId && resolveAgentMemoryEnabled(agent)) {
      if (!fetchImpl) {
        throw new Error(
          'MEMORY_COMPILE_CONTEXT_UNAVAILABLE: no fetch implementation for the memory compile-context route.'
        )
      }
      const memoryResponse = await fetchImpl('/api/memory/compile-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          agentId: agent.id,
          currentUserMessage: currentUserMessage ?? '',
          historyMessageIds: messages.map((message) => message?.id).filter(Boolean)
        })
      })
      if (!memoryResponse.ok) {
        const detail = await memoryResponse.text().catch(() => '')
        throw new Error(
          `MEMORY_COMPILE_CONTEXT_UNAVAILABLE: /api/memory/compile-context returned ${memoryResponse.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`
        )
      }
      memoryCompileContext = (await memoryResponse.json()) as MemoryClientCompileContext
    }

    // CRITICAL: Load unzip state BEFORE compiling so compileForAI expands user-unzipped zips
    const { zippingService } = await import('$lib/services/zipping')
    await zippingService.ensureSessionLoaded(sessionId, fetchImpl)

    const precompiledHistory = options?.precompiledHistory
    const speakerMap = this.buildSpeakerMap(messages, options?.groupContext)

    const { formattedMessages, currentDay, chatHistory } = precompiledHistory
      ? {
          formattedMessages: precompiledHistory.formattedMessages,
          currentDay: precompiledHistory.currentDay,
          chatHistory: precompiledHistory.chatHistory
        }
      : await this.compileChatHistory(
          messages,
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
              // Server-resolved model-facing URL (G-0063). A missing key means the route
              // skipped resolution — a wiring bug, not a "no URL" state: fail loudly.
              if (!('modelFacingUrl' in clip)) {
                throw new Error(
                  `CLIP_URL_RESOLUTION_UNAVAILABLE: clip ${clip.id} response carried no modelFacingUrl`
                )
              }
              const preferredUrl = (clip.modelFacingUrl ?? null) as string | null

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
                let dataUrl: string | null = null
                if (clip.localBase64) {
                  dataUrl = clip.localBase64.startsWith('data:')
                    ? clip.localBase64
                    : `data:${clip.mimeType || 'image/jpeg'};base64,${clip.localBase64}`
                } else {
                  const fetchUrl = clip.localUrl || clip.displayUrl
                  if (fetchImpl && fetchUrl) {
                    const imageResponse = await fetchImpl(fetchUrl)
                    if (!imageResponse.ok) {
                      throw new Error(`Clip image fetch failed: ${imageResponse.status} ${imageResponse.statusText}`)
                    }
                    const blob = await imageResponse.blob()
                    const arrayBuffer = await blob.arrayBuffer()
                    const bytes = new Uint8Array(arrayBuffer)
                    let binary = ''
                    for (const byte of bytes) binary += String.fromCharCode(byte)
                    const base64 =
                      typeof btoa === 'function'
                        ? btoa(binary)
                        : (globalThis as any)?.Buffer?.from(bytes).toString('base64')
                    if (!base64) {
                      throw new Error('No base64 encoder is available for clip image payload')
                    }
                    dataUrl = `data:${clip.mimeType || 'image/jpeg'};base64,${base64}`
                  }
                }

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
    // image path as session clips (DL-104-17 single channel). A memory clip that no
    // longer resolves degrades to a loud DCM note instead of failing the send —
    // deleted memory media is stale content, not broken infrastructure. Mirrors the
    // server twin.
    const memoryClipNotes: string[] = []
    if (memoryCompileContext?.memoryClipIds?.length) {
      const presentClipIds = new Set(dedupedClippedContent.map((item) => item?.clipId))
      for (const memoryClipId of memoryCompileContext.memoryClipIds) {
        if (presentClipIds.has(memoryClipId)) continue
        const sourceMemoryId = memoryCompileContext.memoryClipSources?.[memoryClipId] ?? 'unknown'
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
          if (!('modelFacingUrl' in clip)) {
            throw new Error(
              `CLIP_URL_RESOLUTION_UNAVAILABLE: clip ${clip.id} response carried no modelFacingUrl`
            )
          }
          const preferredUrl = (clip.modelFacingUrl ?? null) as string | null
          if (isImage) {
            let dataUrl: string | null = null
            if (clip.localBase64) {
              dataUrl = clip.localBase64.startsWith('data:')
                ? clip.localBase64
                : `data:${clip.mimeType || 'image/jpeg'};base64,${clip.localBase64}`
            } else {
              const fetchUrl = clip.localUrl || clip.displayUrl
              if (fetchImpl && fetchUrl) {
                const imageResponse = await fetchImpl(fetchUrl)
                if (!imageResponse.ok) {
                  throw new Error(
                    `Clip image fetch failed: ${imageResponse.status} ${imageResponse.statusText}`
                  )
                }
                const blob = await imageResponse.blob()
                const arrayBuffer = await blob.arrayBuffer()
                const bytes = new Uint8Array(arrayBuffer)
                let binary = ''
                for (const byte of bytes) binary += String.fromCharCode(byte)
                const base64 =
                  typeof btoa === 'function'
                    ? btoa(binary)
                    : (globalThis as any)?.Buffer?.from(bytes).toString('base64')
                if (!base64) {
                  throw new Error('No base64 encoder is available for clip image payload')
                }
                dataUrl = `data:${clip.mimeType || 'image/jpeg'};base64,${base64}`
              }
            }
            if (!dataUrl) {
              throw new Error(`Clip image payload could not be resolved: ${clip.id}`)
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
    const shouldInjectZipGuidance = this.shouldInjectZipGuidance(messages, agent, globalZipSettings, {
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
    // compiled prefix (DL-104-04). Mirrors the server twin.
    if (resolveAgentMemoryEnabled(agent)) {
      const memoryPrompt = await this.resolveMemoryGuidancePrompt(agent, runtimeFlavor)
      if (memoryPrompt.trim()) {
        if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
        mergedSystemPrompt += `==== MEMORY (AGENT MEMORY ENABLED) ====\n\n${memoryPrompt}`
      }
    }

    // SA-104 P4: the agent-authored on-my-mind section compiles at the END of the
    // stable prefix, directly after the memory guidance (DL-104-04 / P0 §1.2 locked
    // position). The block text comes preformatted from the recall engine route, so
    // both twins stay byte-identical. Mirrors the server twin.
    if (memoryCompileContext?.onMyMindBlock) {
      if (mergedSystemPrompt) mergedSystemPrompt += '\n\n'
      mergedSystemPrompt += memoryCompileContext.onMyMindBlock
    }

    // SA-104 P6: the open episode's whiteboard (Infinite Sessions) rides directly after
    // AWARENESS — preformatted by the recall engine route so both twins stay
    // byte-identical. Mirrors the server twin.
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
      // All SAs use the same base prompt - specialty logic removed
      // Specialty-specific knowledge now injected via Edit Mode (PA SP) instead

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

        const subagentSkillsCommandsLines = await this.fetchSkillsCommandsDcm({
          agentId: swf.id,
          fetcher: options?.fetch
        })
        const hasSubagentSkillsCommands = subagentSkillsCommandsLines.some((line) =>
          line.startsWith('- /')
        )
        if (hasSubagentSkillsCommands) {
          if (subagentSystemPrompt) subagentSystemPrompt += '\n\n'
          subagentSystemPrompt +=
            `==== SKILLS & PROMPTS (AGENT ACCESS) ====\n\n${subagentSkillsCommandsLines.join('\n')}`
        }

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

    const previousSnapshot = this.getPreviousDynamicSnapshot(messages)
    const zipState = this.buildZipStateSnapshot(messages, zippingService.getAllUnzipped())
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
    const controlErrorLines = buildControlErrorDcmLines(messages as any[])
    const dynamicInfo = currentMessageFormatted
      ? await this.buildDynamicInfoBlock({
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
          memoryDcmLines,
          fetcher: options?.fetch
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
