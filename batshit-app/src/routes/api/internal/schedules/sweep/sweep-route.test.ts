import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createSchedule, getSchedule } from '$lib/server/services/schedules/scheduleStore'
import { __resetScheduleTickerForTests } from '$lib/server/services/schedules/scheduleTicker'

/**
 * SA-115 P1 (DL-115-13) — `POST /api/internal/schedules/sweep`.
 *
 * This lever can start agent turns, and a managed Cloudflare tunnel publishes the whole
 * origin while it runs, so most of what is pinned here is refusals: off unless the env
 * flag is set, and unauthorised without the service token. There is deliberately no
 * cookie lane, so a browser can never reach it at all.
 */

const deliverScheduledDm = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/services/dm/dmTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/dm/dmTools')>()),
  deliverScheduledDm
}))

useRedisTestServer()

const USER = 'user-sweep-route'
const COOPER = 'agent-cooper'
const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined
let previousFlag: string | undefined

async function call(options: { token?: string | null; body?: Record<string, unknown> } = {}) {
  const { POST } = await import('./+server')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) headers['x-batshit-service-token'] = options.token
  return POST({
    request: new Request('http://localhost:5620/api/internal/schedules/sweep', {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? {})
    })
  } as any)
}

async function seedDueSchedule(nextRunAt: string) {
  const record = await createSchedule({
    userId: USER,
    agentId: COOPER,
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: 'America/Chicago',
    message: 'Say good morning.'
  })
  await redis.json.set(`schedule:${record.id}`, '$.nextRunAt', nextRunAt as never)
  return record
}

beforeEach(async () => {
  deliverScheduledDm.mockReset()
  deliverScheduledDm.mockResolvedValue({
    dmId: 'dm_seeded',
    deliveredAs: 'wake',
    sessionId: 'session-seeded',
    outcome: 'woke: session-seeded'
  })
  __resetScheduleTickerForTests()
  previousToken = envRecord.BATSHIT_TOKEN
  previousFlag = envRecord.BATSHIT_ENABLE_WAKE_TEST_TRIGGER
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  envRecord.BATSHIT_ENABLE_WAKE_TEST_TRIGGER = '1'
  await redis.createAgent({
    id: COOPER,
    user_id: USER,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true
  } as any)
})

afterEach(() => {
  __resetScheduleTickerForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  if (previousFlag === undefined) delete envRecord.BATSHIT_ENABLE_WAKE_TEST_TRIGGER
  else envRecord.BATSHIT_ENABLE_WAKE_TEST_TRIGGER = previousFlag
  vi.restoreAllMocks()
})

describe('the two gates', () => {
  it('is NOT THERE at all without the env flag, even with the right token', async () => {
    delete envRecord.BATSHIT_ENABLE_WAKE_TEST_TRIGGER
    const response = await call({ token: 'test-service-token' })
    expect(response.status).toBe(404)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })

  it('refuses a caller with no token or the wrong token', async () => {
    const none = await call({})
    const wrong = await call({ token: 'not-the-token' })
    expect([none.status, wrong.status]).toEqual([401, 401])
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })

  it('accepts the service token', async () => {
    const response = await call({ token: 'test-service-token' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ fired: [], missed: [] })
  })
})

describe('sweeping', () => {
  it('fires a due schedule now, instead of waiting a minute for the ticker', async () => {
    const record = await seedDueSchedule('2026-09-08T14:00:00.000Z')
    const response = await call({
      token: 'test-service-token',
      body: { now: '2026-09-08T14:00:30.000Z' }
    })

    const report = await response.json()
    expect(report.fired).toHaveLength(1)
    expect(report.fired[0]).toMatchObject({ scheduleId: record.id, ok: true })
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
  })

  it('collapses an overdue schedule and fires nothing, with `now` far in the future', async () => {
    const record = await seedDueSchedule('2026-09-08T14:00:00.000Z')
    const response = await call({
      token: 'test-service-token',
      body: { now: '2026-09-11T13:00:00.000Z' }
    })

    const report = await response.json()
    expect(report.fired).toHaveLength(0)
    expect(report.missed).toHaveLength(1)
    // The 8th, 9th and 10th all went by; the 11th at 09:00 Chicago is still ahead.
    expect(report.missed[0]).toMatchObject({ scheduleId: record.id, count: 3 })
    expect(deliverScheduledDm).not.toHaveBeenCalled()
    expect((await getSchedule(record.id))?.missedRun?.count).toBe(3)
  })

  it('refuses an unreadable `now` rather than silently sweeping at the real time', async () => {
    await seedDueSchedule('2026-09-08T14:00:00.000Z')
    const response = await call({ token: 'test-service-token', body: { now: 'tomorrow-ish' } })
    expect(response.status).toBe(400)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })
})
