import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getInternalBatshitServerApiUrl,
  getInternalBatshitServerTaskUrl,
  getInternalBatshitServerUrl,
  getPublicBatshitServerUrl,
  normalizeUploadUrlForStorage,
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlForBrowser,
  resolveUploadUrlsForBrowserInPayload,
  rewriteInternalBatshitServerUrlsInPayload,
  rewriteInternalBatshitServerUrlToPublic
} from '../batshitServerUrls'

describe('batshitServerUrls', () => {
  const envKeys = [
    'BATSHIT_SERVER_URL',
    'BATSHIT_SERVER_API_URL',
    'PUBLIC_BATSHIT_SERVER_URL'
  ] as const
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

  beforeEach(() => {
    for (const key of envKeys) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      const original = originalEnv.get(key)
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  })

  it('prefers the internal Docker service URL for server-side callers', () => {
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600/'

    expect(getInternalBatshitServerUrl()).toBe('http://batshit-server:5600')
    expect(getInternalBatshitServerApiUrl()).toBe('http://batshit-server:5600/api/v1')
    expect(getInternalBatshitServerTaskUrl()).toBe('http://batshit-server:5600/api/v1/task/s')
  })

  it('keeps the public URL available for browser-facing records', () => {
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600/'

    expect(getPublicBatshitServerUrl()).toBe('http://localhost:5600')
  })

  it('falls back to localhost for native development', () => {
    expect(getInternalBatshitServerUrl()).toBe('http://localhost:5600')
    expect(getPublicBatshitServerUrl()).toBe('http://localhost:5600')
  })

  it('rewrites internal Docker batshit-server URLs before saving browser-facing records', () => {
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5614/'

    expect(
      rewriteInternalBatshitServerUrlToPublic(
        'http://batshit-server:5600/uploads/goons/avatar.vrm?download=1#preview'
      )
    ).toBe('http://localhost:5614/uploads/goons/avatar.vrm?download=1#preview')
  })

  it('recursively rewrites upload response payload URLs only for the internal server origin', () => {
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5614/'

    const payload = rewriteInternalBatshitServerUrlsInPayload({
      file: {
        url: 'http://batshit-server:5600/uploads/goons/avatar.vrm',
        filename: 'avatar.vrm'
      },
      files: {
        manifest: {
          url: 'http://batshit-server:5600/uploads/goon_guided_manifests/avatar.json'
        },
        external: {
          url: 'https://example.com/model.vrm'
        }
      }
    })

    expect(payload.file.url).toBe('http://localhost:5614/uploads/goons/avatar.vrm')
    expect(payload.files.manifest.url).toBe(
      'http://localhost:5614/uploads/goon_guided_manifests/avatar.json'
    )
    expect(payload.files.external.url).toBe('https://example.com/model.vrm')
  })

  it('normalizes persisted upload URLs to relative paths without trusting stale hosts', () => {
    expect(
      normalizeUploadUrlForStorage(
        'http://localhost:5600/uploads/images/avatar.png?size=full#preview'
      )
    ).toBe('/uploads/images/avatar.png?size=full#preview')
    expect(
      normalizeUploadUrlForStorage('http://127.0.0.1:5606/uploads/goons/avatar.vrm')
    ).toBe('/uploads/goons/avatar.vrm')
    expect(normalizeUploadUrlForStorage('/uploads/goons/avatar.vrm')).toBe(
      '/uploads/goons/avatar.vrm'
    )
    expect(normalizeUploadUrlForStorage('/goons/stunt-dummy.vrm')).toBe(
      '/goons/stunt-dummy.vrm'
    )
  })

  it('resolves legacy absolute upload URLs against the current public server URL', () => {
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5610/'

    expect(resolveUploadUrlForBrowser('http://localhost:5600/uploads/images/avatar.png')).toBe(
      'http://localhost:5610/uploads/images/avatar.png'
    )
    expect(resolveUploadUrlForBrowser('http://127.0.0.1:5606/uploads/goons/avatar.vrm')).toBe(
      'http://localhost:5610/uploads/goons/avatar.vrm'
    )
    expect(resolveUploadUrlForBrowser('/uploads/goon_scenes/room.glb')).toBe(
      'http://localhost:5610/uploads/goon_scenes/room.glb'
    )
  })

  it('recursively normalizes storage payloads and resolves browser payloads', () => {
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5610'

    const stored = normalizeUploadUrlsForStorageInPayload({
      avatar: 'http://localhost:5600/uploads/avatars/agent.png',
      nested: {
        thumbnailUrl: 'https://old.example/uploads/goon_scene_thumbs/room.jpg'
      },
      external: 'https://cdn.example/assets/not-an-upload.png'
    })

    expect(stored.avatar).toBe('/uploads/avatars/agent.png')
    expect(stored.nested.thumbnailUrl).toBe('/uploads/goon_scene_thumbs/room.jpg')
    expect(stored.external).toBe('https://cdn.example/assets/not-an-upload.png')

    const browser = resolveUploadUrlsForBrowserInPayload(stored)
    expect(browser.avatar).toBe('http://localhost:5610/uploads/avatars/agent.png')
    expect(browser.nested.thumbnailUrl).toBe(
      'http://localhost:5610/uploads/goon_scene_thumbs/room.jpg'
    )
    expect(browser.external).toBe('https://cdn.example/assets/not-an-upload.png')
  })
})
