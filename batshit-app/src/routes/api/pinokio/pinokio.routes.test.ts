// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  access: vi.fn(), preview: vi.fn(), start: vi.fn(), detect: vi.fn(), status: vi.fn(), search: vi.fn(),
  list: vi.fn(), current: vi.fn(), resolve: vi.fn(), endpoint: vi.fn(), forget: vi.fn(), owner: vi.fn(), effect: vi.fn()
}))
vi.mock('$lib/server/artifacts/pinokioArtifactAccess', () => ({ loadPinokioArtifactForUser: (...args: any[]) => mocks.access(...args) }))
vi.mock('$lib/server/services/pinokioService', async original => ({ ...await original<typeof import('$lib/server/services/pinokioService')>(),
  previewPinokioAppStart: (...args: any[]) => mocks.preview(...args), startPinokioApp: (...args: any[]) => mocks.start(...args),
  detectPinokio: (...args: any[]) => mocks.detect(...args), getPinokioTargetStatus: (...args: any[]) => mocks.status(...args), searchPinokioApps: (...args: any[]) => mocks.search(...args)
}))
vi.mock('$lib/server/services/pinokioMachineService', async original => ({ ...await original<typeof import('$lib/server/services/pinokioMachineService')>(),
  pinokioMachineService: { list: (...args: any[]) => mocks.list(...args), resolveCurrent: (...args: any[]) => mocks.current(...args), resolve: (...args: any[]) => mocks.resolve(...args) }
}))
vi.mock('$lib/server/services/pinokioAppEndpoint', () => ({ resolvePinokioAppEndpoint: (...args: any[]) => mocks.endpoint(...args), forgetPinokioAppEndpoint: (...args: any[]) => mocks.forget(...args) }))
vi.mock('$lib/server/redis', () => ({ redis: { json: { get: (...args: any[]) => mocks.owner(...args) } } }))
import { GET as statusGet } from './status/+server'
import { GET as appsGet } from './apps/+server'
import { GET as previewGet, POST as startPost } from './apps/start/+server'
import { __resetPinokioAdmissionForTests, fencePinokioOperations, pinokioBindingFingerprint } from '$lib/server/services/pinokioAdmission'
import { PinokioMachineError } from '$lib/server/services/pinokioMachineService'

const id = '12345678-1234-4123-8123-123456789abc'
const local = { kind: 'local', id: 'local', label: 'This computer', revision: 0, bindingState: 'confirmed' }
const remote = { kind: 'remote', id, label: 'PC', revision: 1, bindingState: 'confirmed' }
let artifact: any
let binding: any
const nativeFingerprint = 'a'.repeat(64)
function event(path: string, options: RequestInit = {}) {
  const url = new URL(path, 'http://batshit.test')
  const request = new Request(url, options)
  return { request, url, locals: { user: { id: 'owner' } } } as any
}
function body(overrides: Record<string, unknown> = {}) {
  return { artifactId: 'art', machineId: id, revision: 1, launchFingerprint: nativeFingerprint,
    bindingFingerprint: pinokioBindingFingerprint(artifact), alsoStarts: ['dep.git'], ...overrides }
}
function post(payload: Record<string, unknown> = body(), options: RequestInit = {}) {
  return startPost(event('/api/pinokio/apps/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://batshit.test' }, body: JSON.stringify(payload), ...options }))
}
beforeEach(() => {
  vi.clearAllMocks()
  artifact = { id: 'art', user_id: 'owner', name: 'Saved tool', brain_type: 'pinokio_app', metadata: { runtime_manager: 'pinokio', source_type: 'custom', pinokio_app_id: 'app.git', pinokio_machine_id: id } }
  binding = { appId: 'app.git', kind: 'custom', machineId: id, runtime: { method: 'POST', path: '/run' } }
  mocks.access.mockImplementation(async () => ({ ok: true, artifact, binding }))
  mocks.owner.mockResolvedValue(['owner'])
  mocks.list.mockResolvedValue([local, remote])
  mocks.current.mockImplementation(async (_user, selected) => selected === undefined || selected === 'local' ? local : remote)
  mocks.resolve.mockResolvedValue(remote)
  mocks.preview.mockResolvedValue({ ok: true, value: { appId: 'app.git', title: 'App', state: 'offline', ready: false, alsoStarts: ['dep.git'], launchFingerprint: nativeFingerprint } })
  mocks.start.mockImplementation(async input => {
    if (input.admitStart && await input.admitStart() !== true) return { ok: false, kind: 'refused', code: 'pinokio_remote_start_not_admitted', message: 'Start admission was lost.' }
    mocks.effect(input)
    return { ok: true, value: { appId: input.appId, title: 'App', machineId: input.machineId, machineRevision: input.revision,
      machineLabel: 'PC', alreadyRunning: false, ready: false, state: 'starting', readyUrl: null, alsoStarted: [], waitedMs: 45_000, launchState: 'pending', message: 'Native chain pending.' } }
  })
  mocks.endpoint.mockResolvedValue({ ok: true, appId: 'app.git', title: 'App', machineId: id, machineRevision: 1, fetch: vi.fn(), baseUrl: 'http://192.168.1.90:8188/' })
  mocks.detect.mockResolvedValue({ available: false, reason: 'not_installed', message: 'No local Pinokio.' })
  mocks.status.mockResolvedValue({ ok: true, value: { available: true, kind: 'remote', machineId: id, machineRevision: 1 } })
  mocks.search.mockResolvedValue({ ok: true, value: { apps: [{ appId: 'app.git', title: 'App', state: 'offline' }] } })
})
afterEach(() => { __resetPinokioAdmissionForTests(); vi.restoreAllMocks() })

describe('existing Pinokio read routes carry the authenticated saved target', () => {
  it('lists saved computers even when local Pinokio is absent', async () => {
    const response = await statusGet(event('/api/pinokio/status'))
    expect(await response.json()).toMatchObject({ pinokio: { available: false }, machines: [{ id: 'local' }, { id }] })
    expect(mocks.list).toHaveBeenCalledWith('owner')
  })
  it('uses remote status without local detection and exposes an unreadable registry honestly', async () => {
    mocks.list.mockRejectedValue(new Error('private backend error'))
    const response = await statusGet(event(`/api/pinokio/status?machineId=${id}&revision=1`))
    expect(await response.json()).toMatchObject({ pinokio: { kind: 'remote' }, machines: null, machinesError: { code: 'pinokio_machine_registry_unavailable' } })
    expect(mocks.detect).not.toHaveBeenCalled()
    expect(mocks.status).toHaveBeenCalledWith({ userId: 'owner', machineId: id, revision: 1 })
  })
  it('pins app-list reads to the freshly resolved revision; body/query user cannot retarget', async () => {
    const response = await appsGet(event(`/api/pinokio/apps?machineId=${id}&userId=other&q=test`))
    expect(await response.json()).toMatchObject({ available: true, machineId: id, machineRevision: 1, apps: [{ appId: 'app.git' }] })
    expect(mocks.search).toHaveBeenCalledWith({ userId: 'owner', machineId: id, revision: 1, query: 'test' })
  })
  it('does not convert malformed or removed saved target into local or a successful empty list', async () => {
    expect((await appsGet(event('/api/pinokio/apps?machineId='))).status).toBe(400)
    mocks.current.mockRejectedValue(new PinokioMachineError('pinokio_machine_missing', 'Missing.', 404))
    const response = await appsGet(event(`/api/pinokio/apps?machineId=${id}`))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ available: false, code: 'pinokio_machine_missing' })
    expect(mocks.search).not.toHaveBeenCalled()
  })
})

describe('panel preview/confirmation custody and one admitted native start', () => {
  it('returns the saved machine/revision/native and binding fingerprints without starting', async () => {
    const response = await previewGet(event('/api/pinokio/apps/start?artifactId=art&machineId=local'))
    expect(await response.json()).toMatchObject({ success: true, machineId: id, machineRevision: 1, machineLabel: 'PC', launchFingerprint: nativeFingerprint, bindingFingerprint: pinokioBindingFingerprint(artifact), endpointReady: false })
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', appId: 'app.git', machineId: id, revision: 1 }))
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('separately probes Batshit-side reachability for a running remote preview', async () => {
    mocks.preview.mockResolvedValue({ ok: true, value: { appId: 'app.git', title: 'App', state: 'online', ready: true, alsoStarts: [], launchFingerprint: nativeFingerprint } })
    expect(await (await previewGet(event('/api/pinokio/apps/start?artifactId=art'))).json()).toMatchObject({ endpointReady: true })
    expect(mocks.endpoint).toHaveBeenCalledWith('app.git', expect.objectContaining({ userId: 'owner', machineId: id, revision: 1 }))
  })
  it.each([{ machineId: 'local' }, { revision: undefined }, { launchFingerprint: undefined }, { bindingFingerprint: 'stale' }, { alsoStarts: [null] }])('refuses changed/malformed preview echo %j before an effect', async patch => {
    const response = await post(body(patch))
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.json()).toMatchObject({ success: false, startEffect: 'not_sent' })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.effect).not.toHaveBeenCalled()
  })
  it('marks target/preflight read failures as not sent only while the route has not entered start', async () => {
    mocks.resolve.mockRejectedValueOnce(new PinokioMachineError('pinokio_machine_stale', 'Refresh the saved target.', 409))
    const stale = await post()
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ success: false, startEffect: 'not_sent' })
    mocks.access.mockRejectedValueOnce(new Error('Unavailable binding store'))
    const unreadable = await post()
    expect(unreadable.status).toBe(502)
    expect(await unreadable.json()).toMatchObject({ success: false, startEffect: 'not_sent' })
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it.each([
    { local: false, throws: false }, { local: false, throws: true },
    { local: true, throws: false }, { local: true, throws: true }
  ])('does not attest no-send after start service entry %j', async ({ local: isLocal, throws }) => {
    let payload = body()
    if (isLocal) {
      delete artifact.metadata.pinokio_machine_id
      delete binding.machineId
      const preview = await (await previewGet(event('/api/pinokio/apps/start?artifactId=art'))).json()
      payload = body({ machineId: 'local', revision: 0, bindingFingerprint: preview.bindingFingerprint, launchFingerprint: preview.launchFingerprint })
    }
    mocks.start.mockImplementation(async () => {
      mocks.effect()
      if (throws) throw new PinokioMachineError('pinokio_machine_stale', 'The reply was lost.', 409)
      return { ok: false, kind: 'refused', code: 'native_refusal', message: 'Native request was refused.' }
    })
    const response = await post(payload)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.json()).not.toHaveProperty('startEffect')
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.effect).toHaveBeenCalledOnce()
  })
  it('derives the effect from the saved artifact, and supplies only the server-owned admission', async () => {
    const response = await post(body({ appId: 'evil.git', userId: 'other', admitStart: true, skip_requirements: true }))
    expect(await response.json()).toMatchObject({ success: true, machineId: id, machineRevision: 1, endpointReady: true })
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', appId: 'app.git', machineId: id, revision: 1, launchFingerprint: nativeFingerprint, admitStart: expect.any(Function), signal: expect.any(AbortSignal) }))
    expect(mocks.owner).toHaveBeenCalledWith('user:owner:data', '$.id')
  })
  it.each(['rebind', 'owner', 'restore'])('rejects %s loss during awaited native preparation', async reason => {
    let hold: ReturnType<typeof fencePinokioOperations> | undefined
    mocks.start.mockImplementation(async input => {
      if (reason === 'rebind') artifact.metadata.pinokio_app_id = 'changed.git'
      if (reason === 'owner') mocks.owner.mockResolvedValue([])
      if (reason === 'restore') hold = fencePinokioOperations()
      if (await input.admitStart() !== true) return { ok: false, kind: 'refused', code: 'pinokio_remote_start_not_admitted', message: 'Start admission was lost.' }
      mocks.effect()
      throw new Error('Unreachable effect')
    })
    try { expect((await post()).status).toBeGreaterThanOrEqual(400); expect(mocks.effect).not.toHaveBeenCalled() }
    finally { hold?.release() }
  })
  it.each(['blocked', 'cancelled'])('keeps native %s scoped/visible without probing or treating it as app readiness', async nativeControlOutcome => {
    mocks.start.mockResolvedValue({ ok: true, value: { appId: 'app.git', machineId: id, machineRevision: 1, launchState: 'unknown', nativeControlOutcome, ready: false } })
    const result = await (await post()).json()
    expect(result).toMatchObject({ success: true, machineId: id, machineRevision: 1, nativeControlOutcome, endpointReady: false })
    expect(result).not.toHaveProperty('startEffect')
    expect(mocks.endpoint).not.toHaveBeenCalled()
  })
  it('does not convert a target-mismatched native response into a ready result', async () => {
    mocks.start.mockResolvedValue({ ok: true, value: { appId: 'app.git', machineId: 'local', machineRevision: 0, ready: true } })
    const response = await post()
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: 'pinokio_start_unknown', machineId: id })
    expect(mocks.endpoint).not.toHaveBeenCalled()
  })
  it('rejects the two-field local bypass after a saved-app rebind, and accepts only fresh local preview custody', async () => {
    delete artifact.metadata.pinokio_machine_id
    delete binding.machineId
    const preview = await (await previewGet(event('/api/pinokio/apps/start?artifactId=art'))).json()
    artifact.metadata.pinokio_app_id = 'changed.git'
    binding.appId = 'changed.git'
    // Same dependency set cannot authorize the new saved app without its own preview.
    expect((await post({ artifactId: 'art', alsoStarts: ['dep.git'] })).status).toBe(409)
    expect((await post({ artifactId: 'art', alsoStarts: preview.alsoStarts, machineId: 'local', revision: 0, bindingFingerprint: preview.bindingFingerprint, launchFingerprint: preview.launchFingerprint })).status).toBe(409)
    expect(mocks.effect).not.toHaveBeenCalled()
    artifact.metadata.pinokio_app_id = 'app.git'
    binding.appId = 'app.git'
    const current = await (await previewGet(event('/api/pinokio/apps/start?artifactId=art'))).json()
    const response = await post({ artifactId: 'art', alsoStarts: current.alsoStarts, machineId: 'local', revision: 0, bindingFingerprint: current.bindingFingerprint, launchFingerprint: current.launchFingerprint })
    expect(response.status).toBe(200)
    expect(mocks.start).toHaveBeenLastCalledWith({ appId: 'app.git', alsoStarts: ['dep.git'] })
  })
  it('enforces matching modern local preview inventory and requires custody on every call', async () => {
    delete artifact.metadata.pinokio_machine_id
    delete binding.machineId
    const preview = await (await previewGet(event('/api/pinokio/apps/start?artifactId=art'))).json()
    expect(preview).toMatchObject({ machineId: 'local', machineRevision: 0, launchFingerprint: expect.any(String) })
    mocks.preview.mockResolvedValue({ ok: true, value: { appId: 'app.git', alsoStarts: ['new.git'] } })
    const response = await post({ artifactId: 'art', machineId: 'local', revision: 0, alsoStarts: ['dep.git'], bindingFingerprint: preview.bindingFingerprint, launchFingerprint: preview.launchFingerprint })
    expect(response.status).toBe(409)
    expect(mocks.effect).not.toHaveBeenCalled()
  })
  it.each([{ authorization: 'Bearer token' }, { origin: 'null' }, { origin: 'https://elsewhere.test' }])('preserves session/origin refusal %j', async headers => {
    expect((await post(body(), { headers: { 'content-type': 'application/json', ...headers } })).status).toBe(403)
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
