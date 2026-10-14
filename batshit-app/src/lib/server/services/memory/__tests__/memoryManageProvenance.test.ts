// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { getManagedMemoryDetail } from '../memoryManage'

/**
 * BL-447: the Memory Panel's "Where It Came From" list prints "(original chat deleted)" for a
 * provenance entry with `source_deleted`, but nothing ever set it. The detail loader now works
 * it out from whether each entry's chat (`session:{id}`) still exists, and stores nothing.
 * Runs on the default fake and on the real-Redis lane; no search index is needed.
 */

useRedisTestServer()

const USER = 'bl447-user'
const AGENT = 'bl447-agent'
const MEMORY_ID = 'mem_1790000000000_bl447a'
const LIVE_CHAT = 'bl447-live-chat'
const GONE_CHAT = 'bl447-gone-chat'
const CONTEXT = { userId: USER, agentId: AGENT }

function memoryRecord(provenance: Array<Record<string, unknown>>) {
  return {
    id: MEMORY_ID,
    agent_id: AGENT,
    user_id: USER,
    lane: 'ltm',
    content: 'Josh likes his coffee black.',
    importance: 5,
    event_at: null,
    event_ts: null,
    saved_at: '2026-09-20T12:00:00.000Z',
    saved_ts: Date.parse('2026-09-20T12:00:00.000Z'),
    is_superseded: 'n',
    provenance,
    visibility: 'normal',
    embedding: [1, 0],
    embedding_model: 'test-embedder',
    schema_version: 1
  }
}

async function seedChat(id: string) {
  await redis.json.set(`session:${id}`, '$', { id, user_id: USER, name: id } as never)
}

beforeEach(async () => {
  await redis.json.set(`agent:${AGENT}`, '$', { id: AGENT, user_id: USER, name: 'Provenance' } as never)
})

describe('Memory Panel detail: a provenance chat that is gone (BL-447)', () => {
  it('marks only the entries whose chat no longer exists, after that chat is deleted', async () => {
    await seedChat(LIVE_CHAT)
    await seedChat(GONE_CHAT)
    await redis.json.set(
      `memory:${AGENT}:${MEMORY_ID}`,
      '$',
      memoryRecord([
        { session_id: LIVE_CHAT, message_id: 'msg_1', source: 'agent' },
        { session_id: GONE_CHAT, message_id: 'msg_2', source: 'agent', quote: 'black, no sugar' },
        { session_id: GONE_CHAT, source: 'dreaming', note: 'merged' }
      ]) as never
    )

    const before = await getManagedMemoryDetail(CONTEXT, MEMORY_ID)
    expect(before.record.provenance.some((entry) => entry.source_deleted)).toBe(false)

    // The chat-delete sweep removes the chat record; it writes nothing into memories.
    await redis.del(`session:${GONE_CHAT}`)

    const after = await getManagedMemoryDetail(CONTEXT, MEMORY_ID)
    expect(after.record.provenance).toEqual([
      { session_id: LIVE_CHAT, message_id: 'msg_1', source: 'agent' },
      {
        session_id: GONE_CHAT,
        message_id: 'msg_2',
        source: 'agent',
        quote: 'black, no sugar',
        source_deleted: true
      },
      { session_id: GONE_CHAT, source: 'dreaming', note: 'merged', source_deleted: true }
    ])
  })

  it('stores nothing: the saved record keeps its provenance as it was', async () => {
    await seedChat(LIVE_CHAT)
    const provenance = [
      { session_id: LIVE_CHAT, source: 'agent' },
      { session_id: GONE_CHAT, source: 'agent' }
    ]
    await redis.json.set(`memory:${AGENT}:${MEMORY_ID}`, '$', memoryRecord(provenance) as never)

    const detail = await getManagedMemoryDetail(CONTEXT, MEMORY_ID)
    expect(detail.record.provenance[1].source_deleted).toBe(true)

    const stored = (await redis.json.get(`memory:${AGENT}:${MEMORY_ID}`)) as Record<string, any>
    expect(stored.provenance).toEqual(provenance)
  })

  it('decides from the chat alone, never from a flag found on the stored entry', async () => {
    await seedChat(LIVE_CHAT)
    await redis.json.set(
      `memory:${AGENT}:${MEMORY_ID}`,
      '$',
      memoryRecord([{ session_id: LIVE_CHAT, source: 'agent', source_deleted: true }]) as never
    )

    const detail = await getManagedMemoryDetail(CONTEXT, MEMORY_ID)
    expect(detail.record.provenance).toEqual([{ session_id: LIVE_CHAT, source: 'agent' }])
  })
})
