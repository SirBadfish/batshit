import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  getFolder: vi.fn(),
  deleteFolder: vi.fn()
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
 * Delete Folder + Sessions deletes each chat the way the session route does: through
 * `deleteSessionStoppingItsTurn`, which stops a chat's running reply first and refuses when that
 * reply does not let go in time (`sessionDeleteTurnStop.ts`, 2026-09-18). The folder route hands
 * that function to `redis.deleteFolder`, and passes a refusal on as a 409 the user can act on;
 * the chats deleted before it stay deleted, and a retry finishes.
 */
async function callDelete(query = '?deleteSessions=true') {
  const { DELETE } = await import('./+server')
  const response = await DELETE({
    params: { id: 'folder-1' },
    locals: { user: { id: 'user-1' } },
    url: new URL(`http://localhost/api/folders/folder-1${query}`)
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('DELETE /api/folders/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.getFolder.mockResolvedValue({ id: 'folder-1', is_default: false })
    redisMock.deleteFolder.mockResolvedValue({ success: true, deleted_sessions: 2 })
  })

  it('deletes each chat through the delete that stops its reply first', async () => {
    expect((await callDelete()).status).toBe(200)
    expect(redisMock.deleteFolder).toHaveBeenCalledWith('user-1', 'folder-1', {
      deleteSessions: true,
      deleteSession: gateMock
    })
  })

  it('moves the chats, deleting none, without deleteSessions', async () => {
    expect((await callDelete('')).status).toBe(200)
    expect(redisMock.deleteFolder).toHaveBeenCalledWith('user-1', 'folder-1', {})
  })

  it('answers 409 with the reason when a chat’s reply did not stop in time', async () => {
    redisMock.deleteFolder.mockRejectedValue(
      new SessionDeleteRefusedError('session_turn_still_stopping')
    )

    const { status, payload } = await callDelete()

    expect(status).toBe(409)
    expect(payload.code).toBe('session_turn_still_stopping')
    expect(payload.error).toContain('still stopping')
  })

  it('keeps answering 500 for any other failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    redisMock.deleteFolder.mockRejectedValue(new Error('redis down'))

    expect((await callDelete()).status).toBe(500)
    error.mockRestore()
  })
})
