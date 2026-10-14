import { afterEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET, POST } from './+server'

// Actual Admin handlers and audit, fake under the default lane and real DB15
// under test:redis. The file-service dispatch is observed separately.
useRedisTestServer()
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const locals = { user: { id: 'bl1025', is_admin: true } }
const request = (body: unknown) => new Request('http://localhost/api/admin/goon-assets', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
})
async function seed(type: string, name: string) {
  await redis.json.set(`upload:${type}:${name}`, '$', { size: 1234, base64: 'AQID' })
}

describe('Admin orphan cleanup authorization and preservation (BL-1025)', () => {
  it('requires an Admin and an explicit deletion confirmation', async () => {
    const dispatch = vi.fn()
    vi.stubGlobal('fetch', dispatch)
    expect((await POST({ locals: {}, request: request({ confirmDeleteOrphans: true, selectedAssets: ['goons/old.vrm'] }) } as any) as Response).status).toBe(401)
    expect((await POST({ locals: { user: { id: 'bl1025' } }, request: request({ confirmDeleteOrphans: true, selectedAssets: ['goons/old.vrm'] }) } as any) as Response).status).toBe(403)
    expect((await POST({ locals, request: request({ selectedAssets: ['goons/old.vrm'] }) } as any) as Response).status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([undefined, [], ['invalid/old.vrm'], ['goons/../old.vrm'], ['goons/..'], ['goons/old\\vrm']])(
    'rejects missing or malformed inspected selections: %j', async (selectedAssets) => {
      const dispatch = vi.fn()
      vi.stubGlobal('fetch', dispatch)
      const response = await POST({ locals, request: request({ confirmDeleteOrphans: true, selectedAssets }) } as any) as Response
      expect(response.status).toBe(400)
      expect(dispatch).not.toHaveBeenCalled()
    }
  )

  it('Inspect changes no data; direct confirmed cleanup cannot delete unknown Scene files', async () => {
    await seed('goon_scenes', 'lost.jpg')
    const before = await redis.json.get('upload:goon_scenes:lost.jpg')
    const dispatch = vi.fn()
    vi.stubGlobal('fetch', dispatch)
    const inspected = await GET({ locals } as any) as Response
    expect(inspected.status).toBe(200)
    expect((await inspected.json()).audit.orphans[0]).toMatchObject({ filename: 'lost.jpg', cleanupEligible: false })
    const response = await POST({ locals, request: request({ confirmDeleteOrphans: true, selectedAssets: ['goon_scenes/lost.jpg'] }) } as any) as Response
    expect(response.status).toBe(200)
    expect((await response.json()).cleanup.deletedCount).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await redis.json.get('upload:goon_scenes:lost.jpg')).toEqual(before)
    expect(await redis.json.get('user:bl1025:settings')).toBeNull()
  })

  it('uses a fresh audit and excludes files not covered by the explicit click', async () => {
    vi.stubEnv('BATSHIT_TOKEN', 'bl1025-test-service-token')
    await seed('goons', 'selected.vrm')
    await seed('goons', 'became-used.vrm')
    const inspected = (await (await GET({ locals } as any) as Response).json()).audit
    await seed('goons', 'later.vrm')
    await redis.sAdd('user:bl1025:goons', 'one')
    await redis.json.set('goon:one', '$', { id: 'one', user_id: 'bl1025', files: { vrm: { filename: 'became-used.vrm' } } })
    const dispatched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      dispatched.push(`${body.uploadType}/${body.filename}`)
      const removed = await redis.execute((client) => client.del(`upload:${body.uploadType}:${body.filename}`))
      return Response.json({ success: true, existed: removed > 0, deletedFile: false })
    }))
    const response = await POST({ locals, request: request({ confirmDeleteOrphans: true,
      selectedAssets: inspected.cleanupCandidates.map((entry: any) => `${entry.uploadType}/${entry.filename}`) }) } as any) as Response
    expect(response.status).toBe(200)
    expect(dispatched).toEqual(['goons/selected.vrm'])
    expect(await redis.exists('upload:goons:became-used.vrm')).toBe(true)
    expect(await redis.exists('upload:goons:later.vrm')).toBe(true)
    expect(await redis.exists('upload:goons:selected.vrm')).toBe(false)
  })
})
