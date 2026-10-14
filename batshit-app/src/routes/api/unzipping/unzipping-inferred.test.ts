import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { writeInferredRezips, writeInferredUnzips } from '$lib/server/services/zipStateInferred'
import { GET, POST } from './+server'
import { DELETE } from './[zipId]/+server'
import { normalizeId } from '$lib/utils/idNormalizer'

/**
 * SA-120 P5 and SA-129 P2 — the zip state routes are the USER's doorway. The server alone writes
 * `inferred` state (Judge Juice), an agent's holds, and every countdown (SA-129 P2 moved the
 * countdown off the tab), so whatever a browser posts is stored as the user's own hold, with no
 * agent and no hold path. The read side still names every source instead of calling it the user's.
 */

useRedisTestServer()

const USER = 'user-unzipping-inferred'

async function ownedSession() {
  const sessionId = `unzipping-inferred-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  await redis.createSession({ id: sessionId, user_id: USER, name: 'zip state', agent_id: 'agent-1' } as any)
  return sessionId
}

async function storedZip(sessionId: string, zipId: string) {
  await setZip({ id: zipId, type: 'text', content: 'small', tokens: 2, description: '', metadata: { sessionId } })
}

async function setZip(zip: Record<string, unknown>) {
  await redis.execute((client: any) => client.json.set(`zip:${zip.id}`, '$', zip))
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
  it('resolves a once-normalized all-digit zip tail through this chat index and stores that state ID', async () => {
    const sessionId = await ownedSession()
    const rawZipId = 'cool_tool_1790500000000_12345'
    const stateZipId = normalizeId(rawZipId)
    await storedZip(sessionId, rawZipId)
    await redis.sAdd(`session:${sessionId}:zips`, rawZipId)

    const response = await POST(event(sessionId, { zipId: stateZipId, sessionId, permanent: true }))
    expect(response.status).toBe(200)
    expect(await redis.sMembers(`unzipped:${sessionId}`)).toEqual([stateZipId])
    expect(await redis.get(`unzipped_item:${sessionId}:${stateZipId}`)).toMatchObject({ zipId: stateZipId, source: 'user' })
    expect(await redis.get(`unzipped_item:${sessionId}:${rawZipId}`)).toBeNull()
  })

  it('refuses a normalized collision even when the browser supplies an exact raw ID', async () => {
    const sessionId = await ownedSession()
    const first = 'cool_tool_1790500000000_12345'
    const second = 'cool_tool_1790500000000_67890'
    await Promise.all([storedZip(sessionId, first), storedZip(sessionId, second)])
    await redis.sAdd(`session:${sessionId}:zips`, first)
    await redis.sAdd(`session:${sessionId}:zips`, second)

    for (const supplied of [normalizeId(first), first]) {
      const response = await POST(event(sessionId, { zipId: supplied, sessionId, permanent: true }))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('ambiguous')
    }
    expect(await redis.sMembers(`unzipped:${sessionId}`)).toEqual([])
  })

  it('applies the too-large check to the resolved raw zip behind a normalized ID', async () => {
    const sessionId = await ownedSession()
    const rawZipId = 'cool_tool_1790500000002_12345'
    const stateZipId = normalizeId(rawZipId)
    await setZip({
      id: rawZipId, type: 'cool_tool', content: '{}', tokens: 1, description: '',
      metadata: { sessionId, promptTokens: 25_000, tokenBasis: 'ai_expanded' }
    })
    await redis.sAdd(`session:${sessionId}:zips`, rawZipId)
    const response = await POST(event(sessionId, { zipId: stateZipId, sessionId, permanent: true }))
    expect(response.status).toBe(413)
    expect(await redis.get(`unzipped_item:${sessionId}:${stateZipId}`)).toBeNull()
  })

  it('refuses a too-large Cool Tool Hold with a visible 413, without writing state', async () => {
    const sessionId = await ownedSession()
    await setZip({
      id: 'zip_too_large', type: 'cool_tool', content: '{}', tokens: 1, description: '',
      metadata: { sessionId, promptTokens: 25_000, tokenBasis: 'ai_expanded' }
    })
    const response = await POST(event(sessionId, { zipId: 'zip_too_large', sessionId, tokens: 1, permanent: true }))
    expect(response.status).toBe(413)
    expect((await response.json()).error).toContain('25,000 tokens')
    expect(await redis.sMembers(`unzipped:${sessionId}`)).toEqual([])
    expect(await redis.get(`unzipped_item:${sessionId}:zip_too_large`)).toBeNull()

    // A Hold made before this rule remains releasable through the existing path.
    await redis.sAdd(`unzipped:${sessionId}`, 'zip_too_large')
    await redis.set(`unzipped_item:${sessionId}:zip_too_large`, { zipId: 'zip_too_large', sessionId, source: 'user', permanent: true })
    const release = await DELETE({
      params: { zipId: 'zip_too_large' },
      url: new URL(`http://localhost/api/unzipping/zip_too_large?sessionId=${sessionId}&mode=automatic`),
      locals: { user: { id: USER } }
    } as any)
    expect(release.status).toBe(200)
    expect(await redis.sMembers(`unzipped:${sessionId}`)).toEqual([])
  })

  it('uses legacy transcript estimates after zero fields instead of falling back to renderer size', async () => {
    const sessionId = await ownedSession()
    for (const [zipId, metadata] of [
      ['zip_legacy_meta', { sessionId, tokenBasis: 'ai_expanded', tokens: 25_000 }],
      ['zip_zero_then_ai', { sessionId, promptTokens: 0, aiTokens: 25_000 }]
    ] as const) {
      await setZip({ id: zipId, type: 'cool_tool', content: '{}', ...(zipId === 'zip_legacy_meta' ? {} : { tokens: 1 }), description: '', metadata })
      const response = await POST(event(sessionId, { zipId, sessionId, tokens: 1, permanent: true }))
      expect(response.status, zipId).toBe(413)
      expect(await redis.get(`unzipped_item:${sessionId}:${zipId}`)).toBeNull()
    }
  })

  it('allows an ordinary Cool Tool and a non-Cool Tool at the boundary', async () => {
    const sessionId = await ownedSession()
    await setZip({
      id: 'zip_under_limit', type: 'cool_tool', content: '{}', tokens: 1, description: '',
      metadata: { sessionId, promptTokens: 24_999, tokenBasis: 'ai_expanded' }
    })
    await setZip({
      id: 'zip_image', type: 'image', content: 'image ref', tokens: 30_000, description: '', metadata: { sessionId }
    })
    for (const zipId of ['zip_under_limit', 'zip_image']) {
      expect((await POST(event(sessionId, { zipId, sessionId, permanent: true }))).status).toBe(200)
    }
  })

  it('does not write a Hold for a zip known to belong to a different chat', async () => {
    const sessionId = await ownedSession()
    const otherSessionId = await ownedSession()
    await storedZip(otherSessionId, 'zip_other_chat')
    const response = await POST(event(sessionId, { zipId: 'zip_other_chat', sessionId, permanent: true }))
    expect(response.status).toBe(403)
    expect(await redis.sMembers(`unzipped:${sessionId}`)).toEqual([])
  })

  it('keeps older user-owned zips without session metadata holdable', async () => {
    const sessionId = await ownedSession()
    await setZip({ id: 'zip_user_only', type: 'text', content: 'small', tokens: 2, description: '', metadata: { userId: USER } })
    const response = await POST(event(sessionId, { zipId: 'zip_user_only', sessionId, permanent: true }))
    expect(response.status).toBe(200)
    expect(await redis.get(`unzipped_item:${sessionId}:zip_user_only`)).toMatchObject({ source: 'user' })
  })

  it('stores whatever a browser posts as the user\'s own hold: never an agent\'s, never inferred', async () => {
    const sessionId = await ownedSession()
    await Promise.all(['zip_forged', 'zip_jev'].map((id) => storedZip(sessionId, id)))
    await POST(event(sessionId, { zipId: 'zip_forged', sessionId, permanent: true, unzippedAt: 1, source: 'agent', agentId: 'agent-1', path: 'src/app.ts' }))
    await POST(event(sessionId, { zipId: 'zip_jev', sessionId, permanent: false, duration: 2, messageCount: 0, unzippedAt: 1, source: 'inferred' }))
    const forged = (await redis.get(`unzipped_item:${sessionId}:zip_forged`)) as Record<string, unknown>
    expect(forged).toMatchObject({ source: 'user', permanent: true })
    expect(forged).not.toHaveProperty('agentId')
    expect(forged).not.toHaveProperty('path')
    expect(await redis.get(`unzipped_item:${sessionId}:zip_jev`)).toMatchObject({ source: 'user', duration: 2 })
  })

  it('a user Hold replaces an inferred open (the user wins)', async () => {
    const sessionId = await ownedSession()
    await storedZip(sessionId, 'zip_jev')
    await writeInferredUnzips(sessionId, [{ zipId: 'zip_jev', probability: 0.84, durationMessages: 2 }])
    await POST(event(sessionId, { zipId: 'zip_jev', sessionId, permanent: true, unzippedAt: 1 }))
    expect(await redis.get(`unzipped_item:${sessionId}:zip_jev`)).toMatchObject({ source: 'user', permanent: true })
  })

  it('still reads an absent or unknown source as the user\'s', async () => {
    const sessionId = await ownedSession()
    await Promise.all(['zip_plain', 'zip_odd'].map((id) => storedZip(sessionId, id)))
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
