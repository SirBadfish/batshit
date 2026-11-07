import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-072 P2 (DL-10): the Pinokio app proxy and the panel's start route. The app always comes
 * from the artifact's saved metadata; the address is resolved on each call; an offline app
 * answers a typed `app_offline`; only the signed-in page can start an app.
 */

const mocks = vi.hoisted(() => ({
  resolveArtifactRuntimeClaims: vi.fn(),
  requireArtifactRuntimeClaims: vi.fn(),
  loadPinokioArtifactForUser: vi.fn(),
  resolvePinokioAppEndpoint: vi.fn(),
  forgetPinokioAppEndpoint: vi.fn(),
  previewPinokioAppStart: vi.fn(),
  startPinokioApp: vi.fn()
}))

vi.mock('$lib/server/services/artifactRuntimeAuth', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/services/artifactRuntimeAuth')>(
    '$lib/server/services/artifactRuntimeAuth'
  )
  return {
    ...actual,
    resolveArtifactRuntimeClaims: (...args: any[]) => mocks.resolveArtifactRuntimeClaims(...args),
    requireArtifactRuntimeClaims: (...args: any[]) => mocks.requireArtifactRuntimeClaims(...args)
  }
})

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn(async ({ localsUserId }: { localsUserId: string | null }) =>
    localsUserId ? { userId: localsUserId, auth: 'session' } : null
  )
}))

vi.mock('$lib/server/artifacts/pinokioArtifactAccess', () => ({
  loadPinokioArtifactForUser: (...args: any[]) => mocks.loadPinokioArtifactForUser(...args)
}))

vi.mock('$lib/server/services/pinokioAppEndpoint', () => ({
  resolvePinokioAppEndpoint: (...args: any[]) => mocks.resolvePinokioAppEndpoint(...args),
  forgetPinokioAppEndpoint: (...args: any[]) => mocks.forgetPinokioAppEndpoint(...args)
}))

vi.mock('$lib/server/services/pinokioService', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/services/pinokioService')>('$lib/server/services/pinokioService')
  return {
    PINOKIO_RUN_DEFAULT_WAIT_SECONDS: actual.PINOKIO_RUN_DEFAULT_WAIT_SECONDS,
    PINOKIO_RUN_MAX_WAIT_SECONDS: actual.PINOKIO_RUN_MAX_WAIT_SECONDS,
    pinokioAppIdProblem: actual.pinokioAppIdProblem,
    previewPinokioAppStart: (...args: any[]) => mocks.previewPinokioAppStart(...args),
    startPinokioApp: (...args: any[]) => mocks.startPinokioApp(...args)
  }
})

import { GET as proxyGet, POST as proxyPost } from '../../../routes/api/artifacts/pinokio/[...path]/+server'
import { GET as startGet, POST as startPost } from '../../../routes/api/pinokio/apps/start/+server'
import { pinokioProxyPathProblem } from '$lib/server/artifacts/pinokioProxyRules'

const COMFY_ARTIFACT = {
  ok: true,
  artifact: { id: 'art_comfy', name: 'Flux via Pinokio', user_id: 'josh', brain_type: 'pinokio_app', metadata: { runtime_manager: 'pinokio', source_type: 'comfyui', pinokio_app_id: 'comfy.git', pinokio_runtime: null } },
  binding: { appId: 'comfy.git', kind: 'comfyui', runtime: null }
}

function proxyEvent(path: string, init: { method?: string; body?: string; headers?: Record<string, string>; query?: string; user?: string | null } = {}) {
  const url = new URL(`http://localhost/api/artifacts/pinokio/${path}${init.query ?? '?artifactId=art_comfy'}`)
  return {
    request: new Request(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body }),
    locals: { user: init.user === null ? null : { id: init.user ?? 'josh' } },
    url,
    params: { path }
  } as any
}

describe('the Pinokio app proxy', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.resolveArtifactRuntimeClaims.mockResolvedValue(null)
    mocks.loadPinokioArtifactForUser.mockResolvedValue(COMFY_ARTIFACT)
    mocks.resolvePinokioAppEndpoint.mockResolvedValue({ ok: true, appId: 'comfy.git', title: 'Comfyui', baseUrl: 'http://127.0.0.1:8188' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"system":{}}', { status: 200, headers: { 'content-type': 'application/json' } })))
  })

  it('forwards to the address Pinokio reports now, without Batshit\'s own query keys', async () => {
    const response = await proxyGet(proxyEvent('system_stats', { query: '?artifactId=art_comfy&timeoutMs=5000&x=1' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-batshit-pinokio-app')).toBe('comfy.git')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://127.0.0.1:8188/system_stats?x=1')
    expect(mocks.loadPinokioArtifactForUser).toHaveBeenCalledWith('art_comfy', 'josh')
  })


  it('uses the saved remote binding and its single guarded app reader', async () => {
    const machineId = 'd86fbc94-7364-4bbc-bb21-f21627736492'
    mocks.loadPinokioArtifactForUser.mockResolvedValue({ ...COMFY_ARTIFACT, artifact: { ...COMFY_ARTIFACT.artifact, metadata: { ...COMFY_ARTIFACT.artifact.metadata, pinokio_machine_id: machineId } }, binding: { ...COMFY_ARTIFACT.binding, machineId } })
    const boundFetch = vi.fn(async () => Response.json({ ok: true }))
    mocks.resolvePinokioAppEndpoint.mockResolvedValue({ ok: true, appId: 'comfy.git', title: 'Comfyui', baseUrl: 'http://192.168.1.90:8188', machineId, machineRevision: 3, fetch: boundFetch })
    const response = await proxyGet(proxyEvent('system_stats', { query: `?artifactId=art_comfy&machineId=${machineId}&revision=3&machineRevision=3&x=1` }))
    expect(response.status).toBe(200)
    await response.text()
    expect(boundFetch).toHaveBeenCalledWith('http://192.168.1.90:8188/system_stats?x=1', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.resolvePinokioAppEndpoint).toHaveBeenCalledWith('comfy.git', expect.objectContaining({ userId: 'josh', machineId }))
  })

  it('refuses query retargeting and a changed saved binding before an app request', async () => {
    const response = await proxyGet(proxyEvent('system_stats', { query: '?artifactId=art_comfy&machineId=another' }))
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
    mocks.resolvePinokioAppEndpoint.mockImplementation(async () => {
      mocks.loadPinokioArtifactForUser.mockResolvedValue({ ...COMFY_ARTIFACT, artifact: { ...COMFY_ARTIFACT.artifact, metadata: { ...COMFY_ARTIFACT.artifact.metadata, pinokio_app_id: 'different.git' } }, binding: { ...COMFY_ARTIFACT.binding, appId: 'different.git' } })
      return { ok: true, appId: 'comfy.git', title: 'Comfyui', baseUrl: 'http://127.0.0.1:8188' }
    })
    expect((await proxyGet(proxyEvent('system_stats'))).status).toBe(502)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['', 20_000], ['&timeoutMs=', 20_000], ['&timeoutMs=%20%20', 20_000],
    ['&timeoutMs=not-a-number', 20_000], ['&timeoutMs=0', 1_000], ['&timeoutMs=999999', 60_000]
  ])('uses the default or bounded explicit timeout for %s', async (query, expected) => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      const response = await proxyGet(proxyEvent('system_stats', { query: `?artifactId=art_comfy${query}` }))
      await response.text()
      expect(timer).toHaveBeenCalledWith(expect.any(Function), expected)
    } finally { timer.mockRestore() }
  })

  it('answers a typed app_offline the Builder Kit turns into Start with Pinokio', async () => {
    mocks.resolvePinokioAppEndpoint.mockResolvedValue({
      ok: false,
      code: 'app_offline',
      status: 503,
      appId: 'comfy.git',
      title: 'Comfyui',
      state: 'offline',
      message: 'Comfyui is not running in Pinokio.'
    })
    const response = await proxyGet(proxyEvent('system_stats'))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'app_offline',
      artifactId: 'art_comfy',
      app: { id: 'comfy.git', title: 'Comfyui', state: 'offline' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reaches only the app its artifact names', async () => {
    const response = await proxyGet(proxyEvent('system_stats', { query: '?artifactId=art_comfy&app=other.git' }))
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('takes the artifact from a runtime token and refuses a second id that disagrees', async () => {
    mocks.resolveArtifactRuntimeClaims.mockResolvedValue({ userId: 'josh', artifactId: 'art_comfy' })
    const ok = await proxyGet(proxyEvent('system_stats', { query: '', headers: { authorization: `Bearer art_rt_${'a'.repeat(64)}` }, user: null }))
    expect(ok.status).toBe(200)
    expect(mocks.loadPinokioArtifactForUser).toHaveBeenCalledWith('art_comfy', 'josh')

    const mismatch = await proxyGet(
      proxyEvent('system_stats', { query: '?artifactId=art_other', headers: { authorization: `Bearer art_rt_${'a'.repeat(64)}` }, user: null })
    )
    expect(mismatch.status).toBe(403)
  })

  it('applies the ComfyUI path allowlist and prompt shape check to ComfyUI apps', async () => {
    expect((await proxyGet(proxyEvent('api/secrets'))).status).toBe(400)
    const ui = await proxyPost(
      proxyEvent('prompt', { method: 'POST', body: JSON.stringify({ prompt: { nodes: [], links: [] } }), headers: { 'content-type': 'application/json' } })
    )
    expect(ui.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses an unsigned caller and an artifact that is not a Pinokio app', async () => {
    expect((await proxyGet(proxyEvent('system_stats', { user: null }))).status).toBe(401)
    mocks.loadPinokioArtifactForUser.mockResolvedValue({ ok: false, status: 400, code: 'not_a_pinokio_artifact', message: 'no' })
    expect((await proxyGet(proxyEvent('system_stats'))).status).toBe(400)
  })

  it('answers a clear 502 when the app stops answering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const response = await proxyGet(proxyEvent('system_stats'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: 'app_unreachable' })
  })
})

describe('proxy path rules by kind', () => {
  it('limits Gradio apps to the Gradio API and lets custom apps reach any path, never dot segments', () => {
    expect(pinokioProxyPathProblem('gradio', 'gradio_api/info')).toBeNull()
    expect(pinokioProxyPathProblem('gradio', 'gradio_api/file=/tmp/x.png')).toBeNull()
    expect(pinokioProxyPathProblem('gradio', 'config')).toBeNull()
    expect(pinokioProxyPathProblem('gradio', 'admin')).not.toBeNull()
    expect(pinokioProxyPathProblem('custom', 'api/anything')).toBeNull()
    expect(pinokioProxyPathProblem('custom', 'a/../b')).not.toBeNull()
    expect(pinokioProxyPathProblem('comfyui', 'view')).toBeNull()
    expect(pinokioProxyPathProblem('comfyui', '')).not.toBeNull()
  })
})

function startEvent(method: 'GET' | 'POST', init: { body?: unknown; headers?: Record<string, string>; user?: string | null; query?: string } = {}) {
  const url = new URL(`http://localhost/api/pinokio/apps/start${init.query ?? '?artifactId=art_comfy'}`)
  return {
    request: new Request(url, {
      method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      body: method === 'POST' ? JSON.stringify(init.body ?? { artifactId: 'art_comfy' }) : undefined
    }),
    locals: { user: init.user === null ? null : { id: init.user ?? 'josh' } },
    url
  } as any
}

async function startPreviewBody() {
  const response = await startGet(startEvent('GET'))
  expect(response.status).toBe(200)
  const preview = await response.json()
  expect(preview.success).toBe(true)
  return { artifactId: 'art_comfy', machineId: preview.machineId, revision: preview.machineRevision,
    bindingFingerprint: preview.bindingFingerprint, launchFingerprint: preview.launchFingerprint, alsoStarts: preview.alsoStarts }
}

describe('Start with Pinokio from a panel', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.loadPinokioArtifactForUser.mockResolvedValue(COMFY_ARTIFACT)
    mocks.previewPinokioAppStart.mockResolvedValue({
      ok: true,
      value: { appId: 'comfy.git', title: 'Comfyui', state: 'offline', ready: false, alsoStarts: [] }
    })
    mocks.startPinokioApp.mockResolvedValue({
      ok: true,
      value: { appId: 'comfy.git', title: 'Comfyui', alreadyRunning: false, ready: true, state: 'online', readyUrl: 'http://localhost:8188', alsoStarted: [], waitedMs: 13000, message: 'Comfyui is running in Pinokio and answered its probe.' }
    })
  })

  it('previews the start for the confirm dialog', async () => {
    const response = await startGet(startEvent('GET'))
    expect(await response.json()).toMatchObject({ success: true, artifactName: 'Flux via Pinokio', title: 'Comfyui', alsoStarts: [] })
    expect(mocks.previewPinokioAppStart).toHaveBeenCalledWith({ appId: 'comfy.git' })
  })

  it('starts only the app the artifact names, with the confirmed chain, and forgets the old address', async () => {
    mocks.previewPinokioAppStart.mockResolvedValue({ ok: true, value: { appId: 'comfy.git', title: 'Comfyui', state: 'offline', ready: false, alsoStarts: ['dep.git'] } })
    const custody = await startPreviewBody()
    const response = await startPost(startEvent('POST', { body: { ...custody, appId: 'evil.git' } }))
    expect(response.status).toBe(200)
    expect(mocks.startPinokioApp).toHaveBeenCalledWith({ appId: 'comfy.git', alsoStarts: ['dep.git'] })
    expect(mocks.forgetPinokioAppEndpoint).toHaveBeenCalledWith('comfy.git')
  })

  it('refuses legacy local starts without the current saved-binding and launch preview', async () => {
    const response = await startPost(startEvent('POST', { body: { artifactId: 'art_comfy', alsoStarts: [] } }))
    expect(response.status).toBe(409)
    expect(mocks.startPinokioApp).not.toHaveBeenCalled()
  })

  it('refuses every caller that is not the signed-in page', async () => {
    expect((await startPost(startEvent('POST', { user: null }))).status).toBe(401)
    expect((await startPost(startEvent('POST', { headers: { authorization: `Bearer art_rt_${'a'.repeat(64)}` } }))).status).toBe(403)
    expect((await startPost(startEvent('POST', { headers: { 'x-batshit-token': 'service' } }))).status).toBe(403)
    expect((await startPost(startEvent('POST', { headers: { origin: 'null' } }))).status).toBe(403)
    expect((await startPost(startEvent('POST', { headers: { origin: 'https://evil.example' } }))).status).toBe(403)
    expect((await startPost(startEvent('POST', { headers: { 'content-type': 'text/plain' } }))).status).toBe(415)
    expect(mocks.startPinokioApp).not.toHaveBeenCalled()
  })

  it('passes a refused start through as the service worded it', async () => {
    mocks.startPinokioApp.mockResolvedValue({ ok: false, kind: 'refused', message: 'Starting Comfyui also starts dep.git.' })
    const response = await startPost(startEvent('POST', { body: await startPreviewBody() }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ success: false, error: 'Starting Comfyui also starts dep.git.' })
  })
})
