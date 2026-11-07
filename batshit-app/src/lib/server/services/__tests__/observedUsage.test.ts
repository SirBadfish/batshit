import { describe, expect, it } from 'vitest'
import { readObservedUsage } from '../observedUsage'

// A reply saved by the removed Codex CLI lane keeps its progress portions; they stay readable.
const partial = (counts: Record<string, number>) => ({ completeness: 'partial' as const, parts: [{ source: 'codex-app-server-progress' as const, counts }] })

describe('stored observed usage evidence', () => {
  it('shares the established strict completeness validator without filtering malformed portions', () => {
    expect(() => readObservedUsage({ completeness: 'partial', parts: [partial({ outputTokens: 0 }).parts[0], { source: 'unknown', counts: { outputTokens: 1 } }] })).toThrow('unknown source')
    expect(readObservedUsage(partial({ outputTokens: 0 }))).toEqual(partial({ outputTokens: 0 }))
  })
})
