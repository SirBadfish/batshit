import { beforeEach, describe, expect, it, vi } from 'vitest'

const cloudflaredMocks = vi.hoisted(() => ({
  ensureManagedCloudflaredTunnel: vi.fn(),
  getCloudflaredRuntimeStatus: vi.fn(),
  getDefaultManagedTunnelTargetUrl: vi.fn(() => 'http://localhost:5600'),
}))

vi.mock('../cloudflaredRuntime', () => ({
  ensureManagedCloudflaredTunnel: cloudflaredMocks.ensureManagedCloudflaredTunnel,
  getCloudflaredRuntimeStatus: cloudflaredMocks.getCloudflaredRuntimeStatus,
  getDefaultManagedTunnelTargetUrl: cloudflaredMocks.getDefaultManagedTunnelTargetUrl,
}))

import {
  buildTunnelPathFromLocalUrl,
  resolveClipTunnelUrl,
  resolveScreenshotUploadModelUrl,
  resolveUploadConfigForScreenshot,
} from '../clipUrlResolver'

describe('clipUrlResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cloudflaredMocks.getCloudflaredRuntimeStatus.mockResolvedValue({
      tunnel: {
        publicUrl: null,
      },
    })
    cloudflaredMocks.ensureManagedCloudflaredTunnel.mockResolvedValue({
      started: false,
      status: {
        publicUrl: null,
      },
    })
  })

  it('derives a reusable tunnel path from a local upload URL', () => {
    expect(
      buildTunnelPathFromLocalUrl('http://localhost:5600/uploads/images/example.png')
    ).toBe('/uploads/images/example.png')
  })

  it('resolves manual tunnel URLs without needing upload-time host storage', async () => {
    const resolved = await resolveClipTunnelUrl(
      {
        tunnelPath: '/uploads/images/example.png',
      },
      {
        ui_settings: {
          upload_settings: {
            strategy: 'local',
            tunnel_provider: 'manual',
            tunnel_url: 'https://tunnel.example',
            use_https: true,
          },
        },
      } as any
    )

    expect(resolved).toBe('https://tunnel.example/uploads/images/example.png')
  })

  it('does not resolve stale tunnel URLs when provider is none', async () => {
    const resolved = await resolveClipTunnelUrl(
      {
        tunnelPath: '/uploads/images/example.png',
      },
      {
        ui_settings: {
          upload_settings: {
            strategy: 'local',
            tunnel_provider: 'none',
            tunnel_url: 'https://stale-tunnel.example',
            use_https: true,
          },
        },
      } as any
    )

    expect(resolved).toBeNull()
  })

  it('derives the tunnel path from localUrl when tunnelPath is missing', async () => {
    const resolved = await resolveClipTunnelUrl(
      {
        tunnelPath: undefined,
        localUrl: 'http://localhost:5600/uploads/images/example.png',
        displayUrl: 'http://localhost:5600/uploads/images/example.png',
      },
      {
        ui_settings: {
          upload_settings: {
            strategy: 'local',
            tunnel_provider: 'manual',
            tunnel_url: 'https://fresh-tunnel.example',
            use_https: true,
          },
        },
      } as any
    )

    expect(resolved).toBe('https://fresh-tunnel.example/uploads/images/example.png')
  })

  it('does not auto-start managed tunnels during passive clip inspection', async () => {
    const resolved = await resolveClipTunnelUrl(
      {
        tunnelPath: '/uploads/images/example.png',
      },
      {
        ui_settings: {
          upload_settings: {
            strategy: 'local',
            tunnel_provider: 'cloudflared_managed',
            cloudflared_auto_start: true,
          },
        },
      } as any
    )

    expect(resolved).toBeNull()
    expect(cloudflaredMocks.ensureManagedCloudflaredTunnel).not.toHaveBeenCalled()
  })

  it('can auto-start managed tunnels on real send-time resolution', async () => {
    cloudflaredMocks.ensureManagedCloudflaredTunnel.mockResolvedValue({
      started: true,
      status: {
        publicUrl: 'https://fresh-tunnel.trycloudflare.com',
      },
    })

    const resolved = await resolveClipTunnelUrl(
      {
        tunnelPath: '/uploads/images/example.png',
      },
      {
        ui_settings: {
          upload_settings: {
            strategy: 'local',
            tunnel_provider: 'cloudflared_managed',
            cloudflared_auto_start: true,
            cloudflared_target_url: 'http://localhost:5600',
          },
        },
      } as any,
      { allowAutoStart: true }
    )

    expect(resolved).toBe(
      'https://fresh-tunnel.trycloudflare.com/uploads/images/example.png'
    )
    expect(cloudflaredMocks.ensureManagedCloudflaredTunnel).toHaveBeenCalledWith({
      targetUrl: 'http://localhost:5600',
    })
  })

  it('builds screenshot upload config from manual tunnel settings', async () => {
    const resolved = await resolveUploadConfigForScreenshot({
      ui_settings: {
        upload_settings: {
          strategy: 'local',
          tunnel_provider: 'manual',
          tunnel_url: 'screens.example',
          use_https: true,
        },
      },
    } as any)

    expect(resolved).toEqual({
      strategy: 'local',
      storageMode: 'local',
      tunnelUrl: 'https://screens.example',
      useHttps: true,
      tunnelProvider: 'manual',
      cloudflaredAutoStart: false,
      cloudflaredTargetUrl: 'http://localhost:5600',
    })
  })

  it('uses the current managed tunnel for screenshot upload config', async () => {
    cloudflaredMocks.getCloudflaredRuntimeStatus.mockResolvedValue({
      tunnel: {
        publicUrl: 'https://current.trycloudflare.com',
      },
    })

    const resolved = await resolveUploadConfigForScreenshot({
      ui_settings: {
        upload_settings: {
          strategy: 'local',
          tunnel_provider: 'cloudflared_managed',
          cloudflared_auto_start: false,
        },
      },
    } as any)

    expect(resolved?.tunnelUrl).toBe('https://current.trycloudflare.com')
    expect(resolved?.tunnelProvider).toBe('cloudflared_managed')
    expect(cloudflaredMocks.ensureManagedCloudflaredTunnel).not.toHaveBeenCalled()
  })

  it('forces managed tunnel start for screenshots when no current tunnel exists', async () => {
    cloudflaredMocks.ensureManagedCloudflaredTunnel.mockResolvedValue({
      started: true,
      status: {
        publicUrl: 'https://started.trycloudflare.com',
      },
    })

    const resolved = await resolveUploadConfigForScreenshot({
      ui_settings: {
        upload_settings: {
          strategy: 'local',
          tunnel_provider: 'cloudflared_managed',
          cloudflared_auto_start: false,
          cloudflared_target_url: 'http://127.0.0.1:5600',
        },
      },
    } as any)

    expect(resolved?.tunnelUrl).toBe('https://started.trycloudflare.com')
    expect(cloudflaredMocks.ensureManagedCloudflaredTunnel).toHaveBeenCalledWith({
      targetUrl: 'http://127.0.0.1:5600',
    })
  })

  it('reports managed screenshot tunnel failures through the caller callback', async () => {
    const onManagedTunnelUnavailable = vi.fn()
    cloudflaredMocks.ensureManagedCloudflaredTunnel.mockResolvedValue({
      started: false,
      reason: 'process exited',
      status: {
        publicUrl: null,
        lastError: 'port closed',
      },
    })

    const resolved = await resolveUploadConfigForScreenshot(
      {
        ui_settings: {
          upload_settings: {
            strategy: 'local',
            tunnel_provider: 'cloudflared_managed',
            cloudflared_auto_start: true,
            cloudflared_target_url: 'http://127.0.0.1:5600',
          },
        },
      } as any,
      { onManagedTunnelUnavailable }
    )

    expect(resolved).toBeNull()
    expect(onManagedTunnelUnavailable).toHaveBeenCalledWith({
      targetUrl: 'http://127.0.0.1:5600',
      reason: 'process exited',
    })
  })

  it('resolves uploaded screenshot model URLs through the fresh tunnel base first', () => {
    expect(
      resolveScreenshotUploadModelUrl(
        {
          localUrl: 'http://localhost:5600/uploads/screenshots/example.png',
          externalUrl: 'https://stale.example/example.png',
        },
        {
          tunnelUrl: 'https://fresh.example',
        }
      )
    ).toBe('https://fresh.example/uploads/screenshots/example.png')
  })
})
