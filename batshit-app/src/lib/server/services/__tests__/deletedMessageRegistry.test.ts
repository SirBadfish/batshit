import { afterEach, describe, expect, it } from 'vitest'
import {
  DELETED_MESSAGE_MEMORY_CAP,
  DELETED_MESSAGE_MEMORY_MS,
  __resetDeletedMessagesForTests,
  noteMessageDeleted,
  wasMessageDeleted
} from '$lib/server/services/deletedMessageRegistry'

/** BL-776: a deleted id is remembered in process for a while, so a late server save cannot bring it back. */
describe('deletedMessageRegistry', () => {
  afterEach(() => __resetDeletedMessagesForTests())

  it('remembers a deleted id of its chat only, for its window', () => {
    noteMessageDeleted('chat-a', 'm1', 1_000)
    expect(wasMessageDeleted('chat-a', 'm1', 1_000 + DELETED_MESSAGE_MEMORY_MS - 1)).toBe(true)
    expect(wasMessageDeleted('chat-b', 'm1', 1_000)).toBe(false)
    expect(wasMessageDeleted('chat-a', 'm1', 1_000 + DELETED_MESSAGE_MEMORY_MS)).toBe(false)
  })

  it('keeps at most its cap, oldest first', () => {
    for (let index = 0; index <= DELETED_MESSAGE_MEMORY_CAP; index += 1) noteMessageDeleted('chat', `m${index}`, 5_000)
    expect(wasMessageDeleted('chat', 'm0', 5_000)).toBe(false)
    expect(wasMessageDeleted('chat', 'm1', 5_000)).toBe(true)
    expect(wasMessageDeleted('chat', `m${DELETED_MESSAGE_MEMORY_CAP}`, 5_000)).toBe(true)
  })
})
