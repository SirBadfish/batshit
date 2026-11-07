import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from './+server'

/**
 * SA-136 D1 (LS-083): the typed file tools' global grant lives inside `global_tool_grid_settings`,
 * which the Global Tool Grid saves as a WHOLE object. The route is the only gate a mistyped value
 * meets (the readers treat anything but true or false as "inherit"), and a refused save writes
 * nothing.
 */

useRedisTestServer()

const USER = 'user-typed-file-tools'

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER, email: 't@example.com' } }
  } as any)
}

describe('global_tool_grid_settings.typed_file_tools', () => {
  it('stores true, false or null beside the grid defaults and reads them back', async () => {
    for (const value of [true, false, null]) {
      const response = await post({ global_tool_grid_settings: { cli: { discoverableToolIds: [] }, typed_file_tools: value } })
      expect(response.status).toBe(200)
      const stored = await redis.getUserSettings(USER)
      expect((stored as any)?.global_tool_grid_settings?.typed_file_tools).toBe(value)
    }
  })

  it('refuses any other value, and writes nothing', async () => {
    await post({ global_tool_grid_settings: { typed_file_tools: true } })
    for (const value of ['true', 1, {}]) {
      const response = await post({ global_tool_grid_settings: { typed_file_tools: value } })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('"Typed File Tools" must be true or false.')
    }
    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_tool_grid_settings).toEqual({ typed_file_tools: true })
  })
})
