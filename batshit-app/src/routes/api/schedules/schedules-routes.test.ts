import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { MAX_SCHEDULES_PER_AGENT } from '$lib/utils/scheduleControl'
import { createSchedule, getSchedule } from '$lib/server/services/schedules/scheduleStore'

/**
 * SA-115 P2 (DL-115-01, DL-115-07, DL-115-09) — the Schedules card's routes.
 *
 * Two rules carry the weight. Every verb must refuse another user's schedule with the same
 * "not found" a missing id gets — anything else confirms the id exists. And **Run now** is
 * the only door a missed run can come through, so what it does and does not touch is
 * asserted rather than assumed.
 */

const deliverScheduledDm = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/dm/dmTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/dm/dmTools')>()),
  deliverScheduledDm
}))

useRedisTestServer()

const USER = 'user-schedule-routes'
const OTHER = 'user-somebody-else'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'
const CHICAGO = 'America/Chicago'

async function seedAgent(id: string, userId = USER, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: id === COOPER ? 'Cooper' : 'Faye',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true,
    ...overrides
  } as any)
}

function locals(userId: string | null) {
  return userId ? { user: { id: userId } } : {}
}

function jsonRequest(body: unknown) {
  return { json: async () => body } as any
}

async function list(userId: string | null) {
  const { GET } = await import('./+server')
  return GET({ locals: locals(userId) } as any)
}

async function create(userId: string | null, body: unknown) {
  const { POST } = await import('./+server')
  return POST({ request: jsonRequest(body), locals: locals(userId) } as any)
}

async function patch(userId: string | null, id: string, body: unknown) {
  const { PATCH } = await import('./[id]/+server')
  return PATCH({ params: { id }, request: jsonRequest(body), locals: locals(userId) } as any)
}

async function remove(userId: string | null, id: string) {
  const { DELETE } = await import('./[id]/+server')
  return DELETE({ params: { id }, locals: locals(userId) } as any)
}

async function runNow(userId: string | null, id: string) {
  const { POST } = await import('./[id]/run-now/+server')
  return POST({ params: { id }, locals: locals(userId) } as any)
}

async function skipMissed(userId: string | null, id: string) {
  const { POST } = await import('./[id]/skip-missed/+server')
  return POST({ params: { id }, locals: locals(userId) } as any)
}

function baseBody(overrides: Record<string, any> = {}) {
  return {
    agentId: COOPER,
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: CHICAGO,
    message: 'Say good morning.',
    ...overrides
  }
}

async function seedSchedule(overrides: Record<string, any> = {}) {
  return createSchedule({
    userId: USER,
    agentId: COOPER,
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: CHICAGO,
    message: 'Say good morning.',
    now: new Date('2026-09-08T15:00:00.000Z'),
    ...overrides
  })
}

beforeEach(async () => {
  deliverScheduledDm.mockReset()
  deliverScheduledDm.mockResolvedValue({
    dmId: 'dm_seeded',
    deliveredAs: 'wake',
    sessionId: 'session-seeded',
    outcome: 'woke: session-seeded'
  })
  await seedAgent(COOPER)
  await seedAgent(FAYE)
})

describe('authentication', () => {
  it('refuses every verb without a session', async () => {
    const record = await seedSchedule()
    for (const response of [
      await list(null),
      await create(null, baseBody()),
      await patch(null, record.id, { name: 'x' }),
      await remove(null, record.id),
      await runNow(null, record.id),
      await skipMissed(null, record.id)
    ]) {
      expect(response.status).toBe(401)
    }
  })
})

describe('GET /api/schedules', () => {
  it('returns this user’s schedules and the ELIGIBLE agents only', async () => {
    // An agent with Agent DMs off can never see a scheduled DM, so it must not be
    // offerable in the picker (AMD-113-05 parity). The card says why when the list is
    // empty rather than letting the user find out from a 400.
    await seedAgent('agent-quiet', USER, { displayName: 'Quiet', dms_enabled: false })
    await seedAgent('agent-n8n', USER, { displayName: 'Flow', agentType: 'n8n' })
    const record = await seedSchedule()

    const payload = await (await list(USER)).json()
    expect(payload.success).toBe(true)
    expect(Array.isArray(payload.schedules)).toBe(true)
    expect(payload.schedules.map((s: any) => s.id)).toEqual([record.id])
    expect(payload.agents.map((a: any) => a.id).sort()).toEqual([COOPER, FAYE])
  })

  it('does not leak another user’s schedules', async () => {
    await seedAgent('agent-theirs', OTHER)
    await seedSchedule({ userId: OTHER, agentId: 'agent-theirs' })
    const payload = await (await list(USER)).json()
    expect(payload.schedules).toHaveLength(0)
  })
})

describe('POST /api/schedules', () => {
  it('creates a schedule with the info + wake defaults (DL-115-14)', async () => {
    const payload = await (await create(USER, baseBody())).json()
    expect(payload.success).toBe(true)
    expect(payload.schedule.kind).toBe('info')
    expect(payload.schedule.deliver).toBe('wake')
    expect(payload.schedule.enabled).toBe(true)
    expect(payload.schedule.createdBy).toBe('user')
  })

  it('refuses a body that is not an object', async () => {
    for (const body of [null, 'nope', ['a']]) {
      expect((await create(USER, body)).status).toBe(400)
    }
  })

  it('refuses an agent with Agent DMs off, and says why', async () => {
    await seedAgent('agent-quiet', USER, { displayName: 'Quiet', dms_enabled: false })
    const response = await create(USER, baseBody({ agentId: 'agent-quiet' }))
    const payload = await response.json()
    expect(response.status).toBe(400)
    expect(payload.error).toContain('Agent DMs')
    expect(payload.hint).toContain('Agent Settings')
  })

  it('refuses another user’s agent as "not found"', async () => {
    await seedAgent('agent-theirs', OTHER)
    const response = await create(USER, baseBody({ agentId: 'agent-theirs' }))
    expect(response.status).toBe(404)
  })

  it('REFUSES at the per-agent cap with a reason instead of clamping', async () => {
    for (let index = 0; index < MAX_SCHEDULES_PER_AGENT; index += 1) {
      expect((await create(USER, baseBody({ name: `Check ${index}` }))).status).toBe(200)
    }
    const response = await create(USER, baseBody({ name: 'One too many' }))
    const payload = await response.json()
    expect(response.status).toBe(400)
    expect(payload.error).toContain(String(MAX_SCHEDULES_PER_AGENT))
    expect(payload.hint).toBeTruthy()
  })

  it('refuses a cron string and an out-of-range interval', async () => {
    expect((await create(USER, baseBody({ cadence: { type: 'cron', at: '* * * * *' } }))).status).toBe(400)
    expect(
      (await create(USER, baseBody({ cadence: { type: 'interval', everyMinutes: 1 } }))).status
    ).toBe(400)
  })
})

describe('PATCH and DELETE /api/schedules/[id]', () => {
  it('applies an edit and recomputes the next run when the WHEN changed', async () => {
    const record = await seedSchedule()
    const before = record.nextRunAt
    const payload = await (
      await patch(USER, record.id, { cadence: { type: 'interval', everyMinutes: 30 } })
    ).json()

    expect(payload.success).toBe(true)
    expect(payload.schedule.cadence).toEqual({ type: 'interval', everyMinutes: 30 })
    expect(payload.schedule.nextRunAt).not.toBe(before)
  })

  it('deletes a schedule', async () => {
    const record = await seedSchedule()
    expect((await remove(USER, record.id)).status).toBe(200)
    expect(await getSchedule(record.id)).toBeNull()
  })

  it('answers "not found" for a malformed id rather than reading a key', async () => {
    // `schedule:` + `s:{userId}` is byte-identical to the `schedules:{userId}` index SET,
    // so a crafted id must never reach Redis (the `wake_hook:` collision shape).
    for (const id of ['s:user-schedule-routes', 'sch_../../etc', 'nonsense']) {
      expect((await patch(USER, id, { name: 'x' })).status).toBe(404)
      expect((await remove(USER, id)).status).toBe(404)
    }
  })
})

describe('another user’s schedule is refused on EVERY verb', () => {
  it('answers "not found", never "forbidden"', async () => {
    const record = await seedSchedule()
    for (const response of [
      await patch(OTHER, record.id, { name: 'Hijacked' }),
      await remove(OTHER, record.id),
      await runNow(OTHER, record.id),
      await skipMissed(OTHER, record.id)
    ]) {
      expect(response.status).toBe(404)
    }
    // And nothing happened to it.
    const stored = await getSchedule(record.id)
    expect(stored?.name).toBe('Morning check')
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })
})

describe('POST /api/schedules/[id]/run-now', () => {
  it('fires, records the outcome, and does NOT move the schedule’s own clock', async () => {
    const record = await seedSchedule()
    const before = record.nextRunAt

    const payload = await (await runNow(USER, record.id)).json()
    expect(payload.success).toBe(true)
    expect(payload.outcome).toBe('woke: session-seeded')
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
    expect(deliverScheduledDm.mock.calls[0][1].trigger).toBe('run-now')

    const stored = await getSchedule(record.id)
    // Pressing Run now at 08:55 must not skip today's 9am run.
    expect(stored?.nextRunAt).toBe(before)
    expect(stored?.lastOutcome).toBe('woke: session-seeded')
    expect(stored?.runCount).toBe(1)
  })

  it('fires a PAUSED schedule too, because the button says "once, now" (F-P2-3a)', async () => {
    // Deliberate, and pinned here so nobody "fixes" it into an enabled-only check. Pausing
    // turns off a schedule's automatic times; it does not forbid the schedule from running.
    // It is also the only way to answer a missed-run item for a schedule paused afterwards.
    const record = await seedSchedule({ enabled: false })

    const payload = await (await runNow(USER, record.id)).json()

    expect(payload.success).toBe(true)
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
    // And it stays paused: a one-off run is not a resume.
    expect((await getSchedule(record.id))?.enabled).toBe(false)
  })

  it('clears the missed-run entry, so the dialog stops asking', async () => {
    const record = await seedSchedule()
    await redis.json.set(`schedule:${record.id}`, '$.missedRun', {
      dueAt: '2026-09-01T14:00:00.000Z',
      count: 3,
      noticedAt: '2026-09-08T15:00:00.000Z'
    } as never)

    await runNow(USER, record.id)
    expect((await getSchedule(record.id))?.missedRun).toBeNull()
  })

  it('records a FAILED fire rather than hiding it, and still clears the entry', async () => {
    const record = await seedSchedule()
    await redis.json.set(`schedule:${record.id}`, '$.missedRun', {
      dueAt: '2026-09-01T14:00:00.000Z',
      count: 1,
      noticedAt: '2026-09-08T15:00:00.000Z'
    } as never)
    deliverScheduledDm.mockRejectedValueOnce(new Error('that agent no longer exists'))

    const response = await runNow(USER, record.id)
    const payload = await response.json()
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('no longer exists')

    const stored = await getSchedule(record.id)
    expect(stored?.lastOutcome).toContain('failed:')
    // The user answered the dialog; re-asking would be the surprise.
    expect(stored?.missedRun).toBeNull()
  })
})

describe('POST /api/schedules/[id]/skip-missed', () => {
  it('clears ONLY the missed run — the schedule stays on (Josh’s "Skip", not "Cancel")', async () => {
    const record = await seedSchedule()
    await redis.json.set(`schedule:${record.id}`, '$.missedRun', {
      dueAt: '2026-09-01T14:00:00.000Z',
      count: 3,
      noticedAt: '2026-09-08T15:00:00.000Z'
    } as never)

    const payload = await (await skipMissed(USER, record.id)).json()
    expect(payload.success).toBe(true)

    const stored = await getSchedule(record.id)
    expect(stored?.missedRun).toBeNull()
    expect(stored?.enabled).toBe(true)
    expect(stored?.nextRunAt).toBe(record.nextRunAt)
    expect(stored?.runCount).toBe(0)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })
})
