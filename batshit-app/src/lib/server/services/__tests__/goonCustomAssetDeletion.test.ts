/** Real Redis Lua authority; file-service HTTP/physical IO is separately proven
 * by prove_sa121_asset_deletion.cjs. Never run against a normal runtime Redis. */
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { GoonRecord } from '$lib/types/goons'
import { createOwnedGoonForClient } from '../goonMutationRepository.server'
import {
  assertNoGoonAssetMaintenanceForRestore,
  cleanupOrphanGoonUploadAssets,
  deleteGoonUploadAsset,
  deleteUnreferencedGoonUploadReferences
} from '../goonAssetCleanupService'
import { withRecipeVerificationRestore } from '../recipeVerificationEpoch.server'
import { GET, POST } from '../../../../routes/api/admin/goon-assets/+server'

const require = createRequire(import.meta.url)
const claims = require(path.resolve('../batshit-server/server/src/services/goonCustomAssetClaims.js'))
const type = 'goon_custom_models' as const
const filename = `${'a'.repeat(64)}.glb`
const uploadKey = `upload:${type}:${filename}`
const markerKey = `goon_asset_delete:${type}:${filename}`
useRedisTestServer()
beforeEach(() => vi.stubEnv('BATSHIT_TOKEN', 'goon-deletion-test-service-token'))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function goon(id = 'new-owner'): GoonRecord {
  return {
    id, user_id: 'josh', name: id, kind: 'custom',
    created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
    customAvatar: { model: { filename, url: `/uploads/${type}/${filename}` } }
  } as GoonRecord
}

async function seedUpload() {
  await redis.json.set(uploadKey, '$', { storage: 'redis', base64: 'AQID', size: 3 })
}

function fileService(options: {
  beforeReserve?: () => Promise<void>
  afterReserve?: () => Promise<void>
  afterDeleteClaim?: () => Promise<void>
} = {}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/asset-deletion/reserve')) {
      calls.push('reserve')
      await options.beforeReserve?.()
      const result = await redis.execute((client) => claims.reserveCustomRecipeDeletion(client, body.uploadType, body.filename))
      await options.afterReserve?.()
      return Response.json({ success: true, ...result })
    }
    expect(url).toMatch(/\/upload\/asset$/)
    expect(init.method).toBe('DELETE')
    calls.push('delete')
    await redis.execute((client) => claims.beginCustomRecipeDeletion(client, body.uploadType, body.filename, body.deletionToken))
    await options.afterDeleteClaim?.()
    await redis.del(`upload:${body.uploadType}:${body.filename}`)
    await redis.execute((client) => claims.finishCustomRecipeDeletion(client, body.uploadType, body.filename, body.deletionToken))
    return Response.json({ success: true })
  }))
  return calls
}

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('custom Goon deletion ownership', () => {
  it('Inspect exposes a referenced asset reservation and a selected cleanup releases it without deletion', async () => {
    await seedUpload()
    await redis.execute((client) => createOwnedGoonForClient({ client, userId: 'josh', goon: goon() }))
    await redis.execute((client) => claims.reserveCustomRecipeDeletion(client, type, filename))
    await expect(assertNoGoonAssetMaintenanceForRestore()).rejects.toThrow('unfinished')
    const locals = { user: { id: 'josh', is_admin: true } }
    const audit = (await (await GET({ locals } as any) as Response).json()).audit
    expect(audit.orphanRecordCount).toBe(0)
    expect(audit.cleanupCandidates).toMatchObject([{ uploadType: type, filename, referenced: true }])
    expect(audit.cleanupCandidates[0].reason).toContain('interrupted')
    expect(audit.cleanupCandidates[0].reason).not.toContain('absent')
    const calls = fileService()
    const response = await POST({ locals, request: new Request('http://localhost/api/admin/goon-assets', {
      method: 'POST', body: JSON.stringify({ confirmDeleteOrphans: true, selectedAssets: [`${type}/${filename}`] })
    }) } as any) as Response
    expect(response.status).toBe(200)
    expect(calls).toEqual(['reserve'])
    expect(await redis.exists(markerKey)).toBe(false)
    expect(await redis.json.get(uploadKey)).toMatchObject({ base64: 'AQID' })
    expect(await redis.json.get('goon:new-owner')).toMatchObject({ id: 'new-owner' })
    await expect(assertNoGoonAssetMaintenanceForRestore()).resolves.toBeUndefined()
  })

  it('preserves an owner acquired after the caller stale audit, before reservation', async () => {
    await seedUpload()
    const calls = fileService({ beforeReserve: () => redis.execute(async (client) => {
      await createOwnedGoonForClient({ client, userId: 'josh', goon: goon() })
    }) })
    const deleted = await deleteUnreferencedGoonUploadReferences(
      new Map([[`${type}/${filename}`, new Set(['old owner'])]]), new Map())
    expect(deleted).toEqual([])
    expect(calls).toEqual(['reserve'])
    expect(await redis.json.get(uploadKey)).toMatchObject({ base64: 'AQID' })
    expect(await redis.exists(markerKey)).toBe(false)
  })

  it('rejects acquisition during reservation and after deletion without mutating the owner index', async () => {
    await seedUpload()
    const acquire = () => redis.execute((client) => createOwnedGoonForClient({ client, userId: 'josh', goon: goon() }))
    fileService({ afterReserve: async () => {
      await expect(acquire()).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
      expect(await redis.json.get('goon:new-owner')).toBeNull()
    } })
    expect(await deleteGoonUploadAsset(type, filename)).toBe(true)
    await expect(acquire()).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
    expect(await redis.sMembers('user:josh:goons')).toEqual([])
    await seedUpload()
    await expect(acquire()).resolves.toMatchObject({ id: 'new-owner' })
  })

  it('retains uncertain deletion ownership, refuses restore, and resumes through Admin cleanup', async () => {
    await seedUpload()
    fileService({ afterDeleteClaim: async () => { throw new Error('lost HTTP response') } })
    await expect(deleteGoonUploadAsset(type, filename)).rejects.toThrow('lost HTTP response')
    expect(await redis.execute((client) => client.get(markerKey))).toContain('deleting')
    await expect(assertNoGoonAssetMaintenanceForRestore()).rejects.toThrow('unfinished')
    // Also cover the crash between metadata deletion and claim release.
    await redis.del(uploadKey)
    fileService()
    const result = await cleanupOrphanGoonUploadAssets('josh')
    expect(result.failed).toEqual([])
    expect(result.deleted.map((entry) => entry.filename)).toContain(filename)
    await expect(assertNoGoonAssetMaintenanceForRestore()).resolves.toBeUndefined()
  })

  it('keeps restore waiting until an acquired physical deletion settles', async () => {
    await seedUpload()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const pause = new Promise<void>((resolve) => { release = resolve })
    fileService({ afterDeleteClaim: async () => { entered(); await pause } })
    const deletion = deleteGoonUploadAsset(type, filename)
    await started
    const mutate = vi.fn(async () => { await assertNoGoonAssetMaintenanceForRestore() })
    const restore = withRecipeVerificationRestore(mutate)
    await Promise.resolve()
    expect(mutate).not.toHaveBeenCalled()
    release()
    await deletion
    await restore
    expect(mutate).toHaveBeenCalledOnce()
  })
})
