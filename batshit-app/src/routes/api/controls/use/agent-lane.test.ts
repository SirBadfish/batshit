import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
const mocks = vi.hoisted(() => ({ useControl: vi.fn() }))
vi.mock('$lib/server/services/fabricRegistry', async (original) => ({
  ...(await original<typeof import('$lib/server/services/fabricRegistry')>()), useControl: mocks.useControl
}))
import { POST } from './+server'
const USER = 'user-use-route'
const TOKEN = 'test-service-token-0123456789abcdef0123456789abcdef'
let previous: string | undefined
const call = (headers: Record<string, string>, body: Record<string, unknown>, userId?: string) => POST({
  request: new Request('http://localhost/api/controls/use', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  locals: userId ? { user: { id: userId } } : {}
} as any)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.useControl.mockResolvedValue({ success: true, controlId: 'sys.memory.recall', result: {} })
  previous = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = TOKEN
})
afterEach(() => {
  if (previous === undefined) delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  else (env as Record<string, string | undefined>).BATSHIT_TOKEN = previous
})
describe('control execution and the retired credential', () => {
  for (const token of ['', 'arc_old.bsac_secret']) {
    it(`refuses a retired header ${JSON.stringify(token)} before execution, even with service and session`, async () => {
      const response = await call({ 'x-batshit-agent-token': token, 'x-batshit-service-token': TOKEN, 'x-batshit-user-id': USER }, { controlId: 'sys.memory.recall', agentId: 'claimed-agent' }, USER)
      expect(response.status).toBe(401)
      expect(mocks.useControl).not.toHaveBeenCalled()
    })
  }
  it('does not echo the body agent ID as a server-bound acting identity', async () => {
    const response = await call({ 'x-batshit-service-token': TOKEN, 'x-batshit-user-id': USER }, { controlId: 'sys.memory.recall', agentId: 'claimed-agent' })
    expect((await response.json()).actingAgentId).toBeUndefined()
    expect(mocks.useControl).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'service', agentId: 'claimed-agent' }))
  })
  it('continues to refuse Fetch Zip to a service or session caller', async () => {
    expect((await call({ 'x-batshit-service-token': TOKEN, 'x-batshit-user-id': USER }, { controlId: 'sys.zip.fetch' })).status).toBe(403)
    expect((await call({}, { controlId: 'sys.zip.fetch' }, USER)).status).toBe(403)
    expect(mocks.useControl).not.toHaveBeenCalled()
  })
})
