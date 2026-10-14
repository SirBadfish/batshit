// @vitest-environment node
// BL-1324: the route signs a real LiveKit token (only the SDK dispatch is faked), and under the
// default jsdom environment the token library rejects Node's bytes ("payload must be an instance of
// Uint8Array"), so every session failed before its dispatch check. The server runs in Node.
import { afterEach, describe, expect, it, vi } from 'vitest'

const apiKeyMocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  refuseDispatch: vi.fn(),
  // Every agent dispatch the route attempts, recorded by the fake SDK client below (BL-1317).
  dispatchClients: [] as unknown[][],
  dispatches: [] as Array<{ roomName: string; agentName: string; options: unknown }>
}))

// BL-1317: only the SDK's dispatch transport is replaced, by a test-owned fake that records each
// call and never touches the network; the real route, session creation and admission run.
vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>()
  class FakeAgentDispatchClient {
    constructor(...args: unknown[]) {
      apiKeyMocks.dispatchClients.push(args)
    }
    async createDispatch(roomName: string, agentName: string, options: unknown) {
      apiKeyMocks.dispatches.push({ roomName, agentName, options })
      return { id: 'fake-dispatch-1' }
    }
  }
  return { ...actual, AgentDispatchClient: FakeAgentDispatchClient }
})

// BL-1311: the session's agent dispatch is admitted only for this Batshit's own sidecar.
vi.mock('$lib/server/services/liveKitSidecarRuntime', () => ({
  refuseLiveKitDispatchUnlessOwnSidecar: apiKeyMocks.refuseDispatch
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: apiKeyMocks.retrieve
  }
}))

import { POST } from './+server'

describe('/api/voice/livekit/session', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    apiKeyMocks.dispatchClients.length = 0
    apiKeyMocks.dispatches.length = 0
    apiKeyMocks.refuseDispatch.mockReset()
    apiKeyMocks.retrieve.mockReset()
  })

  it('rejects anonymous requests', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', { method: 'POST' }),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized'
    })
  })

  it('fails loudly for malformed JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: '{'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid JSON payload',
      runtime: 'livekit',
      fallback: false
    })
  })

  it('fails loudly for non-object JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: '[]'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid LiveKit voice session payload',
      runtime: 'livekit',
      fallback: false
    })
  })

  it('returns a setup hint instead of silently assuming local dev credentials', async () => {
    vi.stubEnv('LIVEKIT_URL', '')
    vi.stubEnv('LIVEKIT_WS_URL', '')
    vi.stubEnv('LIVEKIT_API_KEY', '')
    vi.stubEnv('LIVEKIT_API_SECRET', '')
    apiKeyMocks.retrieve.mockResolvedValue(null)

    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: '{}'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toMatchObject({
      error: 'LiveKit URL not configured.',
      setupHint: expect.stringContaining('LIVEKIT_URL'),
      runtime: 'livekit',
      fallback: false
    })
  })

  // BL-1311 / BL-1317: the real route and admission, with the SDK dispatch replaced by a recording
  // fake. Without the guard (or its default admission), the refusals below dispatch through the fake
  // and these assertions fail at once: no network, no timeout.
  function configureLiveKit() {
    const saved: Record<string, string> = {
      livekit_url: 'ws://127.0.0.1:7880',
      livekit_api_key: 'devkey',
      livekit_api_secret: 'secret'
    }
    apiKeyMocks.retrieve.mockImplementation(async (service: string) => saved[service] ?? null)
  }
  const startSession = (required: boolean) =>
    POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: JSON.stringify({ agentDispatch: { enabled: true, required, agentName: 'batshit-livekit-agent' } })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)

  it('refuses a session whose agent is not this Batshit\'s own sidecar, and dispatches nothing (BL-1311)', async () => {
    configureLiveKit()
    apiKeyMocks.refuseDispatch.mockResolvedValue("Another Batshit's LiveKit agent runs on port 7899. Batshit did not send this session to it.")

    const response = await startSession(true)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Batshit did not send this session to it'),
      runtime: 'livekit'
    })
    expect(apiKeyMocks.refuseDispatch).toHaveBeenCalledOnce()
    expect(apiKeyMocks.dispatches).toEqual([])
    expect(apiKeyMocks.dispatchClients).toEqual([])
  })

  it('a refused dispatch that is not required starts the session with the reason and dispatches nothing', async () => {
    configureLiveKit()
    apiKeyMocks.refuseDispatch.mockResolvedValue('The LiveKit agent is not running on port 7899.')

    const response = await startSession(false)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      agentDispatch: { requested: true, required: false, warning: 'The LiveKit agent is not running on port 7899.' }
    })
    expect(apiKeyMocks.dispatches).toEqual([])
    expect(apiKeyMocks.dispatchClients).toEqual([])
  })

  it('an admitted session dispatches exactly once, to its configured server', async () => {
    configureLiveKit()
    apiKeyMocks.refuseDispatch.mockResolvedValue(null)

    const response = await startSession(true)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      agentDispatch: { requested: true, required: true, agentName: 'batshit-livekit-agent', dispatchId: 'fake-dispatch-1' }
    })
    expect(apiKeyMocks.dispatchClients).toEqual([['ws://127.0.0.1:7880', 'devkey', 'secret']])
    expect(apiKeyMocks.dispatches).toEqual([
      expect.objectContaining({ agentName: 'batshit-livekit-agent', roomName: expect.any(String) })
    ])
  })
})
