import { describe, expect, it } from 'vitest'
import { resolveToolTextBudget, toolTextBudgetHeaders } from '../toolTextBudget'

describe('credential-bound Codex tool text budget', () => {
  it('preserves explicit user limits including zero and safely bounds huge values', () => {
    for (const tokens of [0, 2_000, 25_000, 75_000, Number.MAX_SAFE_INTEGER]) {
      expect(resolveToolTextBudget({ runtime: 'codex', codexToolOutputTokenLimit: tokens })).toEqual({
        maxUtf8Bytes: Math.min(300_000, tokens * 4), source: 'codex-profile'
      })
    }
  })
  it('uses an identified small page for unknown/old credentials and leaves Claude alone', () => {
    for (const value of [undefined, null, -1, 1.5, Number.NaN]) {
      expect(resolveToolTextBudget({ runtime: 'codex', codexToolOutputTokenLimit: value })).toEqual({
        maxUtf8Bytes: 8_000, source: 'codex-fallback'
      })
    }
    expect(resolveToolTextBudget({ runtime: 'claude' })).toBeUndefined()
    expect(toolTextBudgetHeaders({ runtime: 'codex', codexToolOutputTokenLimit: 0 })).toEqual({
      'x-batshit-tool-text-max-bytes': '0', 'x-batshit-tool-text-budget-source': 'codex-profile'
    })
  })
})
