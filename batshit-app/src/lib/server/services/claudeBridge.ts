import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'
import type { NativeModeRequest } from '$lib/server/services/vercelBrain'
import { detectClaudeCliStatus, resolveClaudeCliExecutable } from '$lib/server/services/claudeCliStatus'
import { ClaudeEventAdapter } from '$lib/server/services/claudeEventAdapter'
import {
  applyClaudeContextGuard,
  resolveClaudeContextGuardThreshold,
  resolveClaudeContextWindow,
  type ClaudeContextGuardConfig
} from '$lib/server/services/claudeContextGuard'
import { buildCodexPromptFromMessages } from '$lib/server/services/codexBridge'
import { redis } from '$lib/server/redis'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import {
  syncAgentClaudeProfiles,
  getManagedClaudePaths,
  buildClaudeProfileId,
  collectManagedClaudeGatewayHeaderEnv,
  CLAUDE_APPROVAL_TOOL_NAME
} from '$lib/server/services/claudeProfileManager'
import { buildManagedGatewayId } from '$lib/server/services/codexProfileManager'
import type { MCPGateway } from '$lib/types/database'
import type { SavedModel } from '$lib/types/savedModels'
import type { ClaudePermissionMode } from '$lib/types/claude'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import {
  MODE4_INTERNAL_HELPER_TOOL_NAMES,
  resolveEnabledMode4InternalHelperTools,
  isMode4InternalHelperTool,
  buildMode4InternalHelpersGatewayId,
  buildMode4InternalHelpersGatewaySlug
} from '$lib/server/services/mode4InternalTools'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import { resolveCliToolSelectionScope } from '$lib/server/services/cliToolRegistry'
import {
  isStdioGateway,
  resolveManagedStdioEnvironmentValues
} from '$lib/server/services/mcpGatewayStdio'
import { resolveCliHelperBatshitToken } from '$lib/server/services/cliHelperToken'
import {
  buildClaudeChildEnv,
  buildClaudeChildProcessOptions,
  resolveClaudeRunAsIdentity,
  resolveClaudeRuntimeUid
} from '$lib/server/services/claudeRuntimeUser'
import {
  buildSubagentSlugCollisionError,
  normalizeSubagentSlugValue,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'

type ClaudeTransport = 'cli'

interface ClaudeRunOptions {
  model?: string | null
  workingDirectory: string
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  approvalMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'
  permissionPromptTool?: string
  disallowedTools?: string[]
  addDirectories?: string[]
  allowedTools?: string[]
  maxThinkingTokens?: number
  allowedMcpTools?: string[]
  planAllowedTools?: string[]
  allowedDirs?: string[]
  autoAllowTools?: string[]
  batshitToken?: string | null
  managedStdioEnv?: Record<string, string>
  systemPromptMode?: 'default' | 'append' | 'replace' | 'replace_file'
  systemPrompt?: string
  systemPromptFile?: string
  chromeEnabled?: boolean
  configScope?: 'managed' | 'global'
  settingsPath?: string | null
  mcpConfigPath?: string | null
  pluginDirs?: string[]
  settingSources?: string[]
  signal?: AbortSignal
  sessionId?: string | null
  messageId?: string | null
  userId?: string | null
  agentId?: string | null
  contextGuard?: ClaudeContextGuardConfig | null
}

interface ClaudeRunner {
  transport: ClaudeTransport
  events: AsyncGenerator<any>
  cleanup?: () => void | Promise<void>
}

const PROVIDER_DISABLED_ERROR =
  'Claude Code CLI provider is disabled. Set BATSHIT_CLAUDE_PROVIDER_ENABLED=true and ensure the CLI is installed.'
const CLAUDE_AUTO_ALLOW_TOOLS = ['Read', 'WebSearch', 'WebFetch']
// How long a guard-stopped child gets to exit after SIGTERM before SIGKILL.
const GUARD_KILL_GRACE_MS = 10_000
const ROOT_CLAUDE_BYPASS_PERMISSION_MESSAGE =
  'Claude Code blocks Bypass Permissions when running as root. Configure BATSHIT_CLAUDE_RUN_AS_UID/GID so Batshit can run Claude Code as a non-root child process, or choose Edit Automatically.'

type GetProcessUid = () => number | null | undefined

export function getClaudePermissionModeRuntimeBlockReason(
  permissionMode: ClaudePermissionMode,
  getUid: GetProcessUid = resolveClaudeRuntimeUid
): string | null {
  if (permissionMode !== 'bypassPermissions') return null
  return getUid() === 0 ? ROOT_CLAUDE_BYPASS_PERMISSION_MESSAGE : null
}

function resolveClaudeApprovalMode(
  permissionMode: ClaudeRunOptions['permissionMode'],
  sharedToolApprovalMode: 'off' | 'all'
): NonNullable<ClaudeRunOptions['approvalMode']> {
  if (permissionMode === 'plan') return 'plan'
  if (permissionMode === 'bypassPermissions') return 'bypassPermissions'
  if (permissionMode === 'acceptEdits') {
    return sharedToolApprovalMode === 'all' ? 'acceptEdits' : 'dontAsk'
  }
  return sharedToolApprovalMode === 'all' ? 'default' : 'dontAsk'
}

// Flags whose values carry instruction-bearing payloads (full managed system prompts).
// Mirrors redactCodexCliArgsForLog, which hides developer_instructions/skills.config values.
const CLAUDE_REDACTED_ARG_FLAGS = new Set(['--system-prompt', '--append-system-prompt'])

export function redactClaudeCliArgsForLog(args: string[]) {
  const redacted: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    redacted.push(arg)

    if (!CLAUDE_REDACTED_ARG_FLAGS.has(arg)) continue
    const next = args[index + 1]
    if (typeof next !== 'string') continue

    redacted.push('<redacted>')
    index += 1
  }

  return redacted
}

export class ClaudeBridge {
  async streamNativeMode(request: NativeModeRequest) {
    if (env.BATSHIT_CLAUDE_PROVIDER_ENABLED === 'false') {
      throw new Error(PROVIDER_DISABLED_ERROR)
    }

    if (!request.messages?.length) {
      throw new Error('No messages provided to Claude CLI runtime')
    }

    const requestStart = Date.now()
    const prompt = buildCodexPromptFromMessages({
      messages: request.messages,
      images: request.images
    })

    const input = await this.buildStreamJsonInput(prompt, request.images)

    const agentRecord = await this.loadAgentRecord(request.agentId)
    const permissions = this.resolveAgentPermissions(agentRecord)
    const claudeSettings = request.claudeSettings
      ? buildClaudeRuntimeSettings(request.claudeSettings)
      : buildClaudeRuntimeSettings(request.providerSettings ?? null)
    const resolvedModel = this.resolveCliModel(request.model, claudeSettings.model)
    const workingDirectory = await this.resolveWorkingDirectory({
      userId: request.userId,
      projectPath: request.projectPath ?? null,
      claudeSettings
    })
    const configScope = claudeSettings.configScope ?? 'managed'
    const profileId =
      claudeSettings.profileId ??
      (request.agentId ? buildClaudeProfileId(request.agentId) : null)
    const sharedToolApprovalMode = request.toolApprovalMode === 'all' ? 'all' : 'off'

    // Managed mcp.json references gateway auth headers as ${BATSHIT_MCP_HEADER_*} placeholders;
    // the real values are injected into the CLI child environment at spawn time below.
    let gatewayHeaderEnv: Record<string, string> = {}
    if (configScope === 'managed' && request.userId && profileId) {
      try {
        gatewayHeaderEnv = await syncAgentClaudeProfiles(request.userId)
      } catch (error) {
        console.warn('[ClaudeBridge] Failed to sync managed Claude profiles', error)
        try {
          gatewayHeaderEnv = await collectManagedClaudeGatewayHeaderEnv(request.userId)
        } catch (headerEnvError) {
          console.warn('[ClaudeBridge] Failed to resolve managed gateway header env after sync failure', headerEnvError)
        }
      }
    }

    const desiredPermission = claudeSettings.permissionMode ?? 'acceptEdits'
    const maxPermission =
      permissions.allowNetwork === true
        ? 'bypassPermissions'
        : permissions.allowFileEdits === true
          ? 'acceptEdits'
          : permissions.allowNetwork === false || permissions.allowFileEdits === false
            ? 'default'
            : null
    const permissionRank: Record<string, number> = {
      plan: 0,
      default: 1,
      acceptEdits: 2,
      bypassPermissions: 3
    }
    let permissionMode: ClaudeRunOptions['permissionMode'] = desiredPermission
    if (maxPermission && permissionRank[permissionMode] > permissionRank[maxPermission]) {
      permissionMode = maxPermission
    }
    const permissionBlockReason = getClaudePermissionModeRuntimeBlockReason(permissionMode)
    if (permissionBlockReason) {
      throw new Error(permissionBlockReason)
    }
    const approvalMode = resolveClaudeApprovalMode(permissionMode, sharedToolApprovalMode)
    const wantsPermissionPrompt =
      configScope === 'managed' &&
      (approvalMode === 'default' || approvalMode === 'acceptEdits')

    const disallowedTools = new Set<string>(claudeSettings.disallowedTools ?? [])
    if (permissions.allowFileEdits === false) {
      disallowedTools.add('Write')
      disallowedTools.add('Edit')
      disallowedTools.add('NotebookEdit')
    }
    if (permissions.allowNetwork === false) {
      disallowedTools.add('WebFetch')
      disallowedTools.add('WebSearch')
    }
    let settingsPath: string | null = null
    let mcpConfigPath: string | null = null
    let pluginDirs: string[] | undefined
    if (configScope === 'managed' && profileId) {
      const paths = getManagedClaudePaths(profileId)
      settingsPath = paths.settingsPath
      mcpConfigPath = paths.mcpPath
      pluginDirs = [paths.pluginsDir]
    }

    if (configScope === 'managed') {
      const mcpDisallowed = await this.resolveManagedMcpToolDenyList({
        userId: request.userId,
        gatewayToolMap: request.gatewayToolMap ?? null
      })
      for (const toolName of mcpDisallowed) {
        disallowedTools.add(toolName)
      }
    }

    const addDirectories = new Set<string>()
    if (request.projectPath) addDirectories.add(request.projectPath)
    for (const dir of claudeSettings.addDirs ?? []) {
      if (dir) addDirectories.add(dir)
    }

    const subagentMcpTools =
      configScope === 'managed'
        ? this.resolveSubagentPlanAllowTools({
            agentId: request.agentId ?? null,
            agentSlug: request.agentSlug ?? null,
            assignedSubagents: request.assignedSubagents
          })
        : []

    let allowedMcpTools: string[] = []
    if (configScope === 'managed') {
      allowedMcpTools = await this.resolveManagedMcpToolAllowList({
        userId: request.userId,
        gatewayToolMap: request.gatewayToolMap ?? null
      })
      const internalMode4Tools = await this.resolveMode4InternalControlAllowTools({
        userId: request.userId ?? null,
        agentId: request.agentId ?? null,
        agentSlug: request.agentSlug ?? null,
        providerSettings: request.providerSettings ?? null,
        selectedCliToolIds: request.selectedCliToolIds ?? null
      })
      if (internalMode4Tools.allowTools.length > 0) {
        allowedMcpTools = Array.from(new Set([...allowedMcpTools, ...internalMode4Tools.allowTools]))
      }
      if (subagentMcpTools.length > 0) {
        allowedMcpTools = Array.from(new Set([...allowedMcpTools, ...subagentMcpTools]))
      }
      for (const toolName of internalMode4Tools.disallowTools) {
        disallowedTools.add(toolName)
      }
    }
    const planAllowedTools = subagentMcpTools

    const allowedDirs = new Set<string>()
    if (workingDirectory) {
      allowedDirs.add(workingDirectory)
    }
    for (const dir of addDirectories) {
      if (!dir) continue
      const resolved = path.isAbsolute(dir) ? dir : path.resolve(workingDirectory, dir)
      allowedDirs.add(resolved)
    }

    const batshitToken = await resolveCliHelperBatshitToken(request.userId ?? null)
    const managedStdioEnv =
      configScope === 'managed' && request.userId
        ? await this.resolveManagedStdioEnv(request.userId, request.gatewayToolMap ?? null)
        : {}
    const runProjectPath =
      typeof request.projectPath === 'string' && request.projectPath.trim().length > 0
        ? request.projectPath.trim()
        : null
    if (configScope === 'managed' && runProjectPath) {
      managedStdioEnv.BATSHIT_PROJECT_PATH = runProjectPath
    }
    for (const [key, value] of Object.entries(gatewayHeaderEnv)) {
      managedStdioEnv[key] = value
    }

    const contextGuard = await this.resolveContextGuardConfig({
      agent: agentRecord,
      model: resolvedModel
    })

    const runOptions: ClaudeRunOptions = {
      model: resolvedModel,
      workingDirectory,
      permissionMode,
      disallowedTools: Array.from(disallowedTools),
      allowedTools: claudeSettings.allowedTools ?? [],
      maxThinkingTokens: claudeSettings.maxThinkingTokens,
      allowedMcpTools,
      planAllowedTools,
      allowedDirs: Array.from(allowedDirs),
      autoAllowTools: CLAUDE_AUTO_ALLOW_TOOLS,
      batshitToken,
      managedStdioEnv,
      addDirectories: Array.from(addDirectories),
      systemPromptMode: claudeSettings.systemPromptMode,
      systemPrompt: claudeSettings.systemPrompt,
      systemPromptFile: claudeSettings.systemPromptFile,
      chromeEnabled: typeof claudeSettings.chrome === 'boolean' ? claudeSettings.chrome : undefined,
      configScope,
      settingsPath,
      mcpConfigPath,
      pluginDirs,
      settingSources: configScope === 'managed' ? (claudeSettings.settingSources ?? ['project']) : undefined,
      signal: request.abortSignal,
      approvalMode,
      permissionPromptTool: wantsPermissionPrompt ? CLAUDE_APPROVAL_TOOL_NAME : undefined,
      sessionId: request.sessionId ?? null,
      messageId: request.messageId ?? null,
      userId: request.userId ?? null,
      agentId: request.agentId ?? null,
      contextGuard
    }

    const runner = await this.runViaCli(input, runOptions)

    const adapter = new ClaudeEventAdapter({
      request,
      transport: runner.transport,
      onFinish: request.onFinish
        ? async ({ text, steps, totalUsage, reasoning }) => {
            await request.onFinish?.({
              text,
              steps,
              totalUsage,
              usage: totalUsage,
              reasoning
            })
          }
        : undefined
    })

    const stream = adapter.stream(runner.events)
    let firstChunkLogged = false
    const wrappedStream = this.wrapStream(stream, {
      onAbort: request.onAbort,
      abortSignal: request.abortSignal,
      adapter,
      cleanup: async () => {
        if (runner.cleanup) await runner.cleanup()
      },
      onFirstChunk: () => {
        if (firstChunkLogged) return
        firstChunkLogged = true
        logger.debug('[ClaudeBridge] First Claude chunk ready', {
          elapsedMs: Date.now() - requestStart,
          transport: runner.transport
        })
      }
    })

    return {
      // Canonical AI SDK 7 name plus the legacy alias, mirroring the SDK's own
      // deprecated fullStream alias so no reader silently diverges.
      stream: wrappedStream,
      fullStream: wrappedStream,
      __transport: runner.transport,
      __detectToolSource: adapter.getToolMetadataResolver(),
      __rawEvents: adapter.getRawEvents(),
      __runtimeInfo: {
        runtimeId: 'claude',
        providerId: 'anthropic-claude-cli',
        connectionId: 'claude-cli',
        modelName: resolvedModel ?? null,
        transport: 'claude-cli',
        workingDirectory
      }
    }
  }

  private async loadAgentRecord(agentId?: string): Promise<Record<string, any> | null> {
    if (!agentId) return null

    try {
      return await redis.execute(async (client) => {
        return (await client.json.get(`agent:${agentId}`)) as Record<string, any> | null
      })
    } catch (error) {
      console.error('[ClaudeBridge] Failed to load agent record', error)
      return null
    }
  }

  private resolveAgentPermissions(agent: Record<string, any> | null) {
    const allowFileEditsRaw =
      agent?.ai_permissions?.allow_file_edits ?? agent?.ai_permissions?.allowFileEdits
    const allowNetworkRaw =
      agent?.ai_permissions?.allow_network_commands ?? agent?.ai_permissions?.allowNetworkCommands

    return {
      allowFileEdits: allowFileEditsRaw === undefined ? null : Boolean(allowFileEditsRaw),
      allowNetwork: allowNetworkRaw === undefined ? null : Boolean(allowNetworkRaw)
    }
  }

  private async resolveContextGuardConfig(params: {
    agent: Record<string, any> | null
    model: string | null
  }): Promise<ClaudeContextGuardConfig | null> {
    const threshold = resolveClaudeContextGuardThreshold()
    if (threshold === null) return null

    let presetContextWindow: number | null = null
    const presetId =
      typeof params.agent?.primary_model_preset_id === 'string' &&
      params.agent.primary_model_preset_id.trim().length > 0
        ? params.agent.primary_model_preset_id.trim()
        : null
    if (presetId) {
      try {
        const preset = (await redis.get(`model:${presetId}`)) as SavedModel | null
        const selection = resolveRuntimeModelSelection({
          preset: preset && typeof preset === 'object' ? preset : null
        })
        presetContextWindow = selection.contextWindow
      } catch (error) {
        console.warn('[ClaudeBridge] Failed to load model preset for context guard', error)
      }
    }

    return {
      contextWindow: resolveClaudeContextWindow({
        presetContextWindow,
        model: params.model
      }),
      threshold
    }
  }

  private sanitizeToolName(name: string) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  private normalizeToolName(name: string) {
    return this.sanitizeToolName(name.trim())
  }

  private resolveSubagentPlanAllowTools(params: {
    agentId?: string | null
    agentSlug?: string | null
    assignedSubagents?: any[] | null
  }) {
    const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : ''
    if (!agentId) return []

    const slugSource =
      typeof params.agentSlug === 'string' && params.agentSlug.trim().length > 0
        ? params.agentSlug.trim()
        : agentId
    const managedId = buildManagedGatewayId(
      `${agentId}-subagents`,
      `${slugSource}-subagents`
    )

    const candidates = Array.isArray(params.assignedSubagents) ? params.assignedSubagents : []
    if (candidates.length === 0) return []

    const usedKeys = new Map<string, string>()
    const toolNames: string[] = []

    const addSubagentTool = (key: string, label: string) => {
      const existing = usedKeys.get(key)
      if (existing) {
        throw buildSubagentSlugCollisionError(key, existing, label)
      }
      usedKeys.set(key, label)
      toolNames.push(`mcp__${managedId}__subagent_${key}`)
    }

    for (const entry of candidates) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        addSubagentTool(normalizeSubagentSlugValue(entry), entry)
        continue
      }

      if (entry && typeof entry === 'object') {
        const key = resolveSubagentSlug(entry)
        const label =
          typeof (entry as any).id === 'string' && (entry as any).id.trim()
            ? (entry as any).id.trim()
            : typeof (entry as any).displayName === 'string' && (entry as any).displayName.trim()
              ? (entry as any).displayName.trim()
              : key
        addSubagentTool(key, label)
      }
    }

    return toolNames.sort()
  }

  private async resolveMode4InternalControlAllowTools(params: {
    userId?: string | null
    agentId?: string | null
    agentSlug?: string | null
    providerSettings?: Record<string, any> | null
    selectedCliToolIds?: string[] | null
  }) {
    const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : ''
    if (!agentId) {
      return {
        allowTools: [] as string[],
        disallowTools: [] as string[]
      }
    }

    const slugSource =
      typeof params.agentSlug === 'string' && params.agentSlug.trim().length > 0
        ? params.agentSlug.trim()
        : agentId
    const managedId = buildManagedGatewayId(
      buildMode4InternalHelpersGatewayId(agentId),
      buildMode4InternalHelpersGatewaySlug(slugSource)
    )

    const nativeToolSettings = resolveNativeToolSettings(params.providerSettings ?? null)
    const cliToolScope = await resolveCliToolSelectionScope({
      userId: params.userId ?? '',
      agentId,
      selectedToolIds: params.selectedCliToolIds ?? undefined
    })
    const hasCliTools = cliToolScope.toolIds.length > 0
    const enabledHelperTools = resolveEnabledMode4InternalHelperTools(nativeToolSettings, {
      hasCliTools
    })
    const enabledSet = new Set(enabledHelperTools)
    const toManagedToolName = (toolName: string) => `mcp__${managedId}__${toolName}`

    return {
      allowTools: enabledHelperTools.map(toManagedToolName),
      disallowTools: MODE4_INTERNAL_HELPER_TOOL_NAMES
        .filter((toolName) => !enabledSet.has(toolName))
        .map(toManagedToolName)
    }
  }

  private async resolveManagedMcpToolDenyList(params: {
    userId?: string
    gatewayToolMap?: Record<string, string[]> | null
  }) {
    // Dynamic MCP-only mode: gateway tools are not exposed directly in managed mode,
    // so no broad MCP tool deny matrix is required.
    return []
  }

  private async resolveManagedMcpToolAllowList(params: {
    userId?: string
    gatewayToolMap?: Record<string, string[]> | null
  }) {
    if (!params.userId || !params.gatewayToolMap) return []

    let gateways: MCPGateway[]
    try {
      gateways = await mcpGatewayService.list(params.userId)
    } catch (error) {
      console.warn('[ClaudeBridge] Failed to load MCP gateways for tool scoping', error)
      return []
    }

    const gatewayIds = new Set(Object.keys(params.gatewayToolMap))
    if (gatewayIds.size === 0) return []

    const allowed = new Set<string>()

    for (const gateway of gateways) {
      if (!gatewayIds.has(gateway.id)) continue

      const managedId = buildManagedGatewayId(gateway.id, gateway.slug)
      const enabledTools = (params.gatewayToolMap[gateway.id] ?? [])
        .map((name) => this.normalizeToolName(name))
        .filter((name) => !isMode4InternalHelperTool(name))
        .filter((name) => name.length > 0)

      for (const toolName of enabledTools) {
        allowed.add(`mcp__${managedId}__${toolName}`)
      }
    }

    return Array.from(allowed)
  }

  private async resolveWorkingDirectory(params: {
    userId?: string
    projectPath?: string | null
    claudeSettings?: ReturnType<typeof buildClaudeRuntimeSettings> | null
  }) {
    const candidates: Array<string | null | undefined> = []
    const override =
      params.claudeSettings?.workingDirectoryMode === 'custom'
        ? params.claudeSettings?.customWorkingDirectory?.trim()
        : ''
    if (override) {
      candidates.push(override)
    }

    if (params.projectPath && params.projectPath.trim().length > 0) {
      candidates.push(params.projectPath.trim())
    }

    if (params.userId) {
      try {
        const preferences = await redis.getProjectPreferences(params.userId)
        if (preferences?.default_workspace_path?.trim()) {
          candidates.push(preferences.default_workspace_path.trim())
        }
      } catch (error) {
        console.error('[ClaudeBridge] Failed to load project preferences', error)
      }
    }

    candidates.push(os.homedir())

    for (const candidate of candidates) {
      const resolved = await this.ensureValidWorkingDirectory(candidate)
      if (resolved) return resolved
    }

    return os.homedir()
  }

  private async ensureValidWorkingDirectory(candidate?: string | null): Promise<string | null> {
    if (!candidate) return null
    const trimmed = candidate.trim()
    if (!trimmed) return null

    const resolved = path.resolve(trimmed)
    if (this.isPackagedRuntimePath(resolved)) {
      console.warn('[ClaudeBridge] Refusing to use packaged app runtime as Claude working directory', {
        candidate: resolved
      })
      return null
    }
    try {
      const stats = await fs.stat(resolved)
      if (stats.isDirectory()) return resolved
      const parent = path.dirname(resolved)
      if (this.isPackagedRuntimePath(parent)) {
        console.warn('[ClaudeBridge] Refusing to use packaged app runtime parent as Claude working directory', {
          candidate: resolved,
          parent
        })
        return null
      }
      const parentStats = await fs.stat(parent)
      if (parentStats.isDirectory()) {
        console.warn('[ClaudeBridge] Working directory is not a folder', {
          candidate: resolved,
          fallback: parent
        })
        return parent
      }
    } catch {
      console.warn('[ClaudeBridge] Working directory does not exist', { candidate: resolved })
    }

    return null
  }

  private isPackagedRuntimePath(candidate: string) {
    const normalized = path.resolve(candidate)
    return normalized.includes('.app/Contents/Resources/runtime')
  }

  private buildCliAllowedTools(
    options: Pick<ClaudeRunOptions, 'allowedTools' | 'allowedMcpTools' | 'planAllowedTools'>
  ) {
    return Array.from(
      new Set(
        [
          ...(options.allowedTools ?? []),
          ...(options.allowedMcpTools ?? []),
          ...(options.planAllowedTools ?? [])
        ]
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0)
      )
    )
  }

  private async buildStreamJsonInput(
    prompt: string,
    images?: Array<{ url: string; alt?: string }>
  ) {
    const content: Array<Record<string, any>> = [{ type: 'text', text: prompt }]
    const imageBlocks = await this.buildImageBlocks(images)
    content.push(...imageBlocks)

    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content
      }
    })
  }

  private async buildImageBlocks(images?: Array<{ url: string; alt?: string }>) {
    if (!images?.length) return []

    const blocks: Array<Record<string, any>> = []

    for (const image of images) {
      if (!image?.url) continue
      const source = await this.buildImageSource(image.url)
      if (!source) continue

      if (image.alt && image.alt.trim().length > 0) {
        blocks.push({ type: 'text', text: `Image: ${image.alt.trim()}` })
      }

      blocks.push({ type: 'image', source })
    }

    return blocks
  }

  private async buildImageSource(url: string) {
    const trimmed = url.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('https://')) {
      return { type: 'url', url: trimmed }
    }

    const dataUrlMatch = trimmed.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (dataUrlMatch?.[1] && dataUrlMatch?.[2]) {
      return {
        type: 'base64',
        media_type: dataUrlMatch[1],
        data: dataUrlMatch[2]
      }
    }

    // Claude Code requires HTTPS URLs for `source.type=url`. If we have a non-HTTPS URL (or anything else),
    // fall back to base64 so images still work in local dev setups.
    try {
      const res = await fetch(trimmed)
      if (!res.ok) {
        console.warn('[ClaudeBridge] Failed to fetch image for Claude stream-json input', {
          url: trimmed,
          status: res.status
        })
        return null
      }

      const mediaTypeRaw = res.headers.get('content-type') || 'image/jpeg'
      const mediaType = mediaTypeRaw.split(';')[0]?.trim() || 'image/jpeg'
      const array = await res.arrayBuffer()
      const data = Buffer.from(array).toString('base64')

      return {
        type: 'base64',
        media_type: mediaType,
        data
      }
    } catch (error) {
      console.warn('[ClaudeBridge] Failed to download image for Claude stream-json input', trimmed, error)
      return null
    }
  }

  private async runViaCli(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunner> {
    const status = await detectClaudeCliStatus()
    if (!status.available) {
      throw new Error(
        status.error ||
          'Claude Code CLI is not installed or not authenticated. Install it and run `claude auth login`.'
      )
    }

    const args = [
      '--print',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose'
    ]

    if (options.model && !options.model.includes('claude-cli')) {
      args.push('--model', options.model)
    }

    const permissionBlockReason = options.permissionMode
      ? getClaudePermissionModeRuntimeBlockReason(options.permissionMode)
      : null
    if (permissionBlockReason) {
      throw new Error(permissionBlockReason)
    }

    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }

    if (options.permissionPromptTool) {
      args.push('--permission-prompt-tool', options.permissionPromptTool)
    }

    if (options.disallowedTools && options.disallowedTools.length > 0) {
      const list = options.disallowedTools
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
      if (list.length > 0) {
        args.push('--disallowedTools', list.join(','))
      }
    }

    const list = this.buildCliAllowedTools(options)
    if (list.length > 0) {
      args.push('--allowedTools', list.join(','))
    }

    if (options.systemPromptMode === 'append' && options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt)
    } else if (options.systemPromptMode === 'replace' && options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt)
    } else if (options.systemPromptMode === 'replace_file' && options.systemPromptFile) {
      args.push('--system-prompt-file', options.systemPromptFile)
    }

    if (options.chromeEnabled === true) {
      args.push('--chrome')
    } else if (options.chromeEnabled === false) {
      args.push('--no-chrome')
    }

    if (options.settingSources && options.settingSources.length > 0) {
      args.push('--setting-sources', options.settingSources.join(','))
    }

    if (options.settingsPath) {
      args.push('--settings', options.settingsPath)
    }

    if (options.mcpConfigPath) {
      args.push('--mcp-config', options.mcpConfigPath)
      args.push('--strict-mcp-config')
    }

    if (options.pluginDirs && options.pluginDirs.length > 0) {
      for (const dir of options.pluginDirs) {
        args.push('--plugin-dir', dir)
      }
    }

    if (options.addDirectories) {
      for (const dir of options.addDirectories) {
        args.push('--add-dir', dir)
      }
    }

    const runAsIdentity = resolveClaudeRunAsIdentity()
    const envVars = buildClaudeChildEnv(process.env, runAsIdentity)
    const childProcessOptions = buildClaudeChildProcessOptions(runAsIdentity)
    if (typeof options.maxThinkingTokens === 'number' && options.maxThinkingTokens > 0) {
      envVars.MAX_THINKING_TOKENS = String(options.maxThinkingTokens)
    }
    if (options.sessionId) {
      envVars.BATSHIT_SESSION_ID = options.sessionId
    }
    if (options.messageId) {
      envVars.BATSHIT_MESSAGE_ID = options.messageId
    }
    if (options.userId) {
      envVars.BATSHIT_USER_ID = options.userId
    }
    if (options.agentId) {
      envVars.BATSHIT_AGENT_ID = options.agentId
    }
    if (options.batshitToken) {
      envVars.BATSHIT_TOKEN = options.batshitToken
    }
    if (options.approvalMode) {
      envVars.BATSHIT_CLAUDE_PERMISSION_MODE = options.approvalMode
    }
    if (options.autoAllowTools) {
      envVars.BATSHIT_CLAUDE_AUTO_ALLOW_TOOLS = JSON.stringify(options.autoAllowTools)
    }
    if (options.allowedTools) {
      envVars.BATSHIT_CLAUDE_ALLOWED_TOOLS = JSON.stringify(options.allowedTools)
    }
    if (options.disallowedTools) {
      envVars.BATSHIT_CLAUDE_DENIED_TOOLS = JSON.stringify(options.disallowedTools)
    }
    if (options.allowedMcpTools) {
      envVars.BATSHIT_CLAUDE_ALLOWED_MCP_TOOLS = JSON.stringify(options.allowedMcpTools)
    }
    if (options.planAllowedTools) {
      envVars.BATSHIT_CLAUDE_PLAN_ALLOW_TOOLS = JSON.stringify(options.planAllowedTools)
    }
    if (options.allowedDirs) {
      envVars.BATSHIT_CLAUDE_ALLOWED_DIRS = JSON.stringify(options.allowedDirs)
    }
    if (options.workingDirectory) {
      envVars.BATSHIT_CLAUDE_WORKDIR = options.workingDirectory
    }
    for (const [key, value] of Object.entries(options.managedStdioEnv ?? {})) {
      envVars[key] = value
    }

    const claudeExecutable = status.executable || resolveClaudeCliExecutable(envVars)
    logger.debug('[ClaudeBridge CLI] Executing claude', JSON.stringify({
      executable: claudeExecutable,
      version: status.version ?? null,
      source: status.source ?? null,
      runAsUid: runAsIdentity.uid ?? null,
      runAsUser: runAsIdentity.user ?? null,
      args: redactClaudeCliArgsForLog(args)
    }))

    const child = spawn(claudeExecutable, args, {
      cwd: options.workingDirectory,
      env: envVars,
      ...childProcessOptions,
      signal: options.signal
    })

    if (child.stdin) {
      child.stdin.write(`${prompt}\n`)
      child.stdin.end()
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    })

    let stderrBuffer = ''
    const baseEvents = this.createCliEventIterator(rl, child, () => stderrBuffer, options.signal)

    const guard = options.contextGuard ?? null
    if (guard) {
      logger.debug('[ClaudeBridge CLI] Context guard active', {
        contextWindow: guard.contextWindow,
        threshold: guard.threshold
      })
    }
    const events = guard
      ? applyClaudeContextGuard(baseEvents, {
          contextWindow: guard.contextWindow,
          threshold: guard.threshold,
          onTrip: (stopMessage) => {
            console.warn('[ClaudeBridge CLI] Context guard stopping Claude run', { stopMessage })
            rl.close()
            if (child.exitCode === null && !child.killed) {
              child.kill('SIGTERM')
            }
            const killTimer = setTimeout(() => {
              try {
                if (child.exitCode === null) child.kill('SIGKILL')
              } catch {
                // Child exited between the check and the kill — nothing to stop.
              }
            }, GUARD_KILL_GRACE_MS)
            killTimer.unref?.()
          }
        })
      : baseEvents

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderrBuffer += text
      if (text.trim().length) {
        console.warn('[ClaudeBridge CLI]', text.trim())
      }
    })

    child.once('error', (error) => {
      const isAbortError =
        (error as { name?: string; code?: string })?.name === 'AbortError' ||
        (error as { code?: string })?.code === 'ABORT_ERR'
      if (isAbortError && options.signal?.aborted) {
        return
      }
      console.error('[ClaudeBridge CLI] Spawn error', error)
    })

    const cleanup = async () => {
      rl.close()
      child.removeAllListeners()
      if (!child.killed) {
        child.kill()
      }
    }

    return {
      transport: 'cli',
      events,
      cleanup
    }
  }

  private resolveCliModel(requestModel?: string | null, settingsModel?: string | null) {
    const settings = typeof settingsModel === 'string' ? settingsModel.trim() : ''
    if (settings) return settings

    const request = typeof requestModel === 'string' ? requestModel.trim() : ''
    if (!request) return null
    if (request.toLowerCase().includes('claude-cli')) return null
    return request
  }

  private async resolveManagedStdioEnv(
    userId: string,
    gatewayToolMap?: Record<string, string[]> | null
  ): Promise<Record<string, string>> {
    if (!gatewayToolMap) return {}

    const gatewayIds = Object.keys(gatewayToolMap)
    if (gatewayIds.length === 0) return {}

    const gateways = await mcpGatewayService.list(userId)
    const values: Record<string, string> = {}

    for (const gateway of gateways) {
      if (!gatewayIds.includes(gateway.id) || !isStdioGateway(gateway)) continue
      Object.assign(values, await resolveManagedStdioEnvironmentValues({ gateway, userId }))
    }

    return values
  }

  private async *createCliEventIterator(
    rl: readline.Interface,
    child: import('node:child_process').ChildProcess,
    getStderr: () => string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<any> {
    try {
      for await (const line of rl) {
        if (!line) continue
        try {
          const parsed = JSON.parse(line)
          yield parsed
        } catch (error) {
          console.error('[ClaudeBridge CLI] Failed to parse event line', error)
        }
      }
      await new Promise<void>((resolve, reject) => {
        child.once('close', (code, signal) => {
          const aborted =
            abortSignal?.aborted === true ||
            signal === 'SIGTERM' ||
            signal === 'SIGKILL' ||
            code === 143 ||
            code === 137

          if (code === 0 || aborted) {
            resolve()
            return
          }

          reject(
            new Error(
              `Claude CLI exited with code ${code ?? -1}: ${getStderr()?.trim() || 'No stderr output'}`
            )
          )
        })
      })
    } finally {
      rl.close()
    }
  }

  private wrapStream(
    stream: AsyncGenerator<any>,
    context: {
      onAbort?: NativeModeRequest['onAbort']
      abortSignal?: AbortSignal
      adapter: ClaudeEventAdapter
      cleanup?: (() => void | Promise<void>) | undefined
      onFirstChunk?: () => void
    }
  ) {
    const { onAbort, abortSignal, adapter, cleanup, onFirstChunk } = context

    if (abortSignal && onAbort) {
      abortSignal.addEventListener(
        'abort',
        () => {
          try {
            onAbort({
              steps: adapter.getIntermediateSteps()
            })
          } catch (error) {
            console.error('[ClaudeBridge] Failed to run onAbort callback', error)
          }
        },
        { once: true }
      )
    }

    const iterator = stream[Symbol.asyncIterator]()
    let cleanedUp = false

    const runCleanup = async () => {
      if (cleanedUp) return
      cleanedUp = true
      if (cleanup) {
        await cleanup()
      }
    }

    return {
      [Symbol.asyncIterator]() {
        let firstChunkEmitted = false
        return {
          next: async () => {
            let result: IteratorResult<any>
            try {
              result = await iterator.next()
            } catch (error) {
              await runCleanup()
              throw error
            }
            if (!firstChunkEmitted && !result.done && onFirstChunk) {
              firstChunkEmitted = true
              try {
                onFirstChunk()
              } catch (error) {
                console.error('[ClaudeBridge] First-chunk callback failed', error)
              }
            }
            if (result.done) {
              await runCleanup()
            }
            return result
          },
          return: async () => {
            await runCleanup()
            return iterator.return
              ? iterator.return(undefined)
              : Promise.resolve({ done: true, value: undefined })
          },
          throw: (err?: any) => (iterator.throw ? iterator.throw(err) : Promise.reject(err))
        }
      }
    }
  }
}
