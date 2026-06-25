export const CODEX_SUBMODEL_CHOICES = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
] as const

const CODEX_XHIGH_REASONING_MODEL_SET = new Set<string>([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex-spark'
])

const CODEX_FAST_MODE_MODEL_SET = new Set<string>(['gpt-5.5', 'gpt-5.4'])

export const CODEX_XHIGH_REASONING_HELPER_TEXT =
  'GPT-5.5 / GPT-5.4 / GPT-5.3 Codex Spark (deepest reasoning)'

export const CODEX_FAST_MODE_HELPER_TEXT =
  "Available for GPT-5.5 and GPT-5.4 in Batshit's current Codex list."

export function supportsCodexXhighReasoning(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return CODEX_XHIGH_REASONING_MODEL_SET.has(model.trim())
}

export function supportsCodexFastMode(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return CODEX_FAST_MODE_MODEL_SET.has(model.trim())
}

export type CodexSubmodelValue = (typeof CODEX_SUBMODEL_CHOICES)[number]['value']
