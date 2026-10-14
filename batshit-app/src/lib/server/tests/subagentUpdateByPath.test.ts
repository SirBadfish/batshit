import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  SUBAGENT_KEPT_FIELDS,
  buildSubagentWrites,
  deriveSubagentTypeWrites,
  planSubagentRecordUpdate
} from '$lib/server/subagentRecordUpdate'

/**
 * BL-914: `redis.updateSubagent` writes only the fields its caller passed to a Subagent record,
 * each by path, in one step inside Redis (`UPDATE_SUBAGENT_FIELDS_SCRIPT`), under the rules the
 * agent update has had since BL-768 (they share `planRecordFieldOps` and the ops loop). The route
 * (`routes/api/subagents/[id]/subagent-update-by-path.test.ts`) has the overlapping-save and
 * partial-block tests; this file holds the plan, the script, and the default lane's twin.
 *
 * Real Redis 8 under `npm run test:redis` (a Lua script there); the default lane's fake twin under
 * plain `npm test`. The parity tests need the real client and run on the real lane only.
 */

useRedisTestServer()

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zsu_user'
const SUB = 'zsu_sub'
const KEY = `subagent:${SUB}`
const OLD_STAMP = '2026-09-28T09:00:00.000Z'
const NOW = '2026-09-29T09:00:00.000Z'

async function seed(record: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', {
    id: SUB,
    user_id: USER,
    displayName: 'Probe',
    slug: SUB,
    subagentType: 'api',
    created_at: OLD_STAMP,
    updated_at: OLD_STAMP,
    codex_settings: { model: 'gpt-5', sandbox: 'workspace-write' },
    provider_specific_settings: { temperature: 1.2, nativeTools: { bashAccessMode: 'plan' } },
    ...record
  } as never)
}

async function stored() {
  return (await redis.json.get(KEY)) as any
}

afterEach(async () => {
  vi.restoreAllMocks()
  await redis.del(KEY)
})

describe('the plan of a Subagent update (BL-914)', () => {
  it('a field is one set op, the stamp is the last op, and undefined names nothing', () => {
    const { ops } = planSubagentRecordUpdate({ writes: { displayName: 'A', description: undefined, defaultMCPGateways: ['gw'] }, now: NOW })
    expect(ops).toEqual([
      { op: 'set', field: 'displayName', value: 'A' },
      { op: 'set', field: 'defaultMCPGateways', value: ['gw'] },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('id, user_id, slug, created_at and updated_at are never written, whatever the writes name', () => {
    const writes = Object.fromEntries([...SUBAGENT_KEPT_FIELDS].map((field) => [field, 'x']))
    expect(planSubagentRecordUpdate({ writes: { ...writes, displayName: 'A' }, now: NOW }).ops).toEqual([
      { op: 'set', field: 'displayName', value: 'A' },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('a null removes only the fields that name it; every other field stores the null', () => {
    const { ops } = planSubagentRecordUpdate({
      writes: { system_prompt: null, timeout_seconds: null, webhook_url: null, description: null, primary_model_preset_id: null },
      now: NOW
    })
    expect(ops).toEqual([
      { op: 'delete', field: 'system_prompt' },
      { op: 'delete', field: 'timeout_seconds' },
      { op: 'delete', field: 'webhook_url' },
      { op: 'set', field: 'description', value: null },
      { op: 'set', field: 'primary_model_preset_id', value: null },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('the blocks are written key by key, an entry of a Tool Grid map on its own', () => {
    const { ops } = planSubagentRecordUpdate({
      writes: {
        codex_settings: { model: 'gpt-6', permissionMode: null },
        provider_specific_settings: { temperature: null, nativeTools: { bashAccessMode: 'agent' } },
        dcmDisplaySettings: { groups: { gw_a: 'hidden' } }
      },
      now: NOW
    })
    expect(ops).toEqual([
      { op: 'ensureObject', field: 'codex_settings' },
      { op: 'set', field: 'codex_settings', key: 'model', value: 'gpt-6' },
      { op: 'delete', field: 'codex_settings', key: 'permissionMode' },
      { op: 'ensureObject', field: 'provider_specific_settings' },
      { op: 'delete', field: 'provider_specific_settings', key: 'temperature' },
      { op: 'ensureObject', field: 'provider_specific_settings', key: 'nativeTools' },
      { op: 'set', field: 'provider_specific_settings', key: 'nativeTools', subkey: 'bashAccessMode', value: 'agent' },
      { op: 'ensureObject', field: 'dcmDisplaySettings' },
      { op: 'ensureObject', field: 'dcmDisplaySettings', key: 'groups' },
      { op: 'set', field: 'dcmDisplaySettings', key: 'groups', subkey: 'gw_a', value: 'hidden' },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('a field name that is not a field name is refused with a 400', () => {
    expect(() => planSubagentRecordUpdate({ writes: { 'bad.name': 1 }, now: NOW })).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringContaining('Not a Subagent field name') })
    )
  })
})

describe('the type fields a save writes (BL-914)', () => {
  const derive = (body: Record<string, unknown>, nextType: any, webhookUrl = '') => deriveSubagentTypeWrites({ body, nextType, webhookUrl })

  it('a body that names none of them writes none', () => {
    expect(derive({ description: 'x', system_prompt: 'y' }, 'n8n-workflow', 'https://n8n.example/hook')).toEqual({})
    expect(derive({}, 'cli')).toEqual({})
  })

  it('a type that is not workflow-backed removes the webhook pair and the workflow name; the type is written only when named', () => {
    expect(derive({ subagentType: 'cli' }, 'cli')).toEqual({
      subagentType: 'cli', subagent_type: null, webhook_url: null, webhookUrl: null, workflowName: null
    })
    expect(derive({ webhook_url: 'https://x' }, 'api')).toEqual({ webhook_url: null, webhookUrl: null, workflowName: null })
    expect(derive({ workflowName: 'flow' }, 'cli')).toEqual({ webhook_url: null, webhookUrl: null, workflowName: null })
  })

  it('a workflow-backed type writes the webhook pair only when a webhook is named as a string, the workflow name only as a string', () => {
    expect(derive({ subagentType: 'n8n-workflow' }, 'n8n-workflow', 'https://stored')).toEqual({ subagentType: 'n8n-workflow', subagent_type: null })
    expect(derive({ webhook_url: ' https://x ' }, 'n8n-workflow', 'https://x')).toEqual({ webhook_url: 'https://x', webhookUrl: 'https://x' })
    expect(derive({ webhookUrl: 'https://y' }, 'n8n-workflow', 'https://y')).toEqual({ webhook_url: 'https://y', webhookUrl: 'https://y' })
    expect(derive({ webhook_url: null }, 'n8n-workflow', 'https://stored')).toEqual({})
    expect(derive({ workflowName: '  flow ' }, 'n8n-workflow', 'https://stored')).toEqual({ workflowName: 'flow' })
    expect(derive({ workflowName: '   ' }, 'n8n-workflow', 'https://stored')).toEqual({ workflowName: null })
    expect(derive({ workflowName: null }, 'n8n-workflow', 'https://stored')).toEqual({})
  })

  it('buildSubagentWrites keeps the body\'s other fields, drops the kept and type fields, and normalizes as the route did', () => {
    const writes = buildSubagentWrites({
      body: {
        id: 'x', user_id: 'x', slug: 'x', created_at: 'x', updated_at: 'x', subagent_type: 'cli',
        displayName: 'A', system_prompt: '  ', timeout_seconds: '', avatar_icon_fit: 'contain', avatar_icon_ref: null,
        codex_settings: { model: 'gpt-6' }
      },
      nextType: 'api',
      webhookUrl: ''
    })
    expect(writes).toEqual({
      displayName: 'A', system_prompt: null, timeout_seconds: null, avatar_icon_fit: 'fill', avatar_icon_ref: null,
      codex_settings: { model: 'gpt-6' }
    })
  })

  it('buildSubagentWrites: a prompt with text and a timeout number are written as they are; a bad icon reference is a 400', () => {
    expect(buildSubagentWrites({ body: { system_prompt: 'Be brief.', timeout_seconds: 90 }, nextType: 'api', webhookUrl: '' })).toEqual({
      system_prompt: 'Be brief.', timeout_seconds: 90
    })
    expect(() => buildSubagentWrites({ body: { avatar_icon_ref: { nope: 1 } }, nextType: 'api', webhookUrl: '' })).toThrow(
      expect.objectContaining({ status: 400 })
    )
  })
})

describe('updateSubagent writes only the fields it was given (BL-914)', () => {
  it('writes the named fields and the stamp; every other field stays', async () => {
    await seed({ system_prompt: 'Keep me.', defaultMCPGateways: ['gw'] })
    expect(await redis.updateSubagent(SUB, { displayName: 'Renamed', description: 'New.' })).toBe(true)
    const record = await stored()
    expect(record).toMatchObject({
      id: SUB, user_id: USER, slug: SUB, created_at: OLD_STAMP, displayName: 'Renamed', description: 'New.',
      system_prompt: 'Keep me.', defaultMCPGateways: ['gw'], subagentType: 'api'
    })
    expect(record.updated_at).not.toBe(OLD_STAMP)
  })

  it('writes each block key by key: a key not named stays, a null key is removed, a block or map is made an object first', async () => {
    await seed({ dcmDisplaySettings: { version: 1, groups: { gw_a: 'group-only' } } })
    await redis.updateSubagent(SUB, {
      codex_settings: { model: null, reasoningEffort: 'high' },
      provider_specific_settings: { temperature: null, seed: 3, nativeTools: { webSearchEnabled: true } },
      dcmDisplaySettings: { groups: { gw_b: 'hidden' }, tools: { t: 'hidden' } },
      claude_settings: { model: 'opus' }
    })
    const record = await stored()
    expect(record.codex_settings).toEqual({ sandbox: 'workspace-write', reasoningEffort: 'high' })
    expect(record.provider_specific_settings).toEqual({ seed: 3, nativeTools: { bashAccessMode: 'plan', webSearchEnabled: true } })
    expect(record.dcmDisplaySettings).toEqual({ version: 1, groups: { gw_a: 'group-only', gw_b: 'hidden' }, tools: { t: 'hidden' } })
    expect(record.claude_settings).toEqual({ model: 'opus' })
  })

  it('the block sent as null: provider_specific_settings is removed, the other three become null', async () => {
    await seed({ claude_settings: { model: 'x' }, dcmDisplaySettings: { version: 1 } })
    await redis.updateSubagent(SUB, { provider_specific_settings: null, codex_settings: null, claude_settings: null, dcmDisplaySettings: null })
    const record = await stored()
    expect('provider_specific_settings' in record).toBe(false)
    expect(record.codex_settings).toBeNull()
    expect(record.claude_settings).toBeNull()
    expect(record.dcmDisplaySettings).toBeNull()
  })

  it('a field of SUBAGENT_REMOVES_ON_NULL sent as null is removed; any other stores the null', async () => {
    await seed({ system_prompt: 'x', timeout_seconds: 30, webhook_url: 'u', webhookUrl: 'u', workflowName: 'w', subagent_type: 'api', description: 'd' })
    await redis.updateSubagent(SUB, {
      system_prompt: null, timeout_seconds: null, webhook_url: null, webhookUrl: null, workflowName: null, subagent_type: null, description: null
    })
    const record = await stored()
    for (const gone of ['system_prompt', 'timeout_seconds', 'webhook_url', 'webhookUrl', 'workflowName', 'subagent_type']) {
      expect(gone in record).toBe(false)
    }
    expect(record.description).toBeNull()
  })

  it('id, user_id, slug, created_at and updated_at in the writes change nothing (the stamp is the save\'s own)', async () => {
    await seed()
    await redis.updateSubagent(SUB, {
      id: 'x', user_id: 'x', slug: 'x', created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z', displayName: 'A'
    })
    const record = await stored()
    expect(record).toMatchObject({ id: SUB, user_id: USER, slug: SUB, created_at: OLD_STAMP, displayName: 'A' })
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expect(record.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
  })

  it('a Subagent that is gone: answers false and does not make it again', async () => {
    expect(await redis.updateSubagent(SUB, { displayName: 'Ghost' })).toBe(false)
    expect(await redis.exists(KEY)).toBe(false)
  })

  it("a key that is not a JSON record answers as Redis does: RedisJSON's wrong-type error, the key left as it is", async () => {
    await redis.set(KEY, 'plain text')
    await expect(redis.updateSubagent(SUB, { displayName: 'X' })).rejects.toThrow(/Existing key has wrong Redis type/)
    expect(await redis.get(KEY)).toBe('plain text')
  })

  it('a refused save is a 400 and writes nothing, the fields of the same save included', async () => {
    const lone = String.fromCharCode(0xd800)
    let deep: unknown = 1
    for (let level = 0; level < 65; level += 1) deep = { a: deep }
    for (const writes of [
      { codex_settings: 'oops' },
      { dcmDisplaySettings: { tools: 'oops' } },
      { provider_specific_settings: ['a'] },
      { codex_settings: { [`k${lone}`]: 1 } },
      { provider_specific_settings: { deep } },
      { description: `half${lone}` },
      { 'bad.name': 1 }
    ]) {
      await seed()
      await expect(redis.updateSubagent(SUB, { displayName: 'Half saved', ...writes })).rejects.toMatchObject({ status: 400 })
      const record = await stored()
      expect(record.displayName).toBe('Probe')
      expect(record.updated_at).toBe(OLD_STAMP)
    }
  })

  it('a settings key with any characters is stored under its exact name, and removed by it', async () => {
    const odd = ['top_p.v2', 'say "hi"', `path${String.fromCharCode(92)}to`, 'arr[0]', '"]', '', '__proto__']
    await seed()
    await redis.updateSubagent(SUB, {
      codex_settings: Object.fromEntries(odd.map((key, index) => [key, index])),
      dcmDisplaySettings: { groups: Object.fromEntries(odd.map((key, index) => [key, `mode ${index}`])) }
    })
    let record = await stored()
    odd.forEach((key, index) => {
      expect(Object.prototype.hasOwnProperty.call(record.codex_settings, key)).toBe(true)
      expect(record.codex_settings[key]).toBe(index)
      expect(record.dcmDisplaySettings.groups[key]).toBe(`mode ${index}`)
    })
    expect(record.subagentType).toBe('api')
    await redis.updateSubagent(SUB, {
      codex_settings: Object.fromEntries(odd.map((key) => [key, null])),
      dcmDisplaySettings: { groups: Object.fromEntries(odd.map((key) => [key, null])) }
    })
    record = await stored()
    expect(record.codex_settings).toEqual({ model: 'gpt-5', sandbox: 'workspace-write' })
    expect(record.dcmDisplaySettings.groups).toEqual({})
  })
})

describe.skipIf(!REAL)('updateSubagent against the real script (real Redis)', () => {
  /** Runs `change` before each script call on this Subagent (after the caller's plan was made). */
  function beforeScript(change: (client: any) => Promise<void>) {
    const execute = redis.execute.bind(redis)
    const scriptCalls: string[][] = []
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'eval') {
              return async (script: string, options: { keys?: string[]; arguments?: string[] }) => {
                if (options?.keys?.[0] === KEY) {
                  scriptCalls.push([...(options.arguments ?? [])])
                  await change(client)
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
    return { scriptCalls }
  }

  it('a change written by another writer right before the script survives: only the named paths are written', async () => {
    await seed()
    beforeScript(async (client) => {
      await client.json.set(KEY, '$.codex_settings.model', 'gpt-6')
      await client.json.set(KEY, '$.description', 'written meanwhile')
      await client.json.set(KEY, '$.subagentType', 'cli')
    })
    await redis.updateSubagent(SUB, { codex_settings: { reasoningEffort: 'high' }, displayName: 'Saved' })
    const record = await stored()
    expect(record.codex_settings).toEqual({ model: 'gpt-6', sandbox: 'workspace-write', reasoningEffort: 'high' })
    expect(record.description).toBe('written meanwhile')
    expect(record.subagentType).toBe('cli')
    expect(record.displayName).toBe('Saved')
  })

  it('a Subagent deleted after the plan and before the script is not made again', async () => {
    await seed()
    beforeScript(async (client) => {
      await client.del(KEY)
    })
    expect(await redis.updateSubagent(SUB, { displayName: 'Ghost' })).toBe(false)
    vi.restoreAllMocks()
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('many saves of different keys at the same moment all land', async () => {
    await seed({ codex_settings: {} })
    const names = Array.from({ length: 24 }, (_, index) => `key${index}`)
    const answers = await Promise.all(names.map((name, index) => redis.updateSubagent(SUB, { codex_settings: { [name]: index } })))
    expect(answers.every(Boolean)).toBe(true)
    const block = (await stored()).codex_settings
    expect(Object.keys(block).sort()).toEqual([...names].sort())
  })

  it("the default lane's twin applies the real script's argument the same way: odd keys, removals, null blocks, blocks that are not objects, the stamp", async () => {
    const { runSubagentUpdateScriptTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
    const odd = ['top_p.v2', 'say "hi"', `path${String.fromCharCode(92)}to`, 'arr[0]', '"]', '', '__proto__']
    const cases: Array<{ record: Record<string, unknown>; writes: Record<string, unknown> }> = [
      { record: {}, writes: { displayName: 'Twin', description: null, system_prompt: null, timeout_seconds: null } },
      {
        record: {},
        writes: {
          provider_specific_settings: { ...Object.fromEntries(odd.map((key, index) => [key, { index }])), temperature: null },
          codex_settings: Object.fromEntries(odd.map((key, index) => [key, [index]]))
        }
      },
      { record: { provider_specific_settings: 'not an object', codex_settings: null }, writes: { provider_specific_settings: { knob: 1 }, codex_settings: { model: 'x' } } },
      { record: {}, writes: { provider_specific_settings: null, codex_settings: null, claude_settings: null, dcmDisplaySettings: null } },
      { record: { provider_specific_settings: { nativeTools: 'odd' } }, writes: { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } } },
      { record: { provider_specific_settings: { temperature: 1 } }, writes: { provider_specific_settings: { nativeTools: { bashAccessMode: null } } } },
      { record: { dcmDisplaySettings: { version: 1, groups: { a: 'x' }, tools: { t: 'y' } } }, writes: { dcmDisplaySettings: { version: 1, groups: { ...Object.fromEntries(odd.map((key, index) => [key, `mode ${index}`])), a: null }, tools: { t2: 'n' }, toolDisplayPreferences: null } } },
      { record: { dcmDisplaySettings: 'odd' }, writes: { dcmDisplaySettings: { groups: { a: 'hidden' } } } },
      { record: { dcmDisplaySettings: { version: 1, groups: 'odd', tools: null } }, writes: { dcmDisplaySettings: { groups: { a: 'hidden' }, tools: { b: 'hidden' } } } },
      { record: {}, writes: { dcmDisplaySettings: { groups: { a: null } }, claude_settings: {} } },
      // The type rule's writes: removals of the pair and the legacy type, then a workflow-backed type.
      { record: { subagentType: 'n8n-workflow', webhook_url: 'u', webhookUrl: 'u', workflowName: 'w', subagent_type: 'n8n-workflow' }, writes: { subagentType: 'cli', subagent_type: null, webhook_url: null, webhookUrl: null, workflowName: null } },
      { record: {}, writes: { subagentType: 'n8n-workflow', subagent_type: null, webhook_url: 'https://n8n.example/hook', webhookUrl: 'https://n8n.example/hook', workflowName: 'flow' } }
    ]
    for (const { record, writes } of cases) {
      await seed(record)
      const before = await stored()
      const probe = beforeScript(async () => {})
      await redis.updateSubagent(SUB, writes)
      vi.restoreAllMocks()
      expect(probe.scriptCalls.length).toBe(1)
      const twin = runSubagentUpdateScriptTwin(before, probe.scriptCalls[0])
      expect(twin.record).toEqual(await stored())
    }
  })
})
