import { randomUUID } from 'crypto'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import type { SubagentRow, MCPToolSelections } from '$lib/types/database'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import { CodexBridge } from '$lib/server/services/codexBridge'
import { ClaudeBridge } from '$lib/server/services/claudeBridge'
import {
  buildAgentProfileId,
  prepareManagedCodexSubagentProfile,
} from '$lib/server/services/codexProfileManager'
import { prepareManagedClaudeSubagentProfile } from '$lib/server/services/claudeProfileManager'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import {
  resolveCliSubagentExecutableModel,
  resolveCliSubagentRuntime,
  type CliSubagentRuntime,
} from '$lib/server/services/cliSubagentModelResolution'
import {
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities,
} from '$lib/server/services/slashCommandCapabilities'
import {
  getSubagentTypeDisplayLabel,
  isApiSubagentType,
  isCliSubagentType,
  isWorkflowBackedSubagentType,
  normalizeSubagentType,
  type SubagentType,
} from '$lib/utils/subagentType'
import { buildSubagentRuntimePrompt } from '$lib/utils/subagentRuntimePrompt'
import {
  buildCliSubagentRuntimeId,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import { callWorkflow } from '$lib/server/services/workflowExecutor'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  resolveRuntimeN8nBaseUrl,
  rewriteBatshitCallbackUrlsForN8nRuntime,
  rewriteN8nWebhookUrlForRuntime,
} from '$lib/server/services/runtimeUrlRewrites'
import { createN8nSseCallbackToken } from '$lib/server/services/n8nCallbackTokens'
import {
  appendManagedSubagentDynamicInfo,
  buildManagedSubagentDynamicInfo,
  resolveManagedSubagentScope,
} from '$lib/server/services/subagentRuntimeScope'
import { resolveCacheForensicsExperimentGroup } from '$lib/server/services/cacheForensics/apiAdapter'
import {
  buildManagedSubagentCacheForensicsRecord,
  type ManagedSubagentForensicsLane,
} from '$lib/server/services/cacheForensics/subagentAdapter'
import {
  appendSubagentCacheForensicsRecord,
  isCacheForensicsEnabled,
} from '$lib/server/services/cacheForensics/evIntegration'

const MAX_SUBAGENT_MEMORY_MESSAGES = 24

type ManagedSubagentMemoryMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ManagedSubagentExecutionParams = {
  userId: string
  sessionId: string
  chatInput: string
  subagent: SubagentRow
  parentAgentId?: string | null
  /** Parent send's message id — enables SA-093 forensics on the parent snapshot. */
  parentMessageId?: string | null
  projectPath?: string | null
  selectedGateways?: string[] | null
  toolSelections?: MCPToolSelections | null
  selectedCliToolIds?: string[] | null
  defaultGateways?: string[] | null
  toolApprovalMode?: ToolApprovalMode
  parentModelId?: string | null
  parentConnection?: ModelConnectionInfo | null
  dcmDisplaySettings?: import('$lib/types/database').AgentDcmDisplaySettings | null
  abortSignal?: AbortSignal
}

export type ManagedSubagentExecutionResult = {
  output: string
  intermediateSteps: any[]
  subagentType: SubagentType
}

function subagentMemoryKey(sessionId: string, slug: string) {
  return `subagent_sessions:${sessionId}:subagent:${slug}`
}

function normalizeMemoryEntries(
  value: unknown
): ManagedSubagentMemoryMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const role =
        (entry as Record<string, unknown>).role === 'assistant'
          ? 'assistant'
          : (entry as Record<string, unknown>).role === 'user'
            ? 'user'
            : null
      const content = (entry as Record<string, unknown>).content
      if (!role || typeof content !== 'string' || content.trim().length === 0) {
        return null
      }
      return {
        role,
        content: content.trim(),
      }
    })
    .filter((entry): entry is ManagedSubagentMemoryMessage => entry !== null)
    .slice(-MAX_SUBAGENT_MEMORY_MESSAGES)
}

async function loadSubagentMemory(
  sessionId: string,
  slug: string
): Promise<ManagedSubagentMemoryMessage[]> {
  try {
    const stored = await redis.json.get(subagentMemoryKey(sessionId, slug))
    return normalizeMemoryEntries(stored)
  } catch (error) {
    console.warn('[SubagentRunner] Failed to load subagent memory:', error)
    return []
  }
}

async function persistSubagentMemory(
  sessionId: string,
  slug: string,
  previousMessages: ManagedSubagentMemoryMessage[],
  newMessages: ManagedSubagentMemoryMessage[]
) {
  const nextMessages = [...previousMessages, ...newMessages].slice(
    -MAX_SUBAGENT_MEMORY_MESSAGES
  )

  await redis.json.set(subagentMemoryKey(sessionId, slug), '$', nextMessages)
}

export async function compileManagedSubagentSystemPrompt(
  subagent: SubagentRow,
  userId: string
): Promise<{ systemPrompt: string; description: string }> {
  let systemPrompt = ''

  try {
    const basePrompt = await redis.get('batshit:sub_system_prompt')
    if (basePrompt) {
      systemPrompt = `==== BATSHIT SUB-AGENT SYSTEM PROMPT ====\n\n${basePrompt}`
    }

    if (subagent.include_global_prompt) {
      try {
        const userSettings = await redis.getUserSettings(userId)
        const globalPrompt = userSettings?.global_custom_system_prompt || ''
        if (globalPrompt) {
          if (systemPrompt) systemPrompt += '\n\n'
          systemPrompt += `==== GLOBAL CUSTOM SYSTEM PROMPT ====\n\n${globalPrompt}`
        }
      } catch (error) {
        console.error('[SubagentRunner] Error loading global prompt:', error)
      }
    }

    if (subagent.system_prompt) {
      if (systemPrompt) systemPrompt += '\n\n'
      systemPrompt += `==== SUBAGENT CUSTOM SYSTEM PROMPT ====\n\n${subagent.system_prompt}`
    }

    const runtimePrompt = buildSubagentRuntimePrompt(subagent)
    if (runtimePrompt.trim()) {
      if (systemPrompt) systemPrompt += '\n\n'
      systemPrompt += runtimePrompt
    }

    const subagentId =
      typeof subagent.id === 'string' && subagent.id.trim().length > 0
        ? subagent.id.trim()
        : ''
    if (subagentId && userId) {
      const skillsCommandsLines = buildSkillsCommandsDcmLines(
        await getEnabledAgentSlashCapabilities(userId, subagentId)
      )
      const hasSubagentSkillsCommands = skillsCommandsLines.some((line) =>
        line.startsWith('- /')
      )
      if (hasSubagentSkillsCommands) {
        if (systemPrompt) systemPrompt += '\n\n'
        systemPrompt +=
          `==== SKILLS & PROMPTS (AGENT ACCESS) ====\n\n${skillsCommandsLines.join('\n')}`
      }
    }
  } catch (error) {
    console.error('[SubagentRunner] Error compiling subagent system prompt:', error)
  }

  return {
    systemPrompt,
    description: subagent.description ?? '',
  }
}

function resolveSubagentModelId(
  subagent: SubagentRow,
  parentModelId?: string | null
): string | null {
  const ownModel = subagent.primary_model_name?.trim() || subagent.model?.trim()
  if (ownModel) return ownModel
  const fallbackModel = parentModelId?.trim()
  return fallbackModel && fallbackModel.length > 0 ? fallbackModel : null
}

function resolveBatshitCallbackBaseForN8nWorkflow(): string | null {
  const runtimeEnv = env as Partial<Record<string, string | undefined>>
  return (
    runtimeEnv.BATSHIT_N8N_CALLBACK_BASE_URL?.trim() ||
    runtimeEnv.BATSHIT_FRONTEND_URL?.trim() ||
    runtimeEnv.PUBLIC_BASE_URL?.trim() ||
    runtimeEnv.ORIGIN?.trim() ||
    null
  )
}

function joinCallbackPath(base: string, pathname: string): string {
  try {
    const url = new URL(base)
    url.pathname = pathname
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return `${base.replace(/\/+$/, '')}${pathname}`
  }
}

function cloneProviderSettings(value: Record<string, any> | null | undefined): Record<string, any> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return structuredClone(value)
}

function buildCliSubagentProviderSettings(
  subagent: SubagentRow,
): Record<string, any> {
  const base = cloneProviderSettings(subagent.provider_specific_settings ?? null)
  const nativeTools =
    base.nativeTools && typeof base.nativeTools === 'object'
      ? { ...base.nativeTools }
      : base.batshitNativeTools && typeof base.batshitNativeTools === 'object'
        ? { ...base.batshitNativeTools }
        : {}

  nativeTools.fetchZipEnabled = false
  nativeTools.batshitToolsEnabled = false

  base.nativeTools = nativeTools
  delete base.batshitNativeTools

  return base
}

function shouldSkipCliSubagentToolResult(toolName?: string | null, dynamic?: boolean): boolean {
  if (dynamic) return true
  const normalized = toolName?.trim().toLowerCase() ?? ''
  return normalized === 'codex_plan_update'
}

async function collectCliSubagentStreamResult(
  streamResult: Awaited<ReturnType<CodexBridge['streamNativeMode']>> | Awaited<ReturnType<ClaudeBridge['streamNativeMode']>>
): Promise<{ output: string; intermediateSteps: any[]; usage: unknown }> {
  const outputChunks: string[] = []
  const intermediateSteps: any[] = []
  let usage: unknown = null
  const detectToolSource =
    typeof (streamResult as any).__detectToolSource === 'function'
      ? (streamResult as any).__detectToolSource
      : () => ({})

  for await (const chunk of (streamResult as any).stream as AsyncIterable<any>) {
    if (!chunk || typeof chunk !== 'object') continue

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      outputChunks.push(chunk.text)
      continue
    }

    if (chunk.type === 'finish') {
      usage = chunk.totalUsage ?? chunk.usage ?? usage
      continue
    }

    if (chunk.type !== 'tool-result') continue
    if (shouldSkipCliSubagentToolResult(chunk.toolName, chunk.dynamic === true)) {
      continue
    }

    const toolName =
      typeof chunk.toolName === 'string' && chunk.toolName.trim().length > 0
        ? chunk.toolName
        : 'unknown_tool'
    const toolMetadata = detectToolSource(toolName) ?? {}
    intermediateSteps.push({
      toolName,
      toolInput: chunk.args ?? chunk.input ?? {},
      toolOutput:
        chunk.result ?? chunk.output ?? chunk.data ?? chunk.content ?? null,
      timestamp: Date.now(),
      ...toolMetadata,
      ...(chunk.metadata ?? {}),
    })
  }

  return {
    output: outputChunks.join(''),
    intermediateSteps,
    usage,
  }
}

/**
 * SA-093 P4: opt-in forensics for a completed managed subagent run. The record
 * fingerprints the subagent's OWN compiled contract and lands on the parent
 * send's Execution Viewer snapshot. Fire-and-forget and never throws — a
 * missing parent message id or snapshot means honest absence, not invention.
 */
function captureManagedSubagentForensics(args: {
  lane: ManagedSubagentForensicsLane
  params: ManagedSubagentExecutionParams
  messages: unknown[]
  usage: unknown
  connectionId: string | null
  modelId: string | null
  runMessageId: string
}): void {
  try {
    if (!isCacheForensicsEnabled()) return
    const parentMessageId = args.params.parentMessageId?.trim()
    if (!parentMessageId) return

    const record = buildManagedSubagentCacheForensicsRecord({
      lane: args.lane,
      messages: args.messages,
      usage: args.usage,
      subagentId: args.params.subagent.id ?? null,
      connectionId: args.connectionId,
      modelId: args.modelId,
      runMessageId: args.runMessageId,
      parentMessageId,
      experimentGroup: resolveCacheForensicsExperimentGroup(),
    })

    void appendSubagentCacheForensicsRecord({
      sessionId: args.params.sessionId,
      parentMessageId,
      record,
    })
  } catch (error) {
    console.error(
      '[SubagentRunner] Cache-forensics capture failed (run unaffected):',
      error instanceof Error ? error.message : error,
    )
  }
}

async function runWorkflowBackedSubagent(
  params: ManagedSubagentExecutionParams,
  subagentType: SubagentType,
  subagentSlug: string,
  systemPrompt: string
): Promise<ManagedSubagentExecutionResult> {
  const webhookUrl =
    params.subagent.webhookUrl ||
    params.subagent.webhook_url ||
    params.subagent.workflowName

  if (!webhookUrl) {
    throw new Error(
      `${getSubagentTypeDisplayLabel(subagentType)} is missing a Production Webhook URL.`
    )
  }

  const normalizedParentAgentId = params.parentAgentId ?? null
  let savedN8nApiUrl: string | null = null
  try {
    savedN8nApiUrl = await apiKeyService.retrieve('n8n_api_url', params.userId)
  } catch (error) {
    console.warn('[SubagentRunner] Failed to load n8n API URL for workflow subagent:', error)
  }
  const routedWebhookUrl = rewriteN8nWebhookUrlForRuntime(webhookUrl, savedN8nApiUrl) ?? webhookUrl
  const messageId = `subagent_${randomUUID()}`
  const runtimeN8nBaseUrl = resolveRuntimeN8nBaseUrl(savedN8nApiUrl)
  const callbackBase = resolveBatshitCallbackBaseForN8nWorkflow()
  const callback = await createN8nSseCallbackToken({
    sessionId: params.sessionId,
    messageId,
    userId: params.userId,
    agentId: normalizedParentAgentId,
  })
  const workflowPayload = rewriteBatshitCallbackUrlsForN8nRuntime(
    {
      chatInput: params.chatInput,
      user_id: params.userId,
      userId: params.userId,
      session_id: params.sessionId,
      sessionId: params.sessionId,
      message_id: messageId,
      messageId,
      agent_id: normalizedParentAgentId,
      agentId: normalizedParentAgentId,
      parent_agent_id: normalizedParentAgentId,
      parentAgentId: normalizedParentAgentId,
      primary_agent_id: normalizedParentAgentId,
      primaryAgentId: normalizedParentAgentId,
      project_path: params.projectPath ?? null,
      projectPath: params.projectPath ?? null,
      subagent_id: params.subagent.id,
      subagentId: params.subagent.id,
      subagent_slug: subagentSlug,
      subagentPrompts: {
        [subagentSlug]: systemPrompt,
      },
      subagentModel: {
        provider: params.subagent.primary_model_provider ?? null,
        model:
          params.subagent.primary_model_name ??
          params.parentModelId ??
          null,
      },
      ...(callbackBase
        ? {
            batshit_frontend_url: joinCallbackPath(callbackBase, ''),
            batshitFrontendUrl: joinCallbackPath(callbackBase, ''),
            batshit_sse_endpoint: joinCallbackPath(callbackBase, '/api/sse'),
            batshitSseEndpoint: joinCallbackPath(callbackBase, '/api/sse'),
            batshit_artifact_complete_url: joinCallbackPath(
              callbackBase,
              '/api/artifacts/complete',
            ),
            batshitArtifactCompleteUrl: joinCallbackPath(
              callbackBase,
              '/api/artifacts/complete',
            ),
          }
        : {}),
      batshit_native_tool_token: callback.token,
      batshitNativeToolToken: callback.token,
      batshit_native_tool_header: 'x-batshit-native-tool-token',
      batshitNativeToolHeader: 'x-batshit-native-tool-token',
      batshit_sse_callback_token: callback.token,
      batshitSseCallbackToken: callback.token,
      batshit_sse_callback_header: 'x-batshit-callback-token',
      batshitSseCallbackHeader: 'x-batshit-callback-token',
      batshit_sse_callback_expires_at: callback.expiresAt,
      batshitSseCallbackExpiresAt: callback.expiresAt,
      source: 'batshit-subagent-runner',
    },
    runtimeN8nBaseUrl,
  )

  const result = await callWorkflow(
    {
      id: params.subagent.id,
      name: subagentSlug,
      active: true,
      webhookUrl: routedWebhookUrl,
    },
    workflowPayload,
    {
      sessionId: params.sessionId,
      userId: params.userId,
      timeout: 30000,
      abortSignal: params.abortSignal,
    }
  )

  if (!result.success) {
    throw new Error(result.error || 'Subagent execution failed')
  }

  const output =
    typeof result.data?.output === 'string'
      ? result.data.output
      : typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data ?? {}, null, 2)

  return {
    output,
    intermediateSteps: Array.isArray(result.data?.intermediateSteps)
      ? result.data.intermediateSteps
      : [],
    subagentType,
  }
}

async function runApiSubagent(
  params: ManagedSubagentExecutionParams,
  subagentSlug: string,
  systemPrompt: string
): Promise<ManagedSubagentExecutionResult> {
  const modelId = resolveSubagentModelId(params.subagent, params.parentModelId)
  if (!modelId) {
    throw new Error('API Subagent needs a model selection or a parent model to inherit.')
  }

  const memory = await loadSubagentMemory(params.sessionId, subagentSlug)
  const messages = [
    ...(systemPrompt.trim().length > 0
      ? [{ role: 'system' as const, content: systemPrompt }]
      : []),
    ...memory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    { role: 'user' as const, content: params.chatInput },
  ]

  const { VercelAIBrain } = await import('./vercelBrain')
  const brain = new VercelAIBrain()
  const runMessageId = `subagent-${params.subagent.id}-${randomUUID()}`
  const response = await brain.processNativeMode({
    sessionId: params.sessionId,
    messageId: runMessageId,
    userId: params.userId,
    agentId: params.parentAgentId ?? undefined,
    model: modelId,
    connection: params.subagent.primary_model_name?.trim()
      ? undefined
      : params.parentConnection ?? undefined,
    messages,
    toolsEnabled: true,
    maxToolRounds: 10,
    assignedSubagents: [],
    projectPath: params.projectPath ?? null,
    selectedGateways: params.selectedGateways ?? undefined,
    toolSelections: params.toolSelections ?? undefined,
    selectedCliToolIds: params.selectedCliToolIds ?? undefined,
    dcmDisplaySettings: params.dcmDisplaySettings ?? undefined,
    defaultGateways: params.defaultGateways ?? undefined,
    toolApprovalMode: 'off',
    providerSettings: params.subagent.provider_specific_settings ?? null,
    allowArtifactRuntimeTools: true,
    allowFabricControlTools: false,
    // SA-104 P3: memory tools are PA-only in v1 — subagent memory access is a deferred
    // product decision and memory is PA-owned agent-scoped state (see story Out of Scope).
    memoryControlsEnabled: false,
    abortSignal: params.abortSignal,
  })

  const intermediateSteps = Array.isArray(response.intermediateSteps)
    ? response.intermediateSteps
    : []
  const output = stripLeadingSubagentEchoText(response.content ?? '', intermediateSteps)

  captureManagedSubagentForensics({
    lane: 'api',
    params,
    messages,
    usage: response.usage ?? null,
    connectionId: params.subagent.primary_model_name?.trim()
      ? null
      : params.parentConnection?.id ?? params.parentConnection?.service ?? null,
    modelId,
    runMessageId,
  })

  await persistSubagentMemory(params.sessionId, subagentSlug, memory, [
    { role: 'user', content: params.chatInput },
    { role: 'assistant', content: output },
  ])

  return {
    output,
    intermediateSteps,
    subagentType: 'api',
  }
}

async function runCliSubagent(
  params: ManagedSubagentExecutionParams,
  subagentSlug: string,
  systemPrompt: string
): Promise<ManagedSubagentExecutionResult> {
  const runtime = resolveCliSubagentRuntime(params.subagent)
  if (!runtime) {
    throw new Error('CLI Subagent model must point to either Codex CLI or Claude CLI.')
  }

  const modelId = resolveCliSubagentExecutableModel(params.subagent, runtime)
  if (!modelId) {
    throw new Error(
      'CLI Subagent needs a real Codex or Claude model in its native CLI defaults. The Saved Model picker only chooses the Codex/Claude lane.'
    )
  }

  const runtimeProviderSettings = buildCliSubagentProviderSettings(params.subagent)
  const nativeSettings = resolveNativeToolSettings(runtimeProviderSettings)
  const memory = await loadSubagentMemory(params.sessionId, subagentSlug)
  const messages = [
    ...(systemPrompt.trim().length > 0
      ? [{ role: 'system' as const, content: systemPrompt }]
      : []),
    ...memory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    { role: 'user' as const, content: params.chatInput },
  ]

  const runtimeId = buildCliSubagentRuntimeId(subagentSlug)
  const profileId = buildAgentProfileId(runtimeId)
  const profileLabel = `${params.subagent.displayName || subagentSlug} CLI Subagent`

  let output = ''
  let intermediateSteps: any[] = []
  let collectedUsage: unknown = null
  const runMessageId = `subagent-${params.subagent.id}-${randomUUID()}`

  if (runtime === 'codex') {
    const codexSettings = buildCodexRuntimeSettings(
      params.subagent.codex_settings ?? runtimeProviderSettings
    )
    codexSettings.profileId = profileId
    codexSettings.model = modelId
    codexSettings.historyPersistence = 'none'
    codexSettings.includeProjectInstructions = true

    const profile = await prepareManagedCodexSubagentProfile({
      userId: params.userId,
      profileId,
      runtimeId,
      label: profileLabel,
      displayName: params.subagent.displayName || subagentSlug,
      slug: subagentSlug,
      providerSettings: runtimeProviderSettings,
      defaultMCPGateways: params.defaultGateways ?? null,
      defaultMCPToolSelections: params.toolSelections ?? null,
      defaultCliToolIds: params.selectedCliToolIds ?? null,
      workingDirectory: params.projectPath ?? null,
      runtimeSettings: codexSettings,
    })

    const bridge = new CodexBridge()
    const result = await bridge.streamNativeMode({
      sessionId: params.sessionId,
      messageId: runMessageId,
      userId: params.userId,
      agentId: runtimeId,
      agentSlug: subagentSlug,
      model: modelId,
      messages,
      toolsEnabled: true,
      selectedGateways: profile.resolvedGateways,
      toolSelections: params.toolSelections ?? undefined,
      selectedCliToolIds: params.selectedCliToolIds ?? undefined,
      defaultGateways: params.defaultGateways ?? undefined,
      gatewayToolMap: profile.gatewayToolMap,
      assignedSubagents: [],
      projectPath: params.projectPath ?? null,
      providerSettings: runtimeProviderSettings,
      codexSettings,
      abortSignal: params.abortSignal,
    })

    const collected = await collectCliSubagentStreamResult(result)
    output = stripLeadingSubagentEchoText(collected.output, collected.intermediateSteps)
    intermediateSteps = collected.intermediateSteps
    collectedUsage = collected.usage
  } else {
    const claudeSettings = buildClaudeRuntimeSettings(
      params.subagent.claude_settings ?? runtimeProviderSettings
    )
    claudeSettings.profileId = profileId
    claudeSettings.model = modelId
    claudeSettings.includeProjectInstructions = true

    const profile = await prepareManagedClaudeSubagentProfile({
      userId: params.userId,
      profileId,
      runtimeId,
      label: profileLabel,
      displayName: params.subagent.displayName || subagentSlug,
      slug: subagentSlug,
      providerSettings: runtimeProviderSettings,
      defaultMCPGateways: params.defaultGateways ?? null,
      defaultMCPToolSelections: params.toolSelections ?? null,
      defaultCliToolIds: params.selectedCliToolIds ?? null,
      runtimeSettings: claudeSettings,
    })

    const bridge = new ClaudeBridge()
    const result = await bridge.streamNativeMode({
      sessionId: params.sessionId,
      messageId: runMessageId,
      userId: params.userId,
      agentId: runtimeId,
      agentSlug: subagentSlug,
      model: modelId,
      messages,
      toolsEnabled: true,
      selectedGateways: profile.resolvedGateways,
      toolSelections: params.toolSelections ?? undefined,
      selectedCliToolIds: params.selectedCliToolIds ?? undefined,
      defaultGateways: params.defaultGateways ?? undefined,
      gatewayToolMap: profile.gatewayToolMap,
      assignedSubagents: [],
      projectPath: params.projectPath ?? null,
      providerSettings: runtimeProviderSettings,
      claudeSettings,
      abortSignal: params.abortSignal,
    })

    const collected = await collectCliSubagentStreamResult(result)
    output = stripLeadingSubagentEchoText(collected.output, collected.intermediateSteps)
    intermediateSteps = collected.intermediateSteps
    collectedUsage = collected.usage
  }

  captureManagedSubagentForensics({
    lane: runtime,
    params,
    messages,
    usage: collectedUsage,
    connectionId: null,
    modelId,
    runMessageId,
  })

  await persistSubagentMemory(params.sessionId, subagentSlug, memory, [
    { role: 'user', content: params.chatInput },
    { role: 'assistant', content: output },
  ])

  return {
    output,
    intermediateSteps,
    subagentType: 'cli',
  }
}

export async function executeManagedSubagent(
  params: ManagedSubagentExecutionParams
): Promise<ManagedSubagentExecutionResult> {
  const subagentType = normalizeSubagentType(
    params.subagent,
    params.subagent.subagentType
  )
  const subagentSlug = resolveSubagentSlug(params.subagent)
  const resolvedScope = await resolveManagedSubagentScope({
    userId: params.userId,
    subagent: params.subagent,
    sessionId: params.sessionId,
    projectPath: params.projectPath ?? null,
  })
  let { systemPrompt } = await compileManagedSubagentSystemPrompt(
    params.subagent,
    params.userId
  )
  const dynamicInfo = await buildManagedSubagentDynamicInfo({
    userId: params.userId,
    subagent: params.subagent,
    sessionId: params.sessionId,
    projectPath: resolvedScope.projectPath,
  })
  systemPrompt = appendManagedSubagentDynamicInfo(systemPrompt, dynamicInfo)

  const resolvedParams: ManagedSubagentExecutionParams = {
    ...params,
    projectPath: resolvedScope.projectPath,
    selectedGateways: resolvedScope.resolvedGateways,
    toolSelections: resolvedScope.defaultMcpToolSelections ?? undefined,
    selectedCliToolIds: resolvedScope.resolvedCliToolIds,
    defaultGateways: resolvedScope.defaultMcpGateways,
    dcmDisplaySettings: resolvedScope.dcmDisplaySettings,
  }

  if (isApiSubagentType(subagentType)) {
    return runApiSubagent(resolvedParams, subagentSlug, systemPrompt)
  }

  if (isCliSubagentType(subagentType)) {
    return runCliSubagent(resolvedParams, subagentSlug, systemPrompt)
  }

  if (isWorkflowBackedSubagentType(subagentType)) {
    return runWorkflowBackedSubagent(
      resolvedParams,
      subagentType,
      subagentSlug,
      systemPrompt
    )
  }

  throw new Error(
    `${getSubagentTypeDisplayLabel(subagentType)} does not run through the managed subagent runner.`
  )
}
