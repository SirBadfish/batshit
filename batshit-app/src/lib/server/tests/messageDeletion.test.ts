import { afterEach, describe, expect, it } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createZipFromContent } from '$lib/server/zipService'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import {
  __resetStreamAbortRegistryForTests,
  clearStreamAbort,
  isSessionDeleting,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  deleteSessionStoppingItsTurn
} from '$lib/server/services/sessionDeleteTurnStop'

useRedisTestServer()

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe('message deletion persistence', () => {
  it('removes the message from the session list and clears stale session message cache', async () => {
    const sessionId = 'session-delete-test'
    const userId = 'josh'
    const messageId = 'msg-delete-me'
    const keepMessageId = 'msg-keep-me'

    await redis.createSession({
      id: sessionId,
      user_id: userId,
      name: 'Delete Test Session'
    })

    await redis.saveMessage({
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      role: 'user',
      content: 'delete me'
    })

    await redis.saveMessage({
      id: keepMessageId,
      session_id: sessionId,
      user_id: userId,
      role: 'assistant',
      content: 'keep me'
    })

    await redis.set(`session:${sessionId}:messages`, ['stale-cache'])

    await redis.deleteMessage(messageId, sessionId, userId)

    expect(await redis.exists(`message:${sessionId}:${messageId}`)).toBe(false)
    expect(await redis.exists(`session:${sessionId}:messages`)).toBe(false)

    const remainingMessages = await redis.getMessages(sessionId, 10)
    expect(remainingMessages.map((message) => message.id)).toEqual([keepMessageId])
  })

  // The default lane replaces `$lib/server/redis` with a Map-based fake that has its own
  // `deleteMessage` and no `deleteSession`, so this claim about the REAL sweeps runs only under
  // `npm run test:redis` (this file is on CI's real-Redis list) and reports as skipped otherwise.
  it.runIf(REAL_REDIS_LANE)('takes a deleted reply\'s Jev Juice after-reply record with it, and a deleted session takes them all (SA-120 P6)', async () => {
    // `jev_post_turn:{sessionId}` + `jev_post_turn_item:{sessionId}:{messageId}` are
    // session-scoped keys with no TTL, so these two sweeps are the only thing that removes them.
    const sessionId = 'session-post-turn-sweep'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'After-reply sweep' })
    for (const id of ['reply-a', 'reply-b']) {
      await redis.saveMessage({ id, session_id: sessionId, user_id: userId, role: 'assistant', content: `reply ${id}` })
      await redis.sAdd(`jev_post_turn:${sessionId}`, id)
      await redis.set(`jev_post_turn_item:${sessionId}:${id}`, {
        messageId: id,
        sessionId,
        agentId: null,
        at: '2026-09-17T08:00:00.000Z',
        findings: [{ id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.9 }],
        notes: [],
        toldAgent: false
      })
    }

    await redis.deleteMessage('reply-a', sessionId, userId)
    expect(await redis.exists(`jev_post_turn_item:${sessionId}:reply-a`)).toBe(false)
    expect(await redis.exists(`jev_post_turn_item:${sessionId}:reply-b`)).toBe(true)
    expect(await redis.sMembers(`jev_post_turn:${sessionId}`)).toEqual(['reply-b'])

    await redis.deleteSession(sessionId)
    expect(await redis.exists(`jev_post_turn_item:${sessionId}:reply-b`)).toBe(false)
    expect(await redis.exists(`jev_post_turn:${sessionId}`)).toBe(false)
  })

  /**
   * A chat deleted while its reply runs (2026-09-18). Measured before on the dev lane
   * (`_local/deletemid-proof/before-*.json`): the sweep ran at once, the reply's request ran on
   * for another 20 seconds, and five keys came back that nothing sweeps: the reply's message,
   * the message list, the zip set, the zip, and the Execution Viewer log. The delete now stops
   * the turn and sweeps only once its request has let go, so what that request writes while it
   * stops goes with the chat. The writers here are the REAL ones the request uses.
   */
  describe.runIf(REAL_REDIS_LANE)('a chat deleted while its reply runs', () => {
    afterEach(() => {
      __resetStreamAbortRegistryForTests()
    })

    it('is swept only after the reply’s request lets go, so everything that request wrote goes too', async () => {
      const sessionId = 'session-deleted-mid-reply'
      const userId = 'josh'
      await redis.createSession({ id: sessionId, user_id: userId, name: 'Deleted mid-reply' })
      await redis.saveMessage({
        id: 'msg-ask', session_id: sessionId, user_id: userId, role: 'user', content: 'run sleep 20'
      })
      const reply = registerSessionTurn(sessionId, 'single', 'msg-reply')
      if (!reply.ok) throw new Error('registration refused')
      const stream = new AbortController()
      registerStreamAbort(sessionId, 'msg-reply', stream)

      const deletion = deleteSessionStoppingItsTurn(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(stream.signal.aborted).toBe(true)
      expect(await redis.exists(`session:${sessionId}`)).toBe(true)

      // The stopped reply's request: its tool result's zip, its Execution Viewer snapshot, its
      // finalize, then its own release.
      const zip = await createZipFromContent('slept 20', 'cool_tool', sessionId, 'msg-reply')
      await executionViewerService.recordSnapshot({
        id: 'msg-reply',
        sessionId,
        userId,
        agentId: 'agent-1',
        agentName: 'Probe',
        createdAt: new Date().toISOString(),
        structuredInput: null
      })
      await redis.saveMessage({
        id: 'msg-reply',
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content: `Running it. {{batshit-zip:${zip.zipId}}}`,
        metadata: { interrupted: true, zipIds: [zip.zipId] }
      })
      clearStreamAbort(sessionId, 'msg-reply')
      releaseSessionTurn(sessionId, reply.entry.turnId)

      await deletion
      expect(await redis.keys(`*${sessionId}*`)).toEqual([])
      expect(await redis.exists(`zip:${zip.zipId}`)).toBe(false)
      expect(await redis.sMembers(`user:${userId}:sessions`)).not.toContain(sessionId)
    })

    it('does not stop a locked chat’s reply: the lock refuses before anything is stopped', async () => {
      const sessionId = 'session-locked-mid-reply'
      await redis.createSession({ id: sessionId, user_id: 'josh', name: 'Locked', locked: true })
      const reply = registerSessionTurn(sessionId, 'single', 'msg-reply')
      if (!reply.ok) throw new Error('registration refused')
      const stream = new AbortController()
      registerStreamAbort(sessionId, 'msg-reply', stream)

      await expect(deleteSessionStoppingItsTurn(sessionId)).rejects.toThrow('locked')
      expect(stream.signal.aborted).toBe(false)
      expect(isSessionDeleting(sessionId)).toBe(false)
      expect(await redis.exists(`session:${sessionId}`)).toBe(true)
    })

    it('refuses a message for a chat that no longer exists before writing anything', async () => {
      // `saveMessage` already refused a missing chat (its closing `updateSession`), but only
      // AFTER writing the message and pushing it onto the list: two more keys for nobody.
      await expect(
        redis.saveMessage({
          id: 'msg-late', session_id: 'session-gone', user_id: 'josh', role: 'assistant', content: 'too late'
        })
      ).rejects.toThrow('Session not found')
      expect(await redis.exists('message:session-gone:msg-late')).toBe(false)
      expect(await redis.exists('messages:session-gone')).toBe(false)
    })
  })
})
