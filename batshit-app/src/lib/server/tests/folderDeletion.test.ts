import { describe, expect, it, vi } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()

async function createRedisService() {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return new actual.RedisService()
}

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('folder deletion', () => {
  it('keeps the default folder pinned while ordering other folders by latest activity', async () => {
    const redis = await createRedisService()
    const userId = 'folder-order-user'
    const defaultFolder = await redis.getDefaultFolder(userId)
    const olderFolder = await redis.createFolder({
      id: 'folder-order-older',
      user_id: userId,
      name: 'Older Folder',
      is_default: false,
      is_expanded: true,
      sort_order: 999,
      last_used_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z'
    })
    const newerFolder = await redis.createFolder({
      id: 'folder-order-newer',
      user_id: userId,
      name: 'Newer Folder',
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      last_used_at: '2026-02-01T00:00:00.000Z',
      created_at: '2026-02-01T00:00:00.000Z'
    })

    await redis.createSession({
      id: 'folder-order-session',
      user_id: userId,
      name: 'Order Test Session',
      folder_id: olderFolder.id,
      created_at: '2026-01-02T00:00:00.000Z',
      last_modified_at: '2026-01-02T00:00:00.000Z',
      locked: false
    })

    let folders = await redis.getFolders(userId)
    expect(folders.map((folder) => folder.id)).toEqual([
      defaultFolder.id,
      newerFolder.id,
      olderFolder.id
    ])

    await redis.updateSession('folder-order-session', { name: 'Recently Used Session' })

    folders = await redis.getFolders(userId)
    expect(folders.map((folder) => folder.id)).toEqual([
      defaultFolder.id,
      olderFolder.id,
      newerFolder.id
    ])
  })

  it('keeps the safe default by moving sessions to the default folder', async () => {
    const redis = await createRedisService()
    const userId = 'folder-delete-user'
    const defaultFolder = await redis.getDefaultFolder(userId)
    const folder = await redis.createFolder({
      id: 'folder-delete-move',
      user_id: userId,
      name: 'Move Me',
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      created_at: new Date().toISOString()
    })

    await redis.createSession({
      id: 'session-move-me',
      user_id: userId,
      name: 'Move Session',
      folder_id: folder.id,
      locked: false
    })

    const result = await redis.deleteFolder(userId, folder.id)

    expect(result).toMatchObject({
      success: true,
      moved_to: defaultFolder.id
    })
    expect(await redis.getFolder(userId, folder.id)).toBeNull()
    expect(await redis.getSession('session-move-me')).toMatchObject({
      id: 'session-move-me',
      folder_id: defaultFolder.id
    })
  })

  it('deletes folder sessions when explicitly requested', async () => {
    const redis = await createRedisService()
    const userId = 'folder-delete-with-sessions-user'
    const folder = await redis.createFolder({
      id: 'folder-delete-with-sessions',
      user_id: userId,
      name: 'Delete Everything',
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      created_at: new Date().toISOString()
    })

    await redis.createSession({
      id: 'session-delete-with-folder',
      user_id: userId,
      name: 'Delete Me',
      folder_id: folder.id,
      locked: false
    })

    const result = await redis.deleteFolder(userId, folder.id, {
      deleteSessions: true,
      deleteSession: (sessionId) => redis.deleteSession(sessionId),
      expectedSessionIds: ['session-delete-with-folder']
    })

    expect(result).toMatchObject({
      success: true,
      deleted_sessions: 1
    })
    expect(await redis.getFolder(userId, folder.id)).toBeNull()
    expect(await redis.getSession('session-delete-with-folder')).toBeNull()
  })

  it('does not delete a folder and sessions when any contained session is locked', async () => {
    const redis = await createRedisService()
    const userId = 'folder-delete-locked-user'
    const folder = await redis.createFolder({
      id: 'folder-delete-locked',
      user_id: userId,
      name: 'Locked Folder',
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      created_at: new Date().toISOString()
    })

    await redis.createSession({
      id: 'session-locked-in-folder',
      user_id: userId,
      name: 'Locked Session',
      folder_id: folder.id,
      locked: true
    })

    const result = await redis.deleteFolder(userId, folder.id, {
      deleteSessions: true,
      deleteSession: (sessionId) => redis.deleteSession(sessionId),
      expectedSessionIds: ['session-locked-in-folder']
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('locked')
    expect(await redis.getFolder(userId, folder.id)).toMatchObject({
      id: folder.id
    })
    expect(await redis.getSession('session-locked-in-folder')).toMatchObject({
      id: 'session-locked-in-folder',
      folder_id: folder.id,
      locked: true
    })
  })

  it('lists archived chats for the delete dialog, the same set the delete sweeps (BL-388)', async () => {
    const redis = await createRedisService()
    const { selectFolderChats } = await import('$lib/server/services/folderChatsForDelete')
    const readFolderChatsForDelete = (user: string, id: string, facade: typeof redis) =>
      facade.execute((client) => selectFolderChats(client, user, id))
    const userId = 'folder-delete-archived-user'
    const folder = await redis.createFolder({
      id: 'folder-delete-archived',
      user_id: userId,
      name: 'Archived Only',
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      created_at: new Date().toISOString()
    })
    for (const id of ['session-archived-a', 'session-archived-b']) {
      await redis.createSession({ id, user_id: userId, name: id, folder_id: folder.id, locked: false })
      await redis.archiveSession(id)
    }

    // The page's count: the folder record's chat_count, which leaves archived chats out.
    expect((await redis.getFolder(userId, folder.id))?.chat_count).toBe(0)

    const listed = await readFolderChatsForDelete(userId, folder.id, redis)
    expect(listed?.chats.map((chat) => [chat.id, chat.archived])).toEqual([
      ['session-archived-a', true],
      ['session-archived-b', true]
    ])

    const swept: string[] = []
    const result = await redis.deleteFolder(userId, folder.id, {
      deleteSessions: true,
      deleteSession: async (sessionId) => {
        swept.push(sessionId)
        await redis.deleteSession(sessionId)
      },
      expectedSessionIds: listed!.chats.map((chat) => chat.id)
    })

    expect(result).toMatchObject({ success: true, deleted_sessions: 2 })
    expect([...swept].sort()).toEqual(listed?.chats.map((chat) => chat.id))
    expect(await redis.getSession('session-archived-a')).toBeNull()
    expect(await readFolderChatsForDelete(userId, folder.id, redis)).toBeNull()
  })

  it('deletes nothing when the folder changed since the dialog listed it (BL-388)', async () => {
    const redis = await createRedisService()
    const userId = 'folder-delete-changed-user'
    const folder = await redis.createFolder({
      id: 'folder-delete-changed',
      user_id: userId,
      name: 'Changed',
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      created_at: new Date().toISOString()
    })
    await redis.createSession({
      id: 'session-changed-shown',
      user_id: userId,
      name: 'Shown',
      folder_id: folder.id,
      locked: false
    })
    // A chat arrives after the dialog listed only the first one.
    await redis.createSession({
      id: 'session-changed-new',
      user_id: userId,
      name: 'Arrived later',
      folder_id: folder.id,
      locked: false
    })

    const swept: string[] = []
    const result = await redis.deleteFolder(userId, folder.id, {
      deleteSessions: true,
      deleteSession: async (sessionId) => {
        swept.push(sessionId)
      },
      expectedSessionIds: ['session-changed-shown']
    })

    expect(result).toMatchObject({
      success: false,
      code: 'folder_changed',
      error: 'This folder changed since you opened the dialog. Look again.'
    })
    expect(swept).toEqual([])
    expect(await redis.getFolder(userId, folder.id)).toMatchObject({ id: folder.id })
    expect(await redis.getSession('session-changed-shown')).toMatchObject({ id: 'session-changed-shown' })
  })

  async function folderWithChats(redis: any, userId: string, folderId: string, names: string[]) {
    await redis.createFolder({
      id: folderId,
      user_id: userId,
      name: folderId,
      is_default: false,
      is_expanded: true,
      sort_order: 1,
      created_at: new Date().toISOString()
    })
    for (const name of names) {
      await redis.createSession({ id: `${folderId}-${name}`, user_id: userId, name, folder_id: folderId, locked: false })
    }
    return names.map((name) => `${folderId}-${name}`)
  }

  it('stops at a chat whose delete is refused, keeps the folder, and says how far it got (BL-388)', async () => {
    const redis = await createRedisService()
    const { SessionDeleteRefusedError } = await import('$lib/server/services/sessionDeleteTurnStop')
    const userId = 'folder-partial-user'
    const ids = await folderWithChats(redis, userId, 'folder-partial', ['A first', 'B second', 'C third'])

    const refusal = new SessionDeleteRefusedError('session_turn_still_stopping')
    const result = await redis.deleteFolder(userId, 'folder-partial', {
      deleteSessions: true,
      deleteSession: async (sessionId) => {
        if (sessionId === ids[1]) throw refusal
        await redis.deleteSession(sessionId)
      },
      expectedSessionIds: ids
    })

    expect(result).toMatchObject({
      success: false,
      code: 'folder_delete_stopped',
      deleted_sessions: 1,
      total_sessions: 3,
      stopped_at: { id: ids[1], name: 'B second', locked: false }
    })
    expect((result as any).cause).toBe(refusal)
    expect(await redis.getSession(ids[0])).toBeNull()
    expect(await redis.getSession(ids[1])).toMatchObject({ id: ids[1] })
    expect(await redis.getSession(ids[2])).toMatchObject({ id: ids[2] })
    expect(await redis.getFolder(userId, 'folder-partial')).toMatchObject({ id: 'folder-partial' })
  })

  it('stops at a chat locked during the delete and names it as locked (BL-388)', async () => {
    const redis = await createRedisService()
    const userId = 'folder-locked-late-user'
    const ids = await folderWithChats(redis, userId, 'folder-locked-late', ['A first', 'B second'])

    const result = await redis.deleteFolder(userId, 'folder-locked-late', {
      deleteSessions: true,
      deleteSession: async (sessionId) => {
        if (sessionId === ids[0]) {
          // Someone locks the second chat while the first one is being deleted.
          await redis.updateSession(ids[1], { locked: true })
          await redis.deleteSession(sessionId)
          return
        }
        throw new Error('Session is locked and cannot be deleted until unlocked')
      },
      expectedSessionIds: ids
    })

    expect(result).toMatchObject({
      success: false,
      code: 'folder_delete_stopped',
      deleted_sessions: 1,
      total_sessions: 2,
      stopped_at: { id: ids[1], name: 'B second', locked: true }
    })
    expect(await redis.getFolder(userId, 'folder-locked-late')).toMatchObject({ id: 'folder-locked-late' })
  })

  it('keeps the folder, moving nothing, when a chat arrived during the delete (BL-388)', async () => {
    const redis = await createRedisService()
    const userId = 'folder-arrival-user'
    const ids = await folderWithChats(redis, userId, 'folder-arrival', ['A first', 'B second'])

    const result = await redis.deleteFolder(userId, 'folder-arrival', {
      deleteSessions: true,
      deleteSession: async (sessionId) => {
        if (sessionId === ids[0]) {
          await redis.createSession({
            id: 'folder-arrival-late',
            user_id: userId,
            name: 'Late',
            folder_id: 'folder-arrival',
            locked: false
          })
        }
        await redis.deleteSession(sessionId)
      },
      expectedSessionIds: ids
    })

    expect(result).toMatchObject({
      success: false,
      code: 'folder_not_empty',
      deleted_sessions: 2,
      total_sessions: 2
    })
    expect(await redis.getFolder(userId, 'folder-arrival')).toMatchObject({ id: 'folder-arrival' })
    expect(await redis.getSession('folder-arrival-late')).toMatchObject({ folder_id: 'folder-arrival' })
  })

  it('never deletes the default folder', async () => {
    const redis = await createRedisService()
    const userId = 'folder-delete-default-user'
    const defaultFolder = await redis.getDefaultFolder(userId)

    const result = await redis.deleteFolder(userId, defaultFolder.id, {
      deleteSessions: true,
      deleteSession: (sessionId) => redis.deleteSession(sessionId),
      expectedSessionIds: []
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Cannot delete default folder')
    expect(await redis.getFolder(userId, defaultFolder.id)).toMatchObject({
      id: defaultFolder.id,
      is_default: true
    })
  })
})
