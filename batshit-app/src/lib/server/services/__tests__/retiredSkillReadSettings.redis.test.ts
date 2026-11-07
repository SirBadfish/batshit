// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { redis } from '$lib/server/redis'
import { removeRetiredSkillReadSettings } from '../retiredSkillReadSettings'
import { getToolSettings } from '$lib/utils/toolRenderMap'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
useSkillSessionRedisTestServer()

describe.runIf(REAL_REDIS_LANE)('retired Skill Read saved-data removal (real RedisJSON DB15)', () => {
  it('removes only the retired row/fields from Primary, Subagent and global records; is idempotent', async () => {
    const rows = [{ tool_name: 'before', buffer_size: 7 }, { tool_name: 'skill_read', buffer_size: 123, unknown: 'retired row' },
      { tool_name: 'middle', unknown: { exact: 'kept' } }, { tool_name: 'skill_reference', zip_disabled: true }, { tool_name: 'after', auto_zip: false }]
    for (const key of ['agent:skill-migration', 'subagent:skill-migration']) {
      await redis.json.set(key, '$', { id: 'skill-migration', user_id: 'skill-user', keep: 'untouched',
        auto_zip_skill_read: false, buffer_size_skill_reference: 99, custom_tool_settings: rows } as any)
    }
    await redis.json.set('user:skill-user:settings', '$', { outside: 'untouched', global_zip_settings: {
      buffer_size_skill_read: 999, zip_disabled_skill_read: true, custom_tool_settings: rows, buffer_size_read_file: 5
    } } as any)
    const result = await removeRetiredSkillReadSettings()
    expect(result.records).toBe(3)
    for (const key of ['agent:skill-migration', 'subagent:skill-migration']) {
      expect(await redis.json.get(key)).toEqual({ id: 'skill-migration', user_id: 'skill-user', keep: 'untouched',
        custom_tool_settings: [rows[0], rows[2], rows[4]] })
    }
    expect(await redis.json.get('user:skill-user:settings')).toEqual({ outside: 'untouched', global_zip_settings: {
      custom_tool_settings: [rows[0], rows[2], rows[4]], buffer_size_read_file: 5
    } })
    expect(await removeRetiredSkillReadSettings()).toEqual({ records: 0, fields: 0 })
  })
})

describe('former Skill Read buffers never override lifecycle', () => {
  it('ignores explicit Off/large buffers and inherited universal settings', () => {
    expect(getToolSettings('skill_read', { buffer_size: 999, custom_tool_settings: [{ tool_name: 'skill_read', buffer_size: 999, zip_disabled: true }] }, {
      auto_zip_skill_read: false, buffer_size_skill_read: 999
    })).toEqual({ buffer_size: 0, zip_threshold: 0, auto_zip: true, zip_disabled: false })
  })
})
