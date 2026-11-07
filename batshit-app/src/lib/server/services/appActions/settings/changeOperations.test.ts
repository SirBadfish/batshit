import { describe, expect, it } from 'vitest'
import { settingsOperationReceipt } from './changeOperations'
import type { AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'

describe('bounded operation receipts', () => {
  it('pages every immutable outcome with visible counts and never changes the saved ledger', () => {
    const outcomes: AppActionsTargetOutcome[] = Array.from({ length: 256 }, (_, index) => ({
      subject: { kind: 'primary', id: `agent_${index}_${'x'.repeat(110)}` }, status: index % 2 ? 'applied' : 'conflict',
      saved: index % 2 ? 'saved' : 'not_requested', readback: index % 2 ? 'verified' : 'not_requested', visible: 'unknown'
    }))
    const result = { operationId: 'held_operation', status: 'completed', outcomes }
    const seen: AppActionsTargetOutcome[] = []
    let offset = 0
    do {
      const page = settingsOperationReceipt(result, offset)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192)
      expect(page.outcomesSummary).toMatchObject({ applied: 128, conflict: 128 })
      seen.push(...page.outcomes)
      if (!page.outcomePage.next) break
      expect(page.outcomePage.remaining).toBeGreaterThan(0)
      offset = page.outcomePage.next.outcomeOffset
    } while (offset < 256)
    expect(seen).toEqual(outcomes)
    expect(result.outcomes).toHaveLength(256)
    expect(() => settingsOperationReceipt(result, 257)).toThrow('beyond')
  })
})
