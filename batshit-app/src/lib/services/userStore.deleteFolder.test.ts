import { afterEach, describe, expect, it, vi } from 'vitest'

import { userStore } from './userStore'

/**
 * BL-388: Delete Folder + Sessions must name the chats its dialog showed; the server refuses it
 * otherwise. The type makes every caller of this path pass them, and they travel in the body.
 */
describe('userStore.deleteFolder', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the chat ids a Delete Folder + Sessions was shown', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, deleted_sessions: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await userStore.deleteFolder('folder-1', { deleteSessions: true, expectedChatIds: ['chat-1'] })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/folders/folder-1?deleteSessions=true')
    expect(init?.method).toBe('DELETE')
    expect(JSON.parse(String(init?.body))).toEqual({ expectedChatIds: ['chat-1'] })
  })

  it('does not accept deleteSessions without the ids (type check)', () => {
    const call = () =>
      // @ts-expect-error BL-388: deleteSessions: true requires expectedChatIds.
      userStore.deleteFolder('folder-1', { deleteSessions: true })
    expect(typeof call).toBe('function')
  })
})
