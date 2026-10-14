import type { ToolModelTextBudget } from '$lib/utils/toolModelTextSizeGuard'

// Pinned Codex default qualification uses decoded UTF-8 bytes; unknown is deliberately small.
// This is Batshit's page size, never a write to Codex's vendor configuration.
export const CODEX_FALLBACK_TOOL_TEXT_BYTES = 8_000
export function resolveToolTextBudget(run: {
  runtime?: string
  codexToolOutputTokenLimit?: number | null
}): ToolModelTextBudget | undefined {
  if (run.runtime !== 'codex') return undefined
  const limit = run.codexToolOutputTokenLimit
  const known = typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0
  return {
    maxUtf8Bytes: known ? Math.min(300_000, limit * 4) : CODEX_FALLBACK_TOOL_TEXT_BYTES,
    source: known ? 'codex-profile' : 'codex-fallback'
  }
}

export function toolTextBudgetHeaders(run: Parameters<typeof resolveToolTextBudget>[0]): Record<string, string> {
  const budget = resolveToolTextBudget(run)
  return budget ? {
    'x-batshit-tool-text-max-bytes': String(budget.maxUtf8Bytes),
    'x-batshit-tool-text-budget-source': budget.source!
  } : {}
}
