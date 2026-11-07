// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { apiKeyService } from '$lib/services/apiKey.server'
import { clearRedisTestDatabase, useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { readConfiguredTtsSnapshot } from '$lib/server/configuredTtsGuard'
import { createManagementAdapterContext } from '../adapterContext'
import type { SettingsManagementContext } from '../managementTypes'
import { createPortableSkillToken } from '../../portableSkillTokens'
import { nativePolicyResponse, saveNativePolicy, portableGrantResponse, savePortableGrant } from './authority'
import { admitSettingsManagementActor } from './managementActor'

const fixture = vi.hoisted(() => ({ page: vi.fn() }))
vi.mock('$lib/server/services/voiceService', () => ({ readFishConfiguredAccountVoicePage: (...args: unknown[]) => fixture.page(...args) }))
// Same existing topology isolation as the Settings real-owner tests. This is not native wire/auth proof.
vi.mock('../runtime', () => ({ requireAppActionTopology() {} }))
import { readConfiguredTtsAccountCatalog, checkConfiguredTtsAccountSource } from './configuredTtsAccountCatalog'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const strict = createSettingsRedisAdmission(redis)
const admission = useRedisTestServer({ beforeCleanupAdmission: strict.beforeCleanupAdmission })
afterAll(() => strict.close())
const USER = 'a10_account_catalog_user', ACTOR = 'a10_account_actor', TARGET = 'a10_account_target'
const KEY = apiKeyService.storedKeyName('fish', USER)
const request = { providerId: 'fish' as const, page: 1, modelId: null }

async function setup(lane: 'native' | 'portable', onRefresh?: (count: number, authorityKey: string) => Promise<void>) {
  admission.requireAdmission()
  await redis.createAgent({ id: ACTOR, user_id: USER, agentType: 'api', displayName: 'Owned catalog actor', created_at: '2026-10-18' })
  await redis.createAgent({ id: TARGET, user_id: USER, agentType: 'api', displayName: 'Owned catalog target', created_at: '2026-10-18' })
  await apiKeyService.store('fish', 'a10-fish-synthetic-key-1234567890', USER)
  const policy = { ...defaultAppActionsPolicy(lane === 'portable'), enabled: true,
    scope: { mode: 'selected' as const, subjects: [{ kind: 'primary' as const, id: TARGET }], except: [] } }
  const controller = new AbortController()
  let ownerContext: SettingsManagementContext
  if (lane === 'native') {
    const before = await nativePolicyResponse(USER, ACTOR)
    await saveNativePolicy(USER, ACTOR, { expectedGeneration: before.generation, expectedSubjectRevision: before.subjectRevision, policy })
    ownerContext = { userId: USER, agentId: ACTOR, sessionId: 'owned_catalog_session', actorType: 'in-process', abortSignal: controller.signal }
  } else {
    const created = await createPortableSkillToken({ userId: USER, families: ['app-actions'] })
    const before = await portableGrantResponse(USER, created.record.id)
    const saved = await savePortableGrant(USER, created.record.id, { expectedAuthorityGeneration: before.authorityGeneration,
      grant: { policy, expiresAt: new Date(Date.now() + 60_000).toISOString() } })
    ownerContext = { userId: USER, actorType: 'portable-skill', portableSettingsActor: { tokenId: created.record.id, authorityGeneration: saved.authorityGeneration } }
  }
  const admitted = await admitSettingsManagementActor(ownerContext, lane)
  const base = createManagementAdapterContext(admitted, () => ownerContext, Date.now() + 30_000)
  let refreshes = 0
  const ctx = { ...base, async refreshAuthority() { await base.refreshAuthority(); await onRefresh?.(++refreshes, admitted.fence.key) } }
  const snapshot = await redis.execute(client => readConfiguredTtsSnapshot(client, TARGET))
  const target = { snapshot, providers: [{ id: 'fish', configured: 'yes' as const, enabled: true, supportsTts: true,
    models: ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1'] }], checkEnvironment() {} }
  return { ctx, target, authorityKey: admitted.fence.key }
}

describe.runIf(REAL)('A10 Fish catalog read-only coherent admission on actual RedisJSON', () => {
  beforeEach(() => {
    fixture.page.mockReset().mockResolvedValue({ status: 'listed', page: {
      providerId: 'fish', extent: 'credential-workspace', observedAt: '2026-10-18T12:00:00.000Z', page: 1, pageSize: 100,
      choices: [], rawCount: 0, filteredCount: 0, rejectedCount: 0, reportedTotal: 0, totalExact: true,
      windowLimited: false, accessibleUpperBound: null, maxOffset: null, hasMore: false, nextPage: null, limitReached: false
    } })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    if (admission.isAdmitted()) await redis.execute(client => clearRedisTestDatabase(client))
  })
  it.each(['native', 'portable'] as const)('matches the actual %s fence and key without mutating any fixture', async lane => {
    const f = await setup(lane)
    const keys = [f.authorityKey, KEY, `agent:${TARGET}`]
    const before = await Promise.all(keys.map(key => redis.json.getRaw(key, '$')))
    expect((await readConfiguredTtsAccountCatalog(f.ctx, f.target, request)).status).toBe('listed')
    expect(await Promise.all(keys.map(key => redis.json.getRaw(key, '$')))).toEqual(before)
    expect(fixture.page).toHaveBeenCalledTimes(1)
  })
  it.each(['native', 'portable'] as const)('checks a held %s source locally and refuses key rotation without another provider page', async lane => {
    const f = await setup(lane), read = await readConfiguredTtsAccountCatalog(f.ctx, f.target, request)
    if (read.status !== 'listed') throw new Error('Expected owned source')
    expect(await checkConfiguredTtsAccountSource(f.ctx, f.target, read.source)).toEqual({ status: 'current' })
    await apiKeyService.store('fish', 'a10-fish-rotated-key-1234567890', USER)
    expect(await checkConfiguredTtsAccountSource(f.ctx, f.target, read.source)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.page).toHaveBeenCalledTimes(1)
  })
  it.each(['native', 'portable'] as const)('BL-1709 refuses a %s cursor replacement key before any replacement-account request', async lane => {
    const f = await setup(lane), first = await readConfiguredTtsAccountCatalog(f.ctx, f.target, request)
    if (first.status !== 'listed') throw new Error('Expected owned source')
    await apiKeyService.store('fish', 'a10-fish-replacement-account-1234567890', USER)
    expect(await readConfiguredTtsAccountCatalog(f.ctx, f.target, { ...request, page: 2 }, first.source)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.page).toHaveBeenCalledTimes(1)
  })
  it.each(['native', 'portable'] as const)('BL-1704 catches saved-key rotation during the final %s authority refresh', async lane => {
    const f = await setup(lane, async count => {
      if (count === 3) await apiKeyService.store('fish', 'a10-fish-rotated-key-1234567890', USER)
    })
    expect(await readConfiguredTtsAccountCatalog(f.ctx, f.target, request)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.page).toHaveBeenCalledTimes(1)
  })
  it('catches authority rotation in the same actual final admission that compares the key', async () => {
    const f = await setup('portable', async (count, authorityKey) => {
      if (count === 3) await redis.json.set(authorityKey, '$.authorityGeneration', 99)
    })
    await expect(readConfiguredTtsAccountCatalog(f.ctx, f.target, request)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' })
    expect(fixture.page).toHaveBeenCalledTimes(1)
  })
  it.each(['oversized', 'wrong-type'] as const)('refuses a %s credential source in actual Lua with no raw-data handoff', async kind => {
    const f = await setup('portable', async count => {
      if (count !== 3) return
      if (kind === 'oversized') await redis.json.set(KEY, '$', { encrypted: 'x'.repeat(16385), iv: 'invalid', authTag: 'invalid' })
      else { await redis.del(KEY); await redis.execute(client => client.set(KEY, 'owned-non-json-fixture')) }
    })
    expect(await readConfiguredTtsAccountCatalog(f.ctx, f.target, request)).toEqual({ status: 'unavailable', reason: 'source_changed' })
  })
  it('uses Redis TIME to refuse an expired physical read before the mocked provider starts', async () => {
    const f = await setup('portable')
    const client = await redis.execute(current => current), actual = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementation((script, options) => {
      if (typeof script === 'string' && script.startsWith('-- fixed-a10-fish-account-admission')) {
        const args = [...(options?.arguments ?? [])]; args[2] = '0'
        return actual(script, { ...options, arguments: args })
      }
      return actual(script, options)
    })
    try {
      expect(await readConfiguredTtsAccountCatalog(f.ctx, f.target, request)).toEqual({ status: 'unavailable', reason: 'list_timeout' })
      expect(fixture.page).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
