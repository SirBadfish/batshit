import type { Agent } from '$lib/stores/agents.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type {
  ExecutionSnapshot,
  ExecutionTokenUsage
} from '$lib/types/executionViewer'
import { countMessageTokens, countTotalTokens } from '$lib/utils/tokenCounter'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

export const CLI_WRAPPER_OVERHEAD_TOKENS = 17_000
const MANUAL_TRIM_NOTICE_ID = 'batshit_manual_context_trim_notice'

export interface ManualTrimProtections {
  protectedUnzippedZipIds?: string[]
  userUnzippedZipIds?: string[]
  activeClipIds?: string[]
}

export interface ManualTrimOptions {
  protections?: ManualTrimProtections
  maxNewMessages?: number
}

export interface ManualTrimNoticeOptions {
  sessionId?: string
  userId?: string
  trimmedMessageCount: number
  totalTrimmedMessageCount?: number
  createdAt?: string
}

function normalize(value?: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}

function splitDeveloperModel(value?: string | null): { developerId: string; modelId: string } | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed.includes('/')) return null
  const [developerId, ...rest] = trimmed.split('/')
  const modelId = rest.join('/').trim()
  if (!developerId.trim() || !modelId) return null
  return {
    developerId: developerId.trim(),
    modelId
  }
}

export function resolveAgentPrimarySavedModel(
  agent: Agent | null | undefined,
  models: SavedModel[]
): SavedModel | null {
  if (!agent) return null

  const presetId = agent.primary_model_preset_id?.trim()
  if (presetId) {
    const byId = models.find((model) => model.id === presetId)
    if (byId) return byId
  }

  const rawDeveloperId = agent.primary_model_provider?.trim() ?? ''
  const rawModelId = agent.primary_model_name?.trim() ?? ''
  if (!rawDeveloperId && !rawModelId) return null

  let developerId = rawDeveloperId
  let modelId = rawModelId
  if (rawModelId.includes('/')) {
    const [parsedDeveloperId, ...rest] = rawModelId.split('/')
    const parsedModelId = rest.join('/').trim()
    if (!developerId && parsedDeveloperId.trim()) developerId = parsedDeveloperId.trim()
    if (parsedModelId) modelId = parsedModelId
  }

  let matches = models.filter((model) => model.provider === developerId && model.modelId === modelId)
  if (!matches.length) return null

  const agentConnection = agent.primary_model_connection ?? null
  if (agentConnection) {
    const refined = matches.filter((model) => {
      const connection = resolveSavedModelConnection(model)
      if (connection.type !== agentConnection.type) return false
      if (agentConnection.service && connection.service !== agentConnection.service) return false
      return true
    })
    if (refined.length) matches = refined
  }

  return matches[0] ?? null
}

export function extendTrimmedMessageIds(
  messages: Message[],
  trimmedIds: string[],
  tokensToTrim: number,
  options: ManualTrimOptions = {}
): string[] {
  if (tokensToTrim <= 0 || messages.length <= 1) return trimmedIds

  const trimmedSet = new Set(trimmedIds)
  let accumulated = 0
  let addedMessages = 0
  const nextIds = [...trimmedIds]

  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]
    if (!message?.id || trimmedSet.has(message.id)) continue
    if (isMessageProtectedFromManualTrim(message, options.protections)) continue

    accumulated += countMessageTokens(message)
    trimmedSet.add(message.id)
    nextIds.push(message.id)
    addedMessages += 1

    if (accumulated >= tokensToTrim) break
    if (options.maxNewMessages && addedMessages >= options.maxNewMessages) break
  }

  return nextIds
}

function extractReferenceIds(content: string, type: 'zip' | 'clip'): string[] {
  if (!content) return []
  const pattern =
    type === 'zip'
      ? /\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/g
      : /\{\{batshit-clip:([^:}]+)(?::::[^}]*)?\}\}/g
  const ids = new Set<string>()
  for (const match of content.matchAll(pattern)) {
    const id = match[1]?.trim()
    if (id) ids.add(id)
  }
  return Array.from(ids)
}

function normalizeIdSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )
}

export function isMessageProtectedFromManualTrim(
  message: Message,
  protections: ManualTrimProtections = {}
): boolean {
  const content = message?.content ?? ''
  const protectedZipIds = normalizeIdSet([
    ...(protections.protectedUnzippedZipIds ?? []),
    ...(protections.userUnzippedZipIds ?? [])
  ])
  if (protectedZipIds.size > 0) {
    const zipIds = new Set([
      ...extractReferenceIds(content, 'zip'),
      ...((Array.isArray(message?.metadata?.zipIds) ? message.metadata.zipIds : []) as string[])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    ])
    for (const zipId of zipIds) {
      if (protectedZipIds.has(zipId)) return true
    }
  }

  const activeClipIds = normalizeIdSet(protections.activeClipIds)
  if (activeClipIds.size > 0) {
    for (const clipId of extractReferenceIds(content, 'clip')) {
      if (activeClipIds.has(clipId)) return true
    }
  }

  return false
}

export function countProtectedManualTrimCandidates(
  messages: Message[],
  protections: ManualTrimProtections = {}
): number {
  if (messages.length <= 1) return 0
  return messages
    .slice(0, -1)
    .filter((message) => isMessageProtectedFromManualTrim(message, protections)).length
}

export function buildManualTrimNoticeContent(options: {
  trimmedMessageCount: number
  totalTrimmedMessageCount?: number
}): string {
  const trimmedCount = Math.max(0, Math.round(options.trimmedMessageCount))
  const totalCount = Math.max(
    trimmedCount,
    Math.round(options.totalTrimmedMessageCount ?? trimmedCount)
  )
  const messageWord = totalCount === 1 ? 'message has' : 'messages have'

  return [
    'Manual context trim notice:',
    `The user used Batshit's manual Trim 50k feature to open room in the context window. ${totalCount} older chat ${messageWord} been intentionally omitted from the model-facing context for this request.`,
    'Those messages still exist in the visible chat and can be restored with Reset Trim. Do not treat the omission as an error or assume the full earlier conversation is present.'
  ].join(' ')
}

export function createManualTrimNoticeMessage(options: ManualTrimNoticeOptions): Message {
  const createdAt = options.createdAt ?? new Date().toISOString()
  return {
    id: MANUAL_TRIM_NOTICE_ID,
    session_id: options.sessionId ?? '',
    user_id: options.userId ?? '',
    role: 'system',
    content: buildManualTrimNoticeContent({
      trimmedMessageCount: options.trimmedMessageCount,
      totalTrimmedMessageCount: options.totalTrimmedMessageCount
    }),
    timestamp: createdAt,
    created_at: createdAt,
    metadata: {
      manualContextTrim: true,
      trimmedMessageCount: options.trimmedMessageCount,
      totalTrimmedMessageCount: options.totalTrimmedMessageCount ?? options.trimmedMessageCount
    }
  }
}

export function applyManualTrimToMessages(
  messages: Message[],
  trimmedIds: string[],
  options: {
    protections?: ManualTrimProtections
    sessionId?: string
    userId?: string
    createdAt?: string
  } = {}
): Message[] {
  if (!trimmedIds.length) return messages
  const trimmedSet = new Set(trimmedIds)
  const output: Message[] = []
  let insertedNotice = false
  let trimmedCount = 0
  let effectiveTrimmedCount = 0

  for (const message of messages) {
    const shouldTrim =
      Boolean(message?.id) &&
      trimmedSet.has(message.id) &&
      !isMessageProtectedFromManualTrim(message, options.protections)

    if (!shouldTrim) {
      output.push(message)
      continue
    }

    trimmedCount += 1
    effectiveTrimmedCount += 1
    if (!insertedNotice) {
      output.push(
        createManualTrimNoticeMessage({
          sessionId: options.sessionId ?? message.session_id,
          userId: options.userId ?? message.user_id,
          trimmedMessageCount: effectiveTrimmedCount,
          totalTrimmedMessageCount: trimmedIds.length,
          createdAt: options.createdAt ?? message.created_at ?? message.timestamp
        })
      )
      insertedNotice = true
    }
  }

  if (insertedNotice) {
    const notice = output.find((message) => message.id === MANUAL_TRIM_NOTICE_ID)
    if (notice) {
      notice.content = buildManualTrimNoticeContent({
        trimmedMessageCount: trimmedCount,
        totalTrimmedMessageCount: trimmedCount
      })
      notice.metadata = {
        ...(notice.metadata ?? {}),
        trimmedMessageCount: trimmedCount,
        totalTrimmedMessageCount: trimmedCount
      }
    }
  }

  return output
}

export function filterTrimmedMessages(messages: Message[], trimmedIds: string[]): Message[] {
  if (!trimmedIds.length) return messages
  const trimmedSet = new Set(trimmedIds)
  return messages.filter((message) => !trimmedSet.has(message.id))
}

export function calculateTrimmedTokens(messages: Message[], trimmedIds: string[]): number {
  if (!trimmedIds.length) return 0
  const trimmedSet = new Set(trimmedIds)
  return messages.reduce((total, message) => {
    if (!trimmedSet.has(message.id)) return total
    return total + countMessageTokens(message)
  }, 0)
}

function resolveUsage(snapshot: ExecutionSnapshot): ExecutionTokenUsage | null {
  const responseUsage = snapshot.responseSummary?.usage
  if (
    responseUsage &&
    (responseUsage.inputTokens?.value !== null || responseUsage.outputTokens?.value !== null)
  ) {
    return responseUsage
  }

  const totalUsage = snapshot.llmSummary?.totalUsage
  if (
    totalUsage &&
    (totalUsage.inputTokens?.value !== null || totalUsage.outputTokens?.value !== null)
  ) {
    return totalUsage
  }

  return null
}

type ContextUsageKind = 'single-request' | 'peak-tool-loop-call'
type ContextUsageConfidence = 'exact' | 'near'

interface ContextUsageCandidate {
  snapshot: ExecutionSnapshot
  usage: ExecutionTokenUsage
  inputTokens: number
  confidence: ContextUsageConfidence
  source: string
  kind: ContextUsageKind
  callsCount: number
  aggregateInputTokens: number | null
}

function readTokenStatValue(stat: { value?: number | null } | null | undefined): number | null {
  return typeof stat?.value === 'number' && Number.isFinite(stat.value)
    ? stat.value
    : null
}

function readCallsCount(snapshot: ExecutionSnapshot): number {
  const llmCallsCount = Array.isArray(snapshot.llmCalls) ? snapshot.llmCalls.length : 0
  const summaryCallsCount = readTokenStatValue(snapshot.llmSummary?.callsCount)
  return Math.max(llmCallsCount, summaryCallsCount ?? 0)
}

function isCliRuntimeSnapshot(snapshot: ExecutionSnapshot): boolean {
  const runtimeId = normalize(snapshot.runtime?.runtimeId)
  const agentType = normalize(snapshot.agentType)
  return runtimeId === 'codex' || runtimeId === 'claude' || agentType === 'cli'
}

function hasCliToolActivity(snapshot: ExecutionSnapshot): boolean {
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

function resolveContextUsage(snapshot: ExecutionSnapshot): ContextUsageCandidate | null {
  const runUsage = resolveUsage(snapshot)
  const runInputTokens = readTokenStatValue(runUsage?.inputTokens)
  const callsCount = readCallsCount(snapshot)
  const llmCalls = Array.isArray(snapshot.llmCalls) ? snapshot.llmCalls : []

  const callInputs = llmCalls
    .map((call, index) => {
      const tokens = readTokenStatValue(call?.usage?.inputTokens)
      if (tokens === null) return null
      return {
        call,
        index: typeof call?.index === 'number' ? call.index : index + 1,
        tokens
      }
    })
    .filter(
      (entry): entry is {
        call: NonNullable<ExecutionSnapshot['llmCalls']>[number]
        index: number
        tokens: number
      } => Boolean(entry)
    )

  const cliAggregateOnly =
    isCliRuntimeSnapshot(snapshot) &&
    hasCliToolActivity(snapshot) &&
    callInputs.length <= 1
  if (cliAggregateOnly) {
    return null
  }

  if (callsCount > 1) {
    if (callInputs.length === 0) return null

    const peak = callInputs.reduce((best, entry) =>
      entry.tokens > best.tokens ? entry : best
    )
    const usage = peak.call.usage
    const confidence = usage.inputTokens?.confidence === 'exact' ? 'exact' : 'near'
    const sourceBase =
      usage.inputTokens?.source ?? snapshot.runtime?.runtimeId ?? 'execution viewer'

    return {
      snapshot,
      usage,
      inputTokens: peak.tokens,
      confidence,
      source: `${sourceBase} call ${peak.index}`,
      kind: 'peak-tool-loop-call',
      callsCount,
      aggregateInputTokens: runInputTokens
    }
  }

  if (runUsage && runInputTokens !== null) {
    return {
      snapshot,
      usage: runUsage,
      inputTokens: runInputTokens,
      confidence: runUsage.inputTokens?.confidence === 'exact' ? 'exact' : 'near',
      source:
        runUsage.inputTokens?.source ?? snapshot.runtime?.runtimeId ?? 'execution viewer',
      kind: 'single-request',
      callsCount: Math.max(1, callsCount),
      aggregateInputTokens: null
    }
  }

  if (callInputs.length > 0) {
    const call = callInputs[callInputs.length - 1]
    const usage = call.call.usage
    return {
      snapshot,
      usage,
      inputTokens: call.tokens,
      confidence: usage.inputTokens?.confidence === 'exact' ? 'exact' : 'near',
      source:
        usage.inputTokens?.source ?? snapshot.runtime?.runtimeId ?? 'execution viewer',
      kind: 'single-request',
      callsCount: Math.max(1, callsCount),
      aggregateInputTokens: runInputTokens
    }
  }

  return null
}

function getFlatPrice(value: SavedModel['pricing']['input'] | SavedModel['pricing']['output']): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function buildRuntimeSignals(
  snapshot: ExecutionSnapshot,
  activeModel: SavedModel,
  agent: Agent | null | undefined
) {
  const runtime = snapshot.runtime
  const currentConnection = resolveSavedModelConnection(activeModel)
  const parsedCurrentModel = splitDeveloperModel(agent?.primary_model_name ?? activeModel.modelId)
  const currentModelId = normalize(parsedCurrentModel?.modelId ?? activeModel.modelId)
  const currentDeveloperId = normalize(parsedCurrentModel?.developerId ?? activeModel.provider)
  const currentConnectionService = normalize(currentConnection.service ?? '')

  const runtimeModel = normalize(runtime?.modelName)
  const runtimeProvider = normalize(runtime?.providerId)
  const runtimeConnection = normalize(runtime?.connectionId)

  return {
    missingRuntimeIdentity: !runtimeModel && !runtimeProvider && !runtimeConnection,
    sameModel: !runtimeModel || runtimeModel === currentModelId,
    sameProvider:
      !runtimeProvider ||
      runtimeProvider === currentDeveloperId ||
      runtimeProvider === currentConnectionService,
    sameConnection: !runtimeConnection || runtimeConnection === currentConnectionService
  }
}

export type RunningCostState = 'exact' | 'estimated' | 'unknown'

export interface RunningCostSummary {
  cost: number | null
  state: RunningCostState
  note: string
}

export type ContextUsageState = 'exact' | 'near' | 'estimated' | 'unknown'

export interface ContextUsageSummary {
  displayTokens: number | null
  contextLimit: number | null
  contextPercent: number | null
  visibleEstimateTokens: number
  compiledEstimateTokens: number | null
  batshitEstimateTokens: number
  cliWrapperOverheadTokens: number
  lastInputTokens: number | null
  lastReasoningTokens: number | null
  lastUsageSource: string | null
  state: ContextUsageState
  label: string
  detail: string
  trimAvailable: boolean
  trimUnavailableReason: string
}

function formatCompactTokens(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return 'Unknown'
  const safeValue = Math.max(0, Math.round(value as number))
  if (safeValue < 1000) return `${safeValue}`
  const roundedThousands = Math.round(safeValue / 1000)
  if (roundedThousands < 1000) return `${roundedThousands}K`
  const roundedMillions = Math.round((safeValue / 1_000_000) * 10) / 10
  return `${roundedMillions.toFixed(Number.isInteger(roundedMillions) ? 0 : 1)}M`
}

function sortSnapshotsNewestFirst(snapshots: ExecutionSnapshot[]): ExecutionSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const aTime = Date.parse(a.createdAt)
    const bTime = Date.parse(b.createdAt)
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
  })
}

function countCompiledPayloadTokens(snapshot: ExecutionSnapshot | null | undefined): number | null {
  const compiledMessages = snapshot?.compiledMessages
  if (!Array.isArray(compiledMessages) || compiledMessages.length === 0) return null

  return countTotalTokens(
    compiledMessages.map((message) => ({
      role: typeof message?.role === 'string' ? message.role : 'user',
      content: message?.content,
    }))
  )
}

function findLatestUsageSnapshot(
  snapshots: ExecutionSnapshot[],
  agent: Agent | null | undefined
): ContextUsageCandidate | null {
  const sorted = sortSnapshotsNewestFirst(snapshots)
  const preferred = agent?.id
    ? sorted.find((snapshot) => snapshot.agentId === agent.id)
    : null
  const fallback = preferred ?? sorted[0] ?? null
  return fallback ? resolveContextUsage(fallback) : null
}

function findLatestCompiledSnapshot(
  snapshots: ExecutionSnapshot[],
  agent: Agent | null | undefined
): ExecutionSnapshot | null {
  const sorted = sortSnapshotsNewestFirst(snapshots)
  const hasCompiledPayload = (snapshot: ExecutionSnapshot) =>
    Array.isArray(snapshot.compiledMessages) && snapshot.compiledMessages.length > 0
  const preferred = agent?.id
    ? sorted.find((snapshot) => snapshot.agentId === agent.id && hasCompiledPayload(snapshot))
    : null
  return preferred ?? sorted.find(hasCompiledPayload) ?? null
}

function resolveReserveTokens(activeModel: SavedModel | null): number | null {
  const maxTokens = activeModel?.settings?.maxTokens
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.round(maxTokens)
  }

  const enrichmentMaxOutput = activeModel?.enrichment?.maxOutputTokens
  if (
    typeof enrichmentMaxOutput === 'number' &&
    Number.isFinite(enrichmentMaxOutput) &&
    enrichmentMaxOutput > 0
  ) {
    return Math.round(enrichmentMaxOutput)
  }

  if (activeModel?.capabilities?.reasoning) {
    return 25_000
  }

  return null
}

function clampPercent(tokens: number | null, contextLimit: number | null): number | null {
  if (tokens === null || !contextLimit || contextLimit <= 0) return null
  return Math.max(0, Math.min((tokens / contextLimit) * 100, 100))
}

export function summarizeContextUsage(params: {
  messages: Message[]
  snapshots: ExecutionSnapshot[]
  activeModel: SavedModel | null
  agent: Agent | null | undefined
  manualTrimActive?: boolean
  manualTrimEstimateTokens?: number | null
  liveContextEstimateTokens?: number | null
  liveContextEstimateReason?: string | null
}): ContextUsageSummary {
  const { messages, snapshots, activeModel, agent } = params
  const contextLimit = activeModel?.contextWindow ?? null
  const agentType = normalizePrimaryAgentType(agent)
  const cliWrapperOverheadTokens = agentType === 'cli' ? CLI_WRAPPER_OVERHEAD_TOKENS : 0
  const visibleEstimateTokens = countTotalTokens(messages)
  const latestCompiledSnapshot = findLatestCompiledSnapshot(snapshots, agent)
  const compiledEstimateTokens = countCompiledPayloadTokens(latestCompiledSnapshot)
  const batshitEstimateTokens = visibleEstimateTokens + cliWrapperOverheadTokens
  const latest = findLatestUsageSnapshot(snapshots, agent)
  const latestInput = latest?.usage.inputTokens ?? null
  const latestInputTokens = latest?.inputTokens ?? null
  const latestReasoning = latest?.usage.reasoningTokens ?? null
  const latestReasoningTokens =
    typeof latestReasoning?.value === 'number' && Number.isFinite(latestReasoning.value)
      ? latestReasoning.value
      : null
  const reserveTokens = resolveReserveTokens(activeModel)
  const reserveNote =
    reserveTokens !== null
      ? ` Batshit also keeps ${formatCompactTokens(reserveTokens)} tokens in mind for output/reasoning headroom when warning near the edge.`
      : ''
  const liveContextEstimateTokens =
    typeof params.liveContextEstimateTokens === 'number' &&
    Number.isFinite(params.liveContextEstimateTokens)
      ? Math.max(0, Math.round(params.liveContextEstimateTokens))
      : null
  const liveContextEstimateReason =
    typeof params.liveContextEstimateReason === 'string' && params.liveContextEstimateReason.trim()
      ? params.liveContextEstimateReason.trim()
      : 'context controls'
  const liveEstimateIsSavedResponse = liveContextEstimateReason === 'the saved response'

  const trimUnavailableReason =
    messages.length <= 1
      ? 'Manual trim needs older messages before it has anything safe to exclude.'
      : 'Manual trim is unavailable for this chat state.'

  if (params.manualTrimActive) {
    const manualTrimEstimateTokens =
      liveContextEstimateTokens ??
      (typeof params.manualTrimEstimateTokens === 'number' &&
      Number.isFinite(params.manualTrimEstimateTokens)
        ? Math.max(0, Math.round(params.manualTrimEstimateTokens))
        : batshitEstimateTokens)
    const liveEstimateNote =
      liveContextEstimateTokens !== null
        ? ` This is a live compiled estimate after ${liveContextEstimateReason} changed since the last send.`
        : ''

    return {
      displayTokens: manualTrimEstimateTokens,
      contextLimit,
      contextPercent: clampPercent(manualTrimEstimateTokens, contextLimit),
      visibleEstimateTokens,
      compiledEstimateTokens,
      batshitEstimateTokens,
      cliWrapperOverheadTokens,
      lastInputTokens: latestInputTokens,
      lastReasoningTokens: latestReasoningTokens,
      lastUsageSource: latest?.source ?? latest?.snapshot.runtime?.runtimeId ?? null,
      state: 'estimated',
      label: `~${formatCompactTokens(manualTrimEstimateTokens)} trimmed`,
      detail: `Manual trim is active, so the meter is showing the post-trim send estimate instead of the older untrimmed runtime total.${liveEstimateNote} The next Execution Viewer snapshot will replace this with the actual sent payload and any runtime-reported usage.${reserveNote}`,
      trimAvailable: true,
      trimUnavailableReason
    }
  }

  if (liveContextEstimateTokens !== null && !liveEstimateIsSavedResponse) {
    return {
      displayTokens: liveContextEstimateTokens,
      contextLimit,
      contextPercent: clampPercent(liveContextEstimateTokens, contextLimit),
      visibleEstimateTokens,
      compiledEstimateTokens,
      batshitEstimateTokens,
      cliWrapperOverheadTokens,
      lastInputTokens: latestInputTokens,
      lastReasoningTokens: latestReasoningTokens,
      lastUsageSource: latest?.source ?? latest?.snapshot.runtime?.runtimeId ?? null,
      state: 'estimated',
      label: `~${formatCompactTokens(liveContextEstimateTokens)} live`,
      detail: `Context meter is showing a live compiled estimate after ${liveContextEstimateReason} changed since the last send. It uses the same zip-aware context compiler as sends, then the next Execution Viewer snapshot will replace it with actual runtime usage.${reserveNote}`,
      trimAvailable: messages.length > 1,
      trimUnavailableReason
    }
  }

  if (latestInputTokens !== null) {
    const confidence = latest?.confidence ?? (latestInput?.confidence === 'exact' ? 'exact' : 'near')
    const source = latest?.source ?? latestInput?.source ?? latest?.snapshot.runtime?.runtimeId ?? 'execution viewer'
    const cliNote =
      agentType === 'cli'
        ? ` CLI wrapper overhead is already included when the CLI reports input usage; the ${formatCompactTokens(
            CLI_WRAPPER_OVERHEAD_TOKENS
          )} wrapper reserve is used only before runtime usage exists.`
        : ''
    const reasoningNote =
      latestReasoningTokens !== null
        ? ` The last run reported ${formatCompactTokens(latestReasoningTokens)} reasoning tokens.`
        : activeModel?.capabilities?.reasoning
          ? ' Current-turn reasoning tokens are not knowable until the provider/runtime reports usage.'
          : ''
    const toolLoopNote =
      latest?.kind === 'peak-tool-loop-call'
        ? ` This run used ${latest.callsCount} internal model calls. The meter shows the largest single-call input because that is the context-window pressure; the provider also reported ${formatCompactTokens(
            latest.aggregateInputTokens
          )} aggregate input tokens across the whole loop for cost/accounting.`
        : ''
    const label =
      latest?.kind === 'peak-tool-loop-call'
        ? `${formatCompactTokens(latestInputTokens)} peak call`
        : `${formatCompactTokens(latestInputTokens)} last sent`
    const sourceDescription =
      latest?.kind === 'peak-tool-loop-call'
        ? `the largest single model call in the latest provider/runtime tool loop (${source})`
        : `the latest provider/runtime input-token usage captured by Execution Viewer (${source})`

    return {
      displayTokens: latestInputTokens,
      contextLimit,
      contextPercent: clampPercent(latestInputTokens, contextLimit),
      visibleEstimateTokens,
      compiledEstimateTokens,
      batshitEstimateTokens,
      cliWrapperOverheadTokens,
      lastInputTokens: latestInputTokens,
      lastReasoningTokens: latestReasoningTokens,
      lastUsageSource: source,
      state: confidence,
      label,
      detail: `Context meter is based on ${sourceDescription}. That is the post-zip/post-compile number for context-window pressure as the runtime reported it.${toolLoopNote} The compiled payload estimate is ${
        compiledEstimateTokens === null ? 'unavailable' : formatCompactTokens(compiledEstimateTokens)
      }; visible chat alone estimates ${formatCompactTokens(
        visibleEstimateTokens
      )}; Batshit send estimates include system prompts, DCM/tool context, clips/zips, and runtime packaging when known.${cliNote}${reasoningNote}${reserveNote}`,
      trimAvailable: messages.length > 1,
      trimUnavailableReason
    }
  }

  if (liveContextEstimateTokens !== null) {
    return {
      displayTokens: liveContextEstimateTokens,
      contextLimit,
      contextPercent: clampPercent(liveContextEstimateTokens, contextLimit),
      visibleEstimateTokens,
      compiledEstimateTokens,
      batshitEstimateTokens,
      cliWrapperOverheadTokens,
      lastInputTokens: latestInputTokens,
      lastReasoningTokens: latestReasoningTokens,
      lastUsageSource: latest?.source ?? latest?.snapshot.runtime?.runtimeId ?? null,
      state: 'estimated',
      label: `~${formatCompactTokens(liveContextEstimateTokens)} live`,
      detail: `Context meter is showing a live compiled estimate after ${liveContextEstimateReason} changed since the last send. It uses the same zip-aware context compiler as sends, then the next Execution Viewer snapshot will replace it with actual runtime usage.${reserveNote}`,
      trimAvailable: messages.length > 1,
      trimUnavailableReason
    }
  }

  if (!contextLimit || contextLimit <= 0) {
    return {
      displayTokens: null,
      contextLimit,
      contextPercent: null,
      visibleEstimateTokens,
      compiledEstimateTokens,
      batshitEstimateTokens,
      cliWrapperOverheadTokens,
      lastInputTokens: null,
      lastReasoningTokens: null,
      lastUsageSource: null,
      state: 'unknown',
      label: 'Unknown',
      detail:
        'Context usage is unavailable because this agent does not have a known model context window yet.',
      trimAvailable: messages.length > 1,
      trimUnavailableReason
    }
  }

  if (compiledEstimateTokens !== null) {
    const compiledRuntime = latestCompiledSnapshot?.runtime?.runtimeId ?? 'execution viewer'
    const cliNote =
      agentType === 'cli'
        ? ` The ${formatCompactTokens(
            CLI_WRAPPER_OVERHEAD_TOKENS
          )} CLI wrapper reserve is added only to pre-send estimates; this compiled snapshot is the Batshit-owned payload before the CLI adds runtime-owned instructions.`
        : ''
    const reasoningEstimateNote = activeModel?.capabilities?.reasoning
      ? ' Current-turn hidden reasoning cannot be known before the run, so Batshit shows reported reasoning tokens after completion when the provider/runtime exposes them.'
      : ''

    return {
      displayTokens: compiledEstimateTokens,
      contextLimit,
      contextPercent: clampPercent(compiledEstimateTokens, contextLimit),
      visibleEstimateTokens,
      compiledEstimateTokens,
      batshitEstimateTokens,
      cliWrapperOverheadTokens,
      lastInputTokens: null,
      lastReasoningTokens: null,
      lastUsageSource: compiledRuntime,
      state: 'estimated',
      label: `~${formatCompactTokens(compiledEstimateTokens)} compiled`,
      detail: `Provider/runtime token usage is not available for the latest run, so the meter is estimated from the actual compiled messages saved in Execution Viewer after zip decisions were applied. Visible chat alone estimates ${formatCompactTokens(
        visibleEstimateTokens
      )}.${cliNote}${reasoningEstimateNote}${reserveNote}`,
      trimAvailable: messages.length > 1,
      trimUnavailableReason
    }
  }

  const cliEstimateNote =
    cliWrapperOverheadTokens > 0
      ? ` This estimate includes a ${formatCompactTokens(
          cliWrapperOverheadTokens
        )} CLI wrapper reserve for Codex/Claude Code instructions; it will be replaced by runtime-reported usage after a send.`
      : ''
  const reasoningEstimateNote = activeModel?.capabilities?.reasoning
    ? ' Current-turn hidden reasoning cannot be known before the run, so Batshit reserves headroom and shows reported reasoning tokens after completion.'
    : ''

  return {
    displayTokens: batshitEstimateTokens,
    contextLimit,
    contextPercent: clampPercent(batshitEstimateTokens, contextLimit),
    visibleEstimateTokens,
    compiledEstimateTokens,
    batshitEstimateTokens,
    cliWrapperOverheadTokens,
    lastInputTokens: null,
    lastReasoningTokens: null,
    lastUsageSource: null,
    state: 'estimated',
    label: `~${formatCompactTokens(batshitEstimateTokens)} estimated`,
    detail: `No completed compiled payload or runtime usage is available for this chat yet. The meter is only a pre-send estimate, so it is labeled as estimated until the next send records the actual post-zip payload.${cliEstimateNote}${reasoningEstimateNote}${reserveNote}`,
    trimAvailable: messages.length > 1,
    trimUnavailableReason
  }
}

export function summarizeRunningCost(
  snapshots: ExecutionSnapshot[],
  activeModel: SavedModel | null,
  agent: Agent | null | undefined
): RunningCostSummary {
  if (!activeModel) {
    return {
      cost: null,
      state: 'unknown',
      note: 'Model pricing is unavailable for this agent.'
    }
  }

  const inputPrice = getFlatPrice(activeModel.pricing.input)
  const outputPrice = getFlatPrice(activeModel.pricing.output)
  const cachedInputPrice =
    typeof activeModel.pricing.cachedInput === 'number' && Number.isFinite(activeModel.pricing.cachedInput)
      ? activeModel.pricing.cachedInput
      : null

  if (inputPrice === null || outputPrice === null) {
    return {
      cost: null,
      state: 'unknown',
      note: 'Cost is unavailable because this model uses pricing data Batshit cannot flatten into a truthful per-run number yet.'
    }
  }

  let total = 0
  let hasUsage = false
  let estimated = false

  for (const snapshot of snapshots) {
    const usage = resolveUsage(snapshot)
    if (!usage) continue

    const rawInputTokens = usage.inputTokens?.value
    const rawOutputTokens = usage.outputTokens?.value
    if (!Number.isFinite(rawInputTokens) || !Number.isFinite(rawOutputTokens)) continue

    const inputTokens = rawInputTokens as number
    const outputTokens = rawOutputTokens as number

    hasUsage = true

    const rawCachedInputTokens = usage.cachedInputTokens?.value
    if (Number.isFinite(rawCachedInputTokens) && (rawCachedInputTokens as number) > 0) {
      const cachedInputTokens = rawCachedInputTokens as number
      if (cachedInputPrice === null) {
        estimated = true
      }
      const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)
      total += (uncachedInputTokens / 1_000_000) * inputPrice
      total +=
        (cachedInputTokens / 1_000_000) * (cachedInputPrice ?? inputPrice)
    } else {
      total += (inputTokens / 1_000_000) * inputPrice
    }

    total += (outputTokens / 1_000_000) * outputPrice

    const runtimeSignals = buildRuntimeSignals(snapshot, activeModel, agent)
    if (
      runtimeSignals.missingRuntimeIdentity ||
      !runtimeSignals.sameModel ||
      !runtimeSignals.sameProvider ||
      !runtimeSignals.sameConnection
    ) {
      estimated = true
    }
  }

  if (!hasUsage) {
    return {
      cost: 0,
      state: 'exact',
      note: 'No completed runs yet for this chat.'
    }
  }

  if (estimated) {
    return {
      cost: total,
      state: 'estimated',
      note: 'Running cost uses the current model pricing plus stored run usage. Mixed models or missing runtime identity make this an estimate.'
    }
  }

  return {
    cost: total,
    state: 'exact',
    note: 'Running cost is based on stored run usage and the current model pricing.'
  }
}
