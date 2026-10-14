import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-686 — which saved CLI tools one call may reach.
 *
 * The caller's `selectedToolIds` (a route body, a model's tool input) used to BE the scope, so
 * a managed run of agent A could name a tool saved only for agent B and run it. It is now a
 * filter on the server's scope: a bound run list (`cliToolScope`), else the agent's saved list,
 * else the metadata list, else the user's Tool Grid list. The rule BL-638 set for gateways.
 */

const redisMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getUserSettings: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: redisMocks.get,
    getUserSettings: redisMocks.getUserSettings
  }
}))

import { resolveCliToolSelectionScope, resolveRunCredentialCliToolScope } from '../cliToolRegistry'

const agents: Record<string, Record<string, unknown>> = {
  'agent:agent_a': { id: 'agent_a', user_id: 'user-1', defaultTools: ['a_tool', 'shared_tool'] },
  'agent:agent_b': { id: 'agent_b', user_id: 'user-1', defaultTools: ['b_tool'] },
  'agent:agent_open': { id: 'agent_open', user_id: 'user-1' }
}

describe('resolveCliToolSelectionScope (BL-686)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMocks.get.mockImplementation(async (key: string) => agents[key] ?? null)
    redisMocks.getUserSettings.mockResolvedValue({
      global_tool_grid_settings: {
        cli: { discoverableToolIds: ['a_tool', 'b_tool', 'global_tool'] }
      }
    })
  })

  it("refuses a caller's list that names a tool only another agent has saved", async () => {
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentId: 'agent_a',
      selectedToolIds: ['b_tool']
    })
    expect(scope.toolIds).toEqual([])
    expect(scope.source).toBe('agent')
  })

  it("keeps a caller's narrower list inside the agent's saved list", async () => {
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentId: 'agent_a',
      selectedToolIds: ['shared_tool', 'b_tool', ' shared_tool ']
    })
    expect(scope.toolIds).toEqual(['shared_tool'])
  })

  it("reads the agent's saved list when the caller names none", async () => {
    const scope = await resolveCliToolSelectionScope({ userId: 'user-1', agentId: 'agent_a' })
    expect(scope.toolIds).toEqual(['a_tool', 'shared_tool'])
  })

  it('treats an empty caller list as none', async () => {
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentId: 'agent_a',
      selectedToolIds: []
    })
    expect(scope.toolIds).toEqual([])
  })

  it("narrows the user's Tool Grid list for an agent with no saved list", async () => {
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentId: 'agent_open',
      selectedToolIds: ['global_tool', 'not_discoverable']
    })
    expect(scope).toEqual({ toolIds: ['global_tool'], source: 'user-global' })
  })

  it('narrows a metadata list (a Subagent record) the same way', async () => {
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentMetadata: { defaultTools: ['sub_tool'] },
      selectedToolIds: ['sub_tool', 'b_tool']
    })
    expect(scope.toolIds).toEqual(['sub_tool'])
  })

  it("a bound run list replaces the agent's saved list and the caller's list only narrows it", async () => {
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentId: 'agent_a',
      cliToolScope: ['sub_tool', 'b_tool'],
      selectedToolIds: ['b_tool', 'a_tool']
    })
    expect(scope).toEqual({ toolIds: ['b_tool'], source: 'selected' })
    expect(redisMocks.get).not.toHaveBeenCalled()
  })

  it('a null or malformed bound list is an empty scope, not a fallback to saved lists', async () => {
    for (const cliToolScope of [null, ['a_tool', 7] as unknown as string[]]) {
      const scope = await resolveCliToolSelectionScope({
        userId: 'user-1',
        agentId: 'agent_a',
        cliToolScope,
        selectedToolIds: ['a_tool']
      })
      expect(scope.toolIds).toEqual([])
    }
  })

  it("ignores another user's agent record", async () => {
    redisMocks.get.mockResolvedValue({ id: 'agent_x', user_id: 'someone-else', defaultTools: ['x_tool'] })
    const scope = await resolveCliToolSelectionScope({
      userId: 'user-1',
      agentId: 'agent_x',
      selectedToolIds: ['x_tool']
    })
    expect(scope.toolIds).toEqual([])
  })
})

describe('resolveRunCredentialCliToolScope (BL-686): what a run credential is minted with', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMocks.get.mockImplementation(async (key: string) => agents[key] ?? null)
    redisMocks.getUserSettings.mockResolvedValue({
      global_tool_grid_settings: { cli: { discoverableToolIds: ['global_tool'] } }
    })
  })

  it("a primary run: the turn's list, else its agent's saved list, else the Tool Grid list", async () => {
    expect(await resolveRunCredentialCliToolScope({
      userId: 'user-1', agentId: 'agent_a', selectedCliToolIds: ['a_tool']
    })).toEqual(['a_tool'])
    expect(await resolveRunCredentialCliToolScope({ userId: 'user-1', agentId: 'agent_a' }))
      .toEqual(['a_tool', 'shared_tool'])
    expect(await resolveRunCredentialCliToolScope({ userId: 'user-1', agentId: 'agent_open' }))
      .toEqual(['global_tool'])
  })

  it("a delegated run: its runner's list only, and none without one", async () => {
    expect(await resolveRunCredentialCliToolScope({
      userId: 'user-1', agentId: 'agent_a', delegatedRun: true, selectedCliToolIds: ['sub_tool']
    })).toEqual(['sub_tool'])
    expect(await resolveRunCredentialCliToolScope({
      userId: 'user-1', agentId: 'agent_a', delegatedRun: true
    })).toEqual([])
    expect(redisMocks.get).not.toHaveBeenCalled()
  })
})
