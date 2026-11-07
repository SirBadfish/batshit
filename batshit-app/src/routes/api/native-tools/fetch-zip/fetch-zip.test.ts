import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: null as any }))
vi.mock('$lib/server/services/nativeToolAuth', () => ({ resolveNativeToolUser: vi.fn(async () => mocks.auth) }))
const { POST } = await import('./+server')
const event = (body: Record<string, unknown>) => ({
  request: new Request('http://localhost/api/native-tools/fetch-zip', { method: 'POST', body: JSON.stringify(body) }),
  locals: { user: null }
} as any)
describe('retired direct Fetch Zip route', () => {
  for (const lane of ['service', 'session']) {
    it(`still refuses a ${lane} caller claiming model scope in JSON`, async () => {
      mocks.auth = { auth: lane, userId: 'user-1' }
      const response = await POST(event({ zipId: 'zip-1', sessionId: 'chat-1', agentId: 'agent-a', fetchZipAllowed: true }))
      expect(response.status).toBe(403)
    })
  }
  it('retains invalid input and unauthenticated refusals', async () => {
    mocks.auth = null
    expect((await POST(event({}))).status).toBe(400)
    expect((await POST(event({ zipId: 'zip-1' }))).status).toBe(401)
  })
})
