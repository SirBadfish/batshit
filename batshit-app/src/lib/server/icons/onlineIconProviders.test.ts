import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { getStoredCustomIcon } from '$lib/server/icons/iconLibrary'
import { importOnlineIcon, searchOnlineIcons } from '$lib/server/icons/onlineIconProviders'

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('online icon providers', () => {
  useRedisTestServer()

  it('searches Simple Icons candidates with safe preview SVG', async () => {
    const results = await searchOnlineIcons({
      query: 'youtube',
      providers: ['simple-icons'],
      limit: 5
    })

    const youtube = results.find((icon) => icon.slug === 'youtube')
    expect(youtube?.title).toBe('YouTube')
    expect(youtube?.provider).toBe('simple-icons')
    expect(youtube?.previewSvg).toContain('<svg')
    expect(youtube?.previewSvg).not.toContain('<title')
  })

  it('imports Simple Icons into the custom icon library with provenance', async () => {
    const userId = 'online_icon_simple_user'
    const icon = await importOnlineIcon(userId, {
      provider: 'simple-icons',
      slug: 'youtube'
    })
    const stored = await getStoredCustomIcon(userId, icon.id)

    expect(icon.name).toBe('YouTube')
    expect(icon.source?.provider).toBe('simple-icons')
    expect(icon.source?.slug).toBe('youtube')
    expect(stored?.content).toContain('#FF0000')
    expect(stored?.content).not.toContain('<title')
  })

  it('searches Lobe Icons candidates', async () => {
    const results = await searchOnlineIcons({
      query: 'openai',
      providers: ['lobe-icons'],
      limit: 8
    })

    expect(results.some((icon) => icon.provider === 'lobe-icons' && icon.slug.includes('openai'))).toBe(true)
  })

  it('imports Lobe Icons with sanitized SVG content', async () => {
    const userId = 'online_icon_lobe_user'
    const icon = await importOnlineIcon(userId, {
      provider: 'lobe-icons',
      slug: 'openai'
    })
    const stored = await getStoredCustomIcon(userId, icon.id)

    expect(icon.name).toMatch(/openai/i)
    expect(icon.source?.provider).toBe('lobe-icons')
    expect(icon.source?.slug).toBe('openai')
    expect(stored?.content).toContain('<svg')
    expect(stored?.content).not.toContain('<title')
    expect(stored?.content).not.toContain('style=')
  })
})
