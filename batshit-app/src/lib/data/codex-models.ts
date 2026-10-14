/**
 * Official roster checked 2026-10-04: https://learn.chatgpt.com/docs/models
 * Usable windows measured on the isolated managed 0.160.0 binary via
 * thread/tokenUsage/updated.modelContextWindow, not the API model maximum.
 * Positive per-run telemetry remains authoritative in cliContextWindow.ts.
 */
const CODEX_CONTEXT_SOURCE = {
  contextWindowSource: 'https://learn.chatgpt.com/docs/models',
  contextWindowCheckedOn: '2026-10-04',
  contextWindowRuntime: 'codex-cli 0.160.0'
} as const

export const CODEX_SUBMODEL_CHOICES = [
  { value: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-6-luna', label: 'GPT-6 Luna', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
  { value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 258_400, ...CODEX_CONTEXT_SOURCE },
] as const

/**
 * BL-158 (Josh's option A, 2026-09-26) — every model Batshit's Codex list once offered and no
 * longer does, with the day it left the list (from the file's git history). An agent or
 * Subagent saved before a model left keeps it: its settings flag it, and a run with it stops
 * before Codex starts with a Batshit message naming the setting to change, instead of Codex's
 * raw error. A model id Batshit never listed is not here and is never refused (someone may
 * have typed it on purpose). When a model leaves `CODEX_SUBMODEL_CHOICES`, add it here.
 */
export const CODEX_RETIRED_MODELS: ReadonlyArray<CliRetiredModel> = [
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', leftOn: '2026-09-18' },
  { value: 'gpt-5.4', label: 'GPT-5.4', leftOn: '2026-09-06' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', leftOn: '2026-09-06' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', leftOn: '2026-06-07' },
  { value: 'gpt-5.2', label: 'GPT-5.2', leftOn: '2026-06-07' },
  { value: 'gpt-5', label: 'GPT-5', leftOn: '2026-04-28' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex', leftOn: '2026-04-28' },
  { value: 'gpt-5-codex-mini', label: 'GPT-5 Codex Mini', leftOn: '2026-04-28' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini', leftOn: '2026-04-28' },
  { value: 'gpt-5.1', label: 'GPT-5.1', leftOn: '2026-04-28' },
  { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', leftOn: '2026-04-28' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', leftOn: '2026-04-28' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', leftOn: '2026-04-28' },
  { value: 'gpt-5.1-mini', label: 'GPT-5.1 Mini', leftOn: '2026-04-28' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', leftOn: '2026-04-28' },
  { value: 'codex-5.1-max', label: 'Codex 5.1 Max', leftOn: '2026-03-09' }
]

export type CliRetiredModel = { value: string; label: string; leftOn: string }

/** The retired entry for a stored Codex model, or null (a listed model, or one Batshit never listed). */
export function findRetiredCodexModel(model: string | null | undefined): CliRetiredModel | null {
  if (typeof model !== 'string') return null
  const value = model.trim()
  return CODEX_RETIRED_MODELS.find((entry) => entry.value === value) ?? null
}

const CODEX_XHIGH_REASONING_MODEL_SET = new Set<string>([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5'
])

const CODEX_FAST_MODE_MODEL_SET = new Set<string>([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5'
])

export const CODEX_XHIGH_REASONING_HELPER_TEXT =
  'GPT-6, GPT-5.6, and GPT-5.5 (deepest reasoning)'

export const CODEX_FAST_MODE_HELPER_TEXT =
  "Available for GPT-6, GPT-5.6, and GPT-5.5 in Batshit's current Codex list."

export function supportsCodexXhighReasoning(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return CODEX_XHIGH_REASONING_MODEL_SET.has(model.trim())
}

export function supportsCodexFastMode(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return CODEX_FAST_MODE_MODEL_SET.has(model.trim())
}

export type CodexSubmodelValue = (typeof CODEX_SUBMODEL_CHOICES)[number]['value']
