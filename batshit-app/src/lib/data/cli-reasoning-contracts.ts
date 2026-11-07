import type { ModelReasoningDescriptor, ReasoningControlSelection } from '$lib/types/reasoningControls'

export type CliReasoningRuntime = 'claude'
export const CLI_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CliReasoningEffort = (typeof CLI_REASONING_EFFORTS)[number]

export interface ClaudeReasoningRouting {
  status: 'verified' | 'unverified'
  firstPartyAliases: boolean
  reason?: string
}

export interface CliReasoningContract {
  status: 'verified' | 'unverified'
  runtime: CliReasoningRuntime
  runtimeVersion: string | null
  requestedModel: string
  effectiveModelId: string | null
  /** Published model support does not establish this installation's account/policy limits. */
  accountLimits: 'unknown'
  descriptor: ModelReasoningDescriptor | null
  unqualifiedValues: string[]
  thinkingPolicy: 'always-on' | 'switchable' | 'unverified'
  reason?: string
}

const CHECKED_AT = '2026-10-14'
const CLAUDE_SOURCE = 'https://code.claude.com/docs/en/model-config#adjust-effort-level'
const CLAUDE_ALL_EFFORT_MODELS = new Set([
  'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5',
  'claude-sonnet-5-5', 'claude-haiku-5-5'
])
const CLAUDE_NO_XHIGH_MODELS = new Set(['claude-opus-4-6', 'claude-sonnet-4-6'])
const CLAUDE_MEDIUM_DEFAULT = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
const CLAUDE_ALWAYS_THINKING_MODELS = new Set([
  'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'
])

/** Exact stable versions only: a newer/prerelease binary is not qualified by a pinned rule. */
function stableVersion(text: string | null | undefined): string | null {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?=\s|$)/.exec(text ?? '')
  return match?.[1] ?? null
}

export function resolveCliReasoningContract(args: {
  runtime: CliReasoningRuntime
  model: string | null | undefined
  version?: string | null
  /** Aliases vary by provider and environment. Omit unless that resolution is established. */
  firstPartyClaudeAliases?: boolean
  /** Local route admission is required even for an exact Claude model ID. */
  claudeRouting?: ClaudeReasoningRouting
}): CliReasoningContract {
  const runtimeVersion = stableVersion(args.version)
  const requestedModel = args.model?.trim() ?? ''
  const result: CliReasoningContract = {
    status: 'unverified', runtime: args.runtime, runtimeVersion, requestedModel,
    effectiveModelId: null, accountLimits: 'unknown', descriptor: null, unqualifiedValues: [], thinkingPolicy: 'unverified'
  }
  const unknown = (reason: string) => ({ ...result, reason })
  let model = requestedModel
  if (args.claudeRouting?.status !== 'verified') {
    return unknown(args.claudeRouting?.reason ?? 'The effective Claude connection has not been verified for reasoning controls.')
  }
  if (runtimeVersion !== '2.1.283' && runtimeVersion !== '2.1.296') {
    return unknown('Reasoning choices have not been verified for this Claude Code version.')
  }
  if (model.endsWith('[1m]')) model = model.slice(0, -4)
  const aliases: Record<string, string> = {
    opus: 'claude-opus-5-5', fable: 'claude-fable-5-1',
    sonnet: runtimeVersion === '2.1.296' ? 'claude-sonnet-5-5' : 'claude-sonnet-5',
    haiku: runtimeVersion === '2.1.296' ? 'claude-haiku-5-5' : 'claude-haiku-4-5'
  }
  if (Object.hasOwn(aliases, model)) {
    if (!args.claudeRouting.firstPartyAliases || args.firstPartyClaudeAliases === false) return unknown('Claude model aliases need the actual provider/model identity before their reasoning choices can be verified.')
    model = aliases[model]
  }
  if (runtimeVersion === '2.1.283' && (model === 'claude-sonnet-5-5' || model === 'claude-haiku-5-5')) {
    return unknown('This model requires a newer Claude Code version than the installed reasoning contract.')
  }
  if (!CLAUDE_ALL_EFFORT_MODELS.has(model) && !CLAUDE_NO_XHIGH_MODELS.has(model)) {
    return unknown('Reasoning choices have not been verified for this exact Claude Code model.')
  }
  const values = [...CLI_REASONING_EFFORTS].filter(value => value !== 'xhigh' || !CLAUDE_NO_XHIGH_MODELS.has(model))
  const defaultValue = CLAUDE_MEDIUM_DEFAULT.has(model) ? 'medium' : model === 'claude-opus-4-7' ? 'xhigh' : 'high'
  return {
    ...result, status: 'verified', effectiveModelId: model,
    thinkingPolicy: CLAUDE_ALWAYS_THINKING_MODELS.has(model) ? 'always-on' : 'switchable',
    descriptor: {
      version: 1, connection: `${args.runtime}-cli`, effectiveModelId: model,
      endpoint: `${args.runtime}-cli:${runtimeVersion}`,
      controls: [{ id: 'effort', kind: 'effort', values, defaultValue }],
      evidence: [{ url: CLAUDE_SOURCE, checkedAt: CHECKED_AT }], lastVerified: CHECKED_AT
    }
  }
}

export class CliReasoningSettingError extends Error {
  readonly status = 422
  readonly code = 'CLI_REASONING_UNVERIFIED'
  constructor(message: string) { super(message); this.name = 'CliReasoningSettingError' }
}

/**
 * Claude applies filtered settings.env over its inherited environment. Filters can withhold a
 * tier, so a later apparent default cannot prove an earlier custom route inactive. Inspect
 * only known non-secret routing/capability keys and retain uncertainty from every input tier.
 * null means an admitted reader proved the managed file absent; undefined means unknown.
 */
export function resolveClaudeReasoningRouting(args: {
  sourceEnv: Record<string, unknown>
  runtimeEnv?: Record<string, unknown>
  managedSettings: Record<string, unknown> | null | undefined
  configOverrides?: readonly { key: string; value: string }[]
}): ClaudeReasoningRouting {
  const unknown = (): ClaudeReasoningRouting => ({ status: 'unverified', firstPartyAliases: false,
    reason: 'Reasoning controls have not been verified for this Claude connection or its custom model configuration.' })
  if (args.managedSettings === undefined) return unknown()
  const settingsEnv = args.managedSettings?.env
  if (settingsEnv !== undefined && (!settingsEnv || typeof settingsEnv !== 'object' || Array.isArray(settingsEnv))) return unknown()
  const providerFlags = new Set([
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
    'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'
  ])
  const isRoutingKey = (key: string) => providerFlags.has(key) ||
    ['ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_CLIENT_DATA_URL',
      'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES'].includes(key) ||
    /^ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU|FABLE)_MODEL(?:_SUPPORTED_CAPABILITIES)?$/.test(key)
  const pendingEnv: Record<string, unknown> = {}
  for (const row of args.configOverrides ?? []) {
    if (!row.key.toLowerCase().startsWith('env.')) continue
    const key = row.key.slice(4)
    if (!isRoutingKey(key.toUpperCase())) continue
    let value: unknown = row.value
    try { value = JSON.parse(row.value) } catch { /* Unquoted custom config values are strings. */ }
    pendingEnv[key] = value
  }
  for (const layer of [args.sourceEnv, args.runtimeEnv ?? {}, settingsEnv ?? {}, pendingEnv]) {
    for (const rawKey of Object.keys(layer)) {
      const key = rawKey.toUpperCase()
      if (!isRoutingKey(key)) continue
      const value = (layer as Record<string, unknown>)[rawKey]
      if (value === undefined) continue
      if (providerFlags.has(key)) {
        if (typeof value !== 'string' || !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase())) return unknown()
      } else if (key === 'ANTHROPIC_BASE_URL') {
        if (typeof value !== 'string' || value && value.replace(/\/$/, '') !== 'https://api.anthropic.com') return unknown()
      } else if (key === 'ANTHROPIC_UNIX_SOCKET' || key === 'CLAUDE_CODE_CLIENT_DATA_URL' ||
        /^ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU|FABLE)_MODEL(?:_SUPPORTED_CAPABILITIES)?$/.test(key) ||
        key === 'ANTHROPIC_CUSTOM_MODEL_OPTION' || key === 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES') {
        if (value !== '') return unknown()
      }
    }
  }
  return { status: 'verified', firstPartyAliases: true }
}

/** Process-only hint retained for callers that do not claim complete local route admission. */
export function hasDefaultFirstPartyClaudeAliases(sourceEnv: Record<string, string | undefined>): boolean {
  return resolveClaudeReasoningRouting({ sourceEnv, managedSettings: null }).status === 'verified'
}

/** No selection preserves legacy settings. Explicit default must survive as a runtime marker. */
export function readCliReasoningSelection(value: unknown): ReasoningControlSelection | undefined {
  if (value === undefined) return undefined
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const selection = value as Record<string, unknown>
    if (selection.mode === 'provider-default' && Object.keys(selection).length === 1) return { mode: 'provider-default' }
    if (selection.mode === 'value' && Object.keys(selection).length === 2 &&
      typeof selection.value === 'string' && CLI_REASONING_EFFORTS.includes(selection.value as CliReasoningEffort)) {
      return { mode: 'value', value: selection.value }
    }
  }
  throw new CliReasoningSettingError('The saved CLI reasoning choice is not verified. Choose a supported effort or Use agent default in Agent Settings.')
}

export function resolveCliReasoningEffort(legacy: unknown, selection?: ReasoningControlSelection): string | undefined {
  if (selection?.mode === 'provider-default') return undefined
  if (selection?.mode === 'value') return String(selection.value)
  if (legacy === 'default' || legacy === undefined || legacy === null || legacy === '') return undefined
  // Keep unknown saved literals visible until the run can refuse them; never silently lower/drop them.
  return typeof legacy === 'string' ? legacy : undefined
}

/** Refuse a cap already present in our managed file; unknown external/account caps stay unknown. */
export function assertClaudeReasoningCap(args: { model?: string | null; selection?: ReasoningControlSelection; settings: Record<string, unknown> }): void {
  if (args.selection?.mode !== 'value' || typeof args.selection.value !== 'string') return
  let cap = args.settings.maxEffortLevel
  const byModel = args.settings.modelSettings
  const model = args.model?.replace(/\[1m\]$/, '')
  if (model && byModel && typeof byModel === 'object' && !Array.isArray(byModel)) {
    const entry = (byModel as Record<string, unknown>)[model]
    if (entry && typeof entry === 'object' && !Array.isArray(entry) &&
      Object.hasOwn(entry, 'maxEffortLevel')) cap = (entry as Record<string, unknown>).maxEffortLevel
  }
  if (typeof cap !== 'string' || !CLI_REASONING_EFFORTS.includes(cap as CliReasoningEffort)) return
  if (CLI_REASONING_EFFORTS.indexOf(args.selection.value as CliReasoningEffort) > CLI_REASONING_EFFORTS.indexOf(cap as CliReasoningEffort)) {
    throw new CliReasoningSettingError(`The managed Claude settings cap effort at ${cap}. Choose ${cap} or below in Agent Settings. The saved choice was kept.`)
  }
}

/** Read-only check of the existing managed file after the actual runtime resolved its model. */
export function assertClaudeReasoningConfiguration(args: {
  model?: string | null
  version?: string | null
  firstPartyClaudeAliases?: boolean
  claudeRouting?: ClaudeReasoningRouting
  selection?: ReasoningControlSelection
  settings: Record<string, unknown>
}): void {
  if (args.selection?.mode !== 'value') return
  const configuredRouting = resolveClaudeReasoningRouting({ sourceEnv: {}, managedSettings: args.settings })
  const claudeRouting = configuredRouting.status === 'unverified' ? configuredRouting : args.claudeRouting
  const contract = resolveCliReasoningContract({ ...args, model: args.model, claudeRouting, runtime: 'claude' })
  if (contract.status !== 'verified' || !contract.effectiveModelId) {
    throw new CliReasoningSettingError('The Claude model identity is not verified, so its configured effort limits cannot be checked. Choose a verified exact model or Use agent default in Agent Settings.')
  }
  const environment = args.settings.env
  const configuredEffort = environment && typeof environment === 'object' && !Array.isArray(environment)
    ? (environment as Record<string, unknown>).CLAUDE_CODE_EFFORT_LEVEL : undefined
  if (configuredEffort !== undefined && configuredEffort !== args.selection.value) {
    throw new CliReasoningSettingError('The managed Claude configuration sets CLAUDE_CODE_EFFORT_LEVEL, which would override this effort. Change that manual setting or choose Runtime default in Agent Settings. The configuration and saved choice were kept.')
  }
  // Native Claude canonicalizes modelSettings keys too. Resolve known aliases before looking
  // up a cap and take the lowest matching per-model cap within this one settings file.
  const matchingCaps: string[] = []
  const byModel = args.settings.modelSettings
  if (byModel && typeof byModel === 'object' && !Array.isArray(byModel)) {
    for (const [key, entry] of Object.entries(byModel)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const cap = (entry as Record<string, unknown>).maxEffortLevel
      if (typeof cap !== 'string' || !CLI_REASONING_EFFORTS.includes(cap as CliReasoningEffort)) continue
      const resolved = resolveCliReasoningContract({ runtime: 'claude', model: key, version: args.version,
        firstPartyClaudeAliases: args.firstPartyClaudeAliases, claudeRouting })
      if (resolved.effectiveModelId === contract.effectiveModelId) matchingCaps.push(cap)
    }
  }
  matchingCaps.sort((a, b) => CLI_REASONING_EFFORTS.indexOf(a as CliReasoningEffort) - CLI_REASONING_EFFORTS.indexOf(b as CliReasoningEffort))
  assertClaudeReasoningCap({ model: contract.effectiveModelId, selection: args.selection,
    settings: { ...args.settings, modelSettings: matchingCaps.length ? {
      [contract.effectiveModelId]: { maxEffortLevel: matchingCaps[0] }
    } : undefined } })
}

export function assertCliReasoningEffort(args: Parameters<typeof resolveCliReasoningContract>[0] & {
  effort?: string
  selection?: ReasoningControlSelection
  thinkingEnabled?: boolean
}): void {
  if (!args.effort) return
  // Existing low-through-xhigh runs retain their old admission until the user chooses the new control.
  if (args.selection === undefined && ['low', 'medium', 'high', 'xhigh'].includes(args.effort)) return
  const contract = resolveCliReasoningContract(args)
  const control = contract.descriptor?.controls.find(control => control.id === 'effort')
  if (contract.status !== 'verified' || control?.kind !== 'effort' || !control.values.includes(args.effort)) {
    throw new CliReasoningSettingError(
      `Claude Code reasoning effort "${args.effort}" is not verified for ${args.model || 'the runtime default model'} on ${args.version || 'an unknown CLI version'}. ` +
      'Choose a supported effort or Use agent default in Agent Settings. The saved choice was kept.'
    )
  }
  if (args.selection && args.thinkingEnabled === false &&
    contract.effectiveModelId === 'claude-opus-5' && ['xhigh', 'max'].includes(args.effort)) {
    throw new CliReasoningSettingError('Claude Opus 5 cannot use this effort with Thinking off. Turn Thinking on or choose High or below in Agent Settings. The saved choice was kept.')
  }
}
