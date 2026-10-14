import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPinokioAppStatusMock = vi.hoisted(() => vi.fn())

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
      baseUrl: 'http://127.0.0.1:8188'
    })
    expect(getPinokioAppStatusMock).toHaveBeenCalledWith({ appId: 'comfy.git', probe: true })
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
