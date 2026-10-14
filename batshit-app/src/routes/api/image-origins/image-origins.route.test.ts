import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { GET } from './+server'

useRedisTestServer()
let serial = 0

async function session(userId: string) {
  const id = `image-origin-route-${Date.now()}-${++serial}`
  await redis.createSession({ id, user_id: userId, name: 'test', agent_id: 'agent' } as any)
  return id
}

function event(sessionId: string | null, user: { id: string } | null = { id: 'owner' }) {
  const query = sessionId === null ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
  return { url: new URL(`http://localhost/api/image-origins${query}`), locals: { user } } as any
}

const HASH = 'a'.repeat(64)
const READ_EVIDENCE = { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }

describe('GET /api/image-origins (BL-474 step 2)', () => {
  it("returns the owner's well-formed records", async () => {
    const id = await session('owner')
    await redis.set(`image_origin:${id}:decided`, {
      messageId: 'decided', version: 1, state: 'decided', textHashes: [HASH], lane: 'api', complete: true,
      addresses: { 'https://a.example/x.png': { state: 'as_read', rule: 1, evidence: READ_EVIDENCE } }
    })
    await redis.set(`image_origin:${id}:pending`, { messageId: 'pending', version: 1, state: 'pending' })
    for (const member of ['decided', 'pending']) await redis.sAdd(`image_origins:${id}`, member)
    const response = await GET(event(id))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      records: {
        decided: {
          messageId: 'decided', version: 1, state: 'decided', textHashes: [HASH], lane: 'api', complete: true,
          addresses: { 'https://a.example/x.png': { state: 'as_read', rule: 1, evidence: READ_EVIDENCE } }
        },
        pending: { messageId: 'pending', version: 1, state: 'pending' }
      }
    })
  })

  it('fails visibly when the index names a malformed or missing record', async () => {
    const malformedId = await session('owner')
    await redis.set(`image_origin:${malformedId}:reply`, {
      messageId: 'reply', version: 1, state: 'decided', textHashes: [HASH], lane: 'api', complete: true,
      addresses: { 'https://a.example/x.png': { state: 'as_read', rule: 4, evidence: { ...READ_EVIDENCE, inRecord:'malformed' } } }
    })
    await redis.sAdd(`image_origins:${malformedId}`, 'reply')
    expect((await GET(event(malformedId))).status).toBe(500)

    const missingId = await session('owner')
    await redis.sAdd(`image_origins:${missingId}`, 'reply')
    expect((await GET(event(missingId))).status).toBe(500)
  })

  it('projects an older saved state through the server table without rewriting the saved evidence', async () => {
    const id=await session('owner')
    const address='https://a.example/x.png'
    const saved={messageId:'reply',version:1,state:'decided',textHashes:[HASH],lane:'api',complete:true,
      addresses:{[address]:{state:'as_read',rule:1,evidence:{...READ_EVIDENCE,sharesChatRun:true}}}}
    await redis.set(`image_origin:${id}:reply`,saved)
    await redis.sAdd(`image_origins:${id}`,'reply')
    const response=await GET(event(id))
    expect(response.status).toBe(200)
    const data=await response.json()
    expect(data.records.reply.addresses[address]).toEqual({state:'unknown',rule:3,evidence:saved.addresses[address].evidence})
    expect(await redis.get(`image_origin:${id}:reply`)).toEqual(saved)
  })

  it('refuses signed-out, missing, absent, and foreign sessions', async () => {
    const own = await session('owner')
    const foreign = await session('other')
    expect((await GET(event(own, null))).status).toBe(401)
    expect((await GET(event(null))).status).toBe(400)
    expect((await GET(event('missing'))).status).toBe(404)
    expect((await GET(event(foreign))).status).toBe(403)
  })
})
