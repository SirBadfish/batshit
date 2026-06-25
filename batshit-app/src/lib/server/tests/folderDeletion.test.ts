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

    const result = await redis.deleteFolder(userId, folder.id, { deleteSessions: true })

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

    const result = await redis.deleteFolder(userId, folder.id, { deleteSessions: true })

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

  it('never deletes the default folder', async () => {
    const redis = await createRedisService()
    const userId = 'folder-delete-default-user'
    const defaultFolder = await redis.getDefaultFolder(userId)

    const result = await redis.deleteFolder(userId, defaultFolder.id, { deleteSessions: true })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Cannot delete default folder')
    expect(await redis.getFolder(userId, defaultFolder.id)).toMatchObject({
      id: defaultFolder.id,
      is_default: true
    })
  })
})
