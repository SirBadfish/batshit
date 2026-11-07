// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../tests/fixtures/pinokio/remote/native-8.2.0.json'
import capturedLogs from '../../tests/fixtures/pinokio/logs-before-run.json'
import { __setPinokioRemoteReadDepsForTests, fencePinokioRemoteStarts, pinokioRemoteProvider, type PinokioNativeSocket } from '../pinokioRemoteProvider'
import { PinokioMachineError } from '../pinokioMachineService'
import type { PinokioRemoteMachine } from '$lib/pinokio/machines'
import { __setPinokioDepsForTests, getPinokioAppLogs, getPinokioAppStatus, getPinokioTargetStatus, searchPinokioApps, previewPinokioAppStart, startPinokioApp } from '../pinokioService'
import { closeRegisteredRuntimeResources } from '../runtimeShutdown'

const machineId = '12345678-1234-4123-8123-123456789abc'
const target: PinokioRemoteMachine & { kind: 'remote' } = {
  id: machineId, label: 'PC', controlHost: '192.168.1.20', controlPort: 42000, controlProtocol: 'http' as const,
  version: 1, revision: 1, bindingState: 'confirmed' as const, kind: 'remote' as const
}
const input = { userId: 'owner', machineId }
const clone = <T>(value: T): T => structuredClone(value)

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
function node(id: string, requires: string[] = []) {
  const status = clone(fixture.status)
  status.app_id = id
  status.path = 'C:\\Pinokio\\api\\' + id
  status.default_target = status.path + '\\start.js'
  status.ref = 'pinokio://192.168.1.20:42000/api/' + id
  const candidates = clone(fixture.candidates)
  candidates.app.id = id
  candidates.app.workspace_path = status.path
  candidates.app.launcher_path = status.path
  candidates.app.env_path = status.path + '\\ENVIRONMENT'
  candidates.app.autolaunch_depends = requires as never[]
  return { status, candidates }
}
function setup(respond?: (url: URL) => Response | Promise<Response>) {
  const resolve = vi.fn(async () => ({ ...target }))
  const resolveCurrent = vi.fn(async () => ({ ...target }))
  const fetcher = vi.fn(async (request: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(request))
    if (url.pathname === '/pinokio/version') return json(fixture.version)
    if (respond) return respond(url)
    if (url.pathname === '/apps/status/comfy.git') return json(fixture.status)
    if (url.pathname === '/autolaunch/candidates') return json(fixture.candidates)
    if (url.pathname === '/apps/logs/comfy.git') return json(fixture.logs)
    if (url.pathname === '/apps/search') return json({ q: url.searchParams.get('q'), apps: [{ ...fixture.status, description: 'Images' }] })
    throw new Error('Unexpected test request ' + url.pathname)
  })
  __setPinokioRemoteReadDepsForTests({ resolve, resolveCurrent, fetch: fetcher as typeof fetch })
  return { resolve, resolveCurrent, fetcher }
}
afterEach(() => {
  __setPinokioRemoteReadDepsForTests(null)
  __setPinokioDepsForTests(null)
  vi.restoreAllMocks()
})

describe('saved remote Pinokio reads without a caller-side Pinokio installation', () => {
  it('uses only the authenticated saved origin with manual redirects and no credentials', async () => {
    const { fetcher, resolveCurrent, resolve } = setup()
    __setPinokioDepsForTests({
      platform: 'win32', containerized: () => true,
      homedir: () => { throw new Error('No local HOME lookup') },
      readFile: async () => { throw new Error('No local config read') },
      tcpReachable: async () => { throw new Error('No local daemon probe') },
      pathEnv: () => { throw new Error('No local PATH') }
    })
    const result = await getPinokioAppStatus({ ...input, appId: 'comfy.git' })
    expect(result).toMatchObject({ ok: true, value: { appId: 'comfy.git', machineId, machineRevision: 1, path: fixture.status.path } })
    expect(result.ok && Object.hasOwn(result.value, 'defaultTarget')).toBe(false)
    expect(resolveCurrent).toHaveBeenCalledWith('owner', machineId)
    expect(resolve).toHaveBeenCalledWith('owner', { machineId, revision: 1 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('http://192.168.1.20:42000')
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/json' } })
      expect(Object.keys(init!.headers!)).toEqual(['Accept'])
    }
  })

  it('returns actual target version status and supports a server-only native version response', async () => {
    setup()
    expect(await getPinokioTargetStatus(input)).toMatchObject({ ok: true, value: { available: true, kind: 'remote', version: '8.2.0', pinokiodVersion: '8.2.0' } })
    const world = setup()
    world.fetcher.mockImplementation(async () => json({ pinokiod: '8.2.0' }))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: true, value: { version: null, pinokiodVersion: '8.2.0' } })
  })

  it('preserves HTTPS instead of downgrading it', async () => {
    const { resolve, resolveCurrent, fetcher } = setup()
    resolve.mockResolvedValue({ ...target, controlProtocol: 'https' })
    resolveCurrent.mockResolvedValue({ ...target, controlProtocol: 'https' })
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: true })
    expect(String(fetcher.mock.calls[0][0])).toBe('https://192.168.1.20:42000/pinokio/version')
  })

  it('refuses malformed explicit targets and missing users without local fallback or network', async () => {
    const { fetcher } = setup()
    for (const bad of [
      { machineId }, { userId: 'owner', machineId: null }, { userId: 'owner', revision: 1 }, { userId: 'owner', machineId: 'local', revision: 1 }
    ]) {
      expect(await searchPinokioApps(bad as never)).toMatchObject({ ok: false, kind: 'refused' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses stale/deleted/restored bindings and a failed registry read', async () => {
    const { resolveCurrent, fetcher } = setup()
    for (const code of ['pinokio_machine_changed', 'pinokio_machine_missing', 'pinokio_machine_confirmation_required', 'pinokio_machine_registry_invalid']) {
      resolveCurrent.mockRejectedValueOnce(new PinokioMachineError(code, 'Saved connection unavailable', 409))
      expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, code })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('checks the expected revision after awaited reads and rejects an edited target', async () => {
    const { resolve, fetcher } = setup()
    resolve.mockRejectedValueOnce(new PinokioMachineError('pinokio_machine_changed', 'Changed', 409))
    expect(await pinokioRemoteProvider.appStatus({ ...input, revision: 1, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_machine_changed' })
    // Expected-revision admission failed before a request was made.
    expect(fetcher).not.toHaveBeenCalled()
    resolve.mockResolvedValueOnce({ ...target }).mockRejectedValueOnce(new PinokioMachineError('pinokio_machine_changed', 'Changed', 409))
    expect(await pinokioRemoteProvider.appStatus({ ...input, revision: 1, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_machine_changed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('bounds discovery to the selected node and returns machine-qualified results', async () => {
    const { fetcher } = setup()
    expect(await searchPinokioApps({ ...input, query: 'images', limit: 4 })).toMatchObject({ ok: true, value: { machineId, apps: [{ appId: 'comfy.git' }], skippedRemote: 0 } })
    const url = new URL(String(fetcher.mock.calls[1][0]))
    expect(url.pathname).toBe('/apps/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'images', limit: '4', peer_scope: 'local', include_peers: '0' })
  })

  it('vouches for an installed app before logs and preserves bounded clean output', async () => {
    const { fetcher } = setup()
    expect(await getPinokioAppLogs({ ...input, appId: 'comfy.git', tail: 20 })).toMatchObject({ ok: true, value: { machineId, appId: 'comfy.git', lines: ['first', 'second'] } })
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/pinokio/version', '/apps/status/comfy.git', '/apps/logs/comfy.git'])
  })

  it('reads the native api source from the retained real P0 log capture', async () => {
    const nativeLogs = JSON.parse(capturedLogs.stdout)
    expect(nativeLogs.source).toBe('api')
    setup((url) => json(url.pathname === '/apps/logs/comfy.git' ? nativeLogs : fixture.status))
    expect(await getPinokioAppLogs({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: true, value: { appId: 'comfy.git', lineCount: 104 } })
  })

  it('also accepts the native shell log kind', async () => {
    setup((url) => json(url.pathname === '/apps/logs/comfy.git' ? { ...fixture.logs, source: 'shell' } : fixture.status))
    expect(await getPinokioAppLogs({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: true })
  })

  it.each([{ local: false, host: '10.0.0.2' }, { local: true }, '', 'other'])('refuses an object/unknown log source %j', async (source) => {
    const { fetcher } = setup((url) => json(url.pathname === '/apps/logs/comfy.git' ? { ...fixture.logs, source } : fixture.status))
    expect(await getPinokioAppLogs({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_remote_source' })
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === 'http://192.168.1.20:42000')).toBe(true)
  })

  it('does not read logs if the preceding installed-app status came from a peer', async () => {
    const { fetcher } = setup(() => json({ ...fixture.status, source: { local: false, host: '10.0.0.2' } }))
    expect(await getPinokioAppLogs({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_remote_source' })
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/pinokio/version', '/apps/status/comfy.git'])
  })
})

describe('native projection, app identity and path admission', () => {
  it('preserves the exact Windows default and explicitly unattested dependency projection', async () => {
    setup()
    const result = await pinokioRemoteProvider.candidates({ ...input, appId: 'comfy.git' })
    expect(result).toMatchObject({ ok: true, value: { nativePath: { style: 'win32', root: fixture.status.path }, configuredScript: 'start.js', startupEnabled: false, dependencyRead: 'native_projection_unattested' } })
  })

  it('follows the declared recursive graph in postorder and distinguishes effective native preparation', async () => {
    const nodes = { 'comfy.git': node('comfy.git', ['a.git', 'b.git']), 'a.git': node('a.git', ['shared.git']), 'b.git': node('b.git', ['shared.git']), 'shared.git': node('shared.git') }
    setup((url) => {
      if (url.pathname === '/autolaunch/candidates') return json(nodes[url.searchParams.get('app') as keyof typeof nodes].candidates)
      return json(nodes[decodeURIComponent(url.pathname.split('/').pop()!) as keyof typeof nodes].status)
    })
    const result = await pinokioRemoteProvider.graph({ ...input, appId: 'comfy.git' })
    expect(result).toMatchObject({ ok: true, value: { declaredAlsoStarts: ['a.git', 'b.git', 'shared.git'], effectiveAlsoStarts: ['a.git', 'b.git', 'shared.git'], dependencyRead: 'native_projection_unattested' } })
    if (result.ok) expect(result.value.nodes.map((entry) => entry.status.appId)).toEqual(['shared.git', 'a.git', 'b.git', 'comfy.git'])
    nodes['comfy.git'].candidates.app.autolaunch = 'other.js'
    nodes['comfy.git'].candidates.current = 'other.js'
    expect(await pinokioRemoteProvider.graph({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: true, value: { declaredAlsoStarts: ['a.git', 'b.git', 'shared.git'], effectiveAlsoStarts: [] } })
  })

  it('refuses cycles and a missing configured dependency script rather than omitting them', async () => {
    const root = node('comfy.git', ['dep.git'])
    const dep = node('dep.git', ['comfy.git'])
    setup((url) => json(url.pathname === '/autolaunch/candidates'
      ? (url.searchParams.get('app') === 'comfy.git' ? root.candidates : dep.candidates)
      : (url.pathname.endsWith('/comfy.git') ? root.status : dep.status)))
    expect(await pinokioRemoteProvider.graph({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_remote_dependencies' })
    dep.candidates.app.autolaunch_depends = []
    dep.candidates.app.autolaunch = ''
    dep.candidates.current = ''
    expect(await pinokioRemoteProvider.graph({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_remote_dependencies' })
  })

  it('refuses an install default or a selected script absent from native candidates', async () => {
    const root = node('comfy.git')
    root.status.default_target = root.status.path + '\\install.js'
    root.status.default_script = 'install.js'
    setup((url) => json(url.pathname === '/autolaunch/candidates' ? root.candidates : root.status))
    expect(await pinokioRemoteProvider.graph({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_remote_install_default' })
    root.status.default_target = root.status.path + '\\unknown.js'
    root.status.default_script = 'unknown.js'
    expect(await pinokioRemoteProvider.graph({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code: 'pinokio_remote_path' })
  })

  const refusedStatuses: Array<[string, Record<string, unknown>, string]> = [
    ['app ID', { app_id: 'other.git' }, 'pinokio_remote_app_mismatch'],
    ['peer source', { source: { local: false } }, 'pinokio_remote_source'],
    ['outside native root', { path: 'C:\\Pinokio\\outside\\comfy.git' }, 'pinokio_remote_path'],
    ['escaping default', { default_target: 'C:\\Pinokio\\api\\other.git\\start.js' }, 'pinokio_remote_path'],
    ['app ref', { ref: 'pinokio://192.168.1.20:42000/api/other.git' }, 'pinokio_remote_app_mismatch'],
    ['unknown state', { state: 'asleep' }, 'pinokio_remote_shape']
  ]
  it.each(refusedStatuses)('refuses a mismatched %s', async (_label, patch, code) => {
    setup(() => json({ ...fixture.status, ...patch }))
    expect(await pinokioRemoteProvider.appStatus({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, code })
  })

  it('never routes through a returned ref host and filters unrelated advertised addresses', async () => {
    const { fetcher } = setup(() => json({
      ...fixture.status, ref: 'pinokio://10.0.0.2:42000/api/comfy.git',
      external_ready_urls: [
        { url: 'http://192.168.1.20:8188/', transport: 'ip', scope: 'lan' },
        { url: 'http://192.168.1.99:8188/', transport: 'ip', scope: 'lan' },
        { url: 'https://example.com/app', transport: 'ip', scope: 'unknown' }
      ]
    }))
    expect(await pinokioRemoteProvider.appStatus({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: true, value: { externalReadyUrls: ['http://192.168.1.20:8188/'], excludedExternalReadyUrls: 2 } })
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname === target.controlHost)).toBe(true)
  })
})

describe('bounded transport failures', () => {
  it.each([301, 302, 307, 308])('does not follow HTTP%s redirects or consume their destination', async (status) => {
    const { fetcher } = setup()
    fetcher.mockImplementation(async () => new Response('redirect', { status, headers: { location: 'http://127.0.0.1/secret' } }))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, kind: 'refused', code: 'pinokio_remote_redirect' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('makes no request for an already cancelled read', async () => {
    const { fetcher } = setup()
    expect(await pinokioRemoteProvider.detect({ ...input, signal: AbortSignal.abort() })).toMatchObject({ ok: false, code: 'pinokio_remote_cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('ends a stalled read at the finite network deadline', async () => {
    vi.useFakeTimers()
    try {
      const { fetcher } = setup()
      fetcher.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
      const result = pinokioRemoteProvider.detect(input)
      await vi.advanceTimersByTimeAsync(15_001)
      expect(await result).toMatchObject({ ok: false, kind: 'unavailable', code: 'pinokio_remote_timeout' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('cancels an active body and does not return a partial answer', async () => {
    const controller = new AbortController()
    const cancelled = vi.fn()
    const { fetcher } = setup()
    fetcher.mockImplementation(async (_url, init) => {
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"pinokiod":'))
          init!.signal!.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true })
          controller.abort()
        },
        cancel: cancelled
      }), { headers: { 'content-type': 'application/json' } })
    })
    expect(await pinokioRemoteProvider.detect({ ...input, signal: controller.signal })).toMatchObject({ ok: false, code: 'pinokio_remote_cancelled' })
  })

  it('bounds advertised and streamed response size and hides raw bad response content', async () => {
    const { fetcher } = setup()
    fetcher.mockImplementation(async () => new Response('private upstream content', { headers: { 'content-type': 'application/json', 'content-length': '5000000' } }))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, code: 'pinokio_remote_size' })
    fetcher.mockImplementation(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }))
    const oversized = await pinokioRemoteProvider.detect(input)
    expect(oversized).toMatchObject({ ok: false, code: 'pinokio_remote_size' })
    expect(JSON.stringify(oversized)).not.toContain('private upstream content')
  })

  it('reports old/unknown versions, malformed JSON, HTTP failures and connection failures visibly', async () => {
    const { fetcher } = setup()
    fetcher.mockImplementation(async () => json({ pinokiod: '8.1.9' }))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, code: 'pinokio_remote_version' })
    fetcher.mockImplementation(async () => json({ pinokiod: '9007199254740992.2.0' }))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, code: 'pinokio_remote_version' })
    fetcher.mockImplementation(async () => new Response('private invalid json', { headers: { 'content-type': 'application/json' } }))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, code: 'pinokio_remote_shape' })
    fetcher.mockImplementation(async () => json({ error: 'private remote diagnostic' }, 403))
    expect(await pinokioRemoteProvider.detect(input)).toMatchObject({ ok: false, kind: 'refused', message: 'Pinokio answered HTTP 403.' })
    fetcher.mockImplementation(async () => { throw new Error('private TLS/socket diagnostic') })
    const result = await pinokioRemoteProvider.detect(input)
    expect(result).toMatchObject({ ok: false, kind: 'unavailable', code: 'pinokio_remote_unreachable' })
    expect(JSON.stringify(result)).not.toContain('private')
  })
})

/** Fixed native WS test seam: no listener, target, app or service is started. */
class NativeSocketFixture extends EventTarget {
  readyState = 1
  send = vi.fn<(data: string) => void>()
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event('close')) })
}
function launchSetup() {
  const root = node('comfy.git')
  let now = 0
  const world = setup((url) => json(url.pathname === '/autolaunch/candidates' ? root.candidates : root.status))
  const socket = new NativeSocketFixture()
  const dispose = vi.fn(async () => { socket.close() })
  const createClient = vi.fn((_url: URL) => ({ socket: socket as unknown as PinokioNativeSocket, dispose }))
  const sleep = vi.fn(async (ms: number) => { now += ms })
  __setPinokioRemoteReadDepsForTests({
    resolve: world.resolve, resolveCurrent: world.resolveCurrent, fetch: world.fetcher as typeof fetch,
    now: () => now, sleep, createClient
  })
  const admitStart = vi.fn(async () => true)
  const selectedRunning = () => {
    root.status.running = true
    root.status.state = 'starting'
    root.status.running_scripts = ['start.js'] as never[]
  }
  const prepare = async () => {
    const result = await previewPinokioAppStart({ ...input, appId: 'comfy.git' })
    if (!result.ok || !result.value.launchFingerprint) throw new Error('Fixture preview failed: ' + JSON.stringify(result))
    return { ...input, appId: 'comfy.git', revision: 1, launchFingerprint: result.value.launchFingerprint, alsoStarts: result.value.alsoStarts, admitStart, waitSeconds: 5 }
  }
  return { ...world, root, socket, dispose, createClient, sleep, admitStart, selectedRunning, prepare, advance: (ms: number) => { now += ms } }
}

describe('one admitted native remote root launch; native requirements stay enabled', () => {
  it('uses server-only preview/start with one native Windows URI and no caller-selected effect fields', async () => {
    const w = launchSetup()
    __setPinokioDepsForTests({ readFile: async () => { throw new Error('No local Pinokio config') }, tcpReachable: async () => { throw new Error('No local daemon') } })
    const launch = await w.prepare()
    w.socket.send.mockImplementation(w.selectedRunning)
    const result = await startPinokioApp({ ...launch, uri: 'https://example.com/install.js', method: 'kernel.api.stop', skip_requirements: true } as typeof launch)
    expect(result).toMatchObject({ ok: true, value: { machineId, machineRevision: 1, launchState: 'pending', ready: false, nativeScriptReady: null, declaredAlsoStarts: [], alsoStarted: [] } })
    expect(w.createClient.mock.calls[0][0].toString()).toBe('ws://192.168.1.20:42000/')
    expect(w.socket.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual([{ uri: 'C:\\Pinokio\\api\\comfy.git\\start.js' }])
    expect(w.dispose).toHaveBeenCalledTimes(1)
    expect(w.admitStart).toHaveBeenCalledTimes(3)
  })

  it('retains HTTPS as WSS with no alternate address from native refs', async () => {
    const w = launchSetup()
    w.resolve.mockResolvedValue({ ...target, controlProtocol: 'https' })
    w.resolveCurrent.mockResolvedValue({ ...target, controlProtocol: 'https' })
    w.root.status.ref = 'pinokio://10.0.0.2:9999/api/comfy.git'
    const launch = await w.prepare()
    await startPinokioApp(launch)
    expect(w.createClient.mock.calls[0][0].toString()).toBe('wss://192.168.1.20:42000/')
  })

  it('fingerprints and derives repeated query input from the native default only', async () => {
    const w = launchSetup()
    w.root.status.default_target += '?mode=small&mode=fast&__proto__=safe'
    w.root.status.default_script += '?mode=small&mode=fast&__proto__=safe'
    const launch = await w.prepare()
    await startPinokioApp(launch)
    expect(JSON.parse(w.socket.send.mock.calls[0][0])).toEqual({ uri: 'C:\\Pinokio\\api\\comfy.git\\start.js', input: JSON.parse('{"mode":["small","fast"],"__proto__":"safe"}') })
  })

  it.each(['install', 'missing', 'HTTP', 'candidate'])('refuses a %s default without synthesizing a fallback', async (kind) => {
    const w = launchSetup()
    if (kind === 'install') { w.root.status.default_target = w.root.status.path + '\\install.js'; w.root.status.default_script = 'install.js' }
    if (kind === 'missing') { w.root.status.default_target = null as never; w.root.status.default_script = null as never }
    if (kind === 'HTTP') { w.root.status.default_target = 'http://192.168.1.20:8188'; w.root.status.default_script = null as never }
    if (kind === 'candidate') w.root.candidates.menu = []
    expect(await previewPinokioAppStart({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: false, kind: 'refused' })
    expect(w.createClient).not.toHaveBeenCalled()
  })

  it('requires exact alsoStarts even when the configured dependencies will not be effective for this default', async () => {
    const w = launchSetup()
    const dep = node('dep.git')
    w.root.candidates.app.autolaunch_depends = ['dep.git'] as never[]
    w.root.status.default_target = w.root.status.path + '\\other.js'
    w.root.status.default_script = 'other.js'
    w.root.candidates.other = [{ ...w.root.candidates.menu[0], script: 'other.js' }] as never[]
    w.fetcher.mockImplementation(async (request) => {
      const url = new URL(String(request))
      if (url.pathname === '/pinokio/version') return json(fixture.version)
      const item = (url.searchParams.get('app') === 'dep.git' || url.pathname.endsWith('/dep.git')) ? dep : w.root
      return json(url.pathname === '/autolaunch/candidates' ? item.candidates : item.status)
    })
    const launch = await w.prepare()
    expect(launch.alsoStarts).toEqual(['dep.git'])
    expect(await startPinokioApp({ ...launch, alsoStarts: [] })).toMatchObject({ ok: false, code: 'pinokio_remote_dependencies' })
    expect(w.socket.send).not.toHaveBeenCalled()
    await startPinokioApp(launch)
    expect(w.socket.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual([{ uri: w.root.status.path + '\\other.js' }])
  })

  it.each(['native root', 'script'])('refuses a fresh %s fingerprint change before send', async (changed) => {
    const w = launchSetup()
    const launch = await w.prepare()
    if (changed === 'native root') {
      w.root.status.path = 'D:\\Pinokio\\api\\comfy.git'
      w.root.status.default_target = w.root.status.path + '\\start.js'
      w.root.candidates.app.workspace_path = w.root.status.path
      w.root.candidates.app.launcher_path = w.root.status.path
    }
    if (changed === 'script') { w.root.status.default_script = 'other.js'; w.root.status.default_target = w.root.status.path + '\\other.js'; w.root.candidates.menu[0].script = 'other.js' }
    const result = await startPinokioApp(launch)
    expect(result).toMatchObject({ ok: false, code: 'pinokio_remote_plan_changed' })
    expect(w.socket.send).not.toHaveBeenCalled()
  })

  it('rereads the whole plan after socket open; a late native default edit cannot send', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.createClient.mockImplementation(() => {
      w.root.status.default_target += '?changed=1'
      w.root.status.default_script += '?changed=1'
      return { socket: w.socket as unknown as PinokioNativeSocket, dispose: w.dispose }
    })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: false, code: 'pinokio_remote_plan_changed' })
    expect(w.socket.send).not.toHaveBeenCalled()
    expect(w.dispose).toHaveBeenCalledOnce()
  })

  it('refuses target revision loss during native socket opening', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.createClient.mockImplementation(() => {
      w.resolve.mockRejectedValue(new PinokioMachineError('pinokio_machine_stale', 'Changed target', 409))
      return { socket: w.socket as unknown as PinokioNativeSocket, dispose: w.dispose }
    })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: false, code: 'pinokio_machine_stale' })
    expect(w.socket.send).not.toHaveBeenCalled()
    expect(w.dispose).toHaveBeenCalledOnce()
  })

  it('requires server admission plus exact preview revision/fingerprint rather than a body flag', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    for (const patch of [{ admitStart: undefined }, { revision: undefined }, { launchFingerprint: undefined }]) {
      expect(await startPinokioApp({ ...launch, ...patch })).toMatchObject({ ok: false, code: 'pinokio_remote_start_input' })
    }
    expect(await startPinokioApp({ ...launch, machineId: null as never })).toMatchObject({ ok: false, code: 'pinokio_machine_invalid' })
    expect(w.createClient).not.toHaveBeenCalled()
  })

  it('keeps unresolved issued records at the capacity boundary instead of evicting one for retry', async () => {
    const w = launchSetup()
    w.createClient.mockImplementation(() => {
      const socket = new NativeSocketFixture()
      socket.send = w.socket.send
      return { socket: socket as unknown as PinokioNativeSocket, dispose: vi.fn(async () => { socket.close() }) }
    })
    w.fetcher.mockImplementation(async (request) => {
      const url = new URL(String(request))
      if (url.pathname === '/pinokio/version') return json(fixture.version)
      const id = url.searchParams.get('app') ?? decodeURIComponent(url.pathname.split('/').at(-1)!)
      const item = node(id)
      return json(url.pathname === '/autolaunch/candidates' ? item.candidates : item.status)
    })
    let firstLaunch: Awaited<ReturnType<typeof w.prepare>> | undefined
    for (let index = 0; index < 129; index += 1) {
      const appId = `app-${index}.git`
      const p = await previewPinokioAppStart({ ...input, appId })
      if (!p.ok) throw new Error('Fixture projection')
      const launch = { ...input, appId, revision: 1, launchFingerprint: p.value.launchFingerprint!, alsoStarts: [], admitStart: w.admitStart, waitSeconds: 5 }
      if (index === 0) firstLaunch = launch
      const result = await startPinokioApp(launch)
      if (index < 128) expect(result).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
      else expect(result).toMatchObject({ ok: false, code: 'pinokio_remote_start_capacity' })
    }
    expect(await startPinokioApp(firstLaunch!)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledTimes(128)
  })

  it.each(['Stop', 'restore', 'owner', 'target'])('refuses %s loss immediately before send and closes only the client', async (reason) => {
    const w = launchSetup()
    const launch = await w.prepare()
    const controller = new AbortController()
    let release: (() => void) | undefined
    w.admitStart.mockImplementation(async () => {
      if (w.admitStart.mock.calls.length === 3) {
        if (reason === 'Stop') controller.abort()
        if (reason === 'restore') release = fencePinokioRemoteStarts()
        if (reason === 'owner') return false
        if (reason === 'target') throw new PinokioMachineError('PINOKIO_MACHINE_STALE', 'Changed target', 409)
      }
      return true
    })
    expect(await startPinokioApp({ ...launch, signal: controller.signal })).toMatchObject({ ok: false, kind: 'refused' })
    expect(w.socket.send).not.toHaveBeenCalled()
    expect(w.dispose).toHaveBeenCalledOnce()
    release?.()
  })

  it('preserves an uncertain send beyond the wait; a second call does not blindly resend', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    const first = await startPinokioApp(launch)
    expect(first).toMatchObject({ ok: true, value: { launchState: 'unknown', ready: false } })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledTimes(1)
    // Actual evidence for this exact script reconciles, not generic app.ready.
    w.selectedRunning()
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { alreadyRunning: true, launchState: 'pending' } })
    expect(w.socket.send).toHaveBeenCalledTimes(1)
  })

  it.each([[undefined, 45_000], [500, 50_000]])('bounds native observation at %s seconds while Pinokio keeps the one issued action', async (waitSeconds, waitedMs) => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(w.selectedRunning)
    expect(await startPinokioApp({ ...launch, waitSeconds })).toMatchObject({ ok: true, value: { launchState: 'pending', waitedMs } })
    expect(w.socket.send).toHaveBeenCalledOnce()
    expect(w.dispose).toHaveBeenCalledOnce()
  })

  it('treats a send exception as uncertain, retaining the no-retry record', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(() => { throw new Error('May have enqueued') })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledTimes(1)
  })

  it('reports a script-correlated native error without returning raw stream data or retrying', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(() => {
      w.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: w.root.status.default_target, type: 'error', data: 'untrusted raw launcher text' }) }))
    })
    const result = await startPinokioApp(launch)
    expect(result).toMatchObject({ ok: true, value: { launchState: 'unknown', ready: false, message: expect.stringContaining('reported an error') } })
    expect(JSON.stringify(result)).not.toContain('untrusted raw launcher text')
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledOnce()
  })

  it.each(['blocked', 'cancelled'])('reports native terminal %s without claiming continuation or retrying', async (action) => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(() => {
      w.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: w.root.status.default_target, type: 'launch.requirements.control', data: { action, reason: 'raw private vendor detail' } }) }))
    })
    const result = await startPinokioApp(launch)
    expect(result).toMatchObject({ ok: true, value: { launchState: 'unknown', nativeControlOutcome: action, ready: false, message: expect.stringContaining('no continuation is claimed') } })
    expect(JSON.stringify(result)).not.toContain('raw private vendor detail')
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown', nativeControlOutcome: action, message: expect.stringContaining('no continuation is claimed') } })
    expect(w.socket.send).toHaveBeenCalledOnce()
  })

  it('does not mask a terminal native error arriving during an awaited ready HTTP status', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    let sent = false
    w.socket.send.mockImplementation(() => { sent = true })
    const original = w.fetcher.getMockImplementation()!
    w.fetcher.mockImplementation(async (request, init) => {
      const url = new URL(String(request))
      if (sent && url.pathname === '/apps/status/comfy.git') {
        w.selectedRunning()
        Object.assign(w.root.status, { ready_script: 'start.js', ready: true, probe: true, state: 'online', ready_url: 'http://localhost:8188', external_ready_urls: [{ transport: 'ip', url: 'http://192.168.1.20:8188/' }] })
        w.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: w.root.status.default_target, type: 'error' }) }))
      }
      return original(request, init)
    })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown', ready: false, message: expect.stringContaining('reported an error') } })
  })

  it('previews and no-ops a normal running Open-link default; only exact recorded script status reconciles uncertainty', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    w.root.status.default_target = 'http://localhost:8188/'
    w.root.status.default_script = null as never
    w.selectedRunning()
    Object.assign(w.root.status, { running_scripts: ['other.js'], ready_script: 'other.js', ready: true, probe: true, state: 'online', ready_url: 'http://localhost:8188', external_ready_urls: [{ transport: 'ip', url: 'http://192.168.1.20:8188/' }] })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown', ready: false } })
    expect(w.socket.send).toHaveBeenCalledOnce()
    w.root.status.running_scripts = ['start.js'] as never[]
    Object.assign(w.root.status, { ready_script: 'start.js' })
    // Public read must reconcile the actual recorded root even though default is HTTP.
    expect(await getPinokioAppStatus({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: true })
    expect(await previewPinokioAppStart({ ...input, appId: 'comfy.git' })).toMatchObject({ ok: true, value: { state: 'online', launchFingerprint: expect.any(String) } })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { alreadyRunning: true, launchState: 'ready', ready: true } })
    expect(w.socket.send).toHaveBeenCalledOnce()
    // After that exact acknowledgement and a later real stop, normal new admission works.
    Object.assign(w.root.status, clone(fixture.status))
    w.socket.readyState = 1
    await startPinokioApp(launch)
    expect(w.socket.send).toHaveBeenCalledTimes(2)
  })

  it('does not reconcile an uncertain root from an identical script at a changed native folder', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    await startPinokioApp(launch)
    w.selectedRunning()
    w.root.status.path = 'D:\\Pinokio\\api\\comfy.git'
    w.root.status.default_target = 'http://localhost:8188/'
    w.root.status.default_script = null as never
    await getPinokioAppStatus({ ...input, appId: 'comfy.git' })
    Object.assign(w.root.status, clone(fixture.status))
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledOnce()
  })

  it('does not turn same-named script reachability at a changed native root into issued-root readiness', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(() => {
      w.selectedRunning()
      w.root.status.path = 'D:\\Pinokio\\api\\comfy.git'
      w.root.status.default_target = w.root.status.path + '\\start.js'
      Object.assign(w.root.status, { ready_script: 'start.js', ready: true, probe: true, state: 'online', ready_url: 'http://localhost:8188', external_ready_urls: [{ transport: 'ip', url: 'http://192.168.1.20:8188/' }] })
    })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown', ready: false } })
  })

  it('does not reapprove incidental candidate state or a dependency Open default when launch intent is unchanged', async () => {
    const w = launchSetup()
    const dep = node('dep.git')
    w.root.candidates.app.autolaunch_depends = ['dep.git'] as never[]
    w.fetcher.mockImplementation(async (request) => {
      const url = new URL(String(request))
      if (url.pathname === '/pinokio/version') return json(fixture.version)
      const item = url.searchParams.get('app') === 'dep.git' || url.pathname.endsWith('/dep.git') ? dep : w.root
      return json(url.pathname === '/autolaunch/candidates' ? item.candidates : item.status)
    })
    const launch = await w.prepare()
    w.root.candidates.menu.push({ ...w.root.candidates.menu[0], script: 'unrelated.js', menu_default: false })
    w.root.candidates.menu[0].menu_default = false
    w.root.candidates.menu[0].has_params = true
    dep.status.default_target = 'http://localhost:9999/'
    dep.status.default_script = null as never
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledOnce()
  })

  it('does not confuse unrelated/stale aggregate HTTP readiness with the selected root', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(() => {
      w.root.status.running = true
      w.root.status.ready = true
      w.root.status.probe = true as never
      w.root.status.state = 'online'
      w.root.status.running_scripts = ['other.js'] as never[]
      Object.assign(w.root.status, { ready_script: 'other.js', ready_url: 'http://localhost:8188', external_ready_urls: [{ transport: 'ip', url: 'http://192.168.1.20:8188/' }] })
    })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown', ready: false, readyUrl: null } })
  })

  it('reports exact-script HTTP probe separately from native completion and caller-side reachability', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.socket.send.mockImplementation(() => {
      w.selectedRunning()
      Object.assign(w.root.status, { ready_script: 'start.js', ready: true, probe: true, state: 'online', ready_url: 'http://localhost:8188', external_ready_urls: [{ transport: 'ip', url: 'http://192.168.1.20:8188/' }] })
    })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'ready', ready: true, readiness: 'native_http_probe', nativeScriptReady: null, readyUrl: 'http://192.168.1.20:8188/' } })
  })

  it('shares one admitted flight; an invalid alsoStarts caller cannot join', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    w.sleep.mockImplementationOnce(async (ms) => { await held; /* next sleep advances the clock */ })
    const first = startPinokioApp(launch)
    await vi.waitFor(() => expect(w.socket.send).toHaveBeenCalledOnce())
    expect(await startPinokioApp({ ...launch, alsoStarts: ['extra.git'] })).toMatchObject({ ok: false, code: 'pinokio_remote_dependencies' })
    const second = startPinokioApp(launch)
    await vi.waitFor(() => expect(w.admitStart.mock.calls.length).toBeGreaterThanOrEqual(4))
    release()
    expect(await second).toEqual(await first)
    expect(w.socket.send).toHaveBeenCalledOnce()
  })

  it.each(['Stop', 'deadline'])('detaches a joining caller on its own %s without cancelling another flight', async (reason) => {
    const w = launchSetup()
    const launch = await w.prepare()
    const controller = new AbortController()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    w.sleep.mockImplementationOnce(async () => { await held })
    const first = startPinokioApp({ ...launch, waitSeconds: 50 })
    await vi.waitFor(() => expect(w.socket.send).toHaveBeenCalledOnce())
    if (reason === 'deadline') vi.useFakeTimers()
    try {
      const second = startPinokioApp({ ...launch, waitSeconds: 5, signal: controller.signal })
      await vi.waitFor(() => expect(w.admitStart.mock.calls.length).toBeGreaterThanOrEqual(4))
      if (reason === 'Stop') controller.abort()
      else { w.advance(5_000); await vi.advanceTimersByTimeAsync(5_000) }
      expect(await second).toMatchObject({ ok: true, value: { launchState: 'unknown', observationEnded: reason === 'Stop' ? 'cancelled' : 'timeout' } })
      expect(w.dispose).not.toHaveBeenCalled()
      expect(w.socket.send).toHaveBeenCalledOnce()
    } finally {
      if (reason === 'deadline') vi.useRealTimers()
      release()
    }
    expect(await first).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.dispose).toHaveBeenCalledOnce()
  })

  it('shutdown/Stop after send ends observation without a native stop or another root send', async () => {
    const w = launchSetup()
    const launch = await w.prepare()
    w.sleep.mockImplementationOnce(async () => { await closeRegisteredRuntimeResources('fixture shutdown') })
    expect(await startPinokioApp(launch)).toMatchObject({ ok: true, value: { launchState: 'unknown' } })
    expect(w.socket.send).toHaveBeenCalledTimes(1)
    expect(w.dispose).toHaveBeenCalledOnce()
    expect(await startPinokioApp(launch)).toMatchObject({ ok: false, code: 'pinokio_remote_start_fenced' })
  })
})
