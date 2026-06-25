import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMocks = vi.hoisted(() => ({
  get: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: redisMocks.get
  }
}))

import {
  isRemoteHttpUrl,
  resolveClipDataUrlFromStoredUpload,
  resolveClipPreferredRemoteUrl,
  resolveClipPreferredUrl,
  resolveClipUploadLocator
} from '../clipUploadPayload'

describe('clipUploadPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves an upload Redis key from a local upload URL', () => {
    const locator = resolveClipUploadLocator({
      localUrl: 'http://localhost:5600/uploads/images/photo.png'
    } as any)

    expect(locator).toEqual({
      uploadType: 'images',
      filename: 'photo.png',
      path: '/uploads/images/photo.png',
      redisKey: 'upload:images:photo.png'
    })
  })

  it('builds a structured data URL from the stored upload record at send time', async () => {
    redisMocks.get.mockResolvedValue({
      mimetype: 'image/png',
      base64: 'iVBORw0KGgo='
    })

    const dataUrl = await resolveClipDataUrlFromStoredUpload({
      mimeType: 'image/png',
      tunnelPath: '/uploads/images/photo.png'
    } as any)

    expect(redisMocks.get).toHaveBeenCalledWith('upload:images:photo.png')
    expect(dataUrl).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('builds the preferred tunnel URL from current settings', async () => {
    const preferredUrl = await resolveClipPreferredUrl(
      {
        tunnelPath: '/uploads/images/photo.png',
        localUrl: 'http://localhost:5600/uploads/images/photo.png'
      } as any,
      {
        ui_settings: {
          upload_settings: {
            tunnel_provider: 'manual',
            tunnel_url: 'https://fresh-tunnel.example'
          }
        }
      } as any
    )

    expect(preferredUrl).toBe('https://fresh-tunnel.example/uploads/images/photo.png')
  })

  it('returns the preferred remote URL for model-facing cloud image transport', async () => {
    const preferredUrl = await resolveClipPreferredRemoteUrl(
      {
        tunnelPath: '/uploads/images/photo.png',
        localUrl: 'http://localhost:5600/uploads/images/photo.png'
      } as any,
      {
        ui_settings: {
          upload_settings: {
            tunnel_provider: 'manual',
            tunnel_url: 'https://fresh-tunnel.example'
          }
        }
      } as any
    )

    expect(preferredUrl).toBe('https://fresh-tunnel.example/uploads/images/photo.png')
  })

  it('falls back to the local URL when tunnel provider is none', async () => {
    const preferredUrl = await resolveClipPreferredUrl(
      {
        tunnelPath: '/uploads/images/photo.png',
        localUrl: 'http://localhost:5600/uploads/images/photo.png'
      } as any,
      {
        ui_settings: {
          upload_settings: {
            tunnel_provider: 'none',
            tunnel_url: 'https://stale-tunnel.example'
          }
        }
      } as any
    )

    expect(preferredUrl).toBe('http://localhost:5600/uploads/images/photo.png')
  })

  it('does not treat loopback URLs as remote model-facing URLs', async () => {
    expect(isRemoteHttpUrl('http://localhost:5600/uploads/image.png')).toBe(false)
    expect(isRemoteHttpUrl('http://127.0.0.1:5600/uploads/image.png')).toBe(false)
    expect(isRemoteHttpUrl('https://fresh-tunnel.example/uploads/image.png')).toBe(true)

    const preferredUrl = await resolveClipPreferredRemoteUrl(
      {
        tunnelPath: '/uploads/images/photo.png',
        localUrl: 'http://localhost:5600/uploads/images/photo.png'
      } as any,
      {
        ui_settings: {
          upload_settings: {
            tunnel_provider: 'none'
          }
        }
      } as any
    )

    expect(preferredUrl).toBeNull()
  })
})
