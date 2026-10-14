import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  GoonMutationError,
  assertGenericGoonPatchAllowed,
  createOwnedGoonForClient,
  patchOwnedGoonForClient
} from '../goonMutationRepository.server'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe('atomic Goon mutation repository', () => {
  useRedisTestServer()

  it('reserves Recipe-owned fields once durable Recipe storage is active', () => {
    const existing = { recipe: { contract: 'goon-recipe/v2' } } as any
    expect(() => assertGenericGoonPatchAllowed(existing, { name: 'Allowed' })).not.toThrow()
    expect(() => assertGenericGoonPatchAllowed(existing, { customAvatar: null })).toThrowError(
      expect.objectContaining({ code: 'RECIPE_MANAGED_FIELD', status: 409 })
    )
    for (const field of [
      'oralAppearance',
      'nailSurface',
      'skinAppearance',
      'hairState',
      'clothingState',
      'sphericalEyelid',
      'recipeFitReceipts'
    ]) {
      expect(() => assertGenericGoonPatchAllowed(existing, { [field]: null })).toThrowError(
        expect.objectContaining({ code: 'RECIPE_MANAGED_FIELD', status: 409 })
      )
    }
    expect(() => assertGenericGoonPatchAllowed(existing, { recipe: null })).toThrowError(
      expect.objectContaining({ code: 'RESERVED_FIELD', status: 400 })
    )
    expect(() => assertGenericGoonPatchAllowed(existing, { id: 'replacement' })).toThrowError(
      expect.objectContaining({ code: 'RESERVED_FIELD', status: 400 })
    )
  })

  it.runIf(REAL_REDIS_LANE)('patches unrelated fields without replacing durable Recipe state', async () => {
    await redis.json.set('goon:atomic-goon', '$', {
      id: 'atomic-goon',
      user_id: 'atomic-user',
      name: 'Before',
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 7,
        sentinel: 'must-survive'
      },
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })

    const stored = await redis.execute((client) =>
      patchOwnedGoonForClient({
        client,
        userId: 'atomic-user',
        goonId: 'atomic-goon',
        updates: { name: 'After' },
        updatedAt: '2026-07-17T00:00:01.000Z'
      })
    )

    expect(stored).toMatchObject({
      name: 'After',
      recipe: { contract: 'goon-recipe/v2', writeVersion: 7, sentinel: 'must-survive' }
    })
    expect(stored).not.toBeInstanceOf(GoonMutationError)
  })

  it.runIf(REAL_REDIS_LANE)('rejects custom asset acquisition atomically during deletion and after metadata removal', async () => {
    const uploadKey = 'upload:goon_custom_models:shared.glb'
    const markerKey = 'goon_asset_delete:goon_custom_models:shared.glb'
    const base = {
      id: 'guarded-goon',
      user_id: 'atomic-user',
      name: 'Before',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    } as any
    const customAvatar = { model: { url: '/uploads/goon_custom_models/shared.glb', filename: 'shared.glb' } }
    await redis.execute((client) => client.json.set(uploadKey, '$', { filename: 'shared.glb' }))
    await redis.execute((client) => client.set(markerKey, JSON.stringify({
      contract: 'goon-asset-deletion/v1', phase: 'reserved'
    })))

    await expect(redis.execute((client) => createOwnedGoonForClient({
      client, userId: 'atomic-user', goon: { ...base, customAvatar }
    }))).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
    expect(await redis.json.get('goon:guarded-goon')).toBeNull()
    expect(await redis.execute((client) => client.sIsMember('user:atomic-user:goons', 'guarded-goon'))).toBe(0)

    await redis.execute((client) => client.del(markerKey))
    await redis.execute((client) => createOwnedGoonForClient({
      client, userId: 'atomic-user', goon: base
    }))
    await redis.execute((client) => client.set(markerKey, JSON.stringify({
      contract: 'goon-asset-deletion/v1', phase: 'deleting'
    })))
    await expect(redis.execute((client) => patchOwnedGoonForClient({
      client,
      userId: 'atomic-user',
      goonId: 'guarded-goon',
      updates: { name: 'Changed', customAvatar },
      updatedAt: '2026-07-17T00:00:01.000Z'
    }))).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
    expect(await redis.json.get('goon:guarded-goon')).toMatchObject({ name: 'Before' })

    await redis.execute((client) => client.del(markerKey))
    await redis.execute((client) => client.del(uploadKey))
    await expect(redis.execute((client) => patchOwnedGoonForClient({
      client,
      userId: 'atomic-user',
      goonId: 'guarded-goon',
      updates: { customAvatar },
      updatedAt: '2026-07-17T00:00:01.000Z'
    }))).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
    expect(await redis.json.get('goon:guarded-goon')).toMatchObject({ name: 'Before' })
  })

  it.runIf(REAL_REDIS_LANE)('blocks custom refs during restore while allowing records without them', async () => {
    await redis.json.set('upload:goon_custom_models:restored.glb', '$', { filename: 'restored.glb' })
    await redis.execute((client) => client.set('goon_asset_restore', 'restore-token'))
    const base = {
      id: 'restore-guarded-goon', user_id: 'atomic-user', name: 'Restoring',
      kind: 'custom', sourceProfile: 'expert-custom-glb', files: {},
      created_at: '2026-07-17T00:00:00.000Z', updated_at: '2026-07-17T00:00:00.000Z'
    } as any
    await expect(redis.execute((client) => createOwnedGoonForClient({
      client,
      userId: 'atomic-user',
      goon: {
        ...base,
        customAvatar: { model: { filename: 'restored.glb' } }
      }
    }))).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
    expect(await redis.json.get('goon:restore-guarded-goon')).toBeNull()

    await redis.execute((client) => createOwnedGoonForClient({ client, userId: 'atomic-user', goon: base }))
    expect(await redis.json.get('goon:restore-guarded-goon')).toMatchObject({ name: 'Restoring' })
  })
})
