import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'

/**
 * BL-224: the Compact summarizer reads who said what the way the agent does.
 *
 * Drives the REAL `/api/messages/compact` POST with the default lane's Redis; only the model call
 * (`generateModelSummary`, which captures the prompt) and the token estimate are stubbed. In a chat
 * switched between agents the chat's agent is `<assistant>` and the other is named; in a group
 * chat the summary is spliced into every member's history, so every agent is named.
 */

const captured = vi.hoisted(() => ({ prompts: [] as string[] }))

vi.mock('$lib/server/services/summaryGeneration', () => ({
  generateModelSummary: vi.fn(async (params: { prompt: string }) => {
    captured.prompts.push(params.prompt)
    return { summary: 'Summary.', modelLabel: 'Stub', provider: 'stub', modelId: 'stub-model' }
  })
}))

vi.mock('$lib/server/services/contextTokenPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/contextTokenPreview')>()),
  estimateCurrentContextTokens: vi.fn(async () => ({ budget: { contextLimit: 128_000 }, tokens: 1_000 }))
}))

const { POST } = await import('./+server')

const USER = 'zbctx_user'
const SESSION = 'zbctx_session'
const KEYS = [`session:${SESSION}`, 'agent:zbctx_cody', 'agent:zbctx_bram', `user:${USER}:settings`]

function messages() {
  const at = (minute: number) => `2026-09-25T10:0${minute}:00.000Z`
  return [
    { id: 'u1', session_id: SESSION, role: 'user', content: 'Which color for the kitchen?', timestamp: at(1) },
    { id: 'a1', session_id: SESSION, role: 'assistant', agent_id: 'zbctx_cody', content: 'Sage green.', timestamp: at(2) },
    { id: 'a2', session_id: SESSION, role: 'assistant', agent_id: 'zbctx_bram', content: 'I promised to paint it navy.', timestamp: at(3) },
    { id: 'u2', session_id: SESSION, role: 'user', content: 'Thanks both.', timestamp: at(4) }
  ]
}

async function seed(groupChat: boolean) {
  await redis.json.set(`session:${SESSION}`, '$', {
    id: SESSION,
    user_id: USER,
    name: 'Kitchen',
    metadata: groupChat ? { group_chat: { group_id: 'zbctx_group' } } : {}
  } as never)
  await redis.set('agent:zbctx_cody', { id: 'zbctx_cody', user_id: USER, displayName: 'Cody', agentType: 'api' })
  await redis.set('agent:zbctx_bram', { id: 'zbctx_bram', user_id: USER, displayName: 'Bram', agentType: 'api' })
}

async function compact() {
  const request = new Request('http://localhost/api/messages/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, agentId: 'zbctx_cody', mode: 'manual', messages: messages() })
  })
  const response = await POST({ request, locals: { user: { id: USER } }, fetch: globalThis.fetch } as any)
  expect(response.status, await response.clone().text()).toBe(200)
  expect(captured.prompts).toHaveLength(1)
  return captured.prompts[0]
}

beforeEach(() => {
  captured.prompts = []
})

afterEach(async () => {
  for (const key of KEYS) await redis.del(key)
})

describe('Compact names the other agents (BL-224)', () => {
  it('keeps the chat agent as <assistant> and names the agent it was switched from', async () => {
    await seed(false)
    const prompt = await compact()

    expect(prompt).toContain('<assistant id="a1" time="2026-09-25T10:02:00.000Z">\nSage green.\n</assistant>')
    expect(prompt).toContain(
      '<agent name="Bram" id="a2" time="2026-09-25T10:03:00.000Z">\nI promised to paint it navy.\n</agent>'
    )
  })

  it('names every agent in a group chat, whose summary every member reads', async () => {
    await seed(true)
    const prompt = await compact()

    expect(prompt).toContain('<agent name="Cody" id="a1" time="2026-09-25T10:02:00.000Z">')
    expect(prompt).toContain('<agent name="Bram" id="a2" time="2026-09-25T10:03:00.000Z">')
    expect(prompt).not.toContain('<assistant')
  })
})
