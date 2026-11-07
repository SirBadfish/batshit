import { describe, expect, it } from 'vitest'
import { readArtifactAgentAccess } from './agentAccessIds'

describe('Artifact exact stored access projection (BL1614/BL847)', () => {
  it('keeps effective exact references separate from untouched raw bystanders', () => {
    const agent_allowlist = [' A-B ', 7, 'A-B', 'odd.id', [], { keep: [] }]
    const view = readArtifactAgentAccess({ agent_allowlist })
    expect(view.ids).toEqual(['A-B', 'odd.id'])
    expect(view.raw).toEqual(agent_allowlist)
    expect(view).toMatchObject({ configuredNonempty: true, scope: 'selected' })
    expect(agent_allowlist).toEqual([' A-B ', 7, 'A-B', 'odd.id', [], { keep: [] }])
  })

  it('never widens a malformed nonempty legacy list to All Agents', () => {
    for (const agent_allowlist of [[' A-B '], [7], [''], ['bad\ud800'], 'wrong-shape', {}]) {
      expect(readArtifactAgentAccess({ agent_allowlist })).toMatchObject({ ids: [], configuredNonempty: true, scope: 'selected' })
    }
  })

  it('preserves actual absent/empty legacy intent, named scope and the master-true selected default', () => {
    expect(readArtifactAgentAccess({}).scope).toBe('all')
    expect(readArtifactAgentAccess({ agent_allowlist: [] }).scope).toBe('all')
    expect(readArtifactAgentAccess({ agent_allowlist: null }).scope).toBe('all')
    expect(readArtifactAgentAccess({ agent_use_enabled: true }).scope).toBe('selected')
    expect(readArtifactAgentAccess({ agent_access_scope: ' ALL ', agent_allowlist: [' malformed '] }).scope).toBe('all')
    expect(readArtifactAgentAccess({ agent_access_scope: 'selected', agent_allowlist: [] }).scope).toBe('selected')
  })

  it('uses existing metadata aliases only when a direct array is absent', () => {
    const metadata = { assignedAgentIds: [' A-B ', 'odd.id'] }
    expect(readArtifactAgentAccess({ metadata })).toMatchObject({ ids: ['odd.id'], scope: 'selected' })
    expect(readArtifactAgentAccess({ agent_allowlist: [], metadata })).toMatchObject({ ids: [], configuredNonempty: false, scope: 'all' })
    expect(readArtifactAgentAccess({ metadata: { agent_allowlist: [' A-B '] } })).toMatchObject({ ids: [], scope: 'selected' })
  })
})
