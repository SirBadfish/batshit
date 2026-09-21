import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A deleted chat is announced to every tab of its owner (2026-09-18).
 *
 * Seen live during the delete-mid-reply fix: a chat deleted in one tab stayed in every other
 * tab's sidebar, and on screen in a tab showing it, until that tab reloaded, because no event
 * said a chat was gone (`session_created` had no opposite). `deleteSessionStoppingItsTurn` is the
 * only server delete of a chat (the session route and Delete Folder + Sessions), so it says so
 * once the chat is swept: `session_deleted` on the owner's user channel.
 */

const order: string[] = []
const redisMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  deleteSession: vi.fn()
}))
const publishUserEvent = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({ redis: redisMock }))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent }))

import {
  __resetStreamAbortRegistryForTests,
  beginSessionDelete,
  endSessionDelete
} from '$lib/server/services/streamAbortRegistry'
import {
  SessionDeleteRefusedError,
  deleteSessionStoppingItsTurn
} from '$lib/server/services/sessionDeleteTurnStop'

beforeEach(() => {
  order.length = 0
  __resetStreamAbortRegistryForTests()
  redisMock.getSession.mockReset()
  redisMock.deleteSession.mockReset()
  publishUserEvent.mockReset()
  redisMock.getSession.mockResolvedValue({ id: 'chat-1', user_id: 'josh', locked: false })
  redisMock.deleteSession.mockImplementation(async () => {
    order.push('sweep')
    return true
  })
  publishUserEvent.mockImplementation(async (_userId: string, event: { type: string }) => {
    order.push(event.type)
  })
})

afterEach(() => {
  __resetStreamAbortRegistryForTests()
})

describe('deleting a chat tells the owner’s other tabs', () => {
  it('announces session_deleted to the chat’s owner once the chat is swept', async () => {
    await deleteSessionStoppingItsTurn('chat-1')

    expect(publishUserEvent).toHaveBeenCalledTimes(1)
    expect(publishUserEvent).toHaveBeenCalledWith('josh', {
      type: 'session_deleted',
      sessionId: 'chat-1'
    })
    expect(order).toEqual(['sweep', 'session_deleted'])
  })

  it('announces nothing when the delete is refused and nothing was deleted', async () => {
    beginSessionDelete('chat-1')
    try {
      await expect(deleteSessionStoppingItsTurn('chat-1')).rejects.toBeInstanceOf(
        SessionDeleteRefusedError
      )
    } finally {
      endSessionDelete('chat-1')
    }

    expect(redisMock.deleteSession).not.toHaveBeenCalled()
    expect(publishUserEvent).not.toHaveBeenCalled()
  })

  it('announces nothing for a locked chat', async () => {
    redisMock.getSession.mockResolvedValue({ id: 'chat-1', user_id: 'josh', locked: true })

    await expect(deleteSessionStoppingItsTurn('chat-1')).rejects.toThrow(/locked/)

    expect(publishUserEvent).not.toHaveBeenCalled()
  })

  it('announces nothing when the sweep fails', async () => {
    redisMock.deleteSession.mockRejectedValue(new Error('Redis is down'))

    await expect(deleteSessionStoppingItsTurn('chat-1')).rejects.toThrow('Redis is down')

    expect(publishUserEvent).not.toHaveBeenCalled()
  })
})
