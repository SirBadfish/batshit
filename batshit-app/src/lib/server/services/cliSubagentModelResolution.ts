import type { SubagentRow } from '$lib/types/database'

export type CliSubagentRuntime = 'codex' | 'claude'

const CODEX_MODEL_SENTINELS = new Set(['codex', 'codex-cli', 'codex/codex-cli'])
const CLAUDE_MODEL_SENTINELS = new Set(['claude', 'claude-cli', 'claude/claude-cli'])

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeCliSubagentProviderHint(subagent: Pick<
  SubagentRow,
  'primary_model_provider' | 'primary_model_name' | 'model'
>): string {
  const provider = normalizeString(subagent.primary_model_provider).toLowerCase()
  const model =
    normalizeString(subagent.primary_model_name).toLowerCase() ||
    normalizeString(subagent.model).toLowerCase()
  return `${provider} ${model}`.trim()
}

export function resolveCliSubagentRuntime(
  subagent: Pick<SubagentRow, 'primary_model_provider' | 'primary_model_name' | 'model'>
): CliSubagentRuntime | null {
  const hint = normalizeCliSubagentProviderHint(subagent)
  if (!hint) return null
  if (hint.includes('codex')) return 'codex'
  if (hint.includes('claude-cli') || hint.includes('claude')) return 'claude'
  return null
}

export function normalizeCliRuntimeModel(
  runtime: CliSubagentRuntime,
  value: unknown
): string | null {
  const trimmed = normalizeString(value)
  if (!trimmed) return null

  const lowered = trimmed.toLowerCase()
  const sentinelSet =
    runtime === 'codex' ? CODEX_MODEL_SENTINELS : CLAUDE_MODEL_SENTINELS

  if (sentinelSet.has(lowered)) {
    return null
  }

  return trimmed
}

export function resolveCliSubagentExecutableModel(
  subagent: Pick<
    SubagentRow,
    | 'primary_model_name'
    | 'model'
    | 'provider_specific_settings'
    | 'codex_settings'
    | 'claude_settings'
  >,
  runtime: CliSubagentRuntime
): string | null {
  const providerSettings =
    subagent.provider_specific_settings &&
    typeof subagent.provider_specific_settings === 'object'
      ? subagent.provider_specific_settings
      : null

  const candidates =
    runtime === 'codex'
      ? [
          subagent.codex_settings?.model,
          providerSettings?.codex_model,
          subagent.primary_model_name,
          subagent.model,
        ]
      : [
          subagent.claude_settings?.model,
          providerSettings?.claude_model,
          subagent.primary_model_name,
          subagent.model,
        ]

  for (const candidate of candidates) {
    const resolved = normalizeCliRuntimeModel(runtime, candidate)
    if (resolved) return resolved
  }

  return null
}
