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
})
