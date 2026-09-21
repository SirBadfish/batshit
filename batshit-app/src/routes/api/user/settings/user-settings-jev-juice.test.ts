import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from './+server'

/**
 * SA-120 P5 (LS-054) — "Jev Juice: Smart Zip" lives inside `global_zip_settings`, which the
 * Global Tool Grid saves as a WHOLE object. The route is the only gate a mistyped value
 * meets (the read side treats anything but `true` as OFF, so a typo would otherwise be
 * stored and quietly mean "Jev never runs"), and a refused save must write nothing.
 */

useRedisTestServer()

const USER = 'user-jev-smart-zip'

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

describe('global_zip_settings.jev_juice_smart_zip', () => {
  it('stores the switch beside the other global zip defaults and reads it back', async () => {
    const response = await post({ global_zip_settings: { zip_tool_notes_enabled: true, jev_juice_smart_zip: true } })
    expect(response.status).toBe(200)
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_zip_settings).toEqual({ zip_tool_notes_enabled: true, jev_juice_smart_zip: true })
  })

  it('refuses a value that is not true or false, and writes nothing', async () => {
    await post({ global_zip_settings: { zip_tool_notes_enabled: true } })
    const response = await post({ global_zip_settings: { zip_tool_notes_enabled: false, jev_juice_smart_zip: 'yes' } })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/Jev Juice: Smart Zip.*true or false/)
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_zip_settings).toEqual({ zip_tool_notes_enabled: true })
  })

  it('an unrelated save carries the stored switch forward', async () => {
    await post({ global_zip_settings: { jev_juice_smart_zip: true } })
    await post({ upload_provider: 'local' })
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_zip_settings).toEqual({ jev_juice_smart_zip: true })
  })
})
