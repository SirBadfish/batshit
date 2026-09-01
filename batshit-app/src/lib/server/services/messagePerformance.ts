/**
 * SA-093 P7: per-send performance metadata for the chat-bar strip.
 *
 * Built from AI SDK v7 step results on the `API` lane and persisted on the
 * assistant message's metadata as `metadata.performance`. Honesty rule
 * (DL-093-14): a metric the runtime did not measure is simply absent — the
 * strip renders an explicit unknown state, never a latency-derived guess.
 */

export interface MessagePerformanceMetadata {
  schemaVersion: 1
  /**
   * Where the numbers came from: 'ai-sdk' = SDK-measured stream timings
   * (`API` lane); 'measured' = Batshit-measured wall-clock stream timings
   * (managed CLI lanes, which include harness startup/overhead in TTFT).
   */
  source: 'ai-sdk' | 'measured'
  /** Milliseconds from the FIRST model call's start to its first output chunk. */
  timeToFirstOutputMs?: number
  /** Output tokens per second while streaming (final answer call). */
  outputTokensPerSecond?: number
  /** Total model response time across all calls in the send, in milliseconds. */
  responseTimeMs?: number
  /** Number of model calls in the send (tool loops make this > 1). */
  modelCalls?: number
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

/**
 * Extracts strip metrics from v7 `StepResult[]`. Returns null when no step
 * carries performance data (non-streaming paths, older shapes) so callers
 * store nothing rather than zeros.
 */
export function buildMessagePerformanceFromSteps(
  steps: unknown[],
): MessagePerformanceMetadata | null {
  const list = Array.isArray(steps) ? (steps as any[]) : []
  if (list.length === 0) return null

  const performances = list
    .map((step) => step?.performance)
    .filter((performance): performance is Record<string, unknown> =>
      Boolean(performance && typeof performance === 'object'),
    )
  if (performances.length === 0) return null

  const firstWithTtft = performances.find(
    (performance) => finiteOrUndefined(performance.timeToFirstOutputMs) !== undefined,
  )
  const timeToFirstOutputMs = firstWithTtft
    ? finiteOrUndefined(firstWithTtft.timeToFirstOutputMs)
    : undefined

  const lastPerformance = performances[performances.length - 1]
  const outputTokensPerSecond =
    finiteOrUndefined(lastPerformance.outputTokensPerSecond) ??
    finiteOrUndefined(lastPerformance.effectiveOutputTokensPerSecond)

  let responseTimeMs: number | undefined
  for (const performance of performances) {
    const stepResponseMs = finiteOrUndefined(performance.responseTimeMs)
    if (stepResponseMs !== undefined) {
      responseTimeMs = (responseTimeMs ?? 0) + stepResponseMs
    }
  }

  const metadata: MessagePerformanceMetadata = {
    schemaVersion: 1,
    source: 'ai-sdk',
    modelCalls: list.length,
  }
  if (timeToFirstOutputMs !== undefined) {
    metadata.timeToFirstOutputMs = Math.round(timeToFirstOutputMs)
  }
  if (outputTokensPerSecond !== undefined) {
    metadata.outputTokensPerSecond = Math.round(outputTokensPerSecond * 10) / 10
  }
  if (responseTimeMs !== undefined) metadata.responseTimeMs = Math.round(responseTimeMs)

  if (
    metadata.timeToFirstOutputMs === undefined &&
    metadata.outputTokensPerSecond === undefined &&
    metadata.responseTimeMs === undefined
  ) {
    return null
  }

  return metadata
}

export interface MeasuredStreamTimingInput {
  /** Wall-clock ms when the runtime request/bridge run started. */
  startedAt: number | null
  /** Wall-clock ms when the first real output event arrived (text/reasoning/tool-call). */
  firstOutputAt: number | null
  /** Wall-clock ms when the stream finished. */
  finishedAt: number | null
  /** Total ms spent inside tool-call → tool-result windows (excluded from model time). */
  toolActiveMs?: number
  /** Output token total reported by the runtime, for tokens/sec. */
  outputTokens?: number | null
}

/**
 * SA-093 P7 (DL-093-14): Batshit-measured stream performance for lanes whose
 * runtime does not measure itself — the managed Codex/Claude CLI bridges.
 *
 * Every number is a real wall-clock measurement combined with runtime-reported
 * token counts; nothing here estimates cache behavior from latency. TTFT is
 * end-to-end (it includes CLI harness startup); model time and tokens/sec
 * exclude the tool-execution windows Batshit observed on the stream.
 */
export function buildMeasuredMessagePerformance(
  timing: MeasuredStreamTimingInput,
): MessagePerformanceMetadata | null {
  const startedAt = finiteOrUndefined(timing.startedAt)
  const finishedAt = finiteOrUndefined(timing.finishedAt)
  if (startedAt === undefined || finishedAt === undefined) return null
  if (finishedAt < startedAt) return null

  const firstOutputAt = finiteOrUndefined(timing.firstOutputAt)
  const toolActiveMs = finiteOrUndefined(timing.toolActiveMs) ?? 0

  const metadata: MessagePerformanceMetadata = {
    schemaVersion: 1,
    source: 'measured',
  }

  if (firstOutputAt !== undefined && firstOutputAt >= startedAt) {
    metadata.timeToFirstOutputMs = Math.round(firstOutputAt - startedAt)
  }

  const responseTimeMs = finishedAt - startedAt - toolActiveMs
  if (responseTimeMs > 0) metadata.responseTimeMs = Math.round(responseTimeMs)

  const outputTokens =
    typeof timing.outputTokens === 'number' &&
    Number.isFinite(timing.outputTokens) &&
    timing.outputTokens > 0
      ? timing.outputTokens
      : undefined
  if (outputTokens !== undefined && firstOutputAt !== undefined) {
    const generationMs = finishedAt - firstOutputAt - toolActiveMs
    if (generationMs > 0) {
      metadata.outputTokensPerSecond =
        Math.round((outputTokens / (generationMs / 1000)) * 10) / 10
    }
  }

  if (
    metadata.timeToFirstOutputMs === undefined &&
    metadata.outputTokensPerSecond === undefined &&
    metadata.responseTimeMs === undefined
  ) {
    return null
  }

  return metadata
}
