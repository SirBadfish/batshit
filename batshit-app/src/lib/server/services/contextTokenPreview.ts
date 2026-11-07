import { redis } from '$lib/server/redis'
import { DatabaseService } from '$lib/services/databaseRedis.server'
import type { Message } from '$lib/stores/messages.svelte'
import { stringifyTokenCountableMessageContent } from '$lib/utils/tokenCounter'
import {
  applyManualTrimToMessages,
  isMessageProtectedFromManualTrim
} from '$lib/utils/tokenPanel'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { isSubagentCompatibleWithPrimaryAgent } from '$lib/utils/subagentType'
import { normalizeAssignedSubagent } from '$lib/server/services/assignedSubagentNormalization'
import {
  listActiveClipIds,
  normalizeSessionClipState
} from '$lib/server/services/sessionClipState'
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
import { resolveApiContextBudget } from './localApiContextBudget'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveAgentModelFallbacks, resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import type { SavedModel } from '$lib/types/savedModels'

export type AgentRow = Record<string, any>

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
    if (typeof zipId !== 'string' || !zipId.trim()) continue
    // SA-120 P5: a result Judge Juice opened (source `inferred`) is Batshit's guess, not a pin,
    // so it never shields a message from Manual Trim, Compact, or a nap. A record that
    // cannot be read keeps protecting, as every unzip always has.
    const item = await redis.get(`unzipped_item:${sessionId}:${zipId.trim()}`).catch(() => null)
    if ((item as { source?: unknown } | null)?.source === 'inferred') continue
    protectedIds.push(zipId.trim())
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

async function loadPrimarySavedModel(agent: AgentRow): Promise<SavedModel | null> {
  const presetId =
    typeof agent.primary_model_preset_id === 'string' && agent.primary_model_preset_id.trim()
      ? agent.primary_model_preset_id.trim()
      : null
  if (!presetId) return null

  const model = await redis.get(`model:${presetId}`).catch(() => null)
  return model && typeof model === 'object' ? model as SavedModel : null
}

// `_sessionId` named the chat whose saved CLI context report the Claude Code CLI lane read (SA-139
// R4 removed it); it stays in place so every positional caller still passes its `userId` third.
export async function resolveAgentBudgetSettings(agent: AgentRow, _sessionId?: string, userId = agent.user_id as string) {
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
  const runtimeSettings = buildRuntimeModelSettings({
    ...selection, settings: selection.settings,
    fallbacks: resolveAgentModelFallbacks({ preset, agent })
  })
  const explicitMaxTokens = runtimeSettings.standard.maxTokens ?? null
  const apiContext = await resolveApiContextBudget({
    userId, providerId: selection.provider, modelId: selection.modelId,
    presetContextWindow: selection.contextWindow,
    requestedContextWindow: selection.provider === 'ollama'
      ? runtimeSettings.providerOptions?.ollama?.options?.num_ctx ?? null : null
  })

  return {
    contextLimit: apiContext.contextLimit,
    localContext: apiContext.evidence,
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
  eventFetch: typeof fetch
}): Promise<{
  tokens: number
  budget: PromptBudgetReport
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

  const budgetSettings = await resolveAgentBudgetSettings(params.agent, params.sessionId, params.userId)
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
    runtime: 'vercel',
    messages: compiledMessages,
    contextLimit: budgetSettings.contextLimit,
    outputReserveTokens,
    autoCompactTriggerTokens
  })
  budget.localContext = budgetSettings.localContext

  return {
    tokens: budget.estimatedRuntimeTokens,
    budget,
    compiledMessages
  }
}

export async function estimateCompiledTokens(params: {
  sessionId: string
  messages: Message[]
  agent: AgentRow
  userId: string
  assignedSubagents: any[]
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
    eventFetch: params.eventFetch
  })

  return {
    tokens: compiled.tokens,
    budget: compiled.budget,
    trimmedMessageIds,
    trimmedMessageCount: trimmedMessageIds.length
  }
}
