import { env } from '$env/dynamic/private'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import { findRetiredClaudeCliModel } from '$lib/data/claude-cli-models'
import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import {
  CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE, ClaudePlanSettingsError, claudePlanCliModelArg, claudePlanModelChoice,
  CLAUDE_PLAN_PARAMETERS, CLAUDE_PLAN_THINKING_MODELS, claudePlanEffortsFor, isClaudePlanConnection, isClaudePlanEffort, isClaudePlanSelection, readClaudePlanSettings,
  type ClaudePlanEffort, type ClaudePlanRunSettings, type ClaudePlanUnavailableCode
} from '$lib/utils/claudePlanConnection'

/**
 * SA-139 (D1): the one admission owner for the Claude plan connection. Every consumer (Primary turns,
 * Subagents, Workers, Compact, approval resumes) asks it before any provider cache, client or model
 * call. It reads; it never writes, refreshes a catalog, signs in or falls back to a paid connection.
 * The ChatGPT plan's admission (`chatgptPlanInference.ts`) is the pattern, not a shared identity.
 */
export class ClaudePlanError extends Error {
  /** A readable refusal: never a 500 (send-routed and Compact read it through `claudePlanHttpStatus`). */
  readonly status = 409
  constructor(public readonly code: ClaudePlanErrorCode, message: string) { super(message); this.name = 'ClaudePlanError' }
}
export type ClaudePlanErrorCode = 'connection_invalid' | 'connection_unavailable' | 'consumer_unsupported' |
  'setting_unsupported' | 'model_unavailable' | 'resume_connection_changed' |
  /** Compact on the plan (SA-139 P4): the summary passed its budget, so nothing was compacted. */
  'summary_output_limit' |
  /** Compact on the plan (BL-2368): Claude asked for a tool, so its words are no summary and nothing was compacted. */
  'summary_tool_call'

export function claudePlanHttpStatus(error: unknown): number | null {
  return error instanceof ClaudePlanError ? 409 : null
}

/** Primary covers every path that runs a Primary turn through the API loop (chats, group speakers, woken turns, App Actions as actor). */
export type ClaudePlanConsumer = 'primary' | 'subagent' | 'worker' | 'compact'
const CONSUMERS: ReadonlySet<string> = new Set<ClaudePlanConsumer>(['primary', 'subagent', 'worker', 'compact'])

export function assertClaudePlanConsumer(consumer: string): asserts consumer is ClaudePlanConsumer {
  if (!CONSUMERS.has(consumer)) throw new ClaudePlanError('consumer_unsupported',
    'The Claude plan connection runs Primary agent replies, Subagents, Workers and Compact only. Choose a separate API-compatible preset for this feature.')
}

/** Exact identity. A selection that half-names the connection (service without id, another id, another type) is a conflict. */
export function assertClaudePlanIdentity(connection?: ModelConnectionInfo | null): void {
  if (connection?.type !== 'direct' || connection.service !== CLAUDE_PLAN_SERVICE || connection.id !== CLAUDE_PLAN_CONNECTION_ID) {
    throw new ClaudePlanError('connection_invalid', 'This model selection names the Claude plan connection inconsistently. Choose the Claude plan connection again in Settings → Models.')
  }
}

export function assertClaudePlanModel(modelId?: string | null): string {
  const choice = claudePlanModelChoice(modelId)
  if (choice) return choice.value
  const retired = findRetiredClaudeCliModel(modelId)
  throw new ClaudePlanError('model_unavailable', retired
    ? `${retired.label} left Claude Code's model list on ${retired.leftOn}. Choose another model for this preset.`
    : 'That model is not offered for the Claude plan connection. Choose a model from its list in Settings → Models.')
}

/** The shared pure check (`readClaudePlanSettings`), as this owner's 409 refusal. */
function settingsOrRefuse(read: () => ClaudePlanRunSettings): ClaudePlanRunSettings {
  try { return read() } catch (error) {
    if (error instanceof ClaudePlanSettingsError) throw new ClaudePlanError('setting_unsupported', error.message)
    throw error
  }
}

/** Save: only the connection's own settings (D12), each checked against the model. Blank sends nothing; nothing is dropped silently. */
export function assertClaudePlanPresetSettings(settings: Record<string, unknown> | null | undefined, modelId: string): ClaudePlanRunSettings {
  return settingsOrRefuse(() => readClaudePlanSettings(settings, modelId, { where: 'preset' }))
}

/**
 * Run: the merged settings also carry the agent's own runtime keys (`isAgentRuntimeSettingKey`), which
 * are Batshit's, not the model's, and which the run never reads. The loop's own per-step provider
 * options are not user settings and never reach this check (D12 N2). Sampling fields from an agent
 * record's fallback copies count as saved settings (pass them only for a raw, no-preset selection).
 */
export function assertClaudePlanRunSettings(settings: Record<string, unknown> | null | undefined, modelId: string, sampling?: Record<string, unknown> | null): ClaudePlanRunSettings {
  return settingsOrRefuse(() => readClaudePlanSettings(settings, modelId, { where: 'run', allowKey: isAgentRuntimeSettingKey, sampling }))
}

export type { ClaudePlanUnavailableCode }

export type ClaudePlanReadiness =
  | { state: 'ready'; version?: string }
  | { state: 'unavailable'; code: ClaudePlanUnavailableCode; reason: string
      setupCommand?: string; statusCommand?: string; setupContext?: 'docker' | 'native'; setupWorkingDirectory?: string }

/**
 * SA-139: on since P3's flip, once the adapter, bridge and run registry (P2) and the mid-reply contracts (P3) were on main.
 * A build without the runtime (`runtimeBuilt: false`) refuses every run before any model call.
 */
export const CLAUDE_PLAN_RUNTIME_BUILT: boolean = true
const RUNTIME_UNAVAILABLE = 'Claude plan replies are not available in this Batshit build yet. Choose another connection for this agent.'
const DISABLED = 'Claude Code is turned off in this Batshit configuration (BATSHIT_CLAUDE_PROVIDER_ENABLED=false).'

export function claudePlanEnabled(): boolean { return env.BATSHIT_CLAUDE_PROVIDER_ENABLED !== 'false' }

/**
 * The refusal a model site throws for a Claude plan selection that reached it without the connection's own run
 * (the API brain's `getModel` with no admitted Claude plan model). It runs before any provider client is built,
 * whatever spelling the selection carries; the connection itself runs only through its adapter (Faye's flip read N2).
 */
export function claudePlanNotWiredError(): ClaudePlanError {
  return new ClaudePlanError('connection_unavailable', 'The Claude plan connection runs only through its own Claude Code run, not a provider client, so this path cannot start it. Nothing was sent.')
}

/**
 * Configuration only: no process, no status read. This is all an assignment owner checks
 * (`modelPresetSelectionOwner`); every run is re-admitted live (`claudePlanReadiness.ts`).
 * This module never imports the Claude Code readers, so the many modules that import
 * `providers` or `redis` do not reach it.
 */
export function claudePlanConfigurationReadiness(options: { enabled?: boolean; runtimeBuilt?: boolean } = {}): ClaudePlanReadiness {
  if (!(options.enabled ?? claudePlanEnabled())) return { state: 'unavailable', code: 'disabled', reason: DISABLED }
  if (!(options.runtimeBuilt ?? CLAUDE_PLAN_RUNTIME_BUILT)) return { state: 'unavailable', code: 'runtime_unavailable', reason: RUNTIME_UNAVAILABLE }
  return { state: 'ready' }
}

export interface ClaudePlanAdmission {
  readonly connectionId: typeof CLAUDE_PLAN_CONNECTION_ID
  readonly consumer: ClaudePlanConsumer
  readonly modelId: string
  /** The `--model` value, or null to omit it (CLI default). */
  readonly cliModel: string | null
  /** The `--effort` value, or null to omit it (N1). */
  readonly effort: ClaudePlanEffort | null
  /** `alwaysThinkingEnabled` for `--settings`, or null to leave Claude Code's default (only switchable models). */
  readonly alwaysThinking: boolean | null
}

/**
 * Raw, preset-backed and restored selections all pass here, in this order: identity, consumer, model,
 * settings, then current readiness. A refusal happens before any provider cache, client or process.
 */
export async function admitClaudePlanSelection(input: {
  connection?: ModelConnectionInfo | null
  modelId?: string | null
  settings?: Record<string, unknown> | null
  sampling?: Record<string, unknown> | null
  consumer: string
  /** The live reader (`readClaudePlanReadiness`), passed by the caller so this module stays light. */
  readiness: () => Promise<ClaudePlanReadiness>
}): Promise<ClaudePlanAdmission> {
  assertClaudePlanIdentity(input.connection)
  assertClaudePlanConsumer(input.consumer)
  const modelId = assertClaudePlanModel(input.modelId)
  const { effort, alwaysThinking } = assertClaudePlanRunSettings(input.settings, modelId, input.sampling)
  const readiness = await input.readiness()
  if (readiness.state !== 'ready') throw new ClaudePlanError('connection_unavailable', readiness.reason)
  return Object.freeze({ connectionId: CLAUDE_PLAN_CONNECTION_ID, consumer: input.consumer, modelId, cliModel: claudePlanCliModelArg(modelId), effort, alwaysThinking })
}

/**
 * Approval resume: a reply paused on the Claude plan resumes only on the Claude plan, and a reply
 * paused elsewhere never resumes on it. The held-run claim (D6, P3) still owns the run itself.
 */
export function assertClaudePlanApprovalSource(sourceConnectionId?: string | null, expectedConnectionId?: string | null): void {
  if (!isClaudePlanConnection(sourceConnectionId) && !isClaudePlanConnection(expectedConnectionId)) return
  if (sourceConnectionId !== CLAUDE_PLAN_CONNECTION_ID || expectedConnectionId !== CLAUDE_PLAN_CONNECTION_ID) {
    throw new ClaudePlanError('resume_connection_changed', 'This approval belongs to a reply on a different connection. It did not run. Ask the agent again.')
  }
}

/** The agent record's sampling copies (BL-515, `resolveAgentModelFallbacks`) and the words a person reads for each. */
const RAW_SAMPLING_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['primary_model_temperature', 'temperature'], ['primary_model_max_tokens', 'max tokens'], ['primary_model_top_p', 'top P'],
  ['primary_model_top_k', 'top K'], ['primary_model_frequency_penalty', 'frequency penalty'],
  ['primary_model_presence_penalty', 'presence penalty'], ['primary_model_seed', 'seed'], ['primary_model_stop_sequences', 'stop sequences']
]

/** Set, as admission reads it: `readClaudePlanSettings`'s `filled` for the settings block (an empty list is set there). */
const isFilled = (value: unknown) => value !== undefined && value !== null && value !== ''
/** A sampling copy is set as `claudePlanSamplingToCheck` hands it on: an empty list is unset. */
const isSet = (value: unknown) => isFilled(value) && !(Array.isArray(value) && value.length === 0)

/**
 * SA-139 (Faye S13, the lead's call 2026-10-27): a save that leaves an agent on the Claude plan connection with no
 * preset (a raw pick) removes every setting a run's admission would refuse, so the agent can run: the record's
 * sampling copies, the model keys of its settings block other than effort and Thinking (its own runtime keys stay),
 * and an effort or Thinking value the picked model cannot take. `block` is the settings block as this save leaves
 * it. Returns the top-level clears, the block keys to remove (`null`) and one sentence for the save's answer; null
 * when nothing needs removing. A preset pick never reaches here: it writes the preset's own values (BL-515), and a
 * Claude plan preset holds only what the connection takes. Any model save counts, a settings-block-only save too: a
 * model key it names on a raw Claude plan agent is removed with the note, never stored to be refused at every run
 * (Faye's S13 read, N1; by design).
 */
export function planClaudePlanRawSamplingClears(
  stored: Readonly<Record<string, unknown>> | null | undefined,
  updates: Readonly<Record<string, unknown>>,
  block?: Readonly<Record<string, unknown>> | null
): { clears: Record<string, null>; blockClears: Record<string, null>; fields: string[]; notice: string } | null {
  const value = (field: string) => Object.hasOwn(updates, field) ? updates[field] : stored?.[field]
  const presetId = value('primary_model_preset_id')
  if (typeof presetId === 'string' && presetId.trim()) return null
  if (!isClaudePlanSelection(value('primary_model_connection') as ModelConnectionInfo | null | undefined)) return null
  const clears: Record<string, null> = {}
  const blockClears: Record<string, null> = {}
  const words: string[] = []
  for (const [field, label] of RAW_SAMPLING_FIELDS) {
    if (!isSet(value(field))) continue
    clears[field] = null
    words.push(label)
  }
  const modelId = typeof value('primary_model_name') === 'string' ? String(value('primary_model_name')).trim() : ''
  for (const [key, setting] of Object.entries(block ?? {})) {
    if (!isFilled(setting) || isAgentRuntimeSettingKey(key)) continue
    const refused = !CLAUDE_PLAN_PARAMETERS.has(key) ||
      (key === 'anthropicEffort' && !(isClaudePlanEffort(setting) && claudePlanEffortsFor(modelId).includes(setting))) ||
      (key === 'claudePlanThinking' && !(typeof setting === 'boolean' && CLAUDE_PLAN_THINKING_MODELS.has(modelId)))
    if (!refused) continue
    blockClears[key] = null
    words.push(key === 'anthropicEffort' ? 'reasoning effort' : key === 'claudePlanThinking' ? 'Thinking setting' : `model setting "${key}"`)
  }
  if (!words.length) return null
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
  return { clears, blockClears, fields: [...Object.keys(clears), ...Object.keys(blockClears).map(key => `provider_specific_settings.${key}`)],
    notice: `The Claude plan connection cannot take the agent's ${list}, so this save removed ${words.length === 1 ? 'it' : 'them'}.` }
}
