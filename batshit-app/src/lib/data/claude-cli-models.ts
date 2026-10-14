/**
 * Official aliases/windows checked 2026-10-11:
 * https://code.claude.com/docs/en/model-config
 * Bounded subscription generations on isolated managed 2.1.296 report the
 * active model's result.modelUsage.contextWindow where identity matches.
 * BL-1337 admits the observed primary's suffixed [1m] result row (canonicalModel
 * vouched) and BL-1345 keeps it as the next run's guard baseline. Provider/1M-disable flags
 * still cap estimates through the shared resolver; runtime telemetry wins.
 */
const CLAUDE_CONTEXT_SOURCE = {
  contextWindowSource: 'https://code.claude.com/docs/en/model-config',
  contextWindowCheckedOn: '2026-10-11',
  contextWindowRuntime: 'claude-code 2.1.296'
} as const

export const CLAUDE_CLI_MODEL_CHOICES = [
  { value: 'opus', label: 'Opus (latest alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'best', label: 'Best (most capable alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'fable', label: 'Fable (long task alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 200_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'sonnet', label: 'Sonnet (latest alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'haiku', label: 'Haiku (latest alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'fable[1m]', label: 'Fable (1M alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'sonnet[1m]', label: 'Sonnet (1M alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'opus[1m]', label: 'Opus (1M alias)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'opusplan[1m]', label: 'Opus/Sonnet (plan/exe, 1M)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE },
  { value: 'opusplan', label: 'Opus/Sonnet (plan/exe)', contextWindow: 1_000_000, ...CLAUDE_CONTEXT_SOURCE }
] as const

export type ClaudeCliModelValue = (typeof CLAUDE_CLI_MODEL_CHOICES)[number]['value']

/** Concrete model IDs in CLI init/assistant events may not be picker aliases. */
export const CLAUDE_CLI_CONCRETE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-fable-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000
}

export type CliRetiredClaudeModel = { value: string; label: string; leftOn: string }

/**
 * BL-158 — every model Batshit's Claude CLI list once offered and no longer does (none so far:
 * nothing has left the list). The Codex list's rule applies: a stored model found here is
 * flagged in its settings and a run with it stops before Claude Code starts; a model id Batshit
 * never listed is never refused. When a model leaves `CLAUDE_CLI_MODEL_CHOICES`, add it here.
 */
export const CLAUDE_CLI_RETIRED_MODELS: ReadonlyArray<CliRetiredClaudeModel> = []

/** The retired entry for a stored Claude model, or null. */
export function findRetiredClaudeCliModel(model: string | null | undefined): CliRetiredClaudeModel | null {
  if (typeof model !== 'string') return null
  const value = model.trim()
  return CLAUDE_CLI_RETIRED_MODELS.find((entry) => entry.value === value) ?? null
}
