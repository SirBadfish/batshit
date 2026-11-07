import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
const mocks = vi.hoisted(() => ({ findControls: vi.fn() }))
vi.mock('$lib/server/services/fabricRegistry', async (original) => ({
  ...(await original<typeof import('$lib/server/services/fabricRegistry')>()), findControls: mocks.findControls
}))
import { POST } from './+server'
const USER = 'user-find-route'
const TOKEN = 'test-service-token-0123456789abcdef0123456789abcdef'
let previous: string | undefined
const call = (headers: Record<string, string>, userId?: string) => POST({
  request: new Request('http://localhost/api/controls/find', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ agentId: 'claimed-agent', query: 'memory' }) }),
  locals: userId ? { user: { id: userId } } : {}
} as any)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.findControls.mockResolvedValue({ results: [], totalMatches: 0 })
  previous = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = TOKEN
})
afterEach(() => {
  if (previous === undefined) delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  else (env as Record<string, string | undefined>).BATSHIT_TOKEN = previous
})
describe('control discovery and the retired credential', () => {
  for (const token of ['', 'arc_old.bsac_secret']) {
    it(`refuses a retired header ${JSON.stringify(token)} before discovery, even with service and session`, async () => {
      const response = await call({ 'x-batshit-agent-token': token, 'x-batshit-service-token': TOKEN, 'x-batshit-user-id': USER }, USER)
      expect(response.status).toBe(401)
      expect(mocks.findControls).not.toHaveBeenCalled()
    })
  }
  it('keeps a service body agent ID as a scope hint, not an identity claim', async () => {
    expect((await call({ 'x-batshit-service-token': TOKEN, 'x-batshit-user-id': USER })).status).toBe(200)
    expect(mocks.findControls).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, agentId: 'claimed-agent', actorType: 'service' }))
  })
  it('uses the signed-in session lane when no retired header is present', async () => {
    expect((await call({}, USER)).status).toBe(200)
    expect(mocks.findControls).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, actorType: 'session' }))
  })
})
