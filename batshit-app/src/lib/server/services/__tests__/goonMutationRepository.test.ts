import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { GoonRecord } from '$lib/types/goons'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createRecipePhysicalMigrationFixture } from '$lib/goons/recipe/fixtures/recipePhysicalMigrationPair'
import { recipeAuthoringRevisionSha256 } from '$lib/goons/recipe/recipeContracts'
import { parseGoonRecipeV2, verifyGoonRecipeV2 } from '$lib/goons/recipe/recipeLifecycleContracts'
import {
  captureGoonCompatibilityBasis, captureGoonCompatibilityResetBasis,
  collectGoonCompatibilityMotionFiles, MAX_COMPATIBILITY_GOONS
} from '$lib/goons/goonCompatibilityBasis'
import { buildMountedLiveGoonAnimationPlan } from '$lib/goons/mountedLiveGoon'
import { normalizeGoonsSettings } from '$lib/goons/resolve'
import { resolveUploadUrlsForBrowserInPayload } from '../batshitServerUrls'
import { normalizeGoonAnimationLibrary } from '../goonAnimationLibraryNormalization.server'
import { GET as getGoonList } from '../../../../routes/api/goons/+server'
import { isGoonRuntimeReady, isRecipePreparationRequired, resolveRecipeProductReadiness } from '$lib/goons/recipe/recipeProductLifecycle'
import {
  GoonMutationError,
  assertGenericGoonPatchAllowed,
  createOwnedGoonForClient,
  patchOwnedGoonForClient,
  writeOwnedGoonCompatibilityForClient
} from '../goonMutationRepository.server'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
let firstParty: GoonRecord
let maleFirstParty: GoonRecord

async function firstPartyRecord(baseId: string): Promise<GoonRecord> {
  const fixture = await createRecipePhysicalMigrationFixture({ baseId, fitFamily: baseId })
  const authoringRevision = { contract: 'goon-recipe-authoring-revision/v1' as const, recipeRevision: 1,
    revisionId: 'routing-first-bake', revisionSha256: '0'.repeat(64), source: fixture.source.recipeSource,
    state: fixture.sourceState, updateReport: null }
  authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(authoringRevision)
  const recipe = await verifyGoonRecipeV2({ contract: 'goon-recipe/v2', writeVersion: 1, nextRecipeRevision: 2,
    liveStatus: 'needs_bake', authoringRevision, authoringSourceContainmentReceipt: {
      contract: 'recipe-archive-containment-receipt/v1', ref: 'goon_recipe_document:routing-user:routing-goon:source', sha256: 'a'.repeat(64) },
    activeRevision: null, previousRevision: null, pendingAnalysis: null, pendingJob: null,
    latestUpdateReport: null, lastFailure: null, maintenanceFailure: null })
  return { id: 'routing-goon', user_id: 'routing-user', name: 'Before', kind: 'custom',
    sourceProfile: 'expert-custom-glb', files: {}, recipe,
    customAvatar: { package: { filename: 'source.bgoon', url: fixture.source.recipeSource.package.ref },
      model: { filename: 'avatar.glb', url: fixture.source.recipeSource.model.ref },
      manifest: { filename: 'avatar.json', url: fixture.source.recipeSource.manifest.ref },
      manifestSummary: { baseId: fixture.source.identity.baseId, recipeReady: baseId === 'batshit-base-f-v1' } },
    created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z' }
}

beforeAll(async () => {
  firstParty = await firstPartyRecord('batshit-base-f-v1')
  maleFirstParty = await firstPartyRecord('batshit-base-m-v1')
})

describe('atomic Goon compatibility ownership', () => {
  useRedisTestServer()
  const userId = 'compat-user'
  const report = { tier: 'A' as const, issues: [], animationNames: ['wave'], boneCoverage: { present: 7, total: 7 } }

  function record(id: string, model: string): GoonRecord {
    return {
      id, user_id: userId, name: id, kind: 'vrm',
      files: { vrm: { url: `/uploads/goon_vrms/${model}.vrm`, filename: `${model}.vrm` }, animations: [] },
      compatibility: { tier: 'pending', issues: ['Awaiting VRM analysis'] },
      created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z'
    }
  }

  async function seed(goons: GoonRecord[]) {
    await redis.execute(async (client) => {
      for (const goon of goons) {
        await client.json.set(`goon:${goon.id}`, '$', goon as any)
        await client.sAdd(`user:${userId}:goons`, goon.id)
      }
    })
  }

  function basis(target: GoonRecord, goons: GoonRecord[], shared: GoonRecord['files']['animations'] = []) {
    const browserTarget = resolveUploadUrlsForBrowserInPayload(target)
    const browserGoons = resolveUploadUrlsForBrowserInPayload(goons)
    const browserShared = resolveUploadUrlsForBrowserInPayload(shared ?? [])
    const plan = buildMountedLiveGoonAnimationPlan(browserTarget,
      collectGoonCompatibilityMotionFiles(browserGoons, browserShared), normalizeGoonsSettings(null))
    return captureGoonCompatibilityBasis(browserTarget, browserGoons, browserShared, plan)
  }

  it.runIf(REAL_REDIS_LANE)('preserves prior compatibility and choices when known held null or false fields are present', async () => {
    for (const value of [null, false]) for (const held of [
      { anatomyPresence: value }, { clothingState: value }, { clothingCloset: value }, { sphericalEyelid: value },
      { closet: { items: {}, outfits: { kept: { name: 'Public outfit' } }, clothingPresets: value } },
      { recipe: { requiredMotionPreparation: value } }
    ]) {
      const target = record('compat-a', 'a'), captured = basis(target, [target])
      await seed([{ ...target, ...held, compatibility: { tier: 'C', issues: ['Prior report'] } } as any])
      const key = `goon:${target.id}`, before = await redis.execute(client => client.sendCommand(['JSON.GET', key]))
      const evaluate = vi.fn()
      await expect(redis.execute(client => writeOwnedGoonCompatibilityForClient({ client: new Proxy(client, { get(object, property) {
        if (property === 'eval') return evaluate
        const item = Reflect.get(object, property); return typeof item === 'function' ? item.bind(object) : item
      } }), userId, goonId: target.id, basis: captured, report, updatedAt: 'rejected' })))
        .rejects.toMatchObject({ code: 'COMPATIBILITY_UNAVAILABLE' })
      expect(evaluate).not.toHaveBeenCalled()
      expect(await redis.execute(client => client.sendCommand(['JSON.GET', key]))).toBe(before)
    }
  })

  it.runIf(REAL_REDIS_LANE)('checks known held state at the final compatibility RAW publication and preserves public outfits', async () => {
    const target = record('compat-a', 'a'), outfits = { kept: { name: 'Public outfit', assignments: {} } }
    target.closet = { items: {}, outfits } as any
    const captured = basis(target, [target])
    await seed([target])
    await redis.execute(async client => {
      let invocation!: { script: string; options: any }
      const stored = await writeOwnedGoonCompatibilityForClient({ client: new Proxy(client, { get(object, property) {
        if (property === 'eval') return async (script: string, options: any) => { invocation = { script, options }; return object.eval(script, options) }
        const item = Reflect.get(object, property); return typeof item === 'function' ? item.bind(object) : item
      } }), userId, goonId: target.id, basis: captured, report, updatedAt: 'accepted' })
      expect(stored.closet).toEqual({ items: {}, outfits })
      for (const value of [null, false]) for (const held of [
        { anatomyPresence: value }, { clothingState: value }, { clothingCloset: value }, { sphericalEyelid: value },
        { closet: { items: {}, outfits, clothingPresets: value } }, { recipe: { requiredMotionPreparation: value } }
      ]) {
        await client.json.set(`goon:${target.id}`, '$', { ...stored, ...held } as any)
        const before = await client.sendCommand(['JSON.GET', `goon:${target.id}`])
        // Test the final owner even with an exact matching RAW, independently
        // of the public JavaScript refusal and the ordinary stale-RAW guard.
        invocation.options.arguments[1] = before
        expect(await client.eval(invocation.script, invocation.options)).toBe('COMPATIBILITY_UNAVAILABLE')
        expect(await client.sendCommand(['JSON.GET', `goon:${target.id}`])).toBe(before)
      }
    })
  })

  it.runIf(REAL_REDIS_LANE)('writes a current report with a verified owner and preserves other fields', async () => {
    const target = record('compat-a', 'a')
    const other = record('compat-b', 'b')
    other.files.animations = [{ url: '/uploads/goon_animations/wave.glb', filename: 'wave.glb' }]
    await seed([target, other])
    const stored = await redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client, userId, goonId: target.id, basis: basis(target, [target, other]), report, updatedAt: 'after'
    }))
    expect(stored.compatibility).toMatchObject({ ...report, owner: { contract: 'goon-compatibility-owner/v1' } })
    expect(stored.files).toEqual(target.files)
    expect(stored.name).toBe(target.name)
    expect(await redis.json.get('goon:compat-b')).toEqual(other)
  })

  it.runIf(REAL_REDIS_LANE)('keeps nested motion leaves stable across repeated real preflight and EVAL reads', async () => {
    const target = record('compat-a', 'a')
    const other = record('compat-b', 'b')
    other.files.animations = [{ url: '/uploads/goon_animations/wave.glb', filename: 'wave.glb',
      originalName: 'Wave.glb', size: 42, motionMeta: { posture: 'stand', playback: 'loop', eyeContact: 'off' } }]
    await seed([target, other])
    const vault = { vrma: [{ url: '/uploads/goon_animations/sit.vrma', filename: 'sit.vrma',
      originalname: 'Sit.vrma', uploaded_at: '2026-10-29T00:00:00Z',
      motionMeta: { posture: ' sit ', playback: 'oneshot' } }] }
    await redis.json.set(`user:${userId}:goons_animation_library`, '$', vault as any)
    const shared = normalizeGoonAnimationLibrary(vault).vrma
    const captured = basis(target, [target, other], shared)
    await redis.execute(async (client) => {
      for (const [key, path] of [['goon:compat-b', '$.files.animations'],
        [`user:${userId}:goons_animation_library`, '$.vrma']] as const) {
        const values = []
        for (let index = 0; index < 6; index += 1) values.push(await client.sendCommand(['JSON.GET', key, path]))
        expect(new Set(values).size).toBe(1)
      }
      for (let index = 0; index < 6; index += 1) {
        const stored = await writeOwnedGoonCompatibilityForClient({
          client, userId, goonId: target.id, basis: captured, report, updatedAt: `after-${index}`
        })
        expect(stored.compatibility?.owner?.contract).toBe('goon-compatibility-owner/v1')
      }
    })
  })

  it.runIf(REAL_REDIS_LANE)('owns the validated basis and report before a direct caller mutates them', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    const captured = basis(target, [target])
    const callerReport = { tier: 'A' as const, issues: ['original'] }
    let mutated = false
    const stored = await redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client: {
        sMembers: client.sMembers.bind(client), eval: client.eval.bind(client),
        sendCommand: async (command: string[]) => {
          if (!mutated) {
            mutated = true
            captured.model.id = 'forged'
            callerReport.issues[0] = 'changed after validation'
          }
          return client.sendCommand(command)
        }
      }, userId, goonId: target.id, basis: captured, report: callerReport, updatedAt: 'after'
    }))
    expect(mutated).toBe(true)
    expect(stored.compatibility?.issues).toEqual(['original'])
    expect(stored.compatibility?.owner?.contract).toBe('goon-compatibility-owner/v1')
  })

  it.runIf(REAL_REDIS_LANE).each(['target', 'other-motion', 'vault', 'membership', 'settings'])(
    'refuses an in-flight %s change at the final atomic boundary', async (change) => {
      const target = record('compat-a', 'a')
      const other = record('compat-b', 'b')
      await seed([target, other])
      const captured = basis(target, [target, other])
      await expect(redis.execute((client) => writeOwnedGoonCompatibilityForClient({
        client: {
          sendCommand: client.sendCommand.bind(client), sMembers: client.sMembers.bind(client),
          eval: async (script: string, args: unknown) => {
            if (change === 'target') await client.json.set('goon:compat-a', '$.files.vrm.url', '/uploads/goon_vrms/replaced.vrm')
            if (change === 'other-motion') await client.json.set('goon:compat-b', '$.files.animations', [{ url: '/new.glb', filename: 'new.glb' }])
            if (change === 'vault') await client.json.set(`user:${userId}:goons_animation_library`, '$', { vrma: [{ url: '/new.glb', filename: 'new.glb' }] })
            if (change === 'membership') await client.sAdd(`user:${userId}:goons`, 'compat-c')
            if (change === 'settings') await client.json.set(`user:${userId}:settings`, '$', { goons_settings: { kitchen: { cues: {} } } })
            return client.eval(script, args as never)
          }
        }, userId, goonId: target.id, basis: captured, report, updatedAt: 'after'
      }))).rejects.toMatchObject({ code: 'COMPATIBILITY_STALE' })
      expect((await redis.json.get('goon:compat-a') as any).compatibility).toEqual(target.compatibility)
    }
  )

  it.runIf(REAL_REDIS_LANE)('refuses missing ownership and a generic full-record compatibility bypass', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    await expect(redis.execute((client) => patchOwnedGoonForClient({
      client, userId, goonId: target.id, updates: { name: 'Changed', compatibility: report }, updatedAt: 'after'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_OWNER_REQUIRED' })
    const { PUT } = await import('../../../../routes/api/goons/[id]/+server')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await PUT({ params: { id: target.id }, locals: { user: { id: userId } },
        request: new Request('http://test.local/api/goons/compat-a', { method: 'PUT',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) }) } as any)
      expect(response.status).toBe(409)
      expect(await redis.json.get('goon:compat-a')).toEqual(target)
    } finally { log.mockRestore() }
  })

  it.runIf(REAL_REDIS_LANE)('accepts only an authenticated route report with its captured basis', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    const { PUT } = await import('../../../../routes/api/goons/[id]/+server')
    const request = () => new Request('http://test.local/api/goons/compat-a', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compatibility: report, __compatibilityBasis: basis(target, [target]) }) })
    expect((await PUT({ params: { id: target.id }, locals: {}, request: request() } as any)).status).toBe(401)
    const accepted = await PUT({ params: { id: target.id }, locals: { user: { id: userId } }, request: request() } as any)
    expect(accepted.status).toBe(200)
    expect((await accepted.json()).goon.compatibility.owner.contract).toBe('goon-compatibility-owner/v1')
  })

  it.runIf(REAL_REDIS_LANE)('refuses foreign, malformed and oversized inventories without writing', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    const captured = basis(target, [target])
    const tooMany = { ...captured, goonOrder: Array.from({ length: MAX_COMPATIBILITY_GOONS + 1 }, (_, index) => `g${index}`) }
    await expect(redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client, userId, goonId: target.id, basis: tooMany, report, updatedAt: 'after'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_UNAVAILABLE' })
    await redis.execute(async (client) => {
      await client.json.set('goon:foreign', '$', { id: 'foreign', user_id: 'other-user', files: { animations: [] } })
      await client.sAdd(`user:${userId}:goons`, 'foreign')
    })
    const foreignBasis = { ...captured, goonOrder: [target.id, 'foreign'] }
    await expect(redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client, userId, goonId: target.id, basis: foreignBasis, report, updatedAt: 'after'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_UNAVAILABLE' })
    await redis.execute(async (client) => {
      await client.sRem(`user:${userId}:goons`, 'foreign')
      await client.json.set('goon:compat-a', '$.files.animations', 'not-an-array')
    })
    await expect(redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client, userId, goonId: target.id, basis: captured, report, updatedAt: 'after'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_UNAVAILABLE' })
    expect((await redis.json.get('goon:compat-a') as any).compatibility).toEqual(target.compatibility)
  })

  it.runIf(REAL_REDIS_LANE)('refuses a present Vault without its motion array before writing a report', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    await redis.json.set(`user:${userId}:goons_animation_library`, '$', { retained: true })
    await expect(redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client, userId, goonId: target.id, basis: basis(target, [target]), report, updatedAt: 'after'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_UNAVAILABLE' })
    expect((await redis.json.get('goon:compat-a') as any).compatibility).toEqual(target.compatibility)
    expect(await redis.json.get(`user:${userId}:goons_animation_library`)).toEqual({ retained: true })
  })

  it.runIf(REAL_REDIS_LANE).each(['missing', 'foreign', 'wrong-id', 'bad-name'])(
    'refuses an incomplete indexed Goon list before any Closet recovery: %s', async (kind) => {
      const target = record('compat-a', 'a')
      target.closetAssignments = { shirt: { mode: 'item', itemId: 'old' } }
      await seed([target])
      const settingsKey = `user:${userId}:settings`
      await redis.json.set(settingsKey, '$', { user_id: userId, goons_settings: { globalCloset: { items: {
        old: { id: 'old', name: 'Original', category: 'top', kind: 'texture',
          texture: { filename: 'old.png', url: '/uploads/goon_closet/old.png' } }
      } } } } as any)
      await redis.execute(async (client) => {
        await client.sAdd(`user:${userId}:goons`, 'bad')
        if (kind !== 'missing') {
          await client.json.set('goon:bad', '$', { id: kind === 'wrong-id' ? 'different' : 'bad',
            user_id: kind === 'foreign' ? 'someone-else' : userId,
            name: kind === 'bad-name' ? { invalid: true } : 'Other',
            files: { animations: [] } })
        }
      })
      const before = await redis.execute((client) => client.sendCommand(['JSON.GET', 'goon:compat-a']))
      const settingsBefore = await redis.execute((client) => client.sendCommand(['JSON.GET', settingsKey]))
      const result = await getGoonList({ locals: { user: { id: userId } } } as any)
      expect(result.status).toBe(409)
      expect((await result.json()).error).not.toContain('someone-else')
      expect(await redis.execute((client) => client.sendCommand(['JSON.GET', 'goon:compat-a']))).toBe(before)
      expect(await redis.execute((client) => client.sendCommand(['JSON.GET', settingsKey]))).toBe(settingsBefore)
    })

  it.runIf(REAL_REDIS_LANE)('keeps a valid legacy Goon with no files in the complete list', async () => {
    const legacy = record('compat-a', 'a') as any
    delete legacy.files
    await seed([legacy])
    const result = await getGoonList({ locals: { user: { id: userId } } } as any)
    expect(result.status).toBe(200)
    expect((await result.json()).goons.map((goon: GoonRecord) => goon.id)).toEqual([legacy.id])
  })

  it.runIf(REAL_REDIS_LANE)('keeps a Goon visible while its malformed motion source remains unverified', async () => {
    const target = record('compat-a', 'a')
    ;(target.files as any).animations = 'broken'
    await seed([target])
    const result = await getGoonList({ locals: { user: { id: userId } } } as any)
    expect(result.status).toBe(200)
    expect((await result.json()).goons[0].files.animations).toBe('broken')
    expect(() => basis(target, [target])).toThrow()
  })

  it('owns a generic creation record before yielding to the reference guard', async () => {
    const target = record('compat-new', 'new')
    const evaluate = vi.fn(async (_script: string, _args: { arguments: string[] }) => 'CREATED')
    const pending = createOwnedGoonForClient({ client: { eval: evaluate }, userId, goon: target })
    target.name = 'Changed after dispatch'
    ;(target as any).recipe = { requiredMotionPreparation: null }
    const created = await pending
    const written = JSON.parse(evaluate.mock.calls[0][1].arguments[0])
    expect(created.name).toBe('compat-new')
    expect(written.name).toBe('compat-new')
    expect(written.recipe).toBeUndefined()
  })

  it.runIf(REAL_REDIS_LANE)('refuses generic creation or legacy duplication that could forge a Recipe motion requirement', async () => {
    const source = record('compat-source', 'source')
    const clone = record('compat-clone', 'clone')
    await seed([source])
    const sourceRaw = await redis.execute((client) => client.sendCommand(['JSON.GET', 'goon:compat-source'])) as string
    for (const marker of [null, { contract: 'first-party-motion-requirement/v1' }]) {
      const forged = { ...clone, recipe: { requiredMotionPreparation: marker } } as any
      await expect(redis.execute((client) => createOwnedGoonForClient({ client, userId, goon: forged })))
        .rejects.toMatchObject({ code: 'RESERVED_FIELD' })
      await expect(redis.execute((client) => createOwnedGoonForClient({
        client, userId, goon: forged, duplicateSource: { goonId: source.id, raw: sourceRaw }
      }))).rejects.toMatchObject({ code: 'RESERVED_FIELD' })
    }
    const v2Raw = JSON.stringify({ ...source, recipe: { contract: 'goon-recipe/v2' } })
    await expect(redis.execute((client) => createOwnedGoonForClient({
      client, userId, goon: clone, duplicateSource: { goonId: source.id, raw: v2Raw }
    }))).rejects.toMatchObject({ code: 'RECIPE_MANAGED_FIELD' })
    const markedLegacyRaw = JSON.stringify({ ...source, recipe: { contract: 'goon-recipe/v1', requiredMotionPreparation: null } })
    await expect(redis.execute((client) => createOwnedGoonForClient({
      client, userId, goon: clone, duplicateSource: { goonId: source.id, raw: markedLegacyRaw }
    }))).rejects.toMatchObject({ code: 'RESERVED_FIELD' })
    expect(await redis.json.get('goon:compat-clone')).toBeNull()
    expect(await redis.execute((client) => client.sendCommand(['JSON.GET', 'goon:compat-source']))).toBe(sourceRaw)
  })

  it.runIf(REAL_REDIS_LANE)('resets pending only with a captured real model replacement', async () => {
    const target = record('compat-a', 'a')
    target.compatibility = { tier: 'A', issues: ['old'] }
    await seed([target])
    const reset = captureGoonCompatibilityResetBasis(resolveUploadUrlsForBrowserInPayload(target))
    const nextFiles = { ...target.files, vrm: { url: '/uploads/goon_vrms/b.vrm', filename: 'b.vrm' } }
    const stored = await redis.execute((client) => patchOwnedGoonForClient({
      client, userId, goonId: target.id, updates: { files: nextFiles, name: 'Preserved edit' },
      compatibilityResetBasis: reset, updatedAt: 'after'
    }))
    expect(stored).toMatchObject({ name: 'Preserved edit', files: nextFiles,
      compatibility: { tier: 'pending', issues: ['Awaiting VRM analysis'] } })
    await expect(redis.execute((client) => patchOwnedGoonForClient({
      client, userId, goonId: target.id, updates: { files: nextFiles },
      compatibilityResetBasis: captureGoonCompatibilityResetBasis(resolveUploadUrlsForBrowserInPayload(stored)), updatedAt: 'again'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_OWNER_REQUIRED' })
  })

  it.runIf(REAL_REDIS_LANE)('accepts pending-VRM promotion and guided replacement with the correct pending status', async () => {
    const pending = record('compat-a', 'a')
    pending.files.vrmPending = { url: '/uploads/goon_vrms/b.vrm', filename: 'b.vrm' }
    await seed([pending])
    const promoted = { ...pending.files, vrm: pending.files.vrmPending }
    delete promoted.vrmPending
    const result = await redis.execute((client) => patchOwnedGoonForClient({
      client, userId, goonId: pending.id, updates: { files: promoted },
      compatibilityResetBasis: captureGoonCompatibilityResetBasis(resolveUploadUrlsForBrowserInPayload(pending)), updatedAt: 'after'
    }))
    expect(result).toMatchObject({ files: { vrm: pending.files.vrmPending },
      compatibility: { tier: 'pending', issues: ['Awaiting VRM analysis'] } })

    const guided = record('compat-b', 'a')
    guided.sourceProfile = 'guided-custom-vrm'
    guided.guidedAvatar = { manifest: { url: '/old.json', filename: 'old.json' } }
    await seed([guided])
    const updated = await redis.execute((client) => patchOwnedGoonForClient({
      client, userId, goonId: guided.id,
      updates: { files: { ...guided.files, vrm: { url: '/new.vrm', filename: 'new.vrm' } },
        guidedAvatar: { ...guided.guidedAvatar, manifest: { url: '/new.json', filename: 'new.json' } } },
      compatibilityResetBasis: captureGoonCompatibilityResetBasis(resolveUploadUrlsForBrowserInPayload(guided)), updatedAt: 'after'
    }))
    expect(updated.compatibility).toEqual({ tier: 'pending', issues: ['Awaiting Advanced/Blender Goon analysis'] })
  })

  it.runIf(REAL_REDIS_LANE)('refuses a stale model reset after a concurrent replacement', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    const reset = captureGoonCompatibilityResetBasis(resolveUploadUrlsForBrowserInPayload(target))
    await expect(redis.execute((client) => patchOwnedGoonForClient({
      client: { sendCommand: client.sendCommand.bind(client), eval: async (script: string, args: unknown) => {
        await client.json.set('goon:compat-a', '$.files.vrm.url', '/uploads/goon_vrms/other.vrm')
        return client.eval(script, args as never)
      } }, userId, goonId: target.id,
      updates: { files: { ...target.files, vrm: { url: '/uploads/goon_vrms/new.vrm', filename: 'new.vrm' } } },
      compatibilityResetBasis: reset, updatedAt: 'after'
    }))).rejects.toMatchObject({ code: 'COMPATIBILITY_STALE' })
    const stored = await redis.json.get('goon:compat-a') as any
    expect(stored.files.vrm.url).toBe('/uploads/goon_vrms/other.vrm')
    expect(stored.compatibility).toEqual(target.compatibility)
  })

  it.runIf(REAL_REDIS_LANE)('owns a reset patch and basis before the first asynchronous read', async () => {
    const target = record('compat-a', 'a')
    await seed([target])
    const reset = captureGoonCompatibilityResetBasis(resolveUploadUrlsForBrowserInPayload(target))
    const updates = { files: { ...target.files, vrm: { url: '/uploads/goon_vrms/new.vrm', filename: 'new.vrm' } } }
    let mutated = false
    const stored = await redis.execute((client) => patchOwnedGoonForClient({
      client: {
        eval: client.eval.bind(client),
        sendCommand: async (command: string[]) => {
          if (!mutated) {
            mutated = true
            updates.files.vrm.url = '/uploads/goon_vrms/forged.vrm'
            reset.model.id = 'forged'
          }
          return client.sendCommand(command)
        }
      }, userId, goonId: target.id, updates, compatibilityResetBasis: reset, updatedAt: 'after'
    }))
    expect(mutated).toBe(true)
    expect(stored.files.vrm?.url).toBe('/uploads/goon_vrms/new.vrm')
    expect(stored.compatibility?.tier).toBe('pending')
  })

  it.runIf(REAL_REDIS_LANE)('accepts the bounded maximum Goon-source count and refuses a larger snapshot', async () => {
    const goons = Array.from({ length: MAX_COMPATIBILITY_GOONS }, (_, index) => record(`compat-${index}`, String(index)))
    await seed(goons)
    const started = performance.now()
    const stored = await redis.execute((client) => writeOwnedGoonCompatibilityForClient({
      client, userId, goonId: goons[0].id, basis: basis(goons[0], goons), report, updatedAt: 'after'
    }))
    expect(stored.compatibility?.owner?.contract).toBe('goon-compatibility-owner/v1')
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(30_000)
    console.info(`Compatibility owner checked ${MAX_COMPATIBILITY_GOONS} synthetic Goon sources in ${elapsed.toFixed(1)} ms.`)
    expect(() => basis(goons[0], [...goons, record('overflow', 'overflow')])).toThrow('unavailable')
  }, 45_000)
})

function firstPreparation(status: 'needs_bake' | 'failed' = 'needs_bake', source = firstParty) {
  const goon = structuredClone(source)
  const owner = parseGoonRecipeV2(goon.recipe)
  if (status === 'failed') {
    owner.liveStatus = 'failed'
    owner.pendingJob = { jobId: 'routing-first-bake', jobRef: 'goon_recipe_job:routing-user:routing-goon:routing-first-bake',
      status: 'failed', operation: 'first-bake', targetWriteVersion: owner.writeVersion,
      targetRecipeRevision: owner.authoringRevision.recipeRevision, targetRevisionId: owner.authoringRevision.revisionId }
    owner.lastFailure = { stage: 'baking', reason: 'First bake failed', reportRef: null }
  }
  goon.recipe = parseGoonRecipeV2(owner)
  return goon
}

const routingChanges = [{ kind: 'vrm' }, { sourceProfile: 'standard-vrm' }, { sourceProfile: 'guided-custom-vrm' }]
const initialStatuses = ['needs_bake', 'failed'] as const

function ordinaryRecord(recipe: GoonRecord['recipe']): GoonRecord {
  return { ...structuredClone(firstParty), kind: 'vrm', sourceProfile: 'standard-vrm', recipe }
}

function ordinaryRecipeOwners(): GoonRecord['recipe'][] {
  const independent = firstPreparation().recipe!
  if (independent.contract !== 'goon-recipe/v2') throw new Error('Expected v2 fixture')
  independent.authoringRevision.source.identities.baseId = 'independent-avatar'
  independent.authoringRevision.source.identities.fitFamily = 'independent-avatar'
  const differentFamily = firstPreparation('needs_bake', maleFirstParty).recipe!
  if (differentFamily.contract !== 'goon-recipe/v2') throw new Error('Expected v2 fixture')
  differentFamily.authoringRevision.source.identities.fitFamily = 'independent-fit-family'
  // These raw stored shapes deliberately have no exact Source pair. Their
  // unrelated routing behavior must not become a new malformed-record lock.
  return [undefined, null, { contract: 'goon-recipe/v1' } as GoonRecord['recipe'], independent, differentFamily,
    ...[null, false, 1, 'invalid', [], { source: null }, { source: [] },
      { source: { identities: null } }, { source: { identities: false } },
      { source: { identities: 'invalid' } }, { source: { identities: [] } },
      { source: { identities: { baseId: 'batshit-base-m-v1' } } }
    ].map(authoringRevision => ({ contract: 'goon-recipe/v2', authoringRevision }) as unknown as GoonRecord['recipe'])]
}

describe('atomic Goon mutation repository', () => {
  useRedisTestServer()

  it.each(initialStatuses)('blocks routing changes while the first-party first bake is %s', (status) => {
    const current = firstPreparation(status)
    const before = structuredClone(current)
    expect(isGoonRuntimeReady(current)).toBe(false)
    for (const changes of routingChanges) {
      if ('sourceProfile' in changes) {
        // The durable Source now keeps readiness closed even if an invalid
        // routing change is projected; the mutation must also refuse it.
        expect(isGoonRuntimeReady({ ...current, ...changes } as GoonRecord)).toBe(false)
      }
      expect(() => assertGenericGoonPatchAllowed(current, changes)).toThrowError(
        expect.objectContaining({ code: 'RECIPE_SOURCE_ROUTING', status: 409 }))
    }
    expect(current).toEqual(before)
    expect(resolveRecipeProductReadiness(current)).toBe(status === 'failed' ? 'failed' : 'preparing')
  })

  it('allows same-value routing echoes without changing the Source or readiness', () => {
    for (const status of initialStatuses) {
      const current = firstPreparation(status)
      expect(() => assertGenericGoonPatchAllowed(current, {
        kind: current.kind, sourceProfile: current.sourceProfile, name: 'Renamed'
      })).not.toThrow()
      expect(isGoonRuntimeReady(current)).toBe(false)
    }
  })

  it.each(initialStatuses)('protects the recognized male Source while first preparation is %s', (status) => {
    const current = firstPreparation(status, maleFirstParty)
    const before = structuredClone(current)
    expect(isRecipePreparationRequired(current)).toBe(true)
    expect(resolveRecipeProductReadiness(current)).toBe(status === 'failed' ? 'failed' : 'preparing')
    for (const changes of routingChanges) {
      expect(() => assertGenericGoonPatchAllowed(current, changes)).toThrowError(
        expect.objectContaining({ code: 'RECIPE_SOURCE_ROUTING', status: 409 }))
    }
    expect(() => assertGenericGoonPatchAllowed(current, {
      kind: current.kind, sourceProfile: current.sourceProfile, name: 'Renamed'
    })).not.toThrow()
    expect(current).toEqual(before)
  })

  it('classifies from the stored Source pair rather than a cached or caller-authored summary', () => {
    const current = firstPreparation()
    current.customAvatar!.manifestSummary = { baseId: 'independent-avatar', recipeReady: false }
    expect(() => assertGenericGoonPatchAllowed(current, { sourceProfile: 'standard-vrm' })).toThrowError(
      expect.objectContaining({ code: 'RECIPE_SOURCE_ROUTING' }))
    const independent = firstPreparation()
    if (independent.recipe?.contract !== 'goon-recipe/v2') throw new Error('Expected v2 fixture')
    independent.recipe.authoringRevision.source.identities.baseId = 'independent-avatar'
    independent.recipe.authoringRevision.source.identities.fitFamily = 'independent-avatar'
    // Its summary still says first-party; this cannot grant the new restriction.
    expect(() => assertGenericGoonPatchAllowed(independent, { sourceProfile: 'standard-vrm' })).not.toThrow()
    const differentFamily = firstPreparation()
    if (differentFamily.recipe?.contract !== 'goon-recipe/v2') throw new Error('Expected v2 fixture')
    differentFamily.recipe.authoringRevision.source.identities.fitFamily = 'independent-fit-family'
    expect(() => assertGenericGoonPatchAllowed(differentFamily, { kind: 'vrm' })).not.toThrow()
    const male = firstPreparation('needs_bake', maleFirstParty)
    male.customAvatar!.manifestSummary = { baseId: 'independent-avatar', recipeReady: false }
    expect(() => assertGenericGoonPatchAllowed(male, {
      kind: 'vrm', baseId: 'independent-avatar', manifestSummary: { recipeReady: false }
    })).toThrowError(expect.objectContaining({ code: 'RECIPE_SOURCE_ROUTING' }))
    independent.customAvatar!.manifestSummary = { baseId: 'batshit-base-m-v1', recipeReady: true }
    expect(() => assertGenericGoonPatchAllowed(independent, { sourceProfile: 'standard-vrm' })).not.toThrow()
    male.customAvatar!.manifestSummary = { baseId: 'batshit-base-m-v1', recipeReady: true }
    expect(isRecipePreparationRequired(male)).toBe(true)
  })

  it('preserves ordinary and malformed-owner routing when no exact Source pair exists', () => {
    for (const recipe of ordinaryRecipeOwners()) {
      expect(() => assertGenericGoonPatchAllowed(ordinaryRecord(recipe), {
        kind: 'custom', sourceProfile: 'expert-custom-glb'
      })).not.toThrow()
    }
  })

  it('keeps a pending first-party upload and its readiness summary under the Source owner', () => {
    for (const source of [firstParty, maleFirstParty]) {
      const pending = structuredClone(source)
      delete pending.recipe
      // Male records imported before the new file-service gate carry false;
      // they must remain unavailable until the Source has been verified.
      pending.customAvatar!.manifestSummary = { baseId: source === firstParty ? 'batshit-base-f-v1' : 'batshit-base-m-v1', recipeReady: source === firstParty }
      const falseSummary = { ...pending.customAvatar!, manifestSummary: { baseId: 'independent-avatar', recipeReady: false } }
      expect(() => assertGenericGoonPatchAllowed(pending, { customAvatar: falseSummary }))
        .toThrowError(expect.objectContaining({ code: 'RECIPE_MANAGED_FIELD' }))
      for (const change of routingChanges) {
        expect(() => assertGenericGoonPatchAllowed(pending, change))
          .toThrowError(expect.objectContaining({ code: 'RECIPE_SOURCE_ROUTING' }))
      }
      expect(() => assertGenericGoonPatchAllowed(pending, { name: 'Renamed', kind: pending.kind }))
        .not.toThrow()
    }
    const independent = ordinaryRecord(undefined)
    expect(() => assertGenericGoonPatchAllowed(independent, {
      customAvatar: { package: { filename: 'forged.bgoon', url: '/uploads/goon_custom_packages/forged.bgoon' },
        manifestSummary: { baseId: 'batshit-base-m-v1', recipeReady: false } }
    })).toThrowError(expect.objectContaining({ code: 'RECIPE_MANAGED_FIELD' }))
  })

  it.runIf(REAL_REDIS_LANE)('rechecks a first-party upload after a generic update preflight', async () => {
    for (const source of [firstParty, maleFirstParty]) {
      const pending = structuredClone(source)
      delete pending.recipe
      pending.customAvatar!.manifestSummary = { baseId: source === firstParty ? 'batshit-base-f-v1' : 'batshit-base-m-v1',
        recipeReady: source === firstParty }
      for (const [changes, code] of [
        [{ name: 'Must not save', sourceProfile: 'standard-vrm' }, 'RECIPE_SOURCE_ROUTING'],
        [{ name: 'Must not save', customAvatar: { manifestSummary: { recipeReady: false } } }, 'RECIPE_MANAGED_FIELD']
      ] as const) {
        const before = ordinaryRecord(undefined)
        assertGenericGoonPatchAllowed(before, changes)
        await redis.json.set('goon:routing-goon', '$', before)
        await expect(redis.execute(client => patchOwnedGoonForClient({
          client: new Proxy(client, { get(object, property) {
            if (property === 'eval') return async (script: string, args: unknown) => {
              await client.json.set('goon:routing-goon', '$', pending)
              return client.eval(script, args as never)
            }
            const item = Reflect.get(object, property)
            return typeof item === 'function' ? item.bind(object) : item
          } }), userId: pending.user_id, goonId: pending.id, updates: changes, updatedAt: 'after'
        }))).rejects.toMatchObject({ code })
        expect(await redis.json.get('goon:routing-goon')).toEqual(pending)
      }
    }
  })

  it.each(initialStatuses)('refuses an actual generic PUT bypass while the first bake is %s', async (status) => {
    for (const source of [firstParty, maleFirstParty]) {
      const current = firstPreparation(status, source)
      await redis.json.set('goon:routing-goon', '$', current)
      const { PUT } = await import('../../../../routes/api/goons/[id]/+server')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        for (const changes of routingChanges) {
          const response = await PUT({ params: { id: current.id }, locals: { user: { id: current.user_id } },
            request: new Request('http://test.local/api/goons/routing-goon', { method: 'PUT',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Must not partially save', ...changes }) }) } as any)
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ code: 'RECIPE_SOURCE_ROUTING' })
          expect(await redis.json.get('goon:routing-goon')).toEqual(current)
        }
      } finally { log.mockRestore() }
    }
  })

  it.runIf(REAL_REDIS_LANE)('guards actual final EVAL routing writes and permits exact echoes', async () => {
    for (const source of [firstParty, maleFirstParty]) {
      for (const status of initialStatuses) {
        const current = firstPreparation(status, source)
        await redis.json.set('goon:routing-goon', '$', current)
        for (const changes of routingChanges) {
          await expect(redis.execute(client => patchOwnedGoonForClient({ client, userId: current.user_id,
            goonId: current.id, updates: { name: 'Must not partially save', ...changes }, updatedAt: 'after' })))
            .rejects.toMatchObject({ code: 'RECIPE_SOURCE_ROUTING', status: 409 })
          expect(await redis.json.get('goon:routing-goon')).toEqual(current)
        }
        const renamed = await redis.execute(client => patchOwnedGoonForClient({ client, userId: current.user_id,
          goonId: current.id, updates: { kind: current.kind, sourceProfile: current.sourceProfile, name: 'After' }, updatedAt: 'after' }))
        expect(renamed).toMatchObject({ name: 'After', kind: current.kind, sourceProfile: current.sourceProfile })
        expect(renamed.recipe).toEqual(current.recipe)
        expect(isRecipePreparationRequired(renamed)).toBe(true)
        expect(isGoonRuntimeReady(renamed)).toBe(false)
      }
    }
  })

  it.runIf(REAL_REDIS_LANE)('rechecks the stored Source pair after bootstrap races a generic preflight', async () => {
    for (const source of [firstParty, maleFirstParty]) {
      const before = ordinaryRecord(undefined)
      const changes = { name: 'Must not partially save', sourceProfile: 'guided-custom-vrm' }
      assertGenericGoonPatchAllowed(before, changes)
      await redis.json.set('goon:routing-goon', '$', before)
      const initialized = firstPreparation('needs_bake', source)
      let raced = false
      await expect(redis.execute(client => patchOwnedGoonForClient({
        client: new Proxy(client, { get(object, property) {
          if (property === 'eval') return async (script: string, args: unknown) => {
            // The route has already admitted an ordinary record; first preparation
            // publishes its authoritative Source before the real final Lua runs.
            await client.json.set('goon:routing-goon', '$', initialized)
            raced = true
            return client.eval(script, args as never)
          }
          const item = Reflect.get(object, property)
          return typeof item === 'function' ? item.bind(object) : item
        } }), userId: initialized.user_id, goonId: initialized.id,
        updates: changes, updatedAt: 'after'
      }))).rejects.toMatchObject({ code: 'RECIPE_SOURCE_ROUTING', status: 409 })
      expect(raced).toBe(true)
      expect(await redis.json.get('goon:routing-goon')).toEqual(initialized)
      expect(isRecipePreparationRequired(initialized)).toBe(true)
      expect(isGoonRuntimeReady(initialized)).toBe(false)
    }
  })

  it.runIf(REAL_REDIS_LANE)('keeps ordinary and malformed-owner final writes working without an exact Source pair', async () => {
    for (const recipe of ordinaryRecipeOwners()) {
      const before = ordinaryRecord(recipe)
      await redis.json.set('goon:routing-goon', '$', before)
      const updated = await redis.execute(client => patchOwnedGoonForClient({ client, userId: before.user_id,
        goonId: before.id, updates: { name: 'After', kind: 'custom', sourceProfile: 'expert-custom-glb' }, updatedAt: 'after' }))
      expect(updated).toMatchObject({ name: 'After', kind: 'custom', sourceProfile: 'expert-custom-glb' })
      expect(updated.recipe).toEqual(recipe)
    }
  })

  it.each(['anatomyPresence', 'clothingState', 'clothingCloset', 'sphericalEyelid'])('refuses unsupported private field %s before any generic write', async field => {
    const evaluate = vi.fn()
    expect(() => assertGenericGoonPatchAllowed({} as any, { [field]: null })).toThrowError(expect.objectContaining({ code: 'RESERVED_FIELD', status: 400 }))
    await expect(patchOwnedGoonForClient({ client: { eval: evaluate }, userId: 'owner', goonId: 'target', updates: { [field]: null }, updatedAt: 'after' })).rejects.toMatchObject({ code: 'RESERVED_FIELD' })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it.runIf(REAL_REDIS_LANE)('refuses stored held null or false fields before a generic mutation and preserves exact RAW', async () => {
    const key = 'goon:held-current'
    for (const value of [null, false]) for (const held of [
      { anatomyPresence: value }, { clothingState: value }, { clothingCloset: value }, { sphericalEyelid: value },
      { closet: { items: {}, outfits: { kept: { name: 'Public outfit' } }, clothingPresets: value } },
      { recipe: { requiredMotionPreparation: value } }
    ]) {
      const current = { id: 'held-current', user_id: 'atomic-user', name: 'Before', updated_at: 'stamp', ...held }
      await redis.json.set(key, '$', current)
      const before = await redis.execute(client => client.sendCommand(['JSON.GET', key]))
      expect(() => assertGenericGoonPatchAllowed(current as any, { name: 'After' })).toThrowError(expect.objectContaining({ code: 'RESERVED_FIELD' }))
      const evaluate = vi.fn()
      await expect(redis.execute(client => patchOwnedGoonForClient({ client: new Proxy(client, { get(target, property) {
        if (property === 'eval') return evaluate
        const item = Reflect.get(target, property); return typeof item === 'function' ? item.bind(target) : item
      } }), userId: 'atomic-user', goonId: 'held-current', updates: { name: 'After' }, updatedAt: 'after' })))
        .rejects.toMatchObject({ code: 'RESERVED_FIELD', status: 400 })
      expect(evaluate).not.toHaveBeenCalled()
      expect(await redis.execute(client => client.sendCommand(['JSON.GET', key]))).toBe(before)
    }
  })

  it.runIf(REAL_REDIS_LANE)('refuses held fields added after generic preflight in final Lua without replacing the concurrent RAW', async () => {
    const key = 'goon:held-current'
    for (const value of [null, false]) for (const held of [
      { anatomyPresence: value }, { clothingState: value }, { clothingCloset: value }, { sphericalEyelid: value },
      { closet: { items: {}, outfits: { kept: { name: 'Public outfit' } }, clothingPresets: value } },
      { recipe: { requiredMotionPreparation: value } }
    ]) {
      await redis.json.set(key, '$', { id: 'held-current', user_id: 'atomic-user', name: 'Before', updated_at: 'stamp' })
      let concurrentRaw: unknown, reachedFinal = false
      await expect(redis.execute(client => patchOwnedGoonForClient({ client: new Proxy(client, { get(target, property) {
        if (property === 'eval') return async (script: string, options: any) => {
          reachedFinal = true
          for (const [field, fieldValue] of Object.entries(held)) await target.json.set(key, `$.${field}`, fieldValue as any)
          concurrentRaw = await target.sendCommand(['JSON.GET', key])
          return target.eval(script, options)
        }
        const item = Reflect.get(target, property); return typeof item === 'function' ? item.bind(target) : item
      } }), userId: 'atomic-user', goonId: 'held-current', updates: { name: 'After' }, updatedAt: 'after' })))
        .rejects.toMatchObject({ code: 'RESERVED_FIELD', status: 400 })
      expect(reachedFinal).toBe(true)
      expect(await redis.execute(client => client.sendCommand(['JSON.GET', key]))).toBe(concurrentRaw)
    }
  })

  it.runIf(REAL_REDIS_LANE)('keeps public manual closet.outfits writable and rejects only new nested Clothing presets', async () => {
    const key = 'goon:manual-public', outfits = { kept: { name: 'Public outfit', assignments: {} } }
    const current = { id: 'manual-public', user_id: 'atomic-user', name: 'Before', updated_at: 'stamp',
      closet: { items: {}, outfits }, independentUnknownField: { kept: true } }
    await redis.json.set(key, '$', current)
    const stored = await redis.execute(client => patchOwnedGoonForClient({ client, userId: 'atomic-user', goonId: current.id,
      updates: { name: 'After', closet: { items: {}, outfits } }, updatedAt: 'after' }))
    expect(stored).toMatchObject({ name: 'After', closet: { outfits }, independentUnknownField: { kept: true } })
    for (const value of [null, false]) {
      const before = await redis.execute(client => client.sendCommand(['JSON.GET', key]))
      await expect(redis.execute(client => patchOwnedGoonForClient({ client, userId: 'atomic-user', goonId: current.id,
        updates: { closet: { items: {}, outfits, clothingPresets: value } }, updatedAt: 'rejected' })))
        .rejects.toMatchObject({ code: 'RESERVED_FIELD' })
      // Direct final-EVAL invocation also refuses the unsupported nested field.
      await expect(redis.execute(async client => {
        let captured!: { script: string; options: any }
        await patchOwnedGoonForClient({ client: new Proxy(client, { get(target, property) {
          if (property === 'eval') return async (script: string, options: any) => { captured = { script, options }; return target.eval(script, options) }
          const item = Reflect.get(target, property); return typeof item === 'function' ? item.bind(target) : item
        } }), userId: 'atomic-user', goonId: current.id, updates: { closet: { items: {}, outfits } }, updatedAt: 'after' })
        captured.options.arguments[4] = JSON.stringify({ items: {}, outfits, clothingPresets: value })
        expect(await client.eval(captured.script, captured.options)).toBe('RESERVED_FIELD')
      })).resolves.toBeUndefined()
      expect(await redis.execute(client => client.sendCommand(['JSON.GET', key]))).toBe(before)
    }
  })

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
