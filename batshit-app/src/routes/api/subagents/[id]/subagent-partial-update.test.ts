import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-844, BL-914: the route contract the Subagent form's changed-fields save relies on
 * (`subagentSettingsSavePatch.ts`). The PUT writes each field the body names by path (BL-914,
 * `redis.updateSubagent`), so a body that names one field keeps every other stored field, so a
 * change made to the Subagent elsewhere survives a save that did not name it. A block is written
 * KEY BY KEY: `codex_settings`, `claude_settings`, `provider_specific_settings` and
 * `dcmDisplaySettings` keep the keys the body does not name, and a key (or a `dcmDisplaySettings`
 * map entry) sent as `null` is removed. `{}` names nothing, so a block the user emptied is sent as
 * `null` for each key it had (the whole block as `null` removes `provider_specific_settings`).
 * The overlapping-save and every-block tests are in `subagent-update-by-path.test.ts`.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis`; the default lane's RedisJSON
 * fake under plain `npm test`.
 */

vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'ss844_route_user'
const SUB = 'ss844_route_sub'

const RECORD = {
  id: SUB,
  user_id: USER,
  displayName: 'ss844 route sub',
  slug: SUB,
  subagentType: 'api',
  specialty: 'general',
  system_prompt: 'Answer only in haiku.',
  include_global_prompt: true,
  primary_model_provider: 'openai',
  primary_model_name: 'gpt-5.5',
  primary_model_preset_id: 'ss844_preset',
  primary_model_connection: { type: 'direct', service: 'openai' },
  timeout_seconds: 45,
  avatar: null,
  provider_specific_settings: { temperature: 0.7, nativeTools: { webSearchEnabled: false } },
  created_at: '2026-09-28T00:00:00.000Z',
  updated_at: '2026-09-28T00:00:00.000Z'
}

async function seed() {
  await redis.json.set(`subagent:${SUB}`, '$', RECORD as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
}

async function callPut(updates: Record<string, unknown>) {
  const { PUT } = await import('./+server')
  const request = new Request(`http://localhost/api/subagents/${SUB}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  const response = (await PUT({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
  return { status: response.status, body: await response.json() }
}

async function stored() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

describe('a Subagent save that names only some fields (BL-844)', () => {
  it('keeps every field it does not name, whatever another window changed since', async () => {
    await seed()
    // Another window changes the timeout and the prompt after this copy was taken.
    await redis.json.set(`subagent:${SUB}`, '$', { ...RECORD, timeout_seconds: 90, system_prompt: 'Answer in limericks.' } as any)

    const { status } = await callPut({ displayName: 'ss844 renamed' })

    expect(status).toBe(200)
    const record = await stored()
    expect(record.displayName).toBe('ss844 renamed')
    expect(record.timeout_seconds).toBe(90)
    expect(record.system_prompt).toBe('Answer in limericks.')
    expect(record.primary_model_preset_id).toBe('ss844_preset')
    expect(record.primary_model_connection).toEqual({ type: 'direct', service: 'openai' })
    expect(record.include_global_prompt).toBe(true)
    expect(record.provider_specific_settings).toEqual(RECORD.provider_specific_settings)
  }, 30_000)

  it('writes provider_specific_settings key by key: a key the body does not name stays, a key named null is removed', async () => {
    await seed()

    await callPut({ provider_specific_settings: { nativeTools: { webSearchEnabled: true }, seed: 7, temperature: null } })

    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: { webSearchEnabled: true }, seed: 7 })
  }, 30_000)

  it('writes codex_settings and claude_settings key by key: every key the body does not name stays', async () => {
    await seed()
    await redis.json.set(`subagent:${SUB}`, '$', {
      ...RECORD,
      codex_settings: { model: 'gpt-5.5', reasoningEffort: 'high', addDirs: ['/one'] },
      claude_settings: { model: 'opus', permissionMode: 'plan' }
    } as any)

    await callPut({ codex_settings: { model: 'gpt-6-sol' }, claude_settings: { permissionMode: 'acceptEdits' } })

    // The Primary Agent route writes these blocks key by key (BL-848), and so does this one (BL-914).
    const record = await stored()
    expect(record.codex_settings).toEqual({ model: 'gpt-6-sol', reasoningEffort: 'high', addDirs: ['/one'] })
    expect(record.claude_settings).toEqual({ model: 'opus', permissionMode: 'acceptEdits' })
  }, 30_000)

  it('a block the user emptied is sent as null for each key it had; {} names nothing, and the block as null is removed', async () => {
    await seed()

    await callPut({ displayName: 'ss844 renamed' })
    expect((await stored()).provider_specific_settings).toEqual(RECORD.provider_specific_settings)

    await callPut({ provider_specific_settings: {} })
    expect((await stored()).provider_specific_settings).toEqual(RECORD.provider_specific_settings)

    await callPut({ provider_specific_settings: { temperature: null, nativeTools: null } })
    expect((await stored()).provider_specific_settings).toEqual({})

    await callPut({ provider_specific_settings: null })
    expect('provider_specific_settings' in (await stored())).toBe(false)
  }, 30_000)
})
