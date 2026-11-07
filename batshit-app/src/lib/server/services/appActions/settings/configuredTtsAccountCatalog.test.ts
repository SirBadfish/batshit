import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfiguredApiKeyUseState } from '$lib/services/apiKey.server'
import type { ConfiguredFishAccountPage } from '$lib/appActions/settings/configuredTtsPreferences'
import type { AdapterContext } from '../managementTypes'

const fixture = vi.hoisted(() => ({
  saved: { key: 'api_keys:u:fish', raw: '[{"encrypted":"SYNTHETIC_CIPHERTEXT"}]', state: 'readable', value: 'SYNTHETIC_SAVED_KEY' } as ConfiguredApiKeyUseState,
  current: { key: 'api_keys:u:fish', raw: '[{"encrypted":"SYNTHETIC_CIPHERTEXT"}]', configured: true, readable: true },
  readPage: vi.fn(), consume: vi.fn(), acquireKey: vi.fn(), acquireRedis: vi.fn(), admit: vi.fn(), authorityChanged: false,
  forbidden: vi.fn(() => { throw new Error('Effectful owner called') })
}))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: {
  withConfiguredValue: async <Result>(service: string, userId: string, consume: (source: ConfiguredApiKeyUseState) => Promise<Result>) => {
    await fixture.acquireKey()
    fixture.consume(service, userId)
    return consume(fixture.saved)
  },
  storedKeyName: (service: string, userId: string) => `api_keys:${userId}:${service}`,
  readConfiguredState: fixture.forbidden,
  retrieve: fixture.forbidden, store: fixture.forbidden
} }))
vi.mock('$lib/server/services/voiceService', () => ({
  readFishConfiguredAccountVoicePage: (...args: unknown[]) => fixture.readPage(...args),
  listVoices: fixture.forbidden, buildVoiceProviderSummary: fixture.forbidden,
  synthesizeSpeech: fixture.forbidden, checkByoSpeechStatus: fixture.forbidden
}))
vi.mock('$lib/server/redis', () => ({ redis: {
  execute: async <Result>(read: (client: { eval: (script: string, args: { keys: string[]; arguments: string[] }) => Promise<unknown> }) => Promise<Result>) => {
    await fixture.acquireRedis()
    return read({ eval: (script, args) => fixture.admit(script, args) })
  }
} }))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: fixture.forbidden }))
vi.mock('../runtime', () => ({ requireAppActionTopology: fixture.forbidden }))
vi.mock('$lib/server/services/streamAbortRegistry', () => ({ getOriginatingReplyStopSignal: fixture.forbidden }))

import { env } from '$env/dynamic/private'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { AppActionsManagementRefusal } from './authority'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from './lifecycle'
import { assertConfiguredTtsAccountEnvironment, readConfiguredTtsAccountCatalog, checkConfiguredTtsAccountSource, type ConfiguredTtsAccountCatalogRead } from './configuredTtsAccountCatalog'

const page = Object.freeze({
  providerId: 'fish', extent: 'credential-workspace', observedAt: '2026-10-18T12:00:00.000Z', page: 1, pageSize: 100,
  choices: [{ source: 'provider-list', providerId: 'fish', voiceId: 'workspace-voice', profileId: null, modelId: null,
    label: 'Workspace Voice', labelTruncated: false, modelScope: 'unknown' }],
  rawCount: 1, filteredCount: 0, rejectedCount: 0, reportedTotal: 1, totalExact: true,
  windowLimited: false, accessibleUpperBound: null, maxOffset: null, hasMore: false, nextPage: null, limitReached: false
} satisfies ConfiguredFishAccountPage)
function context(signal?: AbortSignal, onRefresh?: (count: number) => void | Promise<void>): AdapterContext {
  const policy = defaultAppActionsPolicy(true)
  policy.enabled = true
  policy.scope.subjects = [{ kind: 'primary', id: 'a10_account' }]
  let refreshes = 0
  const expiresAt = Date.now() + 30_000
  const key = 'portable_skill_token:u:token_a10'
  const record = { id: 'token_a10', userId: 'u', revokedAt: null, families: ['app-actions'], authorityGeneration: 1,
    appActionsGrant: { policy, expiresAt: new Date(expiresAt).toISOString() } }
  const assertCurrent = () => {
    if (signal?.aborted) throw new AppActionsManagementRefusal('CONTROL_STOPPED', 'The exact caller stopped.', 409)
  }
  return {
    admission: { actor: { userId: 'u', kind: 'portable', id: 'token_a10', generation: 1, label: 'Owned test token' }, policy,
      fence: { key, paths: Object.entries(record).map(([field, value]): [string, string] => [`$.${field}`, JSON.stringify([value])]), lifecycle: captureSettingsLifecycle([key]) }, expiresAt },
    deadlineAt: Date.now() + 30_000, ...(signal ? { signal } : {}), assertCurrent,
    async refreshAuthority() { await onRefresh?.(++refreshes); assertCurrent() }
  }
}
function target() {
  return { snapshot: { record: { id: 'a10_account', user_id: 'u', agentType: 'api' }, lifecycle: captureSettingsLifecycle(['agent:a10_account']) },
    providers: [{ id: 'fish', configured: 'yes' as const, enabled: true, supportsTts: true, models: ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1'] }],
    checkEnvironment: vi.fn() }
}
const request = { providerId: 'fish' as const, page: 1, modelId: null }

beforeEach(() => {
  vi.clearAllMocks()
  delete env.FISH_AUDIO_API_KEY; delete env.FISH_API_KEY
  fixture.saved = { key: 'api_keys:u:fish', raw: '[{"encrypted":"SYNTHETIC_CIPHERTEXT"}]', state: 'readable', value: 'SYNTHETIC_SAVED_KEY' }
  fixture.current = { key: fixture.saved.key, raw: fixture.saved.raw, configured: true, readable: true }
  fixture.authorityChanged = false
  fixture.acquireKey.mockReset().mockResolvedValue(undefined)
  fixture.acquireRedis.mockReset().mockResolvedValue(undefined)
  fixture.admit.mockReset().mockImplementation(async (script: string, args: { keys: string[]; arguments: string[] }) => {
    expect(script).toContain('-- fixed-a10-fish-account-admission')
    expect(args.keys).toEqual(['portable_skill_token:u:token_a10', 'api_keys:u:fish'])
    return fixture.authorityChanged ? 'AUTHORITY_CHANGED' : fixture.current.raw === args.arguments[1] ? 'OK' : 'SOURCE_CHANGED'
  })
  fixture.readPage.mockReset().mockResolvedValue({ status: 'listed', page })
})
afterEach(() => vi.useRealTimers())

describe('unexposed configured Fish account source owner', () => {
  it.each(['before-continuation', 'during-acquisition'] as const)('BL-1709 refuses a replacement credential %s before accessing its account', async phase => {
    const ctx = context(), subject = target(), first = await readConfiguredTtsAccountCatalog(ctx, subject, request)
    if (first.status !== 'listed') throw new Error('Expected owned source')
    const rotate = () => {
      fixture.saved = { key: fixture.saved.key, raw: '[{"encrypted":"REPLACEMENT_ACCOUNT"}]', state: 'readable', value: 'SYNTHETIC_REPLACEMENT_KEY' }
      fixture.current = { ...fixture.current, raw: fixture.saved.raw }
    }
    if (phase === 'before-continuation') rotate()
    else fixture.acquireKey.mockImplementationOnce(async () => { rotate() })
    expect(await readConfiguredTtsAccountCatalog(ctx, subject, { ...request, page: 2 }, first.source)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.readPage).toHaveBeenCalledTimes(1)
    expect(fixture.readPage).not.toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'SYNTHETIC_REPLACEMENT_KEY' }))
  })
  it.each(['absent', 'readable'] as const)('BL-1709 binds ticket environment through credential acquisition with unchanged %s raw', async state => {
    if (state === 'absent') {
      fixture.saved = { key: fixture.saved.key, raw: '[]', state: 'absent', value: null }
      fixture.current = { ...fixture.current, raw: '[]', readable: true, configured: false }
    }
    env.FISH_API_KEY = 'SYNTHETIC_ENV_ACCOUNT_A'
    const ctx = context(), subject = target(), first = await readConfiguredTtsAccountCatalog(ctx, subject, request)
    if (first.status !== 'listed') throw new Error('Expected owned source')
    const originalRaw = fixture.saved.raw
    fixture.acquireKey.mockImplementationOnce(async () => { env.FISH_API_KEY = 'SYNTHETIC_ENV_ACCOUNT_B' })
    expect(await readConfiguredTtsAccountCatalog(ctx, subject, { ...request, page: 2 }, first.source)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.saved.raw).toBe(originalRaw); expect(fixture.readPage).toHaveBeenCalledTimes(1)
  })
  it('BL-1709 permits unchanged ticket continuation and keeps the expected basis private and captured', async () => {
    const ctx = context(), subject = target(), first = await readConfiguredTtsAccountCatalog(ctx, subject, request)
    if (first.status !== 'listed') throw new Error('Expected owned source')
    const expected = { ...first.source, credential: { ...first.source.credential } }
    fixture.acquireKey.mockImplementationOnce(async () => { expected.credential.raw = '["CALLER_MUTATION"]'; expected.environmentStamp = 'b'.repeat(64) })
    const next = await readConfiguredTtsAccountCatalog(ctx, subject, { ...request, page: 2 }, expected)
    expect(next.status).toBe('listed'); expect(fixture.readPage).toHaveBeenCalledTimes(2)
    expect(fixture.readPage).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'SYNTHETIC_SAVED_KEY', page: 2 }))
    expect(fixture.readPage.mock.calls[1][0]).not.toHaveProperty('expectedSource')
  })
  it('validates held source with one LOCAL cut and never re-lists a provider or retrieves a key value', async () => {
    const ctx = context(), subject = target(), read = await readConfiguredTtsAccountCatalog(ctx, subject, request)
    if (read.status !== 'listed') throw new Error('Expected owned source')
    expect(await checkConfiguredTtsAccountSource(ctx, subject, read.source)).toEqual({ status: 'current' })
    fixture.current.raw = '[{"encrypted":"ROTATED"}]'
    expect(await checkConfiguredTtsAccountSource(ctx, subject, read.source)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    const foreign = { ...read.source, credential: { ...read.source.credential, key: 'api_keys:other:fish' } }
    expect(await checkConfiguredTtsAccountSource(ctx, subject, foreign)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.readPage).toHaveBeenCalledTimes(1)
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('bounds a cached-source pool wait and fences a late ignored-abort read without a provider call', async () => {
    const ctx = context(), subject = target(), read = await readConfiguredTtsAccountCatalog(ctx, subject, request)
    if (read.status !== 'listed') throw new Error('Expected owned source')
    vi.useFakeTimers()
    let release = () => {}, reached = () => {}
    const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { reached = resolve })
    fixture.acquireRedis.mockImplementationOnce(async () => { reached(); await gate })
    const issued = fixture.admit.mock.calls.length
    try {
      const pending = checkConfiguredTtsAccountSource(context(), subject, read.source)
      await held; await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toEqual({ status: 'unavailable', reason: 'list_timeout' })
      release(); await vi.advanceTimersByTimeAsync(0)
      expect(fixture.admit).toHaveBeenCalledTimes(issued)
      expect(fixture.readPage).toHaveBeenCalledTimes(1)
    } finally { release(); vi.useRealTimers() }
  })
  it('admits exactly the owned granted API/CLI subject and no unavailable model or source', async () => {
    const foreign = target(); foreign.snapshot.record.user_id = 'other'
    await expect(readConfiguredTtsAccountCatalog(context(), foreign, request)).rejects.toMatchObject({ code: 'TTS_SUBJECT_UNAVAILABLE' })
    const delegated = target(); delegated.snapshot.record.agentType = 'retired'
    await expect(readConfiguredTtsAccountCatalog(context(), delegated, request)).rejects.toMatchObject({ code: 'TTS_SUBJECT_UNAVAILABLE' })
    const denied = context(); denied.admission.policy.scope.subjects = []
    await expect(readConfiguredTtsAccountCatalog(denied, target(), request)).rejects.toMatchObject({ code: 'SUBJECT_NOT_GRANTED' })
    const closed = target(); closed.providers[0].enabled = false
    expect(await readConfiguredTtsAccountCatalog(context(), closed, request)).toEqual({ status: 'unavailable', reason: 'not_configured' })
    expect(await readConfiguredTtsAccountCatalog(context(), target(), { ...request, modelId: 'unknown-model' })).toEqual({ status: 'unavailable', reason: 'invalid_payload' })
    expect(fixture.consume).not.toHaveBeenCalled(); expect(fixture.readPage).not.toHaveBeenCalled()
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('uses the exact saved key before ordered env fallbacks, and keeps its private fence outside the safe page', async () => {
    env.FISH_AUDIO_API_KEY = 'SYNTHETIC_ENV_FIRST'; env.FISH_API_KEY = 'SYNTHETIC_ENV_SECOND'
    const result = await readConfiguredTtsAccountCatalog(context(), target(), { ...request, modelId: 's2.1-pro' })
    expect(result.status).toBe('listed')
    if (result.status !== 'listed') throw new Error('Expected observed page')
    expect(fixture.consume).toHaveBeenCalledWith('fish', 'u')
    expect(fixture.readPage).toHaveBeenCalledTimes(1)
    expect(fixture.readPage).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'SYNTHETIC_SAVED_KEY', page: 1 }))
    expect(result.source).toMatchObject({ providerId: 'fish', credential: { key: fixture.saved.key, path: '$', raw: fixture.saved.raw }, modelScope: 'unknown' })
    expect(JSON.stringify(result.page)).not.toMatch(/SYNTHETIC_|"credential"|endpoint|preview|readiness/)
    expect(JSON.stringify(result.source)).not.toMatch(/SYNTHETIC_SAVED_KEY|SYNTHETIC_ENV_/)
    expect(result.page.choices[0].modelScope).toBe('unknown')
    expect(() => assertConfiguredTtsAccountEnvironment(result.source)).not.toThrow()
    env.FISH_API_KEY = 'SYNTHETIC_ENV_CHANGED'
    expect(() => assertConfiguredTtsAccountEnvironment(result.source)).toThrow('tts_account_source_changed')
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('preserves unreadable versus absent saved state while using the actual ordered Voice env fallback', async () => {
    fixture.saved = { key: fixture.saved.key, raw: '[{"encrypted":"BROKEN"}]', state: 'unreadable', value: null }
    fixture.current = { key: fixture.saved.key, raw: fixture.saved.raw, configured: false, readable: false }
    expect(await readConfiguredTtsAccountCatalog(context(), target(), request)).toEqual({ status: 'unavailable', reason: 'credential_unreadable' })
    expect(fixture.readPage).not.toHaveBeenCalled()
    env.FISH_API_KEY = 'SYNTHETIC_ENV_SECOND'; env.FISH_AUDIO_API_KEY = 'SYNTHETIC_ENV_FIRST'
    expect((await readConfiguredTtsAccountCatalog(context(), target(), request)).status).toBe('listed')
    expect(fixture.readPage).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'SYNTHETIC_ENV_FIRST' }))
    delete env.FISH_AUDIO_API_KEY
    expect((await readConfiguredTtsAccountCatalog(context(), target(), request)).status).toBe('listed')
    expect(fixture.readPage).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'SYNTHETIC_ENV_SECOND' }))
    fixture.saved = { ...fixture.saved, state: 'readable', value: '' }
    fixture.current = { ...fixture.current, readable: true, configured: false }
    expect((await readConfiguredTtsAccountCatalog(context(), target(), request)).status).toBe('listed')
    expect(fixture.readPage).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'SYNTHETIC_ENV_SECOND' }))
    delete env.FISH_API_KEY
    fixture.saved = { key: fixture.saved.key, raw: '[]', state: 'absent', value: null }
    fixture.current = { key: fixture.saved.key, raw: '[]', configured: false, readable: true }
    expect(await readConfiguredTtsAccountCatalog(context(), target(), request)).toEqual({ status: 'unavailable', reason: 'not_configured' })
  })
  it('fences key/env rotation across an authority await before any provider request', async () => {
    const keyChanged = context(undefined, count => { if (count === 2) fixture.current.raw = '[{"encrypted":"ROTATED"}]' })
    expect(await readConfiguredTtsAccountCatalog(keyChanged, target(), request)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.readPage).not.toHaveBeenCalled()
    fixture.current.raw = fixture.saved.raw
    const envChanged = context(undefined, count => { if (count === 2) env.FISH_API_KEY = 'SYNTHETIC_ROTATED_ENV' })
    expect(await readConfiguredTtsAccountCatalog(envChanged, target(), request)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.readPage).not.toHaveBeenCalled()
  })
  it('BL-1704 refuses key rotation during the final authority refresh instead of handing off an old page', async () => {
    const ctx = context(undefined, count => { if (count === 3) fixture.current.raw = '[{"encrypted":"FINAL_REFRESH_ROTATION"}]' })
    expect(await readConfiguredTtsAccountCatalog(ctx, target(), request)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    expect(fixture.readPage).toHaveBeenCalledTimes(1)
    expect(fixture.admit).toHaveBeenCalledTimes(2)
  })
  it.each(['environment', 'target-replacement'] as const)('BL-1706 fences %s in the real microtask gap before provider issue', async drift => {
    const subject = target()
    let interposed = false, replacement: Promise<void> | undefined
    subject.checkEnvironment.mockImplementation(() => {
      if (interposed || fixture.admit.mock.calls.length !== 1 || fixture.readPage.mock.calls.length !== 0) return
      interposed = true
      // Queued during admit's final internal check: it runs before its awaiter's continuation.
      queueMicrotask(() => {
        if (drift === 'environment') env.FISH_API_KEY = 'test-issue-boundary-rotation'
        else replacement = withSettingsRecordReplacement('agent:a10_account', async () => {})
      })
    })
    try {
      const pending = readConfiguredTtsAccountCatalog(context(), subject, request)
      if (drift === 'environment') await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'source_changed' })
      else await expect(pending).rejects.toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
      expect(interposed).toBe(true)
      expect(fixture.readPage).not.toHaveBeenCalled()
    } finally { await replacement }
  })
  it.each(['pool', 'eval'] as const)('BL-1707 sanitizes a private final %s failure in both return and throw channels', async boundary => {
    const privateError = new Error('SYNTHETIC_PRIVATE_REDIS_ERROR https://private-endpoint.invalid/secret')
    if (boundary === 'pool') fixture.acquireRedis.mockResolvedValueOnce(undefined).mockRejectedValueOnce(privateError)
    else fixture.admit.mockResolvedValueOnce('OK').mockRejectedValueOnce(privateError)
    const observed: { result?: ConfiguredTtsAccountCatalogRead; thrown?: string } = {}
    try { observed.result = await readConfiguredTtsAccountCatalog(context(), target(), request) }
    catch (error) { observed.thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    expect(JSON.stringify(observed)).not.toMatch(/SYNTHETIC_PRIVATE|private-endpoint|https:/)
    expect(observed).toEqual({ result: { status: 'unavailable', reason: 'list_unavailable' } })
    expect(fixture.readPage).toHaveBeenCalledTimes(1)
  })
  it('refuses authority drift at the coherent final source admission and malformed private fences before any provider read', async () => {
    const changed = context(undefined, count => { if (count === 3) fixture.authorityChanged = true })
    await expect(readConfiguredTtsAccountCatalog(changed, target(), request)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' })
    fixture.authorityChanged = false; fixture.readPage.mockClear()
    const foreign = context(); foreign.admission.fence.key = 'portable_skill_token:other:token_a10'
    await expect(readConfiguredTtsAccountCatalog(foreign, target(), request)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' })
    const path = context(); path.admission.fence.paths[0][0] = '$.arbitrary'
    await expect(readConfiguredTtsAccountCatalog(path, target(), request)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' })
    const oversized = context(); oversized.admission.fence.paths[0][1] = 'x'.repeat(262145)
    await expect(readConfiguredTtsAccountCatalog(oversized, target(), request)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' })
    fixture.saved = { ...fixture.saved, key: 'api_keys:other:fish' }
    expect(await readConfiguredTtsAccountCatalog(context(), target(), request)).toEqual({ status: 'unavailable', reason: 'credential_unreadable' })
    expect(fixture.readPage).not.toHaveBeenCalled()
  })
  it('captures the exact requested page before a caller object can change across an await', async () => {
    const input = { ...request }
    const ctx = context(undefined, count => { if (count === 2) input.page = 11 })
    expect((await readConfiguredTtsAccountCatalog(ctx, target(), input)).status).toBe('listed')
    expect(fixture.readPage).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }))
  })
  it('discards an observed page after local key rotation and returns fixed list failures without falling back to another catalog', async () => {
    fixture.readPage.mockImplementationOnce(async () => { fixture.current.raw = '[{"encrypted":"ROTATED"}]'; return { status: 'listed', page } })
    expect(await readConfiguredTtsAccountCatalog(context(), target(), request)).toEqual({ status: 'unavailable', reason: 'source_changed' })
    fixture.current.raw = fixture.saved.raw
    fixture.readPage.mockResolvedValueOnce({ status: 'unavailable', reason: 'list_denied' })
    expect(await readConfiguredTtsAccountCatalog(context(), target(), request)).toEqual({ status: 'unavailable', reason: 'list_denied' })
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('suppresses a completed page on post-await revoke, Stop or subject drift', async () => {
    const early = new AbortController(); early.abort()
    await expect(readConfiguredTtsAccountCatalog(context(early.signal), target(), request)).rejects.toMatchObject({ code: 'CONTROL_STOPPED' })
    expect(fixture.consume).not.toHaveBeenCalled()
    const revoked = context(undefined, count => { if (count === 3) throw new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'Revoked.', 409) })
    await expect(readConfiguredTtsAccountCatalog(revoked, target(), request)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' })
    const controller = new AbortController()
    fixture.readPage.mockImplementationOnce(async () => { controller.abort(); return { status: 'listed', page } })
    await expect(readConfiguredTtsAccountCatalog(context(controller.signal), target(), request)).rejects.toMatchObject({ code: 'CONTROL_STOPPED' })
    const drifted = target()
    fixture.readPage.mockImplementationOnce(async () => { drifted.snapshot.record.user_id = 'other'; return { status: 'listed', page } })
    await expect(readConfiguredTtsAccountCatalog(context(), drifted, request)).rejects.toMatchObject({ code: 'TTS_SUBJECT_UNAVAILABLE' })
    const replaced = target()
    fixture.readPage.mockImplementationOnce(async () => { await withSettingsRecordReplacement('agent:a10_account', async () => {}); return { status: 'listed', page } })
    await expect(readConfiguredTtsAccountCatalog(context(), replaced, request)).rejects.toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('bounds private env input before hashing and never returns raw private errors', async () => {
    env.FISH_AUDIO_API_KEY = 'x'.repeat(16385)
    expect(await readConfiguredTtsAccountCatalog(context(), target(), request)).toEqual({ status: 'unavailable', reason: 'credential_unreadable' })
    expect(fixture.readPage).not.toHaveBeenCalled()
    delete env.FISH_AUDIO_API_KEY
    fixture.readPage.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_ERROR https://private.invalid'))
    const result = await readConfiguredTtsAccountCatalog(context(), target(), request)
    expect(result).toEqual({ status: 'unavailable', reason: 'credential_unreadable' })
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_|https:/)
  })
  it.each(['initial-authority', 'credential', 'pre-admission', 'source-read', 'provider-read', 'final-authority', 'final-admission'] as const)(
    'BL-1705 bounds %s and prevents ignored-abort late work from issuing or publishing', async phase => {
      vi.useFakeTimers()
      let release = () => {}, reached = () => {}
      const gate = new Promise<void>(resolve => { release = resolve })
      const held = new Promise<void>(resolve => { reached = resolve })
      const hold = async () => { reached(); await gate }
      const ctx = context(undefined, async count => {
        if (phase === 'initial-authority' && count === 1 || phase === 'final-authority' && count === 3) await hold()
      })
      if (phase === 'credential') fixture.acquireKey.mockImplementationOnce(hold)
      if (phase === 'pre-admission') fixture.acquireRedis.mockImplementationOnce(hold)
      if (phase === 'source-read' || phase === 'final-admission') {
        fixture.admit.mockImplementation(async () => { if (fixture.admit.mock.calls.length === (phase === 'source-read' ? 1 : 2)) await hold(); return 'OK' })
      }
      if (phase === 'provider-read') fixture.readPage.mockImplementationOnce(async () => { await hold(); return { status: 'listed', page } })
      try {
        const pending = readConfiguredTtsAccountCatalog(ctx, target(), request)
        await held
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await pending).toEqual({ status: 'unavailable', reason: 'list_timeout' })
        const providerCalls = phase === 'provider-read' || phase === 'final-authority' || phase === 'final-admission' ? 1 : 0
        expect(fixture.readPage).toHaveBeenCalledTimes(providerCalls)
        const issued = fixture.admit.mock.calls.length
        release(); await vi.advanceTimersByTimeAsync(0)
        expect(fixture.readPage).toHaveBeenCalledTimes(providerCalls)
        expect(fixture.admit).toHaveBeenCalledTimes(issued)
        expect(fixture.forbidden).not.toHaveBeenCalled()
      } finally { release(); vi.useRealTimers() }
    })
  it('honors genuine Stop during a held credential read and fences its late callback', async () => {
    let release = () => {}, reached = () => {}
    const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { reached = resolve })
    fixture.acquireKey.mockImplementationOnce(async () => { reached(); await gate })
    const stopped = new AbortController()
    const pending = readConfiguredTtsAccountCatalog(context(stopped.signal), target(), request)
    try {
      await held; stopped.abort()
      await expect(pending).rejects.toMatchObject({ code: 'CONTROL_STOPPED' })
      release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(fixture.readPage).not.toHaveBeenCalled(); expect(fixture.admit).not.toHaveBeenCalled()
    } finally { release() }
  })
})
