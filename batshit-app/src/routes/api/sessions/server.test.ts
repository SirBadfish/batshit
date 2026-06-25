import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSessions: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

describe('POST /api/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.getSessions.mockResolvedValue([])
    redisMock.createSession.mockImplementation(async (session) => session)
  })

  it('rejects duplicate session ids before createSession can overwrite data', async () => {
    redisMock.getSessions.mockResolvedValue([
      {
        id: 'existing-session',
        user_id: 'user-1',
        name: 'Existing Session',
        archived: true
      }
    ])

    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          id: 'existing-session',
          name: 'Duplicate Attempt'
        })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(409)
    expect(payload.error).toBe('Session ID already exists')
    expect(redisMock.getSessions).toHaveBeenCalledWith('user-1', true)
    expect(redisMock.createSession).not.toHaveBeenCalled()
  })

  it('creates a session when the requested id is available', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          id: 'new-session',
          name: 'New Session'
        })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.id).toBe('new-session')
    expect(redisMock.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-session',
        user_id: 'user-1'
      })
    )
  })
})
