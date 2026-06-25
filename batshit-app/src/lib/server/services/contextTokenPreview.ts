import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { redis } from '$lib/server/redis'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { DatabaseService } from '$lib/services/databaseRedis.server'
import type { Message } from '$lib/stores/messages.svelte'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import {
  countTotalTokens,
  stringifyTokenCountableMessageContent
} from '$lib/utils/tokenCounter'
import {
  CLI_WRAPPER_OVERHEAD_TOKENS,
  applyManualTrimToMessages,
  isMessageProtectedFromManualTrim
} from '$lib/utils/tokenPanel'
import {
  isCliPrimaryAgentType,
  normalizePrimaryAgentType
} from '$lib/utils/primaryAgentType'
import { isSubagentCompatibleWithPrimaryAgent } from '$lib/utils/subagentType'
import { normalizeAssignedSubagent } from '$lib/server/services/assignedSubagentNormalization'
import {
  listActiveClipIds,
  normalizeSessionClipState
} from '$lib/server/services/sessionClipState'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import {
  applyContextCompactionToMessages,
  getContextCompactionState,
  resolveAutoCompactTriggerTokens,
  resolveEffectiveAutoCompactSettings
} from '$lib/utils/contextCompaction'
import {
  buildPromptBudgetReport,
  resolveBudgetOutputReserve,
  type PromptBudgetReport
} from '$lib/server/services/contextBudgetPreflight'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import type { SavedModel } from '$lib/types/savedModels'

export type AgentRow = Record<string, any>
export type RuntimeFlavor = 'codex' | 'claude' | 'vercel' | 'n8n'
export const CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES = 32_000
export const CODEX_NATIVE_BASE_OVERHEAD_TOKENS = 10_000

export interface ContextProtections {
  protectedUnzippedZipIds: string[]
  userUnzippedZipIds: string[]
  activeClipIds: string[]
}

export function stringifyMessageContent(content: unknown): string {
  return stringifyTokenCountableMessageContent(content)
}

export function normalizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((message): message is Record<string, any> => Boolean(message && typeof message === 'object'))
    .map((message) => ({
      id: typeof message.id === 'string' ? message.id : crypto.randomUUID(),
      session_id: typeof message.session_id === 'string' ? message.session_id : '',
      user_id: typeof message.user_id === 'string' ? message.user_id : '',
      agent_id: typeof message.agent_id === 'string' ? message.agent_id : undefined,
      role:
        message.role === 'assistant' || message.role === 'system' || message.role === 'user'
          ? message.role
          : 'user',
      content:
        typeof message.content === 'string'
          ? message.content
          : stringifyMessageContent(message.content),
      timestamp:
        typeof message.timestamp === 'string'
          ? message.timestamp
          : typeof message.created_at === 'string'
            ? message.created_at
            : new Date().toISOString(),
      created_at:
        typeof message.created_at === 'string'
          ? message.created_at
          : typeof message.timestamp === 'string'
            ? message.timestamp
            : new Date().toISOString(),
      metadata:
        message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
          ? message.metadata
          : undefined,
      toolResults: Array.isArray(message.toolResults) ? message.toolResults : undefined
    })) as Message[]
}

export async function loadStoredContextMessages(sessionId: string): Promise<Message[]> {
  return normalizeMessages(await redis.getSessionMessages(sessionId))
}

export async function resolveContextPreviewMessages(params: {
  sessionId: string
  providedMessages: unknown
  useStoredMessages?: boolean
}): Promise<Message[]> {
  if (params.useStoredMessages) {
    return loadStoredContextMessages(params.sessionId)
  }

  return normalizeMessages(params.providedMessages)
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

function resolveAssignedSubagentIds(agent: AgentRow): string[] {
  if (Array.isArray(agent.assignedSubagents) && agent.assignedSubagents.length > 0) {
    return normalizeStringArray(agent.assignedSubagents)
  }
  if (Array.isArray(agent.assigned_subagent_ids) && agent.assigned_subagent_ids.length > 0) {
    return normalizeStringArray(agent.assigned_subagent_ids)
  }
  return []
}

export async function loadAssignedSubagents(agent: AgentRow): Promise<any[]> {
  const ids = resolveAssignedSubagentIds(agent)
  if (!ids.length) return []

  const subagents: any[] = []
  await redis.execute(async (client) => {
    for (const id of ids) {
      try {
        const raw = await client.json.get(`subagent:${id}`)
        if (raw) {
          subagents.push(normalizeAssignedSubagent(raw as Record<string, any>))
        }
      } catch (error) {
        console.error(`[context-preview] Failed to load subagent ${id}:`, error)
      }
    }
  })

  const primaryAgentType = normalizePrimaryAgentType(agent)
  return subagents.filter((subagent) =>
    isSubagentCompatibleWithPrimaryAgent(primaryAgentType, subagent)
  )
}

async function loadProtectedUnzippedZipIds(sessionId: string): Promise<string[]> {
  const ids = await redis.sMembers(`unzipped:${sessionId}`).catch(() => [])
  const protectedIds: string[] = []

  for (const zipId of ids ?? []) {
    if (typeof zipId === 'string' && zipId.trim()) protectedIds.push(zipId.trim())
  }

  return protectedIds
}

async function loadActiveClipIds(sessionId: string): Promise<string[]> {
  const raw = await redis.get(`session:${sessionId}:clip_state`).catch(() => null)
  const state = normalizeSessionClipState(sessionId, raw)
  return listActiveClipIds(state)
}

export async function loadContextProtections(sessionId: string): Promise<ContextProtections> {
  const [protectedUnzippedZipIds, activeClipIds] = await Promise.all([
    loadProtectedUnzippedZipIds(sessionId),
    loadActiveClipIds(sessionId)
  ])

  return {
    protectedUnzippedZipIds,
    userUnzippedZipIds: protectedUnzippedZipIds,
    activeClipIds
  }
}

export function resolveRuntimeFlavor(agent: AgentRow, agentTypeHint?: string): RuntimeFlavor {
  const primaryAgentType = normalizePrimaryAgentType({
    ...agent,
    ...(agentTypeHint ? { agentType: agentTypeHint } : {})
  })

  if (primaryAgentType === 'n8n') return 'n8n'
  if (!isCliPrimaryAgentType(primaryAgentType)) return 'vercel'

  const provider = String(agent.primary_model_provider ?? '').toLowerCase()
  const connection = String(
    agent.primary_model_connection?.service ??
      agent.primary_model_connection?.id ??
      agent.primary_model_connection?.type ??
      ''
  ).toLowerCase()

  return provider.includes('claude') || connection.includes('claude') ? 'claude' : 'codex'
}

export function resolveCliWrapperOverhead(agent: AgentRow, agentTypeHint?: string): number {
  const primaryAgentType = normalizePrimaryAgentType({
    ...agent,
    ...(agentTypeHint ? { agentType: agentTypeHint } : {})
  })
  return isCliPrimaryAgentType(primaryAgentType) ? CLI_WRAPPER_OVERHEAD_TOKENS : 0
}

function readTokenStatValue(stat: { value?: number | null } | null | undefined): number | null {
  return typeof stat?.value === 'number' && Number.isFinite(stat.value)
    ? stat.value
    : null
}

function countSnapshotCompiledTokens(snapshot: ExecutionSnapshot): number | null {
  const compiledMessages = snapshot.compiledMessages
  if (!Array.isArray(compiledMessages) || compiledMessages.length === 0) return null

  return countTotalTokens(
    compiledMessages.map((message) => ({
      role: typeof message?.role === 'string' ? message.role : 'user',
      content: message?.content
    }))
  )
}

function readSnapshotInputTokens(snapshot: ExecutionSnapshot): number | null {
  return (
    readTokenStatValue(snapshot.responseSummary?.usage?.inputTokens) ??
    readTokenStatValue(snapshot.llmSummary?.totalUsage?.inputTokens) ??
    null
  )
}

function snapshotHasCliToolActivity(snapshot: ExecutionSnapshot): boolean {
  const toolCallsCount = readTokenStatValue(snapshot.responseSummary?.toolCallsCount)
  if (toolCallsCount !== null && toolCallsCount > 0) return true
  if (Array.isArray(snapshot.intermediateSteps) && snapshot.intermediateSteps.length > 0) return true

  const eventLog = Array.isArray(snapshot.runtime?.eventLog)
    ? snapshot.runtime?.eventLog
    : []
  return eventLog.some((event: any) => {
    const itemType = typeof event?.item?.type === 'string' ? event.item.type : ''
    return itemType.includes('command_execution') || itemType.includes('tool')
  })
}

async function resolveObservedCliNativeOverheadTokens(params: {
  sessionId: string
  agentId?: string | null
  runtimeFlavor: RuntimeFlavor
}): Promise<number | null> {
  if (params.runtimeFlavor !== 'codex' && params.runtimeFlavor !== 'claude') return null

  const snapshots = await executionViewerService.getSnapshots(params.sessionId).catch(() => [])
  for (const snapshot of snapshots) {
    if (params.agentId && snapshot.agentId && snapshot.agentId !== params.agentId) continue
    if (snapshotHasCliToolActivity(snapshot)) continue

    const runtimeId = String(snapshot.runtime?.runtimeId ?? '').toLowerCase()
    const usageSource = String(
      snapshot.responseSummary?.usage?.inputTokens?.source ??
        snapshot.llmSummary?.totalUsage?.inputTokens?.source ??
        ''
    ).toLowerCase()
    if (
      (runtimeId && runtimeId !== params.runtimeFlavor) ||
      (usageSource && usageSource !== params.runtimeFlavor)
    ) {
      continue
    }

    const inputTokens = readSnapshotInputTokens(snapshot)
    const compiledTokens = countSnapshotCompiledTokens(snapshot)
    if (inputTokens === null || compiledTokens === null) continue

    const overhead = inputTokens - compiledTokens
    if (Number.isFinite(overhead) && overhead > 0) {
      return Math.round(overhead)
    }
  }

  return null
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null
}

export function resolveCodexProjectDocMaxBytes(agent: AgentRow): number {
  const settings = buildCodexRuntimeSettings(agent.codex_settings ?? agent.provider_specific_settings ?? null)
  const override = settings.configOverrides.find((entry) => {
    const key = entry.key.trim().toLowerCase()
    return key === 'project_doc_max_bytes' || key === 'project.doc_max_bytes'
  })
  return parsePositiveInteger(override?.value) ?? CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES
}

async function readProjectInstructionsFile(projectPath: string): Promise<Buffer | null> {
  const trimmed = projectPath.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return null

  for (const filename of ['AGENTS.md', 'agents.md', 'Agents.md']) {
    try {
      return await readFile(path.join(trimmed, filename))
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return null
    }
  }

  return null
}

export async function estimateCodexProjectInstructionTokens(params: {
  agent: AgentRow
  projectPath?: string | null
}): Promise<number> {
  const settings = buildCodexRuntimeSettings(params.agent.codex_settings ?? params.agent.provider_specific_settings ?? null)
  if (settings.includeProjectInstructions === false) return 0

  const maxBytes = resolveCodexProjectDocMaxBytes(params.agent)
  if (maxBytes <= 0) return 0

  const projectPath = params.projectPath?.trim()
  if (!projectPath) return 0

  const fileBuffer = await readProjectInstructionsFile(projectPath)
  if (!fileBuffer) return 0

  const selected = fileBuffer.byteLength > maxBytes ? fileBuffer.subarray(0, maxBytes) : fileBuffer
  return countTotalTokens([
    {
      role: 'system',
      content: selected.toString('utf8')
    }
  ])
}

export async function estimateCodexProjectInstructionChars(params: {
  agent: AgentRow
  projectPath?: string | null
}): Promise<number> {
  const settings = buildCodexRuntimeSettings(params.agent.codex_settings ?? params.agent.provider_specific_settings ?? null)
  if (settings.includeProjectInstructions === false) return 0

  const maxBytes = resolveCodexProjectDocMaxBytes(params.agent)
  if (maxBytes <= 0) return 0

  const projectPath = params.projectPath?.trim()
  if (!projectPath) return 0

  const fileBuffer = await readProjectInstructionsFile(projectPath)
  if (!fileBuffer) return 0

  const selected = fileBuffer.byteLength > maxBytes ? fileBuffer.subarray(0, maxBytes) : fileBuffer
  return selected.toString('utf8').length
}

async function resolveCliNativeOverheadTokens(params: {
  sessionId: string
  agent: AgentRow
  runtimeFlavor: RuntimeFlavor
  projectPath?: string | null
  wrapperOverheadTokens: number
}): Promise<number> {
  const observed = await resolveObservedCliNativeOverheadTokens({
    sessionId: params.sessionId,
    agentId: typeof params.agent.id === 'string' ? params.agent.id : null,
    runtimeFlavor: params.runtimeFlavor
  })
  if (observed !== null) return observed

  if (params.runtimeFlavor === 'codex') {
    return (
      CODEX_NATIVE_BASE_OVERHEAD_TOKENS +
      (await estimateCodexProjectInstructionTokens({
        agent: params.agent,
        projectPath: params.projectPath
      }))
    )
  }

  return params.wrapperOverheadTokens
}

async function loadPrimarySavedModel(agent: AgentRow): Promise<SavedModel | null> {
  const presetId =
    typeof agent.primary_model_preset_id === 'string' && agent.primary_model_preset_id.trim()
      ? agent.primary_model_preset_id.trim()
      : null
  if (!presetId) return null

  const model = await redis.get(`model:${presetId}`).catch(() => null)
  return model && typeof model === 'object' ? model as SavedModel : null
}

async function resolveAgentBudgetSettings(agent: AgentRow) {
  const preset = await loadPrimarySavedModel(agent)
  const selection = resolveRuntimeModelSelection({
    preset,
    presetId: typeof agent.primary_model_preset_id === 'string' ? agent.primary_model_preset_id : null,
    provider: agent.primary_model_provider,
    modelId: agent.primary_model_name,
    connection: preset?.connection ?? agent.primary_model_connection ?? null,
    capabilities: preset?.capabilities ?? agent.primary_model_capabilities ?? null,
    settings: (preset?.settings ?? agent.provider_specific_settings ?? null) as Record<string, any> | null
  })
  const explicitMaxTokens =
    typeof selection.settings?.maxTokens === 'number'
      ? selection.settings.maxTokens
      : typeof agent.primary_model_max_tokens === 'number'
        ? agent.primary_model_max_tokens
        : null

  return {
    contextLimit: selection.contextWindow ?? null,
    maxOutputTokens: explicitMaxTokens,
    reasoningModel: Boolean(selection.capabilities?.reasoning)
  }
}

export async function estimateCompiledBudget(params: {
  sessionId: string
  messages: Message[]
  agent: AgentRow
  userId: string
  assignedSubagents: any[]
  runtimeFlavor: RuntimeFlavor
  wrapperOverheadTokens: number
  eventFetch: typeof fetch
}): Promise<{
  tokens: number
  budget: PromptBudgetReport
  wrapperOverheadTokens: number
  compiledMessages: Array<{ role: string; content: unknown }>
}> {
  const databaseService = new DatabaseService(params.eventFetch)
  const userSettings = await redis.getUserSettings(params.userId).catch(() => null)
  const formatted = await databaseService.buildFormattedChatInput(
    params.sessionId,
    params.messages,
    params.agent,
    undefined,
    params.assignedSubagents,
    params.userId,
    {
      fetch: params.eventFetch,
      runtimeFlavor: params.runtimeFlavor,
      goonsSettings: userSettings?.goons_settings ?? null
    }
  )

  const compiledMessages = []
  if (formatted.primarySystemPrompt) {
    compiledMessages.push({
      role: 'system',
      content: formatted.primarySystemPrompt
    })
  }
  for (const message of formatted.structuredInput?.messages ?? []) {
    compiledMessages.push({
      role: typeof message?.role === 'string' ? message.role : 'user',
      content: message?.content
    })
  }

  const nativeOverheadTokens = await resolveCliNativeOverheadTokens({
    sessionId: params.sessionId,
    agent: params.agent,
    runtimeFlavor: params.runtimeFlavor,
    projectPath:
      formatted.resolvedProjectPath ??
      formatted.structuredInput?.metadata?.resolvedProjectPath ??
      null,
    wrapperOverheadTokens: params.wrapperOverheadTokens
  })
  const [budgetSettings, codexProjectInstructionChars] = await Promise.all([
    resolveAgentBudgetSettings(params.agent),
    params.runtimeFlavor === 'codex'
      ? estimateCodexProjectInstructionChars({
          agent: params.agent,
          projectPath:
            formatted.resolvedProjectPath ??
            formatted.structuredInput?.metadata?.resolvedProjectPath ??
            null
        })
      : Promise.resolve(0)
  ])
  const effectiveAutoCompactSettings = resolveEffectiveAutoCompactSettings({
    global: userSettings?.global_auto_compact_settings,
    agent: params.agent.auto_compact_settings
  })
  const autoCompactTriggerTokens = resolveAutoCompactTriggerTokens(
    effectiveAutoCompactSettings,
    budgetSettings.contextLimit
  )
  const outputReserveTokens = resolveBudgetOutputReserve({
    maxOutputTokens: budgetSettings.maxOutputTokens,
    contextLimit: budgetSettings.contextLimit,
    reasoningModel: budgetSettings.reasoningModel
  })
  const budget = buildPromptBudgetReport({
    runtime: params.runtimeFlavor,
    messages: compiledMessages,
    contextLimit: budgetSettings.contextLimit,
    nativeOverheadTokens,
    outputReserveTokens,
    autoCompactTriggerTokens,
    extraRuntimeInputChars: codexProjectInstructionChars
  })

  return {
    tokens: budget.estimatedRuntimeTokens,
    budget,
    wrapperOverheadTokens: params.wrapperOverheadTokens,
    compiledMessages
  }
}

export async function estimateCompiledTokens(params: {
  sessionId: string
  messages: Message[]
  agent: AgentRow
  userId: string
  assignedSubagents: any[]
  runtimeFlavor: RuntimeFlavor
  wrapperOverheadTokens: number
  eventFetch: typeof fetch
}) {
  const result = await estimateCompiledBudget(params)
  return result.tokens
}

export async function estimateCurrentContextTokens(params: {
  sessionId: string
  messages: Message[]
  agent: AgentRow
  userId: string
  agentTypeHint?: string
  trimmedMessageIds?: string[]
  eventFetch: typeof fetch
}) {
  const [protections, assignedSubagents] = await Promise.all([
    loadContextProtections(params.sessionId),
    loadAssignedSubagents(params.agent)
  ])
  const session = await redis.getSession(params.sessionId).catch(() => null)
  const compactionState = getContextCompactionState(session?.metadata ?? null)
  const compactedMessages = applyContextCompactionToMessages(
    params.messages,
    compactionState.events
  )
  const messagesById = new Map(compactedMessages.map((message) => [message.id, message]))
  const trimmedMessageIds = normalizeStringArray(params.trimmedMessageIds).filter((id) => {
    const message = messagesById.get(id)
    return message && !isMessageProtectedFromManualTrim(message, protections)
  })
  const runtimeFlavor = resolveRuntimeFlavor(params.agent, params.agentTypeHint)
  const wrapperOverheadTokens = resolveCliWrapperOverhead(params.agent, params.agentTypeHint)
  const contextMessages = applyManualTrimToMessages(compactedMessages, trimmedMessageIds, {
    protections,
    sessionId: params.sessionId,
    userId: params.userId
  })
  const compiled = await estimateCompiledBudget({
    sessionId: params.sessionId,
    messages: contextMessages,
    agent: params.agent,
    userId: params.userId,
    assignedSubagents,
    runtimeFlavor,
    wrapperOverheadTokens,
    eventFetch: params.eventFetch
  })

  return {
    tokens: compiled.tokens,
    budget: compiled.budget,
    wrapperOverheadTokens,
    trimmedMessageIds,
    trimmedMessageCount: trimmedMessageIds.length
  }
}
