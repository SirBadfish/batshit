import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATCH_UP_RETRY_DELAYS_MS,
  resolveCatchUpRetryDelay,
  resolveChatsToCatchUpAfterUserChannelReturn,
  resolveRepliesEndedWhileAway,
  shouldCatchUpChatAfterReconnect
} from '../reconnectCatchUp'

/**
 * BL-382: after a reconnect across a reply's end, the tab never heard `end`, so the reply stayed
 * "streaming" in its run registry and the Stop button stayed. The chat's reload is the server's
 * answer: a reply is stored only when it ends (or fails), and the load keeps this tab's own
 * in-progress copy (and a newer approval-resume copy) otherwise.
 */
describe('which replies ended while the tab was away', () => {
  const msg = (id: string, status: 'complete' | 'error' | 'in_progress') => ({ id, status })

  it('a reply this tab still streams that the reload holds finished (or failed) has ended', () => {
    expect(
      resolveRepliesEndedWhileAway({
        activeMessageIds: ['a', 'b', 'c'],
        messages: [msg('a', 'complete'), msg('b', 'in_progress'), msg('c', 'error')]
      })
    ).toEqual(['a', 'c'])
  })

  it('a reply the reload does not hold (still streaming, nothing stored) keeps running', () => {
    expect(resolveRepliesEndedWhileAway({ activeMessageIds: ['a'], messages: [] })).toEqual([])
  })

  it('nothing streaming, nothing to end', () => {
    expect(resolveRepliesEndedWhileAway({ activeMessageIds: [], messages: [msg('a', 'complete')] })).toEqual([])
  })
})

describe('which chats catch up (BL-382 review)', () => {
  it('a chat subscription that came back: the chat on screen, and any chat still streaming a reply', () => {
    expect(shouldCatchUpChatAfterReconnect({ onScreen: true, streamingReplyIds: [] })).toBe(true)
    expect(shouldCatchUpChatAfterReconnect({ onScreen: false, streamingReplyIds: ['m1'] })).toBe(true)
    expect(shouldCatchUpChatAfterReconnect({ onScreen: false, streamingReplyIds: [] })).toBe(false)
  })

  it('the user channel\'s return: every chat still streaming that has no chat subscription of its own', () => {
    expect(
      resolveChatsToCatchUpAfterUserChannelReturn({
        runStates: [
          { sessionId: 'woken', activeStreamMessageIds: ['m1'] },
          { sessionId: 'subscribed', activeStreamMessageIds: ['m2'] },
          { sessionId: 'idle', activeStreamMessageIds: [] }
        ],
        chatsWithOwnSubscription: new Set(['subscribed'])
      })
    ).toEqual(['woken'])
  })
})

describe('the chat page ends them after the reconnect reload (source pins)', () => {
  const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')
  const start = page.indexOf('\n  async function catchUpAfterReconnect(sessionId: string, failedReads = 0) {\n')
  const body = page.slice(start, page.indexOf('\n  }\n', start + 1) + 1)

  it('the reconnect handler loads the chat, then ends what ended, in that order', () => {
    expect(page).toContain('\n    void catchUpAfterReconnect(sessionId)\n')
    expect(start).toBeGreaterThan(-1)
    const load = body.indexOf('\n    const outcome = await loadMessagesForSession(sessionId)\n')
    const resolve = body.indexOf('resolveRepliesEndedWhileAway({')
    expect(load).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(load)
  })

  it('it ends each one the way `end` ends its busy state, and saves nothing', () => {
    for (const step of [
      'clearThinkingIndicator(messageId)',
      'resetToolStateForMessage(messageId)',
      'resolveStreamCompletion(messageId)',
      'unregisterActiveMessage(messageId, sessionId)'
    ]) {
      expect(body).toContain(step)
    }
    expect(body).not.toContain('saveMessageToDatabase')
  })

  it('it takes the other steps a real `end` takes (steer bubbles, the Auto Compact hold, creating, previews)', () => {
    for (const step of [
      'settleSteerBubblesForMessage(sessionId, messageId, {',
      'autoCompactStopHolds = releaseAutoCompactHoldOnReplyEnd(autoCompactStopHolds, sessionId)',
      'clearCreatingSession(sessionId)',
      "void refreshLiveContextPreview('message-finalized', sessionId, {",
      'void refreshDeadCopies(sessionId)'
    ]) {
      expect(body).toContain(step)
    }
  })

  it('only the chat on screen resets the composer', () => {
    expect(body).toContain('\n    if (sessionId === sessionStore.getCurrentSessionId()) chatInputRef?.aiResponseReceived?.()\n')
  })

  it('a chat subscription\'s return catches up the chat on screen or a chat still streaming', () => {
    const start = page.indexOf('\n  function handleSSEReconnected(sessionId: string) {\n')
    const handler = page.slice(start, page.indexOf('\n  }\n', start + 1) + 1)
    expect(handler).toContain('shouldCatchUpChatAfterReconnect({')
    expect(handler).toContain('\n    void catchUpAfterReconnect(sessionId)\n')
    expect(handler).not.toContain('if (sessionId !== sessionStore.getCurrentSessionId()) return')
  })

  it('the user channel\'s return catches up the streaming chats without a chat subscription', () => {
    expect(page).toContain("\n      if (event?.type === 'reconnected') {\n")
    expect(page).toContain('resolveChatsToCatchUpAfterUserChannelReturn({')
    expect(page).toMatch(/chatsWithOwnSubscription: new Set\(sseServices\.keys\(\)\)/)
  })
})

/**
 * BL-814: a failed read of the chat cleared the tab's messages (the chat on screen went blank
 * until the next read), and a reconnect catch-up that met it found none of its replies, so their
 * busy state (the Stop button) stayed until a later read that never ended them either.
 */
describe('a catch-up whose read failed (BL-814)', () => {
  it('reads again after 2 s, 5 s, and 15 s, then stops', () => {
    expect(CATCH_UP_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000])
    expect(resolveCatchUpRetryDelay(0)).toBe(2_000)
    expect(resolveCatchUpRetryDelay(1)).toBe(5_000)
    expect(resolveCatchUpRetryDelay(2)).toBe(15_000)
    expect(resolveCatchUpRetryDelay(3)).toBeNull()
  })

  const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')
  const bodyOf = (signature: string) => {
    const start = page.indexOf(signature)
    expect(start).toBeGreaterThan(-1)
    return page.slice(start, page.indexOf('\n\t  }\n', start + 1) + 1)
  }

  it('a failed read keeps the messages the tab has, and says it failed (source pins)', () => {
    const load = bodyOf('\n  async function loadMessagesFromServer(sessionId: string): Promise<ChatLoadOutcome> {\n')
    expect(load).toContain("return 'loaded'")
    expect(load).toContain("return 'missing'")
    expect(load).toContain("return 'failed'")
    const failure = load.slice(load.indexOf("console.error('[loadMessagesForSession] Failed to load messages:', error)"))
    expect(failure).not.toContain('clearMessages')
    expect(failure).toContain("toast.error('Failed to load conversation. Please try again.')")
  })

  it('the catch-up reads again after a failed read and ends nothing on the old copy (source pins)', () => {
    const start = page.indexOf('\n  async function catchUpAfterReconnect(sessionId: string, failedReads = 0) {\n')
    const body = page.slice(start, page.indexOf('\n  }\n', start + 1) + 1)
    const failed = body.indexOf("\n    if (outcome === 'failed') {\n      scheduleCatchUpRetry(sessionId, failedReads)\n      return\n    }\n")
    expect(failed).toBeGreaterThan(-1)
    expect(failed).toBeLessThan(body.indexOf('resolveRepliesEndedWhileAway({'))
    const retry = page.slice(page.indexOf('\n  function scheduleCatchUpRetry(sessionId: string, failedReads: number) {\n'))
    expect(retry).toContain('const delay = resolveCatchUpRetryDelay(failedReads)')
    expect(retry).toContain('if (missingSessionIds.has(sessionId)) return')
    expect(retry).toContain('if (stillNeeded) void catchUpAfterReconnect(sessionId, failedReads + 1)')
  })

  it('a deleted chat and a closed page leave no read behind (source pins)', () => {
    const forget = page.indexOf('\t    chatLoadQueue.forget(sessionId)\n\t    cancelCatchUpRetry(sessionId)\n')
    expect(forget).toBeGreaterThan(-1)
    expect(page).toContain('for (const sessionId of Array.from(catchUpRetryTimers.keys())) cancelCatchUpRetry(sessionId)')
  })
})
