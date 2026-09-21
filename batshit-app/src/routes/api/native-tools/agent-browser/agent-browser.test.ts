import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  redisGet: vi.fn(),
  nativeAgentBrowserFind: vi.fn(),
  nativeAgentBrowserUse: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: mocks.redisGet
  }
}))

vi.mock('$lib/server/services/nativeTools', () => ({
  resolveNativeToolSettings: (providerSettings: Record<string, any> | null) => {
    const nativeTools = providerSettings?.nativeTools ?? {}
    return {
      agentBrowserEnabled: nativeTools.agentBrowserEnabled !== false,
      agentBrowserLiveViewEnabled: nativeTools.agentBrowserLiveViewEnabled ?? true,
      agentBrowserRuntimeMode: nativeTools.agentBrowserRuntimeMode ?? 'chromium',
      agentBrowserCdpPort: nativeTools.agentBrowserCdpPort ?? 9222,
      agentBrowserProvider: nativeTools.agentBrowserProvider ?? 'local',
      agentBrowserExecutablePath: nativeTools.agentBrowserExecutablePath ?? null,
      agentBrowserExtraFlags: nativeTools.agentBrowserExtraFlags ?? [],
      agentBrowserTimeoutMs: nativeTools.agentBrowserTimeoutMs ?? 120000
    }
  },
  nativeToolService: {
    nativeAgentBrowserFind: mocks.nativeAgentBrowserFind,
    nativeAgentBrowserUse: mocks.nativeAgentBrowserUse
  }
}))

import { POST } from './+server'
import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'

function useRequest(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/native-tools/agent-browser', {
      method: 'POST',
      body: JSON.stringify({ action: 'use', agentId: 'agent-1', toolName: 'open', ...body })
    }),
    locals: { user: { id: 'user-1' } }
  } as any)
}

const dockerSidecarStoppedResult = {
  success: false,
  available: false,
  supported: true,
  dockerUnsupported: false,
  error: 'Docker Agent Browser sidecar is not reachable: sidecar offline.',
  reason: 'Docker Agent Browser sidecar is not reachable: sidecar offline.',
  supportLevel: 'docker-sidecar',
  results: [
    {
      toolName: 'open'
    }
  ]
}

describe('/api/native-tools/agent-browser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStreamAbortRegistryForTests()
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1' })
    mocks.redisGet.mockResolvedValue({
      user_id: 'user-1',
      provider_specific_settings: {
        nativeTools: {
          agentBrowserEnabled: true
        }
      }
    })
  })

  it('returns 200 with sidecar status when Docker Agent Browser find is requested while stopped', async () => {
    mocks.nativeAgentBrowserFind.mockResolvedValue(dockerSidecarStoppedResult)

    const response = await POST({
      request: new Request('http://localhost/api/native-tools/agent-browser', {
        method: 'POST',
        body: JSON.stringify({
          action: 'find',
          agentId: 'agent-1',
          query: 'open'
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      available: false
    })
  })

  it('returns 200 with a clear sidecar error when Docker Agent Browser use is requested while stopped', async () => {
    mocks.nativeAgentBrowserUse.mockResolvedValue(dockerSidecarStoppedResult)

    const response = await POST({
      request: new Request('http://localhost/api/native-tools/agent-browser', {
        method: 'POST',
        body: JSON.stringify({
          action: 'use',
          agentId: 'agent-1',
          toolName: 'open',
          params: {
            url: 'https://example.com'
          }
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      error: expect.stringContaining('sidecar')
    })
  })

  /**
   * A Stop reaches the managed CLI lanes' Agent Browser call (2026-09-18, bug sweep item 17).
   *
   * The helper's request cannot carry it: SvelteKit aborts `request.signal` only when the caller
   * leaves before the body is read, and a Stop ends the managed CLI after that. The reply that
   * runs in the chat registers its stream controller, and that controller is what the Stop
   * button's interrupt route (`abortStream`), a voice barge-in, and a chat delete abort.
   */
  it('hands a use call the Stop of the reply that runs in its chat', async () => {
    const reply = new AbortController()
    registerStreamAbort('session-1', 'message-1', reply)
    let received: AbortSignal | undefined
    mocks.nativeAgentBrowserUse.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      received = abortSignal
      await new Promise((resolve) => abortSignal?.addEventListener('abort', resolve, { once: true }))
      return { success: false, stopped: true, reason: 'The command was stopped.' }
    })

    const pending = useRequest({ sessionId: 'session-1', params: { url: 'https://example.com' } })
    await vi.waitFor(() => expect(received).toBeInstanceOf(AbortSignal))
    abortStream('session-1', 'user')
    const response = await pending

    expect(received?.aborted).toBe(true)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ stopped: true, reason: 'The command was stopped.' })
  })

  it('hands no signal when no reply runs in the chat, so the call keeps its own time limit', async () => {
    registerStreamAbort('another-session', 'message-9', new AbortController())
    mocks.nativeAgentBrowserUse.mockResolvedValue({ success: true })

    await useRequest({ sessionId: 'session-2', params: { url: 'https://example.com' } })
    await useRequest({ params: { url: 'https://example.com' } })

    expect(mocks.nativeAgentBrowserUse).toHaveBeenCalledTimes(2)
    for (const [input] of mocks.nativeAgentBrowserUse.mock.calls) {
      expect(input.abortSignal).toBeUndefined()
    }
  })
})
