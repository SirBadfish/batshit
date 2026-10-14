import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: null as any,
  fetch: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn(async () => mocks.auth)
}))
vi.mock('$lib/server/services/actingAgentIdentity', () => ({
  refuseDelegatedRunOutsideList: vi.fn(() => null)
}))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: { nativeFetchZip: mocks.fetch }
}))

const { POST } = await import('./+server')

function event(body: Record<string, any>) {
  return {
    request: new Request('http://localhost/api/native-tools/fetch-zip', {
      method: 'POST', body: JSON.stringify(body)
    }),
    locals: { user: null }
  } as any
}

beforeEach(() => {
  mocks.auth = {
    auth: 'agent', userId: 'user-1', agentId: 'agent-a',
    sessionId: 'chat-1', messageId: 'reply-1', fetchZipAllowed: true
  }
  mocks.fetch.mockReset()
  mocks.fetch.mockResolvedValue({ found: true, zipId: 'zip-1', content: 'page' })
})

describe('direct model Fetch Zip route', () => {
  it('rejects a service-token caller claiming a chat in JSON', async () => {
    mocks.auth = { auth: 'service', userId: 'user-1' }
    const response = await POST(event({
      zipId: 'zip-1', sessionId: 'chat-1', agentId: 'agent-a'
    }))
    expect(response.status).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('rejects an agent whose server-owned run scope omitted Fetch Zip despite a forged flag', async () => {
    mocks.auth.fetchZipAllowed = false
    const response = await POST(event({ zipId: 'zip-1', fetchZipAllowed: true }))
    expect(response.status).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('forwards only credential-bound chat, actor, and reply plus the requested page', async () => {
    const response = await POST(event({
      zipId: 'zip-1', offset: 64, maxChars: 64,
      sessionId: 'forged-chat', agentId: 'forged-agent', messageId: 'forged-reply'
    }))
    expect(response.status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledWith({
      userId: 'user-1', agentId: 'agent-a', sessionId: 'chat-1',
      messageId: 'reply-1', actorType: 'agent', zipId: 'zip-1',
      includeContent: undefined, maxChars: 64, offset: 64
    })
  })

  it('returns a visible 400 for malformed paging', async () => {
    mocks.fetch.mockResolvedValue({
      found: false, zipId: 'zip-1', code: 'INVALID_OFFSET',
      reason: 'offset must be a non-negative integer.'
    })
    const response = await POST(event({ zipId: 'zip-1', offset: -1 }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('INVALID_OFFSET')
  })
})
