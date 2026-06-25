import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redactWebhookStyleInput } from '$lib/server/services/executionViewerRedaction'
import { resolveRuntimeN8nBaseUrl } from '$lib/server/services/runtimeUrlRewrites'

type N8nExecutionListEntry = {
  id?: number
  workflowId?: number
  startedAt?: string
  stoppedAt?: string
  status?: string
}

export type N8nExecutionStopResult = {
  apiConfigured: boolean
  baseUrl: string | null
  checkedExecutionIds: number[]
  matchedExecutionIds: number[]
  stoppedExecutionIds: number[]
  workflowFallbackExecutionIds: number[]
  failures: Array<{ executionId: number; error: string }>
}

export type N8nExecutionTokenUsageKind = 'tokenUsage' | 'tokenUsageEstimate'

export type N8nExecutionTokenUsage = {
  kind: N8nExecutionTokenUsageKind
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  nodeName: string | null
}

export type N8nExecutionIntermediateStepsInsight = {
  toolCallsCount: number | null
  steps: any[] | null
}

type IntermediateStepsCandidate = {
  steps: any[]
  nodeName: string | null
  nodeType: string | null
  depth: number
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  // Guard against users pasting the full API root (we append /api/v1 below).
  return trimmed.replace(/\/api\/v1$/i, '')
}

async function resolveN8nApiAuth(userId: string): Promise<{ baseUrl: string; apiKey: string } | null> {
  // Prefer the per-user key stored in Redis (Settings → API Keys). Env is a fallback for dev only.
  const apiKey =
    (await apiKeyService.retrieve('n8n_api_key', userId).catch(() => null)) || env.N8N_API_KEY
  if (!apiKey) return null

  const savedApiUrl = await apiKeyService.retrieve('n8n_api_url', userId).catch(() => null)
  const apiUrl = resolveRuntimeN8nBaseUrl(savedApiUrl, env) || 'http://localhost:5678'

  return {
    baseUrl: normalizeBaseUrl(apiUrl),
    apiKey
  }
}

async function fetchJson(
  url: string,
  apiKey: string,
  timeoutMs = 10_000,
  method: 'GET' | 'POST' = 'GET'
): Promise<any> {
  const response = await fetch(url, {
    method,
    headers: {
      'X-N8N-API-KEY': apiKey,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body || `n8n API error (${response.status})`)
  }

  return await response.json()
}

function executionIdToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeWebhookPathFromUrl(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null

  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    const markerIndex = parts.findIndex((part) => part === 'webhook' || part === 'webhook-test')
    if (markerIndex === -1) return null
    const path = parts.slice(markerIndex + 1).join('/')
    return path ? decodeURIComponent(path) : null
  } catch {
    const parts = value.split('/').filter(Boolean)
    const markerIndex = parts.findIndex((part) => part === 'webhook' || part === 'webhook-test')
    if (markerIndex === -1) return null
    const path = parts.slice(markerIndex + 1).join('/')
    return path || null
  }
}

function looksLikeWebhookPayload(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return 'headers' in value && 'params' in value && 'query' in value && 'body' in value
}

function unwrapApiData(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload

  // n8n's REST API often wraps responses in { data: ... }.
  if ('data' in payload) return (payload as any).data

  return payload
}

function extractRunData(executionPayload: any): Record<string, any> | null {
  // Different n8n versions/endpoints nest execution data differently.
  const root = unwrapApiData(executionPayload)

  const roots = [root, root?.data, root?.executionData].filter(Boolean)
  const paths: Array<Array<string>> = [
    ['resultData', 'runData'],
    ['data', 'resultData', 'runData'],
    ['executionData', 'resultData', 'runData']
  ]

  for (const candidateRoot of roots) {
    for (const path of paths) {
      let value: any = candidateRoot
      for (const key of path) {
        if (!value || typeof value !== 'object') {
          value = null
          break
        }
        value = value[key]
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, any>
      }
    }
  }

  return null
}

function extractWorkflowNodeTypes(executionPayload: any): Record<string, string> {
  const root = unwrapApiData(executionPayload)

  const roots = [root, root?.data, root?.executionData].filter(Boolean)
  const paths: Array<Array<string>> = [
    ['workflowData', 'nodes'],
    ['data', 'workflowData', 'nodes'],
    ['executionData', 'workflowData', 'nodes']
  ]

  for (const candidateRoot of roots) {
    for (const path of paths) {
      let value: any = candidateRoot
      for (const key of path) {
        if (!value || typeof value !== 'object') {
          value = null
          break
        }
        value = value[key]
      }

      if (Array.isArray(value)) {
        const map: Record<string, string> = {}
        for (const node of value) {
          const name = typeof node?.name === 'string' ? node.name : null
          const type = typeof node?.type === 'string' ? node.type : null
          if (!name || !type) continue
          map[name] = type
        }
        return map
      }
    }
  }

  return {}
}

function isChatModelNodeType(nodeType: string | null): boolean {
  if (!nodeType) return false
  return nodeType.toLowerCase().includes('.lmchat')
}

function isAiAgentNodeType(nodeType: string | null): boolean {
  if (!nodeType) return false
  const lowered = nodeType.toLowerCase()
  if (isAiAgentToolNodeType(nodeType)) return false
  return lowered.includes('.agent') || lowered.includes('langchain.agent') || lowered.includes('aiagent')
}

function isAiAgentToolNodeType(nodeType: string | null): boolean {
  if (!nodeType) return false
  const lowered = nodeType.toLowerCase()
  return lowered.includes('.agenttool') || lowered.includes('agenttool') || lowered.includes('toolaiagent')
}

function extractWebhookItemsFromExecution(execution: any): any[] {
  const runData = extractRunData(execution)
  if (!runData) {
    return []
  }

  const candidates: any[] = []

  for (const nodeRuns of Object.values(runData as Record<string, any>)) {
    if (!Array.isArray(nodeRuns)) continue

    for (const runEntry of nodeRuns) {
      const main = runEntry?.data?.main
      if (!Array.isArray(main) || main.length === 0) continue
      const firstChannel = main[0]
      if (!Array.isArray(firstChannel) || firstChannel.length === 0) continue

      for (const item of firstChannel) {
        const json = item?.json ?? item
        if (looksLikeWebhookPayload(json)) {
          candidates.push(json)
        }
      }
    }
  }

  return candidates
}

function parseIntermediateStepsString(value: string): any[] | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null

  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function collectIntermediateStepsCandidatesFromValue(
  value: any,
  output: IntermediateStepsCandidate[],
  visited: WeakSet<object>,
  source: { nodeName: string | null; nodeType: string | null },
  depth = 0
) {
  if (!value || depth > 10) return
  if (typeof value !== 'object') return
  if (visited.has(value as object)) return
  visited.add(value as object)

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectIntermediateStepsCandidatesFromValue(entry, output, visited, source, depth + 1)
    }
    return
  }

  for (const [key, nested] of Object.entries(value as Record<string, any>)) {
    const isIntermediateKey = key === 'intermediateSteps' || key === 'intermediate_steps'
    if (isIntermediateKey) {
      if (Array.isArray(nested)) {
        output.push({
          steps: nested,
          nodeName: source.nodeName,
          nodeType: source.nodeType,
          depth
        })
      } else if (typeof nested === 'string') {
        const parsed = parseIntermediateStepsString(nested)
        if (parsed) {
          output.push({
            steps: parsed,
            nodeName: source.nodeName,
            nodeType: source.nodeType,
            depth
          })
        }
      }
      continue
    }

    if (nested && typeof nested === 'object') {
      collectIntermediateStepsCandidatesFromValue(nested, output, visited, source, depth + 1)
    }
  }
}

function chooseBestIntermediateStepsCandidate(
  candidates: IntermediateStepsCandidate[]
): IntermediateStepsCandidate | null {
  if (candidates.length === 0) return null

  const primaryAiAgentCandidates = candidates.filter((candidate) =>
    isAiAgentNodeType(candidate.nodeType)
  )
  const pool = primaryAiAgentCandidates.length > 0 ? primaryAiAgentCandidates : candidates

  let best: IntermediateStepsCandidate | null = null
  for (const candidate of pool) {
    if (!Array.isArray(candidate.steps)) continue
    if (!best) {
      best = candidate
      continue
    }

    if (primaryAiAgentCandidates.length > 0) {
      if (candidate.depth < best.depth) {
        best = candidate
        continue
      }
      if (candidate.depth === best.depth && candidate.steps.length > best.steps.length) {
        best = candidate
      }
      continue
    }

    if (candidate.steps.length > best.steps.length) {
      best = candidate
    }
  }

  return best
}

function extractIntermediateStepsInsightFromExecution(execution: any): N8nExecutionIntermediateStepsInsight {
  const runData = extractRunData(execution)
  if (!runData) return { toolCallsCount: null, steps: null }
  const nodeTypes = extractWorkflowNodeTypes(execution)

  const candidates: IntermediateStepsCandidate[] = []

  for (const [nodeName, nodeRuns] of Object.entries(runData)) {
    if (!Array.isArray(nodeRuns)) continue

    for (const runEntry of nodeRuns) {
      const visited = new WeakSet<object>()
      collectIntermediateStepsCandidatesFromValue(
        runEntry?.data,
        candidates,
        visited,
        {
          nodeName,
          nodeType: nodeTypes[nodeName] ?? null
        }
      )
    }
  }

  const bestCandidate = chooseBestIntermediateStepsCandidate(candidates)
  const bestSteps = bestCandidate?.steps ?? null

  return {
    toolCallsCount: bestSteps ? bestSteps.length : null,
    steps: bestSteps
  }
}

function determineExecutionModeFromWebhookUrl(webhookUrl: string | null): string | null {
  if (!webhookUrl) return null
  if (webhookUrl.includes('/webhook-test/')) return 'test'
  if (webhookUrl.includes('/webhook/')) return 'production'
  return null
}

function extractExecutionListEntries(listPayload: any): N8nExecutionListEntry[] {
  const data = unwrapApiData(listPayload)
  if (Array.isArray(data)) return data as N8nExecutionListEntry[]

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const candidates = [
      (data as any).data,
      (data as any).results,
      (data as any).executions,
      (data as any).items
    ]

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate as N8nExecutionListEntry[]
    }
  }

  return []
}

function executionMatchesMessage(execution: any, params: { sessionId: string; messageId: string }) {
  const webhookItems = extractWebhookItemsFromExecution(execution)
  if (!Array.isArray(webhookItems) || webhookItems.length === 0) return false

  return webhookItems.some((item) => {
    const body = item?.body
    const messageId = body?.message_id ?? body?.messageId ?? body?.id
    const sessionId = body?.session_id ?? body?.sessionId
    if (String(messageId ?? '') !== params.messageId) return false
    if (String(sessionId ?? '') !== params.sessionId) return false
    return true
  })
}

async function fetchWorkflowIdsForWebhookPath(
  auth: { baseUrl: string; apiKey: string },
  webhookPath: string | null
): Promise<Set<string>> {
  const ids = new Set<string>()
  if (!webhookPath) return ids

  let cursor = ''
  do {
    const url = new URL(`${auth.baseUrl}/api/v1/workflows`)
    url.searchParams.set('limit', '250')
    url.searchParams.set('excludePinnedData', 'true')
    if (cursor) url.searchParams.set('cursor', cursor)

    const payload = await fetchJson(url.toString(), auth.apiKey)
    const workflows = Array.isArray(payload?.data) ? payload.data : []

    for (const workflow of workflows) {
      const workflowId = workflow?.id
      if (workflowId === undefined || workflowId === null) continue
      const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
      const hasPath = nodes.some((node: any) => {
        if (node?.type !== 'n8n-nodes-base.webhook') return false
        return String(node?.parameters?.path ?? '') === webhookPath
      })
      if (hasPath) ids.add(String(workflowId))
    }

    cursor = typeof payload?.nextCursor === 'string' ? payload.nextCursor : ''
  } while (cursor)

  return ids
}

async function stopN8nExecution(
  auth: { baseUrl: string; apiKey: string },
  executionId: number
): Promise<void> {
  const stopUrl = `${auth.baseUrl}/api/v1/executions/${encodeURIComponent(String(executionId))}/stop`
  await fetchJson(stopUrl, auth.apiKey, 10_000, 'POST')
}

type MatchingExecution = {
  execution: any
  webhookItems: any[]
  executionId: number | null
}

function normalizeTokenCount(value: any): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeTokenUsageObject(value: any): {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const promptTokens = normalizeTokenCount(
    (value as any).promptTokens ??
      (value as any).prompt ??
      (value as any).prompt_tokens ??
      (value as any).inputTokens ??
      (value as any).input_tokens
  )
  const completionTokens = normalizeTokenCount(
    (value as any).completionTokens ??
      (value as any).completion ??
      (value as any).completion_tokens ??
      (value as any).outputTokens ??
      (value as any).output_tokens
  )
  const totalTokens = normalizeTokenCount(
    (value as any).totalTokens ?? (value as any).total ?? (value as any).total_tokens
  )

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null
  }

  // Some n8n nodes (e.g., routing/model selector helpers) may emit `{ tokenUsageEstimate: { 0,0,0 } }`.
  // Treat that as "no usage" so we don't inflate totals when we apply batshit's tool-definition estimate.
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }

  return { promptTokens, completionTokens, totalTokens }
}

function collectTokenUsageFromValue(
  value: any,
  nodeName: string,
  output: N8nExecutionTokenUsage[],
  seen: Set<string>,
  visited: WeakSet<object>,
  depth = 0
) {
  if (!value || depth > 8) return
  if (typeof value !== 'object') return
  if (visited.has(value as object)) return
  visited.add(value as object)

  const tokenUsage = (value as any).tokenUsage
  const tokenUsageEstimate = (value as any).tokenUsageEstimate

  if (tokenUsage && typeof tokenUsage === 'object') {
    const normalized = normalizeTokenUsageObject(tokenUsage)
    if (normalized) {
      const key = `tokenUsage|${nodeName}|${normalized.promptTokens ?? ''}|${normalized.completionTokens ?? ''}|${normalized.totalTokens ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        output.push({
          kind: 'tokenUsage',
          ...normalized,
          nodeName
        })
      }
    }
  }

  if (tokenUsageEstimate && typeof tokenUsageEstimate === 'object') {
    const normalized = normalizeTokenUsageObject(tokenUsageEstimate)
    if (normalized) {
      const key = `tokenUsageEstimate|${nodeName}|${normalized.promptTokens ?? ''}|${normalized.completionTokens ?? ''}|${normalized.totalTokens ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        output.push({
          kind: 'tokenUsageEstimate',
          ...normalized,
          nodeName
        })
      }
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTokenUsageFromValue(entry, nodeName, output, seen, visited, depth + 1)
    }
    return
  }

  for (const nested of Object.values(value as Record<string, any>)) {
    if (!nested || typeof nested !== 'object') continue
    collectTokenUsageFromValue(nested, nodeName, output, seen, visited, depth + 1)
  }
}

function extractTokenUsagesFromExecution(execution: any): N8nExecutionTokenUsage[] {
  const runData = extractRunData(execution)
  if (!runData) return []

  const nodeTypes = extractWorkflowNodeTypes(execution)
  const hasNodeTypes = Object.keys(nodeTypes).length > 0

  const output: N8nExecutionTokenUsage[] = []

  for (const [nodeName, nodeRuns] of Object.entries(runData)) {
    if (!Array.isArray(nodeRuns)) continue

    if (hasNodeTypes) {
      const nodeType = nodeTypes[nodeName] ?? null
      if (!isChatModelNodeType(nodeType)) continue
    }

    for (const runEntry of nodeRuns) {
      const visited = new WeakSet<object>()
      const seen = new Set<string>()

      // n8n stores token usage in multiple places depending on node type/version.
      // - Chat Model nodes often emit data under `data.ai_languageModel` (not `data.main`).
      // - Some nodes may embed usage inside `item.json` under `data.main`.
      // To be resilient, scan the entire runEntry.data object.
      collectTokenUsageFromValue(runEntry?.data, nodeName, output, seen, visited)
    }
  }

  return output
}

async function fetchMatchingExecution(params: {
  userId: string
  sessionId: string
  messageId: string
  expectedWebhookUrl?: string | null
  limit?: number
}): Promise<MatchingExecution | null> {
  const auth = await resolveN8nApiAuth(params.userId)
  if (!auth) return null

  const limitRaw = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 60
  const limit = Math.max(1, Math.min(250, Math.trunc(limitRaw)))
  const listUrl = `${auth.baseUrl}/api/v1/executions?limit=${encodeURIComponent(String(limit))}`

  const listPayload = await fetchJson(listUrl, auth.apiKey)
  const entries = extractExecutionListEntries(listPayload)
  if (entries.length === 0) {
    throw new Error(`No n8n executions returned by ${auth.baseUrl} (limit=${limit}).`)
  }

  const expectedMessageId = params.messageId
  const expectedSessionId = params.sessionId
  const expectedWebhookUrl =
    typeof params.expectedWebhookUrl === 'string' ? params.expectedWebhookUrl : null

  let detailFetchCount = 0
  let detailWithRunDataCount = 0
  let totalWebhookCandidates = 0

  for (const entry of entries) {
    const executionId = entry?.id
    if (executionId === undefined || executionId === null) continue

    let execution: any
    try {
      const executionUrl = `${auth.baseUrl}/api/v1/executions/${encodeURIComponent(String(executionId))}?includeData=true`
      execution = await fetchJson(executionUrl, auth.apiKey)
    } catch {
      continue
    }

    detailFetchCount += 1
    if (extractRunData(execution)) {
      detailWithRunDataCount += 1
    }

    const webhookItems = extractWebhookItemsFromExecution(execution)
    if (!Array.isArray(webhookItems) || webhookItems.length === 0) continue
    totalWebhookCandidates += webhookItems.length

    if (!executionMatchesMessage(execution, {
      sessionId: expectedSessionId,
      messageId: expectedMessageId
    })) {
      continue
    }

    const normalized = webhookItems.map((item) => {
      const webhookUrl = typeof item?.webhookUrl === 'string' ? item.webhookUrl : expectedWebhookUrl
      const executionMode =
        typeof item?.executionMode === 'string'
          ? item.executionMode
          : determineExecutionModeFromWebhookUrl(webhookUrl)

      return {
        ...item,
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(executionMode ? { executionMode } : {})
      }
    })

    return {
      execution,
      webhookItems: normalized,
      executionId: typeof executionId === 'number' ? executionId : Number(executionId) || null
    }
  }

  // No match found. If we couldn't see execution runData at all, this is almost certainly an n8n setting/API behavior issue.
  if (detailFetchCount > 0 && detailWithRunDataCount === 0) {
    throw new Error(
      `n8n executions from ${auth.baseUrl} did not include runData (includeData=true returned no execution data). ` +
        `Enable saving execution data for successful runs in n8n, then try Refresh again.`
    )
  }

  // We saw runData but never found a webhook-style payload. That usually means the webhook node output isn't being returned by the API.
  if (detailWithRunDataCount > 0 && totalWebhookCandidates === 0) {
    throw new Error(
      `n8n executions from ${auth.baseUrl} included runData, but no webhook-style payload was found. ` +
        `This can happen if execution data is trimmed or if n8n changed its execution data shape.`
    )
  }

  return null
}

export async function fetchExactN8nWebhookStyleInput(params: {
  userId: string
  sessionId: string
  messageId: string
  expectedWebhookUrl?: string | null
  limit?: number
}): Promise<any[] | null> {
  const match = await fetchMatchingExecution(params)
  if (!match) return null
  return redactWebhookStyleInput(match.webhookItems) as any[]
}

export async function fetchN8nExecutionTokenUsages(params: {
  userId: string
  sessionId: string
  messageId: string
  expectedWebhookUrl?: string | null
  limit?: number
}): Promise<N8nExecutionTokenUsage[] | null> {
  const match = await fetchMatchingExecution(params)
  if (!match) return null
  return extractTokenUsagesFromExecution(match.execution)
}

export async function fetchN8nExecutionInsights(params: {
  userId: string
  sessionId: string
  messageId: string
  expectedWebhookUrl?: string | null
  limit?: number
}): Promise<{
  webhookStyleInput: any[]
  tokenUsages: N8nExecutionTokenUsage[]
  executionId: number | null
  intermediateSteps: N8nExecutionIntermediateStepsInsight
} | null> {
  const match = await fetchMatchingExecution(params)
  if (!match) return null

  return {
    webhookStyleInput: redactWebhookStyleInput(match.webhookItems) as any[],
    tokenUsages: extractTokenUsagesFromExecution(match.execution),
    executionId: match.executionId,
    intermediateSteps: extractIntermediateStepsInsightFromExecution(match.execution)
  }
}

export async function stopRunningN8nExecutionsForMessage(params: {
  userId: string
  sessionId: string
  messageId: string
  expectedWebhookUrl?: string | null
  limit?: number
}): Promise<N8nExecutionStopResult> {
  const auth = await resolveN8nApiAuth(params.userId)
  if (!auth) {
    return {
      apiConfigured: false,
      baseUrl: null,
      checkedExecutionIds: [],
      matchedExecutionIds: [],
      stoppedExecutionIds: [],
      workflowFallbackExecutionIds: [],
      failures: []
    }
  }

  const limitRaw = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 50
  const limit = Math.max(1, Math.min(250, Math.trunc(limitRaw)))
  const listUrl = `${auth.baseUrl}/api/v1/executions?status=running&limit=${encodeURIComponent(String(limit))}`
  const result: N8nExecutionStopResult = {
    apiConfigured: true,
    baseUrl: auth.baseUrl,
    checkedExecutionIds: [],
    matchedExecutionIds: [],
    stoppedExecutionIds: [],
    workflowFallbackExecutionIds: [],
    failures: []
  }

  const expectedWorkflowIds = await fetchWorkflowIdsForWebhookPath(
    auth,
    normalizeWebhookPathFromUrl(params.expectedWebhookUrl)
  ).catch(() => new Set<string>())
  const listPayload = await fetchJson(listUrl, auth.apiKey)
  const entries = extractExecutionListEntries(listPayload)
  const workflowFallbackCandidates: number[] = []

  for (const entry of entries) {
    const executionId = executionIdToNumber(entry?.id)
    if (executionId === null) continue
    result.checkedExecutionIds.push(executionId)
    if (
      expectedWorkflowIds.size > 0 &&
      entry?.workflowId !== undefined &&
      entry?.workflowId !== null &&
      expectedWorkflowIds.has(String(entry.workflowId))
    ) {
      workflowFallbackCandidates.push(executionId)
    }

    let execution: any
    try {
      const executionUrl = `${auth.baseUrl}/api/v1/executions/${encodeURIComponent(String(executionId))}?includeData=true`
      execution = await fetchJson(executionUrl, auth.apiKey)
    } catch (error) {
      result.failures.push({
        executionId,
        error: error instanceof Error ? error.message : String(error)
      })
      continue
    }

    if (!executionMatchesMessage(execution, params)) continue
    result.matchedExecutionIds.push(executionId)

    try {
      await stopN8nExecution(auth, executionId)
      result.stoppedExecutionIds.push(executionId)
    } catch (error) {
      result.failures.push({
        executionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (result.matchedExecutionIds.length === 0 && workflowFallbackCandidates.length === 1) {
    const executionId = workflowFallbackCandidates[0]
    result.workflowFallbackExecutionIds.push(executionId)
    try {
      await stopN8nExecution(auth, executionId)
      result.stoppedExecutionIds.push(executionId)
    } catch (error) {
      result.failures.push({
        executionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return result
}
