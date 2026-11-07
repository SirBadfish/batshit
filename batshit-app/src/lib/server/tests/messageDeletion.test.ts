import { afterEach, describe, expect, it, vi } from 'vitest'

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

useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  const expectedRunId = process.env.SA133_REDIS_RUN_ID
  if (expectedRunId === undefined) return
  expect(expectedRunId.trim()).not.toBe('')
  expect(Number(new URL(resolvedUrl).pathname.slice(1))).toBe(14)
  for (const client of [adminClient, await redis.execute(async connection => connection)]) {
    expect((await client.clientInfo()).db).toBe(14)
    const actualRunId = /^run_id:([^\r\n]+)\r?$/m.exec(await client.info('server'))?.[1]
    expect(actualRunId).toBe(expectedRunId)
  }
} })

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

  // BL-1513: the chat delete sweeps every zip the chat's set lists AND every zip a message's text
  // names, read as the trust reader reads a reference. A Batshit-written reference with an empty
  // description (`zipService.ts` writes `:::}}`) once escaped the text sweep, so a zip the set did
  // not list (an older chat's record, or a set that lost the member) outlived its chat.
  it.runIf(REAL_REDIS_LANE)('a chat delete takes every zip its messages name, an empty description included (BL-1513)', async () => {
    const sessionId = 'session-bl1513-sweep'
    const userId = 'josh'
    await redis.createSession({ id: sessionId, user_id: userId, name: 'Every named zip goes' })
    const unlisted = {
      empty: 'cool_tool_1790500000000_empty',
      described: 'cool_tool_1790500000001_descr',
      older: 'cool_tool_1790500000002_older',
      unnamed: 'cool_tool_1790500000003_unnam'
    }
    // Zip records the chat's set does not list.
    for (const zipId of Object.values(unlisted)) {
      await redis.execute((client: any) =>
        client.json.set(`zip:${zipId}`, '$', { id: zipId, type: 'cool_tool', content: 'x', metadata: { sessionId } })
      )
    }
    const listed = await createZipFromContent('listed in the set', 'cool_tool', sessionId, 'msg-a')
    await redis.saveMessage({
      id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `Read: {{batshit-zip:${unlisted.empty}:::}} and {{batshit-zip:${unlisted.described}:::Tool execution: read}}`,
      metadata: {}
    })
    await redis.saveMessage({
      id: 'msg-b', session_id: sessionId, user_id: userId, role: 'assistant',
      content: `Older form: {{batshit|id:${unlisted.older}|tool}}`, metadata: {}
    })
    expect((await redis.json.get(`message:${sessionId}:msg-a`) as any)?.content).toContain(`{{batshit-zip:${unlisted.empty}:::}}`)

    await redis.deleteSession(sessionId)

    expect(await redis.exists(`zip:${listed.zipId}`)).toBe(false)
    expect(await redis.exists(`zip:${unlisted.empty}`)).toBe(false)
    expect(await redis.exists(`zip:${unlisted.described}`)).toBe(false)
    expect(await redis.exists(`zip:${unlisted.older}`)).toBe(false)
    // A zip nothing names and the set does not list is not the chat's to sweep.
    expect(await redis.exists(`zip:${unlisted.unnamed}`)).toBe(true)
    await redis.del(`zip:${unlisted.unnamed}`)
  })

  /**
   * BL-1798: the chat delete took `zip:<id>` for every id a message of the chat named, with no
   * look at the zip's own chat. Two saves keep another chat's reference as written: the older
   * `{{batshit|id:…|` form (never neutralized, user text included) and a reply saved through
   * `saveMessage` (the LiveKit voice route's transcript), and a tab posts `zipMetadata` and
   * `metadata.zipIds`. So deleting chat A deleted chat B's zip that A's words named. A zip goes
   * now only when its record names the deleted chat; one that names no chat goes only when the
   * chat's own set lists it.
   */
  describe.runIf(REAL_REDIS_LANE)('a chat delete takes only its own zips (BL-1798)', () => {
    const userId = 'josh'

    async function chatWithZip(sessionId: string, label: string) {
      await redis.createSession({ id: sessionId, user_id: userId, name: label })
      const zip = await createZipFromContent(`${label} output`, 'cool_tool', sessionId, `${sessionId}-reply`)
      await redis.saveMessage({
        id: `${sessionId}-reply`, session_id: sessionId, user_id: userId, role: 'assistant',
        content: `Read it. {{batshit-zip:${zip.zipId}:::Tool execution: read}}`,
        metadata: { zipIds: [zip.zipId] }
      })
      return zip.zipId
    }

    async function expectChatStillReads(sessionId: string, zipId: string, label: string) {
      expect(await redis.exists(`zip:${zipId}`)).toBe(true)
      expect((await redis.getZip(zipId))?.content).toBe(`${label} output`)
      expect((await redis.getZip(zipId))?.metadata?.sessionId).toBe(sessionId)
      expect(await redis.sMembers(`session:${sessionId}:zips`)).toContain(zipId)
      const [reply] = await redis.getMessages(sessionId, 10)
      expect(reply?.content).toContain(`{{batshit-zip:${zipId}:::`)
    }

    it('keeps another chat\'s zip that its words name in the older form or that a tab posted, and that chat still reads it', async () => {
      const otherOlder = await chatWithZip('session-bl1798-b1', 'B older form')
      const otherPosted = await chatWithZip('session-bl1798-b2', 'B posted zipMetadata')
      const otherIds = await chatWithZip('session-bl1798-b3', 'B posted zipIds')
      const own = await chatWithZip('session-bl1798-a', 'A')
      const sessionId = 'session-bl1798-a'
      await redis.saveMessage({
        id: 'msg-user', session_id: sessionId, user_id: userId, role: 'user',
        content: `Pasted from the other chat: {{batshit|id:${otherOlder}|tool}}`,
        zipMetadata: [{ zipId: otherPosted }],
        metadata: { zipIds: [otherIds] }
      } as any)
      // The older form is saved as written (the precondition of the bug).
      expect(((await redis.json.get(`message:${sessionId}:msg-user`)) as any)?.content).toContain(
        `{{batshit|id:${otherOlder}|`
      )

      await redis.deleteSession(sessionId)

      expect(await redis.exists(`zip:${own}`)).toBe(false)
      await expectChatStillReads('session-bl1798-b1', otherOlder, 'B older form')
      await expectChatStillReads('session-bl1798-b2', otherPosted, 'B posted zipMetadata')
      await expectChatStillReads('session-bl1798-b3', otherIds, 'B posted zipIds')
    })

    it('keeps another chat\'s zip that a voice reply saved by the LiveKit turn route names', async () => {
      const other = await chatWithZip('session-bl1798-voice-b', 'B voice')
      const sessionId = 'session-bl1798-voice-a'
      await redis.createSession({ id: sessionId, user_id: userId, name: 'A voice' })
      await redis.createAgent({ id: 'agent-bl1798-voice', user_id: userId, displayName: 'Voice', agentType: 'API' } as any)
      const { env } = await import('$env/dynamic/private')
      const mutableEnv = env as Record<string, string | undefined>
      const previousToken = mutableEnv.BATSHIT_TOKEN
      const token = 'bl1798-voice-route-test-token-0123456789'
      mutableEnv.BATSHIT_TOKEN = token
      try {
        const { POST } = await import('../../../routes/api/voice/livekit/turn/+server')
        const response = await POST({
          request: new Request('http://localhost/api/voice/livekit/turn', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-batshit-service-token': token },
            body: JSON.stringify({
              kind: 'speech_to_speech_assistant_message',
              userId,
              sessionId,
              agentId: 'agent-bl1798-voice',
              messageId: 'voice-reply-1',
              transcript: `As the other chat said, {{batshit-zip:${other}:::Tool execution: read}}`
            })
          }),
          fetch: async () => new Response('{}', { status: 200 })
        } as any)
        expect(response.status).toBe(200)
      } finally {
        if (previousToken === undefined) delete mutableEnv.BATSHIT_TOKEN
        else mutableEnv.BATSHIT_TOKEN = previousToken
      }
      // The route saved the transcript as spoken (the precondition of the bug).
      expect(((await redis.json.get(`message:${sessionId}:voice-reply-1`)) as any)?.content).toContain(
        `{{batshit-zip:${other}:::`
      )

      await redis.deleteSession(sessionId)

      await expectChatStillReads('session-bl1798-voice-b', other, 'B voice')
    })

    it('takes its own zips wherever a message names them, the set missing them included', async () => {
      const sessionId = 'session-bl1798-own'
      await redis.createSession({ id: sessionId, user_id: userId, name: 'Own zips' })
      const zipIds = {
        inSet: (await createZipFromContent('listed', 'cool_tool', sessionId, 'msg-a')).zipId,
        zipIds: (await createZipFromContent('metadata.zipIds only', 'cool_tool', sessionId, 'msg-a')).zipId,
        zipIdsSnake: (await createZipFromContent('metadata.zip_ids only', 'cool_tool', sessionId, 'msg-a')).zipId,
        zipReferences: (await createZipFromContent('metadata.zipReferences only', 'cool_tool', sessionId, 'msg-a')).zipId,
        emptyDescription: (await createZipFromContent('empty description', 'cool_tool', sessionId, 'msg-a')).zipId,
        zipMetadata: (await createZipFromContent('zipMetadata only', 'cool_tool', sessionId, 'msg-a')).zipId
      }
      await redis.saveMessage({
        id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant',
        content: `Read {{batshit-zip:${zipIds.emptyDescription}:::}}`,
        zipMetadata: [{ zipId: zipIds.zipMetadata }],
        metadata: {
          zipIds: [zipIds.zipIds],
          zip_ids: [zipIds.zipIdsSnake],
          zipReferences: [{ zipId: zipIds.zipReferences }]
        }
      } as any)
      // Every zip but the listed one has lost its set member (an older chat's set, say).
      for (const [name, zipId] of Object.entries(zipIds)) {
        if (name !== 'inSet') await redis.sRem(`session:${sessionId}:zips`, zipId)
      }
      expect(await redis.sMembers(`session:${sessionId}:zips`)).toEqual([zipIds.inSet])

      await redis.deleteSession(sessionId)

      for (const [name, zipId] of Object.entries(zipIds)) {
        expect(await redis.exists(`zip:${zipId}`), name).toBe(false)
      }
    })

    it('reads a zip\'s chat as the compile does, and takes a record that names no chat only from its own set', async () => {
      const sessionId = 'session-bl1798-recorded'
      await redis.createSession({ id: sessionId, user_id: userId, name: 'Recorded chat' })
      const records: Record<string, Record<string, unknown>> = {
        // No field names a chat: the chat's own set is the only proof it is this chat's.
        noChatInSet: { id: 'cool_tool_1790600000000_nocha', type: 'cool_tool', content: 'x', metadata: {} },
        noChatNamedOnly: { id: 'cool_tool_1790600000001_nonam', type: 'cool_tool', content: 'x', metadata: {} },
        // Older shapes the compile and the zip routes read after `metadata.sessionId`.
        topLevelThisChat: { id: 'cool_tool_1790600000002_topth', type: 'cool_tool', content: 'x', sessionId },
        snakeOtherChatInSet: {
          id: 'cool_tool_1790600000003_snako', type: 'cool_tool', content: 'x', metadata: { session_id: 'session-elsewhere' }
        }
      }
      for (const record of Object.values(records)) {
        await redis.execute((client: any) => client.json.set(`zip:${record.id}`, '$', record))
      }
      await redis.sAdd(`session:${sessionId}:zips`, records.noChatInSet.id as string)
      await redis.sAdd(`session:${sessionId}:zips`, records.snakeOtherChatInSet.id as string)
      await redis.saveMessage({
        id: 'msg-a', session_id: sessionId, user_id: userId, role: 'assistant',
        content: `{{batshit|id:${records.noChatNamedOnly.id}|tool}} {{batshit-zip:${records.topLevelThisChat.id}:::read}}`,
        metadata: {}
      })

      await redis.deleteSession(sessionId)

      expect(await redis.exists(`zip:${records.noChatInSet.id}`)).toBe(false)
      expect(await redis.exists(`zip:${records.topLevelThisChat.id}`)).toBe(false)
      expect(await redis.exists(`zip:${records.noChatNamedOnly.id}`)).toBe(true)
      expect(await redis.exists(`zip:${records.snakeOtherChatInSet.id}`)).toBe(true)
    })

    /** Make the real `client.json.mGet` reject when it reads a key `matches` accepts, and nothing else. */
    function failJsonMGets(matches: (key: string) => boolean) {
      const execute = redis.execute.bind(redis) as (operation: (client: any) => Promise<unknown>) => Promise<unknown>
      return vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
        execute(async (client: any) => {
          const target = client.json
          // Empty proxy targets: the client's own properties are read-only.
          const json = new Proxy({}, {
            get(_empty, property) {
              const value = Reflect.get(target, property)
              if (property === 'mGet') {
                return async (keys: string[], path: string) => {
                  if (keys.some(matches)) throw new Error('Redis read failed (injected by the test)')
                  return value.call(target, keys, path)
                }
              }
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
          const wrapped = new Proxy({}, {
            get(_empty, property) {
              if (property === 'json') return json
              const value = Reflect.get(client, property)
              return typeof value === 'function' ? value.bind(client) : value
            }
          })
          return operation(wrapped)
        })) as typeof redis.execute)
    }

    // Review of BL-1798 (S1): the sweep read the zips' chats only after it had deleted the
    // messages and the chat's set, and a failed read was only logged, so the chat's zips were left
    // with nothing that could find them again. Every read the sweep needs now comes before its
    // first write, and a failed one throws: nothing is deleted, the door reports the failure, and
    // a retry deletes the whole chat (the rule of BL-390's message delete and BL-608's agent delete).
    it.each([
      ['the zips\' chats', 'zips'],
      ['the messages\' claims', 'messages']
    ] as const)('a failed read of %s deletes nothing, the delete fails, and a retry deletes the chat', async (_name, failing) => {
      const sessionId = `session-bl1798-failed-${failing}`
      const zipId = await chatWithZip(sessionId, 'Failed read')
      await redis.saveMessage({
        id: 'msg-user', session_id: sessionId, user_id: userId, role: 'user', content: 'and another'
      })
      await redis.set(`whiteboard:${sessionId}:board`, { text: 'kept' })
      const keysBefore = (await redis.keys(`*${sessionId}*`)).sort()
      expect(keysBefore).toEqual(expect.arrayContaining([
        `session:${sessionId}`, `messages:${sessionId}`, `session:${sessionId}:zips`,
        `message:${sessionId}:${sessionId}-reply`, `message:${sessionId}:msg-user`, `whiteboard:${sessionId}:board`
      ]))

      const injected = failJsonMGets((key) =>
        failing === 'zips' ? key.startsWith('zip:') : key === `message:${sessionId}:msg-user`
      )
      try {
        await expect(deleteSessionStoppingItsTurn(sessionId)).rejects.toThrow('nothing was deleted')
      } finally {
        injected.mockRestore()
      }

      expect((await redis.keys(`*${sessionId}*`)).sort()).toEqual(keysBefore)
      expect(await redis.exists(`zip:${zipId}`)).toBe(true)
      expect(await redis.sMembers(`user:${userId}:sessions`)).toContain(sessionId)
      expect(isSessionDeleting(sessionId)).toBe(false)

      await deleteSessionStoppingItsTurn(sessionId)
      expect(await redis.keys(`*${sessionId}*`)).toEqual([])
      expect(await redis.exists(`zip:${zipId}`)).toBe(false)
    })

    // Re-review of BL-1798: a message key that exists but is not JSON is no failed read. It
    // claims no zip, is named in the log, and goes with the chat; refused, it left the chat
    // undeletable. Only a failed read (the transport) stops the delete.
    it('deletes a chat with a message key that is not JSON, that key included, and still keeps another chat\'s zip', async () => {
      const other = await chatWithZip('session-bl1798-broken-b', 'B broken')
      const sessionId = 'session-bl1798-broken-a'
      const own = await chatWithZip(sessionId, 'A broken')
      await redis.saveMessage({
        id: 'msg-user', session_id: sessionId, user_id: userId, role: 'user',
        content: `Pasted: {{batshit|id:${other}|tool}}`
      })
      // A message record that is a plain string, listed like the others.
      await redis.execute(async (client: any) => {
        await client.set(`message:${sessionId}:msg-broken`, '{"content": "not a JSON record"}')
        await client.rPush(`messages:${sessionId}`, 'msg-broken')
      })
      expect(await redis.execute((client: any) => client.type(`message:${sessionId}:msg-broken`))).toBe('string')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await deleteSessionStoppingItsTurn(sessionId)
        expect(warn.mock.calls.some((call) => JSON.stringify(call).includes(`message:${sessionId}:msg-broken`))).toBe(true)
      } finally {
        warn.mockRestore()
      }

      expect(await redis.keys(`*${sessionId}*`)).toEqual([])
      expect(await redis.exists(`zip:${own}`)).toBe(false)
      await expectChatStillReads('session-bl1798-broken-b', other, 'B broken')
    })
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
