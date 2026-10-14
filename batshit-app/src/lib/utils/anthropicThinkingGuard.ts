/**
 * The Claude models whose thinking setting the AI SDK rewrites without a word.
 *
 * `@ai-sdk/anthropic` 4.0.60 and 4.0.67 (the SDK set of 2026-09-29) change a thinking setting
 * these models refuse and report it only as an SDK warning, which Batshit does not show
 * (measured through the real packages, `_local/session-d-2026-09-29/aisdk/wire-*.json`):
 *
 * - Claude Opus 5.5, Claude Fable 5, Claude Fable 5.1 always think. `disabled` is removed and
 *   `enabled` with a budget becomes `adaptive`.
 * - Claude Sonnet 5.5 cannot turn thinking off. `disabled` becomes `between_tools`, its lowest
 *   setting, and `enabled` with a budget becomes `adaptive`.
 *
 * Anthropic answers 400 to each of these settings (its model guide; Sonnet 5.5 measured with real
 * calls on 2026-09-28), which is what a user saw before the SDK move. Batshit's rule is that a
 * setting is sent as saved or refused with a reason, never swapped for another one, so the send
 * stops here with a sentence that says what to change. Blank sends nothing (Anthropic's default,
 * adaptive thinking) and passes, as does `adaptive`, and `between_tools` on Sonnet 5.5.
 *
 * Every other model is left alone: an older Claude model takes what it took before, and a model
 * that refuses a value the SDK passes through unchanged still gets Anthropic's own 400. Only a
 * lane that sends `providerOptions.anthropic` is checked: direct Anthropic, the Vercel AI Gateway
 * (its package rewrites the same way), and a preset with no connection (it runs on one of the
 * two). OpenRouter reads only `providerOptions.openrouter`, so the setting never leaves there
 * (logged on the bug list), and a direct connection to another service is not Anthropic.
 */

export class AnthropicThinkingRefusedError extends Error {
  readonly status = 400
  readonly code = 'model_setting_unsupported'

  constructor(message: string) {
    super(message)
    this.name = 'AnthropicThinkingRefusedError'
  }
}

type RefusalRule = { name: string; allowed: ReadonlySet<string>; lowest: string | null }

const ALWAYS_THINKS: Omit<RefusalRule, 'name'> = { allowed: new Set(['adaptive']), lowest: null }
const RULES: Array<{ pattern: RegExp } & RefusalRule> = [
  { pattern: /^claude-opus-5-5(?:-|$)/, name: 'Claude Opus 5.5', ...ALWAYS_THINKS },
  { pattern: /^claude-fable-5-1(?:-|$)/, name: 'Claude Fable 5.1', ...ALWAYS_THINKS },
  { pattern: /^claude-fable-5(?!-1(?:-|$))(?:-|$)/, name: 'Claude Fable 5', ...ALWAYS_THINKS },
  {
    pattern: /^claude-sonnet-5-5(?:-|$)/,
    name: 'Claude Sonnet 5.5',
    allowed: new Set(['adaptive', 'between_tools']),
    lowest: 'Between tools'
  }
]

/** `anthropic/claude-opus-5.5` and `claude-opus-5-5-20260901` are the same model as `claude-opus-5-5`. */
function normalizeClaudeModelId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const bare = value.trim().toLowerCase().split('/').pop() ?? ''
  return bare.replace(/\./g, '-')
}

function ruleFor(ids: unknown[]): RefusalRule | null {
  for (const id of ids) {
    const normalized = normalizeClaudeModelId(id)
    if (!normalized) continue
    const rule = RULES.find((candidate) => candidate.pattern.test(normalized))
    if (rule) return rule
  }
  return null
}

/**
 * Throws `AnthropicThinkingRefusedError` when the built `providerOptions.anthropic.thinking` is a
 * setting the SDK would rewrite for this model. Called once, at the end of
 * `buildRuntimeModelSettings`, so a preset field and a Custom Parameter are both covered.
 */
export function refuseAnthropicThinkingTheModelRejects(input: {
  provider?: string | null
  modelId?: string | null
  vercelId?: string | null
  connection?: { type?: string | null; service?: string | null } | null
  providerOptions: Record<string, Record<string, any>>
}): void {
  const thinking = input.providerOptions?.anthropic?.thinking
  if (!thinking || typeof thinking !== 'object') return
  if (!sendsAnthropicOptions(input.connection)) return
  const rule = ruleFor([input.modelId, input.vercelId])
  if (!rule) return

  const type = typeof thinking.type === 'string' ? thinking.type : null
  const hasBudget = thinking.budgetTokens !== undefined && thinking.budgetTokens !== null
  if (!hasBudget && (type === null || rule.allowed.has(type))) return

  const mode =
    type === 'disabled'
      ? 'Thinking mode Disabled'
      : type === 'enabled'
        ? 'Thinking mode Enabled'
        : type
          ? `Thinking mode "${type}"`
          : null
  const what = mode && hasBudget ? `${mode} with a Thinking budget` : mode ?? 'Thinking budget'
  const because = rule.lowest
    ? `${rule.name} cannot turn thinking off (its lowest setting is ${rule.lowest}), and it takes no thinking budget`
    : `${rule.name} always thinks, and it takes no thinking budget`
  throw new AnthropicThinkingRefusedError(
    `${because}, so this model preset's ${what} cannot be sent. Open Settings → Models, edit this model preset, and clear Thinking mode and Thinking budget (blank sends nothing and uses Anthropic's default). Batshit does not send a setting the model refuses, and does not change it for you.`
  )
}

/**
 * Does this lane send `providerOptions.anthropic` to Anthropic? (See the file comment.) The Sonnet 5.5
 * mapping in `modelSettingsMapper.ts` asks it too: it refuses a saved Enabled only where the
 * setting would be sent.
 */
export function sendsAnthropicOptions(connection: { type?: string | null; service?: string | null } | null | undefined): boolean {
  if (!connection || !connection.type) return true
  if (connection.type === 'openrouter') return false
  if (connection.type === 'direct') {
    const service = typeof connection.service === 'string' ? connection.service.trim().toLowerCase() : ''
    return !service || service === 'anthropic'
  }
  return true
}

/**
 * A model setting refused before the call, by this guard or by another check that answers with
 * the same code. Callers that turn a refusal into a readable failure (a Subagent run) ask this.
 */
export function isModelSettingRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'model_setting_unsupported' &&
    (error as { status?: unknown }).status === 400
  )
}
