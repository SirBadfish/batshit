import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAgentBrowserRuntimeStatus: vi.fn(),
  installAgentBrowserRuntime: vi.fn(),
  uninstallAgentBrowserRuntime: vi.fn()
}))

vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: {
    getAgentBrowserRuntimeStatus: mocks.getAgentBrowserRuntimeStatus,
    installAgentBrowserRuntime: mocks.installAgentBrowserRuntime,
    uninstallAgentBrowserRuntime: mocks.uninstallAgentBrowserRuntime
  }
}))

import { DELETE, GET, POST } from './+server'

const dockerStatus = {
  installed: false,
  supported: true,
  dockerUnsupported: false,
  supportLevel: 'docker-sidecar',
  installScope: 'docker-sidecar',
  command: null,
  version: null,
  reason: 'Docker Agent Browser sidecar is not reachable: sidecar offline.',
  installCommand: 'npm install -g agent-browser@0.24.1 && agent-browser install',
  installHelp:
    'Docker Agent Browser is managed by the optional agent-browser Compose sidecar, not by downloading a binary into the core app container.',
  testedVersion: '0.24.1',
  packageSpec: 'agent-browser@0.24.1',
  packageTarballUrl: 'https://registry.npmjs.org/agent-browser/-/agent-browser-0.24.1.tgz',
  packageIntegrity: 'sha512-test',
  runtimeMatchesTestedVersion: null,
  run: null
}

const dockerActionStatus = {
  ...dockerStatus,
  dockerUnsupported: true
}

describe('/api/native-tools/agent-browser/runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Docker sidecar status with 200 for GET', async () => {
    mocks.getAgentBrowserRuntimeStatus.mockResolvedValue(dockerStatus)

    const response = await GET({
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar'
    })
  })

  it('returns 503 for Docker native install attempts', async () => {
    mocks.installAgentBrowserRuntime.mockResolvedValue(dockerActionStatus)

    const response = await POST({
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      installed: false,
      dockerUnsupported: true
    })
  })

  it('returns 503 for Docker native uninstall attempts', async () => {
    mocks.uninstallAgentBrowserRuntime.mockResolvedValue({
      ...dockerActionStatus,
      uninstalled: false
    })

    const response = await DELETE({
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      uninstalled: false,
      dockerUnsupported: true
    })
  })
})
