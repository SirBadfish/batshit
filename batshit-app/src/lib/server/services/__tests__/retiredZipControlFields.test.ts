// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { removeRetiredZipControlFields } from '../retiredZipControlFields'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

/**
 * BL-1484 (Josh, 2026-10-13): the parked zip control permission's two older keys are removed at
 * startup, not only ignored. Real RedisJSON path deletes (DB15 through `npm run test:redis`): the
 * legacy fields go, every sibling field's stored value stays byte for byte, a record without them is
 * untouched, a key that is not a JSON document is left alone, and a second run changes nothing.
 *
 * Measured here (Redis 8.10.1): `JSON.DEL` of an object member moves the object's LAST member into
 * the freed slot, so the edited object's member ORDER changes while every value stays the same. JSON
 * objects are unordered and no Batshit reader depends on member order, so the test compares each
 * sibling's own stored text, not the whole document's.
 */

useRedisTestServer()

afterEach(() => {
  vi.restoreAllMocks()
})

/** Each sibling's stored text, read path by path, so member order does not count. */
async function siblings(key: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const path of paths) out[path] = await redis.execute((client: any) => client.sendCommand(['JSON.GET', key, path]))
  return out
}

const SETTINGS_SIBLING_PATHS = [
  '$.user_id', '$.global_custom_system_prompt', '$.global_tool_grid_settings',
  ...Object.keys({
    zip_ai_view_mode: 1, zip_tool_notes_enabled: 1, zip_agent_control_experiment: 1, custom_tool_settings: 1, jev_juice_smart_zip: 1
  }).map((field) => `$.global_zip_settings.${field}`)
]
const AZ1_SIBLING_PATHS = ['$.id', '$.user_id', '$.displayName', '$.zip_agent_control_experiment', '$.zip_ai_view_mode', '$.buffer_size_read_file', '$.provider_specific_settings']
const AZ2_SIBLING_PATHS = ['$.id', '$.user_id', '$.displayName', '$.zip_tool_notes_enabled']
const SZ1_SIBLING_PATHS = ['$.id', '$.user_id', '$.name', '$.buffer_size_read_file', '$.provider_specific_settings']

const raw = (key: string) => redis.execute((client: any) => client.sendCommand(['JSON.GET', key, '$'])) as Promise<string>
const setJson = (key: string, value: unknown) => redis.execute((client: any) => client.json.set(key, '$', value))

const SETTINGS_SIBLINGS = {
  zip_ai_view_mode: 'appended',
  zip_tool_notes_enabled: true,
  zip_agent_control_experiment: true,
  custom_tool_settings: [{ tool_name: 'read_file', buffer_size: 3, auto_zip: false }],
  jev_juice_smart_zip: true
}

async function seed() {
  await setJson('user:uz1:settings', {
    user_id: 'uz1',
    global_custom_system_prompt: 'keep me',
    global_zip_settings: { zip_agent_control_enabled: true, zip_control_mode: 'agent', ...SETTINGS_SIBLINGS },
    global_tool_grid_settings: { cli: { discoverableToolIds: ['x'] } }
  })
  await setJson('agent:az1', {
    id: 'az1', user_id: 'uz1', displayName: 'Lucy', zip_agent_control_enabled: true, zip_control_mode: 'user',
    zip_agent_control_experiment: false, zip_ai_view_mode: 'inline', buffer_size_read_file: 9,
    provider_specific_settings: { nativeTools: { bashEnabled: true } }
  })
  await setJson('agent:az2', { id: 'az2', user_id: 'uz1', displayName: 'Kiriko', zip_agent_control_enabled: true, zip_tool_notes_enabled: false })
  await setJson('agent:az3', { id: 'az3', user_id: 'uz1', displayName: 'Bob', zip_ai_view_mode: 'appended' })
  await setJson('subagent:sz1', {
    id: 'sz1', user_id: 'uz1', name: 'Scout', zip_agent_control_enabled: false, zip_control_mode: 'agent',
    buffer_size_read_file: 4, provider_specific_settings: { nativeTools: { webSearchEnabled: true } }
  })
  await setJson('subagent:sz1:runs', { zip_control_mode: 'agent' })
  await setJson('user:uz2:settings', { user_id: 'uz2', global_zip_settings: { zip_ai_view_mode: 'inline' } })
  // Not agent records: another family under agent:, and a non-JSON key.
  await setJson('agent:az1:notes', { zip_agent_control_enabled: true })
  await redis.execute((client: any) => client.set('agent:azstring', 'zip_agent_control_enabled'))
}

describe.runIf(REAL_REDIS_LANE)('removeRetiredZipControlFields (BL-1484, real RedisJSON)', () => {
  it('removes the legacy fields, keeps every sibling byte for byte, and a second run changes nothing', async () => {
    await seed()
    const siblingsBefore = {
      settings: await siblings('user:uz1:settings', SETTINGS_SIBLING_PATHS),
      az1: await siblings('agent:az1', AZ1_SIBLING_PATHS),
      az2: await siblings('agent:az2', AZ2_SIBLING_PATHS),
      sz1: await siblings('subagent:sz1', SZ1_SIBLING_PATHS)
    }
    const untouchedBefore = {
      subRuns: await raw('subagent:sz1:runs'),
      az3: await raw('agent:az3'),
      uz2: await raw('user:uz2:settings'),
      notes: await raw('agent:az1:notes'),
      string: await redis.execute((client: any) => client.get('agent:azstring'))
    }
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const first = await removeRetiredZipControlFields()

    expect(first).toEqual({ records: 4, fields: 7 })
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toBe('[Startup] Removed 7 retired zip control field(s) from 4 record(s) (BL-1484).')

    expect(JSON.parse(await raw('user:uz1:settings'))).toEqual([{
      user_id: 'uz1',
      global_custom_system_prompt: 'keep me',
      global_zip_settings: SETTINGS_SIBLINGS,
      global_tool_grid_settings: { cli: { discoverableToolIds: ['x'] } }
    }])
    expect(JSON.parse(await raw('agent:az1'))).toEqual([{
      id: 'az1', user_id: 'uz1', displayName: 'Lucy', zip_agent_control_experiment: false, zip_ai_view_mode: 'inline',
      buffer_size_read_file: 9, provider_specific_settings: { nativeTools: { bashEnabled: true } }
    }])
    expect(JSON.parse(await raw('agent:az2'))).toEqual([{ id: 'az2', user_id: 'uz1', displayName: 'Kiriko', zip_tool_notes_enabled: false }])
    // Byte for byte: every sibling's own stored text is exactly what it was.
    expect(await siblings('user:uz1:settings', SETTINGS_SIBLING_PATHS)).toEqual(siblingsBefore.settings)
    expect(await siblings('agent:az1', AZ1_SIBLING_PATHS)).toEqual(siblingsBefore.az1)
    expect(await siblings('agent:az2', AZ2_SIBLING_PATHS)).toEqual(siblingsBefore.az2)
    expect(await siblings('subagent:sz1', SZ1_SIBLING_PATHS)).toEqual(siblingsBefore.sz1)
    expect(JSON.parse(await raw('subagent:sz1'))).toEqual([{
      id: 'sz1', user_id: 'uz1', name: 'Scout', buffer_size_read_file: 4, provider_specific_settings: { nativeTools: { webSearchEnabled: true } }
    }])
    expect(await raw('subagent:sz1:runs')).toBe(untouchedBefore.subRuns)
    for (const key of ['user:uz1:settings', 'agent:az1', 'agent:az2', 'subagent:sz1']) {
      expect(await raw(key)).not.toMatch(/zip_agent_control_enabled|zip_control_mode/)
    }

    // Records without the fields, another key family, and a non-JSON key are untouched.
    expect(await raw('agent:az3')).toBe(untouchedBefore.az3)
    expect(await raw('user:uz2:settings')).toBe(untouchedBefore.uz2)
    expect(await raw('agent:az1:notes')).toBe(untouchedBefore.notes)
    expect(await redis.execute((client: any) => client.get('agent:azstring'))).toBe(untouchedBefore.string)

    const swept = {
      settings: await raw('user:uz1:settings'),
      az1: await raw('agent:az1'),
      az2: await raw('agent:az2'),
      sz1: await raw('subagent:sz1')
    }
    info.mockClear()
    const second = await removeRetiredZipControlFields()
    expect(second).toEqual({ records: 0, fields: 0 })
    expect(info).not.toHaveBeenCalled()
    expect(await raw('user:uz1:settings')).toBe(swept.settings)
    expect(await raw('agent:az1')).toBe(swept.az1)
    expect(await raw('agent:az2')).toBe(swept.az2)
    expect(await raw('subagent:sz1')).toBe(swept.sz1)
  })

  it('does nothing and says nothing on an instance with no legacy fields', async () => {
    await setJson('user:uz3:settings', { user_id: 'uz3', global_zip_settings: { zip_agent_control_experiment: true } })
    await setJson('agent:az4', { id: 'az4', zip_agent_control_experiment: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(await removeRetiredZipControlFields()).toEqual({ records: 0, fields: 0 })
    expect(info).not.toHaveBeenCalled()
    expect(JSON.parse(await raw('agent:az4'))).toEqual([{ id: 'az4', zip_agent_control_experiment: true }])
  })
})

describe.skipIf(REAL_REDIS_LANE)('removeRetiredZipControlFields on the fake lane', () => {
  it('is proven on real Redis only (npm run test:redis); the fake has no RedisJSON path delete in Lua', () => {
    expect(REAL_REDIS_LANE).toBe(false)
  })
})
