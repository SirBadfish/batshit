// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-120 P3 — the group create/update routes refuse an unknown speaking preset loudly
 * (a typo must never be stored and silently read as another preset) and accept `smart`.
 */

const redisState = vi.hoisted(() => ({
  group: { id: 'g1', user_id: 'josh', name: 'G', agent_ids: ['a', 'b'] } as Record<string, any> | null,
  updateCalls: [] as Array<{ id: string; updates: Record<string, any> }>,
  createCalls: [] as Array<Record<string, any>>
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getGroup: vi.fn(async () => redisState.group),
    updateGroup: vi.fn(async (id: string, updates: Record<string, any>) => {
      redisState.updateCalls.push({ id, updates })
    }),
    exists: vi.fn(async () => false),
    createGroup: vi.fn(async (group: Record<string, any>) => {
      redisState.createCalls.push(group)
      return { ...group, created_at: 'now', updated_at: 'now' }
    })
  }
}))

import { PUT } from './[id]/+server'
import { POST } from './+server'

const locals = { user: { id: 'josh' } }

function jsonRequest(method: string, body: unknown) {
  return new Request('http://localhost/api/groups/g1', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

beforeEach(() => {
  redisState.group = { id: 'g1', user_id: 'josh', name: 'G', agent_ids: ['a', 'b'] }
  redisState.updateCalls = []
  redisState.createCalls = []
})

describe('PUT /api/groups/[id]', () => {
  it('refuses an unknown speak preset before touching the record', async () => {
    const response = await PUT({
      params: { id: 'g1' },
      request: jsonRequest('PUT', { agent_settings: { a: { speak_policy: 'smrt' } } }),
      locals
    } as any)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('speak_policy must be one of')
    expect(redisState.updateCalls).toEqual([])
  })

  it('accepts the smart preset and stores it as sent', async () => {
    const response = await PUT({
      params: { id: 'g1' },
      request: jsonRequest('PUT', { agent_settings: { a: { speak_policy: 'smart' }, b: { speak_policy: 'quiet' } } }),
      locals
    } as any)
    expect(response.status).toBe(200)
    expect(redisState.updateCalls).toHaveLength(1)
    expect(redisState.updateCalls[0].updates.agent_settings).toEqual({ a: { speak_policy: 'smart' }, b: { speak_policy: 'quiet' } })
  })
})

describe('POST /api/groups', () => {
  it('refuses an unknown speak preset and creates nothing', async () => {
    const response = await POST({
      request: jsonRequest('POST', { name: 'New', agent_ids: ['a', 'b'], agent_settings: { a: { speak_policy: 'clever' } } }),
      locals
    } as any)
    expect(response.status).toBe(400)
    expect(redisState.createCalls).toEqual([])
  })

  it('creates a group whose agent carries the smart preset', async () => {
    const response = await POST({
      request: jsonRequest('POST', { name: 'New', agent_ids: ['a', 'b'], agent_settings: { a: { speak_policy: 'smart' } } }),
      locals
    } as any)
    expect(response.status).toBe(200)
    expect(redisState.createCalls).toHaveLength(1)
    expect(redisState.createCalls[0].agent_settings).toEqual({ a: { speak_policy: 'smart' } })
  })
})
