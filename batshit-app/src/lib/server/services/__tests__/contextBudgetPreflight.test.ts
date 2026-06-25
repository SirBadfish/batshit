import { describe, expect, it } from 'vitest'

import {
  CODEX_CLI_INPUT_CHAR_LIMIT,
  CODEX_CLI_INPUT_CHAR_SAFETY_MARGIN,
  buildPromptBudgetReport
} from '$lib/server/services/contextBudgetPreflight'

describe('context budget preflight', () => {
  it('blocks sends that exceed the model context window after output reserve', () => {
    const report = buildPromptBudgetReport({
      runtime: 'vercel',
      messages: [{ role: 'user', content: 'A'.repeat(20_000) }],
      contextLimit: 1_000,
      outputReserveTokens: 500,
      autoCompactTriggerTokens: 300
    })

    expect(report.canSend).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.tokenStatus).toBe('blocked')
    expect(report.reason).toContain('context window')
  })

  it('recommends compacting when the compiled prompt enters the auto compact margin', () => {
    const report = buildPromptBudgetReport({
      runtime: 'vercel',
      messages: [{ role: 'user', content: 'A'.repeat(4_000) }],
      contextLimit: 3_000,
      outputReserveTokens: 0,
      autoCompactTriggerTokens: 2_500
    })

    expect(report.canSend).toBe(true)
    expect(report.status).toBe('compact_recommended')
    expect(report.shouldAutoCompact).toBe(true)
  })

  it('blocks Codex CLI launches before the packaged character hard limit', () => {
    const safeLimit = CODEX_CLI_INPUT_CHAR_LIMIT - CODEX_CLI_INPUT_CHAR_SAFETY_MARGIN
    const report = buildPromptBudgetReport({
      runtime: 'codex',
      messages: [{ role: 'user', content: 'A'.repeat(safeLimit) }],
      contextLimit: 2_000_000,
      outputReserveTokens: 0,
      autoCompactTriggerTokens: 80_000
    })

    expect(report.canSend).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.runtimeHardLimitStatus).toBe('blocked')
    expect(report.packagedInputSafeCharLimit).toBe(safeLimit)
    expect(report.reason).toContain('Codex CLI')
  })
})
