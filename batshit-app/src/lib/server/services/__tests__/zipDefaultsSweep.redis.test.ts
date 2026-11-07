import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { SWEEP_OLD_ZIP_DEFAULTS_SCRIPT, sweepOldZipDefaults, ZIP_DEFAULTS_SWEEP_KEY } from '../zipDefaultsSweep'
import { getToolSettings } from '$lib/utils/toolRenderMap'

/**
 * SA-126 shipped defaults, step 1d (Josh chose the sweep, 2026-10-19): real Redis 8 only (Lua
 * JSON.DEL by path and the record shapes are the claim), so the default lane skips it.
 * The fixtures are shaped like Josh's own records (read-only look at a copy, 2026-10-19).
 */
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zds_user'
const KEYS = ['agent:zds_stamped', 'agent:zds_mixed', 'agent:zds_text', 'agent:zds_odd', `user:${USER}:settings`,
  'user:zds_bare:settings', 'user:zds_null:settings', 'subagent:zds_sub', ZIP_DEFAULTS_SWEEP_KEY]

const OLD_STAMP = {
  buffer_size_read_file: 8, zip_threshold_read_file: 0, auto_zip_read_file: false,
  buffer_size_write_file: 2, zip_threshold_write_file: 0, auto_zip_write_file: false,
  buffer_size_edit_file: 2, zip_threshold_edit_file: 0, auto_zip_edit_file: false,
  buffer_size_execute_command: 1, zip_threshold_execute_command: 0, auto_zip_execute_command: false,
  buffer_size_list_files: 1, zip_threshold_list_files: 0, auto_zip_list_files: true,
  buffer_size_all_other_tools: 1, zip_threshold_all_other_tools: 0, auto_zip_all_other_tools: true
}
const ZIP_ROW = /^(buffer_size|zip_threshold|auto_zip|zip_disabled)_/
const zipRows = (record: any) => Object.fromEntries(Object.entries(record).filter(([key]) => ZIP_ROW.test(key)))
// Other suites share the real lane's database; judge only this file's records.
const mine = (result: Awaited<ReturnType<typeof sweepOldZipDefaults>>) => {
  const changed = result.changed.filter((entry) => KEYS.includes(entry.key))
  return { records: changed.length, rows: changed.reduce((sum, entry) => sum + entry.rows.length, 0), changed }
}

describe.runIf(REAL)('one-time sweep of old default zip rows (SA-126 1d)', () => {
  const admission = useRedisTestServer()
  beforeEach(async () => {
    admission.requireAdmission()
    for (const key of KEYS) await redis.del(key)
    await redis.json.set('agent:zds_stamped', '$', {
      id: 'zds_stamped', user_id: USER, displayName: 'Stamped', agentType: 'api', description: 'keep me',
      ...OLD_STAMP,
      custom_tool_settings: [{ tool_name: 'skill_read', buffer_size: 10 }, { tool_name: 'fetch_zip', buffer_size: 1, zip_threshold: 0, auto_zip: false }]
    } as never)
    await redis.json.set('agent:zds_mixed', '$', {
      id: 'zds_mixed', user_id: USER, displayName: 'Mixed', agentType: 'api',
      // A choice: a buffer that differs keeps the whole row, Normal included.
      buffer_size_read_file: 2, zip_threshold_read_file: 0, auto_zip_read_file: false, zip_disabled_read_file: false,
      // Exactly the old row plus "not Off": goes whole.
      buffer_size_write_file: 2, zip_threshold_write_file: 0, auto_zip_write_file: false, zip_disabled_write_file: false,
      // Off with the old numbers is a choice.
      buffer_size_edit_file: 2, zip_threshold_edit_file: 0, zip_disabled_edit_file: true,
      // Auto differs from the old Normal: stays.
      buffer_size_execute_command: 1, zip_threshold_execute_command: 0, auto_zip_execute_command: true,
      buffer_size_list_files: 5, zip_threshold_list_files: 300,
      zip_threshold_all_other_tools: 0,
      buffer_size_subagent: 2,
      custom_tool_settings: [
        { tool_name: 'fetch_zip', auto_zip: true, zip_disabled: false },
        { tool_name: 'skill_read', buffer_size: 10, zip_threshold: 0, auto_zip: false, zip_disabled: false },
        { tool_name: 'skill_read', buffer_size: 10, note: 'unknown field: keep' },
        { tool_name: 'search_files', auto_zip: false }
      ]
    } as never)
    await redis.set('agent:zds_text', 'not a JSON document')
    await redis.json.set('subagent:zds_sub', '$', { id: 'zds_sub', user_id: USER, ...OLD_STAMP } as never)
    await redis.json.set(`user:${USER}:settings`, '$', {
      id: `settings_${USER}`, user_id: USER, displayName: 'Probe',
      global_zip_settings: {
        zip_threshold_read_file: 0, buffer_size_read_file: 8, auto_zip_execute_command: true, zip_disabled_subagent: true,
        custom_tool_settings: [{ tool_name: 'skill_read', auto_zip: false }]
      },
      global_tool_grid_settings: { cli: { keep: true } }
    } as never)
  })
  afterEach(async () => { admission.requireAdmission(); for (const key of KEYS) await redis.del(key) })
  afterAll(() => redis.disconnect())

  it('a dry run counts what would go and writes nothing, not even the marker', async () => {
    const before = JSON.stringify([await redis.json.get('agent:zds_stamped'), await redis.json.get('agent:zds_mixed'), await redis.json.get(`user:${USER}:settings`)])
    const result = await sweepOldZipDefaults({ dryRun: true })
    expect(result.status).toBe('dry-run')
    expect(mine(result).records).toBe(3)
    expect(mine(result).changed.map((entry) => [entry.key, entry.rows])).toEqual([
      ['agent:zds_mixed', ['all_other_tools', 'skill_read', 'write_file']],
      ['agent:zds_stamped', ['all_other_tools', 'edit_file', 'execute_command', 'fetch_zip', 'list_files', 'read_file', 'skill_read', 'write_file']],
      [`user:${USER}:settings`, ['read_file', 'skill_read']]
    ])
    expect(await redis.exists(ZIP_DEFAULTS_SWEEP_KEY)).toBeFalsy()
    expect(JSON.stringify([await redis.json.get('agent:zds_stamped'), await redis.json.get('agent:zds_mixed'), await redis.json.get(`user:${USER}:settings`)])).toBe(before)
  })

  it('removes whole old-default rows only, keeps every choice and sibling, and writes the marker', async () => {
    const result = await sweepOldZipDefaults()
    expect(result.status).toBe('swept')
    expect(mine(result)).toMatchObject({ records: 3, rows: 13 })

    const stamped = await redis.json.get('agent:zds_stamped') as any
    expect(zipRows(stamped)).toEqual({})
    expect(stamped.custom_tool_settings).toEqual([])
    expect(stamped.description).toBe('keep me')
    // The agent now runs the new factory rows.
    expect(getToolSettings('read_file', stamped, {})).toMatchObject({ buffer_size: 2, auto_zip: false })
    expect(getToolSettings('edit_file', stamped, {})).toMatchObject({ auto_zip: true })
    expect(getToolSettings('skill_read', stamped, {})).toMatchObject({ buffer_size: 0, auto_zip: true })
    expect(getToolSettings('fetch_zip', stamped, {})).toMatchObject({ auto_zip: true })

    const mixed = await redis.json.get('agent:zds_mixed') as any
    expect(zipRows(mixed)).toEqual({
      buffer_size_read_file: 2, zip_threshold_read_file: 0, auto_zip_read_file: false, zip_disabled_read_file: false,
      buffer_size_edit_file: 2, zip_threshold_edit_file: 0, zip_disabled_edit_file: true,
      buffer_size_execute_command: 1, zip_threshold_execute_command: 0, auto_zip_execute_command: true,
      buffer_size_list_files: 5, zip_threshold_list_files: 300,
      buffer_size_subagent: 2
    })
    expect(mixed.custom_tool_settings).toEqual([
      { tool_name: 'fetch_zip', auto_zip: true, zip_disabled: false },
      { tool_name: 'skill_read', buffer_size: 10, note: 'unknown field: keep' },
      { tool_name: 'search_files', auto_zip: false }
    ])

    const settings = await redis.json.get(`user:${USER}:settings`) as any
    expect(settings.global_zip_settings).toEqual({ auto_zip_execute_command: true, zip_disabled_subagent: true, custom_tool_settings: [] })
    expect(settings.global_tool_grid_settings).toEqual({ cli: { keep: true } })
    expect(settings.displayName).toBe('Probe')

    // Not an agent record, and Subagents were never stamped: both untouched.
    expect(await redis.get('agent:zds_text')).toBe('not a JSON document')
    expect(zipRows(await redis.json.get('subagent:zds_sub'))).toEqual(OLD_STAMP)
    expect(await redis.get(ZIP_DEFAULTS_SWEEP_KEY)).toMatchObject({ version: 1, completed_at: expect.any(String) })
  })

  it('runs once: after the marker, a value equal to an old default is a choice and stays', async () => {
    await sweepOldZipDefaults()
    await redis.json.set('agent:zds_stamped', '$.buffer_size_read_file', 8)
    expect(await sweepOldZipDefaults()).toMatchObject({ status: 'already-complete', records: 0 })
    expect((await redis.json.get('agent:zds_stamped') as any).buffer_size_read_file).toBe(8)
  })

  it('leaves stored nulls, strings, missing or null blocks and odd custom shapes alone', async () => {
    const odd = 'agent:zds_odd'
    const bare = `user:zds_bare:settings`
    const nullBlock = `user:zds_null:settings`
    // Agent Settings stores a Default pick as null: the old numbers beside it still go, the null stays.
    await redis.json.set(odd, '$', {
      id: 'zds_odd', user_id: USER, displayName: 'Odd', agentType: 'api',
      buffer_size_read_file: 8, zip_threshold_read_file: 0, auto_zip_read_file: null,
      buffer_size_write_file: '2', zip_threshold_write_file: 0, auto_zip_write_file: false,
      custom_tool_settings: [null, { tool_name: 'skill_read', buffer_size: 10 }, 'text']
    } as never)
    await redis.json.set(bare, '$', { id: 'settings_zds_bare', user_id: 'zds_bare' } as never)
    await redis.json.set(nullBlock, '$', { id: 'settings_zds_null', user_id: 'zds_null', global_zip_settings: null } as never)
    await redis.json.set('agent:zds_stamped', '$.custom_tool_settings', { skill_read: { buffer_size: 10 } })

    const result = await sweepOldZipDefaults()
    expect(mine(result).changed.find((entry) => entry.key === odd)?.rows).toEqual(['read_file', 'skill_read'])
    expect(mine(result).changed.some((entry) => entry.key === bare || entry.key === nullBlock)).toBe(false)
    const after = await redis.json.get(odd) as any
    expect(zipRows(after)).toEqual({ auto_zip_read_file: null, buffer_size_write_file: '2', zip_threshold_write_file: 0, auto_zip_write_file: false })
    expect(after.custom_tool_settings).toEqual([null, 'text'])
    // (The reader itself throws on a null custom entry, BL-1877, so it reads the rows without them.)
    expect(getToolSettings('read_file', { ...after, custom_tool_settings: [] }, {})).toMatchObject({ buffer_size: 2, auto_zip: false })
    expect(await redis.json.get(bare)).toEqual({ id: 'settings_zds_bare', user_id: 'zds_bare' })
    expect(await redis.json.get(nullBlock)).toEqual({ id: 'settings_zds_null', user_id: 'zds_null', global_zip_settings: null })
    // The legacy object map of custom rows is not a list: untouched.
    expect((await redis.json.get('agent:zds_stamped') as any).custom_tool_settings).toEqual({ skill_read: { buffer_size: 10 } })
  })

  it('a pass that fails part way writes no marker, and the next pass finishes it', async () => {
    const client = await redis.execute(async (connection) => connection)
    const original = client.eval.bind(client)
    let calls = 0
    const spy = vi.spyOn(client, 'eval').mockImplementation(async (script: any, options: any) => {
      if (String(script) === SWEEP_OLD_ZIP_DEFAULTS_SCRIPT && options.keys[0] === 'agent:zds_stamped' && calls++ === 0) {
        throw new Error('injected sweep failure')
      }
      return original(script, options)
    })
    try {
      await expect(sweepOldZipDefaults()).rejects.toThrow('injected sweep failure')
    } finally {
      spy.mockRestore()
    }
    expect(await redis.exists(ZIP_DEFAULTS_SWEEP_KEY)).toBeFalsy()
    // `agent:zds_mixed` (sorted first) was already swept; the retry removes only what is left.
    expect(mine(await sweepOldZipDefaults()).changed.map((entry) => entry.key)).toEqual(['agent:zds_stamped', `user:${USER}:settings`])
    expect(zipRows(await redis.json.get('agent:zds_stamped'))).toEqual({})
    expect(await redis.exists(ZIP_DEFAULTS_SWEEP_KEY)).toBeTruthy()
  })

  it('a restore without the marker sweeps again on the next start (the marker belongs to the backup)', async () => {
    await sweepOldZipDefaults()
    await redis.del(ZIP_DEFAULTS_SWEEP_KEY)
    await redis.json.set('agent:zds_stamped', '$.buffer_size_write_file', 2)
    const again = await sweepOldZipDefaults()
    expect(again.status).toBe('swept')
    expect(mine(again)).toMatchObject({ records: 1, rows: 1 })
    expect((await redis.json.get('agent:zds_stamped') as any).buffer_size_write_file).toBeUndefined()
  })
})
