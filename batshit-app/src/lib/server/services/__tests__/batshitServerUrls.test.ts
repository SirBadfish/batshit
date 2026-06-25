import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dynamicPrivateEnv = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>
}))

vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)

import {
  getInternalBatshitServerApiUrl,
  getInternalBatshitServerTaskUrl,
  getInternalBatshitServerUrl,
  getPublicBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload,
  rewriteInternalBatshitServerUrlToPublic
} from '../batshitServerUrls'

describe('batshitServerUrls', () => {
  const originalPublicServerUrl = process.env.PUBLIC_BATSHIT_SERVER_URL

  beforeEach(() => {
    for (const key of Object.keys(dynamicPrivateEnv.env)) {
      delete dynamicPrivateEnv.env[key]
    }
    restorePublicServerUrl()
  })

  afterEach(() => {
    restorePublicServerUrl()
  })

  function restorePublicServerUrl() {
    if (originalPublicServerUrl === undefined) {
      delete process.env.PUBLIC_BATSHIT_SERVER_URL
    } else {
      process.env.PUBLIC_BATSHIT_SERVER_URL = originalPublicServerUrl
    }
  }

  it('prefers the internal Docker service URL for server-side callers', () => {
    dynamicPrivateEnv.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600/'

    expect(getInternalBatshitServerUrl()).toBe('http://batshit-server:5600')
    expect(getInternalBatshitServerApiUrl()).toBe('http://batshit-server:5600/api/v1')
    expect(getInternalBatshitServerTaskUrl()).toBe('http://batshit-server:5600/api/v1/task/s')
  })

  it('keeps the public URL available for browser-facing records', () => {
    dynamicPrivateEnv.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600/'

    expect(getPublicBatshitServerUrl()).toBe('http://localhost:5600')
  })

  it('falls back to localhost for native development', () => {
    expect(getInternalBatshitServerUrl()).toBe('http://localhost:5600')
    expect(getPublicBatshitServerUrl()).toBe('http://localhost:5600')
  })

  it('rewrites internal Docker batshit-server URLs before saving browser-facing records', () => {
    dynamicPrivateEnv.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5614/'

    expect(
      rewriteInternalBatshitServerUrlToPublic(
        'http://batshit-server:5600/uploads/goons/avatar.vrm?download=1#preview'
      )
    ).toBe('http://localhost:5614/uploads/goons/avatar.vrm?download=1#preview')
  })

  it('recursively rewrites upload response payload URLs only for the internal server origin', () => {
    dynamicPrivateEnv.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600/'
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
})
