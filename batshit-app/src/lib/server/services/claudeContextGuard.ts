/**
 * Proactive context guard for Batshit-managed Claude Code CLI runs.
 *
 * Claude's stream-json output reports per-request token usage on every
 * top-level `assistant` event (`message.usage`), but never the model context
 * window. The guard reads that live usage, compares it against the resolved
 * window for the actual model and stops the child process gracefully before the window
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
import { resolveCliContextWindow, type CliContextWindowReport } from '$lib/utils/cliContextWindow'

export const DEFAULT_CLAUDE_CONTEXT_GUARD_THRESHOLD = DEFAULT_CONTEXT_GUARD_THRESHOLD

const CONTEXT_GUARD_ENV_VAR = 'BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD'

export interface ClaudeContextGuardConfig {
  contextWindow: number | null
  threshold: number | null
  model?: string | null
  presetContextWindow?: number | null
  disableClaude1M?: boolean
  /** Matching saved runtime evidence; init never turns this into fresh telemetry. */
  reported?: CliContextWindowReport | null
  onReport?: (report: CliContextWindowReport) => void
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
 * 1. Matching runtime evidence.
 * 2. Explicit positive preset, then verified choice. Unknown stays unknown.
 */
export function resolveClaudeContextWindow(params: {
  presetContextWindow?: number | null
  model?: string | null
  disableClaude1M?: boolean
  reported?: CliContextWindowReport | null
}): number | null {
  return resolveCliContextWindow({
    runtime: 'claude', model: params.model,
    presetContextWindow: params.presetContextWindow,
    disableClaude1M: params.disableClaude1M,
    reported: params.reported
  }).contextWindow
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

/** Only a unique row bound to this run's observed primary identity is telemetry. */
function primaryResultWindow(event: any, actualModel: string, initializedModel: string | null): number | null {
  if (event.parent_tool_use_id) return null
  const usage = event.modelUsage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null

  const keys = [actualModel]
  // The captured CLI shape names the extended model in init, then its base in
  // assistant. canonicalModel must vouch for that same base; it is never enough
  // to admit an unobserved key or an earlier, different primary model.
  if (initializedModel === `${actualModel}[1m]`) keys.push(initializedModel)
  const rows = keys.filter(key => Object.hasOwn(usage, key))
  if (rows.length !== 1) return null
  const key = rows[0]
  const row = usage[key]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  if (key !== actualModel && row.canonicalModel !== actualModel) return null
  if (key === actualModel && row.canonicalModel !== undefined && row.canonicalModel !== actualModel) return null

  const window = row.contextWindow
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return null
  const rounded = Math.round(window)
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null
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
  let actualModel: string | null = null
  let initializedModel: string | null = null
  let contextWindow = guard.contextWindow
  let runtimeReport = guard.reported ?? null
  const requestedModel = guard.model?.trim() || 'default'
  const noteModel = (value: unknown, fromInit = false) => {
    if (typeof value !== 'string' || !value.trim()) return
    actualModel = value.trim()
    const savedModel = runtimeReport?.actualModel
    // Saved evidence names the assistant's base model, while the captured CLI shape
    // initializes `<base>[1m]`. Only that exact top-level init keeps it; the
    // base-name assistant then matches it exactly, and anything else discards it.
    const sameIdentity = typeof savedModel === 'string' && savedModel !== '' &&
      (savedModel === actualModel || (fromInit && `${savedModel}[1m]` === actualModel))
    if (runtimeReport?.runtime === 'claude' && runtimeReport.evidence === 'runtime' && runtimeReport.model === requestedModel &&
      sameIdentity && Boolean(runtimeReport.disableClaude1M) === Boolean(guard.disableClaude1M)) {
      contextWindow = resolveClaudeContextWindow({ model: guard.model, presetContextWindow: guard.presetContextWindow,
        reported: runtimeReport, disableClaude1M: guard.disableClaude1M })
      return
    }
    runtimeReport = null
    const requestedFamily = requestedModel.toLowerCase().replace(/\[1m\]/g, '').replace(/[^a-z0-9]/g, '')
    const actualFamily = actualModel.toLowerCase().replace(/[^a-z0-9]/g, '')
    contextWindow = resolveClaudeContextWindow({
      presetContextWindow: guard.presetContextWindow,
      // The CLI can name the concrete base model in init even when an explicit
      // `[1m]` selection requested the extended window for that same model.
      model: requestedModel.toLowerCase().includes('[1m]') &&
        actualFamily.includes(requestedFamily)
          ? requestedModel : actualModel,
      disableClaude1M: guard.disableClaude1M
    })
    guard.onReport?.({
      runtime: 'claude', model: requestedModel, actualModel, contextWindow,
      evidence: contextWindow === null ? 'unresolved' : 'resolved',
      disableClaude1M: guard.disableClaude1M
    })
  }
  for await (const event of events) {
    if (event?.type === 'system' && event.subtype === 'init' && !event.parent_tool_use_id) {
      initializedModel = typeof event.model === 'string' && event.model.trim() ? event.model.trim() : null
      noteModel(event.model, true)
    }
    if (event?.type === 'assistant' && !event.parent_tool_use_id) noteModel(event.message?.model)
    if (event?.type === 'result' && actualModel) {
      const window = primaryResultWindow(event, actualModel, initializedModel)
      if (window !== null) {
        contextWindow = window
        runtimeReport = {
          runtime: 'claude', model: requestedModel, actualModel, contextWindow,
          evidence: 'runtime', disableClaude1M: guard.disableClaude1M
        }
        guard.onReport?.(runtimeReport)
      }
    }
    yield event

    if (guard.threshold === null || contextWindow === null) continue
    const usedTokens = extractClaudeContextUsedTokens(event)
    if (usedTokens === null) continue
    if (usedTokens < contextWindow * guard.threshold) continue

    const stopMessage = buildClaudeContextGuardStopMessage({
      usedTokens,
      contextWindow,
      threshold: guard.threshold,
    })
    console.warn('[ClaudeContextGuard] Context guard tripped', {
      usedTokens,
      contextWindow,
      threshold: guard.threshold,
    })
    await guard.onTrip(stopMessage)
    throw new Error(stopMessage)
  }
}
