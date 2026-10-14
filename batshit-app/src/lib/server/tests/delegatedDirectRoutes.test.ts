import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  auth: { userId: 'user_1', auth: 'agent', delegated: true, delegatedAllowedControlIds: [] } as any,
  bash: vi.fn(),
  search: vi.fn(),
  sandbox: vi.fn(),
  runEvent: vi.fn(),
  fetch: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn(async () => state.auth)
}))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: {
    nativeBashExecute: (...args: any[]) => state.bash(...args),
    nativeWebSearch: (...args: any[]) => state.search(...args),
    normalizeNativeExecutionBackend: vi.fn(() => 'docker_sandbox'),
    getSandboxBackendStatus: (...args: any[]) => state.sandbox(...args),
    getAppleContainerSandboxBackendStatus: (...args: any[]) => state.sandbox(...args)
  }
}))
vi.mock('$lib/server/services/artifactRuntimeAuth', () => ({
  isOpaqueArtifactRuntimeRequest: vi.fn(() => false),
  requireArtifactRuntimeClaims: vi.fn(async () => null),
  resolveArtifactRuntimeClaims: vi.fn(async () => null)
}))
vi.mock('$lib/server/artifacts/artifactRunLogs', () => ({
  recordArtifactClientRunEvent: (...args: any[]) => state.runEvent(...args)
}))

function post(path: string, body: unknown, params?: Record<string, string>) {
  const url = new URL(`http://localhost${path}`)
  return {
    request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
    locals: { user: null },
    url,
    params: params ?? {}
  } as any
}

function get(path: string, params?: Record<string, string>) {
  const url = new URL(`http://localhost${path}`)
  return { request: new Request(url), locals: { user: null }, url, params: params ?? {} } as any
}

describe('direct routes on delegated and primary run credentials', () => {
  afterEach(() => vi.unstubAllGlobals())

  beforeEach(() => {
    state.auth = { userId: 'user_1', auth: 'agent', delegated: true, delegatedAllowedControlIds: [] }
    state.bash.mockReset().mockResolvedValue({ success: true })
    state.search.mockReset().mockResolvedValue({ success: true })
    state.sandbox.mockReset().mockResolvedValue({ available: true })
    state.runEvent.mockReset().mockResolvedValue(undefined)
    state.fetch.mockReset().mockResolvedValue(new Response('upstream', { status: 200 }))
    vi.stubGlobal('fetch', state.fetch)
  })

  it('refuses delegated Bash and primary agent attempts to override its approval policy', async () => {
    const { POST } = await import('../../../routes/api/native-tools/bash/execute/+server')
    const event = () => post('/api/native-tools/bash/execute', {
      command: 'touch /tmp/bl126', accessMode: 'dangerous', policyMode: 'workspace',
      approved: true, requireApproval: false, backend: 'local'
    })

    const delegated = await POST(event())
    expect(delegated.status).toBe(403)
    expect((await delegated.json()).code).toBe('CONTROL_NOT_ALLOWED')
    expect(state.bash).not.toHaveBeenCalled()

    state.auth = { userId: 'user_1', auth: 'agent', agentId: 'primary_1', delegated: false }
    const primary = await POST(event())
    expect(primary.status).toBe(403)
    expect((await primary.json()).code).toBe('DIRECT_BASH_NOT_ALLOWED')
    expect(state.bash).not.toHaveBeenCalled()

    state.auth = { userId: 'user_1', auth: 'session' }
    const probe = await POST(event())
    expect(probe.status).toBe(200)
    expect(state.bash).toHaveBeenCalledOnce()

    state.auth = { userId: 'user_1', auth: 'service' }
    expect((await POST(event())).status).toBe(200)
    expect(state.bash).toHaveBeenCalledTimes(2)
  })

  it('refuses a delegated credential before web search or sandbox status', async () => {
    const [{ POST }, { GET }] = await Promise.all([
      import('../../../routes/api/native-tools/web-search/+server'),
      import('../../../routes/api/native-tools/sandbox/status/+server')
    ])
    expect((await POST(post('/api/native-tools/web-search', { query: 'example' }))).status).toBe(403)
    expect((await GET(get('/api/native-tools/sandbox/status'))).status).toBe(403)
    expect(state.search).not.toHaveBeenCalled()
    expect(state.sandbox).not.toHaveBeenCalled()

    state.auth = { userId: 'user_1', auth: 'agent', delegated: true,
      delegatedAllowedControlIds: ['use.artifact.allowed'] }
    expect((await POST(post('/api/native-tools/web-search', { query: 'example' }))).status).toBe(403)
    expect(state.search).not.toHaveBeenCalled()
  })

  it('refuses a delegated credential before artifact run-event recording or ComfyUI forwarding', async () => {
    const [{ POST: runEvent }, { GET: comfyGet }] = await Promise.all([
      import('../../../routes/api/artifacts/run-event/+server'),
      import('../../../routes/api/artifacts/comfyui/[...path]/+server')
    ])
    const event = post('/api/artifacts/run-event', {
      artifactId: 'a1', runId: 'r1', eventType: 'started'
    })
    expect((await runEvent(event)).status).toBe(403)
    const comfy = get('/api/artifacts/comfyui/system_stats?baseUrl=http://127.0.0.1:8188', {
      path: 'system_stats'
    })
    expect((await comfyGet(comfy)).status).toBe(403)
    expect(state.runEvent).not.toHaveBeenCalled()
    expect(state.fetch).not.toHaveBeenCalled()

    state.auth = { userId: 'user_1', auth: 'agent', delegated: true,
      delegatedAllowedControlIds: ['use.artifact.allowed'] }
    expect((await runEvent(post('/api/artifacts/run-event', {
      artifactId: 'a1', runId: 'r1', eventType: 'started'
    }))).status).toBe(403)
    expect((await comfyGet(get('/api/artifacts/comfyui/system_stats?baseUrl=http://127.0.0.1:8188', {
      path: 'system_stats'
    }))).status).toBe(403)
    expect(state.runEvent).not.toHaveBeenCalled()
    expect(state.fetch).not.toHaveBeenCalled()
  })
})
