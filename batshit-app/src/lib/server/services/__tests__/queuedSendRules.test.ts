import { describe, expect, it } from 'vitest'

import {
  QUEUED_SEND_CAP,
  QUEUED_SEND_KEPT_CODE,
  buildQueuedSendKeptAnswer,
  buildQueuedSendOverflowAnswer,
  decideQueuedSend,
  isQueueableSend,
  isSavedUserMessageForSend,
  mergeQueuedSendHistory,
  resentMessageCreatedAt,
  sentWhileReplyRan,
  shouldMoveSentMessageToEnd
} from '../queuedSendRules'
import { hasUserTurnContent } from '../approvalResumeMessage'

/**
 * BL-4 — the rules a send that meets another turn is held to. The wiring in send-routed is
 * pinned by `send-routed-queued-send-contract.test.ts`; the decisions are here, where a mutation
 * can reach them.
 */
describe('isQueueableSend', () => {
  const page = {
    prefersRespondAsync: true,
    approvalClick: false,
    hasUserContent: true,
    userMessageId: 'msg_20260922-120000_0003',
    wake: undefined
  }

  it('queues the page’s own ordinary send, which names the message it saved', () => {
    expect(isQueueableSend(page)).toBe(true)
  })

  it('never queues an approval click: it answers one card and has its own wait', () => {
    expect(isQueueableSend({ ...page, approvalClick: true })).toBe(false)
  })

  it('never queues a woken turn: it keeps today’s agent_busy', () => {
    expect(isQueueableSend({ ...page, wake: { chainDepth: 1 } })).toBe(false)
  })

  it('never queues a caller that waits for the end of its turn (voice, share, smoke, drivers)', () => {
    expect(isQueueableSend({ ...page, prefersRespondAsync: false })).toBe(false)
  })

  it('never queues a send without words or without a saved message to reuse', () => {
    expect(isQueueableSend({ ...page, hasUserContent: false })).toBe(false)
    expect(isQueueableSend({ ...page, userMessageId: '' })).toBe(false)
    expect(isQueueableSend({ ...page, userMessageId: '   ' })).toBe(false)
    expect(isQueueableSend({ ...page, userMessageId: 42 })).toBe(false)
  })
})

describe('decideQueuedSend', () => {
  it('lets a send through when the chat is free and nobody is waiting', () => {
    expect(decideQueuedSend({ lockHeld: false, queuedTurns: 0, runnableQueuedTurns: 0 })).toBe('free')
  })

  it('queues behind a held lock, and behind a waiting line even while the chat is free', () => {
    expect(decideQueuedSend({ lockHeld: true, queuedTurns: 0, runnableQueuedTurns: 0 })).toBe('queue')
    expect(decideQueuedSend({ lockHeld: false, queuedTurns: 1, runnableQueuedTurns: 1 })).toBe('queue')
  })

  it('refuses the sixth: five runnable sends is the cap, and kept ones do not count', () => {
    expect(QUEUED_SEND_CAP).toBe(5)
    expect(decideQueuedSend({ lockHeld: true, queuedTurns: 4, runnableQueuedTurns: 4 })).toBe('queue')
    expect(decideQueuedSend({ lockHeld: true, queuedTurns: 5, runnableQueuedTurns: 5 })).toBe('overflow')
    expect(decideQueuedSend({ lockHeld: true, queuedTurns: 7, runnableQueuedTurns: 2 })).toBe('queue')
  })
})

describe('isSavedUserMessageForSend', () => {
  const saved = { id: 'u-1', role: 'user', session_id: 'chat', user_id: 'josh', content: 'hi' }

  it('accepts the user’s own saved message in this chat', () => {
    expect(isSavedUserMessageForSend(saved, { sessionId: 'chat', userId: 'josh', userMessageId: 'u-1' })).toBe(true)
  })

  it('refuses anything else: another chat, another user, a reply, a different id, nothing', () => {
    const ctx = { sessionId: 'chat', userId: 'josh', userMessageId: 'u-1' }
    expect(isSavedUserMessageForSend({ ...saved, session_id: 'other' }, ctx)).toBe(false)
    expect(isSavedUserMessageForSend({ ...saved, user_id: 'someone' }, ctx)).toBe(false)
    expect(isSavedUserMessageForSend({ ...saved, role: 'assistant' }, ctx)).toBe(false)
    expect(isSavedUserMessageForSend({ ...saved, id: 'u-2' }, ctx)).toBe(false)
    expect(isSavedUserMessageForSend(null, ctx)).toBe(false)
  })
})

describe('mergeQueuedSendHistory', () => {
  const m = (id: string, role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}) => ({
    id,
    role,
    content,
    ...extra
  })

  it('keeps the browser’s view, adds what the chat got while the send waited, and ends with the send', () => {
    // The browser trimmed m1 away and put its notice in its place; the store still has m1.
    const notice = m('trim-notice', 'assistant', '[older messages trimmed]')
    const requestHistory = [notice, m('m2', 'user', 'q2'), m('m3', 'assistant', 'a2'), m('b', 'user', 'SECOND')]
    const storedRecent = [
      m('m1', 'user', 'q1'),
      m('m2', 'user', 'q2'),
      m('m3', 'assistant', 'a2'),
      m('a', 'user', 'FIRST'),
      m('a-reply', 'assistant', 'FIRST DONE'),
      m('b', 'user', 'SECOND')
    ]
    const merged = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'b' })
    expect(merged.map((message) => message.id)).toEqual(['trim-notice', 'm2', 'm3', 'a', 'a-reply', 'b'])
  })

  it('uses the browser’s own copy of the send, and takes it out of the middle wherever it sat', () => {
    const own = m('b', 'user', 'SECOND')
    const requestHistory = [m('m2', 'user', 'q2'), own, m('a', 'user', 'FIRST')]
    const storedRecent = [m('m2', 'user', 'q2'), m('a', 'user', 'FIRST'), m('a-reply', 'assistant', 'FIRST DONE'), m('b', 'user', 'stored copy')]
    const merged = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'b' })
    expect(merged.map((message) => message.id)).toEqual(['m2', 'a', 'a-reply', 'b'])
    expect(merged.at(-1)).toBe(own)
  })

  it('drops a reply placeholder the browser still had, and takes the finished reply from the store', () => {
    const requestHistory = [
      m('a', 'user', 'FIRST'),
      m('a-reply', 'assistant', '', { status: 'in_progress' }),
      m('b-placeholder', 'assistant', '', { metadata: { client_waiting_placeholder: true } }),
      m('b', 'user', 'SECOND')
    ]
    const storedRecent = [m('a', 'user', 'FIRST'), m('a-reply', 'assistant', 'FIRST DONE'), m('b', 'user', 'SECOND')]
    const merged = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'b' })
    expect(merged.map((message) => message.id)).toEqual(['a', 'a-reply', 'b'])
    expect(merged[1]?.content).toBe('FIRST DONE')
  })

  it('leaves out any other send still waiting in the line, from either source', () => {
    const requestHistory = [m('a', 'user', 'FIRST'), m('c', 'user', 'THIRD, still waiting'), m('b', 'user', 'SECOND')]
    const storedRecent = [m('a', 'user', 'FIRST'), m('a-reply', 'assistant', 'FIRST DONE'), m('b', 'user', 'SECOND')]
    const merged = mergeQueuedSendHistory({
      requestHistory,
      storedRecent,
      userMessageId: 'b',
      isStillQueued: (id) => id === 'c'
    })
    expect(merged.map((message) => message.id)).toEqual(['a', 'a-reply', 'b'])
  })

  it('never repeats a message', () => {
    const requestHistory = [m('a', 'user', 'FIRST'), m('a-reply', 'assistant', 'FIRST DONE'), m('b', 'user', 'SECOND')]
    const storedRecent = [m('a', 'user', 'FIRST'), m('a-reply', 'assistant', 'FIRST DONE'), m('b', 'user', 'SECOND')]
    const ids = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'b' }).map((message) => message.id)
    expect(ids).toEqual(['a', 'a-reply', 'b'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  // BL-904: a message the tab knows can be stored AFTER the reply the send waited behind. The
  // tab's copy of that reply is a placeholder, and its finished form sits before the last known
  // message, so it must come back at its stored place, not only when it is the newest thing.
  it('takes the finished reply back at its place when a held message stands after it (BL-904, A)', () => {
    // A reply stopped at a card, typed words were held below it (BL-455), the user approved,
    // and a message with a Clip was sent during the resumed reply.
    const requestHistory = [
      m('q', 'user', 'run it'),
      m('card', 'assistant', 'May I?', { status: 'in_progress' }),
      m('held', 'user', 'and then tidy up', { metadata: { waitsForApproval: { messageId: 'card' } } }),
      m('clip', 'user', 'look at this')
    ]
    const storedRecent = [
      m('q', 'user', 'run it'),
      m('card', 'assistant', 'May I? Done: 3 files.'),
      m('held', 'user', 'and then tidy up'),
      m('held-reply', 'assistant', 'Tidied.'),
      m('clip', 'user', 'look at this')
    ]
    const merged = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'clip' })
    expect(merged.map((message) => message.id)).toEqual(['q', 'card', 'held', 'held-reply', 'clip'])
    expect(merged[1]?.content).toBe('May I? Done: 3 files.')
  })

  it('takes the reply both sends waited behind back when the first one ran before the second (BL-904, B)', () => {
    // The second waiting send was posted while its tab still listed the first one.
    const requestHistory = [
      m('q', 'user', 'go'),
      m('reply', 'assistant', '', { metadata: { client_waiting_placeholder: true } }),
      m('first', 'user', 'FIRST'),
      m('second', 'user', 'SECOND')
    ]
    const storedRecent = [
      m('q', 'user', 'go'),
      m('reply', 'assistant', 'GONE'),
      m('first', 'user', 'FIRST'),
      m('first-reply', 'assistant', 'FIRST DONE'),
      m('second', 'user', 'SECOND')
    ]
    const merged = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'second' })
    expect(merged.map((message) => message.id)).toEqual(['q', 'reply', 'first', 'first-reply', 'second'])
    expect(merged[1]?.content).toBe('GONE')
  })

  it('invents nothing for a placeholder whose reply was never stored (a crash) (BL-904)', () => {
    const requestHistory = [
      m('q', 'user', 'go'),
      m('lost', 'assistant', '', { status: 'in_progress' }),
      m('held', 'user', 'then this'),
      m('clip', 'user', 'CLIP')
    ]
    const storedRecent = [m('q', 'user', 'go'), m('held', 'user', 'then this'), m('clip', 'user', 'CLIP')]
    const merged = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'clip' })
    expect(merged.map((message) => message.id)).toEqual(['q', 'held', 'clip'])
  })

  it('brings back only the placeholder’s reply, never a message the browser trimmed away (BL-904)', () => {
    const requestHistory = [
      m('trim-notice', 'assistant', '[older messages trimmed]'),
      m('card', 'assistant', '', { status: 'in_progress' }),
      m('held', 'user', 'then this'),
      m('clip', 'user', 'CLIP')
    ]
    const storedRecent = [
      m('old', 'user', 'trimmed away'),
      m('card', 'assistant', 'DONE'),
      m('held', 'user', 'then this'),
      m('clip', 'user', 'CLIP')
    ]
    const ids = mergeQueuedSendHistory({ requestHistory, storedRecent, userMessageId: 'clip' }).map((message) => message.id)
    expect(ids).toEqual(['trim-notice', 'card', 'held', 'clip'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('falls back to the stored copy of the send when the browser did not carry one', () => {
    const merged = mergeQueuedSendHistory({
      requestHistory: [m('a', 'user', 'FIRST')],
      storedRecent: [m('a', 'user', 'FIRST'), m('a-reply', 'assistant', 'FIRST DONE'), m('b', 'user', 'SECOND')],
      userMessageId: 'b'
    })
    expect(merged.map((message) => message.id)).toEqual(['a', 'a-reply', 'b'])
  })
})

describe('sentWhileReplyRan (BL-906 b)', () => {
  // A send made while its tab still drew a reply belongs behind that reply: it joins the chat's
  // line even when the reply's request is only finishing, so a card that reply raised holds it
  // (BL-713). A send made after the tab saw the reply end is the user's new message (BL-455).
  it('is true when the send’s history holds a reply its tab was still drawing', () => {
    expect(
      sentWhileReplyRan([
        { id: 'q', role: 'user', content: 'go' },
        { id: 'r', role: 'assistant', content: 'wor', status: 'in_progress' },
        { id: 'clip', role: 'user', content: 'look' }
      ])
    ).toBe(true)
    expect(
      sentWhileReplyRan([
        { id: 'q', role: 'user', content: 'go' },
        { id: 'r', role: 'assistant', content: '', metadata: { client_waiting_placeholder: true } }
      ])
    ).toBe(true)
  })

  it('ignores the send’s own reply placeholder, which the page adds before it builds the history (review)', () => {
    // An ordinary send from an idle tab: the page draws its own waiting placeholder, named by the
    // body's `messageId`, and posts it in the history. That is not a reply the tab was drawing.
    const ownPlaceholder = { id: 'own-reply', role: 'assistant', content: '', status: 'in_progress', metadata: { client_waiting_placeholder: true } }
    const history = [
      { id: 'q', role: 'user', content: 'go' },
      { id: 'r', role: 'assistant', content: 'May I?', status: 'complete' },
      { id: 'next', role: 'user', content: 'no, wait' },
      ownPlaceholder
    ]
    expect(sentWhileReplyRan(history, 'own-reply')).toBe(false)
    // Another reply still drawn beside it counts.
    expect(
      sentWhileReplyRan([{ id: 'r', role: 'assistant', content: 'wor', status: 'in_progress' }, ownPlaceholder], 'own-reply')
    ).toBe(true)
  })

  it('is false once the tab saw the reply end, and for anything that is not a history', () => {
    expect(
      sentWhileReplyRan([
        { id: 'q', role: 'user', content: 'go' },
        { id: 'r', role: 'assistant', content: 'May I?', status: 'complete' },
        { id: 'next', role: 'user', content: 'no, wait' }
      ])
    ).toBe(false)
    expect(sentWhileReplyRan([{ id: 'u', role: 'user', content: 'x', status: 'in_progress' }])).toBe(false)
    expect(sentWhileReplyRan(undefined)).toBe(false)
    expect(sentWhileReplyRan('nope')).toBe(false)
  })
})

describe('shouldMoveSentMessageToEnd', () => {
  const history = (...ids: string[]) => ids.map((id) => ({ id, role: 'user', content: id }))

  it('leaves a fresh send where it was saved: it is the newest thing its tab knows', () => {
    expect(
      shouldMoveSentMessageToEnd({ idsAfter: [], requestHistory: history('m1', 'a'), userMessageId: 'a' })
    ).toBe(false)
  })

  it('leaves it before a message another tab saved while it was being sent (measured live, BL-4)', () => {
    // Tab B saved its message a moment after tab A's; tab A's page never knew about it. Moving
    // A after it restamped A later than the reply tab A had already added, and tab A then drew
    // its own reply above its question.
    expect(
      shouldMoveSentMessageToEnd({ idsAfter: ['b'], requestHistory: history('m1', 'a'), userMessageId: 'a' })
    ).toBe(false)
  })

  it('leaves it before a message still waiting in the line, even one its tab knew', () => {
    expect(
      shouldMoveSentMessageToEnd({
        idsAfter: ['c'],
        requestHistory: history('m1', 'c', 'b'),
        userMessageId: 'b',
        isStillQueued: (id) => id === 'c'
      })
    ).toBe(false)
  })

  it('moves a Send now after what the user said since, which its tab knew', () => {
    // Stop kept B and C, in that order, at the end of the chat; Send now on B sends it now.
    expect(
      shouldMoveSentMessageToEnd({
        idsAfter: ['c'],
        requestHistory: history('m1', 'stopped-reply', 'c', 'b'),
        userMessageId: 'b'
      })
    ).toBe(true)
    expect(
      shouldMoveSentMessageToEnd({
        idsAfter: ['d', 'd-reply'],
        requestHistory: history('m1', 'd', 'd-reply', 'b'),
        userMessageId: 'b'
      })
    ).toBe(true)
  })

  it('reads nothing into a malformed list or history', () => {
    expect(shouldMoveSentMessageToEnd({ idsAfter: null, requestHistory: history('c'), userMessageId: 'b' })).toBe(false)
    expect(shouldMoveSentMessageToEnd({ idsAfter: ['c'], requestHistory: null, userMessageId: 'b' })).toBe(false)
  })
})

describe('resentMessageCreatedAt', () => {
  const stored = '2026-09-22T18:00:00.000Z'

  it('stamps a resent message with its tab’s own time of sending, so that tab’s reply sorts after it', () => {
    const sentAt = '2026-09-22T18:05:00.000Z'
    expect(resentMessageCreatedAt({ id: 'b', created_at: sentAt }, stored)).toBe(sentAt)
  })

  it('lets the server’s clock decide when the tab’s time is missing, unreadable, or older than the stored message', () => {
    expect(resentMessageCreatedAt({ id: 'b' }, stored)).toBeNull()
    expect(resentMessageCreatedAt({ id: 'b', created_at: 'yesterday-ish' }, stored)).toBeNull()
    expect(resentMessageCreatedAt({ id: 'b', created_at: '2026-09-22T17:59:59.000Z' }, stored)).toBeNull()
    expect(resentMessageCreatedAt(null, stored)).toBeNull()
  })

  it('never dates it later than the server’s own clock: a tab whose clock runs ahead gets the server’s time (BL-197)', () => {
    // Every reply is dated by the server's clock. A resent message dated by a tab running ahead
    // of it sorted after its own reply in every reader that orders a chat by time.
    const serverNow = Date.parse('2026-09-22T18:10:00.000Z')
    expect(resentMessageCreatedAt({ id: 'b', created_at: '2026-09-22T18:10:01.000Z' }, stored, serverNow)).toBeNull()
    expect(resentMessageCreatedAt({ id: 'b', created_at: '2026-09-22T19:00:00.000Z' }, stored, serverNow)).toBeNull()
    // At or behind the server's clock, the tab's own time stands (its reply, drawn by that tab's
    // clock, sorts after it).
    expect(resentMessageCreatedAt({ id: 'b', created_at: '2026-09-22T18:10:00.000Z' }, stored, serverNow)).toBe(
      '2026-09-22T18:10:00.000Z'
    )
    expect(resentMessageCreatedAt({ id: 'b', created_at: '2026-09-22T18:09:59.000Z' }, stored, serverNow)).toBe(
      '2026-09-22T18:09:59.000Z'
    )
  })
})

describe('buildQueuedSendOverflowAnswer', () => {
  it('is today’s refusal, and says where the words will be', () => {
    const kept = buildQueuedSendOverflowAnswer()
    expect(kept.code).toBe('session_turn_in_progress')
    expect(kept.details).toMatch(/will show after them, unanswered/)
  })

  it('promises no move while a restore drains: the words stay where they were sent (second review)', () => {
    const notKept = buildQueuedSendOverflowAnswer({ keptInLine: false })
    expect(notKept.code).toBe('session_turn_in_progress')
    expect(notKept.details).not.toMatch(/after them/)
    expect(notKept.details).toMatch(/where you sent it, unanswered/)
  })
})

describe('buildQueuedSendKeptAnswer', () => {
  it('says the send was kept, why, and that the words are in the chat', () => {
    const stopped = buildQueuedSendKeptAnswer('stopped')
    expect(stopped.code).toBe(QUEUED_SEND_KEPT_CODE)
    expect(stopped.reason).toBe('stopped')
    expect(stopped.error).toMatch(/Not sent/)
    expect(stopped.details).toMatch(/in the chat/)
    expect(buildQueuedSendKeptAnswer('shutdown').reason).toBe('shutdown')
  })

  it('says why a send kept at an approval card was not sent, in BL-455’s words (BL-713)', () => {
    const waited = buildQueuedSendKeptAnswer('approval_wait')
    expect(waited).toMatchObject({ code: QUEUED_SEND_KEPT_CODE, reason: 'approval_wait' })
    expect(waited.details).toBe(
      'The approval card is still waiting for your answer. Your message is in the chat, unanswered.'
    )
    const expired = buildQueuedSendKeptAnswer('approval_expired')
    expect(expired).toMatchObject({ code: QUEUED_SEND_KEPT_CODE, reason: 'approval_expired' })
    expect(expired.details).toBe('The approval card expired. Your message is in the chat, unanswered.')
  })
})

describe('a message whose only content is a Clip or a file (BL-713 build check)', () => {
  it('carries a user turn, so it waits in the line like any other send', () => {
    // The composer sends a Clip as its placeholder in the words; a message of only that is words.
    const clipOnly = '{{batshit-clip:clip_20260928_120000_ab12:::photo.png}}'
    expect(hasUserTurnContent(clipOnly)).toBe(true)
    expect(isQueueableSend({
      prefersRespondAsync: true,
      approvalClick: false,
      hasUserContent: hasUserTurnContent(clipOnly),
      userMessageId: 'msg_user_client_1',
      wake: undefined
    })).toBe(true)
  })
})
