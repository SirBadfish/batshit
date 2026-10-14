import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-482: clearing a Subagent's Custom System Prompt clears it. Settings sends the emptied prompt
 * as `''` (it used to send `undefined`, which JSON drops, so the route's merge kept the old prompt
 * and every later Subagent call still carried it). The route stores an empty prompt as no prompt
 * at all: the field is gone from the saved record, so `subagentRunner` adds no custom prompt block.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis`; the default lane's RedisJSON fake
 * under plain `npm test` (the route only reads the record and writes it whole).
 */

vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'ssacc_sub_user'
const SUB = 'ssacc_sub_prompt'
const OLD_PROMPT = 'Answer only in haiku.'

async function seedSubagent() {
  await redis.json.set(`subagent:${SUB}`, '$', {
    id: SUB,
    user_id: USER,
    displayName: 'ssacc sub prompt',
    slug: SUB,
    subagentType: 'api',
    specialty: 'Writes haiku.',
    system_prompt: OLD_PROMPT,
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.4',
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  })
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
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, unknown> | null
}

describe('clearing a Subagent Custom System Prompt (BL-482)', () => {
  it('an empty prompt removes the stored prompt, and the rest of the record stays', async () => {
    await seedSubagent()

    const { status, body } = await callPut({ displayName: 'ssacc sub prompt', system_prompt: '' })

    expect(status).toBe(200)
    const record = await stored()
    expect(record).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(record, 'system_prompt')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(body.subagent, 'system_prompt')).toBe(false)
    expect(record?.specialty).toBe('Writes haiku.')
    expect(record?.primary_model_name).toBe('gpt-5.4')
  })

  it('spaces or null clear it too; a save without the field keeps it; a new prompt is stored', async () => {
    await seedSubagent()

    await callPut({ specialty: 'Writes short haiku.' })
    expect((await stored())?.system_prompt).toBe(OLD_PROMPT)

    await callPut({ system_prompt: '   ' })
    expect(Object.prototype.hasOwnProperty.call(await stored(), 'system_prompt')).toBe(false)

    await callPut({ system_prompt: 'Answer in limericks.' })
    expect((await stored())?.system_prompt).toBe('Answer in limericks.')

    await callPut({ system_prompt: null })
    expect(Object.prototype.hasOwnProperty.call(await stored(), 'system_prompt')).toBe(false)
  })
})
