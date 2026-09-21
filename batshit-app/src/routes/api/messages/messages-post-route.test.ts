import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  beginSessionDelete,
  endSessionDelete
} from '$lib/server/services/streamAbortRegistry'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  saveMessage: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

/**
 * The browser saves a finished reply when `end` arrives, from every tab showing the chat
 * (`dbService.saveMessage` in the chat page). A chat deleted mid-reply now has its reply
 * stopped while the delete waits, so that `end` and that save land DURING the delete
 * (`sessionDeleteTurnStop.ts`, 2026-09-18). A save that reaches Redis while the delete sweeps
 * would put the message and the list entry back after the sweep passed them. So this route
 * refuses a chat that is being deleted, with the same answer it gives a chat that is gone.
 */
async function post(sessionId: string) {
  const { POST } = await import('./+server')
  const response = await POST({
    request: new Request('http://localhost/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        id: 'msg-reply',
        session_id: sessionId,
        role: 'assistant',
        content: 'Done.'
      })
    }),
    locals: { user: { id: 'user-1' } }
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('POST /api/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStreamAbortRegistryForTests()
    redisMock.get.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    redisMock.saveMessage.mockResolvedValue(undefined)
  })

  afterEach(() => {
    __resetStreamAbortRegistryForTests()
  })

  it('saves a message into an existing chat', async () => {
    expect(await post('session-1')).toEqual({ status: 200, payload: { success: true, id: 'msg-reply' } })
    expect(redisMock.saveMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses a chat that is being deleted, as it refuses a chat that is gone', async () => {
    beginSessionDelete('session-1')

    expect(await post('session-1')).toEqual({ status: 404, payload: { error: 'Session not found' } })
    expect(redisMock.saveMessage).not.toHaveBeenCalled()

    // Another chat still saves.
    expect((await post('session-2')).status).toBe(200)

    endSessionDelete('session-1')
    redisMock.get.mockResolvedValue(null)
    expect(await post('session-1')).toEqual({ status: 404, payload: { error: 'Session not found' } })
    expect(redisMock.saveMessage).toHaveBeenCalledTimes(1)
  })
})
