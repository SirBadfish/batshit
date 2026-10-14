import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  __resetQueuedSendHiddenIdsForTests,
  filterQueuedSendMessageIds,
  hideQueuedSendMessage,
  isQueuedSendMessageHidden,
  revealQueuedSendMessage
} from '../queuedSendHiddenIds'

/**
 * BL-4 — the ids of saved messages whose send is waiting in a chat's line.
 *
 * `redis.ts` reads this on every message-list read, and the approval gates import `redis.ts`, so
 * the module must stay a leaf: `jevNeverApproves.pinning.test.ts` walks every import from those
 * gates, and a leaf adds exactly one file to that walk and nothing behind it.
 */
describe('queuedSendHiddenIds', () => {
  afterEach(() => __resetQueuedSendHiddenIdsForTests())

  it('imports nothing at all', () => {
    const source = readFileSync(
      path.resolve('src/lib/server/services/queuedSendHiddenIds.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\bimport\(/)
    expect(source).not.toMatch(/^\s*export\s+[^'"]*from\s+['"]/m)
  })

  it('hides an id for its own chat only, until it is revealed', () => {
    hideQueuedSendMessage('chat-a', 'msg-2')
    expect(isQueuedSendMessageHidden('chat-a', 'msg-2')).toBe(true)
    expect(isQueuedSendMessageHidden('chat-b', 'msg-2')).toBe(false)

    revealQueuedSendMessage('chat-a', 'msg-2')
    expect(isQueuedSendMessageHidden('chat-a', 'msg-2')).toBe(false)
  })

  it('filters a positional page without widening it, so a page never skips or repeats', () => {
    hideQueuedSendMessage('chat-a', 'msg-3')
    const pageOne = ['msg-1', 'msg-2', 'msg-3']
    const pageTwo = ['msg-4', 'msg-5', 'msg-6']
    const shownOne = filterQueuedSendMessageIds('chat-a', pageOne)
    const shownTwo = filterQueuedSendMessageIds('chat-a', pageTwo)

    // The hidden id leaves a shorter page; nothing is pulled in from the next one.
    expect(shownOne).toEqual(['msg-1', 'msg-2'])
    expect(shownTwo).toEqual(['msg-4', 'msg-5', 'msg-6'])
    // Every visible message appears exactly once across the pages.
    expect([...shownOne, ...shownTwo]).toEqual(['msg-1', 'msg-2', 'msg-4', 'msg-5', 'msg-6'])
  })

  it('returns the same array when the chat hides nothing', () => {
    const ids = ['msg-1', 'msg-2']
    expect(filterQueuedSendMessageIds('chat-a', ids)).toBe(ids)
  })

  it('forgets a chat once its last hidden id is revealed', () => {
    hideQueuedSendMessage('chat-a', 'msg-1')
    hideQueuedSendMessage('chat-a', 'msg-2')
    revealQueuedSendMessage('chat-a', 'msg-1')
    expect(filterQueuedSendMessageIds('chat-a', ['msg-1', 'msg-2'])).toEqual(['msg-1'])
    revealQueuedSendMessage('chat-a', 'msg-2')
    const ids = ['msg-1', 'msg-2']
    expect(filterQueuedSendMessageIds('chat-a', ids)).toBe(ids)
  })
})
