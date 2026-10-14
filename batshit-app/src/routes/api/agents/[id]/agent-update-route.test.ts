// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { buildAgentMemoryRecordFields, resolveAgentMemorySettingsDraft } from '$lib/utils/memoryControl'

/**
 * `PUT /api/agents/[id]` and `GET /api/agents/[id]` on the default lane's Redis fake (the twin of
 * `redis.updateAgent`'s by-path script, BL-768).
 */

vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles: vi.fn(async () => {}),
  deleteAgentCodexConfig: vi.fn(async () => {}),
  buildAgentProfileId: (id: string) => `batshit_agent_${id}`
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

useRedisTestServer()

const USER = 'user-agent-update-route'
const AGENT = 'ssmod_route_agent'

const WORK_MODE = {
  bashAccessMode: 'plan',
  bashNeverAllowList: ['rm -rf *'],
  executionBackend: 'apple_container',
  webSearchProvider: 'exa'
}

const { GET, PUT } = await import('./+server')

async function put(body: Record<string, unknown>) {
  const response = await PUT({
    params: { id: AGENT },
    request: new Request(`http://localhost/api/agents/${AGENT}`, { method: 'PUT', body: JSON.stringify(body) }),
    locals: { user: { id: USER } }
  } as any)
  return { status: response.status, body: await response.json() }
}

async function stored() {
  return (await redis.json.get(`agent:${AGENT}`)) as any
}

beforeEach(async () => {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Route probe',
    agentType: 'api',
    primary_model_preset_id: 'preset-a',
    primary_model_temperature: 1.2,
    provider_specific_settings: { temperature: 1.2, customKnob: 5, nativeTools: WORK_MODE }
  } as any)
})

describe('PUT /api/agents/[id] provider settings (BL-768)', () => {
  it('a block the body sends replaces the stored block: a key it leaves out is removed', async () => {
    const { status } = await put({ provider_specific_settings: { temperature: 0.3, nativeTools: WORK_MODE } })
    expect(status).toBe(200)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 0.3, nativeTools: WORK_MODE })
  })

  it('a save that sends no block leaves the stored block alone', async () => {
    await put({ displayName: 'Renamed' })
    const record = await stored()
    expect(record.displayName).toBe('Renamed')
    expect(record.provider_specific_settings).toEqual({ temperature: 1.2, customKnob: 5, nativeTools: WORK_MODE })
  })
})

describe('PUT /api/agents/[id] keeps the agent\'s own settings (BL-514)', () => {
  it('the old chat-bar pick (the preset\'s settings as the whole block) keeps the Work mode and never-allow list', async () => {
    const { status } = await put({
      primary_model_preset_id: 'preset-b',
      provider_specific_settings: { temperature: 0.7 }
    })
    expect(status).toBe(200)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 0.7, nativeTools: WORK_MODE })
  })

  it('a block sent as null (Agent Settings clearing the model) keeps the agent keys', async () => {
    await put({ primary_model_preset_id: null, provider_specific_settings: null })
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: WORK_MODE })
  })

  it('a Work-mode change still saves, and a body that names nativeTools as null removes it', async () => {
    const agentMode = { ...WORK_MODE, bashAccessMode: 'agent' }
    await put({ provider_specific_settings: { temperature: 1.2, customKnob: 5, nativeTools: agentMode } })
    expect((await stored()).provider_specific_settings.nativeTools).toEqual(agentMode)

    await put({ provider_specific_settings: { temperature: 1.2, customKnob: 5, nativeTools: null } })
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 1.2, customKnob: 5 })
  })
})

describe('PUT /api/agents/[id] refuses a save it cannot write whole, with a 400 (review items 2 and 6)', () => {
  const LONE_SURROGATE = String.fromCharCode(0xd800)

  async function expectRefused(body: Record<string, unknown>, message: RegExp) {
    const before = await stored()
    const { status, body: answer } = await put({ displayName: 'Half saved', ...body })
    expect(status).toBe(400)
    expect(answer.error).toMatch(message)
    expect(await stored()).toEqual(before)
  }

  it('a block that is not an object or null', async () => {
    await expectRefused({ provider_specific_settings: 'oops' }, /provider_specific_settings must be an object or null/)
    await expectRefused({ provider_specific_settings: [1, 2] }, /provider_specific_settings must be an object or null/)
  })

  it('a field name that is not an agent field name', async () => {
    await expectRefused({ 'bad.name': 1 }, /Not an agent field name/)
  })

  it('a Custom Parameter name with a broken character: the message says what to change', async () => {
    await expectRefused(
      { provider_specific_settings: { temperature: 0.3, [`knob${LONE_SURROGATE}`]: 1, nativeTools: WORK_MODE } },
      /broken character[\s\S]*Custom Parameter name/
    )
  })

  it('a Custom Parameter value nested deeper than 64 levels', async () => {
    let deep: unknown = 1
    for (let level = 0; level < 65; level += 1) deep = { a: deep }
    await expectRefused({ provider_specific_settings: { temperature: 0.3, deep, nativeTools: WORK_MODE } }, /64 levels/)
  })
})

describe('PUT /api/agents/[id] and the memory settings base (BL-1294)', () => {
  const memoryBase = async () => buildAgentMemoryRecordFields(resolveAgentMemorySettingsDraft(await stored()))

  it('a memory save with its base is written; the base itself is never stored', async () => {
    const base = await memoryBase()
    const { status } = await put({ ...base, memory_linger_turns: 5, expectedMemory: base })
    expect(status).toBe(200)
    const record = await stored()
    expect(record.memory_linger_turns).toBe(5)
    expect('expectedMemory' in record).toBe(false)
  })

  it('a memory save without its base (an older page) is refused visibly: 400 memory_base_required, nothing written', async () => {
    const before = await stored()
    for (const field of ['memory_lane_budgets', 'memoryLaneBudgets', 'memory_enabled', 'memoryWindow']) {
      const value = field.includes('Budgets') || field.includes('budgets') ? { on_my_mind: 1, triggers: 1, recalled: 1 } : true
      const { status, body } = await put({ [field]: value })
      expect(status).toBe(400)
      expect(body.code).toBe('memory_base_required')
      expect(body.error).toMatch(/Reload Batshit/)
    }
    const { status } = await put({ memory_enabled: true, expectedMemory: 'not an object' })
    expect(status).toBe(400)
    expect(await stored()).toEqual(before)
  })

  it('a memory save whose base the agent changed meanwhile: 409 memory_settings_changed, nothing written', async () => {
    const base = await memoryBase()
    await redis.json.set(`agent:${AGENT}`, '$.memory_linger_turns', 6 as never)
    const before = await stored()

    const { status, body } = await put({ ...base, memory_recall_linger_turns: 4, expectedMemory: base })

    expect(status).toBe(409)
    expect(body.code).toBe('memory_settings_changed')
    expect(await stored()).toEqual(before)
  })

  it('a save that names no memory setting needs no base, and a stray base is dropped, never stored', async () => {
    const { status } = await put({ displayName: 'No memory here', expectedMemory: { memory_enabled: false } })
    expect(status).toBe(200)
    const record = await stored()
    expect(record.displayName).toBe('No memory here')
    expect('expectedMemory' in record).toBe(false)
  })
})
