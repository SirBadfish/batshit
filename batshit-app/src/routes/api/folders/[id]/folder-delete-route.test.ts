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
async function callDelete(
  query = '?deleteSessions=true',
  // `null` sends no body at all.
  body: unknown = { expectedChatIds: ['chat-1', 'chat-2'] }
) {
  const { DELETE } = await import('./+server')
  const url = `http://localhost/api/folders/folder-1${query}`
  const response = await DELETE({
    params: { id: 'folder-1' },
    locals: { user: { id: 'user-1' } },
    url: new URL(url),
    request: new Request(url, {
      method: 'DELETE',
      ...(body === null ? {} : { body: JSON.stringify(body) })
    })
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
      deleteSession: gateMock,
      expectedSessionIds: ['chat-1', 'chat-2']
    })
  })

  it('refuses 400, deleting nothing, when the delete does not name the chats it showed', async () => {
    const { status } = await callDelete('?deleteSessions=true', null)
    expect(status).toBe(400)
    expect((await callDelete('?deleteSessions=true', { expectedChatIds: [1] })).status).toBe(400)
    expect(redisMock.deleteFolder).not.toHaveBeenCalled()
  })

  it('answers 409 with plain words when the folder changed since the dialog opened', async () => {
    redisMock.deleteFolder.mockResolvedValue({
      success: false,
      code: 'folder_changed',
      error: 'This folder changed since you opened the dialog. Look again.'
    })

    const { status, payload } = await callDelete()

    expect(status).toBe(409)
    expect(payload.code).toBe('folder_changed')
    expect(payload.error).toBe('This folder changed since you opened the dialog. Look again.')
  })

  it('moves the chats, deleting none, without deleteSessions', async () => {
    expect((await callDelete('', null)).status).toBe(200)
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

  function stoppedAt(cause: unknown, locked = false) {
    return {
      success: false,
      code: 'folder_delete_stopped',
      error: 'stopped',
      deleted_sessions: 3,
      total_sessions: 5,
      stopped_at: { id: 'chat-4', name: 'Plans', locked },
      cause
    }
  }

  it('says how far a delete got when a chat is still stopping (409)', async () => {
    redisMock.deleteFolder.mockResolvedValue(
      stoppedAt(new SessionDeleteRefusedError('session_turn_still_stopping'))
    )
    const { status, payload } = await callDelete()
    expect(status).toBe(409)
    expect(payload.error).toBe(
      'Deleted 3 of 5 chats. "Plans" is still stopping, so it and the folder remain. Try again.'
    )
    expect(payload).toMatchObject({ code: 'session_turn_still_stopping', deleted_sessions: 3 })
    expect(payload.cause).toBeUndefined()
  })

  it('names a chat locked during the delete (409)', async () => {
    redisMock.deleteFolder.mockResolvedValue(stoppedAt(new Error('locked'), true))
    const { status, payload } = await callDelete()
    expect(status).toBe(409)
    expect(payload.error).toBe('Deleted 3 of 5 chats. "Plans" was locked, so it and the folder remain.')
    expect(payload.code).toBe('session_locked')
  })

  it('says so honestly when a chat failed for another reason (500)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    redisMock.deleteFolder.mockResolvedValue({ ...stoppedAt(new Error('redis down')), deleted_sessions: 0 })
    const { status, payload } = await callDelete()
    expect(status).toBe(500)
    expect(payload.error).toBe(
      'No chat was deleted. "Plans" could not be deleted, so it and the folder remain. Try again.'
    )
    error.mockRestore()
  })

  it('keeps the folder when a chat arrived during the delete (409)', async () => {
    redisMock.deleteFolder.mockResolvedValue({
      success: false,
      code: 'folder_not_empty',
      error: 'x',
      deleted_sessions: 5,
      total_sessions: 5
    })
    const { status, payload } = await callDelete()
    expect(status).toBe(409)
    expect(payload.error).toBe(
      'Deleted 5 of 5 chats. A new chat arrived in the folder, so the folder remains.'
    )
    expect(payload.code).toBe('folder_not_empty')
  })

  it('keeps answering 500 for any other failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    redisMock.deleteFolder.mockRejectedValue(new Error('redis down'))

    expect((await callDelete()).status).toBe(500)
    error.mockRestore()
  })
})
