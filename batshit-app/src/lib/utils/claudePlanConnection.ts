import { CLAUDE_CLI_MODEL_CHOICES } from '$lib/data/claude-cli-models'
import { CLI_REASONING_EFFORTS, type CliReasoningEffort } from '$lib/data/cli-reasoning-contracts'

/**
 * SA-139 (D1): the Claude plan connection. An ordinary API connection whose model is the user's own
 * Claude Code, signed in through Anthropic's own flow. It is never the Claude Code CLI lane
 * (`claude-cli` / `anthropic-claude-cli`) and never the ChatGPT plan (`chatgpt-plan:<uuid>`).
 */
export const CLAUDE_PLAN_SERVICE = 'claude-plan'
export const CLAUDE_PLAN_CONNECTION_ID = 'claude-plan:local'
export const CLAUDE_PLAN_LABEL = 'Claude Plan'
export const CLAUDE_PLAN_USAGE_URL = 'https://claude.ai/settings/usage'
/**
 * Why the Claude plan connection cannot run now (server readiness, the card and pickers share it).
 * Claude Code's own facts: not installed, an executable that is not the qualified one
 * (`executable_unusable`), signed out, signed in some other way than a Claude plan (`not_plan`), or a
 * sign-in that does not show a plan or cannot be read (`status_unreadable`). Then this build's gates.
 */
export type ClaudePlanUnavailableCode = 'disabled' | 'runtime_unavailable' | 'not_installed' | 'executable_unusable' | 'signed_out' | 'not_plan' | 'status_unreadable'
/** "CLI default": Claude Code picks the model; the run sends no `--model` (D12 N3). */
export const CLAUDE_PLAN_DEFAULT_MODEL = 'default'
/** The user-saved preset settings the connection honors (D12). */
export const CLAUDE_PLAN_PARAMETERS: ReadonlySet<string> = new Set(['anthropicEffort', 'claudePlanThinking'])
/**
 * D12: per-model Thinking control, as data. Source: Claude Code model configuration
 * (https://code.claude.com/docs/en/model-config, read 2026-10-26) and the SA-139 P0 receipt §6.
 * Thinking can be turned off (`alwaysThinkingEnabled`) only on the models listed; on Opus 5.5,
 * Sonnet 5.5, Haiku 5.5 and Fable the model decides per step from the effort, so the setting is
 * refused there, as it is on aliases. No fixed thinking budget is offered anywhere: the documented
 * fixed-budget path (Opus 4.6 or Sonnet 4.6 with adaptive thinking disabled) is not qualified yet.
 */
export const CLAUDE_PLAN_THINKING_SOURCE = Object.freeze({ url: 'https://code.claude.com/docs/en/model-config', checkedOn: '2026-10-26', receipt: 'SA-139 P0 §6' })
export const CLAUDE_PLAN_THINKING_CONTROLS: Readonly<Record<string, { off: true; budget: null; evidence: 'docs' | 'docs and P0 run t7-opus-4-6-off' }>> = Object.freeze({
  'claude-opus-4-8': { off: true, budget: null, evidence: 'docs' },
  'claude-opus-4-6': { off: true, budget: null, evidence: 'docs and P0 run t7-opus-4-6-off' },
  'claude-sonnet-5': { off: true, budget: null, evidence: 'docs' }
})
export const CLAUDE_PLAN_THINKING_MODELS: ReadonlySet<string> = new Set(Object.keys(CLAUDE_PLAN_THINKING_CONTROLS))

/** The exact connection identity (not every spelling): only this one gets reasoning controls. */
export function isExactClaudePlanConnection(connection?: { type?: string | null; id?: string | null; service?: string | null } | null): boolean {
  return connection?.type === 'direct' && connection.id === CLAUDE_PLAN_CONNECTION_ID && connection.service === CLAUDE_PLAN_SERVICE
}
export const CLAUDE_PLAN_EFFORTS = CLI_REASONING_EFFORTS
export type ClaudePlanEffort = CliReasoningEffort

export type ClaudePlanModelChoice = { value: string; label: string; contextWindow: number | null }
export const CLAUDE_PLAN_MODEL_CHOICES: readonly ClaudePlanModelChoice[] = [
  { value: CLAUDE_PLAN_DEFAULT_MODEL, label: 'CLI default', contextWindow: null },
  ...CLAUDE_CLI_MODEL_CHOICES.map(({ value, label, contextWindow }) => ({ value, label, contextWindow }))
]

/**
 * Any spelling that names this connection (including `direct:claude-plan`, which the service lookup
 * reads as `claude-plan`), so a malformed or conflicting one is refused, never routed elsewhere.
 */
export function isClaudePlanConnection(connectionId?: string | null): boolean {
  const id = (connectionId?.trim().toLowerCase() ?? '').replace(/^direct:/, '')
  return id === CLAUDE_PLAN_SERVICE || id.startsWith(`${CLAUDE_PLAN_SERVICE}:`)
}

export function isClaudePlanSelection(connection?: { id?: string | null; service?: string | null } | null): boolean {
  return connection?.service?.trim().toLowerCase() === CLAUDE_PLAN_SERVICE || isClaudePlanConnection(connection?.id)
}

export function claudePlanModelChoice(modelId?: string | null): ClaudePlanModelChoice | null {
  const value = modelId?.trim() ?? ''
  return CLAUDE_PLAN_MODEL_CHOICES.find(choice => choice.value === value) ?? null
}

/** The `--model` value for an admitted model id, or null to omit the flag (CLI default). */
export function claudePlanCliModelArg(modelId: string): string | null {
  return modelId === CLAUDE_PLAN_DEFAULT_MODEL ? null : modelId
}

export function isClaudePlanEffort(value: unknown): value is ClaudePlanEffort {
  return typeof value === 'string' && (CLAUDE_PLAN_EFFORTS as readonly string[]).includes(value)
}

/**
 * Per-model effort limits, as data. Source: Claude Code 2.1.296's own recorded `initialize` model list
 * (`supportedEffortLevels`) and measured init events (SA-139 P2, 2026-10-27), not the docs: a new pin's
 * limits come from its recorded list. Every other offered model takes all five levels; aliases start a
 * model that does (opus → Opus 5.5, sonnet → Sonnet 5.5, fable → Fable 5.1, …). The run refuses a level
 * the started model does not take before any model call (P2's backstop).
 */
export const CLAUDE_PLAN_EFFORT_SOURCE = Object.freeze({ url: 'https://code.claude.com/docs/en/model-config#adjust-effort-level', checkedOn: '2026-10-27',
  measured: 'Claude Code 2.1.296 initialize model list and init events' })
export const CLAUDE_PLAN_EFFORT_LIMITS: Readonly<Record<string, readonly ClaudePlanEffort[]>> = Object.freeze({
  'claude-opus-4-6': Object.freeze(['low', 'medium', 'high', 'max'] as ClaudePlanEffort[])
})
export function claudePlanEffortsFor(modelId: string): readonly ClaudePlanEffort[] {
  return CLAUDE_PLAN_EFFORT_LIMITS[modelId] ?? CLAUDE_PLAN_EFFORTS
}

/** The reasoning-control adapter name for this connection (`reasoning-controls.ts`). */
export const CLAUDE_PLAN_REASONING_ADAPTER = 'claude-code'

/** A plan setting Claude Code cannot honor. Each caller turns it into its own refusal (409 at save and admission, the Send refusal in the preview). */
export class ClaudePlanSettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'ClaudePlanSettingsError' }
}
export type ClaudePlanRunSettings = { effort: ClaudePlanEffort | null; alwaysThinking: boolean | null }
const filled = (value: unknown) => value !== undefined && value !== null && value !== ''

/**
 * The one pure settings check (D12) for save, run admission, Send and the chat-bar preview. At save
 * only the connection's own settings pass; at run the agent's own runtime keys pass too
 * (`allowKey`), and any filled `sampling` value from an agent record's fallback copies is refused.
 * Blank sends nothing; zero is real; nothing is dropped silently.
 */
export function readClaudePlanSettings(settings: Record<string, unknown> | null | undefined, modelId: string,
  options: { where: 'preset' | 'run'; allowKey?: (key: string) => boolean; sampling?: Record<string, unknown> | null } = { where: 'preset' }): ClaudePlanRunSettings {
  const fix = options.where === 'preset' ? 'Clear that preset setting.' : 'Clear that setting on the preset or agent.'
  const unsupported = Object.entries(settings ?? {}).find(([key, value]) => filled(value) && !CLAUDE_PLAN_PARAMETERS.has(key) && !options.allowKey?.(key)) ??
    Object.entries(options.sampling ?? {}).find(([, value]) => filled(value))
  if (unsupported) throw new ClaudePlanSettingsError(`The Claude plan connection does not support ${unsupported[0]}. ${fix}`)
  const effort = settings?.anthropicEffort, thinking = settings?.claudePlanThinking
  if (filled(effort) && !isClaudePlanEffort(effort)) throw new ClaudePlanSettingsError('The saved reasoning effort is not one Claude Code accepts. Choose Low, Medium, High, Extra High or Max, or clear it.')
  if (filled(effort) && !claudePlanEffortsFor(modelId).includes(effort as ClaudePlanEffort)) {
    throw new ClaudePlanSettingsError(`Claude Code does not take ${effort === 'xhigh' ? 'Extra High' : effort} effort on ${modelId}. Choose another level, or clear it.`)
  }
  if (filled(thinking)) {
    if (!CLAUDE_PLAN_THINKING_MODELS.has(modelId)) throw new ClaudePlanSettingsError(`Claude Code cannot turn thinking on or off for ${modelId}: the model decides per step from the effort. Clear the Thinking setting.`)
    if (typeof thinking !== 'boolean') throw new ClaudePlanSettingsError('The saved Thinking choice is not On or Off. Choose one, or clear it.')
  }
  return { effort: filled(effort) ? effort as ClaudePlanEffort : null, alwaysThinking: filled(thinking) ? thinking as boolean : null }
}
