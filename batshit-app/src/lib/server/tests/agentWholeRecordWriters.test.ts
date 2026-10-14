import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-770: the writers of an agent record that sat outside `updateAgent` write only what they change,
 * by path (`updateAgent`'s script, BL-768). Each used to read the agent and write the whole record
 * back, so a save that landed between the read and the write (Agent Settings, the chat-bar model
 * picker, `memoryRecall.ts`'s by-path stamp) was taken back with no word:
 * - `POST /api/agents/[id]/subagents` (the Subagent assignment),
 * - the one-time dynamic-only MCP reset in `mcpSelectionResolver.ts`,
 * - the legacy type clean-up of `GET /api/agents/[id]` and of `redis.getAgents`,
 * - `GET /api/agents/[id]/fix`, which now writes only a record that really is double-encoded.
 * And the agent PUT itself, saved from two copies read at different times (Agent Settings and the
 * chat bar): each save keeps the other's change (BL-841, BL-833, BL-848, BL-855, at the end).
 *
 * The gap tests need the real client and run on the real lane only (`npm run test:redis`).
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

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zawr_user'
const AGENT = 'zawr_agent'
const KEY = `agent:${AGENT}`
const SUBAGENT = 'zawr_sub'
const OLD_STAMP = '2026-09-27T09:00:00.000Z'
const WORK_MODE = { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *', 'git push --force'] }

async function seed(record: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', {
    id: AGENT,
    user_id: USER,
    displayName: 'Probe',
    agentType: 'api',
    created_at: OLD_STAMP,
    updated_at: OLD_STAMP,
    provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } },
    ...record
  } as never)
  await redis.sAdd(`user:${USER}:agents`, AGENT)
}

async function stored() {
  return (await redis.json.get(KEY)) as any
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of [KEY, `agent:${AGENT}:subagents`, `subagent:${SUBAGENT}`, `user:${USER}:agents`, `batshit:mcp_dynamic_only_reset:v1:${USER}`]) {
    await redis.del(key)
  }
})

/** The same probe as `agentUpdateByPath.test.ts`: another writer lands right after the first read. */
function interleaveAnotherWriter() {
  const execute = redis.execute.bind(redis)
  let wroteBetween = false
  const wholeRecordWrites: unknown[] = []
  vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    execute(async (client: any) => {
      const writeBetween = async () => {
        if (wroteBetween) return
        wroteBetween = true
        await client.json.set(KEY, '$.memory_last_interaction_at', '2026-09-28T12:00:00.000Z')
        await client.json.set(KEY, '$.provider_specific_settings.nativeTools', WORK_MODE)
      }
      const target = client.json
      const json = new Proxy({}, {
        get(_empty, property) {
          const value = Reflect.get(target, property)
          if (property === 'get') {
            return async (key: string, options?: unknown) => {
              const answer = await value.call(target, key, options)
              if (key === KEY) await writeBetween()
              return answer
            }
          }
          if (property === 'set') {
            return async (key: string, path: string, ...rest: unknown[]) => {
              if (key === KEY && path === '$') wholeRecordWrites.push(rest[0])
              return value.call(target, key, path, ...rest)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const wrapped = new Proxy({}, {
        get(_empty, property) {
          if (property === 'json') return json
          if (property === 'eval') {
            return async (script: string, options: { keys?: string[] }) => {
              if (options?.keys?.[0] === KEY) await writeBetween()
              return client.eval(script, options)
            }
          }
          const value = Reflect.get(client, property)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(wrapped)
    })) as any)
  return { wholeRecordWrites, wroteBetween: () => wroteBetween }
}

function expectOtherWriterKept(record: any) {
  expect(record.memory_last_interaction_at).toBe('2026-09-28T12:00:00.000Z')
  expect(record.provider_specific_settings.nativeTools).toEqual(WORK_MODE)
}

describe('GET /api/agents/[id]/fix writes only a double-encoded record (BL-770)', () => {
  it('leaves a record that is already an object alone', async () => {
    await seed()
    const { GET } = await import('../../../routes/api/agents/[id]/fix/+server')
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(200)
    expect((await response.json()).message).toBe('Agent data is already stored correctly')
    expect((await stored()).updated_at).toBe(OLD_STAMP)
  })

  it('still repairs a double-encoded record', async () => {
    const record = { id: AGENT, user_id: USER, displayName: 'Probe', agentType: 'api' }
    await redis.set(KEY, JSON.stringify(JSON.stringify(record)))
    const { GET } = await import('../../../routes/api/agents/[id]/fix/+server')
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(200)
    expect((await response.json()).message).toBe('Agent data fixed')
    expect(await stored()).toEqual(record)
  })
})

describe('GET /api/agents/[id]/fix replaces a string record only while it is the string it read (BL-770)', () => {
  it('a record that changed after the read is left as it is now, and the route says so', async () => {
    const now = { id: AGENT, user_id: USER, displayName: 'Changed meanwhile', agentType: 'api' }
    await redis.set(KEY, JSON.stringify(JSON.stringify(now)))
    const stale = JSON.stringify(JSON.stringify({ ...now, displayName: 'Read first' }))
    vi.spyOn(redis, 'readAgentRecordStorage').mockResolvedValueOnce({ type: 'string', raw: stale })
    const { GET } = await import('../../../routes/api/agents/[id]/fix/+server')
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(409)
    // The raw stored text, the same on both lanes (the facade's `get` decodes a string once on real Redis).
    expect(await redis.readAgentRecordStorage(AGENT)).toEqual({ type: 'string', raw: JSON.stringify(JSON.stringify(now)) })
  })
})

describe.skipIf(!REAL)('a change written while another agent writer runs survives (BL-770, real Redis)', () => {
  it('the Subagent assignment writes the two assignment fields and nothing else', async () => {
    await seed()
    await redis.json.set(`subagent:${SUBAGENT}`, '$', { id: SUBAGENT, user_id: USER, displayName: 'Sub', subagentType: 'api' } as never)
    const probe = interleaveAnotherWriter()
    const { POST } = await import('../../../routes/api/agents/[id]/subagents/+server')

    const response = await POST({
      params: { id: AGENT },
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ subagentIds: [SUBAGENT] }) }),
      locals: { user: { id: USER } }
    } as any)

    expect(response.status).toBe(200)
    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
    expect(record.assigned_subagent_ids).toEqual([SUBAGENT])
    expect(record.assignedSubagents).toEqual([SUBAGENT])
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expectOtherWriterKept(record)
  })

  it('the one-time dynamic-only MCP reset clears the two legacy lists and nothing else', async () => {
    await seed({ defaultMCPToolSelections: ['gw.tool'], default_mcp_tool_selections: ['gw.tool'] })
    const probe = interleaveAnotherWriter()
    const { __testUtils } = await import('$lib/server/services/mcpSelectionResolver')

    await __testUtils.runDynamicOnlySelectionReset(USER)

    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
    expect(record.defaultMCPToolSelections).toEqual([])
    expect(record.default_mcp_tool_selections).toEqual([])
    expectOtherWriterKept(record)
  })

  it('the legacy type clean-up of GET /api/agents/[id] writes agentType and removes the legacy fields only', async () => {
    await seed({ agentType: undefined, batshitMode: 'cli', mode: 'vercel-native' })
    const probe = interleaveAnotherWriter()
    const { GET } = await import('../../../routes/api/agents/[id]/+server')

    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)

    expect(response.status).toBe(200)
    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
    expect('mode' in record).toBe(false)
    expectOtherWriterKept(record)
  })

  it("redis.getAgents' legacy type clean-up persists by path without changing current fields (BL-1339)", async () => {
    await seed({ agentType: undefined, batshitMode: 'direct', memory_enabled: false })
    const probe = interleaveAnotherWriter()

    const agents = await redis.getAgents(USER)

    expect(agents.find((agent) => agent.id === AGENT)?.agentType).toBe('api')
    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
    expect(record.agentType).toBe('api')
    expect('batshitMode' in record).toBe(false)
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expect(record).toMatchObject({
      id: AGENT,
      user_id: USER,
      displayName: 'Probe',
      created_at: OLD_STAMP,
      memory_enabled: false
    })
    expectOtherWriterKept(record)
  })
})

/**
 * Review item 1 (wave 2): a writer that worked the type out from its own earlier read wrote that
 * old type back over an API to CLI change made after the read. `redis.updateAgent` now writes
 * `agentType` only when a caller passes it or the stored type is legacy or not canonical, and
 * decides that inside its script. These probes change the type after the route's read and before
 * its save (by wrapping `updateAgent`, so they hold on both lanes).
 */
let restoreUpdateAgent: (() => void) | undefined
afterEach(() => {
  restoreUpdateAgent?.()
  restoreUpdateAgent = undefined
})

// Swapped by assignment, not `vi.spyOn`: on the default lane `updateAgent` is already the fake's
// `vi.fn`, and a spy on it replaces that same function's implementation.
function changeTypeBeforeTheSave(storedChange: Record<string, unknown>) {
  const target = redis as any
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'updateAgent')
  const original = target.updateAgent
  const passed: Array<Record<string, unknown>> = []
  target.updateAgent = async (id: string, updates: any) => {
    passed.push({ ...updates })
    for (const [field, value] of Object.entries(storedChange)) {
      await redis.json.set(KEY, `$.${field}`, value as never)
    }
    return original.call(target, id, updates)
  }
  restoreUpdateAgent = () => {
    if (hadOwn) target.updateAgent = original
    else delete target.updateAgent
  }
  return { passed }
}

describe('a type change made after a route read the agent survives its save (review item 1)', () => {
  it('PUT /api/agents/[id] without agentType keeps an API to CLI change made meanwhile', async () => {
    await seed()
    const probe = changeTypeBeforeTheSave({ agentType: 'cli' })
    const { PUT } = await import('../../../routes/api/agents/[id]/+server')

    const response = await PUT({
      params: { id: AGENT },
      request: new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ displayName: 'Renamed' }) }),
      locals: { user: { id: USER } }
    } as any)

    expect(response.status).toBe(200)
    expect(probe.passed).toHaveLength(1)
    expect('agentType' in probe.passed[0]).toBe(false)
    const record = await stored()
    expect(record.displayName).toBe('Renamed')
    expect(record.agentType).toBe('cli')
  })

  it('PUT /api/agents/[id] with agentType still changes the type', async () => {
    await seed()
    const { PUT } = await import('../../../routes/api/agents/[id]/+server')

    const response = await PUT({
      params: { id: AGENT },
      request: new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ agentType: 'CLI' }) }),
      locals: { user: { id: USER } }
    } as any)

    expect(response.status).toBe(200)
    expect((await stored()).agentType).toBe('cli')
  })

  it('the legacy type clean-up of GET /api/agents/[id] keeps a canonical type written meanwhile', async () => {
    await seed({ agentType: undefined, batshitMode: 'direct', mode: 'vercel-native' })
    changeTypeBeforeTheSave({ agentType: 'cli' })
    const { GET } = await import('../../../routes/api/agents/[id]/+server')

    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)

    expect(response.status).toBe(200)
    const record = await stored()
    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
    expect('mode' in record).toBe(false)
  })
})

describe.skipIf(!REAL)('a type that keeps changing during a PUT is a 409, not a 500 (re-review, real Redis)', () => {
  it('three changed tries: 409 with the plain sentence, and nothing is written', async () => {
    await seed({ agentType: undefined, batshitMode: 'direct' })
    const execute = redis.execute.bind(redis)
    let flip = false
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'eval') {
              return async (script: string, options: { keys?: string[] }) => {
                if (options?.keys?.[0] === KEY) {
                  flip = !flip
                  await client.json.set(KEY, '$.batshitMode', flip ? 'cli' : 'direct')
                }
                return client.eval(script, options)
              }
            }
            const value = Reflect.get(client, property)
            return typeof value === 'function' ? value.bind(client) : value
          }
        })
        return operation(wrapped)
      })) as any)
    const { PUT } = await import('../../../routes/api/agents/[id]/+server')

    const response = await PUT({
      params: { id: AGENT },
      request: new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ displayName: 'Never saved' }) }),
      locals: { user: { id: USER } }
    } as any)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/kept changing while it was being saved[\s\S]*nothing was saved\. Try again\./)
    const record = await stored()
    expect(record.displayName).toBe('Probe')
    expect(record.updated_at).toBe(OLD_STAMP)
  })
})

describe.skipIf(!REAL)("redis.getAgents' legacy clean-up keeps a type written after its read (review item 1, real Redis)", () => {
  it('writes no type from its own read', async () => {
    await seed({ agentType: undefined, batshitMode: 'direct' })
    const execute = redis.execute.bind(redis)
    let changed = false
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const target = client.json
        const json = new Proxy({}, {
          get(_empty, property) {
            const value = Reflect.get(target, property)
            if (property === 'get') {
              return async (key: string, options?: unknown) => {
                const answer = await value.call(target, key, options)
                if (key === KEY && !changed) {
                  changed = true
                  await target.set(KEY, '$.agentType', 'cli')
                }
                return answer
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'json') return json
            const value = Reflect.get(client, property)
            return typeof value === 'function' ? value.bind(client) : value
          }
        })
        return operation(wrapped)
      })) as any)

    await redis.getAgents(USER)

    const record = await stored()
    expect(changed).toBe(true)
    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
  })
})

/** Runs `other` (a whole save) right before the first script on the agent, then lets that script run. */
function runBeforeFirstScript(other: () => Promise<unknown>) {
  const execute = redis.execute.bind(redis)
  let state: 'waiting' | 'running' | 'done' = 'waiting'
  vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    execute(async (client: any) => {
      const wrapped = new Proxy({}, {
        get(_empty, property) {
          if (property === 'eval') {
            return async (script: string, options: { keys?: string[] }) => {
              if (options?.keys?.[0] === KEY && state === 'waiting') {
                state = 'running'
                await other()
                state = 'done'
              }
              return client.eval(script, options)
            }
          }
          const value = Reflect.get(client, property)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(wrapped)
    })) as any)
  return { ran: () => state === 'done' }
}

/**
 * BL-841 and BL-833: two places save the same agent from copies of it read at different times,
 * Agent Settings (a copy from when it opened) and the chat bar (the agents store's copy). Each
 * save must carry only what its control changed, and the PUT route must write only that:
 * - Agent Settings sends `nativeTools` field by field (`buildAgentSettingsSavePatch`), and the
 *   server writes it by path inside the save's one script, so a never-allow list edit never takes
 *   back a Work mode chosen in the chat bar of another window (BL-841);
 * - a block that names only the agent's own keys leaves the stored model keys alone, so the chat
 *   bar's mode, Work mode and reasoning controls send only their own key, and a Settings save of
 *   a native-tool field no longer sends its older model keys (BL-833).
 * The chat-bar bodies below are what `ChatInput.svelte` sends (`chatBarWorkModeSave`, unit-tested
 * in `agentProviderSettings.test.ts`); the Settings bodies come from the real patch builder.
 */
describe('two copies of one agent saved from two places keep both changes (BL-841, BL-833)', () => {
  const MODEL_FIELDS_A = {
    primary_model_preset_id: 'zawr_preset_a',
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-probe-a',
    primary_model_temperature: 1.2,
    primary_model_max_tokens: 4000
  }
  const MODEL_FIELDS_B = {
    primary_model_preset_id: 'zawr_preset_b',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-probe-b',
    primary_model_temperature: 0.2,
    primary_model_max_tokens: null
  }
  const NEVER_ALLOW = ['rm -rf *']
  const NEVER_ALLOW_EDITED = ['rm -rf *', 'git push --force']
  const CHAT_BAR_PLAN = { provider_specific_settings: { nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container' } } }

  async function seedPresetA() {
    await seed({
      ...MODEL_FIELDS_A,
      provider_specific_settings: {
        temperature: 1.2,
        maxTokens: 4000,
        nativeTools: { bashAccessMode: 'agent', bashNeverAllowList: NEVER_ALLOW }
      }
    })
  }

  /** The part of Agent Settings' basic payload these saves touch, built from a copy of the record. */
  function settingsPayload(record: Record<string, any>): Record<string, unknown> {
    return {
      displayName: record.displayName,
      ...Object.fromEntries(Object.keys(MODEL_FIELDS_A).map((field) => [field, record[field] ?? null])),
      provider_specific_settings: structuredClone(record.provider_specific_settings)
    }
  }

  function withNeverAllow(payload: Record<string, any>, list: string[]) {
    const block = payload.provider_specific_settings
    return { ...payload, provider_specific_settings: { ...block, nativeTools: { ...block.nativeTools, bashNeverAllowList: list } } }
  }

  /** Agent Settings' form after picking preset B: its model fields and keys, the own keys kept. */
  function withPresetB(payload: Record<string, any>) {
    const { temperature: _t, maxTokens: _m, ...ownKeys } = payload.provider_specific_settings
    return { ...payload, ...MODEL_FIELDS_B, provider_specific_settings: { ...ownKeys, temperature: 0.2 } }
  }

  async function put(body: Record<string, unknown>) {
    const { PUT } = await import('../../../routes/api/agents/[id]/+server')
    const response = await PUT({
      params: { id: AGENT },
      request: new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }),
      locals: { user: { id: USER } }
    } as any)
    expect(response.status).toBe(200)
  }

  async function settingsSave(baseline: Record<string, unknown>, next: Record<string, unknown>) {
    const { buildAgentSettingsSavePatch } = await import('$lib/utils/agentSettingsSavePatch')
    const patch = buildAgentSettingsSavePatch(baseline, next)
    await put(patch)
    return patch
  }

  it('a block that names only own keys leaves the stored model keys alone (BL-833)', async () => {
    await seedPresetA()
    await put({ provider_specific_settings: { codex_permission_mode: 'agent' } })
    expect((await stored()).provider_specific_settings).toEqual({
      temperature: 1.2,
      maxTokens: 4000,
      nativeTools: { bashAccessMode: 'agent', bashNeverAllowList: NEVER_ALLOW },
      codex_permission_mode: 'agent'
    })
  })

  it('a pick of a preset with no settings still clears the old model keys (an empty block)', async () => {
    await seedPresetA()
    await put({ ...MODEL_FIELDS_B, provider_specific_settings: {} })
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: { bashAccessMode: 'agent', bashNeverAllowList: NEVER_ALLOW } })
  })

  it("with Settings' copy stale, a Work-mode change from the chat bar survives a never-allow edit from Settings (BL-841)", async () => {
    await seedPresetA()
    const settingsCopy = settingsPayload(await stored())

    await put(CHAT_BAR_PLAN)
    const patch = await settingsSave(settingsCopy, withNeverAllow(settingsCopy, NEVER_ALLOW_EDITED))

    expect(patch).toEqual({ provider_specific_settings: { nativeTools: { bashNeverAllowList: NEVER_ALLOW_EDITED } } })
    const record = await stored()
    expect(record.provider_specific_settings).toEqual({
      temperature: 1.2,
      maxTokens: 4000,
      nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container', bashNeverAllowList: NEVER_ALLOW_EDITED }
    })
  })

  it("with Settings' copy stale, a model picked in the chat bar survives a never-allow edit from Settings (BL-833)", async () => {
    await seedPresetA()
    const settingsCopy = settingsPayload(await stored())

    // The chat-bar picker's save (ModelSelector): the preset's model fields and keys.
    await put({ ...MODEL_FIELDS_B, provider_specific_settings: { temperature: 0.2 } })
    await settingsSave(settingsCopy, withNeverAllow(settingsCopy, NEVER_ALLOW_EDITED))

    const record = await stored()
    expect(record.primary_model_preset_id).toBe('zawr_preset_b')
    expect(record.provider_specific_settings).toEqual({
      temperature: 0.2,
      nativeTools: { bashAccessMode: 'agent', bashNeverAllowList: NEVER_ALLOW_EDITED }
    })
  })

  const EXPECTED_BOTH = {
    temperature: 0.2,
    nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container', bashNeverAllowList: NEVER_ALLOW }
  }

  /**
   * Review fix: the command location travels with the Work mode. Another window switches the agent
   * to Full access (the record then holds `executionBackend: 'local'`); a window whose copy still
   * shows Agent in the sandbox then picks Plan. Sending the mode alone stored Plan with `local`:
   * commands ran on the Mac outside the sandbox while that window showed the sandbox.
   */
  async function seedAgentInSandbox() {
    await seedPresetA()
    await redis.json.set(KEY, '$.provider_specific_settings.nativeTools.executionBackend', 'apple_container' as never)
  }

  async function chatBarPick(copy: Record<string, any>, mode: string) {
    const { chatBarWorkModeSave } = await import('$lib/utils/agentProviderSettings')
    await put({ provider_specific_settings: chatBarWorkModeSave(copy.provider_specific_settings, mode) })
  }

  /** Agent Settings' Permissions Mode pick on its form (`AgentSettingsPanel.svelte`'s handler). */
  function withSettingsWorkMode(payload: Record<string, any>, mode: string) {
    const block = payload.provider_specific_settings
    const nativeTools: Record<string, unknown> = {
      ...block.nativeTools,
      bashAccessMode: mode,
      executionBackend: mode === 'dangerous' ? 'local' : 'apple_container'
    }
    delete nativeTools.bashPolicyMode
    if (mode !== 'agent') nativeTools.bashAgentApprovalCardsEnabled = false
    return { ...payload, provider_specific_settings: { ...block, nativeTools } }
  }

  it("another window's Full access, then a chat-bar Plan pick from a stale copy: the location is a sandbox (review fix)", async () => {
    await seedAgentInSandbox()
    const staleCopy = structuredClone(await stored())
    await chatBarPick(structuredClone(await stored()), 'dangerous')
    expect((await stored()).provider_specific_settings.nativeTools.executionBackend).toBe('local')

    await chatBarPick(staleCopy, 'plan')

    const nativeTools = (await stored()).provider_specific_settings.nativeTools
    expect(nativeTools.bashAccessMode).toBe('plan')
    expect(nativeTools.executionBackend).toBe('apple_container')
  })

  it("another window's Full access, then a Settings Plan pick from a stale copy: the location is a sandbox (review fix)", async () => {
    await seedAgentInSandbox()
    const settingsCopy = settingsPayload(await stored())
    await chatBarPick(structuredClone(await stored()), 'dangerous')

    await settingsSave(settingsCopy, withSettingsWorkMode(settingsCopy, 'plan'))

    const nativeTools = (await stored()).provider_specific_settings.nativeTools
    expect(nativeTools.bashAccessMode).toBe('plan')
    expect(nativeTools.executionBackend).toBe('apple_container')
    expect(nativeTools.bashNeverAllowList).toEqual(NEVER_ALLOW)
  })

  it.skipIf(!REAL)('Full access written inside a Settings Plan pick from a stale copy: the location is a sandbox (review fix, real Redis)', async () => {
    await seedAgentInSandbox()
    const settingsCopy = settingsPayload(await stored())
    const chatBarCopy = structuredClone(await stored())
    const probe = runBeforeFirstScript(() => chatBarPick(chatBarCopy, 'dangerous'))

    await settingsSave(settingsCopy, withSettingsWorkMode(settingsCopy, 'plan'))

    expect(probe.ran()).toBe(true)
    const nativeTools = (await stored()).provider_specific_settings.nativeTools
    expect(nativeTools.bashAccessMode).toBe('plan')
    expect(nativeTools.executionBackend).toBe('apple_container')
  })

  it.skipIf(!REAL)('Full access written inside a chat-bar Plan pick from a stale copy: the location is a sandbox (review fix, real Redis)', async () => {
    await seedAgentInSandbox()
    const staleCopy = structuredClone(await stored())
    const probe = runBeforeFirstScript(() => chatBarPick(structuredClone(staleCopy), 'dangerous'))

    await chatBarPick(staleCopy, 'plan')

    expect(probe.ran()).toBe(true)
    const nativeTools = (await stored()).provider_specific_settings.nativeTools
    expect(nativeTools.bashAccessMode).toBe('plan')
    expect(nativeTools.executionBackend).toBe('apple_container')
  })

  it.skipIf(!REAL)('a chat-bar Work-mode change inside a Settings model pick: both survive (BL-833, real Redis)', async () => {
    await seedPresetA()
    const settingsCopy = settingsPayload(await stored())
    const probe = runBeforeFirstScript(() => put(CHAT_BAR_PLAN))

    await settingsSave(settingsCopy, withPresetB(settingsCopy))

    expect(probe.ran()).toBe(true)
    const record = await stored()
    expect(record.primary_model_preset_id).toBe('zawr_preset_b')
    expect(record.provider_specific_settings).toEqual(EXPECTED_BOTH)
  })

  it.skipIf(!REAL)('a Settings model pick inside a chat-bar Work-mode change: both survive (BL-833, real Redis)', async () => {
    await seedPresetA()
    const settingsCopy = settingsPayload(await stored())
    const probe = runBeforeFirstScript(() => settingsSave(settingsCopy, withPresetB(settingsCopy)))

    await put(CHAT_BAR_PLAN)

    expect(probe.ran()).toBe(true)
    const record = await stored()
    expect(record.primary_model_preset_id).toBe('zawr_preset_b')
    expect(record.provider_specific_settings).toEqual(EXPECTED_BOTH)
  })
})

/**
 * BL-848 and BL-855: `codex_settings`, `claude_settings` and `dcmDisplaySettings` are written field
 * by field, so the chat bar's Codex and Claude controls, the model selectors, the MCP menu and Agent
 * Settings, each holding a copy of the agent from a different time, keep each other's choices as
 * long as each save names only the keys it changed (`diffAgentBlock`, `agentBlockFieldSettings.ts`).
 */
describe('two copies of one agent saved from two places keep both provider and Tool Grid choices (BL-848, BL-855)', () => {
  const CODEX = { model: 'gpt-5', permissionMode: 'chat', sandbox: 'workspace-write', reasoningEffort: 'medium', addDirs: ['/a'], configOverrides: [] }
  const CLAUDE = { model: 'sonnet', permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: [], configOverrides: [] }
  const DCM = { version: 1, groups: { gw_a: 'group-only' }, tools: { 'gw_a::read': 'name-only' }, groupDisplayPreferences: {}, toolDisplayPreferences: {} }

  async function seedBlocks() {
    await seed({ codex_settings: CODEX, claude_settings: CLAUDE, dcmDisplaySettings: DCM, defaultMCPGateways: ['gw_a'], defaultTools: ['read_file'] })
  }

  async function putRaw(body: Record<string, unknown>) {
    const { PUT } = await import('../../../routes/api/agents/[id]/+server')
    return PUT({
      params: { id: AGENT },
      request: new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }),
      locals: { user: { id: USER } }
    } as any)
  }

  async function put(body: Record<string, unknown>) {
    const response = await putRaw(body)
    expect(response.status).toBe(200)
  }

  // What the Codex model selector and Agent Settings send once each names only what it changed.
  const CHAT_BAR_MODEL = { codex_settings: { model: 'gpt-6', reasoningEffort: 'high' } }
  const SETTINGS_SANDBOX = { codex_settings: { sandbox: 'read-only' } }
  const EXPECTED_CODEX = { ...CODEX, model: 'gpt-6', reasoningEffort: 'high', sandbox: 'read-only' }

  it("a chat-bar Codex model pick and Agent Settings' sandbox change each keep the other, in both orders (BL-848)", async () => {
    for (const [first, second] of [[CHAT_BAR_MODEL, SETTINGS_SANDBOX], [SETTINGS_SANDBOX, CHAT_BAR_MODEL]]) {
      await seedBlocks()
      await put(first)
      await put(second)
      expect((await stored()).codex_settings).toEqual(EXPECTED_CODEX)
    }
  })

  it("a chat-bar Claude mode change and Agent Settings' Claude model change each keep the other (BL-848)", async () => {
    await seedBlocks()
    await put({ claude_settings: { permissionMode: 'plan' } })
    await put({ claude_settings: { model: 'opus' } })
    expect((await stored()).claude_settings).toEqual({ ...CLAUDE, permissionMode: 'plan', model: 'opus' })
  })

  it("the chat bar's MCP menu and Agent Settings each save only the Tool Grid fields they changed (BL-855)", async () => {
    await seedBlocks()
    // The MCP menu adds a gateway group and its list entry; Agent Settings, from an older copy, hides a tool.
    await put({ dcmDisplaySettings: { groups: { gw_b: 'hidden' } }, defaultMCPGateways: ['gw_a', 'gw_b'] })
    await put({ dcmDisplaySettings: { tools: { 'gw_a::read': 'hidden' } } })

    const record = await stored()
    expect(record.dcmDisplaySettings).toEqual({ ...DCM, groups: { gw_a: 'group-only', gw_b: 'hidden' }, tools: { 'gw_a::read': 'hidden' } })
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultTools).toEqual(['read_file'])
  })

  it.skipIf(!REAL)('a chat-bar Codex model pick inside a Settings sandbox change: both survive, in both orders (BL-848, real Redis)', async () => {
    for (const [inner, outer] of [[CHAT_BAR_MODEL, SETTINGS_SANDBOX], [SETTINGS_SANDBOX, CHAT_BAR_MODEL]]) {
      await seedBlocks()
      const probe = runBeforeFirstScript(() => put(inner))
      await put(outer)
      vi.restoreAllMocks()
      expect(probe.ran()).toBe(true)
      expect((await stored()).codex_settings).toEqual(EXPECTED_CODEX)
    }
  })

  it('a partial block passes the config override check; a bad override is still refused when it is sent, and nothing is written', async () => {
    await seedBlocks()
    await put({ codex_settings: { model: 'gpt-6' } })
    await put({ claude_settings: { permissionMode: 'plan' } })

    const badCodex = await putRaw({ codex_settings: { model: 'gpt-7', configOverrides: [{ key: 'history.persistence', value: 'none' }] } })
    expect(badCodex.status).toBe(400)
    expect(((await badCodex.json()) as any).error).toContain("can't redefine Batshit-managed settings")
    const badClaude = await putRaw({ claude_settings: { model: 'opus', configOverrides: [{ key: 'permissions', value: 'x' }] } })
    expect(badClaude.status).toBe(400)
    expect(((await badClaude.json()) as any).error).toContain("can't redefine Batshit-managed settings")

    const record = await stored()
    expect(record.codex_settings).toEqual({ ...CODEX, model: 'gpt-6' })
    expect(record.claude_settings).toEqual({ ...CLAUDE, permissionMode: 'plan' })
  })

  it('a block that is not an object or null is a 400 from the route, and nothing is written', async () => {
    await seedBlocks()
    for (const body of [{ codex_settings: 'gpt-6' }, { claude_settings: ['plan'] }, { dcmDisplaySettings: 5 }]) {
      const response = await putRaw({ displayName: 'Half saved', ...body })
      expect(response.status).toBe(400)
      expect(((await response.json()) as any).error).toMatch(/must be an object or null/)
    }
    const record = await stored()
    expect(record.displayName).toBe('Probe')
    expect(record.codex_settings).toEqual(CODEX)
    expect(record.claude_settings).toEqual(CLAUDE)
    expect(record.dcmDisplaySettings).toEqual(DCM)
  })
})
