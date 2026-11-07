import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * The app's look (Josh, 2026-10-29) is `appearance_settings.look`. The settings route builds
 * its update from a named list, so a block it does not name is dropped and the Themes panel
 * would look saved while every window kept the old look. A malformed look is refused, never
 * stored and quietly read as the default. A saved look tells every open window to repaint.
 */

const published = vi.hoisted(() => [] as unknown[])
vi.mock('$lib/server/ssePublisher', () => ({
  publishUserEvent: vi.fn(async (_user: string, event: unknown) => { published.push(event) })
}))

const { POST } = await import('./+server')

useRedisTestServer()

const USER = 'user-appearance-settings'

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER, email: 'j@example.com' } }
  } as any)
}

describe('appearance_settings', () => {
  beforeEach(() => { published.length = 0 })
  afterEach(() => { vi.clearAllMocks() })

  it('stores the look, answers with it, and tells every window to repaint', async () => {
    const response = await post({ appearance_settings: { look: 'minimal' } })
    expect(response.status).toBe(200)
    expect((await response.json()).settings.appearance_settings).toEqual({ look: 'minimal' })
    expect(((await redis.getUserSettings(USER)) as any)?.appearance_settings).toEqual({ look: 'minimal' })
    expect(published).toContainEqual({ type: 'user_settings_changed', family: 'appearance' })
  })

  it('keeps a stored look through an unrelated save, which publishes nothing about looks', async () => {
    await post({ appearance_settings: { look: 'og' } })
    published.length = 0
    expect((await post({ upload_provider: 'local' })).status).toBe(200)
    expect(((await redis.getUserSettings(USER)) as any)?.appearance_settings).toEqual({ look: 'og' })
    expect(published).not.toContainEqual({ type: 'user_settings_changed', family: 'appearance' })
  })

  it('refuses a malformed look with a 400 and saves nothing', async () => {
    await post({ appearance_settings: { look: 'cave' } })
    published.length = 0
    for (const bad of [{ look: 'neon' }, { look: 'cave', accent: 'pink' }, 'minimal', null]) {
      const response = await post({ appearance_settings: bad })
      expect(response.status).toBe(400)
    }
    expect(((await redis.getUserSettings(USER)) as any)?.appearance_settings).toEqual({ look: 'cave' })
    expect(published).toEqual([])
  })
})
