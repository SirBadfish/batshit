import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { __resetDmLocksForTests, createDm, getDm, listInbox } from '$lib/server/services/dm/dmStore'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import type { DmRecord } from '$lib/types/dm'

/**
 * SA-113 P4 (DL-113-10a) — the inbox drawer's routes.
 *
 * Two rules carry the weight here. The list must be summary-first (a drawer full of long
 * assignments has to cost one subject line each), and every route must refuse another
 * user's DM — these are the only DM surfaces that are not agent-scoped, so `record.userId`
 * is the whole ownership check.
 */

useRedisTestServer()

const USER = 'user-dm-routes'
const OTHER = 'user-somebody-else'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'

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

async function seedAssignment(overrides: Record<string, any> = {}): Promise<DmRecord> {
  return createDm({
    userId: USER,
    from: { kind: 'agent', agentId: FAYE, name: 'Faye' },
    to: COOPER,
    kind: 'assignment',
    subject: 'Verify the package',
    body: 'A long body the list route must not return.',
    requestedOutcome: 'Pass or fail.',
    scope: 'The packaged Mac app only.',
    reportBackTo: FAYE,
    deliver: 'wait',
    ...overrides
  })
}

function locals(userId: string | null) {
  return userId ? { user: { id: userId } } : {}
}

async function list(userId: string | null) {
  const { GET } = await import('./+server')
  return GET({ locals: locals(userId) } as any)
}

async function readOne(userId: string | null, id: string) {
  const { GET } = await import('./[id]/+server')
  return GET({ params: { id }, locals: locals(userId) } as any)
}

async function patch(userId: string | null, id: string, action: string) {
  const { PATCH } = await import('./[id]/+server')
  return PATCH({
    params: { id },
    locals: locals(userId),
    request: new Request('http://localhost:5620/api/dms/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })
  } as any)
}

async function remove(userId: string | null, id: string) {
  const { DELETE } = await import('./[id]/+server')
  return DELETE({ params: { id }, locals: locals(userId) } as any)
}

beforeEach(async () => {
  __resetDmLocksForTests()
  __resetWakeRunRegistryForTests()
  vi.restoreAllMocks()
  await seedAgent(COOPER)
  await seedAgent(FAYE)
})

describe('GET /api/dms', () => {
  it('needs a session', async () => {
    expect((await list(null)).status).toBe(401)
  })

  it('returns rows without bodies, plus the agents behind the presence dot', async () => {
    const record = await seedAssignment()
    const payload = await (await list(USER)).json()

    expect(payload.success).toBe(true)
    expect(payload.dms).toHaveLength(1)
    const row = payload.dms[0]
    expect(row).toMatchObject({
      id: record.id,
      kind: 'assignment',
      status: 'new',
      subject: 'Verify the package',
      to: COOPER
    })
    // Summary-first: the body and the result text belong to the single-DM route only.
    expect(row.body).toBeUndefined()
    expect(row.result).toBeUndefined()
    expect(row.hasResult).toBe(false)

    expect(payload.agents.map((agent: any) => agent.id).sort()).toEqual([COOPER, FAYE].sort())
    expect(payload.agents[0]).toHaveProperty('state')
  })

  it('shows only this user\'s DMs', async () => {
    await seedAssignment()
    await createDm({
      userId: OTHER,
      from: { kind: 'agent', agentId: 'agent-theirs', name: 'Theirs' },
      to: 'agent-theirs-2',
      kind: 'info',
      subject: 'Not yours',
      body: 'x',
      deliver: 'wait'
    })

    const payload = await (await list(USER)).json()
    expect(payload.dms).toHaveLength(1)
    expect(payload.dms[0].subject).toBe('Verify the package')
  })

  it('marks a row live only while its woken turn is actually running', async () => {
    const record = await seedAssignment()
    await redis.json.set(`dm:${record.id}`, '$.delivery', {
      requested: 'wake',
      actual: 'wake',
      sessionId: 'wake-session-1'
    } as never)

    // No wake run is registered, so the row must NOT offer a Stop button for a turn that
    // has already ended.
    const payload = await (await list(USER)).json()
    expect(payload.dms[0].runningSessionId).toBeNull()
    expect(payload.dms[0].delivery.sessionId).toBe('wake-session-1')
  })
})

describe('GET /api/dms/[id]', () => {
  it('returns the full record, body included', async () => {
    const record = await seedAssignment()
    const payload = await (await readOne(USER, record.id)).json()
    expect(payload.dm.body).toBe('A long body the list route must not return.')
    expect(payload.dm.requestedOutcome).toBe('Pass or fail.')
  })

  it('404s another user\'s DM rather than saying it exists', async () => {
    const record = await seedAssignment()
    expect((await readOne(OTHER, record.id)).status).toBe(404)
    expect((await readOne(USER, 'dm_nope')).status).toBe(404)
  })
})

describe('PATCH and DELETE /api/dms/[id]', () => {
  it('closes and reopens', async () => {
    const record = await seedAssignment()

    const closed = await (await patch(USER, record.id, 'done')).json()
    expect(closed.dm.status).toBe('done')
    expect(closed.dm.result).toBe('Closed by user')
    expect(await listInbox(COOPER)).toHaveLength(0)

    const reopened = await (await patch(USER, record.id, 'reopen')).json()
    expect(reopened.dm.status).toBe('new')
    expect((await listInbox(COOPER)).map((entry) => entry.id)).toEqual([record.id])
  })

  it('refuses an action it does not know', async () => {
    const record = await seedAssignment()
    const response = await patch(USER, record.id, 'archive')
    expect(response.status).toBe(400)
    expect((await getDm(record.id))?.status).toBe('new')
  })

  it('refuses to touch another user\'s DM', async () => {
    const record = await seedAssignment()
    expect((await patch(OTHER, record.id, 'done')).status).toBe(404)
    expect((await remove(OTHER, record.id)).status).toBe(404)
    expect(await getDm(record.id)).not.toBeNull()
  })

  it('deletes', async () => {
    const record = await seedAssignment()
    const payload = await (await remove(USER, record.id)).json()
    expect(payload.success).toBe(true)
    expect(await getDm(record.id)).toBeNull()
    expect((await (await list(USER)).json()).dms).toHaveLength(0)
  })

  it('needs a session for every write', async () => {
    const record = await seedAssignment()
    expect((await patch(null, record.id, 'done')).status).toBe(401)
    expect((await remove(null, record.id)).status).toBe(401)
  })
})
