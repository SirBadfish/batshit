import { afterEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-549 (N4): an Infinite Session nap and dreaming write only their own parts of the chat's
 * record, each at its own path, in one step inside Redis: a graduation event
 * (`appendFixedSessionGraduationEvent`), dreaming's era swap (`swapFixedSessionGraduationEvents`),
 * and the nap's record (`appendFixedSessionNapRecord`). They used to read the chat and write that
 * copy's whole metadata back, erasing a Compact event or any other block written in between.
 *
 * Real Redis 8 under `npm run test:redis` (Lua scripts there); the default lane's fake twins under
 * plain `npm test`, so both keep one contract. The nap-level races run in the memory lane
 * (`services/memory/__tests__/memoryWindow.test.ts`).
 */

useRedisTestServer()

const USER = 'zcnap_user'
const SESSION = 'zcnap_writes_session'

const compactEvent = {
  id: 'zcnap_compact',
  createdAt: '2026-09-27T12:00:00.000Z',
  sourceMessageIds: ['u1', 'a1'],
  summary: 'Written by a Compact.'
}

function gradEvent(id: string) {
  return {
    id,
    createdAt: '2026-09-27T12:00:00.000Z',
    source: 'nap',
    episodeId: null,
    segmentId: `seg_${id}`,
    sourceMessageIds: [`m_${id}`],
    compactedMessageCount: 1,
    summary: `summary ${id}`,
    summaryTokenEstimate: 3
  }
}

function napRecord(id: string) {
  return { id, at: '2026-09-27T12:00:00.000Z', status: 'completed', trigger: 'manual' }
}

async function seed(record: Record<string, unknown>) {
  await redis.json.set(`session:${SESSION}`, '$', {
    id: SESSION,
    user_id: USER,
    name: 'Shed',
    created_at: '2026-09-27T09:00:00.000Z',
    last_modified_at: '2026-09-27T09:00:00.000Z',
    ...record
  } as never)
}

const fixed = { version: 1, enabled: true, created_at: '2026-09-27T09:00:00.000Z' }

async function stored() {
  return (await redis.getSession(SESSION)) as any
}

afterEach(async () => {
  await redis.del(`session:${SESSION}`)
})

describe('the nap writes by path (BL-549 N4)', () => {
  it('a graduation event joins the stored list; every other block and field stays', async () => {
    await seed({
      locked: true,
      metadata: {
        contextCompaction: { version: 1, events: [compactEvent] },
        fixedSession: { ...fixed, graduation: { version: 1, events: [gradEvent('g1')] }, naps: [napRecord('n0')] }
      }
    })
    expect(await redis.appendFixedSessionGraduationEvent(SESSION, gradEvent('g2'))).toBe('ok')
    const record = await stored()
    expect(record.metadata.fixedSession.graduation.events.map((event: any) => event.id)).toEqual(['g1', 'g2'])
    expect(record.metadata.fixedSession.graduation.events[1]).toEqual(gradEvent('g2'))
    expect(record.metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
    expect(record.metadata.fixedSession.naps).toEqual([napRecord('n0')])
    expect(record.metadata.fixedSession.enabled).toBe(true)
    expect(record.locked).toBe(true)
    expect(record.last_modified_at).not.toBe('2026-09-27T09:00:00.000Z')
  })

  it('a first graduation event creates the list; a regular chat and a missing chat get no write', async () => {
    await seed({ metadata: { fixedSession: fixed } })
    expect(await redis.appendFixedSessionGraduationEvent(SESSION, gradEvent('g1'))).toBe('ok')
    expect((await stored()).metadata.fixedSession.graduation).toEqual({ version: 1, events: [gradEvent('g1')] })

    await seed({ metadata: { origin: { kind: 'zcnap' } } })
    expect(await redis.appendFixedSessionGraduationEvent(SESSION, gradEvent('g1'))).toBe('not_fixed')
    expect((await stored()).metadata).toEqual({ origin: { kind: 'zcnap' } })

    await redis.del(`session:${SESSION}`)
    expect(await redis.appendFixedSessionGraduationEvent(SESSION, gradEvent('g1'))).toBe('missing')
    expect(await redis.exists(`session:${SESSION}`)).toBe(false)
  })

  it('the era swap replaces its events in place and keeps events and blocks added since', async () => {
    await seed({
      metadata: {
        contextCompaction: { version: 1, events: [compactEvent] },
        fixedSession: {
          ...fixed,
          graduation: { version: 1, events: [gradEvent('g1'), gradEvent('g2'), gradEvent('g3'), gradEvent('g4')] }
        }
      }
    })
    expect(await redis.swapFixedSessionGraduationEvents(SESSION, ['g2', 'g3'], gradEvent('era'))).toEqual({ ok: true })
    const record = await stored()
    expect(record.metadata.fixedSession.graduation.events.map((event: any) => event.id)).toEqual(['g1', 'era', 'g4'])
    expect(record.metadata.fixedSession.graduation.events[1]).toEqual(gradEvent('era'))
    expect(record.metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
  })

  it('the era swap refuses, and writes nothing, when a replaced event is gone', async () => {
    await seed({ metadata: { fixedSession: { ...fixed, graduation: { version: 1, events: [gradEvent('g1'), gradEvent('g2')] } } } })
    expect(await redis.swapFixedSessionGraduationEvents(SESSION, ['g1', 'gone'], gradEvent('era'))).toEqual({
      ok: false,
      reason: 'changed',
      missing: ['gone']
    })
    expect((await stored()).metadata.fixedSession.graduation.events.map((event: any) => event.id)).toEqual(['g1', 'g2'])
    await redis.del(`session:${SESSION}`)
    expect(await redis.swapFixedSessionGraduationEvents(SESSION, ['g1'], gradEvent('era'))).toEqual({ ok: false, reason: 'missing' })
    expect(await redis.exists(`session:${SESSION}`)).toBe(false)
  })

  it('a nap record joins the stored history (the last 20 kept) and answers the stored metadata', async () => {
    const before = Array.from({ length: 20 }, (_, index) => napRecord(`n${index}`))
    await seed({
      metadata: {
        contextCompaction: { version: 1, events: [compactEvent] },
        fixedSession: { ...fixed, naps: before }
      }
    })
    const metadata = await redis.appendFixedSessionNapRecord(SESSION, napRecord('new'), 20)
    const record = await stored()
    expect(record.metadata.fixedSession.naps.map((nap: any) => nap.id)).toEqual([
      ...before.slice(1).map((nap) => nap.id),
      'new'
    ])
    expect(metadata).toEqual(record.metadata)
    expect(record.metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
  })

  it('a first nap record creates the history; a missing chat gets no write', async () => {
    await seed({ metadata: { fixedSession: fixed } })
    await redis.appendFixedSessionNapRecord(SESSION, napRecord('n1'), 20)
    expect((await stored()).metadata.fixedSession.naps).toEqual([napRecord('n1')])
    await redis.del(`session:${SESSION}`)
    expect(await redis.appendFixedSessionNapRecord(SESSION, napRecord('n2'), 20)).toBeNull()
    expect(await redis.exists(`session:${SESSION}`)).toBe(false)
  })
})
