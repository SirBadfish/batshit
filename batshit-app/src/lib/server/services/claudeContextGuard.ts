/**
 * Proactive context guard for Batshit-managed Claude Code CLI runs.
 *
 * Claude's stream-json output reports per-request token usage on every
 * top-level `assistant` event (`message.usage`), but never the model context
 * window. The guard reads that live usage, compares it against the resolved
 * context window (model preset → `[1m]` model suffix → Anthropic's standard
 * 200k window), and stops the child process gracefully before the window
 * fills mid-task.
 *
 * A guard stop surfaces as a thrown error whose message is classified by
 * `isContextExhaustionError`, so send-routed's partial-finalize +
 * auto-continue machinery takes over — the same recovery lane as a real
 * context-window failure, minus the wasted failed CLI run. This mirrors the
 * Codex app-server lane guard in `codexAppServerLane.ts`; Claude needs its own
 * usage source because the CLI has no app-server equivalent.
 */

import {
  CONTEXT_GUARD_CLASSIFIER_MARKER,
  DEFAULT_CONTEXT_GUARD_THRESHOLD,
  resolveManagedContextGuardThreshold,
} from './contextGuardPolicy'

export const DEFAULT_CLAUDE_CONTEXT_GUARD_THRESHOLD = DEFAULT_CONTEXT_GUARD_THRESHOLD

/**
 * Every model Claude Code exposes ships a 200k context window unless the
 * 1M-token beta is requested via a `[1m]` model suffix. Used when the agent's
 * model preset does not declare an explicit `contextWindow`.
 */
export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000
const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000

const CONTEXT_GUARD_ENV_VAR = 'BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD'

export interface ClaudeContextGuardConfig {
  contextWindow: number
  threshold: number
}

/**
 * Resolves the guard threshold from `BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD`.
 * Valid range is 0.5 ≤ t < 1; invalid values fail loudly.
 * Returns null (guard disabled) for explicit opt-out values like `off` or `0`.
 */
export function resolveClaudeContextGuardThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return resolveManagedContextGuardThreshold(env, CONTEXT_GUARD_ENV_VAR)
}

/**
 * Resolves the context window for a Claude CLI run. Precedence:
 * 1. Explicit positive `contextWindow` on the agent's model preset.
 * 2. A `[1m]` suffix on the resolved model string (Anthropic 1M-token beta).
 * 3. Anthropic's standard 200k window.
 */
export function resolveClaudeContextWindow(params: {
  presetContextWindow?: number | null
  model?: string | null
}): number {
  if (
    typeof params.presetContextWindow === 'number' &&
    Number.isFinite(params.presetContextWindow) &&
    params.presetContextWindow > 0
  ) {
    return params.presetContextWindow
  }
  if (typeof params.model === 'string' && params.model.toLowerCase().includes('[1m]')) {
    return CLAUDE_1M_CONTEXT_WINDOW
  }
  return DEFAULT_CLAUDE_CONTEXT_WINDOW
}

export function buildClaudeContextGuardStopMessage(details: {
  usedTokens: number
  contextWindow: number
  threshold: number
}): string {
  const pct = Math.round((details.usedTokens / details.contextWindow) * 100)
  return (
    `${CONTEXT_GUARD_CLASSIFIER_MARKER}: Claude context window usage reached ${pct}% ` +
    `(${details.usedTokens.toLocaleString()} of ${details.contextWindow.toLocaleString()} tokens) mid-task. ` +
    `The run was stopped gracefully before the model ran out of room.`
  )
}

function usageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Computes the live context fill from a stream-json `assistant` event.
 *
 * Anthropic usage semantics: the request's full context input is
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
 * (fresh + cache-read + cache-write are disjoint), and `output_tokens`
 * becomes part of the next request's input — so input + output is the
 * context occupied once this response lands.
 *
 * Returns null for non-assistant events, subagent sidechain events
 * (`parent_tool_use_id` set — those report the subagent's own context, not
 * the main thread's), and events without a usable usage payload.
 */
export function extractClaudeContextUsedTokens(event: any): number | null {
  if (!event || typeof event !== 'object' || event.type !== 'assistant') return null
  if (event.parent_tool_use_id) return null
  const usage = event.message?.usage
  if (!usage || typeof usage !== 'object') return null

  const inputTokens = usageNumber(usage.input_tokens)
  const cachedInputTokens = usageNumber(usage.cache_read_input_tokens)
  const cacheCreationInputTokens = (() => {
    const direct = usageNumber(usage.cache_creation_input_tokens)
    if (direct !== null) return direct
    const cacheCreation = usage.cache_creation
    if (!cacheCreation || typeof cacheCreation !== 'object') return null
    const values = Object.values(cacheCreation).filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    )
    if (values.length === 0) return null
    return values.reduce((sum, value) => sum + value, 0)
  })()
  const outputTokens = usageNumber(usage.output_tokens)

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    cacheCreationInputTokens === null &&
    outputTokens === null
  ) {
    return null
  }

  return (
    (inputTokens ?? 0) +
    (cachedInputTokens ?? 0) +
    (cacheCreationInputTokens ?? 0) +
    (outputTokens ?? 0)
  )
}

/**
 * Wraps the raw Claude CLI NDJSON event stream with the context guard.
 *
 * The triggering assistant event is always yielded BEFORE the guard trips, so
 * the event adapter has processed that partial work when the classified error
 * propagates. `onTrip` must stop the child process; the thrown error then
 * routes through the adapter into send-routed's context-exhaustion recovery.
 */
export async function* applyClaudeContextGuard(
  events: AsyncGenerator<any>,
  guard: ClaudeContextGuardConfig & {
    onTrip: (stopMessage: string) => void | Promise<void>
  },
): AsyncGenerator<any> {
  for await (const event of events) {
    yield event

    const usedTokens = extractClaudeContextUsedTokens(event)
    if (usedTokens === null) continue
    if (usedTokens < guard.contextWindow * guard.threshold) continue

    const stopMessage = buildClaudeContextGuardStopMessage({
      usedTokens,
      contextWindow: guard.contextWindow,
      threshold: guard.threshold,
    })
    console.warn('[ClaudeContextGuard] Context guard tripped', {
      usedTokens,
      contextWindow: guard.contextWindow,
      threshold: guard.threshold,
    })
    await guard.onTrip(stopMessage)
    throw new Error(stopMessage)
  }
}
