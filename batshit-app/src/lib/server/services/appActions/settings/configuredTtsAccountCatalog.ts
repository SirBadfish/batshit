import { createHash } from 'node:crypto'
import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import { readFishConfiguredAccountVoicePage } from '$lib/server/services/voiceService'
import { isCanonicalAgentId } from '$lib/utils/agentId'
import { validTtsId, type ConfiguredFishAccountPage, type ConfiguredTtsAccountReadFailure } from '$lib/appActions/settings/configuredTtsPreferences'
import type { AdapterContext } from '../managementTypes'
import { AppActionsManagementRefusal } from './authority'
import { requireSettingsSubjectAdmission } from './managementActor'
import { assertSettingsLifecycle, SettingsLifecycleRefusal, type SettingsLifecycleSnapshot } from './lifecycle'

type Target = Readonly<{
  snapshot: Readonly<{ record: Readonly<{ id?: unknown; user_id?: unknown; agentType?: unknown }>; lifecycle: SettingsLifecycleSnapshot }>
  providers: readonly Readonly<{ id: string; configured: 'yes' | 'no' | 'unknown'; enabled: boolean; supportsTts: boolean; models: readonly string[] }>[]
  checkEnvironment(): void
}>
/** Server-private local basis, never part of the public page or a model-provided grant. */
export type ConfiguredTtsAccountSource = Readonly<{
  providerId: 'fish'; credential: Readonly<{ key: string; path: '$'; raw: string }>
  environmentStamp: string; observedAt: string; modelScope: 'unknown'
}>
export type ConfiguredTtsAccountCatalogRead = Readonly<
  { status: 'listed'; page: ConfiguredFishAccountPage; source: ConfiguredTtsAccountSource } |
  { status: 'unavailable'; reason: ConfiguredTtsAccountReadFailure }
>
const FISH_ENV_NAMES = ['FISH_AUDIO_API_KEY', 'FISH_API_KEY'] as const
function fishEnvironmentStamp(): string {
  const hash = createHash('sha256')
  for (const name of FISH_ENV_NAMES) {
    const value = env[name] ?? null
    if (value !== null && (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 16384)) throw new Error('tts_account_environment_unavailable')
    hash.update(JSON.stringify([name, value]))
  }
  return hash.digest('hex')
}
/** Only the future selected-account branch may add this extra environment assertion. */
export function assertConfiguredTtsAccountEnvironment(source: ConfiguredTtsAccountSource): void {
  if (source.providerId !== 'fish' || fishEnvironmentStamp() !== source.environmentStamp) throw new Error('tts_account_source_changed')
}

class AccountReadFailure extends Error {
  constructor(readonly reason: ConfiguredTtsAccountReadFailure) { super(reason) }
}
type AccountBasis = Readonly<{ credential: Readonly<{ key: string; path: '$'; raw: string }>; environmentStamp: string }>
/** Fixed read-only admission, not a writer or a generic caller-supplied predicate. */
const ACCOUNT_ADMISSION = `-- fixed-a10-fish-account-admission
local now = redis.call('TIME')
if tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000) >= tonumber(ARGV[3]) then return 'EXPIRED' end
local kind = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(kind) ~= 'table' or kind.err or kind[1] ~= 'object' then return 'AUTHORITY_CHANGED' end
for _, pair in ipairs(cjson.decode(ARGV[1])) do
  local raw = redis.pcall('JSON.GET', KEYS[1], pair[1])
  if type(raw) == 'table' or (raw and string.len(raw) > 262144) or (raw or '') ~= pair[2] then return 'AUTHORITY_CHANGED' end
end
local raw = redis.pcall('JSON.GET', KEYS[2], '$')
if type(raw) == 'table' or (raw and string.len(raw) > 16384) or (raw or '[]') ~= ARGV[2] then return 'SOURCE_CHANGED' end
return 'OK'
`
function captureAuthority(ctx: AdapterContext) {
  const { actor, fence } = ctx.admission
  const expected = actor.kind === 'native' ? ['$.id', '$.user_id', '$.agentType', '$.app_action_policy', '$.created_at'] :
    ['$.id', '$.userId', '$.revokedAt', '$.families', '$.authorityGeneration', '$.appActionsGrant']
  const key = actor.kind === 'native' ? `agent:${actor.id}` : `portable_skill_token:${actor.userId}:${actor.id}`
  if (actor.kind !== 'native' && actor.kind !== 'portable' || fence.key !== key || !key.isWellFormed() || Buffer.byteLength(key, 'utf8') > 16384 ||
      !Array.isArray(fence.paths) || fence.paths.length !== expected.length ||
      fence.paths.some((pair, index) => !Array.isArray(pair) || pair.length !== 2 || pair[0] !== expected[index] || typeof pair[1] !== 'string' || !pair[1].isWellFormed() || Buffer.byteLength(pair[1], 'utf8') > 262144) ||
      fence.paths.reduce((bytes, pair) => bytes + Buffer.byteLength(pair[1], 'utf8'), 0) > 524288) {
    throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The current account-read authority is unavailable.', 409)
  }
  if (!fence.lifecycle) throw new AppActionsManagementRefusal('AUTHORITY_LIFECYCLE_REQUIRED', 'Current server authority is unavailable.', 409)
  assertSettingsLifecycle(fence.lifecycle)
  return { key, paths: JSON.stringify(fence.paths.map(([path, raw]) => [path, raw])), lifecycle: fence.lifecycle }
}

type AccountUnavailable = Readonly<{ status: 'unavailable'; reason: ConfiguredTtsAccountReadFailure }>
type AccountControls = Readonly<{
  wait<T>(read: () => Promise<T>): Promise<T>
  assertTarget(): void
  checkBasis(basis: AccountBasis): void
  admit(basis: AccountBasis): Promise<void>
  deadlineAt: number; signal: AbortSignal
}>
/** One fixed owner for both remote reads and LOCAL held-source validation. */
async function withFishAccountContext<Result>(ctx: AdapterContext, target: Target,
  action: (controls: AccountControls) => Promise<Result>): Promise<Result | AccountUnavailable> {
  // The attempt starts at entry, before authority or credential acquisition can wait.
  const deadlineAt = Math.min(ctx.deadlineAt, ctx.admission.expiresAt ?? Infinity, Date.now() + 10_000)
  const timerController = new AbortController()
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timerController.signal]) : timerController.signal
  let onAbort = () => {}
  const ended = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try { ctx.assertCurrent() } catch (error) { reject(error); return }
      reject(new AccountReadFailure(ctx.signal?.aborted ? 'list_stopped' : 'list_timeout'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  void ended.catch(() => {})
  const timer = setTimeout(() => timerController.abort(), Math.max(0, deadlineAt - Date.now()))
  const record = target.snapshot.record
  function assertAttempt() {
    ctx.assertCurrent()
    if (signal.aborted || !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) throw new AccountReadFailure(ctx.signal?.aborted ? 'list_stopped' : 'list_timeout')
  }
  async function wait<T>(read: () => Promise<T>): Promise<T> {
    assertAttempt()
    const result = await Promise.race([read(), ended])
    assertAttempt()
    return result
  }
  function assertTarget() {
    assertAttempt()
    if (typeof record.id !== 'string' || !isCanonicalAgentId(record.id) || record.user_id !== ctx.admission.actor.userId || record.agentType !== 'api') {
      throw new AppActionsManagementRefusal('TTS_SUBJECT_UNAVAILABLE', 'This reply-voice subject is unavailable.', 409)
    }
    requireSettingsSubjectAdmission(ctx.admission, { kind: 'primary', id: record.id })
    assertSettingsLifecycle(target.snapshot.lifecycle)
    target.checkEnvironment()
  }
  try {
    assertTarget()
    const authority = captureAuthority(ctx)
    let finalBasis: AccountBasis | undefined
    function checkBasis(basis: AccountBasis) {
      assertTarget(); assertSettingsLifecycle(authority.lifecycle)
      if (basis.credential.key !== apiKeyService.storedKeyName('fish', ctx.admission.actor.userId) || basis.credential.path !== '$' ||
          !basis.credential.key.isWellFormed() || Buffer.byteLength(basis.credential.key, 'utf8') > 16384 || typeof basis.credential.raw !== 'string' ||
          !basis.credential.raw.isWellFormed() || Buffer.byteLength(basis.credential.raw, 'utf8') > 16384 || !/^[a-f0-9]{64}$/.test(basis.environmentStamp)) throw new AccountReadFailure('source_changed')
      if (fishEnvironmentStamp() !== basis.environmentStamp) throw new AccountReadFailure('source_changed')
    }
    async function admit(basis: AccountBasis) {
      checkBasis(basis)
      const answer = await wait(() => redis.execute(client => {
        // A late pool acquisition must not issue even this read after the attempt ends.
        checkBasis(basis)
        return client.eval(ACCOUNT_ADMISSION, { keys: [authority.key, basis.credential.key], arguments: [authority.paths, basis.credential.raw, String(deadlineAt)] })
      }))
      checkBasis(basis)
      if (answer === 'EXPIRED') throw new AccountReadFailure('list_timeout')
      if (answer === 'SOURCE_CHANGED') throw new AccountReadFailure('source_changed')
      if (answer === 'AUTHORITY_CHANGED') throw new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'The captured account-read authority changed.', 409)
      if (answer !== 'OK') throw new AppActionsManagementRefusal('TTS_ACCOUNT_SOURCE_UNAVAILABLE', 'The account-read source is unavailable.', 409)
      finalBasis = basis
    }
    const result = await wait(() => action({ wait, assertTarget, checkBasis, admit, deadlineAt, signal }))
    // The action's async return is another handoff boundary; only synchronous checks follow.
    if (finalBasis) checkBasis(finalBasis)
    assertTarget()
    return result
  } catch (error) {
    if (error instanceof AppActionsManagementRefusal || error instanceof SettingsLifecycleRefusal) throw error
    try { ctx.assertCurrent() } catch (current) {
      if (current instanceof AppActionsManagementRefusal || current instanceof SettingsLifecycleRefusal) throw current
      return { status: 'unavailable', reason: 'list_unavailable' }
    }
    return { status: 'unavailable', reason: error instanceof AccountReadFailure ? error.reason : 'list_unavailable' }
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort)
  }
}

/** Private server-held evidence only. This performs ONE LOCAL read; it never lists a provider. */
export async function checkConfiguredTtsAccountSource(ctx: AdapterContext, target: Target, source: ConfiguredTtsAccountSource):
  Promise<Readonly<{ status: 'current' }> | AccountUnavailable> {
  return withFishAccountContext(ctx, target, async ({ admit, checkBasis }) => {
    if (source.providerId !== 'fish') throw new AccountReadFailure('source_changed')
    await admit(source)
    checkBasis(source)
    return { status: 'current' as const }
  })
}

/** ONE explicitly requested workspace page. The writer only consumes held observations. */
export async function readConfiguredTtsAccountCatalog(ctx: AdapterContext, target: Target,
  request: Readonly<{ providerId: 'fish'; page: number; modelId: string | null }>, expectedSource?: ConfiguredTtsAccountSource): Promise<ConfiguredTtsAccountCatalogRead> {
  const { providerId, page, modelId } = request
  // This basis comes only from the private ticket. Capture it before any await;
  // admission must fence the same source whose actual value is consumed below.
  const expected = expectedSource && Object.freeze({ providerId: expectedSource.providerId, environmentStamp: expectedSource.environmentStamp,
    credential: Object.freeze({ ...expectedSource.credential }) })
  return withFishAccountContext(ctx, target, async ({ wait, assertTarget, checkBasis, admit, deadlineAt, signal }): Promise<ConfiguredTtsAccountCatalogRead> => {
    await wait(() => ctx.refreshAuthority()); assertTarget()
    if (providerId !== 'fish') return { status: 'unavailable', reason: 'unsupported_catalog' }
    const provider = target.providers.find(item => item.id === 'fish')
    if (!provider || provider.configured !== 'yes' || !provider.enabled || !provider.supportsTts) return { status: 'unavailable', reason: 'not_configured' }
    if (!Number.isInteger(page) || page < 1 || page > 10 || modelId !== null && (!validTtsId(modelId) || !provider.models.includes(modelId))) {
      return { status: 'unavailable', reason: 'invalid_payload' }
    }
    const captured: { basis?: AccountBasis } = {}
    let read: Awaited<ReturnType<typeof readFishConfiguredAccountVoicePage>>
    try {
      read = await wait(() => apiKeyService.withConfiguredValue('fish', ctx.admission.actor.userId, async saved => {
        assertTarget()
        if (saved.key !== apiKeyService.storedKeyName('fish', ctx.admission.actor.userId) || !saved.key.isWellFormed() || Buffer.byteLength(saved.key, 'utf8') > 16384 ||
            typeof saved.raw !== 'string' || !saved.raw.isWellFormed() || Buffer.byteLength(saved.raw, 'utf8') > 16384) {
          throw new AccountReadFailure('credential_unreadable')
        }
        const basis: AccountBasis = Object.freeze({ credential: Object.freeze({ key: saved.key, path: '$', raw: saved.raw }), environmentStamp: fishEnvironmentStamp() })
        if (expected && (expected.providerId !== 'fish' || expected.credential.key !== basis.credential.key || expected.credential.path !== basis.credential.path ||
            expected.credential.raw !== basis.credential.raw || expected.environmentStamp !== basis.environmentStamp)) throw new AccountReadFailure('source_changed')
        captured.basis = basis
        // Exact existing Voice precedence: truthy saved value, then the two ordered env names.
        const value = saved.state === 'readable' && saved.value ? saved.value : FISH_ENV_NAMES.map(name => env[name]).find(Boolean)
        await wait(() => ctx.refreshAuthority())
        await admit(basis)
        if (!value) return { status: 'unavailable', reason: saved.state === 'unreadable' ? 'credential_unreadable' : 'not_configured' } as const
        // No independent awaited authority/key read between coherent admission and issue.
        return wait(() => {
          checkBasis(basis)
          return readFishConfiguredAccountVoicePage({ apiKey: value, page, deadlineAt, signal })
        })
      }))
    } catch (error) {
      if (error instanceof AccountReadFailure && error.reason !== 'credential_unreadable' || error instanceof AppActionsManagementRefusal || error instanceof SettingsLifecycleRefusal) throw error
      read = { status: 'unavailable', reason: 'credential_unreadable' }
    }
    await wait(() => ctx.refreshAuthority())
    const basis = captured.basis
    if (basis) {
      // LAST await: key and authority must coexist in the same physical read cut.
      await admit(basis)
      checkBasis(basis)
      if (read.status === 'listed') return { status: 'listed', page: read.page, source: Object.freeze({ providerId: 'fish', ...basis,
        observedAt: read.page.observedAt, modelScope: 'unknown' }) }
    }
    assertTarget()
    return read.status === 'listed' ? { status: 'unavailable', reason: 'credential_unreadable' } : read
  })
}
