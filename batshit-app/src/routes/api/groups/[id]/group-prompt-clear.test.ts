import { describe, expect, it, vi } from 'vitest'

// BL-482: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { PUT } from './+server'

/**
 * BL-482: clearing a Group System Prompt clears it. The panel sends the emptied prompt as `''`
 * (it used to send `undefined`, which JSON drops), and `redis.updateGroup` stores an empty prompt
 * as no prompt at all: the field is gone from the stored group, so the next group turn (which
 * reads the group fresh, `send-routed`) carries no custom prompt.
 *
 * Drives the real route and the real `updateGroup` on Redis 8. Real-Redis suite (G-0228): it runs
 * only under `npm run test:redis` and reports as skipped in the default lane, whose Redis fake has
 * no Group methods.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'ssacc_group_user'
const GROUP = 'ssacc_group_prompt'
const OLD_PROMPT = 'Always answer as the ssacc crew.'

async function seedGroup(extra: Record<string, unknown> = {}) {
  await redis.createGroup({
    id: GROUP,
    user_id: USER,
    name: 'Ssacc Crew',
    agent_ids: ['ssacc_a', 'ssacc_b'],
    group_system_prompt: OLD_PROMPT,
    ...extra
  } as any)
}

async function put(body: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/groups/${GROUP}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const response = (await (PUT as any)({ params: { id: GROUP }, request, locals: { user: { id: USER } } })) as Response
  return { status: response.status, body: await response.json() }
}

async function storedGroup() {
  return (await redis.json.get(`group:${GROUP}`)) as Record<string, unknown> | null
}

describe.runIf(REAL_REDIS_LANE)('clearing the Group System Prompt (BL-482)', () => {
  useRedisTestServer()

  it('an empty prompt removes the stored prompt, and the other settings stay', async () => {
    await seedGroup()
    expect((await storedGroup())?.group_system_prompt).toBe(OLD_PROMPT)

    const { status } = await put({ name: 'Ssacc Crew', group_system_prompt: '' })

    expect(status).toBe(200)
    const stored = await storedGroup()
    expect(stored).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(stored, 'group_system_prompt')).toBe(false)
    expect(stored?.agent_ids).toEqual(['ssacc_a', 'ssacc_b'])
    expect(stored?.name).toBe('Ssacc Crew')
    expect((await redis.getGroup(GROUP))?.group_system_prompt).toBeUndefined()
  })

  it('a prompt of only spaces or null clears it too; a save without the field keeps it', async () => {
    await seedGroup()
    await put({ max_followups_total: 3 })
    expect((await storedGroup())?.group_system_prompt).toBe(OLD_PROMPT)

    await put({ group_system_prompt: '   ' })
    expect(Object.prototype.hasOwnProperty.call(await storedGroup(), 'group_system_prompt')).toBe(false)

    await put({ group_system_prompt: 'New shared rule.' })
    expect((await storedGroup())?.group_system_prompt).toBe('New shared rule.')

    await put({ group_system_prompt: null })
    expect(Object.prototype.hasOwnProperty.call(await storedGroup(), 'group_system_prompt')).toBe(false)
  })
})
