import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { resolveSessionOrigin } from '$lib/utils/sessionOrigin'
import { POST as createSession } from '../../../routes/api/sessions/+server'
import { PUT as updateSession } from '../../../routes/api/sessions/[id]/+server'

/**
 * SA-113 P1 (DL-113-08) — the server owns `metadata.origin`, proved against the real
 * routes.
 *
 * Two ways it could be lost or forged, both closed here:
 *  - `POST /api/sessions` spreads the request body into the record, so a browser could
 *    otherwise claim its own chat was started by an agent.
 *  - `redis.updateSession` replaces metadata wholesale, so a read-spread-write caller
 *    (an agent switch, say) would otherwise strip a stored origin on the next save.
 */

useRedisTestServer()

const USER = 'user-origin-routes'

function cookieEvent(body: unknown, params: Record<string, string> = {}) {
  return {
    request: new Request('http://localhost:5621/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER } },
    params
  }
}

const storedOrigin = {
  version: 1,
  kind: 'dm' as const,
  label: 'Cooper',
  agentId: 'agent-cooper',
  at: '2026-09-07T12:00:00.000Z',
  chainDepth: 1
}

beforeEach(async () => {
  await redis.createSession({
    id: 'sess-woken',
    user_id: USER,
    name: 'DM from Cooper',
    agent_id: 'agent-cooper',
    created_at: '2026-09-07T09:00:00.000Z',
    last_modified_at: '2026-09-07T09:00:00.000Z',
    metadata: { agent_id: 'agent-cooper', origin: storedOrigin }
  } as any)
})

describe('POST /api/sessions', () => {
  it('strips a client-supplied origin so a browser cannot forge one', async () => {
    const response = (await (createSession as any)(
      cookieEvent({
        id: 'sess-forged',
        name: 'Mine',
        metadata: { agent_id: 'a1', origin: { kind: 'dm', label: 'Nobody' } }
      })
    )) as Response

    expect(response.status).toBe(200)
    const stored = await redis.getSession('sess-forged')
    expect(resolveSessionOrigin(stored)).toBeNull()
    expect((stored?.metadata as any)?.agent_id).toBe('a1')
  })

  it('rejects a session id containing a colon, which protects the user-channel name', async () => {
    const response = (await (createSession as any)(
      cookieEvent({ id: 'user:evil', name: 'Mine' })
    )) as Response

    expect(response.status).toBe(400)
    expect(await redis.getSession('user:evil')).toBeNull()
  })

  it('creates an ordinary session unchanged', async () => {
    const response = (await (createSession as any)(
      cookieEvent({ id: 'sess-plain', name: 'Mine', metadata: { agent_id: 'a1' } })
    )) as Response

    expect(response.status).toBe(200)
    const stored = await redis.getSession('sess-plain')
    expect(stored?.name).toBe('Mine')
    expect(resolveSessionOrigin(stored)).toBeNull()
  })
})

describe('PUT /api/sessions/[id]', () => {
  it('re-attaches a stored origin when a read-spread-write payload omits it', async () => {
    const response = (await (updateSession as any)(
      cookieEvent({ metadata: { agent_id: 'agent-faye', last_agent_id: 'agent-faye' } }, {
        id: 'sess-woken'
      })
    )) as Response

    expect(response.status).toBe(200)
    const stored = await redis.getSession('sess-woken')
    expect(resolveSessionOrigin(stored)).toMatchObject({ kind: 'dm', label: 'Cooper' })
    expect((stored?.metadata as any)?.agent_id).toBe('agent-faye')
  })

  it('refuses to change a stored origin', async () => {
    const response = (await (updateSession as any)(
      cookieEvent(
        { metadata: { origin: { ...storedOrigin, label: 'Somebody else' } } },
        { id: 'sess-woken' }
      )
    )) as Response

    expect(response.status).toBe(409)
    const stored = await redis.getSession('sess-woken')
    expect(resolveSessionOrigin(stored)?.label).toBe('Cooper')
  })

  it('refuses to add an origin to a chat the user started', async () => {
    await redis.createSession({
      id: 'sess-mine',
      user_id: USER,
      name: 'Mine',
      created_at: '2026-09-07T09:00:00.000Z',
      last_modified_at: '2026-09-07T09:00:00.000Z',
      metadata: {}
    } as any)

    const response = (await (updateSession as any)(
      cookieEvent({ metadata: { origin: storedOrigin } }, { id: 'sess-mine' })
    )) as Response

    expect(response.status).toBe(409)
    expect(resolveSessionOrigin(await redis.getSession('sess-mine'))).toBeNull()
  })

  it('leaves updates that carry no metadata alone', async () => {
    const response = (await (updateSession as any)(
      cookieEvent({ name: 'Renamed' }, { id: 'sess-woken' })
    )) as Response

    expect(response.status).toBe(200)
    const stored = await redis.getSession('sess-woken')
    expect(stored?.name).toBe('Renamed')
    expect(resolveSessionOrigin(stored)).toMatchObject({ kind: 'dm', label: 'Cooper' })
  })
})
