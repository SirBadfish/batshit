import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({ BATSHIT_CONTAINERIZED: undefined as string | undefined }))
const mockArtifactRuntimeAuth = vi.hoisted(() => ({
  resolveArtifactRuntimeClaims: vi.fn(),
  requireArtifactRuntimeClaims: vi.fn()
}))

vi.mock('$env/dynamic/private', () => ({
  env: mockEnv
}))

vi.mock('$lib/server/services/artifactRuntimeAuth', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/services/artifactRuntimeAuth')>(
    '$lib/server/services/artifactRuntimeAuth'
  )
  return {
    ...actual,
    resolveArtifactRuntimeClaims: (...args: any[]) =>
      mockArtifactRuntimeAuth.resolveArtifactRuntimeClaims(...args),
    requireArtifactRuntimeClaims: (...args: any[]) =>
      mockArtifactRuntimeAuth.requireArtifactRuntimeClaims(...args)
  }
})

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn(async () => ({ userId: 'user_1', auth: 'session' }))
}))

function buildPostEvent(path: string, body: unknown) {
  const url = new URL(`http://localhost/api/artifacts/comfyui/${path}?baseUrl=comfyui_api_desktop`)
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: 'user_1' } },
    url,
    params: { path }
  } as any
}

function buildRuntimePostEvent(path: string, body: unknown) {
  const url = new URL(`http://localhost/api/artifacts/comfyui/${path}?baseUrl=comfyui_api_desktop`)
  return {
    request: new Request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer art_rt_${'a'.repeat(64)}`,
        'Content-Type': 'application/json',
        Origin: 'null'
      },
      body: JSON.stringify(body)
    }),
    locals: { user: null },
    url,
    params: { path }
  } as any
}

function buildGetEvent(path: string, baseUrl: string) {
  const url = new URL(`http://localhost/api/artifacts/comfyui/${path}?baseUrl=${encodeURIComponent(baseUrl)}`)
  return {
    request: new Request(url),
    locals: { user: { id: 'user_1' } },
    url,
    params: { path }
  } as any
}

function buildRuntimeGetEvent(
  path: string,
  query: Record<string, string> = {},
  baseUrl = 'comfyui_api_desktop'
) {
  const url = new URL(`http://localhost/api/artifacts/comfyui/${path}`)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('baseUrl', baseUrl)
  return {
    request: new Request(url, {
      headers: {
        Authorization: `Bearer art_rt_${'a'.repeat(64)}`,
        Origin: 'null'
      }
    }),
    locals: { user: null },
    url,
    params: { path }
  } as any
}

describe('POST /api/artifacts/comfyui/[...path]', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockEnv.BATSHIT_CONTAINERIZED = undefined
    mockArtifactRuntimeAuth.resolveArtifactRuntimeClaims.mockClear()
    mockArtifactRuntimeAuth.requireArtifactRuntimeClaims.mockClear()
    mockArtifactRuntimeAuth.resolveArtifactRuntimeClaims.mockResolvedValue(null)
    mockArtifactRuntimeAuth.requireArtifactRuntimeClaims.mockResolvedValue({
      token: `art_rt_${'a'.repeat(64)}`,
      userId: 'runtime_user',
      artifactId: 'artifact_runtime',
      sessionId: 'session_1',
      createdAt: '2026-05-27T00:00:00.000Z',
      expiresAt: '2026-05-27T06:00:00.000Z'
    })
  })

  it('rejects UI workflow graph payloads for /prompt with a clear 400 error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { POST } = await import('../../../routes/api/artifacts/comfyui/[...path]/+server')

    const response = await POST(
      buildPostEvent('prompt', {
        prompt: {
          id: 'wf_ui',
          nodes: [{ id: 1, type: 'KSampler' }],
          links: [],
          definitions: {}
        },
        client_id: 'test'
      })
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(String(body.error)).toContain('API prompt-format')
    expect(body.details?.detectedPromptShape).toBe('ui')
    expect(body.details?.expectedPromptShape).toBe('api')
    expect(Array.isArray(body.details?.hints)).toBe(true)
    expect(String(body.details?.hints?.[0] ?? '')).toContain('workflow_format')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects unknown prompt shapes for /prompt with a clear 400 error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { POST } = await import('../../../routes/api/artifacts/comfyui/[...path]/+server')

    const response = await POST(
      buildPostEvent('prompt', {
        prompt: 'not-an-object',
        client_id: 'test'
      })
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.details?.reason).toBe('unknown_prompt_shape')
    expect(body.details?.expectedPromptShape).toBe('api')
    expect(Array.isArray(body.details?.hints)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards valid API prompt payloads to upstream /prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ prompt_id: 'p_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }) as any
    )
    const { POST } = await import('../../../routes/api/artifacts/comfyui/[...path]/+server')

    const response = await POST(
      buildPostEvent('prompt', {
        prompt: {
          '3': {
            class_type: 'KSampler',
            inputs: { steps: 8 }
          },
          '4': {
            class_type: 'EmptyLatentImage',
            inputs: { width: 1024, height: 1024, batch_size: 1 }
          }
        },
        client_id: 'test'
      })
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.prompt_id).toBe('p_123')
    expect(fetchSpy).toHaveBeenCalledOnce()
    const firstCallUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
    expect(firstCallUrl).toContain('/prompt')
  })

  it('accepts sandboxed artifact runtime token auth for opaque ComfyUI requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ prompt_id: 'p_runtime' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }) as any
    )
    const { POST } = await import('../../../routes/api/artifacts/comfyui/[...path]/+server')

    const response = await POST(
      buildRuntimePostEvent('prompt', {
        prompt: {
          '3': {
            class_type: 'KSampler',
            inputs: { steps: 8 }
          }
        },
        client_id: 'runtime-test'
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ prompt_id: 'p_runtime' })
    expect(mockArtifactRuntimeAuth.requireArtifactRuntimeClaims).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('accepts sandboxed artifact runtime token auth for protected ComfyUI media', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('image-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      }) as any
    )
    const { GET } = await import('../../../routes/api/artifacts/comfyui/[...path]/+server')

    const response = await GET(buildRuntimeGetEvent('view', { filename: 'result.png', type: 'output' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('image-bytes')
    expect(mockArtifactRuntimeAuth.requireArtifactRuntimeClaims).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[0]?.[0] ?? '')).toContain('/view?filename=result.png')
  })

  it('allows Docker Compose service-name ComfyUI URLs only in containerized runtime', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ system: { os: 'mock' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }) as any
    )
    const { GET } = await import('../../../routes/api/artifacts/comfyui/[...path]/+server')

    let response = await GET(buildGetEvent('system_stats', 'http://comfyui:8188'))
    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()

    mockEnv.BATSHIT_CONTAINERIZED = '1'

    response = await GET(buildGetEvent('system_stats', 'http://comfyui:8188'))
    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[0]?.[0] ?? '')).toBe('http://comfyui:8188/system_stats')
  })
})
