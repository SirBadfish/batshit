export const CODEX_SUBMODEL_CHOICES = [
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
] as const

const CODEX_XHIGH_REASONING_MODEL_SET = new Set<string>([
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5'
])

const CODEX_FAST_MODE_MODEL_SET = new Set<string>([
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5'
])

export const CODEX_XHIGH_REASONING_HELPER_TEXT =
  'Astra, GPT-5.6, and GPT-5.5 (deepest reasoning)'

export const CODEX_FAST_MODE_HELPER_TEXT =
  "Available for Astra, GPT-5.6, and GPT-5.5 in Batshit's current Codex list."

export function supportsCodexXhighReasoning(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return CODEX_XHIGH_REASONING_MODEL_SET.has(model.trim())
}

export function supportsCodexFastMode(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return CODEX_FAST_MODE_MODEL_SET.has(model.trim())
}

export type CodexSubmodelValue = (typeof CODEX_SUBMODEL_CHOICES)[number]['value']
