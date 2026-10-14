/**
 * The error `result` events Claude Code 2.1.296 writes on `--output-format stream-json`, read from
 * the installed CLI's bundled source (2026-10-11; not run). Every event keeps the vendor's own field
 * names and nesting; the ids, words, and numbers are replaced, and the fields the adapter does not
 * read (`fast_mode_state`, `fast_mode_disabled_reason`, `origin`, `subagent_stats`, `safety_stops`)
 * are left out.
 *
 * - The main loop's error result (`error_max_turns`, `error_during_execution`, `error_max_budget_usd`)
 *   carries the same common fields as a successful one, plus `is_error: true`, the subtype, and
 *   `errors[]` with no `result`. Its `modelUsage` is the ledger of the run's model calls. On the
 *   session-engine path its `usage` is built from that ledger (each counter the sum over its models,
 *   on a template whose other fields stay at their defaults); the query loop writes the turn's own
 *   usage on the same template instead.
 * - An API error ends the run as `subtype: 'success'` with `is_error: true`, `api_error_status`, and
 *   the error's words as `result`, with the same common fields.
 * - The session-crash result (`error_during_execution`, `[session_crash] …`) is a fixed shape:
 *   `duration_ms`/`duration_api_ms`/`num_turns`/`total_cost_usd` 0, the all-zero `usage` template,
 *   and `modelUsage: {}`, whatever the run spent before it crashed.
 */

const SESSION = '5f0c3a52-7d1e-4b8a-9c6f-0e2d4a1b3c7d'
const MODEL = 'claude-sonnet-5-5'

export type ClaudeResultCounts = {
  input: number
  cacheRead: number
  cacheCreation: number
  output: number
}

/** The counts the main loop's error result reports below unless a test passes others. */
export const CLAUDE_ERROR_RESULT_COUNTS: ClaudeResultCounts = {
  input: 6,
  cacheRead: 2048,
  cacheCreation: 512,
  output: 40
}

/** Claude Code's usage template: every counter 0 (a result built from it overrides the counters). */
const usageTemplate = () => ({
  output_tokens_details: { thinking_tokens: 0 },
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
  fallback_credit: null
})

/** A result's `usage`: the template with the ledger's sums (its `cache_creation` split stays 0). */
const reportedUsage = (counts: ClaudeResultCounts) => ({
  ...usageTemplate(),
  input_tokens: counts.input,
  output_tokens: counts.output,
  output_tokens_details: { thinking_tokens: 0 },
  cache_read_input_tokens: counts.cacheRead,
  cache_creation_input_tokens: counts.cacheCreation,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }
})

/** One `modelUsage` row, the ledger entry for the model that ran. */
const modelUsageRow = (counts: ClaudeResultCounts) => ({
  inputTokens: counts.input,
  outputTokens: counts.output,
  cacheReadInputTokens: counts.cacheRead,
  cacheCreationInputTokens: counts.cacheCreation,
  webSearchRequests: 0,
  costUSD: 0.0087,
  contextWindow: 200000,
  maxOutputTokens: 32000,
  thinkingTokens: 0,
  canonicalModel: MODEL,
  provider: 'firstParty',
  costBasis: 'list'
})

/** The loop's own stop reason for each subtype (one of its listed terminal reasons). */
const TERMINAL_REASON = {
  error_max_turns: 'max_turns',
  error_during_execution: 'model_error',
  error_max_budget_usd: 'budget_exhausted'
} as const

/**
 * The main loop's error result after the run made model calls: `is_error: true`, an `error_*`
 * subtype, the reason in `errors[]`, no `result`, and the run's usage with its `modelUsage`.
 */
export function claudeErrorResult(
  subtype: 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd',
  errors: string[],
  counts: ClaudeResultCounts = CLAUDE_ERROR_RESULT_COUNTS
): Record<string, unknown> {
  return {
    duration_api_ms: 3900,
    // The last model call's own stop reason: the loop stopped between a tool call and its answer.
    stop_reason: 'tool_use',
    session_id: SESSION,
    total_cost_usd: 0.0087,
    usage: reportedUsage(counts),
    modelUsage: { [MODEL]: modelUsageRow(counts) },
    permission_denials: [],
    terminal_reason: TERMINAL_REASON[subtype],
    is_error: true,
    num_turns: 3,
    subtype,
    errors,
    type: 'result',
    duration_ms: 4100,
    uuid: 'e0000000-0000-4000-8000-0000000000ff'
  }
}

/** An API error after earlier model calls of the run: a `success` subtype with `is_error: true`. */
export function claudeApiErrorResult(
  result: string,
  apiErrorStatus: number,
  counts: ClaudeResultCounts = CLAUDE_ERROR_RESULT_COUNTS
): Record<string, unknown> {
  return {
    duration_api_ms: 61200,
    stop_reason: 'tool_use',
    session_id: SESSION,
    total_cost_usd: 0.0087,
    usage: reportedUsage(counts),
    modelUsage: { [MODEL]: modelUsageRow(counts) },
    permission_denials: [],
    terminal_reason: 'api_error',
    is_error: true,
    num_turns: 2,
    subtype: 'success',
    api_error_status: apiErrorStatus,
    result,
    type: 'result',
    duration_ms: 62800,
    uuid: 'e0000000-0000-4000-8000-0000000000fd'
  }
}

/** The session-crash result: the fixed all-zero usage and an empty `modelUsage`. */
export function claudeSessionCrashResult(errors: string[]): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: SESSION,
    total_cost_usd: 0,
    usage: usageTemplate(),
    modelUsage: {},
    permission_denials: [],
    uuid: 'e0000000-0000-4000-8000-0000000000fe',
    errors
  }
}
