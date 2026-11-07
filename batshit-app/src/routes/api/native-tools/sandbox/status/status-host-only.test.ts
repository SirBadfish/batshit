import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-137 Round 2 (S5): `GET /api/native-tools/sandbox/status?hostOnly=1` answers only what this
 * computer is (the Settings availability check for Refreshed File Reads) and probes no sandbox.
 * Authentication and the delegated-run refusal run first, exactly as for the full status.
 */

const HOST = { platform: 'darwin', containerized: false, linuxKernel: null }
const state = vi.hoisted(() => ({
  auth: { userId: 'user_1', auth: 'session' } as any,
  docker: vi.fn(),
  apple: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn(async () => state.auth)
}))
vi.mock('$lib/server/services/typedFileToolsHost.server', () => ({
  readTypedFileToolsHost: () => HOST
}))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: {
    normalizeNativeExecutionBackend: (value: string | null) => (value === 'apple_container' ? 'apple_container' : null),
    getSandboxBackendStatus: (...args: any[]) => state.docker(...args),
    getAppleContainerSandboxBackendStatus: (...args: any[]) => state.apple(...args)
  }
}))

function get(search = '') {
  const url = new URL(`http://localhost/api/native-tools/sandbox/status${search}`)
  return { request: new Request(url), locals: { user: null }, url, params: {} } as any
}

describe('GET /api/native-tools/sandbox/status hostOnly (Round 2)', () => {
  beforeEach(() => {
    state.auth = { userId: 'user_1', auth: 'session' }
    state.docker.mockReset().mockResolvedValue({ available: true, backend: 'docker_sandbox' })
    state.apple.mockReset().mockResolvedValue({ available: true, backend: 'apple_container' })
  })

  it('answers the host facts alone and probes no sandbox', async () => {
    const { GET } = await import('./+server')
    const response = await GET(get('?hostOnly=1'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, typedFileToolsHost: HOST })
    expect(state.docker).not.toHaveBeenCalled()
    expect(state.apple).not.toHaveBeenCalled()
  })

  it('does not probe the Apple Container either when it is asked for beside hostOnly', async () => {
    const { GET } = await import('./+server')
    const response = await GET(get('?hostOnly=1&backend=apple_container'))
    expect(await response.json()).toEqual({ success: true, typedFileToolsHost: HOST })
    expect(state.apple).not.toHaveBeenCalled()
    expect(state.docker).not.toHaveBeenCalled()
  })

  it('still requires authentication', async () => {
    state.auth = null
    const { GET } = await import('./+server')
    const response = await GET(get('?hostOnly=1'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
    expect(state.docker).not.toHaveBeenCalled()
  })

  it('only the exact value 1 selects the mode: anything else is the full status, probe included', async () => {
    const { GET } = await import('./+server')
    for (const search of ['', '?hostOnly=0', '?hostOnly=true', '?hostOnly=']) {
      state.docker.mockClear()
      const response = await GET(get(search))
      const body = await response.json()
      expect(body).toMatchObject({ success: true, available: true, typedFileToolsHost: HOST })
      expect(state.docker).toHaveBeenCalledTimes(1)
    }
  })

  it('the full status for the Apple Container still probes it and carries the host facts', async () => {
    const { GET } = await import('./+server')
    const body = await (await GET(get('?backend=apple_container'))).json()
    expect(state.apple).toHaveBeenCalledTimes(1)
    expect(state.docker).not.toHaveBeenCalled()
    expect(body).toMatchObject({ success: true, backend: 'apple_container', typedFileToolsHost: HOST })
  })
})
