import { describe, expect, it } from 'vitest'

import { resolveLiveKitSidecarBatshitBaseUrl } from '$lib/server/services/liveKitSidecarUrls'

describe('resolveLiveKitSidecarBatshitBaseUrl', () => {
  it('prefers the sidecar-specific callback URL', () => {
    expect(
      resolveLiveKitSidecarBatshitBaseUrl({
        LIVEKIT_AGENT_BATSHIT_BASE_URL: 'http://localhost:5620/',
        BATSHIT_FRONTEND_URL: 'http://localhost:5600'
      })
    ).toBe('http://localhost:5620')
  })

  it('uses the real Batshit frontend URL before port fallback', () => {
    expect(
      resolveLiveKitSidecarBatshitBaseUrl({
        BATSHIT_FRONTEND_URL: 'http://localhost:5620'
      })
    ).toBe('http://localhost:5620')
  })

  it('falls back to the Svelte dev app port instead of batshit-server port 5600', () => {
    expect(resolveLiveKitSidecarBatshitBaseUrl({})).toBe('http://localhost:5620')
  })
})
