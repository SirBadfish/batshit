import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import type { ConfiguredFishAccountPage, ConfiguredFishAccountReportPage, ConfiguredTtsSelection } from '$lib/appActions/settings/configuredTtsPreferences'
import type { SettingsManagementAdmission, SettingsManagementContext } from '../managementTypes'
import type { ConfiguredTtsTarget } from './configuredTtsSources'
const boundary = vi.hoisted(() => ({ admit: vi.fn(), refresh: vi.fn(), read: vi.fn(), check: vi.fn(), environment: vi.fn(), publish: vi.fn() }))
vi.mock('./managementActor', async original => ({ ...await original<typeof import('./managementActor')>(),
  admitSettingsManagementActor: (...args: unknown[]) => boundary.admit(...args), refreshSettingsOperationAuthority: (...args: unknown[]) => boundary.refresh(...args) }))
vi.mock('./configuredTtsAccountCatalog', () => ({ readConfiguredTtsAccountCatalog: (...args: unknown[]) => boundary.read(...args),
  checkConfiguredTtsAccountSource: (...args: unknown[]) => boundary.check(...args), assertConfiguredTtsAccountEnvironment: (...args: unknown[]) => boundary.environment(...args) }))
vi.mock('../runtime', () => ({ requireAppActionTopology() {} }))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: (...args: unknown[]) => boundary.publish(...args) }))
import { createSettingsManagementReports } from './managementReports'
import { createSettingsOperationRegistry } from './operationRegistry'
import { createSettingsChanges } from './changeOperations'
import { AppActionsManagementRefusal } from './authority'
import { nativeSettingsSignal } from './managementActor'
import { captureSettingsLifecycle } from './lifecycle'
import { SETTINGS_SNAPSHOT_PATHS, type ConditionalSettingsStore } from './conditionalAgentSettings'
import { CONFIGURED_TTS_READ_PATHS, configuredTtsSnapshotFromDetail, ConfiguredTtsSaveUnconfirmedError } from '$lib/server/configuredTtsGuard'
import { redis } from '$lib/server/redis'

const USER = 'a10_report_owner', ID = 'a10_report_target', KEY = `api_keys:${USER}:fish`, RAW = '[{"encrypted":"SYNTHETIC_PRIVATE_CREDENTIAL"}]'
const subject = { kind: 'primary' as const, id: ID }, inherited: ConfiguredTtsSelection = { providerId: null, modelId: null, voiceId: null, profileId: null }
const source = { providerId: 'fish' as const, credential: { key: KEY, path: '$' as const, raw: RAW }, environmentStamp: 'a'.repeat(64), observedAt: '2026-10-18T12:00:00.000Z', modelScope: 'unknown' as const }
const query = { targets: { subjects: [subject] }, focus: ['agent.voice.tts-selection'], detail: 'choices', query: { ttsCatalog: 'account', ttsProviderId: 'fish' } }
let admission: SettingsManagementAdmission, stopped: AbortController, selected: ConfiguredTtsSelection, environmentChanged: boolean, failedReadback: boolean
function record() { return { id: ID, user_id: USER, agentType: 'api', created_at: '2026-10-18', displayName: 'Owned', voice_profile: { tts: { ...selected }, stt: { providerId: 'browser' }, future: 'KEEP' } } }
function at(value: unknown, path: string) { return path.slice(2).split('.').reduce<unknown>((row, field) => row && typeof row === 'object' ? (row as Record<string, unknown>)[field] : undefined, value) }
function target(): ConfiguredTtsTarget {
  const row = record(), life = captureSettingsLifecycle([`agent:${ID}`])
  const snapshot = configuredTtsSnapshotFromDetail(ID, row, CONFIGURED_TTS_READ_PATHS.map(path => { const value = at(row, path); return value === undefined ? '[]' : JSON.stringify([value]) }), life)
  const profileSource = { profiles: [], count: 0, complete: true, lifecycle: captureSettingsLifecycle([]) }
  const providers: ConfiguredTtsTarget['providers'] = [
    { id: 'fish', label: 'Fish', configured: 'yes', enabled: true, supportsTts: true, catalog: 'configured-subset', models: ['s2.1-pro', 's1'], voices: [], defaultModel: 's2.1-pro', defaultVoice: null, guards: [{ key: KEY, path: '$', raw: RAW }] },
    { id: 'browser', label: 'Browser', configured: 'yes', enabled: true, supportsTts: true, catalog: 'configured-subset', models: [], voices: ['system'], defaultModel: null, defaultVoice: 'system', guards: [] }
  ]
  const globalSelection = { ...inherited, providerId: 'browser' }, providerId = selected.providerId ?? 'browser'
  return { snapshot, selection: selected, globalSelection, effective: { ...selected, providerId, modelId: selected.modelId ?? (providerId === 'fish' ? 's2.1-pro' : null), voiceId: selected.voiceId ?? 'system' }, locked: false,
    guards: [], profiles: [], choices: selected.providerId && selected.voiceId ? [{ source: 'saved-target', ...selected, providerId: selected.providerId, label: selected.voiceId }] : [],
    sourceLifecycle: life, providers, complete: true, environment: 'e'.repeat(64),
    catalog: { voiceCatalog: { snapshot: null, source: 'bundled', checkedAt: null },
      userId: USER, global: { settings: { tts: { providerId: 'browser' } }, guards: [] }, providers,
      registry: { engines: [], complete: true, guard: { key: `voice_engine_registry:${USER}`, path: '$', fingerprint: 'a'.repeat(40), byteLimit: 262144 } }, profileSource, profileCount: 0, environment: 'e'.repeat(64) },
    checkEnvironment() { if (environmentChanged) throw new Error('SYNTHETIC_PRIVATE_ENV_CHANGED') }
  }
}
function store(): ConditionalSettingsStore {
  return { read: vi.fn(async () => ({ raw: SETTINGS_SNAPSHOT_PATHS.map(path => { const value = at(record(), path); return value === undefined ? '[]' : JSON.stringify([value]) }), incarnationRaw: '["2026-10-18"]', lifecycle: captureSettingsLifecycle([`agent:${ID}`]) })),
    readConfiguredTts: vi.fn(async () => { if (failedReadback) throw new Error('Synthetic readback unavailable'); return target() }), async write() { throw new Error('Scalar writer must not run') } }
}
function context(lane: 'native' | 'portable' = 'portable'): SettingsManagementContext {
  if (lane === 'native') {
    const row = { id: 'actor', user_id: USER, agentType: 'api', app_action_policy: { generation: 1, policy: admission.policy }, created_at: '2026-10-18' }
    admission = { actor: { ...admission.actor, kind: 'native', id: 'actor', sessionId: 'chat' }, policy: admission.policy, signal: stopped.signal,
      fence: { key: 'agent:actor', paths: Object.entries(row).map(([field, value]): [string, string] => [`$.${field}`, JSON.stringify([value])]), lifecycle: captureSettingsLifecycle(['agent:actor']) } }
  }
  return lane === 'native' ? { userId: USER, agentId: 'actor', sessionId: 'chat', actorType: 'in-process', abortSignal: stopped.signal } :
    { userId: USER, actorType: 'portable-skill', portableSettingsActor: { tokenId: 'token', authorityGeneration: 1 } }
}
function page(number: number): ConfiguredFishAccountPage {
  return { providerId: 'fish', extent: 'credential-workspace', observedAt: source.observedAt, page: number, pageSize: 100,
    choices: Array.from({ length: 40 }, (_, index) => ({ source: 'provider-list', providerId: 'fish', voiceId: `voice_${(number - 1) * 40 + index}`, modelId: null, profileId: null, label: `Voice ${index}`, labelTruncated: false, modelScope: 'unknown' })),
    rawCount: 40, filteredCount: 0, rejectedCount: 0, reportedTotal: 80, totalExact: true, windowLimited: false, accessibleUpperBound: null, maxOffset: null, hasMore: number < 2, nextPage: number < 2 ? number + 1 : null, limitReached: false }
}
function account(value: { report: unknown }): ConfiguredFishAccountReportPage {
  if (!value.report || typeof value.report !== 'object' || !('account' in value.report)) throw new Error('Expected account DTO')
  return value.report as ConfiguredFishAccountReportPage
}
beforeEach(() => {
  vi.clearAllMocks(); selected = inherited; environmentChanged = false; failedReadback = false; stopped = new AbortController()
  const policy = defaultAppActionsPolicy(true); policy.enabled = true; policy.scope.subjects = [subject]
  const expiresAt = Date.now() + 60_000, row = { id: 'token', userId: USER, revokedAt: null, families: ['app-actions'], authorityGeneration: 1,
    appActionsGrant: { policy, expiresAt: new Date(expiresAt).toISOString() } }
  admission = { actor: { userId: USER, kind: 'portable', id: 'token', generation: 1, label: 'Owned' }, policy,
    fence: { key: `portable_skill_token:${USER}:token`, paths: Object.entries(row).map(([field, value]): [string, string] => [`$.${field}`, JSON.stringify([value])]), lifecycle: captureSettingsLifecycle([]) }, expiresAt }
  boundary.admit.mockReset().mockImplementation(async ctx => { if (ctx.userId !== USER) throw new AppActionsManagementRefusal('NOT_OWNED', 'Wrong owner.'); return admission })
  boundary.refresh.mockReset().mockResolvedValue(undefined); boundary.environment.mockReset(); boundary.publish.mockReset().mockResolvedValue(undefined)
  boundary.read.mockReset().mockImplementation(async (ctx, _target, request) => { await ctx.refreshAuthority(); ctx.assertCurrent(); return { status: 'listed', source, page: page(request.page) } })
  boundary.check.mockReset().mockImplementation(async ctx => { ctx.assertCurrent(); return { status: 'current' } })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('Fish report/held-selection wiring through existing Settings owners', () => {
  it('keeps default and local choices strictly free of account reads, including ordinary Block metadata', async () => {
    admission.policy.ordinaryChanges = false
    const reports = createSettingsManagementReports('a'.repeat(24), store()), ctx = context()
    await reports.report(ctx, 'portable', { targets: query.targets })
    await reports.report(ctx, 'portable', { ...query, query: { ttsProviderId: 'fish' } })
    expect(boundary.read).not.toHaveBeenCalled(); expect(boundary.check).not.toHaveBeenCalled()
  })
  it('uses one explicit request, bounded DTOs and only issued account positions with singleflight replay', async () => {
    const reports = createSettingsManagementReports('a'.repeat(24), store()), ctx = context()
    const first = await reports.report(ctx, 'portable', query), a = account(first)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(12288)
    expect(a.account.choices).toHaveLength(32); expect(JSON.stringify(first)).not.toMatch(/SYNTHETIC_PRIVATE|api_keys|"credential":|"raw":|endpoint/)
    const middle = await reports.report(ctx, 'portable', { reportId: first.reportId, cursor: a.continuation.nextCursor })
    expect(account(middle).account.choices).toHaveLength(8); expect(boundary.read).toHaveBeenCalledTimes(1)
    const next = account(middle).continuation.nextCursor
    const [b, c] = await Promise.all([reports.report(ctx, 'portable', { reportId: first.reportId, cursor: next }), reports.report(ctx, 'portable', { reportId: first.reportId, cursor: next })])
    expect(account(b)).toEqual(account(c)); expect(boundary.read).toHaveBeenCalledTimes(2)
    await expect(reports.report(ctx, 'portable', { reportId: first.reportId, cursor: `sv1:${a.snapshotId}:999` })).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' })
    const local = await reports.report(ctx, 'portable', { targets: query.targets, focus: query.focus })
    await expect(reports.report(ctx, 'portable', { reportId: local.reportId, cursor: a.continuation.nextCursor })).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' })
    expect(boundary.read).toHaveBeenCalledTimes(2)
  })
  it('suppresses stale/private results after the last local check and retains source failure independently', async () => {
    const reports = createSettingsManagementReports('a'.repeat(24), store()), ctx = context()
    boundary.check.mockImplementationOnce(async adapter => { adapter.assertCurrent(); queueMicrotask(() => { environmentChanged = true }); return { status: 'current' } })
    await expect(reports.report(ctx, 'portable', query)).rejects.toMatchObject({ code: 'REPORT_SUBJECT_CHANGED' })
    environmentChanged = false
    boundary.check.mockResolvedValueOnce({ status: 'unavailable', reason: 'source_changed' })
    const changed = await reports.report(ctx, 'portable', query)
    expect(account(changed).account).toMatchObject({ status: 'unavailable', choices: [], reason: 'source_changed' })
    boundary.check.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_REDIS https://private.invalid'))
    const failure = reports.report(ctx, 'portable', query)
    await expect(failure).rejects.toMatchObject({ code: 'TTS_ACCOUNT_REPORT_UNAVAILABLE' })
    await expect(failure).rejects.not.toThrow(/SYNTHETIC_PRIVATE|private.invalid/)
  })
  it('bounds even initial authority acquisition and prevents a late callback from starting any source read', async () => {
    vi.useFakeTimers()
    let release = () => {}, reached = () => {}
    const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { reached = resolve })
    boundary.admit.mockImplementationOnce(async () => { reached(); await gate; return admission })
    const sourceStore = store(), reports = createSettingsManagementReports('a'.repeat(24), sourceStore)
    const pending = reports.report(context(), 'portable', query)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'OPERATION_ENDED' })
    try { await held; await vi.advanceTimersByTimeAsync(10_000); await rejection; release(); await vi.advanceTimersByTimeAsync(0)
      expect(sourceStore.read).not.toHaveBeenCalled(); expect(boundary.read).not.toHaveBeenCalled()
    } finally { release() }
  })
  it('uses genuine native Stop during an ignored-abort provider wait and emits no late page', async () => {
    let release = () => {}, reached = () => {}
    const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { reached = resolve })
    boundary.read.mockImplementationOnce(async () => { reached(); await gate; return { status: 'listed', source, page: page(1) } })
    const reports = createSettingsManagementReports('a'.repeat(24), store()), ctx = context('native')
    const pending = reports.report(ctx, 'native', query)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'OPERATION_ENDED' })
    try { await held; stopped.abort(); await rejection; release(); await Promise.resolve(); await Promise.resolve(); expect(boundary.read).toHaveBeenCalledTimes(1) }
    finally { release() }
  })
  it('BL-1710 promptly stops the current resumed reply B during LOCAL refresh, with no list/write or late write', async () => {
    vi.useFakeTimers()
    const sourceStore = store(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, sourceStore), ctxA = context('native')
    const first = await reports.report(ctxA, 'native', query), changes = createSettingsChanges(registry, reports, sourceStore)
    const prepared = await changes.prepare(ctxA, 'native', { op: 'change', requestId: `${registry.boot}:stop-current`, reportId: first.reportId,
      semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'voice_1' } })
    const actor = admission.actor
    stopped = new AbortController(); const replyB = stopped, ctxB = context('native')
    let release = () => {}, reached = () => {}, failure: unknown
    const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { reached = resolve })
    boundary.check.mockImplementationOnce(async adapter => {
      adapter.assertCurrent(); reached()
      await new Promise<void>((resolve, reject) => {
        const stop = () => { try { adapter.assertCurrent() } catch (error) { reject(error) } }
        adapter.signal?.addEventListener('abort', stop, { once: true })
        void gate.then(() => { adapter.signal?.removeEventListener('abort', stop); resolve() })
      })
      adapter.assertCurrent(); return { status: 'current' }
    })
    const update = vi.spyOn(redis, 'updateAgent').mockResolvedValue(undefined)
    const pending = registry.validatePending(prepared.operation.operationId, actor, ctxB).catch(error => { failure = error })
    try {
      await held; replyB.abort(); await vi.advanceTimersByTimeAsync(0)
      expect(failure).toMatchObject({ code: 'OPERATION_ENDED' })
      expect(boundary.read).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled()
      release(); await pending; await vi.advanceTimersByTimeAsync(0)
      expect(update).not.toHaveBeenCalled(); expect(boundary.read).toHaveBeenCalledTimes(1)
    } finally { release(); await pending }
  })
  it('BL-1710 ignores retired aborted reply A while live resumed reply B validates and saves', async () => {
    const sourceStore = store(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, sourceStore), ctxA = context('native'), replyA = stopped
    const first = await reports.report(ctxA, 'native', query), changes = createSettingsChanges(registry, reports, sourceStore)
    const prepared = await changes.prepare(ctxA, 'native', { op: 'change', requestId: `${registry.boot}:live-current`, reportId: first.reportId,
      semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'voice_1' } })
    const actor = admission.actor
    stopped = new AbortController(); const replyB = stopped, ctxB = context('native')
    replyA.abort()
    await expect(registry.validatePending(prepared.operation.operationId, actor, ctxB)).resolves.toMatchObject({ status: 'ready' })
    expect(boundary.check.mock.calls.at(-1)?.[0].signal).toBe(replyB.signal)
    const update = vi.spyOn(redis, 'updateAgent').mockImplementation(async (_id, _body, options) => {
      const mutation = options?.configuredTtsMutation
      if (!mutation) throw new Error('Missing typed TTS mutation')
      mutation.check(); selected = { ...mutation.selection }; mutation.onSaved?.()
    })
    expect((await registry.nativeExecute(prepared.operation.operationId, actor, replyB.signal, () => { nativeSettingsSignal(ctxB) })).outcomes[0]).toMatchObject({ saved: 'saved', readback: 'verified' })
    expect(update).toHaveBeenCalledTimes(1); expect(boundary.read).toHaveBeenCalledTimes(1)
  })
  it('selects only held membership with immutable four-row preview/raw key guard and performs no re-list on prepare/issue', async () => {
    const sourceStore = store(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, sourceStore), ctx = context()
    const first = await reports.report(ctx, 'portable', query), changes = createSettingsChanges(registry, reports, sourceStore)
    const input = { op: 'change', requestId: `${registry.boot}:fish`, reportId: first.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'voice_1' } }
    const prepared = await changes.prepare(ctx, 'portable', input)
    expect((await registry.humanReview(USER, prepared.operation.operationId)).preview.targets[0].changes.map(row => row.field)).toEqual(['providerId', 'modelId', 'voiceId', 'profileId'])
    input.changes.voiceId = 'redirected_after_capture'
    const update = vi.spyOn(redis, 'updateAgent').mockImplementation(async (_id, _body, options) => {
      const mutation = options?.configuredTtsMutation
      if (!mutation) throw new Error('Missing typed TTS mutation')
      mutation.check(); expect(mutation.sources).toContainEqual({ key: KEY, path: '$', raw: RAW }); selected = { ...mutation.selection }; mutation.onSaved?.()
    })
    const done = await registry.portableExecute(prepared.operation.operationId, admission.actor)
    expect(done.outcomes[0]).toMatchObject({ saved: 'saved', readback: 'verified' })
    expect(selected.voiceId).toBe('voice_1'); expect(update).toHaveBeenCalledTimes(1); expect(boundary.read).toHaveBeenCalledTimes(1)
  })
  it('keeps a failed catalog independent from saved/static selection and ordinary change Block', async () => {
    selected = { ...inherited, providerId: 'fish', voiceId: 'saved_voice' }
    boundary.read.mockResolvedValue({ status: 'unavailable', reason: 'list_denied' })
    const sourceStore = store(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, sourceStore), ctx = context()
    const first = await reports.report(ctx, 'portable', query), changes = createSettingsChanges(registry, reports, sourceStore)
    boundary.check.mockClear()
    const local = await changes.prepare(ctx, 'portable', { op: 'change', requestId: `${registry.boot}:local`, reportId: first.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'saved_voice' } })
    expect(local.operation.outcomes[0]).toMatchObject({ status: 'unchanged' }); expect(boundary.check).not.toHaveBeenCalled()
    admission.policy.ordinaryChanges = false
    await expect(changes.prepare(ctx, 'portable', { op: 'change', requestId: `${registry.boot}:blocked`, reportId: first.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'inherit' } })).rejects.toMatchObject({ code: 'SETTINGS_CHANGE_BLOCKED' })
    expect(boundary.read).toHaveBeenCalledTimes(1)
  })
  it('expires report paging without shortening an already captured operation review clock', async () => {
    vi.useFakeTimers()
    admission.expiresAt = Date.now() + 60 * 60_000
    const sourceStore = store(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, sourceStore), ctx = context()
    const first = await reports.report(ctx, 'portable', query), changes = createSettingsChanges(registry, reports, sourceStore)
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1_000)
    const prepared = await changes.prepare(ctx, 'portable', { op: 'change', requestId: `${registry.boot}:own-clock`, reportId: first.reportId,
      semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'voice_1' } })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(reports.report(ctx, 'portable', { reportId: first.reportId })).rejects.toMatchObject({ code: 'OPERATION_ENDED' })
    const update = vi.spyOn(redis, 'updateAgent').mockImplementation(async (_id, _body, options) => {
      const mutation = options?.configuredTtsMutation
      if (!mutation) throw new Error('Missing typed TTS mutation')
      mutation.check(); selected = { ...mutation.selection }; mutation.onSaved?.()
    })
    expect((await registry.portableExecute(prepared.operation.operationId, admission.actor)).outcomes[0]).toMatchObject({ saved: 'saved', readback: 'verified' })
    expect(update).toHaveBeenCalledTimes(1); expect(boundary.read).toHaveBeenCalledTimes(1)
  })
  it('preserves known save/readback failure and an issued unknown without re-list or replay', async () => {
    const sourceStore = store(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, sourceStore), ctx = context()
    const first = await reports.report(ctx, 'portable', query), changes = createSettingsChanges(registry, reports, sourceStore)
    const input = (requestId: string, voiceId: string) => ({ op: 'change', requestId: `${registry.boot}:${requestId}`, reportId: first.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'fish', modelId: null, voiceId } })
    const prepared = await changes.prepare(ctx, 'portable', input('known', 'voice_1'))
    const update = vi.spyOn(redis, 'updateAgent').mockImplementation(async (_id, _body, options) => { options?.configuredTtsMutation?.onSaved?.(); failedReadback = true })
    expect((await registry.portableExecute(prepared.operation.operationId, admission.actor)).outcomes[0]).toMatchObject({ saved: 'saved', readback: 'unavailable' })
    failedReadback = false
    const unknown = await changes.prepare(ctx, 'portable', input('unknown', 'voice_2'))
    update.mockRejectedValueOnce(new ConfiguredTtsSaveUnconfirmedError())
    const result = await registry.portableExecute(unknown.operation.operationId, admission.actor)
    expect(result.outcomes[0]).toMatchObject({ saved: 'unknown', status: 'unknown' })
    const issued = update.mock.calls.length
    await registry.portableExecute(unknown.operation.operationId, admission.actor)
    expect(update).toHaveBeenCalledTimes(issued); expect(boundary.read).toHaveBeenCalledTimes(1)
  })
})
