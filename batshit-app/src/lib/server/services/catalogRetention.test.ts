import { describe, expect, it } from 'vitest'
import { retainCatalogSourceEntries } from './catalogRetention'

const evidence = { connectionId: 'direct:example', effectiveId: 'old', firstAbsentAt: '2026-09-28T10:00:00Z', recheckedAt: '2026-09-28T11:00:00Z', evidenceUrl: 'https://example.com/retirements', reason: 'Provider confirms retirement.' }
describe('catalog retirement evidence', () => {
  it('retains missing IDs until both recheck and provider evidence are recorded', () => {
    expect(retainCatalogSourceEntries('direct:example', [{ id: 'new' }], [{ id: 'old' }]).entries).toEqual([{ id: 'new' }, { id: 'old' }])
    expect(retainCatalogSourceEntries('direct:example', [{ id: 'new' }], [{ id: 'old' }], [evidence]).confirmedRemovalIds).toEqual(['old'])
  })
  it('limits a retirement to its exact connection and exact upstream ID', () => {
    expect(retainCatalogSourceEntries('openrouter', [], [{ id: 'old' }], [evidence]).entries).toHaveLength(1)
    expect(retainCatalogSourceEntries('direct:example', [], [{ id: 'OLD' }], [evidence]).entries).toHaveLength(1)
  })
  it('keeps an ID which the provider lists again despite recorded retirement', () => {
    expect(retainCatalogSourceEntries('direct:example', [{ id: 'old', price: 2 }], [{ id: 'old', price: 1 }], [evidence]).entries).toEqual([{ id: 'old', price: 2 }])
  })
  it.each([{ recheckedAt: '2026-09-28T10:05:00Z' }, { evidenceUrl: '' }, { firstAbsentAt: 'invalid' }])('refuses incomplete confirmation %s', bad => {
    expect(() => retainCatalogSourceEntries('direct:example', [], [{ id: 'old' }], [{ ...evidence, ...bad }])).toThrow('Invalid confirmed')
  })
})
