import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { GET } from './+server'

useRedisTestServer()
let serial = 0

async function session(userId: string) {
  const id = `codex-warning-route-${Date.now()}-${++serial}`
  await redis.createSession({ id, user_id: userId, name: 'test', agent_id: 'agent' } as any)
  return id
}

function event(sessionId: string | null, user: { id: string } | null = { id: 'owner' }) {
  const query = sessionId === null ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
  return { url: new URL(`http://localhost/api/codex/cleanup-warnings${query}`), locals: { user } } as any
}

describe('GET /api/codex/cleanup-warnings', () => {
  it('returns only the owner\'s fixed warning records', async () => {
    const id = await session('owner')
    await redis.set(`codex_cleanup_warning:${id}:reply`, { messageId: 'reply', kind: 'unconfirmed_command_cleanup' })
    await redis.sAdd(`codex_cleanup_warnings:${id}`, 'reply')
    await redis.set(`codex_cleanup_warning:${id}:forged`, { messageId: 'forged', text: 'untrusted process details' })
    await redis.sAdd(`codex_cleanup_warnings:${id}`, 'forged')
    const response = await GET(event(id))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ records: { reply: { messageId: 'reply', kind: 'unconfirmed_command_cleanup' } } })
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
