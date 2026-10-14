import type { LocalContextBudgetEvidence } from '$lib/types/localContextBudget'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
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
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import {
  cliContextSettingsKey, latestCliContextReport, latestCliContextSnapshot, matchingCliContextReport,
  resolveEffectiveAgentCliModel, resolveCliContextWindow,
  type CliContextRuntime
} from '$lib/utils/cliContextWindow'
import { claudeContextCappedByFlags, type ClaudeContextEnvironment } from '$lib/utils/cliContextWindow'
import { scanLooseClipReferences, scanLooseZipReferences } from '$lib/utils/zipReferenceSafety'

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

/**
 * The zip or clip ids a message's words reference (the older shape), read once (BL-707): the old
 * patterns searched to the first `}` again from every opener. The server runs this in the trim
 * preview, the context preview, and memory graduation.
 */
function extractReferenceIds(content: string, type: 'zip' | 'clip'): string[] {
  if (!content) return []
  const references = type === 'zip' ? scanLooseZipReferences(content) : scanLooseClipReferences(content)
  const ids = new Set<string>()
  for (const reference of references) {
    const id = reference.id.trim()
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
  // Absent (undefined) and tiered prices are both unknown here; only a finite number is a price.
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

type CacheTtl = '5m' | '1h'

/**
 * BL-184: what a cache WRITE costs, as a multiple of the model's input price. Anthropic bills
 * a write at 1.25x for its 5-minute cache and 2x for its 1-hour cache (platform.claude.com
 * pricing, 2026-09-25), and every lane that serves a Claude model passes that on: direct
 * Anthropic, OpenRouter, Vercel AI Gateway, Bedrock, and Vertex.
 */
const ANTHROPIC_CACHE_WRITE_MULTIPLIERS: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 }

const ANTHROPIC_BILLED_PROVIDER_IDS = new Set(['anthropic', 'anthropic-claude-cli', 'claude-cli'])

function isAnthropicBilledModel(modelId: string | null | undefined, providerId: string | null | undefined): boolean {
  return normalize(modelId).includes('claude') || ANTHROPIC_BILLED_PROVIDER_IDS.has(normalize(providerId))
}

function readCacheTtl(value: unknown): CacheTtl | null {
  return value === '5m' || value === '1h' ? value : null
}

/** The one lifetime Batshit's cache policy recorded for an API run (`apiPromptCachePolicy.ts`). */
function readSnapshotCacheTtl(snapshot: ExecutionSnapshot): CacheTtl | null {
  return readCacheTtl(snapshot.runtime?.metadata?.promptCachePolicy?.cacheTtl)
}

interface CacheWriteRate {
  multiplier: number
  /** False when Batshit cannot vouch for the multiplier; the cost is then an estimate. */
  known: boolean
}

/**
 * A Claude model's write costs its cache lifetime's multiplier; an unknown lifetime is priced
 * at the lower (5-minute) one and marked unknown. Any other provider's write price is not
 * something Batshit knows (OpenRouter lists 1x, 1.25x, or input plus storage, by provider), so
 * it is priced at the input price and marked unknown.
 */
function resolveCacheWriteRate(anthropicBilled: boolean, ttl: CacheTtl | null): CacheWriteRate {
  if (!anthropicBilled) return { multiplier: 1, known: false }
  if (ttl) return { multiplier: ANTHROPIC_CACHE_WRITE_MULTIPLIERS[ttl], known: true }
  return { multiplier: ANTHROPIC_CACHE_WRITE_MULTIPLIERS['5m'], known: false }
}

interface PricedInput {
  cost: number
  /** Cache reads were priced at the input price because the model has no cached-input price. */
  cachedPriceUnknown: boolean
  /** Cache writes were priced at a rate Batshit cannot vouch for (see `resolveCacheWriteRate`). */
  writePriceUnknown: boolean
}

/**
 * Prices one run's input: fresh tokens at the input price, cache reads at the cached-input
 * price, and cache writes at the write rate. Every lane reports `inputTokens` as the WHOLE
 * prompt (fresh + cache read + cache write; `execution-viewer.md` → API Evidence), so the
 * fresh part is what remains after both. A price of zero stays exactly zero whatever the rate.
 */
function priceRunInput(args: {
  inputTokens: number
  cachedInputTokens: number | null | undefined
  cacheWriteTokens: number | null | undefined
  inputPrice: number
  cachedInputPrice: number | null
  writeRate: () => CacheWriteRate
}): PricedInput {
  const cached =
    typeof args.cachedInputTokens === 'number' && Number.isFinite(args.cachedInputTokens) && args.cachedInputTokens > 0
      ? args.cachedInputTokens
      : 0
  const written =
    typeof args.cacheWriteTokens === 'number' && Number.isFinite(args.cacheWriteTokens) && args.cacheWriteTokens > 0
      ? args.cacheWriteTokens
      : 0
  const fresh = Math.max(0, args.inputTokens - cached - written)

  let cachedPriceUnknown = false
  let writePriceUnknown = false
  let cost = (fresh / 1_000_000) * args.inputPrice
  if (cached > 0) {
    // A price of zero stays an exact zero, for reads as for writes.
    if (args.cachedInputPrice === null && args.inputPrice !== 0) cachedPriceUnknown = true
    cost += (cached / 1_000_000) * (args.cachedInputPrice ?? args.inputPrice)
  }
  if (written > 0) {
    const rate = args.writeRate()
    if (!rate.known && args.inputPrice !== 0) writePriceUnknown = true
    cost += (written / 1_000_000) * args.inputPrice * rate.multiplier
  }
  return { cost, cachedPriceUnknown, writePriceUnknown }
}

/** A model id without its developer prefix: `anthropic/claude-sonnet-5` is `claude-sonnet-5`. */
function modelKey(value?: string | null): string {
  const normalized = normalize(value)
  return splitDeveloperModel(normalized)?.modelId ?? normalized
}

/** A connection id without the `direct:` prefix: a direct preset's id is `direct:<service>`. */
function connectionKey(value?: string | null): string {
  const normalized = normalize(value)
  return normalized.startsWith('direct:') ? normalized.slice('direct:'.length) : normalized
}

/**
 * Does this run match the active preset? A run records the id of the request's connection
 * (`direct:anthropic`, `openrouter`) and the model id it sent (`anthropic/claude-sonnet-5` on
 * OpenRouter), so both sides are compared without the `direct:` and developer prefixes. Until
 * 2026-09-25 (bug batch, new find 2) the connection id was compared with the service name and
 * the prefixed model id with the bare one, so every direct and every OpenRouter run read as an
 * estimate.
 */
function buildRuntimeSignals(
  snapshot: ExecutionSnapshot,
  activeModel: SavedModel,
  agent: Agent | null | undefined
) {
  const runtime = snapshot.runtime
  const currentConnection = resolveSavedModelConnection(activeModel)
  const parsedCurrentModel = splitDeveloperModel(agent?.primary_model_name ?? activeModel.modelId)
  const currentDeveloperId = normalize(parsedCurrentModel?.developerId ?? activeModel.provider)
  const currentConnectionService = normalize(currentConnection.service ?? '')
  const currentModelKeys = new Set(
    [agent?.primary_model_name, activeModel.modelId, activeModel.effectiveModelId]
      .map(modelKey)
      .filter(Boolean)
  )
  const currentConnectionKeys = new Set(
    [
      currentConnection.id,
      currentConnection.service,
      currentConnection.type === 'direct' ? null : currentConnection.type
    ]
      .map(connectionKey)
      .filter(Boolean)
  )

  const runtimeModel = normalize(runtime?.modelName)
  const runtimeProvider = normalize(runtime?.providerId)
  const runtimeConnection = normalize(runtime?.connectionId)

  return {
    missingRuntimeIdentity: !runtimeModel && !runtimeProvider && !runtimeConnection,
    sameModel: !runtimeModel || currentModelKeys.has(modelKey(runtimeModel)),
    sameProvider:
      !runtimeProvider ||
      runtimeProvider === currentDeveloperId ||
      runtimeProvider === currentConnectionService,
    sameConnection: !runtimeConnection || currentConnectionKeys.has(connectionKey(runtimeConnection))
  }
}

export type RunningCostState = 'exact' | 'estimated' | 'unknown'

export interface RunningCostSummary {
  cost: number | null
  state: RunningCostState
  note: string
  delegatedTokens: number | null
  delegatedCost: number | null
  delegatedRunCount: number
  delegatedUsageUnknownRuns: number
  delegatedCostUnknownRuns: number
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

function cliRuntimeAndModel(agent: Agent | null | undefined, model: SavedModel | null): {
  runtime: CliContextRuntime
  model: string | null
  selectedSettings: Record<string, any> | null
  selectedModelId: string | null
} | null {
  if (normalizePrimaryAgentType(agent) !== 'cli') return null
  const rawAgent = agent as Record<string, any>
  const service = model?.connection?.service ?? agent?.primary_model_connection?.service ??
    agent?.primary_model_provider ?? ''
  const selection = resolveRuntimeModelSelection({
    preset: model, modelId: agent?.primary_model_name,
    settings: rawAgent.provider_specific_settings ?? null
  })
  const selectedSettings = selection.settings
  const selectedModelId = selection.modelId
  if (service === 'openai-codex' || service === 'codex') {
    return { runtime: 'codex', model: resolveEffectiveAgentCliModel('codex', rawAgent, selectedSettings, selectedModelId), selectedSettings, selectedModelId }
  }
  if (service === 'anthropic-claude-cli' || service === 'claude-cli') {
    return { runtime: 'claude', model: resolveEffectiveAgentCliModel('claude', rawAgent, selectedSettings, selectedModelId), selectedSettings, selectedModelId }
  }
  return null
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
  /** Server preview knows instance-only CLI settings such as disabled 1M context. */
  liveContextLimit?: number | null
  liveLocalContext?: LocalContextBudgetEvidence | null
  now?: number
  liveContextWindowWarning?: string | null
  liveContextCheckedAt?: number | null
  claudeContextEnvironment?: ClaudeContextEnvironment | null
}): ContextUsageSummary {
  const { messages, snapshots, activeModel, agent } = params
  const cli = cliRuntimeAndModel(agent, activeModel)
  const savedReport = cli ? latestCliContextReport(snapshots, agent?.id, cli.runtime) : null
  const claudeCap = cli?.runtime === 'claude'
    ? claudeContextCappedByFlags(cli.model, params.claudeContextEnvironment) : false
  const matchedReport = cli && agent ? matchingCliContextReport(savedReport,
    cliContextSettingsKey(cli.runtime, agent as Record<string, any>, activeModel?.contextWindow,
      cli.selectedSettings, cli.selectedModelId)) : null
  const matchingReport = matchedReport && (cli?.runtime !== 'claude' ||
    Boolean(matchedReport.disableClaude1M) === claudeCap) ? matchedReport : null
  const cliResolution = cli ? resolveCliContextWindow({
    ...cli,
    presetContextWindow: activeModel?.contextWindow,
    reported: matchingReport,
    disableClaude1M: claudeCap
  }) : null
  const serverLimit = typeof params.liveContextLimit === 'number' &&
    Number.isFinite(params.liveContextLimit) && params.liveContextLimit > 0
      ? params.liveContextLimit : null
  const latestCliSnapshot = cli ? latestCliContextSnapshot(snapshots, agent?.id, cli.runtime) : null
  const savedBudget = latestCliSnapshot?.executionMetadata?.promptBudget
  const activeSettingsKey = cli && agent ? cliContextSettingsKey(cli.runtime, agent as Record<string, any>,
    activeModel?.contextWindow, cli.selectedSettings, cli.selectedModelId) : null
  const savedWarning = activeSettingsKey && savedBudget?.contextWindowSettingsKey === activeSettingsKey &&
    typeof savedBudget?.contextWindowWarning === 'string'
      ? savedBudget.contextWindowWarning.trim() : null
  const previewIsNewer = typeof params.liveContextCheckedAt === 'number' &&
    params.liveContextCheckedAt > (savedBudget?.contextWindowCheckedAt ?? Infinity)
  const newestWarningAt = Math.max(
    savedWarning ? savedBudget?.contextWindowCheckedAt ?? Infinity : 0,
    params.liveContextWindowWarning ? params.liveContextCheckedAt ?? Infinity : 0
  )
  const newerRuntimeEvidence = matchingReport?.evidence === 'runtime' &&
    typeof matchingReport.reportedAt === 'number' && matchingReport.reportedAt > newestWarningAt
  const contextWindowWarning = cli && !newerRuntimeEvidence
    ? params.liveContextWindowWarning?.trim() || (!previewIsNewer ? savedWarning : null)
    : null
  const apiSelection = resolveRuntimeModelSelection({ preset: activeModel,
    provider: agent?.primary_model_provider, modelId: agent?.primary_model_name,
    connection: agent?.primary_model_connection, settings: agent?.provider_specific_settings })
  const local = !cli && LOCAL_AI_SERVER_IDS.has(apiSelection.provider as any)
  const localEvidence = params.liveLocalContext
  const freshLocal = localEvidence && localEvidence.providerId === apiSelection.provider &&
    localEvidence.modelId === apiSelection.modelId && localEvidence.expiresAt > (params.now ?? Date.now())
      ? localEvidence : null
  const localNote = local ? freshLocal?.note ?? 'The Local AI context limit is waiting for a fresh server reading.' : ''
  const contextLimit = contextWindowWarning || (cli && matchingReport?.evidence === 'unresolved')
    ? null
    : cli ? (serverLimit ?? cliResolution?.contextWindow ?? null)
      : local ? (freshLocal ? serverLimit : null) : activeModel?.contextWindow ?? null
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
    (reserveTokens !== null
      ? ` Batshit also keeps ${formatCompactTokens(reserveTokens)} tokens in mind for output/reasoning headroom when warning near the edge.`
      : '') + (contextWindowWarning ? ` ${contextWindowWarning}` : '') + (localNote ? ` ${localNote}` : '')
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
        contextWindowWarning ?? 'Context usage is unavailable because this agent does not have a known model context window yet.',
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

function findDelegatedSavedModel(
  modelId: string | null,
  provider: string | null,
  models: SavedModel[],
): SavedModel | null {
  const wantedModel = normalize(modelId)
  if (!wantedModel) return null
  const wantedProvider = normalize(provider)

  const matches = models.filter((model) => {
    const modelIds = [
      model.modelId,
      model.effectiveModelId,
      model.settings?.model,
      model.settings?.codex_model,
      model.settings?.claude_model,
    ].map((value) => normalize(typeof value === 'string' ? value : null))
    if (!modelIds.includes(wantedModel)) return false
    if (!wantedProvider) return true
    const connection = resolveSavedModelConnection(model)
    return (
      normalize(model.provider) === wantedProvider ||
      normalize(connection.service) === wantedProvider
    )
  })

  return matches[0] ?? null
}

/**
 * BL-184: the cache lifetime of a delegated run's writes. An API Subagent or Worker run carries
 * no request-level cache setting (`runApiSubagent` passes the preset's other provider options,
 * but `withoutRequestCacheSetting` in `subagentModelSelection.ts` strips its Prompt cache TTL
 * first), so every cache point on it is one the cache policy placed with Anthropic's default
 * five-minute lifetime, or the gateway's own five-minute default. A CLI run's lifetime is the CLI's own and unknown. A
 * Worker follows its parent's runtime family (SA-111 P4, DL-111-10), so the parent's run says
 * which lane it used.
 */
function resolveDelegatedCacheTtl(runType: string, parent: ExecutionSnapshot): CacheTtl | null {
  const type = normalize(runType)
  if (type === 'api') return '5m'
  if (type === 'worker' || type.startsWith('worker of ')) {
    return parent.runtime?.runtimeId === 'vercel' ? '5m' : null
  }
  return null
}

type DelegatedCostSummary = Pick<
  RunningCostSummary,
  | 'delegatedTokens'
  | 'delegatedCost'
  | 'delegatedRunCount'
  | 'delegatedUsageUnknownRuns'
  | 'delegatedCostUnknownRuns'
>

function summarizeDelegatedCost(
  snapshots: ExecutionSnapshot[],
  models: SavedModel[],
): DelegatedCostSummary & { priceEstimated: boolean } {
  // A price that went into the total is not known exactly: a cache-write rate Batshit cannot
  // vouch for (BL-184), or cache reads priced at the input price because the model has no
  // cached-input price (bug batch 2026-09-25, new find 3; the parent run already said so).
  let priceEstimated = false
  let delegatedTokens = 0
  let delegatedCost = 0
  let delegatedRunCount = 0
  let delegatedUsageUnknownRuns = 0
  let delegatedCostUnknownRuns = 0
  let tokenKnownRuns = 0
  let costKnownRuns = 0

  for (const snapshot of snapshots) {
    for (const run of snapshot.delegated?.runs ?? []) {
      delegatedRunCount += 1
      const usage = run.usage
      if (!usage) {
        delegatedUsageUnknownRuns += 1
        delegatedCostUnknownRuns += 1
        continue
      }

      const totalTokens =
        typeof usage.totalTokens === 'number'
          ? usage.totalTokens
          : typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
            ? usage.inputTokens + usage.outputTokens
            : null
      if (totalTokens !== null) {
        tokenKnownRuns += 1
        delegatedTokens += totalTokens
      } else {
        delegatedUsageUnknownRuns += 1
      }

      if (run.provider === 'chatgpt-plan') { delegatedCostUnknownRuns += 1; continue }
      const model = findDelegatedSavedModel(run.model, run.provider, models)
      const inputPrice = model ? getFlatPrice(model.pricing.input) : null
      const outputPrice = model ? getFlatPrice(model.pricing.output) : null
      if (
        !model ||
        inputPrice === null ||
        outputPrice === null ||
        typeof usage.inputTokens !== 'number' ||
        typeof usage.outputTokens !== 'number'
      ) {
        delegatedCostUnknownRuns += 1
        continue
      }

      const cachedPrice =
        typeof model.pricing.cachedInput === 'number' && Number.isFinite(model.pricing.cachedInput)
          ? model.pricing.cachedInput
          : null
      const priced = priceRunInput({
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheCreationInputTokens,
        inputPrice,
        cachedInputPrice: cachedPrice,
        writeRate: () =>
          resolveCacheWriteRate(
            isAnthropicBilledModel(run.model, run.provider),
            resolveDelegatedCacheTtl(run.type, snapshot),
          ),
      })
      if (priced.cachedPriceUnknown || priced.writePriceUnknown) priceEstimated = true
      delegatedCost += priced.cost
      delegatedCost += (usage.outputTokens / 1_000_000) * outputPrice
      costKnownRuns += 1
    }
  }

  return {
    delegatedTokens: tokenKnownRuns > 0 ? delegatedTokens : null,
    delegatedCost: costKnownRuns > 0 ? delegatedCost : null,
    delegatedRunCount,
    delegatedUsageUnknownRuns,
    delegatedCostUnknownRuns,
    priceEstimated,
  }
}

export function summarizeRunningCost(
  snapshots: ExecutionSnapshot[],
  activeModel: SavedModel | null,
  agent: Agent | null | undefined,
  models: SavedModel[] = [],
): RunningCostSummary {
  const { priceEstimated: delegatedPriceEstimated, ...delegated } = summarizeDelegatedCost(
    snapshots,
    models,
  )
  if (!activeModel) {
    return {
      cost: null,
      state: 'unknown',
      note: 'Model pricing is unavailable for this agent.',
      ...delegated,
    }
  }

  if (activeModel.connection?.service === 'chatgpt-plan' || activeModel.connection?.id?.startsWith('chatgpt-plan:')) return {
    cost: null, state: 'unknown', note: 'ChatGPT plan usage is managed at https://chatgpt.com/settings/usage. Batshit has no documented quota or monetary cost telemetry for this connection.', ...delegated,
  }

  const inputPrice = getFlatPrice(activeModel.pricing.input)
  const outputPrice = getFlatPrice(activeModel.pricing.output)
  const cachedInputPrice =
    typeof activeModel.pricing.cachedInput === 'number' &&
    Number.isFinite(activeModel.pricing.cachedInput)
      ? activeModel.pricing.cachedInput
      : null

  if (inputPrice === null || outputPrice === null) {
    // BL-67: an absent price is unknown, never $0.00. A real zero is a number and lands below.
    const missingPrice =
      activeModel.pricing?.input === undefined || activeModel.pricing?.output === undefined
    return {
      cost: null,
      state: 'unknown',
      note: missingPrice
        ? 'Cost is unknown because this model preset has no price. Add its input and output prices in Settings → Models to see a running cost.'
        : 'Cost is unavailable because this model uses pricing data Batshit cannot flatten into a truthful per-run number yet.',
      ...delegated,
    }
  }

  let total = 0
  let hasUsage = false
  let estimated = false
  // Missing usage is unknown, never zero: a run with no usage, or without both counts (a
  // stopped reply, a lane that reported nothing, a reply still running), leaves its cost out,
  // so the total is at best an estimate, and unknown when no run reported any.
  let runsWithoutUsage = 0

  for (const snapshot of snapshots) {
    const usage = resolveUsage(snapshot)
    if (!usage) {
      runsWithoutUsage += 1
      estimated = true
      continue
    }

    const rawInputTokens = usage.inputTokens?.value
    const rawOutputTokens = usage.outputTokens?.value
    if (!Number.isFinite(rawInputTokens) || !Number.isFinite(rawOutputTokens)) {
      runsWithoutUsage += 1
      estimated = true
      continue
    }

    const inputTokens = rawInputTokens as number
    const outputTokens = rawOutputTokens as number

    hasUsage = true

    const priced = priceRunInput({
      inputTokens,
      cachedInputTokens: usage.cachedInputTokens?.value,
      cacheWriteTokens: usage.cacheCreationInputTokens?.value,
      inputPrice,
      cachedInputPrice,
      writeRate: () =>
        resolveCacheWriteRate(
          isAnthropicBilledModel(
            snapshot.runtime?.modelName || activeModel.modelId,
            snapshot.runtime?.providerId || activeModel.provider,
          ),
          readSnapshotCacheTtl(snapshot),
        ),
    })
    if (priced.cachedPriceUnknown || priced.writePriceUnknown) estimated = true
    // A cache count the run names but does not know (`value: null`: an approval resume whose
    // halves did not both report it, BL-525) is priced as no cache at all, the whole input at the
    // input price, so the total is an estimate, never exact.
    if (
      usage.cachedInputTokens?.value === null ||
      usage.cacheCreationInputTokens?.value === null
    ) {
      estimated = true
    }
    total += priced.cost

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

  if (delegated.delegatedCost !== null) {
    total += delegated.delegatedCost
    hasUsage = true
  }
  if (delegated.delegatedCostUnknownRuns > 0 || delegatedPriceEstimated) {
    estimated = true
  }

  if (!hasUsage) {
    if (runsWithoutUsage > 0) {
      return {
        cost: null,
        state: 'unknown',
        note: 'Runs were recorded, but none reported the token usage a truthful cost total needs.',
        ...delegated,
      }
    }
    if (delegated.delegatedRunCount > 0) {
      return {
        cost: null,
        state: 'unknown',
        note: 'Delegated runs were recorded, but their usage or model pricing was not available for a truthful cost total.',
        ...delegated,
      }
    }
    return {
      cost: 0,
      state: 'exact',
      note: 'No completed runs yet for this chat.',
      ...delegated,
    }
  }

  if (estimated) {
    return {
      cost: total,
      state: 'estimated',
      note: 'Running cost includes parent and delegated run usage. Mixed models, missing usage, missing runtime identity, or a cache-write price Batshit does not know make this an estimate.',
      ...delegated,
    }
  }

  return {
    cost: total,
    state: 'exact',
    note: 'Running cost is based on stored parent and delegated run usage with matching model pricing.',
    ...delegated,
  }
}
