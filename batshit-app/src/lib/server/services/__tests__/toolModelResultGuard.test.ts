import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { guardToolModelText, retainToolModelText } from '../toolModelResultGuard'
import { beginSessionDelete, endSessionDelete } from '../streamAbortRegistry'
import {
  __resetToolModelRetentionTurnBudgetsForTests,
  reserveToolModelRetainedCopy
} from '../toolModelRetentionTurnBudget'

useRedisTestServer()

beforeEach(() => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') vi.stubEnv('VITEST_FAKE_RETAINED_OUTPUT_EVAL', 'true')
})

const context = { userId: 'guard-user', sessionId: 'guard-chat', messageId: 'reply-not-saved', agentId: 'guard-agent', fetchZipAllowed: true }
const source = 'one unaltered line\n'.repeat(8_000)

async function seed() {
  await redis.json.set('session:guard-chat', '$', { id: context.sessionId, user_id: context.userId })
  await redis.sAdd(`user:${context.userId}:sessions`, context.sessionId)
}

afterEach(() => {
  endSessionDelete(context.sessionId)
  __resetToolModelRetentionTurnBudgetsForTests()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function spendFortyNineSlots() {
  for (let index = 0; index < 49; index += 1) {
    reserveToolModelRetainedCopy(context)?.commit()
  }
}

describe('tool model result retention', () => {
  it.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('does not simulate unrelated Lua scripts in the opt-in fake', async () => {
    await expect(redis.execute((client) => client.eval('return 1', {
      keys: [], arguments: []
    }))).rejects.toThrow('does not implement that Lua script')
  })

  it('leaves a small model result byte-identical without creating a zip', async () => {
    const getSession = vi.spyOn(redis, 'getSession')
    expect(await guardToolModelText('short\r\nresult', context)).toBe('short\r\nresult')
    expect(getSession).not.toHaveBeenCalled()
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
  })

  it('cuts server-classified memory results without raw storage or a fetch identifier', async () => {
    const getSession = vi.spyOn(redis, 'getSession')
    const result = await guardToolModelText(source, {
      ...context, memoryResult: true, modelTextBudget: { maxUtf8Bytes: 8_000, source: 'codex-fallback' }
    })
    expect(result).toContain('Search again with a narrower query or a smaller limit, or recall one memory by its id.')
    expect(result).not.toContain('zipId')
    expect(result).not.toContain('offset')
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(8_000)
    expect(getSession).not.toHaveBeenCalled()
    expect(await redis.keys('zip:*')).toEqual([])
  })

  it('saves the exact text and its deletion index before returning a fetchable id, without a saved message', async () => {
    await seed()
    const result = await guardToolModelText(source, context)
    const ids = await redis.sMembers('session:guard-chat:zips')
    expect(ids).toHaveLength(1)
    const zip = await redis.getZip(ids[0])
    expect(zip).toMatchObject({ type: 'tool_raw', content: source, metadata: {
      userId: context.userId, sessionId: context.sessionId, messageId: context.messageId, agentId: context.agentId, retainedForSizeGuard: true, retainedChars: source.length, droppedChars: 0
    } })
    expect(result).toContain(`Call Fetch Zip with zipId ${ids[0]} and offset `)
    expect(result.length).toBeLessThanOrEqual(100_000)
    expect(await redis.json.get(`message:${context.sessionId}:${context.messageId}`)).toBeNull()
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('sweeps the hidden raw copy when deleting its chat', async () => {
    await seed()
    await guardToolModelText(source, context)
    const [id] = await redis.sMembers('session:guard-chat:zips')
    await redis.deleteSession(context.sessionId)
    expect(await redis.getZip(id)).toBeNull()
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
  })

  it('caps the raw copy at 8M and explicitly names the discarded tail', async () => {
    await seed()
    const text = 'x'.repeat(8_000_000) + 'dropped-tail'
    const result = await guardToolModelText(text, context)
    const [id] = await redis.sMembers('session:guard-chat:zips')
    expect((await redis.getZip(id))?.content).toBe(text.slice(0, 8_000_000))
    expect(result).toContain('12 later characters were dropped')
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('persists only the helper-delivered 8M and records its omitted million-character tail', async () => {
    await seed()
    const delivered = 'x'.repeat(8_000_000)
    const originalTextChars = 9_000_000
    const result = await guardToolModelText(delivered, { ...context, originalTextChars })
    const [id] = await redis.sMembers('session:guard-chat:zips')
    const zip = await redis.getZip(id)
    expect(zip?.content).toBe(delivered)
    expect(zip?.content).toHaveLength(8_000_000)
    expect(zip?.metadata).toMatchObject({ modelTextChars: 9_000_000, retainedChars: 8_000_000, droppedChars: 1_000_000 })
    expect(result).toContain('9,000,000 characters')
    expect(result).toContain('1,000,000 later characters were dropped')
    expect(result).toContain(`Call Fetch Zip with zipId ${id} and offset `)
  })

  it('refuses missing turn identity, another user, and a deleting chat without a raw write', async () => {
    await seed()
    await expect(guardToolModelText(source, { ...context, messageId: '' })).rejects.toThrow('owning chat, reply, or agent')
    await expect(guardToolModelText(source, { ...context, userId: 'other-user' })).rejects.toThrow('unavailable')
    beginSessionDelete(context.sessionId)
    await expect(guardToolModelText(source, context)).rejects.toThrow('unavailable')
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
  })

  it('never returns an invented reference when Redis storage fails', async () => {
    await seed()
    spendFortyNineSlots()
    vi.spyOn(redis, 'getSession').mockResolvedValue({ id: context.sessionId, user_id: context.userId } as any)
    const execute = vi.spyOn(redis, 'execute').mockRejectedValueOnce(new Error('Redis write failed'))
    await expect(guardToolModelText(source, context)).rejects.toThrow('Redis write failed')
    execute.mockRestore()
    expect(await guardToolModelText(source, context)).toContain('Call Fetch Zip with zipId ')
    expect(await guardToolModelText(source, context)).toContain('retained-copy limit')
  })

  it('refuses a wrong-type index before writing a fresh raw record', async () => {
    await seed()
    await redis.set('session:guard-chat:zips', 'invalid-index')
    await expect(guardToolModelText(source, context)).rejects.toThrow()
    expect(await redis.keys('zip:*')).toEqual([])
  })

  it('admits exactly fifty raw copies for one reply under concurrent calls, then gives a no-id cut', async () => {
    await seed()
    const results = await Promise.all(Array.from({ length: 51 }, () => guardToolModelText(source, context)))
    const fetchable = results.filter((text) => text.includes('Call Fetch Zip with zipId '))
    const noId = results.filter((text) => text.includes('retained-copy limit'))
    expect(fetchable).toHaveLength(50)
    expect(noId).toHaveLength(1)
    expect(noId[0]).not.toContain('zipId ')
    expect(await redis.sMembers('session:guard-chat:zips')).toHaveLength(50)
    expect(await guardToolModelText(source, { ...context, messageId: 'another-reply' })).toContain('Call Fetch Zip with zipId ')
  })

  it('ignores indexed legacy zips with absent, null, or scalar metadata while admitting a raw copy', async () => {
    await seed()
    for (const [id, metadata] of [
      ['legacy-no-metadata', undefined],
      ['legacy-null-metadata', null],
      ['legacy-scalar-metadata', 'old metadata']
    ] as const) {
      await redis.json.set(`zip:${id}`, '$', { id, type: 'text', content: 'old', ...(metadata === undefined ? {} : { metadata }) })
      await redis.sAdd('session:guard-chat:zips', id)
    }
    const result = await guardToolModelText(source, context)
    expect(result).toContain('Call Fetch Zip with zipId ')
    expect(await redis.sMembers('session:guard-chat:zips')).toHaveLength(4)
  })

  it('removes its own raw record and index member when the chat disappears during the write', async () => {
    await seed()
    spendFortyNineSlots()
    vi.spyOn(redis, 'getSession')
      .mockResolvedValueOnce({ id: context.sessionId, user_id: context.userId } as any)
      .mockResolvedValueOnce(null)
    await expect(guardToolModelText(source, context)).rejects.toThrow('being deleted')
    expect(await redis.keys('zip:*')).toEqual([])
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
    expect(await guardToolModelText(source, context)).toContain('Call Fetch Zip with zipId ')
  })

  it('removes an indexed copy and refunds its slot when deletion begins after the write', async () => {
    await seed()
    spendFortyNineSlots()
    vi.spyOn(redis, 'getSession')
      .mockResolvedValueOnce({ id: context.sessionId, user_id: context.userId } as any)
      .mockImplementationOnce(async () => {
        beginSessionDelete(context.sessionId)
        return { id: context.sessionId, user_id: context.userId } as any
      })
    await expect(guardToolModelText(source, context)).rejects.toThrow('being deleted')
    expect(await redis.keys('zip:*')).toEqual([])
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
    endSessionDelete(context.sessionId)
    expect(await guardToolModelText(source, context)).toContain('Call Fetch Zip with zipId ')
  })

  it('does not announce a raw id if the post-write chat has a different owner', async () => {
    await seed()
    vi.spyOn(redis, 'getSession')
      .mockResolvedValueOnce({ id: context.sessionId, user_id: context.userId } as any)
      .mockResolvedValueOnce({ id: context.sessionId, user_id: 'another-user' } as any)
    await expect(guardToolModelText(source, context)).rejects.toThrow('not delivered')
    expect(await redis.keys('zip:*')).toEqual([])
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('keeps the deletion index if an undelivered raw copy cannot be deleted', async () => {
    await seed()
    spendFortyNineSlots()
    vi.spyOn(redis, 'getSession')
      .mockResolvedValueOnce({ id: context.sessionId, user_id: context.userId } as any)
      .mockResolvedValueOnce(null)
    vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('delete failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(guardToolModelText(source, context)).rejects.toThrow('being deleted')
    const ids = await redis.sMembers('session:guard-chat:zips')
    expect(ids).toHaveLength(1)
    expect(await redis.getZip(ids[0])).not.toBeNull()
    expect(await guardToolModelText(source, context)).toContain('retained-copy limit')
  })
  it('retains disabled-run output but gives no id or offset in its notice', async () => {
    await seed()
    const text = await guardToolModelText(source, { ...context, fetchZipAllowed: false })
    const [id] = await redis.sMembers('session:guard-chat:zips')
    expect((await redis.getZip(id))?.content).toBe(source)
    expect(text).toContain('The rest cannot be read in this run, because this agent has no Fetch Zip.')
    expect(text).not.toContain(id)
    expect(text).not.toContain('offset')
  })
  it('cleans up when the post-write ownership read itself fails', async () => {
    await seed()
    vi.spyOn(redis, 'getSession')
      .mockResolvedValueOnce({ id: context.sessionId, user_id: context.userId } as any)
      .mockRejectedValueOnce(new Error('post-write read failed'))
    await expect(guardToolModelText(source, context)).rejects.toThrow('post-write read failed')
    expect(await redis.keys('zip:*')).toEqual([])
    expect(await redis.sMembers('session:guard-chat:zips')).toEqual([])
  })

})
