import { afterEach, describe, expect, it } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createZipFromContent } from '$lib/server/zipService'
import { MessageStillRunningError } from '$lib/server/messageStillRunningError'
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
  it.runIf(REAL_REDIS_LANE)('takes a deleted reply\'s Judge Juice after-reply record with it, and a deleted session takes them all (SA-120 P6)', async () => {
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

  // BL-474 step 2: the record of where a reply's pictures came from goes with its reply, and a
  // deleted chat takes them all (session-scoped keys with no TTL). Real sweeps: real-Redis lane only.
  it.runIf(REAL_REDIS_LANE)('takes a deleted reply\'s picture-origin record with it, and a deleted chat takes them all (BL-474)', async () => {
    const sessionId = 'session-image-origin-sweep'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Picture origin sweep' })
    for (const id of ['reply-a', 'reply-b']) {
      await redis.saveMessage({ id, session_id: sessionId, user_id: userId, role: 'assistant', content: `reply ${id}` })
      expect(await redis.writeImageOriginRecord({
        userId, sessionId, messageId: id, version: 1, state: 'decided',
        record: {
          messageId: id, version: 1, state: 'decided', textHashes: ['f'.repeat(64)], lane: 'api', complete: true,
          addresses: {}
        }
      })).toBe('ok')
    }

    await redis.deleteMessage('reply-a', sessionId, userId)
    expect(await redis.exists(`image_origin:${sessionId}:reply-a`)).toBe(false)
    expect(await redis.exists(`image_origin:${sessionId}:reply-b`)).toBe(true)
    expect(await redis.sMembers(`image_origins:${sessionId}`)).toEqual(['reply-b'])
    // A late write for the deleted reply finds no reply and writes nothing.
    expect(await redis.writeImageOriginRecord({
      userId, sessionId, messageId: 'reply-a', version: 1, state: 'decided',
      record: { messageId: 'reply-a', version: 1, state: 'decided', textHashes: ['f'.repeat(64)], lane: 'api', complete: true, addresses: {} }
    })).toBe('missing_reply')
    expect(await redis.exists(`image_origin:${sessionId}:reply-a`)).toBe(false)

    await redis.deleteSession(sessionId)
    expect(await redis.exists(`image_origin:${sessionId}:reply-b`)).toBe(false)
    expect(await redis.exists(`image_origins:${sessionId}`)).toBe(false)
    // And a pending write for the deleted chat finds no chat.
    expect(await redis.writeImageOriginRecord({
      userId, sessionId, messageId: 'reply-c', version: 1, state: 'pending',
      record: { messageId: 'reply-c', version: 1, state: 'pending' }
    })).toBe('missing_chat')
  })

  /**
   * BL-390: deleting one message left its zips in `session:{id}:zips`, so the Zip Manager still
   * listed the deleted tool output, it could still be opened, and every later backup carried it,
   * along with its hold and rezip state. The delete now reads the message and the chat's zips
   * and takes each zip this message owns (`metadata.messageId`) that no other message of the
   * chat still lists in `metadata.zipIds`, with its zip state, under the chat's zip state lock.
   */
  it.runIf(REAL_REDIS_LANE)('takes the zips only this message owns, with their holds and rezips, and keeps shared ones (BL-390)', async () => {
    const sessionId = 'session-bl390-zips'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Zips go with their message' })
    const own = await createZipFromContent('only mine', 'cool_tool', sessionId, 'msg-a')
    const shared = await createZipFromContent('read again later', 'cool_tool', sessionId, 'msg-a')
    const other = await createZipFromContent('the other reply', 'cool_tool', sessionId, 'msg-b')
    await redis.saveMessage({
      id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `A {{batshit-zip:${own.zipId}}} {{batshit-zip:${shared.zipId}}}`,
      metadata: { zipIds: [own.zipId, shared.zipId] }
    })
    await redis.saveMessage({
      id: 'msg-b', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `B {{batshit-zip:${shared.zipId}}} {{batshit-zip:${other.zipId}}}`,
      metadata: { zipIds: [shared.zipId, other.zipId] }
    })
    // An agent's hold on the owned zip, a rezip of it, and a user hold on the shared one.
    await redis.set(`unzipped_item:${sessionId}:${own.zipId}`, {
      zipId: own.zipId, sessionId, permanent: true, source: 'agent', agentId: 'agent-1', path: 'src/a.ts'
    })
    await redis.sAdd(`unzipped:${sessionId}`, own.zipId)
    await redis.set(`rezipped_item:${sessionId}:${own.zipId}`, { zipId: own.zipId, sessionId, source: 'user' })
    await redis.sAdd(`rezipped:${sessionId}`, own.zipId)
    await redis.set(`unzipped_item:${sessionId}:${shared.zipId}`, {
      zipId: shared.zipId, sessionId, permanent: true, source: 'user'
    })
    await redis.sAdd(`unzipped:${sessionId}`, shared.zipId)

    await redis.deleteMessage('msg-a', sessionId, userId)

    expect(await redis.exists(`message:${sessionId}:msg-a`)).toBe(false)
    expect(await redis.exists(`zip:${own.zipId}`)).toBe(false)
    expect(await redis.exists(`unzipped_item:${sessionId}:${own.zipId}`)).toBe(false)
    expect(await redis.exists(`rezipped_item:${sessionId}:${own.zipId}`)).toBe(false)
    expect(await redis.sMembers(`rezipped:${sessionId}`)).toEqual([])
    expect((await redis.sMembers(`unzipped:${sessionId}`)).sort()).toEqual([shared.zipId])
    expect((await redis.sMembers(`session:${sessionId}:zips`)).sort()).toEqual([shared.zipId, other.zipId].sort())
    expect(await redis.exists(`zip:${shared.zipId}`)).toBe(true)
    expect(await redis.exists(`unzipped_item:${sessionId}:${shared.zipId}`)).toBe(true)
    expect(await redis.exists(`zip:${other.zipId}`)).toBe(true)

    // The last message that lists the shared zip takes it when it goes.
    await redis.deleteMessage('msg-b', sessionId, userId)
    expect(await redis.exists(`zip:${shared.zipId}`)).toBe(false)
    expect(await redis.exists(`zip:${other.zipId}`)).toBe(false)
    expect(await redis.exists(`unzipped_item:${sessionId}:${shared.zipId}`)).toBe(false)
    expect(await redis.exists(`session:${sessionId}:zips`)).toBe(false)
    expect(await redis.exists(`unzipped:${sessionId}`)).toBe(false)
    await redis.deleteSession(sessionId)
  })

  it.runIf(REAL_REDIS_LANE)('keeps a zip another message claims only in its text, or only through zipReferences (BL-390)', async () => {
    const sessionId = 'session-bl390-wider-claims'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Wider claims' })
    const inText = await createZipFromContent('named in text', 'cool_tool', sessionId, 'msg-a')
    const inRefs = await createZipFromContent('named in zipReferences', 'cool_tool', sessionId, 'msg-a')
    const own = await createZipFromContent('only mine', 'cool_tool', sessionId, 'msg-a')
    const emptyDescription = await createZipFromContent('named with an empty description', 'cool_tool', sessionId, 'msg-a')
    await redis.saveMessage({
      id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant', content: 'A',
      metadata: { zipIds: [inText.zipId, inRefs.zipId, own.zipId, emptyDescription.zipId] }
    })
    await redis.saveMessage({
      id: 'msg-b', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `B quotes {{batshit-zip:${inText.zipId}}} and {{batshit-zip:${emptyDescription.zipId}:::}}`, metadata: {}
    })
    await redis.saveMessage({
      id: 'msg-c', session_id: sessionId, user_id: userId, role: 'assistant', content: 'C',
      metadata: { zipReferences: [{ zipId: inRefs.zipId }] }
    })

    await redis.deleteMessage('msg-a', sessionId, userId)

    expect(await redis.exists(`zip:${own.zipId}`)).toBe(false)
    expect(await redis.exists(`zip:${inText.zipId}`)).toBe(true)
    expect(await redis.exists(`zip:${inRefs.zipId}`)).toBe(true)
    expect(await redis.exists(`zip:${emptyDescription.zipId}`)).toBe(true)
    expect((await redis.sMembers(`session:${sessionId}:zips`)).sort()).toEqual(
      [inText.zipId, inRefs.zipId, emptyDescription.zipId].sort()
    )
    await redis.deleteSession(sessionId)
  })

  // BL-775: a reply the finalize saved from its own copy does not name the zips the stream path
  // made for it; those go (with their zip state) by the claim rules above, and nothing else does.
  it('removes only the zips a reply made that no message names (BL-775), on both lanes', async () => {
    const sessionId = 'session-bl775-unclaimed'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Unclaimed stream zips' })
    const streamMade = await createZipFromContent('Traceback: boom', 'error', sessionId, 'msg-a')
    const named = await createZipFromContent('Traceback: boom', 'error', sessionId, 'msg-a')
    const inMetadata = await createZipFromContent('tool output', 'cool_tool', sessionId, 'msg-a')
    const quotedElsewhere = await createZipFromContent('quoted later', 'error', sessionId, 'msg-a')
    const otherMaker = await createZipFromContent('the other reply', 'error', sessionId, 'msg-b')
    await redis.saveMessage({
      id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `It failed: {{batshit-zip:${named.zipId}:::Error}}`,
      metadata: { zipIds: [named.zipId], zipReferences: [{ zipId: inMetadata.zipId, reference: `{{batshit-zip:${inMetadata.zipId}:::tool}}` }] }
    })
    await redis.saveMessage({
      id: 'msg-b', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `B quotes {{batshit-zip:${quotedElsewhere.zipId}:::x}}`, metadata: {}
    })
    await redis.set(`unzipped_item:${sessionId}:${streamMade.zipId}`, { zipId: streamMade.zipId, sessionId, source: 'user' })
    await redis.sAdd(`unzipped:${sessionId}`, streamMade.zipId)

    const removed = await redis.removeUnclaimedZipsMadeByMessage(sessionId, 'msg-a', [
      streamMade.zipId, named.zipId, inMetadata.zipId, quotedElsewhere.zipId, otherMaker.zipId
    ])

    expect(removed).toEqual([streamMade.zipId])
    expect(await redis.exists(`zip:${streamMade.zipId}`)).toBe(false)
    expect(await redis.exists(`unzipped_item:${sessionId}:${streamMade.zipId}`)).toBe(false)
    expect(await redis.sMembers(`unzipped:${sessionId}`)).toEqual([])
    expect((await redis.sMembers(`session:${sessionId}:zips`)).sort()).toEqual(
      [named.zipId, inMetadata.zipId, quotedElsewhere.zipId, otherMaker.zipId].sort()
    )
    // The default lane's fake has no `deleteSession`; the harness empties it between tests.
    if (REAL_REDIS_LANE) await redis.deleteSession(sessionId)
  })

  it.runIf(REAL_REDIS_LANE)('removes no unclaimed zip when a message of the chat cannot be read (BL-775)', async () => {
    const sessionId = 'session-bl775-unclaimed-damaged'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Damaged' })
    const streamMade = await createZipFromContent('Traceback: boom', 'error', sessionId, 'msg-a')
    await redis.saveMessage({ id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant', content: 'A', metadata: {} })
    await redis.execute(async (client) => {
      await client.set(`message:${sessionId}:msg-damaged`, 'not json')
      await client.rPush(`messages:${sessionId}`, ['msg-damaged'])
    })
    await expect(redis.removeUnclaimedZipsMadeByMessage(sessionId, 'msg-a', [streamMade.zipId])).rejects.toThrow('could not be read')
    expect(await redis.exists(`zip:${streamMade.zipId}`)).toBe(true)
    await redis.execute(async (client) => {
      await client.del(`message:${sessionId}:msg-damaged`)
      await client.lRem(`messages:${sessionId}`, 0, 'msg-damaged')
    })
    await redis.deleteSession(sessionId)
  })

  it.runIf(REAL_REDIS_LANE)('refuses when another message exists but cannot be read, and counts a missing one as no claim (BL-390)', async () => {
    const sessionId = 'session-bl390-damaged-other'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Damaged other' })
    const zip = await createZipFromContent('mine', 'cool_tool', sessionId, 'msg-a')
    await redis.saveMessage({
      id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant', content: 'A', metadata: { zipIds: [zip.zipId] }
    })
    await redis.execute(async (client) => {
      await client.set(`message:${sessionId}:msg-damaged`, 'not json')
      await client.rPush(`messages:${sessionId}`, ['msg-damaged', 'msg-missing'])
    })

    await expect(redis.deleteMessage('msg-a', sessionId, userId)).rejects.toThrow('could not be read')
    expect(await redis.exists(`message:${sessionId}:msg-a`)).toBe(true)
    expect(await redis.exists(`zip:${zip.zipId}`)).toBe(true)

    // Only the missing id left: it claims nothing, and the delete goes on.
    await redis.execute(async (client) => {
      await client.del(`message:${sessionId}:msg-damaged`)
      await client.lRem(`messages:${sessionId}`, 0, 'msg-damaged')
    })
    await redis.deleteMessage('msg-a', sessionId, userId)
    expect(await redis.exists(`message:${sessionId}:msg-a`)).toBe(false)
    expect(await redis.exists(`zip:${zip.zipId}`)).toBe(false)
    await redis.deleteSession(sessionId)
  })

  it.runIf(REAL_REDIS_LANE)('asks the running check again inside the lock, right before it writes (BL-381)', async () => {
    const sessionId = 'session-bl381-in-lock'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Guard' })
    const zip = await createZipFromContent('mine', 'cool_tool', sessionId, 'msg-a')
    await redis.saveMessage({
      id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant', content: 'A', metadata: { zipIds: [zip.zipId] }
    })

    await expect(
      redis.deleteMessage('msg-a', sessionId, userId, { stillRunning: () => true })
    ).rejects.toBeInstanceOf(MessageStillRunningError)
    expect(await redis.exists(`message:${sessionId}:msg-a`)).toBe(true)
    expect(await redis.exists(`zip:${zip.zipId}`)).toBe(true)
    await redis.deleteSession(sessionId)
  })

  it.runIf(REAL_REDIS_LANE)('a failed read of the message stops the delete with nothing deleted, never read as "no zips" (BL-390)', async () => {
    const sessionId = 'session-bl390-failed-read'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Failed read' })
    const zip = await createZipFromContent('mine', 'cool_tool', sessionId, 'msg-broken')
    // A message record that cannot be read as JSON: the read throws.
    await redis.execute(async (client) => {
      await client.set(`message:${sessionId}:msg-broken`, 'not json')
      await client.rPush(`messages:${sessionId}`, 'msg-broken')
    })

    await expect(redis.deleteMessage('msg-broken', sessionId, userId)).rejects.toThrow()
    expect(await redis.exists(`zip:${zip.zipId}`)).toBe(true)
    expect(await redis.sMembers(`session:${sessionId}:zips`)).toEqual([zip.zipId])
    expect(await redis.execute((client) => client.lRange(`messages:${sessionId}`, 0, -1))).toEqual(['msg-broken'])
    await redis.execute((client) => client.del(`message:${sessionId}:msg-broken`))
    await redis.deleteSession(sessionId)
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
