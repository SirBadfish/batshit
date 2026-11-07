// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * SA-139 R1: a stopped Codex CLI reply's cleanup warnings (`codex_cleanup_warnings:{chat}` and
 * `codex_cleanup_warning:{chat}:{reply}`) were written before Codex CLI was removed. Nothing
 * writes or reads them any more and they have no TTL, so the reply and chat deletes in `redis.ts`
 * are the only things that ever remove leftover ones. The keys are planted as stored data.
 *
 * The default lane's Redis stand-in has its own reply and chat deletes, so these run only on the
 * real Redis lane (`npm run test:redis`), against the real `redis.ts` sweeps.
 */

useRedisTestServer()
const realRedis = process.env.VITEST_USE_REAL_REDIS === 'true'
let serial = 0

async function fixture() {
  const sessionId = `codex-cleanup-sweep-${Date.now()}-${++serial}`
  const messageId = `reply-${serial}`
  await redis.createSession({ id: sessionId, user_id: 'owner', name: 'cleanup', agent_id: 'agent' } as any)
  await redis.saveMessage({
    id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
    role: 'assistant', content: 'Stopped reply', metadata: { interrupted: true }
  } as any)
  return { sessionId, messageId }
}

async function plantLeftoverWarning(sessionId: string, messageId: string) {
  await redis.sAdd(`codex_cleanup_warnings:${sessionId}`, messageId)
  await redis.json.set(`codex_cleanup_warning:${sessionId}:${messageId}`, '$', {
    messageId, kind: 'unconfirmed_command_cleanup'
  } as any)
}

describe.skipIf(!realRedis)('leftover Codex cleanup warnings go with their reply and their chat (real Redis)', () => {
  it('a reply delete removes that reply’s leftover warning and its set member only', async () => {
    const { sessionId, messageId } = await fixture()
    await redis.saveMessage({
      id: 'reply-kept', session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'Another stopped reply'
    } as any)
    await plantLeftoverWarning(sessionId, messageId)
    await plantLeftoverWarning(sessionId, 'reply-kept')

    await redis.deleteMessage(messageId, sessionId, 'owner')

    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBeFalsy()
    expect(await redis.sMembers(`codex_cleanup_warnings:${sessionId}`)).toEqual(['reply-kept'])
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:reply-kept`)).toBeTruthy()
  })

  it('a chat delete removes every leftover warning key, one outside the set included', async () => {
    const { sessionId, messageId } = await fixture()
    await plantLeftoverWarning(sessionId, messageId)
    await redis.json.set(`codex_cleanup_warning:${sessionId}:reply-outside-set`, '$', {
      messageId: 'reply-outside-set', kind: 'unconfirmed_command_cleanup'
    } as any)

    await redis.deleteSession(sessionId)

    expect(await redis.exists(`codex_cleanup_warnings:${sessionId}`)).toBeFalsy()
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBeFalsy()
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:reply-outside-set`)).toBeFalsy()
  })
})
