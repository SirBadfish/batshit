// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  deleteImageOrigin,
  loadImageOrigins,
  markImageOriginPending,
  sweepImageOrigins,
  writeImageOriginDecision
} from '../imageAddressOrigins'
import type { DecidedImageOriginRecord } from '$lib/utils/imageOriginRecord'
import { beginSessionDelete, endSessionDelete } from '$lib/server/services/streamAbortRegistry'
import { failNextRedisCommand } from '$lib/test-utils/redis-command-failure'

// The write is one RedisJSON Lua step (`WRITE_IMAGE_ORIGIN_SCRIPT`) on the real lane and its JS twin
// (`vitest-setup.ts`) on the default lane: this suite runs on both, so the twin keeps the contract.
useRedisTestServer()
let serial = 0

vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: vi.fn(async () => undefined) }))

async function fixture(options: { reply?: boolean } = {}) {
  const sessionId = `image-origin-${Date.now()}-${++serial}`
  const messageId = `reply-${serial}`
  await redis.createSession({ id: sessionId, user_id: 'owner', name: 'origins', agent_id: 'agent' } as any)
  if (options.reply !== false) {
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'A reply', metadata: {}
    } as any)
  }
  return { sessionId, messageId }
}

function decided(messageId: string, version: number, rule: 1 | 4 = 4): DecidedImageOriginRecord {
  const evidence = rule === 1
    ? { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
    : { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
  return {
    messageId,
    version,
    state: 'decided',
    textHashes: ['b'.repeat(64)],
    lane: 'api',
    complete: true,
    addresses: { 'https://a.example/x.png': rule === 1 ? { state: 'as_read', rule: 1, evidence } : { state: 'blocked', rule: 4, evidence } }
  }
}

describe('image origin records (BL-474 step 2)', () => {
  it('fails visibly for a missing or malformed key named by the chat index', async () => {
    const { sessionId, messageId } = await fixture()
    await redis.sAdd(`image_origins:${sessionId}`, messageId)
    await expect(loadImageOrigins(sessionId)).rejects.toThrow(/image origin index.*missing reply/i)

    await redis.set(`image_origin:${sessionId}:${messageId}`, {
      ...decided(messageId, 1),
      addresses: {
        'https://a.example/x.png': {
          state: 'as_read',
          rule: 4,
          evidence: { inRecord: true, startInRecord: false, sharesChatRun: false }
        }
      }
    })
    await expect(loadImageOrigins(sessionId)).rejects.toThrow(/image origin index.*malformed reply/i)
  })

  it('reads an older table outcome through its stored evidence for full and history reads (BL-1023)', async () => {
    const { sessionId, messageId } = await fixture()
    const current = decided(messageId, 1, 1)
    await redis.set(`image_origin:${sessionId}:${messageId}`, {
      ...current,
      addresses: {
        'https://a.example/x.png': { ...current.addresses['https://a.example/x.png'], state: 'blocked', rule: 4 }
      }
    })
    await redis.sAdd(`image_origins:${sessionId}`, messageId)
    await expect(loadImageOrigins(sessionId)).resolves.toEqual({ [messageId]: current })
    await expect(loadImageOrigins(sessionId, { messageIds: [messageId] })).resolves.toEqual({ [messageId]: current })
  })

  it('bounds a messageIds read to those indexed records and distinguishes a legacy absence', async () => {
    const { sessionId, messageId } = await fixture()
    const wanted = decided(messageId, 1, 1)
    await redis.set(`image_origin:${sessionId}:${messageId}`, wanted)
    await redis.sAdd(`image_origins:${sessionId}`, messageId)

    const unrelated = 'older-corrupt-reply'
    await redis.sAdd(`image_origins:${sessionId}`, unrelated)
    await redis.set(`image_origin:${sessionId}:${unrelated}`, { messageId: unrelated, version: 1, state: 'decided' })

    await expect(loadImageOrigins(sessionId, { messageIds: [messageId] })).resolves.toEqual({ [messageId]: wanted })
    await expect(loadImageOrigins(sessionId, { messageIds: ['legacy-reply-with-no-record'] })).resolves.toEqual({})
    await expect(loadImageOrigins(sessionId, { messageIds: [unrelated] })).rejects.toThrow(/image origin index.*malformed reply/i)
  })

  it('does not turn an index-read failure into an empty chat', async () => {
    const { sessionId } = await fixture()
    const execute = vi.spyOn(redis, 'execute').mockRejectedValueOnce(new Error('index unavailable'))
    try {
      await expect(loadImageOrigins(sessionId)).rejects.toThrow('index unavailable')
    } finally {
      execute.mockRestore()
    }
  })

  it('a reply starts pending; its end writes the decision; a stale save of the reply changes nothing', async () => {
    const { sessionId, messageId } = await fixture()
    await markImageOriginPending({ userId: 'owner', sessionId, messageId, version: 1 })
    expect(await loadImageOrigins(sessionId)).toEqual({ [messageId]: { messageId, version: 1, state: 'pending' } })
    expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })).toBe(true)
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'An older copy', metadata: { imageOrigins: 'forged' }
    } as any)
    expect(await loadImageOrigins(sessionId)).toEqual({ [messageId]: decided(messageId, 1) })
    expect(await redis.sMembers(`image_origins:${sessionId}`)).toEqual([messageId])
  })

  it('a second end writes the next version; an older end never writes over it; a late pending never replaces a decision', async () => {
    const { sessionId, messageId } = await fixture()
    await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })
    const resumeVersion = 1_790_000_000_000
    await markImageOriginPending({ userId: 'owner', sessionId, messageId, version: resumeVersion })
    expect((await loadImageOrigins(sessionId))[messageId]).toEqual({ messageId, version: resumeVersion, state: 'pending' })
    expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, resumeVersion, 1) })).toBe(true)
    // The first end, arriving late, is refused.
    expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })).toBe(false)
    await markImageOriginPending({ userId: 'owner', sessionId, messageId, version: resumeVersion })
    expect((await loadImageOrigins(sessionId))[messageId]).toEqual(decided(messageId, resumeVersion, 1))
    // The same end again (the failure path's second finalize of one run) may write.
    expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, resumeVersion) })).toBe(true)
  })

  it('writes nothing for a missing chat, a foreign owner, or a decision without its reply', async () => {
    const { sessionId, messageId } = await fixture({ reply: false })
    await markImageOriginPending({ userId: 'owner', sessionId: `${sessionId}-gone`, messageId, version: 1 })
    await markImageOriginPending({ userId: 'intruder', sessionId, messageId, version: 1 })
    expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })).toBe(false)
    expect(await loadImageOrigins(sessionId)).toEqual({})
    expect(await redis.exists(`image_origin:${sessionId}-gone:${messageId}`)).toBeFalsy()
    // A user message is not a reply.
    await redis.saveMessage({ id: 'u1', session_id: sessionId, user_id: 'owner', role: 'user', content: 'hi', metadata: {} } as any)
    expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided('u1', 1) })).toBe(false)
  })

  it('rejects a record body whose message id, state, or version disagrees with write arguments', async () => {
    const { sessionId, messageId } = await fixture()
    const valid = decided(messageId, 1)
    for (const [overrides, label] of [
      [{ record: { ...valid, messageId: 'another-reply' } }, 'messageId'],
      [{ state: 'pending' as const }, 'state'],
      [{ record: { ...valid, version: 2 } }, 'version']
    ] as const) {
      await expect(redis.writeImageOriginRecord({
        userId: 'owner', sessionId, messageId, version: 1, state: 'decided', record: valid, ...overrides
      } as any)).rejects.toThrow(/image origin record.*(match|mismatch|invalid)/i)
      expect(await redis.exists(`image_origin:${sessionId}:${messageId}`), label).toBeFalsy()
      expect(await redis.sMembers(`image_origins:${sessionId}`), label).toEqual([])
    }
  })

  it('writes nothing for a chat that is being deleted', async () => {
    const { sessionId, messageId } = await fixture()
    expect(beginSessionDelete(sessionId)).toBe(true)
    try {
      await markImageOriginPending({ userId: 'owner', sessionId, messageId, version: 1 })
      expect(await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })).toBe(false)
      expect(await loadImageOrigins(sessionId)).toEqual({})
    } finally {
      endSessionDelete(sessionId)
    }
  })

  it('the reply delete and the chat sweep leave no key', async () => {
    const { sessionId, messageId } = await fixture()
    await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })
    await deleteImageOrigin(sessionId, messageId)
    expect(await redis.exists(`image_origin:${sessionId}:${messageId}`)).toBeFalsy()
    expect(await redis.sMembers(`image_origins:${sessionId}`)).toEqual([])
    await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })
    // A record outside the index (a failed earlier SADD) is swept by its pattern too.
    await redis.set(`image_origin:${sessionId}:stray`, { messageId: 'stray', version: 1, state: 'pending' })
    await sweepImageOrigins(sessionId)
    expect(await redis.keys(`image_origin*:${sessionId}*`)).toEqual([])
  })

  it('keeps the record readable when removing its index entry fails (BL-1022)', async () => {
    const { sessionId, messageId } = await fixture()
    const record = decided(messageId, 1)
    await writeImageOriginDecision({ userId: 'owner', sessionId, record })
    const failure = failNextRedisCommand('sRem', new Error('index unavailable'))
    try {
      await expect(deleteImageOrigin(sessionId, messageId)).rejects.toThrow('index unavailable')
      expect(failure.failed()).toBe(true)
    } finally {
      failure.restore()
    }
    expect(await loadImageOrigins(sessionId)).toEqual({ [messageId]: record })
    await deleteImageOrigin(sessionId, messageId)
    expect(await loadImageOrigins(sessionId)).toEqual({})
  })

  it('leaves an invisible orphan after a failed record delete, then the chat pattern sweep removes it (BL-1022/1024)', async () => {
    const { sessionId, messageId } = await fixture()
    await writeImageOriginDecision({ userId: 'owner', sessionId, record: decided(messageId, 1) })
    const failure = failNextRedisCommand('del', new Error('record unavailable'))
    try {
      await expect(deleteImageOrigin(sessionId, messageId)).rejects.toThrow('record unavailable')
      expect(failure.failed()).toBe(true)
    } finally {
      failure.restore()
    }
    expect(await redis.exists(`image_origin:${sessionId}:${messageId}`)).toBe(true)
    expect(await loadImageOrigins(sessionId)).toEqual({})
    expect(await loadImageOrigins(sessionId, { messageIds: [messageId] })).toEqual({})
    await sweepImageOrigins(sessionId)
    expect(await redis.exists(`image_origin:${sessionId}:${messageId}`)).toBe(false)
    expect(await redis.exists(`image_origins:${sessionId}`)).toBe(false)
  })

  // The fake's KEYS matcher does not implement Redis glob escapes; only real Redis proves this.
  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('sweeps orphan records using the exact escaped chat id (BL-1024)', async () => {
    const sessionId = 'image-origin-[a]*?\\'
    const neighbor = 'image-origin-a-anything'
    await redis.set(`image_origin:${sessionId}:orphan`, { messageId: 'orphan', version: 1, state: 'pending' })
    await redis.set(`image_origin:${neighbor}:orphan`, { messageId: 'orphan', version: 1, state: 'pending' })
    await sweepImageOrigins(sessionId)
    expect(await redis.exists(`image_origin:${sessionId}:orphan`)).toBe(false)
    expect(await redis.exists(`image_origin:${neighbor}:orphan`)).toBe(true)
  })
})
