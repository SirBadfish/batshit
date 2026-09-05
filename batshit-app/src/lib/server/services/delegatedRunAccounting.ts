import type {
  DelegatedExecutionSummary,
  DelegatedRunKind,
  DelegatedRunRecord,
  DelegatedRunStatus,
  DelegatedRunThread,
} from '$lib/types/delegation'
import {
  buildUsageLike,
  normalizeUsageLike,
  type ApiUsageLike,
} from '$lib/server/services/apiProviderUsage'

function plainObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, any>
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function findDelegatedPayload(value: unknown, depth = 0): Record<string, any> | null {
  if (depth > 5) return null
  if (typeof value === 'string') {
    const parsed = parseJsonText(value)
    return parsed === value ? null : findDelegatedPayload(parsed, depth + 1)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDelegatedPayload(entry, depth + 1)
      if (found) return found
    }
    return null
  }

  const record = plainObject(value)
  if (!record) return null
  if (
    (record.kind === 'subagent' || record.kind === 'worker') &&
    ['completed', 'failed', 'timed_out'].includes(record.status)
  ) {
    return record
  }

  for (const key of ['toolResult', 'toolOutput', 'result', 'content', 'data', 'output']) {
    const found = findDelegatedPayload(record[key], depth + 1)
    if (found) return found
  }
  if (record.type === 'text' && typeof record.text === 'string') {
    return findDelegatedPayload(record.text, depth + 1)
  }
  return null
}

/**
 * SA-111 P4: a worker BATCH is one tool call carrying up to three runs, so it does not
 * look like the single-run payload above. `native_spawn_workers` / `spawn_workers` return
 * `{ kind: 'workers', workers: [...] }`; each entry becomes its own delegated run so the
 * Token Panel and the Execution Viewer count all three, not one.
 */
function findWorkerBatchPayload(value: unknown, depth = 0): Record<string, any>[] | null {
  if (depth > 5) return null
  if (typeof value === 'string') {
    const parsed = parseJsonText(value)
    return parsed === value ? null : findWorkerBatchPayload(parsed, depth + 1)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findWorkerBatchPayload(entry, depth + 1)
      if (found) return found
    }
    return null
  }

  const record = plainObject(value)
  if (!record) return null
  if (record.kind === 'workers' && Array.isArray(record.workers)) {
    const runs = record.workers
      .map((entry: unknown) => plainObject(entry))
      .filter((entry): entry is Record<string, any> => Boolean(entry))
    return runs.length > 0 ? runs : null
  }

  for (const key of ['toolResult', 'toolOutput', 'result', 'content', 'data', 'output']) {
    const found = findWorkerBatchPayload(record[key], depth + 1)
    if (found) return found
  }
  if (record.type === 'text' && typeof record.text === 'string') {
    return findWorkerBatchPayload(record.text, depth + 1)
  }
  return null
}

function normalizeThread(value: unknown): DelegatedRunThread {
  return value === 'fresh' || value === 'resumed' || value === 'resumed-empty' ? value : null
}

function addUsage(
  totals: NonNullable<ApiUsageLike>,
  usage: NonNullable<ApiUsageLike>,
): NonNullable<ApiUsageLike> {
  const add = (left: number | undefined, right: number | undefined) =>
    right === undefined ? left : (left ?? 0) + right
  return {
    inputTokens: add(totals.inputTokens, usage.inputTokens),
    outputTokens: add(totals.outputTokens, usage.outputTokens),
    totalTokens: add(totals.totalTokens, usage.totalTokens),
    reasoningTokens: add(totals.reasoningTokens, usage.reasoningTokens),
    cachedInputTokens: add(totals.cachedInputTokens, usage.cachedInputTokens),
    cacheCreationInputTokens: add(totals.cacheCreationInputTokens, usage.cacheCreationInputTokens),
  }
}

export function buildDelegatedExecutionSummary(steps: unknown): DelegatedExecutionSummary | null {
  if (!Array.isArray(steps) || steps.length === 0) return null

  const runs: DelegatedRunRecord[] = []
  const seenCallIds = new Set<string>()
  let totalUsage: NonNullable<ApiUsageLike> = {}
  let usageKnownRuns = 0

  const addUsageForRun = (usage: ReturnType<typeof normalizeUsageLike>) => {
    if (!usage) return
    usageKnownRuns += 1
    totalUsage = addUsage(totalUsage, usage)
  }

  for (const step of steps) {
    const stepRecord = plainObject(step)
    if (!stepRecord) continue
    const batch = findWorkerBatchPayload(stepRecord)
    const payload = batch ? null : findDelegatedPayload(stepRecord)
    if (!batch && !payload) continue

    const callId =
      typeof stepRecord.toolCallId === 'string'
        ? stepRecord.toolCallId.trim()
        : typeof stepRecord.id === 'string'
          ? stepRecord.id.trim()
          : ''
    if (callId && seenCallIds.has(callId)) continue
    if (callId) seenCallIds.add(callId)

    if (batch) {
      for (const entry of batch) {
        const status = entry.status as DelegatedRunStatus
        if (!['completed', 'failed', 'timed_out'].includes(status)) continue
        const usage = normalizeUsageLike(entry.usage) ?? null
        addUsageForRun(usage)
        const duration = Number(entry.durationMs)
        const base = typeof entry.base === 'string' && entry.base.trim() ? entry.base.trim() : null
        runs.push({
          kind: 'worker',
          name: String(entry.name ?? entry.role ?? 'Worker'),
          type: base ? `worker of ${base}` : 'worker',
          model: typeof entry.modelId === 'string' ? entry.modelId : null,
          provider: typeof entry.provider === 'string' ? entry.provider : null,
          usage,
          durationMs: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0,
          status,
          // A worker has no stored thread at all — honest absence, not a made-up 'fresh'.
          thread: null,
        })
      }
      continue
    }

    if (!payload) continue
    const kind = payload.kind as DelegatedRunKind
    const status = payload.status as DelegatedRunStatus
    const usage = normalizeUsageLike(payload.usage) ?? null
    addUsageForRun(usage)

    const duration = Number(payload.durationMs)
    const nameCandidate =
      payload.subagentName ??
      payload.name ??
      payload.role ??
      stepRecord.subagentName ??
      stepRecord.toolName ??
      (kind === 'worker' ? 'Worker' : 'Subagent')
    const typeCandidate =
      payload.subagentType ?? payload.type ?? (kind === 'worker' ? 'worker' : 'subagent')

    runs.push({
      kind,
      name: String(nameCandidate),
      type: String(typeCandidate),
      model:
        typeof (payload.modelId ?? payload.model) === 'string'
          ? String(payload.modelId ?? payload.model)
          : null,
      provider: typeof payload.provider === 'string' ? payload.provider : null,
      usage,
      durationMs: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0,
      status,
      thread: normalizeThread(payload.thread),
    })
  }

  if (runs.length === 0) return null

  return {
    runs,
    totals: {
      runs: runs.length,
      completed: runs.filter((run) => run.status === 'completed').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      timedOut: runs.filter((run) => run.status === 'timed_out').length,
      usageKnownRuns,
      usageUnknownRuns: runs.length - usageKnownRuns,
      usage: buildUsageLike(totalUsage) ?? null,
    },
  }
}
