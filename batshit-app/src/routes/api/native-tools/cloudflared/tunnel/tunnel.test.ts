import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  getCloudflaredRuntimeStatus: vi.fn(),
  ensureManagedCloudflaredTunnel: vi.fn(),
  stopManagedCloudflaredTunnel: vi.fn(),
  controlRuntimeAddon: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: (...args: any[]) => mocks.getUserSettings(...args),
    updateUserSettings: (...args: any[]) => mocks.updateUserSettings(...args)
  }
}))

vi.mock('$lib/server/services/cloudflaredRuntime', () => ({
  getCloudflaredRuntimeStatus: mocks.getCloudflaredRuntimeStatus,
  ensureManagedCloudflaredTunnel: mocks.ensureManagedCloudflaredTunnel,
  stopManagedCloudflaredTunnel: mocks.stopManagedCloudflaredTunnel,
  getDefaultManagedTunnelTargetUrl: () => 'http://localhost:5600',
  getDefaultDockerManagedTunnelTargetUrl: () => 'http://batshit-server:5600'
}))

vi.mock('$lib/server/services/runtimeAddons', () => ({
  controlRuntimeAddon: mocks.controlRuntimeAddon
}))

import { POST } from './+server'

function uploadSettings(overrides: Record<string, unknown> = {}) {
  return {
    strategy: 'local',
    tunnel_provider: 'cloudflared_managed',
    cloudflared_auto_start: false,
    cloudflared_target_url: 'http://localhost:5613',
    tunnel_url: '',
    use_https: true,
    ...overrides
  }
}

function userSettings(overrides: Record<string, unknown> = {}) {
  const upload = uploadSettings(overrides)
  return {
    ui_settings: {
      upload_settings: upload
    },
    upload_settings: upload
  }
}

function dockerStatus(overrides: Record<string, unknown> = {}) {
  return {
    installed: false,
    supported: true,
    dockerUnsupported: false,
    supportLevel: 'docker-sidecar',
    command: 'docker compose profile: cloudflared',
    version: null,
    reason: 'Docker Cloudflared sidecar is not running yet.',
    testedVersion: '2026.3.0',
    installScope: 'docker-sidecar',
    managedInstallPresent: false,
    installCommand: 'docker compose --env-file .env.docker --profile cloudflared up -d --build cloudflared',
    installHelp: 'Docker Cloudflared is managed by the optional cloudflared Compose profile.',
    defaultPlatform: 'linux-x64',
    manifest: null,
    tunnel: {
      running: false,
      publicUrl: null,
      targetUrl: 'http://batshit-server:5600',
      pid: null,
      startedAt: null,
      lastError: null
    },
    dockerSidecar: null,
    ...overrides
  }
}

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/native-tools/cloudflared/tunnel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

const authedEvent = (body: Record<string, unknown>) =>
  ({
    locals: {
      user: {
        id: 'user-1'
      }
    },
    request: request(body)
  }) as any

describe('/api/native-tools/cloudflared/tunnel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getUserSettings.mockResolvedValue(userSettings())
    mocks.updateUserSettings.mockResolvedValue(userSettings())
  })

  it('starts Docker Cloudflared through the runtime add-on operator and replaces stale host targets', async () => {
    const running = dockerStatus({
      installed: true,
      reason: 'Docker Cloudflared sidecar is running.',
      tunnel: {
        running: true,
        publicUrl: 'https://fresh-tunnel.trycloudflare.com',
        targetUrl: 'http://batshit-server:5600',
        pid: null,
        startedAt: '2026-05-26T00:00:00.000Z',
        lastError: null
      },
      dockerSidecar: {
        status: 'running',
        publicUrl: 'https://fresh-tunnel.trycloudflare.com',
        targetUrl: 'http://batshit-server:5600',
        lastSeenAt: '2026-05-26T00:00:00.000Z',
        stale: false
      }
    })
    mocks.getCloudflaredRuntimeStatus.mockResolvedValueOnce(dockerStatus()).mockResolvedValue(running)
    mocks.controlRuntimeAddon.mockResolvedValue({ success: true, operation: 'start', addonId: 'cloudflared' })

    const response = await POST(authedEvent({ action: 'start', targetUrl: 'http://localhost:5613' }))

    expect(response.status).toBe(200)
    expect(mocks.controlRuntimeAddon).toHaveBeenCalledWith('cloudflared', 'start')
    expect(mocks.ensureManagedCloudflaredTunnel).not.toHaveBeenCalled()
    expect(mocks.updateUserSettings).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        upload_settings: expect.objectContaining({
          cloudflared_target_url: 'http://batshit-server:5600',
          tunnel_url: 'https://fresh-tunnel.trycloudflare.com',
          use_https: true
        })
      })
    )
    await expect(response.json()).resolves.toMatchObject({
      supportLevel: 'docker-sidecar',
      targetUrl: 'http://batshit-server:5600',
      tunnel: {
        running: true,
        publicUrl: 'https://fresh-tunnel.trycloudflare.com'
      }
    })
  })

  it('stops Docker Cloudflared through the runtime add-on operator', async () => {
    const running = dockerStatus({
      installed: true,
      tunnel: {
        running: true,
        publicUrl: 'https://fresh-tunnel.trycloudflare.com',
        targetUrl: 'http://batshit-server:5600',
        pid: null,
        startedAt: '2026-05-26T00:00:00.000Z',
        lastError: null
      }
    })
    mocks.getCloudflaredRuntimeStatus.mockResolvedValueOnce(running).mockResolvedValue(dockerStatus())
    mocks.controlRuntimeAddon.mockResolvedValue({ success: true, operation: 'stop', addonId: 'cloudflared' })

    const response = await POST(authedEvent({ action: 'stop' }))

    expect(response.status).toBe(200)
    expect(mocks.controlRuntimeAddon).toHaveBeenCalledWith('cloudflared', 'stop')
    expect(mocks.stopManagedCloudflaredTunnel).not.toHaveBeenCalled()
    expect(mocks.updateUserSettings).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        upload_settings: expect.objectContaining({
          cloudflared_target_url: 'http://batshit-server:5600',
          tunnel_url: '',
          use_https: true
        })
      })
    )
    await expect(response.json()).resolves.toMatchObject({
      supportLevel: 'docker-sidecar',
      targetUrl: 'http://batshit-server:5600',
      tunnel: {
        running: false
      }
    })
  })
})
