export const CLAUDE_CLI_MODEL_CHOICES = [
  { value: 'opus', label: 'Opus (latest alias)' },
  { value: 'best', label: 'Best (most capable alias)' },
  { value: 'fable', label: 'Fable 5 (long task alias)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'sonnet', label: 'Sonnet (latest alias)' },
  { value: 'haiku', label: 'Haiku (latest alias)' },
  { value: 'sonnet[1m]', label: 'Sonnet (1M alias)' },
  { value: 'opus[1m]', label: 'Opus (1M alias)' },
  { value: 'opusplan[1m]', label: 'Opus/Sonnet (plan/exe, 1M)' },
  { value: 'opusplan', label: 'Opus/Sonnet (plan/exe)' }
] as const

export type ClaudeCliModelValue = (typeof CLAUDE_CLI_MODEL_CHOICES)[number]['value']
