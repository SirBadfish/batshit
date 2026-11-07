import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from './+server'

/**
 * SA-137 P4a (D11) — "Live File Reads" lives inside `global_zip_settings`, which the Global Tool
 * Grid saves as a WHOLE object. The route is the only gate a mistyped value meets (the resolver
 * reads anything but true or false as "not set", so a typo would otherwise be stored and quietly
 * mean off), and a refused save writes nothing.
 */

useRedisTestServer()

const USER = 'user-live-file-reads'

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER, email: 'l@example.com' } }
  } as any)
}

describe('global_zip_settings.live_file_reads', () => {
  it('stores true, false or null beside the other global zip defaults and reads them back', async () => {
    for (const value of [true, false, null]) {
      const response = await post({ global_zip_settings: { zip_tool_notes_enabled: true, live_file_reads: value } })
      expect(response.status).toBe(200)
      const stored = await redis.getUserSettings(USER)
      expect((stored as any)?.global_zip_settings).toEqual({ zip_tool_notes_enabled: true, live_file_reads: value })
    }
  })

  it('a save without the field stores no value for it (Default is stored as absent)', async () => {
    const response = await post({ global_zip_settings: { zip_tool_notes_enabled: true } })
    expect(response.status).toBe(200)
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_zip_settings).toEqual({ zip_tool_notes_enabled: true })
    expect((stored as any)?.global_zip_settings).not.toHaveProperty('live_file_reads')
  })

  it('refuses any other value, and writes nothing', async () => {
    await post({ global_zip_settings: { zip_tool_notes_enabled: true, live_file_reads: true } })
    for (const value of ['true', 'yes', 1, {}, []]) {
      const response = await post({ global_zip_settings: { zip_tool_notes_enabled: false, live_file_reads: value } })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('"Refreshed File Reads" must be true or false.')
    }
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_zip_settings).toEqual({ zip_tool_notes_enabled: true, live_file_reads: true })
  })

  it('an unrelated save carries the stored value forward', async () => {
    await post({ global_zip_settings: { live_file_reads: false } })
    await post({ upload_provider: 'local' })
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_zip_settings).toEqual({ live_file_reads: false })
  })
})
