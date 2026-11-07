import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterContext, SettingsManagementAdmission } from '../managementTypes'
import type { ConfiguredFishAccountPage, ConfiguredFishAccountChoice } from '$lib/appActions/settings/configuredTtsPreferences'
import type { ConfiguredTtsTarget } from './configuredTtsSources'
const remote = vi.hoisted(() => ({ read: vi.fn(), environment: vi.fn() }))
vi.mock('./configuredTtsAccountCatalog', () => ({ readConfiguredTtsAccountCatalog: (...args: unknown[]) => remote.read(...args), assertConfiguredTtsAccountEnvironment: (...args: unknown[]) => remote.environment(...args) }))
import { createConfiguredFishAccountPages } from './configuredTtsAccountPaging'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from './lifecycle'
const key = 'api_keys:u:fish', raw = '[{"encrypted":"SYNTHETIC_PRIVATE_CUT"}]', subject = { kind: 'primary' as const, id: 'a10_pages' }
const source = { providerId: 'fish' as const, credential: { key, path: '$' as const, raw }, environmentStamp: 'a'.repeat(64), observedAt: '2026-10-18T12:00:00.000Z', modelScope: 'unknown' as const }
function fixture() {
  const life = captureSettingsLifecycle([`agent:${subject.id}`]), policy = defaultAppActionsPolicy(true)
  policy.enabled = true; policy.scope.subjects = [subject]
  const admission: SettingsManagementAdmission = { actor: { userId: 'u', kind: 'portable', id: 'token', generation: 1, label: 'Test' }, policy,
    fence: { key: 'portable_skill_token:u:token', paths: [], lifecycle: captureSettingsLifecycle([]) }, expiresAt: Date.now() + 60_000 }
  // Cache-only source view; full provider/Redis request owners have their separate whole-file proof.
  const target = { snapshot: { id: subject.id, record: { id: subject.id, user_id: 'u', agentType: 'api' }, lifecycle: life }, locked: false,
    providers: [{ id: 'fish', guards: [{ key, path: '$', raw }] }], checkEnvironment() {} } as unknown as ConfiguredTtsTarget
  const ctx: AdapterContext = { admission, deadlineAt: Date.now() + 30_000, assertCurrent() {}, async refreshAuthority() {} }
  return { ctx, target, options: { subject, target, admission, modelId: null, manifestDigest: 'b'.repeat(64), expiresAt: Date.now() + 60_000 } }
}
const choice = (id: string, label = id): ConfiguredFishAccountChoice => ({ source: 'provider-list', providerId: 'fish', voiceId: id, profileId: null, modelId: null, label, labelTruncated: false, modelScope: 'unknown' })
function page(number: number, choices: ConfiguredFishAccountChoice[], more = false): ConfiguredFishAccountPage {
  return { providerId: 'fish', extent: 'credential-workspace', observedAt: source.observedAt, page: number, pageSize: 100, choices,
    rawCount: choices.length, filteredCount: 0, rejectedCount: 0, reportedTotal: choices.length, totalExact: true, windowLimited: false,
    accessibleUpperBound: null, maxOffset: null, hasMore: more, nextPage: more && number < 10 ? number + 1 : null, limitReached: more && number === 10 }
}
beforeEach(() => { vi.clearAllMocks(); remote.read.mockReset().mockResolvedValue({ status: 'listed', source, page: page(1, [choice('one')]) }) })
afterEach(() => vi.restoreAllMocks())
describe('private finite Fish report cursor and observation cache', () => {
  it('singleflights one exact position, replays settled pages and fetches only explicit issued remote continuation', async () => {
    const f = fixture(), state = createConfiguredFishAccountPages(f.options)
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    remote.read.mockImplementationOnce(async () => { await gate; return { status: 'listed', source, page: page(1, Array.from({ length: 40 }, (_, index) => choice(`voice_${index}`)), true) } })
    const first = state.page(f.ctx), duplicate = state.page(f.ctx)
    expect(remote.read).toHaveBeenCalledTimes(1)
    release(); const [a, b] = await Promise.all([first, duplicate])
    expect(a).toBe(b); expect(a.account.choices).toHaveLength(32)
    expect(await state.page(f.ctx)).toBe(a)
    const second = await state.page(f.ctx, a.continuation.nextCursor!)
    expect(second.account.choices).toHaveLength(8); expect(remote.read).toHaveBeenCalledTimes(1)
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: page(2, [choice('one')]) })
    await state.page(f.ctx, second.continuation.nextCursor!)
    expect(remote.read).toHaveBeenCalledTimes(2)
    expect(remote.read.mock.calls[0][3]).toBeUndefined()
    expect(remote.read.mock.calls[1][3]).toEqual(source)
    await expect(state.page(f.ctx, `sv1:${state.snapshotId}:999`)).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' })
    await expect(state.page(f.ctx, `sv1:${'c'.repeat(64)}:1`)).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' })
    await expect(state.page(f.ctx, `sr1:${state.snapshotId}:1`)).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' })
    expect(remote.read).toHaveBeenCalledTimes(2)
  })
  it('keeps complete IDs/labels inside32-row8KiB pages and never projects its private key/source', async () => {
    const f = fixture(), state = createConfiguredFishAccountPages(f.options)
    const voices = Array.from({ length: 60 }, (_, index) => choice(`${index}_${'x'.repeat(250)}`, '😀'.repeat(50)))
    remote.read.mockResolvedValue({ status: 'listed', source, page: page(1, voices) })
    const seen: string[] = []; let cursor: string | undefined
    do {
      const next = await state.page(f.ctx, cursor)
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(8192)
      expect(next.account.choices.length).toBeLessThanOrEqual(32)
      expect(JSON.stringify(next)).not.toMatch(/SYNTHETIC_PRIVATE_CUT|api_keys|"credential":|"raw":|https:/)
      seen.push(...next.account.choices.map(row => row.voiceId)); cursor = next.continuation.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(voices.map(row => row.voiceId)); expect(remote.read).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(state.find(voices[0].voiceId))).toBe(true)
    expect(Object.isFrozen(state.find(voices[0].voiceId)!.choice)).toBe(true)
  })
  it('reports unknown/window-limited/filtered coverage honestly and retains unknown model scope without a readiness gate', async () => {
    const f = fixture()
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: { ...page(1, [choice('one')]), hasMore: null, totalExact: null, windowLimited: null, reportedTotal: null } })
    const unknown = await createConfiguredFishAccountPages(f.options).page(f.ctx)
    expect(unknown.account).toMatchObject({ complete: false, reportedTotal: null, hasMore: null, reason: 'continuation_unavailable', modelScope: 'unknown' })
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: { ...page(1, [choice('one')]), windowLimited: true, totalExact: false, reportedTotal: 500 } })
    expect((await createConfiguredFishAccountPages(f.options).page(f.ctx)).account).toMatchObject({ complete: false, windowLimited: true, reason: 'source_limit' })
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: page(1, [choice('one')]) })
    expect((await createConfiguredFishAccountPages(f.options).page(f.ctx)).account.complete).toBe(true)
  })
  it('stops at finite held/provider limits and keeps provider page progress independent of accepted rows', async () => {
    const f = fixture(), state = createConfiguredFishAccountPages(f.options)
    remote.read.mockImplementation(async (_ctx, _target, request) => ({ status: 'listed', source,
      page: page(request.page, Array.from({ length: 100 }, (_, index) => choice(`${request.page}_${index}_${'x'.repeat(220)}`, 'é'.repeat(100))), true) }))
    let cursor: string | undefined, result
    do { result = await state.page(f.ctx, cursor); cursor = result.continuation.nextCursor ?? undefined } while (cursor)
    expect(result!.account).toMatchObject({ complete: false, reason: 'source_limit' })
    expect(remote.read.mock.calls.length).toBeLessThanOrEqual(10)
    expect(result!.account.observedCount).toBeLessThanOrEqual(1000)
    const other = createConfiguredFishAccountPages(f.options)
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: { ...page(1, [], true), rawCount: 100, filteredCount: 100 } })
    const empty = await other.page(f.ctx)
    expect(empty.account).toMatchObject({ rawCount: 100, observedCount: 0, filteredCount: 100 })
    expect(empty.continuation.nextCursor).toBeTruthy()
  })
  it('does not merge a rotated account source or conflicting duplicate and never silently retries a failed read', async () => {
    const f = fixture(), state = createConfiguredFishAccountPages(f.options)
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: page(1, [choice('one')], true) })
    const first = await state.page(f.ctx)
    remote.read.mockResolvedValueOnce({ status: 'listed', source: { ...source, credential: { ...source.credential, raw: '["ROTATED"]' } }, page: page(2, [choice('two')]) })
    const changed = await state.page(f.ctx, first.continuation.nextCursor!)
    expect(changed.account).toMatchObject({ status: 'unavailable', reason: 'source_changed', choices: [] })
    expect(await state.page(f.ctx, first.continuation.nextCursor!)).toBe(changed)
    expect(state.find('two')).toBeUndefined(); expect(remote.read).toHaveBeenCalledTimes(2)
    const duplicate = createConfiguredFishAccountPages(f.options)
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: page(1, [choice('one')], true) })
    const a = await duplicate.page(f.ctx)
    remote.read.mockResolvedValueOnce({ status: 'listed', source, page: page(2, [choice('one', 'Changed name')]) })
    expect((await duplicate.page(f.ctx, a.continuation.nextCursor!)).account.reason).toBe('invalid_payload')
  })
  it('keeps authority/subject/read expiry current while captured choices stay immutable', async () => {
    const f = fixture(), state = createConfiguredFishAccountPages(f.options)
    await state.page(f.ctx)
    const changed: AdapterContext = { ...f.ctx, admission: { ...f.ctx.admission, actor: { ...f.ctx.admission.actor, generation: 2 } } }
    await expect(state.page(changed)).rejects.toMatchObject({ code: 'REPORT_AUTHORITY_CHANGED' })
    await withSettingsRecordReplacement(`agent:${subject.id}`, async () => {})
    await expect(state.page(f.ctx)).rejects.toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
    const g = fixture(), expired = createConfiguredFishAccountPages(g.options)
    vi.spyOn(Date, 'now').mockReturnValue(g.options.expiresAt)
    await expect(expired.page(g.ctx)).rejects.toMatchObject({ code: 'REPORT_EXPIRED' })
    expect(remote.read).toHaveBeenCalledTimes(1)
  })
})
