// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { GoonRecord } from '$lib/types/goons'
import { createRecipePhysicalMigrationFixture } from '$lib/goons/recipe/fixtures/recipePhysicalMigrationPair'
import { recipeAuthoringRevisionSha256, verifyGoonRecipe } from '$lib/goons/recipe/recipeContracts'
import { verifyGoonRecipeV2 } from '$lib/goons/recipe/recipeLifecycleContracts'
import * as mutations from '$lib/server/services/goonMutationRepository.server'
import { POST } from './+server'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER_ID = 'duplicate-branch-test-owner'
const SOURCE_ID = 'duplicate-branch-test-source'
const NOW = 1793270000000
const COPY_ID = `goon_${NOW}_${(.125).toString(36).slice(2, 8)}`
const sourceKey = `goon:${SOURCE_ID}`
const indexKey = `user:${USER_ID}:goons`
const settingsKey = `user:${USER_ID}:settings`
const copyKey = `goon:${COPY_ID}`
const event = () => ({ params: { id: SOURCE_ID }, locals: { user: { id: USER_ID } } }) as any

describe.runIf(REAL)('duplicate route fresh Recipe branch ownership', () => {
  useRedisTestServer()

  let v1: Awaited<ReturnType<typeof verifyGoonRecipe>>
  let v2: Awaited<ReturnType<typeof verifyGoonRecipeV2>>
  beforeAll(async () => {
    // Existing synthetic fixture; no source/model art or application assets.
    const fixture = await createRecipePhysicalMigrationFixture()
    const authoring = { contract: 'goon-recipe-authoring-revision/v1' as const, recipeRevision: 1,
      revisionId: 'synthetic-duplicate-1', revisionSha256: '0'.repeat(64),
      source: fixture.source.recipeSource, state: fixture.sourceState, updateReport: null }
    authoring.revisionSha256 = await recipeAuthoringRevisionSha256(authoring)
    v1 = await verifyGoonRecipe({ contract: 'goon-recipe/v1', recipeRevision: 1,
      revisionId: authoring.revisionId, concurrencyToken: 'a'.repeat(64), liveStatus: 'needs_bake',
      authoringRevision: authoring, activeRevision: null, previousRevision: null,
      activeLiveBuildReceipt: null, pendingJob: null, latestUpdateReport: null, lastFailure: null })
    v2 = await verifyGoonRecipeV2({ contract: 'goon-recipe/v2', writeVersion: 1, nextRecipeRevision: 2,
      liveStatus: 'needs_bake', authoringRevision: authoring, authoringSourceContainmentReceipt: {
        contract: 'recipe-archive-containment-receipt/v1', ref: 'synthetic-receipt', sha256: 'b'.repeat(64) },
      activeRevision: null, previousRevision: null, pendingAnalysis: null, pendingJob: null,
      latestUpdateReport: null, lastFailure: null, maintenanceFailure: null })
  }, 30000)
  afterEach(async () => {
    vi.restoreAllMocks()
    // Only these test-owned keys and the deterministic test copy are removed.
    await redis.execute((client) => client.del([sourceKey, indexKey, settingsKey, copyKey]))
  })
  afterAll(async () => { await redis.disconnect() })

  function source(extra: Partial<GoonRecord> = {}): GoonRecord {
    return { id: SOURCE_ID, user_id: USER_ID, name: 'Legacy', kind: 'vrm', sourceProfile: 'standard-vrm',
      files: { animations: [] }, created_at: 'before', updated_at: 'before', ...extra }
  }
  async function seed(goon: GoonRecord) {
    await redis.execute(async (client) => {
      await client.json.set(sourceKey, '$', goon as any)
      await client.sAdd(indexKey, SOURCE_ID)
    })
  }
  function fixCopyIdentity() {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.spyOn(Math, 'random').mockReturnValue(.125)
  }
  async function expectNoCopy() {
    expect(await redis.execute((client) => client.json.get(copyKey))).toBeNull()
    expect(await redis.execute((client) => client.sMembers(indexKey))).toEqual([SOURCE_ID])
  }

  it('refuses when a verified v2 owner is written between the branch read and the fresh owned read', async () => {
    const before = source()
    await seed(before)
    fixCopyIdentity()
    const bootstrap = mutations.readOwnedGoonRawForClient
    let transitioned = false
    vi.spyOn(mutations, 'readOwnedGoonRawForClient').mockImplementationOnce(async (client, userId, goonId) => {
      await client.json.set(sourceKey, '$.recipe', v2 as any)
      const unchanged = await bootstrap(client, userId, goonId)
      transitioned = true
      return unchanged
    })
    const response = await POST(event())
    expect(transitioned).toBe(true)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/changed.*duplicating.*reload/i)
    await expectNoCopy()
    const actual = await redis.execute((client) => client.json.get(sourceKey))
    expect(actual).toEqual({ ...before, recipe: v2 })
    await expect(verifyGoonRecipeV2((actual as GoonRecord).recipe)).resolves.toEqual(v2)
  })

  it('preserves the public global Closet while ordinary duplication retains its existing assignments', async () => {
    const before = source({ closetAssignments: { shirt: { mode: 'item', itemId: 'old' } } })
    await seed(before)
    const settings = { id: 'settings', user_id: USER_ID, goons_settings: { globalCloset: { items: { old: { id: 'old', name: 'Kept legacy item', category: 'top', kind: 'texture' } } } } }
    await redis.execute(client => client.json.set(settingsKey, '$', settings as any))
    fixCopyIdentity()
    const raw = await redis.json.getRaw(settingsKey, '$')
    const response = await POST(event())
    expect(response.status).toBe(200)
    expect((await response.json()).goon.closetAssignments).toEqual(before.closetAssignments)
    expect(await redis.json.getRaw(settingsKey, '$')).toBe(raw)
    expect(await redis.execute(client => client.json.get(sourceKey))).toEqual(before)
  })

  it('keeps the existing raw-source CAS for a change after the fresh read', async () => {
    const before = source()
    await seed(before)
    fixCopyIdentity()
    const create = mutations.createOwnedGoonForClient
    let transitioned = false
    vi.spyOn(mutations, 'createOwnedGoonForClient').mockImplementationOnce(async (input) => {
      await input.client.json.set(sourceKey, '$.recipe', v2 as any)
      transitioned = true
      return create(input)
    })
    const response = await POST(event())
    expect(transitioned).toBe(true)
    expect(response.status).toBe(409)
    await expectNoCopy()
    expect(await redis.execute((client) => client.json.get(sourceKey))).toEqual({ ...before, recipe: v2 })
  })

  it.each(['none', 'v1'] as const)('preserves ordinary %s legacy duplication', async (kind) => {
    const before = source(kind === 'v1' ? { recipe: v1 } : {})
    await seed(before)
    fixCopyIdentity()
    const response = await POST(event())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.goon).toMatchObject({ id: COPY_ID, user_id: USER_ID, name: 'Legacy Copy', files: before.files })
    expect(result.goon.recipe).toEqual(before.recipe)
    expect(await redis.execute((client) => client.json.get(sourceKey))).toEqual(before)
    expect(await redis.execute((client) => client.json.get(copyKey))).toMatchObject({ id: COPY_ID, user_id: USER_ID })
  })

  it('continues to route a fresh v2 owner through the dedicated Recipe duplicator', async () => {
    const before = source({ recipe: v2 })
    await seed(before)
    fixCopyIdentity()
    const ownedReadSpy = vi.spyOn(mutations, 'readOwnedGoonRawForClient')
    const createSpy = vi.spyOn(mutations, 'createOwnedGoonForClient')
    // This synthetic v2 has no active revision; the real dedicated owner must
    // refuse it before publishing a duplicate, not use the legacy path.
    const response = await POST(event())
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/complete active revision/i)
    expect(ownedReadSpy).toHaveBeenCalledOnce()
    expect(ownedReadSpy).toHaveBeenCalledWith(expect.anything(), USER_ID, SOURCE_ID)
    expect(createSpy).not.toHaveBeenCalled()
    expect(await redis.execute((client) => client.json.get(sourceKey))).toEqual(before)
    await expectNoCopy()
  })
})
