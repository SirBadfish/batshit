import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  GoonMutationError,
  assertGenericGoonPatchAllowed,
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
})
