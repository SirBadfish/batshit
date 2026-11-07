import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getPinokioAppStatusMock = vi.hoisted(() => vi.fn())
const machines = vi.hoisted(() => ({ resolveCurrent: vi.fn(), resolve: vi.fn() }))
vi.mock('../pinokioMachineService', () => ({ pinokioMachineService: machines }))
afterEach(() => vi.unstubAllGlobals())

vi.mock('../pinokioService', () => ({
  getPinokioAppStatus: getPinokioAppStatusMock
}))

import {
  describePinokioAppApi,
  forgetPinokioAppEndpoint,
  pinokioEndpointAgentMessage,
  pinokioReadyUrlToBase,
  resolvePinokioAppEndpoint,
  summarizeGradioInfo
} from '../pinokioAppEndpoint'

/** SA-072 P2 (DL-10): the address is asked for on every call, never stored. */

function status(overrides: Record<string, unknown>) {
  return {
    ok: true,
    value: {
      appId: 'comfy.git',
      title: 'Comfyui',
      state: 'online',
      running: true,
      ready: true,
      readyUrl: 'http://localhost:8188',
      probe: true,
      path: '/Users/tester/pinokio/api/comfy.git',
      lastError: null,
      ...overrides
    }
  }
}

describe('resolvePinokioAppEndpoint', () => {
  beforeEach(() => {
    getPinokioAppStatusMock.mockReset()
    forgetPinokioAppEndpoint()
  })

  it('asks pterm status --probe and calls the IPv4 loopback origin', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({}))
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toEqual({
      ok: true,
      appId: 'comfy.git',
      title: 'Comfyui',
      baseUrl: 'http://127.0.0.1:8188',
      nativeReadyOrigins: ['http://localhost:8188']
    })
    expect(getPinokioAppStatusMock).toHaveBeenCalledWith({ appId: 'comfy.git', probe: true })
  })

  it('preserves the exact reported local alias through normalized endpoint and Gradio file delivery', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({ appId: 'ocr.git', title: 'OCR', readyUrl: 'http://localhost:7860' }))
    const endpoint = await resolvePinokioAppEndpoint('ocr.git')
    if (!endpoint.ok) throw new Error('missing local endpoint')
    expect(endpoint.baseUrl).toBe('http://127.0.0.1:7860')
    expect(endpoint.nativeReadyOrigins).toEqual(['http://localhost:7860'])
    const { runPinokioAppArtifact } = await import('../pinokioAppRunner')
    const appFetch = vi.fn(async (resource: any) => {
      const url = String(resource)
      if (url.endsWith('/config')) return Response.json({ version: '5', api_prefix: '/gradio_api' })
      if (url.endsWith('/call/predict')) return Response.json({ event_id: 'event' })
      if (url.endsWith('/call/predict/event')) return new Response('event: complete\ndata: [{"url":"http://localhost:7860/gradio_api/file=/tmp/out.png"},{"url":"https://foreign.example/gradio_api/file=/tmp/foreign.png"}]\n\n')
      if (url === 'http://127.0.0.1:7860/gradio_api/file=/tmp/out.png') return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })
      throw new Error(`unexpected app fetch ${url}`)
    })
    const metadata = { runtime_manager: 'pinokio', pinokio_app_id: 'ocr.git', source_type: 'gradio', pinokio_runtime: { api_name: '/predict', inputs: [] } }
    const files = vi.fn(async () => {})
    await runPinokioAppArtifact({ artifactId: 'a', binding: { appId: 'ocr.git', kind: 'gradio', runtime: metadata.pinokio_runtime }, metadata, values: {} }, { chunk: async () => {}, file: files }, {
      fetch: appFetch as unknown as typeof fetch, resolveEndpoint: async () => endpoint, sleep: async () => {}, now: () => 0, randomSeed: () => 1, batshitUploadOrigins: () => [], readClip: async () => null
    })
    expect(files).toHaveBeenCalledTimes(1)
    expect(files.mock.calls[0]).toEqual([expect.objectContaining({ mediaType: 'image/png', base64: 'data:image/png;base64,AQI=' }), 0])
    expect(appFetch.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:7860/'))).toBe(true)
  })

  it('keeps an online answer for a few seconds and never keeps an offline one', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({}))
    await resolvePinokioAppEndpoint('comfy.git')
    await resolvePinokioAppEndpoint('comfy.git')
    expect(getPinokioAppStatusMock).toHaveBeenCalledTimes(1)
    forgetPinokioAppEndpoint('comfy.git')

    getPinokioAppStatusMock.mockResolvedValue(status({ state: 'offline', running: false, ready: false, readyUrl: null, probe: false }))
    await resolvePinokioAppEndpoint('comfy.git')
    await resolvePinokioAppEndpoint('comfy.git')
    expect(getPinokioAppStatusMock).toHaveBeenCalledTimes(3)
  })

  it('answers app_offline for offline, starting, and online-but-not-answering', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({ state: 'offline', running: false, ready: false, probe: false }))
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toMatchObject({
      ok: false,
      code: 'app_offline',
      status: 503,
      state: 'offline',
      message: 'Comfyui is not running in Pinokio.'
    })
    getPinokioAppStatusMock.mockResolvedValue(status({ state: 'starting', ready: false, probe: false }))
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toMatchObject({ code: 'app_offline', state: 'starting' })
    getPinokioAppStatusMock.mockResolvedValue(status({ probe: false }))
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toMatchObject({ code: 'app_offline', state: 'starting' })
  })

  it('maps Pinokio failures to typed codes', async () => {
    getPinokioAppStatusMock.mockResolvedValue({ ok: false, kind: 'unavailable', reason: 'not_running', message: 'Pinokio is installed but not running.' })
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toMatchObject({ code: 'pinokio_unavailable', status: 503, reason: 'not_running' })
    getPinokioAppStatusMock.mockResolvedValue({ ok: false, kind: 'not_found', message: 'app not found' })
    await expect(resolvePinokioAppEndpoint('x.git')).resolves.toMatchObject({ code: 'app_not_found', status: 404 })
    getPinokioAppStatusMock.mockResolvedValue({ ok: false, kind: 'refused', message: 'That app belongs to another Pinokio machine.' })
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toMatchObject({ code: 'app_refused', status: 400 })
  })

  it('refuses a ready URL outside this computer and the private network', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({ readyUrl: 'https://example.com:8188' }))
    await expect(resolvePinokioAppEndpoint('comfy.git')).resolves.toMatchObject({ ok: false, code: 'app_refused' })
  })

  it('tells an agent the next step', () => {
    expect(
      pinokioEndpointAgentMessage({ ok: false, code: 'app_offline', status: 503, appId: 'comfy.git', title: 'Comfyui', state: 'starting', message: 'Comfyui is still starting in Pinokio.' })
    ).toContain('fabric:sys.pinokio.app_status')
  })
})

describe('pinokioReadyUrlToBase', () => {
  it.each([
    ['http://localhost:8188', 'http://127.0.0.1:8188'],
    ['http://127.0.0.1:7860/?__theme=dark', 'http://127.0.0.1:7860'],
    ['http://192.168.1.10:7860/ui/', 'http://192.168.1.10:7860'],
    ['http://mac.local:9000', 'http://mac.local:9000'],
    ['http://[::1]:7860', 'http://[::1]:7860'],
    ['https://example.com', null],
    ['file:///etc/passwd', null],
    ['not a url', null],
    [null, null]
  ])('%s -> %s', (input, expected) => {
    expect(pinokioReadyUrlToBase(input as string | null)).toBe(expected)
  })
})

describe('describePinokioAppApi', () => {
  const gradioInfo = {
    named_endpoints: {
      '/predict': {
        parameters: [
          { label: 'Image', parameter_name: 'image', parameter_has_default: false, python_type: { type: 'filepath' }, component: 'Image' },
          { label: 'Max tokens', parameter_name: 'max_tokens', parameter_has_default: true, parameter_default: 1024, python_type: { type: 'float' }, component: 'Slider' }
        ],
        returns: [{ label: 'Text', python_type: { type: 'str' }, component: 'Textbox' }]
      }
    },
    unnamed_endpoints: {}
  }

  it('lists a Gradio app\'s endpoints in the recipe\'s terms', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:7860/config') return Response.json({ version: '5.9.1', api_prefix: '/gradio_api', components: [] })
      if (url === 'http://127.0.0.1:7860/gradio_api/info') return Response.json(gradioInfo)
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const api = await describePinokioAppApi('http://127.0.0.1:7860', fetchImpl)
    expect(api).toMatchObject({ kind: 'gradio', apiPrefix: '/gradio_api' })
    expect(summarizeGradioInfo(gradioInfo)).toEqual([
      {
        api_name: '/predict',
        parameters: [
          { name: 'image', label: 'Image', component: 'Image', type: 'filepath', required: true },
          { name: 'max_tokens', label: 'Max tokens', component: 'Slider', type: 'float', required: false, default: 1024 }
        ],
        returns: [{ position: 0, label: 'Text', component: 'Textbox', type: 'str' }]
      }
    ])
  })

  it('recognizes ComfyUI and says where to read its workflows', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/system_stats') ? Response.json({ system: { comfyui_version: '0.37.0' } }) : new Response('', { status: 404 })
    ) as unknown as typeof fetch
    const api = await describePinokioAppApi('http://127.0.0.1:8188', fetchImpl)
    expect(api).toMatchObject({ kind: 'comfyui', comfyuiVersion: '0.37.0' })
    expect(api.hint).toContain('fabric:sys.comfyui.workflows (baseUrl: "http://127.0.0.1:8188")')
  })

  it('says custom when neither answers', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(describePinokioAppApi('http://127.0.0.1:9000', fetchImpl)).resolves.toMatchObject({ kind: 'unknown' })
  })
})

const REMOTE_ID = 'd86fbc94-7364-4bbc-bb21-f21627736492'
function remoteTarget(overrides = {}) {
  return { id: REMOTE_ID, label: 'Studio PC', kind: 'remote', revision: 3, version: 4, bindingState: 'confirmed', controlHost: '192.168.1.90', controlPort: 42000, controlProtocol: 'http', ...overrides }
}
describe('saved remote app endpoint policy', () => {
  beforeEach(() => {
    forgetPinokioAppEndpoint()
    machines.resolveCurrent.mockReset().mockResolvedValue(remoteTarget())
    machines.resolve.mockReset().mockResolvedValue(remoteTarget())
    getPinokioAppStatusMock.mockReset().mockResolvedValue(status({ readyUrl: 'http://127.0.0.1:7860', externalReadyUrls: ['http://192.168.1.90:7777/ui'] }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ready')))
  })
  const resolve = (extra = {}) => resolvePinokioAppEndpoint('comfy.git', { userId: 'josh', machineId: REMOTE_ID, ...extra })
  it('uses only an advertised saved-IP app origin and proves Batshit-side reachability', async () => {
    const endpoint = await resolve()
    expect(endpoint).toMatchObject({ ok: true, baseUrl: 'http://192.168.1.90:7777', machineId: REMOTE_ID, machineRevision: 3, nativeReadyOrigins: ['http://127.0.0.1:7860'] })
    expect(fetch).toHaveBeenCalledWith('http://192.168.1.90:7777/ui', expect.objectContaining({ redirect: 'error', credentials: 'omit' }))
    expect(getPinokioAppStatusMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'josh', machineId: REMOTE_ID, revision: 3 }))
  })
  it('does not use native probe/loopback or the control port as an app endpoint', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({ externalReadyUrls: ['http://127.0.0.1:7860', 'https://public.example/x', 'http://192.168.1.91:8888'] }))
    expect(await resolve()).toMatchObject({ ok: false, code: 'app_offline' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not infer caller reachability from the native probe', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await resolve()).toMatchObject({ ok: false, code: 'app_offline' })
    expect(await resolve()).toMatchObject({ ok: false })
    expect(getPinokioAppStatusMock).toHaveBeenCalledTimes(2)
  })
  it('revalidates even cached targets and never falls back local after restore/removal', async () => {
    expect(await resolve()).toMatchObject({ ok: true })
    machines.resolveCurrent.mockRejectedValue(new Error('Reconnect this restored computer.'))
    expect(await resolve()).toMatchObject({ ok: false, code: 'app_refused', message: 'Reconnect this restored computer.' })
    expect(getPinokioAppStatusMock).toHaveBeenCalledTimes(1)
  })
  it('keeps cache entries distinct for owner, target revision and machine', async () => {
    expect(await resolve()).toMatchObject({ ok: true })
    expect(await resolve()).toMatchObject({ ok: true })
    expect(getPinokioAppStatusMock).toHaveBeenCalledTimes(1)
    expect(await resolve({ userId: 'other' })).toMatchObject({ ok: true })
    machines.resolveCurrent.mockResolvedValue(remoteTarget({ revision: 4 }))
    machines.resolve.mockResolvedValue(remoteTarget({ revision: 4 }))
    expect(await resolve()).toMatchObject({ ok: true, machineRevision: 4 })
    machines.resolveCurrent.mockResolvedValue(remoteTarget({ id: 'f86fbc94-7364-4bbc-bb21-f21627736492' }))
    machines.resolve.mockResolvedValue(remoteTarget({ id: 'f86fbc94-7364-4bbc-bb21-f21627736492' }))
    expect(await resolve({ machineId: 'f86fbc94-7364-4bbc-bb21-f21627736492' })).toMatchObject({ ok: true })
    expect(getPinokioAppStatusMock).toHaveBeenCalledTimes(4)
  })
  it('pins every unsent request and strips ambient credentials without following redirects', async () => {
    const endpoint = await resolve()
    if (!endpoint.ok || !endpoint.fetch) throw new Error('missing bound fetch')
    await endpoint.fetch('/api/run', { method: 'POST', headers: { cookie: 'secret', authorization: 'secret', 'content-type': 'application/json' } })
    const call = vi.mocked(fetch).mock.calls.at(-1)!
    expect(call[0]).toBe('http://192.168.1.90:7777/api/run')
    expect(new Headers(call[1]?.headers).has('cookie')).toBe(false)
    expect(new Headers(call[1]?.headers).has('authorization')).toBe(false)
    const count = vi.mocked(fetch).mock.calls.length
    await expect(endpoint.fetch('http://127.0.0.1:7777/api/run')).rejects.toThrow('origin')
    await expect(endpoint.fetch('http://192.168.1.91:7777/api/run')).rejects.toThrow('origin')
    expect(fetch).toHaveBeenCalledTimes(count)
    machines.resolve.mockRejectedValue(new Error('target changed'))
    await expect(endpoint.fetch('/next')).rejects.toThrow('target changed')
    expect(fetch).toHaveBeenCalledTimes(count)
  })
  it('honors original Stop and fresh saved-binding admission before each request', async () => {
    const abort = new AbortController()
    const admit = vi.fn(async () => {})
    const endpoint = await resolve({ signal: abort.signal, admitFetch: admit })
    if (!endpoint.ok || !endpoint.fetch) throw new Error('missing bound fetch')
    admit.mockRejectedValue(new Error('Artifact rebound'))
    await expect(endpoint.fetch('/next')).rejects.toThrow('Artifact rebound')
    admit.mockResolvedValue()
    abort.abort()
    await expect(endpoint.fetch('/next')).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps remote next-step and authoring hints on the saved computer', async () => {
    const message = pinokioEndpointAgentMessage({ ok: false, code: 'app_offline', status: 503, appId: 'ocr.git', title: 'OCR', state: 'offline', message: 'OCR is stopped.', machineId: REMOTE_ID, machineRevision: 3 })
    expect(message).toContain(JSON.stringify({ appId: 'ocr.git', machineId: REMOTE_ID, revision: 3, previewStart: true }))
    expect(message).toContain('launchFingerprint')
    const api = await describePinokioAppApi('http://192.168.1.90:7777', vi.fn(async () => new Response('', { status: 404 })) as typeof fetch, { machineId: REMOTE_ID })
    expect(api.hint).toContain(`metadata.pinokio_machine_id to "${REMOTE_ID}"`)
    expect(api.hint).toContain('do not save a revision or address')
  })
  it('does not hide lost target admission as an unknown API description', async () => {
    const admit = vi.fn(async () => {})
    const endpoint = await resolve({ admitFetch: admit })
    if (!endpoint.ok || !endpoint.fetch) throw new Error('missing bound fetch')
    admit.mockRejectedValue(Object.assign(new Error('Saved Artifact rebound'), { status: 409 }))
    await expect(describePinokioAppApi(endpoint.baseUrl, endpoint.fetch)).rejects.toThrow('rebound')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses redirect replies and never downgrades advertised HTTPS', async () => {
    getPinokioAppStatusMock.mockResolvedValue(status({ externalReadyUrls: ['https://192.168.1.90:7777/'] }))
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://192.168.1.90:7777/' } }))
    expect(await resolve()).toMatchObject({ ok: false })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://192.168.1.90:7777/')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
