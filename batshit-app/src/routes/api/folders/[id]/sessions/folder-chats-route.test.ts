import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/folders/[id]/sessions (BL-388): every chat "Delete Folder + Sessions" would delete,
 * archived chats included, by the delete's own rule (a missing record and another user's chat
 * are skipped). The route and `folderChatsForDelete.ts` run for real here over a small keyed
 * store; `folderDeletion.test.ts` pins on real Redis that this list equals what the delete sweeps.
 */

const store = vi.hoisted(() => ({
  json: new Map<string, unknown>(),
  sets: new Map<string, string[]>(),
  failJsonGet: false
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: async (operation: (client: any) => Promise<unknown>) =>
      operation({
        json: {
          get: async (key: string) => {
            if (store.failJsonGet) throw new Error('redis down')
            return store.json.get(key) ?? null
          }
        },
        sMembers: async (key: string) => store.sets.get(key) ?? []
      })
  }
}))

async function callGet(userId: string | null, folderId = 'folder-1') {
  const { GET } = await import('./+server')
  const response = await GET({
    params: { id: folderId },
    locals: userId ? { user: { id: userId } } : {}
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('GET /api/folders/[id]/sessions', () => {
  beforeEach(() => {
    store.json.clear()
    store.sets.clear()
    store.failJsonGet = false
    store.json.set('folder:user-1:folder-1', {
      id: 'folder-1',
      user_id: 'user-1',
      name: 'Probe',
      is_default: false
    })
    store.sets.set('folder:user-1:folder-1:sessions', [
      'chat-active',
      'chat-archived',
      'chat-missing',
      'chat-other-user'
    ])
    store.json.set('session:chat-active', { id: 'chat-active', user_id: 'user-1', name: 'Live' })
    store.json.set('session:chat-archived', {
      id: 'chat-archived',
      user_id: 'user-1',
      name: 'Filed away',
      archived: true,
      locked: true
    })
    store.json.set('session:chat-other-user', { id: 'chat-other-user', user_id: 'user-2' })
  })

  it('lists active and archived chats, skipping a missing record and another user’s chat', async () => {
    const { status, payload } = await callGet('user-1')

    expect(status).toBe(200)
    expect(payload.folder).toEqual({ id: 'folder-1', name: 'Probe', is_default: false })
    expect(payload.chats).toEqual([
      { id: 'chat-archived', name: 'Filed away', archived: true, locked: true },
      { id: 'chat-active', name: 'Live', archived: false, locked: false }
    ])
  })

  it('answers 404 for a folder the caller does not have', async () => {
    expect((await callGet('user-2')).status).toBe(404)
  })

  it('answers 400 for the default folder, which no delete takes', async () => {
    store.json.set('folder:user-1:folder-1', {
      id: 'folder-1',
      user_id: 'user-1',
      name: 'My Chats',
      is_default: true
    })
    const { status, payload } = await callGet('user-1')
    expect(status).toBe(400)
    expect(payload.chats).toBeUndefined()
  })

  it('answers 401 without a signed-in user', async () => {
    expect((await callGet(null)).status).toBe(401)
  })

  it('answers 500, not an empty list, when a read fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    store.failJsonGet = true

    const { status, payload } = await callGet('user-1')

    expect(status).toBe(500)
    expect(payload.chats).toBeUndefined()
    error.mockRestore()
  })
})
