import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-686 — `/api/cli-tools/find` lists only the saved CLI tools a caller may reach.
 *
 * `findCliTools` is mocked (its scope rule has `cliToolSelectionScope.test.ts`), so this pins
 * what the ROUTE hands it: a managed run's credential list as the bound scope, and the body's
 * `selectedToolIds` only as a filter on it.
 */

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  findCliTools: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

vi.mock('$lib/server/services/cliToolRegistry', () => ({
  findCliTools: mocks.findCliTools
}))

import { POST } from './+server'

function run(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/cli-tools/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: {}
  } as any)
}

describe('/api/cli-tools/find — the saved CLI tools a caller may reach (BL-686)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findCliTools.mockResolvedValue({ results: [], totalMatches: 0, query: '' })
  })

  it("leaves the signed-in lane on the named agent's saved list", async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({ auth: 'session', userId: 'user-1' })
    await run({ query: 'a', agentId: 'agent_a', selectedToolIds: ['a_tool'], cliToolScope: ['b_tool'] })
    const params = mocks.findCliTools.mock.calls[0][0]
    expect(params).not.toHaveProperty('cliToolScope')
    expect(params.agentId).toBe('agent_a')
    expect(params.selectedToolIds).toEqual(['a_tool'])
  })
})
