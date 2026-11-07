import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET } from './+server'

useRedisTestServer()

describe('authenticated Hair catalog projection', () => {
  it('keeps verified retained built-ins separate from current discovery', async () => {
    const denied = await GET({ locals: {} } as Parameters<typeof GET>[0])
    expect(denied.status).toBe(401)

    const response = await GET({ locals: { user: { id: 'hair-history-probe' } } } as Parameters<typeof GET>[0])
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.assets.map((asset: { revisionId: string }) => asset.revisionId))
      .toContain('batshit-style-01-r2')
    expect(payload.assets.map((asset: { revisionId: string }) => asset.revisionId))
      .not.toContain('batshit-style-01-r1')
    expect(payload.retainedBuiltinAssets.map((asset: { revisionId: string }) => asset.revisionId))
      .toContain('batshit-style-01-r1')
    expect(payload.retainedBuiltinAssets.map((asset: { revisionId: string }) => asset.revisionId))
      .not.toContain('batshit-style-01-r2')
    expect(payload.refitSources).toEqual([])
  })
})
