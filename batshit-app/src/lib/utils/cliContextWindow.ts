import { CLAUDE_CLI_CONCRETE_CONTEXT_WINDOWS, CLAUDE_CLI_MODEL_CHOICES } from '$lib/data/claude-cli-models'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'

export type CliContextRuntime = 'claude'
export type CliContextWindowReport = {
  runtime: CliContextRuntime
  /** The saved CLI selection, or `default` when the CLI chooses it. */
  model: string
  /** Actual model named by the CLI, when available (the selected value may be an alias). */
  actualModel?: string
  contextWindow: number | null
  evidence: 'runtime' | 'resolved' | 'unresolved'
  disableClaude1M?: boolean
  settingsKey?: string
  /** Server receipt time of this run's evidence, used only for warning ordering. */
  reportedAt?: number
}

export type CliContextWindowResolution = {
  contextWindow: number | null
  source: 'runtime' | 'preset' | 'choice' | 'unknown'
  model: string | null
}

/** Server-owned selection from the same preflight that built the primary send. */
export type CliContextSelection = {
  model: string | null
  presetContextWindow: number | null
  settingsKey: string | null
  priorReport: CliContextWindowReport | null
}

export type ClaudeContextEnvironment = { disable1M: boolean; externalRoute: boolean }

export function readClaudeContextEnvironment(env: NodeJS.ProcessEnv = process.env): ClaudeContextEnvironment {
  return {
    disable1M: env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1',
    externalRoute: Boolean(env.ANTHROPIC_BASE_URL || env.CLAUDE_CODE_USE_BEDROCK === '1' ||
      env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_FOUNDRY === '1')
  }
}

export function claudeContextCappedByFlags(
  model: string | null | undefined, flags?: ClaudeContextEnvironment | null
): boolean {
  return Boolean(flags?.disable1M || (flags?.externalRoute && !model?.toLowerCase().includes('[1m]')))
}

function positiveWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null
}

/** The same legacy/structured model fields the CLI settings builder reads. */
export function resolveCliModelFromSettings(
  runtime: CliContextRuntime, value: Record<string, any> | null | undefined
): string | null {
  if (!value || typeof value !== 'object') return null
  const structured = 'permissionMode' in value
  const raw = structured ? value.model : value[`${runtime}_model`]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export function resolveAgentCliModel(runtime: CliContextRuntime, agent: Record<string, any>): string | null {
  const settings = agent[`${runtime}_settings`]
  // Primary bridges launch the CLI default when its settings name no model;
  // the preset/primary model label names the transport, never an executable fallback.
  return resolveCliModelFromSettings(runtime, settings ?? agent.provider_specific_settings)
}

export function resolveEffectiveAgentCliModel(
  runtime: CliContextRuntime, agent: Record<string, any>,
  selectedSettings?: Record<string, any> | null, selectedModelId?: string | null
): string | null {
  return resolveAgentCliModel(runtime, {
    ...agent,
    provider_specific_settings: selectedSettings ?? agent.provider_specific_settings,
    primary_model_name: selectedModelId ?? agent.primary_model_name
  })
}

/** A changed CLI selection or preset cannot inherit a prior run's limit. */
export function cliContextSettingsKey(
  runtime: CliContextRuntime, agent: Record<string, any>, presetContextWindow?: number | null,
  selectedSettings?: Record<string, any> | null, selectedModelId?: string | null
): string | null {
  return JSON.stringify({
    runtime,
    model: resolveEffectiveAgentCliModel(runtime, agent, selectedSettings, selectedModelId),
    presetId: agent.primary_model_preset_id ?? null,
    presetContextWindow: positiveWindow(presetContextWindow),
    // Claude takes no context override; the empty list keeps the key of a saved report the same.
    contextOverrides: []
  })
}

/** A null/missing key is deliberately never reusable, even against another null. */
export function matchingCliContextReport(
  report: CliContextWindowReport | null | undefined, key: string | null
): CliContextWindowReport | null {
  if (!key || !report?.settingsKey) return null
  return report.settingsKey === key ? report : null
}

export function reportForCliSnapshot(
  report: CliContextWindowReport, agent: Record<string, any>, presetContextWindow?: number | null,
  selectedSettings?: Record<string, any> | null, selectedModelId?: string | null
): CliContextWindowReport {
  const { settingsKey: _untrustedKey, ...safeReport } = report
  const key = cliContextSettingsKey(
    report.runtime, agent, presetContextWindow, selectedSettings, selectedModelId
  )
  return key ? { ...safeReport, settingsKey: key } : safeReport
}

export function latestCliContextSnapshot<T extends Pick<ExecutionSnapshot, 'agentId' | 'createdAt' | 'runtime'>>(
  snapshots: T[],
  agentId: string | null | undefined, runtime: CliContextRuntime
): T | null {
  if (!agentId) return null
  return [...snapshots]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .find((snapshot) => snapshot.agentId === agentId && snapshot.runtime?.runtimeId === runtime) ?? null
}

export function latestCliContextReport(
  snapshots: Pick<ExecutionSnapshot, 'agentId' | 'createdAt' | 'runtime'>[],
  agentId: string | null | undefined, runtime: CliContextRuntime
): CliContextWindowReport | null {
  const latest = latestCliContextSnapshot(snapshots, agentId, runtime)
  const report = latest?.runtime?.metadata?.cliContextWindow
  return report && typeof report === 'object' ? report as CliContextWindowReport : null
}

export function claudeContextCappedByEnvironment(
  model: string | null | undefined, env: NodeJS.ProcessEnv = process.env
): boolean {
  return claudeContextCappedByFlags(model, readClaudeContextEnvironment(env))
}

function chosenWindow(model: string): number | null {
  const choices: readonly { value: string; contextWindow?: number }[] = CLAUDE_CLI_MODEL_CHOICES
  return positiveWindow(choices.find((choice) => choice.value === model)?.contextWindow) ??
    positiveWindow(CLAUDE_CLI_CONCRETE_CONTEXT_WINDOWS[model])
}

/** The generic CLI preset is a transport; the actual model is chosen in CLI settings. */
export function resolveCliContextWindow(params: {
  runtime: CliContextRuntime
  model?: string | null
  presetContextWindow?: number | null
  reported?: CliContextWindowReport | null
  disableClaude1M?: boolean
}): CliContextWindowResolution {
  const model = typeof params.model === 'string' && params.model.trim()
    ? params.model.trim()
    : null
  const reported = params.reported
  if (
    reported?.runtime === params.runtime && reported.model === (model ?? 'default') &&
    reported.evidence === 'unresolved'
  ) return { contextWindow: null, source: 'unknown', model }
  if (
    reported?.runtime === params.runtime && reported.model === (model ?? 'default') &&
    reported.evidence === 'runtime' && positiveWindow(reported.contextWindow) !== null
  ) {
    return { contextWindow: positiveWindow(reported.contextWindow), source: 'runtime', model }
  }
  const preset = positiveWindow(params.presetContextWindow)
  const choice = reported?.runtime === params.runtime && reported.model === (model ?? 'default') &&
    reported.evidence === 'resolved' && reported.actualModel
      ? positiveWindow(reported.contextWindow)
      : model ? chosenWindow(model) : null
  const contextWindow = preset ?? choice
  if (contextWindow === null) return { contextWindow: null, source: 'unknown', model }
  return {
    contextWindow: params.disableClaude1M || reported?.disableClaude1M
      ? Math.min(contextWindow, 200_000)
      : contextWindow,
    source: preset !== null ? 'preset' : 'choice',
    model
  }
}
