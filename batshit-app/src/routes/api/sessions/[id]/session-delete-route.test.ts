import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  getSessions: vi.fn()
}))
const gateMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/server/services/sessionDeleteTurnStop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/sessionDeleteTurnStop')>()),
  deleteSessionStoppingItsTurn: gateMock
}))

import { SessionDeleteRefusedError } from '$lib/server/services/sessionDeleteTurnStop'

/**
 * The session route deletes a chat through `deleteSessionStoppingItsTurn`, which stops a reply
 * still running in it and sweeps only once that reply's request is done (2026-09-18; the rule
 * and its tests are in `sessionDeleteTurnStop.ts`). When the reply does not let go in time, or
 * another delete of the same chat is already stopping it, NOTHING is deleted, and the route must
 * say so as a 409 the user can act on, not a generic 500.
 */
async function callDelete() {
  const { DELETE } = await import('./+server')
  const response = await DELETE({
    params: { id: 'session-1' },
    locals: { user: { id: 'user-1' } }
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('DELETE /api/sessions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.getSessions.mockResolvedValue([{ id: 'session-1', user_id: 'user-1', locked: false }])
    gateMock.mockResolvedValue({ kind: 'no_turn' })
  })

  it('deletes an unlocked chat through the delete that stops its reply first', async () => {
    expect(await callDelete()).toEqual({ status: 200, payload: { success: true } })
    expect(gateMock).toHaveBeenCalledWith('session-1')
  })

  it('answers 409 with the reason when the chat’s reply did not stop in time', async () => {
    gateMock.mockRejectedValue(new SessionDeleteRefusedError('session_turn_still_stopping'))

    const { status, payload } = await callDelete()

    expect(status).toBe(409)
    expect(payload.code).toBe('session_turn_still_stopping')
    expect(payload.error).toContain('still stopping')
    expect(payload.error).toContain('nothing was deleted')
  })

  it('answers 409 when the chat is already being deleted', async () => {
    gateMock.mockRejectedValue(new SessionDeleteRefusedError('session_delete_in_progress'))

    const { status, payload } = await callDelete()

    expect(status).toBe(409)
    expect(payload.code).toBe('session_delete_in_progress')
  })

  it('keeps answering 500 for any other failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    gateMock.mockRejectedValue(new Error('redis down'))

    expect(await callDelete()).toEqual({
      status: 500,
      payload: { error: 'Failed to delete session' }
    })
    error.mockRestore()
  })

  it('never reaches the delete for a locked chat', async () => {
    redisMock.getSessions.mockResolvedValue([{ id: 'session-1', user_id: 'user-1', locked: true }])

    const { status } = await callDelete()

    expect(status).toBe(409)
    expect(gateMock).not.toHaveBeenCalled()
  })
})
