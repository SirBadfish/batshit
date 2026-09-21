import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { writeInferredRezips, writeInferredUnzips } from '$lib/server/services/zipStateInferred'
import { GET, POST } from './+server'

/**
 * SA-120 P5 — the zip state routes and `source: 'inferred'`. The browser never creates an
 * inferred unzip, but it re-posts one to persist its countdown; that must keep its source,
 * because coercing it to `user` would turn Batshit's weakest, temporary state into a user
 * lock. And the read side must name the third source instead of calling it the user's.
 */

useRedisTestServer()

const USER = 'user-unzipping-inferred'

async function ownedSession() {
  const sessionId = `unzipping-inferred-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  await redis.createSession({ id: sessionId, user_id: USER, name: 'zip state', agent_id: 'agent-1' } as any)
  return sessionId
}

function event(sessionId: string, body?: Record<string, unknown>) {
  return {
    url: new URL(`http://localhost/api/unzipping?sessionId=${sessionId}`),
    request: new Request('http://localhost/api/unzipping', {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    }),
    locals: { user: { id: USER, email: 'j@example.com' } }
  } as any
}

describe('/api/unzipping with inferred state', () => {
  it('keeps the inferred source when the browser re-posts the countdown', async () => {
    const sessionId = await ownedSession()
    await writeInferredUnzips(sessionId, [{ zipId: 'zip_jev', probability: 0.84, durationMessages: 2 }])

    const stored = (await redis.get(`unzipped_item:${sessionId}:zip_jev`)) as Record<string, unknown>
    const response = await POST(event(sessionId, { ...stored, messageCount: 1 }))
    expect(response.status).toBe(200)
    expect(await redis.get(`unzipped_item:${sessionId}:zip_jev`)).toMatchObject({ source: 'inferred', messageCount: 1, duration: 2 })
  })

  it('still reads an absent or unknown source as the user\'s', async () => {
    const sessionId = await ownedSession()
    await POST(event(sessionId, { zipId: 'zip_plain', sessionId, permanent: true, unzippedAt: 1 }))
    await POST(event(sessionId, { zipId: 'zip_odd', sessionId, permanent: true, unzippedAt: 1, source: 'mystery' }))
    expect(await redis.get(`unzipped_item:${sessionId}:zip_plain`)).toMatchObject({ source: 'user' })
    expect(await redis.get(`unzipped_item:${sessionId}:zip_odd`)).toMatchObject({ source: 'user' })
  })

  it('reports whose rezip each marker is, inferred included', async () => {
    const sessionId = await ownedSession()
    await writeInferredRezips(sessionId, [{ zipId: 'zip_closed', done: 0.9, again: 0.1 }])
    await redis.sAdd(`rezipped:${sessionId}`, 'zip_hand')
    await redis.set(`rezipped_item:${sessionId}:zip_hand`, { zipId: 'zip_hand', sessionId, source: 'agent', rezippedAt: 1 })
    await redis.sAdd(`rezipped:${sessionId}`, 'zip_legacy')

    const payload = await (await GET(event(sessionId))).json()
    expect(payload.rezippedSources).toEqual({ zip_closed: 'inferred', zip_hand: 'agent', zip_legacy: 'user' })
  })
})
