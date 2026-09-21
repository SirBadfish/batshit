// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import type { JevJuicePostTurnRecord } from '$lib/types/typesafe'
import {
  deletePostTurnRecord,
  loadPostTurnRecord,
  loadPostTurnRecords,
  markPostTurnRecordTold,
  sweepPostTurnRecords,
  writePostTurnRecord
} from '../postTurnCheckState'

/**
 * SA-120 P6 — the only writer of the after-reply records (`jev_post_turn:{sessionId}` +
 * `jev_post_turn_item:{sessionId}:{messageId}`): a clean check stores nothing, a record is read
 * back defensively, the told mark never re-creates a deleted record, and both sweeps leave no
 * key behind. Runs on the fake and, under `npm run test:redis`, on real RedisJSON.
 */

useRedisTestServer()

let counter = 0
let SESSION = ''

function record(messageId: string, overrides: Partial<JevJuicePostTurnRecord> = {}): JevJuicePostTurnRecord {
  return {
    messageId,
    sessionId: SESSION,
    agentId: 'agent-1',
    at: '2026-09-17T08:00:00.000Z',
    findings: [{ id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.91 }],
    notes: [],
    toldAgent: false,
    ...overrides
  }
}

beforeEach(() => {
  counter += 1
  SESSION = `post-turn-session-${counter}-${Date.now()}`
})

describe('writePostTurnRecord', () => {
  it('stores one record per reply under the item key and indexes it under the session', async () => {
    expect(await writePostTurnRecord(record('msg_a'))).toBe(true)
    expect(await redis.sMembers(`jev_post_turn:${SESSION}`)).toEqual(['msg_a'])
    expect(await redis.get(`jev_post_turn_item:${SESSION}:msg_a`)).toEqual(record('msg_a'))
    expect(await loadPostTurnRecord(SESSION, 'msg_a')).toEqual(record('msg_a'))
  })

  it('stores nothing for a clean check: no findings and no notes means no key at all', async () => {
    expect(await writePostTurnRecord(record('msg_clean', { findings: [] }))).toBe(false)
    expect(await redis.sMembers(`jev_post_turn:${SESSION}`)).toEqual([])
    expect(await redis.exists(`jev_post_turn_item:${SESSION}:msg_clean`)).toBe(false)
  })

  it('stores a lane that could not run, so the chip can say so', async () => {
    const note = { feature: 'reply_check', status: 'unavailable' as const, reason: 'deadline' as const, at: '2026-09-17T08:00:00.000Z' }
    expect(await writePostTurnRecord(record('msg_note', { findings: [], notes: [note] }))).toBe(true)
    expect((await loadPostTurnRecord(SESSION, 'msg_note'))?.notes).toEqual([note])
  })

  it('drops anything it cannot read instead of guessing', async () => {
    await redis.set(`jev_post_turn_item:${SESSION}:msg_bad`, { messageId: 'msg_bad', findings: [{ id: 'made_up', lane: 'reply_check', source: 'inferred' }] })
    await redis.sAdd(`jev_post_turn:${SESSION}`, 'msg_bad')
    expect(await loadPostTurnRecord(SESSION, 'msg_bad')).toBeNull()
    expect(await loadPostTurnRecords(SESSION)).toEqual({})
  })
})

describe('loadPostTurnRecords', () => {
  it('returns every record of the chat keyed by message id, and nothing from another chat', async () => {
    await writePostTurnRecord(record('msg_a'))
    await writePostTurnRecord(record('msg_b', { findings: [{ id: 'same_move', lane: 'style_coach', source: 'inferred', probability: 0.9 }] }))
    await writePostTurnRecord({ ...record('msg_other'), sessionId: `${SESSION}-other` })
    const records = await loadPostTurnRecords(SESSION)
    expect(Object.keys(records).sort()).toEqual(['msg_a', 'msg_b'])
    expect(records.msg_b.findings[0].id).toBe('same_move')
    expect(await loadPostTurnRecords('')).toEqual({})
  })
})

describe('markPostTurnRecordTold', () => {
  it('flips the told mark once and keeps the findings', async () => {
    await writePostTurnRecord(record('msg_a'))
    await markPostTurnRecordTold(SESSION, 'msg_a')
    expect(await loadPostTurnRecord(SESSION, 'msg_a')).toEqual(record('msg_a', { toldAgent: true }))
  })

  it('never re-creates a record whose reply was deleted meanwhile', async () => {
    await writePostTurnRecord(record('msg_a'))
    await deletePostTurnRecord(SESSION, 'msg_a')
    await markPostTurnRecordTold(SESSION, 'msg_a')
    expect(await redis.exists(`jev_post_turn_item:${SESSION}:msg_a`)).toBe(false)
    expect(await redis.sMembers(`jev_post_turn:${SESSION}`)).toEqual([])
  })
})

describe('the two sweeps', () => {
  it('a deleted message takes its own record and leaves the others', async () => {
    await writePostTurnRecord(record('msg_a'))
    await writePostTurnRecord(record('msg_b'))
    await deletePostTurnRecord(SESSION, 'msg_a')
    expect(await redis.exists(`jev_post_turn_item:${SESSION}:msg_a`)).toBe(false)
    expect(await redis.sMembers(`jev_post_turn:${SESSION}`)).toEqual(['msg_b'])
  })

  it('a deleted session leaves no key behind', async () => {
    await writePostTurnRecord(record('msg_a'))
    await writePostTurnRecord(record('msg_b'))
    await sweepPostTurnRecords(SESSION)
    expect(await redis.exists(`jev_post_turn:${SESSION}`)).toBe(false)
    expect(await redis.exists(`jev_post_turn_item:${SESSION}:msg_a`)).toBe(false)
    expect(await redis.exists(`jev_post_turn_item:${SESSION}:msg_b`)).toBe(false)
  })
})
