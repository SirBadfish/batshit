import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { loadClipRow } from '../clipService'
import { POST } from '../../../../routes/api/clips/+server'
import { PUT } from '../../../../routes/api/clips/[id]/+server'
import { PUT as PUT_SYSTEM } from '../../../../routes/api/clips/system/[id]/+server'

describe('actual Clip whole-row publishers (default seam, not Lua)', () => {
  useRedisTestServer()
  const originalExecute = vi.mocked(redis.execute).getMockImplementation()!
  const evalRefusal = vi.fn().mockResolvedValue('ASSET_UNAVAILABLE')
  beforeEach(async () => {
    const client = await redis.execute(async (client: any) => client)
    evalRefusal.mockClear()
    vi.mocked(redis.execute).mockImplementation((operation: any) => operation({ ...client, eval: evalRefusal }))
  })
  afterEach(() => { vi.mocked(redis.execute).mockImplementation(originalExecute) })
  const locals = { user: { id: 'owner', is_admin: true } }
  const request = (body: unknown) => new Request('http://fixture.test/api/clips', {
    method: 'POST', body: JSON.stringify(body)
  })
  const clip = { id: 'borrower', filename: 'borrowed.txt', fileType: 'text', mimeType: 'text/plain',
    localUrl: '/uploads/goon_hair_assets/shared.png', localBase64: Buffer.from('text').toString('base64') }

  it('refuses arbitrary POST acquisition before storing a Clip or index member', async () => {
    const response = await POST({ locals, request: request(clip) } as any)
    expect(response.status).toBe(500)
    expect(evalRefusal).toHaveBeenCalledTimes(1)
    expect(await redis.get('clip:owner:borrower')).toBeNull()
    expect(await redis.sMembers('user:owner:clips')).toEqual([])
  })

  it('guards a retained URL when PUT changes only prose and preserves the original row on refusal', async () => {
    await redis.json.set('clip:owner:borrower', '$', clip)
    const response = await PUT({ locals, params: { id: 'borrower' }, request: request({ description: 'changed' }) } as any)
    expect(response.status).toBe(500)
    expect(evalRefusal).toHaveBeenCalledTimes(1)
    expect(await redis.get('clip:owner:borrower')).toEqual(clip)
  })

  it('guards system PUT carried URLs before any row/index write', async () => {
    await redis.json.set('clip:system:borrower', '$', clip)
    await expect(PUT_SYSTEM({ locals, params: { id: 'borrower' }, request: request({ content: 'changed' }) } as any))
      .rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
    expect(await redis.get('clip:system:borrower')).toEqual(clip)
    expect(await redis.sMembers('user:system:clips')).toEqual([])
  })

  it('cannot reacquire borrowed bytes during legacy text content writeback', async () => {
    await redis.json.set('clip:owner:borrower', '$', clip)
    await expect(loadClipRow('owner', 'borrower')).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
    expect(evalRefusal).toHaveBeenCalledTimes(1)
    expect(await redis.get('clip:owner:borrower')).toEqual(clip)
  })
})
