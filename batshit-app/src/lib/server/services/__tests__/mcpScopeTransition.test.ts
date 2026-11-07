import { describe, expect, it } from 'vitest'
import { planFreshMcpScope, snapshotActualMcpScope } from '../appActions/mcp/scopeTransition'
describe('MCP actual-scope conservation', () => {
  it('preserves human A plus approved verified C even when defaults independently changed to B', () => {
    const original = snapshotActualMcpScope({ gatewayIds: ['A'], provenance: 'human-selection', snapshotId: 'original' })
    // permitted includes B because current authority allows it; membership still cannot add B.
    const next = planFreshMcpScope(original, { add: ['C'], remove: [] }, { verifiedAdditions: ['C'], permittedGatewayIds: ['A', 'B', 'C'], nextSnapshotId: 'next' })
    expect(next.gatewayIds).toEqual(['A', 'C'])
    expect(original.gatewayIds).toEqual(['A'])
    expect(Object.isFrozen(original.gatewayIds)).toBe(true)
  })
  it('preserves explicit empty scope, removal-only empty results, and later accepted lineage', () => {
    const empty = snapshotActualMcpScope({ gatewayIds: [], provenance: 'human-selection', snapshotId: 'empty' })
    const first = planFreshMcpScope(empty, { add: ['C'], remove: [] }, { verifiedAdditions: ['C'], permittedGatewayIds: ['B', 'C'], nextSnapshotId: 'first' })
    const second = planFreshMcpScope(first, { add: [], remove: ['C'] }, { verifiedAdditions: [], permittedGatewayIds: ['B', 'C'], nextSnapshotId: 'second' })
    expect(first.gatewayIds).toEqual(['C'])
    expect(second.gatewayIds).toEqual([])
  })
  it('only subtracts genuine current restrictions and refuses missing or extra positive verification', () => {
    const original = snapshotActualMcpScope({ gatewayIds: ['A'], provenance: 'saved-defaults', snapshotId: 'scope' })
    expect(planFreshMcpScope(original, { add: ['C'], remove: [] }, { verifiedAdditions: ['C'], permittedGatewayIds: ['C'], nextSnapshotId: 'tight' }).gatewayIds).toEqual(['C'])
    expect(() => planFreshMcpScope(original, { add: ['C'], remove: [] }, { verifiedAdditions: [], permittedGatewayIds: ['A', 'C'], nextSnapshotId: 'missing' })).toThrow(/approved additions/)
    expect(() => planFreshMcpScope(original, { add: ['C'], remove: [] }, { verifiedAdditions: ['B', 'C'], permittedGatewayIds: ['A', 'B', 'C'], nextSnapshotId: 'extra' })).toThrow(/approved additions/)
  })
})
