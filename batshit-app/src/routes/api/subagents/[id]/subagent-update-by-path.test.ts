import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-914: `PUT /api/subagents/[id]` writes each field the body names by path, key by key inside
 * `codex_settings`, `claude_settings`, `provider_specific_settings` and `dcmDisplaySettings`, in
 * one step inside Redis (`redis.updateSubagent`, the Subagent twin of BL-768's `updateAgent`).
 * It used to read the record, wait for the request body, lay the body over the record it had
 * read (`{ ...existing, ...body }`) and write the WHOLE record back. Two things were lost:
 * - a partial block erased the keys it did not name, and a stale copy took back another
 *   window's choice inside those blocks;
 * - two saves of different fields that overlapped in time (the core autosave and the Tool Grid
 *   save of one panel): the later write carried the earlier read, one field was lost, and both
 *   answered success.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis` (the script is Lua there); the
 * default lane's fake runs its twin (`test-utils/agentUpdateScriptTwin.ts`). An overlap is
 * deterministic: the first request is held where the route waits for its body (after its read
 * of the record), the second runs to its end, then the first goes on.
 */

const syncManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/cliSubagentProfileSync')>()
  return { ...actual, syncManagedCliSubagentProfile }
})
vi.mock('$lib/server/services/codexProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/codexProfileManager')>()
  return { ...actual, syncAgentCodexProfiles: vi.fn(async () => {}) }
})
vi.mock('$lib/server/services/claudeProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/claudeProfileManager')>()
  return { ...actual, syncAgentClaudeProfiles: vi.fn(async () => {}) }
})
const compatibilitySync = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: compatibilitySync }))

useRedisTestServer()

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zu2_user'
const SUB = 'zu2_sub'
const KEY = `subagent:${SUB}`
const OLD_STAMP = '2026-09-28T00:00:00.000Z'

const CODEX_BLOCK = {
  model: 'gpt-5.5',
  permissionMode: 'chat',
  sandbox: 'workspace-write',
  addDirs: ['/one', '/two'],
  configOverrides: [{ key: 'model_verbosity', value: 'low' }]
}
const CLAUDE_BLOCK = { model: 'sonnet', permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: ['/one'] }
const DCM_BLOCK = {
  version: 1,
  groups: { gw_a: 'group-only', gw_b: 'hidden' },
  tools: { 'gw_a::read': 'name-only' },
  groupDisplayPreferences: { gw_a: 'group-only' },
  toolDisplayPreferences: { 'gw_a::read': 'name+hint' }
}
const PROVIDER_BLOCK = { temperature: 0.7, reasoningEffort: 'low', nativeTools: { webSearchEnabled: false, bashAccessMode: 'plan' } }

const RECORD = {
  id: SUB,
  user_id: USER,
  displayName: 'zu2 sub',
  slug: SUB,
  subagentType: 'api',
  specialty: 'general',
  description: 'Writes haiku.',
  system_prompt: 'Answer only in haiku.',
  include_global_prompt: true,
  primary_model_provider: 'openai',
  primary_model_name: 'gpt-5.5',
  primary_model_preset_id: 'zu2_preset',
  primary_model_connection: { type: 'direct', service: 'openai' },
  timeout_seconds: 45,
  avatar: null,
  defaultMCPGateways: ['gw_a'],
  codex_settings: CODEX_BLOCK,
  claude_settings: CLAUDE_BLOCK,
  dcmDisplaySettings: DCM_BLOCK,
  provider_specific_settings: PROVIDER_BLOCK,
  created_at: OLD_STAMP,
  updated_at: OLD_STAMP
}

async function seed(record: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', { ...RECORD, ...record } as never)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
}

async function stored() {
  return (await redis.json.get(KEY)) as Record<string, any>
}

/** The PUT, with `beforeBody` run where the route awaits the request body (after its read). */
async function callPut(updates: unknown, beforeBody: () => Promise<void> = async () => {}, user = USER) {
  const { PUT } = await import('./+server')
  const request = {
    json: async () => {
      await beforeBody()
      return updates
    }
  }
  const response = (await PUT({ params: { id: SUB }, request, locals: { user: { id: user } } } as any)) as Response
  return { status: response.status, body: await response.json() }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * `first` is held after its read of the record, `second` runs to its end, then `first` goes on:
 * the two saves overlap in time, `first`'s read being older than `second`'s write.
 */
async function overlapping(first: Record<string, unknown>, second: Record<string, unknown>) {
  const reached = deferred()
  const release = deferred()
  const firstCall = callPut(first, async () => {
    reached.resolve()
    await release.promise
  })
  await reached.promise
  const secondResult = await callPut(second)
  release.resolve()
  return { first: await firstCall, second: secondResult }
}

beforeEach(() => {
  syncManagedCliSubagentProfile.mockReset()
  syncManagedCliSubagentProfile.mockImplementation(async () => ({ runtime: 'codex', profileId: 'p', written: true }))
  compatibilitySync.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await redis.del(KEY)
  await redis.del(`user:${USER}:subagents`)
})

describe('two Subagent saves that overlap in time both stay (BL-914, second condition)', () => {
  const CORE_SAVE = { displayName: 'zu2 renamed', description: 'Writes limericks.' }
  const TOOL_GRID_SAVE = { defaultMCPGateways: ['gw_a', 'gw_b'], defaultMCPToolSelections: ['gw_a::read'] }

  it('the core save and the Tool Grid save of one panel: the field of each is on the record, in both orders', async () => {
    await seed()
    let saved = await overlapping(CORE_SAVE, TOOL_GRID_SAVE)
    expect([saved.first.status, saved.second.status]).toEqual([200, 200])
    let record = await stored()
    expect(record.displayName).toBe('zu2 renamed')
    expect(record.description).toBe('Writes limericks.')
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultMCPToolSelections).toEqual(['gw_a::read'])

    await seed()
    saved = await overlapping(TOOL_GRID_SAVE, CORE_SAVE)
    expect([saved.first.status, saved.second.status]).toEqual([200, 200])
    record = await stored()
    expect(record.displayName).toBe('zu2 renamed')
    expect(record.description).toBe('Writes limericks.')
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultMCPToolSelections).toEqual(['gw_a::read'])
  }, 30_000)

  it('two saves that each name a different key of ONE block both survive, in both orders', async () => {
    for (const [field, first, second, expected] of [
      ['codex_settings', { model: 'gpt-6' }, { sandbox: 'read-only' }, { ...CODEX_BLOCK, model: 'gpt-6', sandbox: 'read-only' }],
      ['claude_settings', { permissionMode: 'plan' }, { model: 'opus' }, { ...CLAUDE_BLOCK, permissionMode: 'plan', model: 'opus' }],
      [
        'provider_specific_settings',
        { temperature: 0.2 },
        { reasoningEffort: 'high' },
        { ...PROVIDER_BLOCK, temperature: 0.2, reasoningEffort: 'high' }
      ],
      [
        'dcmDisplaySettings',
        { groups: { gw_a: 'hidden' } },
        { groups: { gw_c: 'group+tools+names' }, tools: { 'gw_a::write': 'hidden' } },
        {
          ...DCM_BLOCK,
          groups: { gw_a: 'hidden', gw_b: 'hidden', gw_c: 'group+tools+names' },
          tools: { 'gw_a::read': 'name-only', 'gw_a::write': 'hidden' }
        }
      ]
    ] as const) {
      for (const [early, late] of [[first, second], [second, first]]) {
        await seed()
        const saved = await overlapping({ [field]: early }, { [field]: late })
        expect([field, saved.first.status, saved.second.status]).toEqual([field, 200, 200])
        expect([field, (await stored())[field]]).toEqual([field, expected])
      }
    }
  }, 60_000)

  it('a stale save keeps a choice another window wrote inside the block meanwhile', async () => {
    await seed()
    const held = await callPut({ codex_settings: { reasoningEffort: 'high' } }, async () => {
      // Another window picks another Codex model, by path, after this save read its copy.
      await redis.json.set(KEY, '$.codex_settings.model', 'gpt-6')
    })
    expect(held.status).toBe(200)
    expect((await stored()).codex_settings).toEqual({ ...CODEX_BLOCK, model: 'gpt-6', reasoningEffort: 'high' })
  })

  it('a stale save of the core form keeps a type another save wrote meanwhile (the derived fields are not rewritten)', async () => {
    await seed({ subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook', webhookUrl: 'https://n8n.example/hook', workflowName: 'flow' })
    const saved = await overlapping({ description: 'Edited while the type changed.' }, { subagentType: 'cli' })
    expect([saved.first.status, saved.second.status]).toEqual([200, 200])
    const record = await stored()
    expect(record.description).toBe('Edited while the type changed.')
    expect(record.subagentType).toBe('cli')
    expect('webhook_url' in record).toBe(false)
    expect('webhookUrl' in record).toBe(false)
    expect('workflowName' in record).toBe(false)
  })

  it('answers the record as it is after the write: the other save\'s field is in the answer, and the profile sync gets it', async () => {
    await seed({ subagentType: 'cli' })
    const saved = await overlapping({ description: 'first save' }, { defaultMCPGateways: ['gw_z'] })
    expect(saved.first.body.subagent.description).toBe('first save')
    expect(saved.first.body.subagent.defaultMCPGateways).toEqual(['gw_z'])
    const synced = syncManagedCliSubagentProfile.mock.calls.at(-1)?.[1]
    expect(synced).toMatchObject({ id: SUB, description: 'first save', defaultMCPGateways: ['gw_z'], subagentType: 'cli' })
  })
})

describe('a block the body names only in part keeps the keys it leaves out (BL-914, first condition)', () => {
  it('codex_settings and claude_settings: a named key is written, every other key stays', async () => {
    await seed()
    const { status } = await callPut({ codex_settings: { model: 'gpt-6-sol' }, claude_settings: { permissionMode: 'acceptEdits' } })
    expect(status).toBe(200)
    const record = await stored()
    expect(record.codex_settings).toEqual({ ...CODEX_BLOCK, model: 'gpt-6-sol' })
    expect(record.claude_settings).toEqual({ ...CLAUDE_BLOCK, permissionMode: 'acceptEdits' })
  })

  it('a key named null is removed; a list is written whole; the block sent as null is a write of null', async () => {
    await seed()
    await callPut({ codex_settings: { permissionMode: null, addDirs: ['/c'], search: true }, claude_settings: { model: null } })
    let record = await stored()
    expect(record.codex_settings).toEqual({ model: 'gpt-5.5', sandbox: 'workspace-write', addDirs: ['/c'], configOverrides: CODEX_BLOCK.configOverrides, search: true })
    expect(record.claude_settings).toEqual({ permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: ['/one'] })

    await callPut({ codex_settings: null, claude_settings: null, dcmDisplaySettings: null })
    record = await stored()
    expect(record.codex_settings).toBeNull()
    expect(record.claude_settings).toBeNull()
    expect(record.dcmDisplaySettings).toBeNull()
  })

  it('dcmDisplaySettings: each map entry is written on its own, an entry named null is removed', async () => {
    await seed()
    await callPut({ dcmDisplaySettings: { groups: { gw_b: null, gw_d: 'group-only' }, tools: { 'gw_a::read': 'hidden' }, toolDisplayPreferences: { 'gw_a::read': null } } })
    expect((await stored()).dcmDisplaySettings).toEqual({
      version: 1,
      groups: { gw_a: 'group-only', gw_d: 'group-only' },
      tools: { 'gw_a::read': 'hidden' },
      groupDisplayPreferences: { gw_a: 'group-only' },
      toolDisplayPreferences: {}
    })
  })

  it('provider_specific_settings: key by key, nativeTools field by field; the block as null is removed', async () => {
    await seed()
    await callPut({ provider_specific_settings: { temperature: null, seed: 7, nativeTools: { webSearchEnabled: true, bashAccessMode: null } } })
    expect((await stored()).provider_specific_settings).toEqual({
      reasoningEffort: 'low',
      seed: 7,
      nativeTools: { webSearchEnabled: true }
    })

    await callPut({ provider_specific_settings: {} })
    expect((await stored()).provider_specific_settings).toEqual({ reasoningEffort: 'low', seed: 7, nativeTools: { webSearchEnabled: true } })

    await callPut({ provider_specific_settings: null })
    expect('provider_specific_settings' in (await stored())).toBe(false)
  })

  it('a block missing on the record is made an object first, and only when a key is set', async () => {
    await seed({ codex_settings: undefined, claude_settings: 'garbage', provider_specific_settings: undefined })
    await callPut({ codex_settings: { model: 'gpt-6' }, claude_settings: { model: 'opus' }, provider_specific_settings: { temperature: 0.1 } })
    const record = await stored()
    expect(record.codex_settings).toEqual({ model: 'gpt-6' })
    expect(record.claude_settings).toEqual({ model: 'opus' })
    expect(record.provider_specific_settings).toEqual({ temperature: 0.1 })

    await seed({ codex_settings: undefined })
    await callPut({ codex_settings: { model: null } })
    expect('codex_settings' in (await stored())).toBe(false)
  })

  it('a block that is neither an object nor null is refused with a 400 and NOTHING of the save is written', async () => {
    for (const field of ['codex_settings', 'claude_settings', 'dcmDisplaySettings', 'provider_specific_settings']) {
      for (const bad of ['oops', ['a'], 5, true]) {
        await seed()
        const { status, body } = await callPut({ displayName: 'never written', description: 'never written', [field]: bad })
        expect([field, status]).toEqual([field, 400])
        expect(body.error).toMatch(/must be an object or null/)
        const record = await stored()
        expect(record.displayName).toBe('zu2 sub')
        expect(record.updated_at).toBe(OLD_STAMP)
      }
    }
  })

  it('a key or value with a broken character, or nested more than 64 levels: a 400 before anything is written', async () => {
    const lone = String.fromCharCode(0xd800)
    let deep: unknown = 1
    for (let level = 0; level < 65; level += 1) deep = { a: deep }
    for (const body of [
      { codex_settings: { [`model${lone}`]: 'x' } },
      { claude_settings: { addDirs: [`/a${lone}`] } },
      { dcmDisplaySettings: { groups: { [`gw${lone}`]: 'hidden' } } },
      { provider_specific_settings: { deep } },
      { defaultMCPGateways: [`gw${lone}`] }
    ]) {
      await seed()
      const { status } = await callPut({ displayName: 'never written', ...body })
      expect([JSON.stringify(Object.keys(body)), status]).toEqual([JSON.stringify(Object.keys(body)), 400])
      expect((await stored()).displayName).toBe('zu2 sub')
    }
  })

  it('a field name that is not a field name is a 400 and nothing is written', async () => {
    await seed()
    const { status, body } = await callPut({ displayName: 'never written', 'bad.name': 1 })
    expect(status).toBe(400)
    expect(body.error).toMatch(/Not a Subagent field name/)
    expect((await stored()).displayName).toBe('zu2 sub')
  })
})

describe('what the route checks before any write is unchanged (BL-914)', () => {
  async function expectRefused(updates: unknown, status: number, matcher: Record<string, unknown> | RegExp, record: Record<string, unknown> = {}) {
    await seed(record)
    const answer = await callPut(updates)
    expect(answer.status).toBe(status)
    if (matcher instanceof RegExp) expect(answer.body.error).toMatch(matcher)
    else expect(answer.body).toMatchObject(matcher)
    const after = await stored()
    expect(after.updated_at).toBe(OLD_STAMP)
    expect(after.displayName).toBe('zu2 sub')
  }

  it('a Subagent of the retired n8n Subnode type can only be deleted (409), whatever the body', async () => {
    await expectRefused(
      { displayName: 'never written' },
      409,
      { code: 'subagent_type_retired', error: 'This Subagent uses the retired n8n Subnode type and can only be deleted.' },
      { subagentType: 'n8n-subnode' }
    )
  })

  it('a type that is not n8n Workflow, API or CLI is a 400 with its code', async () => {
    for (const subagentType of ['n8n-subnode', 'bogus', '', null, 5]) {
      await expectRefused(
        { displayName: 'never written', subagentType },
        400,
        { code: 'subagent_type_invalid', error: 'Subagent type must be n8n Workflow, API, or CLI.' }
      )
    }
  })

  it('an n8n Workflow Subagent needs its production webhook URL', async () => {
    await expectRefused(
      { displayName: 'never written', subagentType: 'n8n-workflow' },
      400,
      { error: 'Production webhook URL is required for n8n Workflow Subagents.' }
    )
    await expectRefused(
      { displayName: 'never written', webhook_url: '   ' },
      400,
      { error: 'Production webhook URL is required for n8n Workflow Subagents.' },
      { subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook' }
    )
  })

  it('a Codex or Claude config override that redefines a Batshit setting is refused', async () => {
    await expectRefused({ displayName: 'never written', codex_settings: { configOverrides: [{ key: 'model', value: 'x' }] } }, 400, /can't redefine Batshit-managed settings: model/)
    await expectRefused({ displayName: 'never written', claude_settings: { configOverrides: [{ key: 'permissions', value: 'x' }] } }, 400, /Claude custom settings/)
  })

  it('a Call Timeout outside 10 to 600 seconds is refused; a blank one removes it; a number is stored', async () => {
    await expectRefused({ displayName: 'never written', timeout_seconds: 5 }, 400, /Call timeout must be a whole number from 10 to 600 seconds\./)
    await seed()
    await callPut({ timeout_seconds: '' })
    expect('timeout_seconds' in (await stored())).toBe(false)
    await callPut({ timeout_seconds: 120 })
    expect((await stored()).timeout_seconds).toBe(120)
    await callPut({ timeout_seconds: null })
    expect('timeout_seconds' in (await stored())).toBe(false)
  })

  it('an avatar icon reference or fit the picker cannot make is a 400; a valid one is stored, null is kept as null', async () => {
    await expectRefused({ displayName: 'never written', avatar_icon_ref: { bad: true } }, 400, /avatar_icon_ref must be a valid icon picker reference/)
    await expectRefused({ displayName: 'never written', avatar_icon_fit: 'stretch' }, 400, /avatar_icon_fit must be "contain" or "fill"/)
    await seed()
    await callPut({ avatar_icon_fit: 'contain', avatar_icon_ref: null })
    const record = await stored()
    expect(record.avatar_icon_fit).toBe('fill')
    expect(record.avatar_icon_ref).toBeNull()
  })

  it('a Subagent that is not there is a 404, and one that is another user\'s a 403', async () => {
    const gone = await callPut({ displayName: 'x' })
    expect(gone.status).toBe(404)
    expect(gone.body).toEqual({ error: 'Subagent not found' })
    expect(await redis.exists(KEY)).toBe(false)

    await seed()
    const foreign = await callPut({ displayName: 'never written' }, async () => {}, 'zu2_someone_else')
    expect(foreign.status).toBe(403)
    expect((await stored()).displayName).toBe('zu2 sub')
  })

  it('an emptied Custom System Prompt is removed (BL-482); an upload URL is stored in its storage form', async () => {
    await seed()
    await callPut({ system_prompt: '  ', avatar: 'http://localhost:5600/uploads/avatars/zu2.png' })
    const record = await stored()
    expect('system_prompt' in record).toBe(false)
    expect(record.avatar).toBe('/uploads/avatars/zu2.png')
  })
})

describe('a body never writes the fields the route keeps (BL-762, BL-914)', () => {
  it('id, user_id, slug, created_at and a legacy subagent_type in the body change nothing; updated_at is stamped by the save', async () => {
    await seed()
    const { status, body } = await callPut({
      id: 'zu2_other',
      user_id: 'zu2_someone_else',
      slug: 'zu2_hijacked',
      created_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
      subagent_type: 'cli',
      description: 'edited'
    })
    expect(status).toBe(200)
    const record = await stored()
    expect(record).toMatchObject({ id: SUB, user_id: USER, slug: SUB, created_at: OLD_STAMP, subagentType: 'api', description: 'edited' })
    expect('subagent_type' in record).toBe(false)
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expect(record.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
    expect(body.subagent.id).toBe(SUB)
  })
})

describe('the type fields are written only when the request names them (BL-914)', () => {
  const WORKFLOW = { subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook', webhookUrl: 'https://n8n.example/hook', workflowName: 'flow' }

  it('a save that names none of them leaves the type, the webhook pair and the workflow name as stored', async () => {
    await seed(WORKFLOW)
    await callPut({ description: 'edited' })
    expect(await stored()).toMatchObject({ ...WORKFLOW, description: 'edited' })
  })

  it('naming a type that is not workflow-backed removes the webhook pair, the workflow name and a legacy subagent_type', async () => {
    await seed({ ...WORKFLOW, subagent_type: 'n8n-workflow' })
    await callPut({ subagentType: 'cli' })
    const record = await stored()
    expect(record.subagentType).toBe('cli')
    for (const gone of ['webhook_url', 'webhookUrl', 'workflowName', 'subagent_type']) expect(gone in record).toBe(false)
  })

  it('naming a webhook on a Subagent that is not workflow-backed removes the pair, as every save did', async () => {
    await seed({ webhook_url: 'https://left.over/hook', webhookUrl: 'https://left.over/hook', workflowName: 'left over' })
    await callPut({ webhook_url: 'https://n8n.example/hook' })
    const record = await stored()
    expect(record.subagentType).toBe('api')
    for (const gone of ['webhook_url', 'webhookUrl', 'workflowName']) expect(gone in record).toBe(false)
  })

  it('naming n8n Workflow with a webhook writes the type and BOTH webhook fields, trimmed; the workflow name is trimmed, or removed when blank', async () => {
    await seed({ subagent_type: 'api' })
    await callPut({ subagentType: 'n8n-workflow', webhook_url: '  https://n8n.example/hook  ', workflowName: '  flow  ' })
    let record = await stored()
    expect(record).toMatchObject({ subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook', webhookUrl: 'https://n8n.example/hook', workflowName: 'flow' })
    expect('subagent_type' in record).toBe(false)

    await callPut({ workflowName: '   ' })
    record = await stored()
    expect('workflowName' in record).toBe(false)
    expect(record.subagentType).toBe('n8n-workflow')
    expect(record.webhook_url).toBe('https://n8n.example/hook')
  })

  it('naming only the webhook of a workflow-backed Subagent writes the pair and no type; the camelCase name works too', async () => {
    await seed(WORKFLOW)
    await callPut({ webhookUrl: 'https://n8n.example/new' })
    expect(await stored()).toMatchObject({ ...WORKFLOW, webhook_url: 'https://n8n.example/new', webhookUrl: 'https://n8n.example/new' })
  })

  it('the isolated test driver deadline probe body works: webhook pair and a null timeout, then a restore', async () => {
    await seed({ ...WORKFLOW, timeout_seconds: 30 })
    await callPut({ webhook_url: 'https://n8n.example/probe', webhookUrl: 'https://n8n.example/probe', timeout_seconds: null })
    let record = await stored()
    expect(record.webhook_url).toBe('https://n8n.example/probe')
    expect('timeout_seconds' in record).toBe(false)
    await callPut({ webhook_url: WORKFLOW.webhook_url, webhookUrl: WORKFLOW.webhook_url, timeout_seconds: 30 })
    record = await stored()
    expect(record).toMatchObject({ webhook_url: WORKFLOW.webhook_url, webhookUrl: WORKFLOW.webhook_url, timeout_seconds: 30 })
  })

  it('a workflow-backed save runs the n8n compatibility sync; a warning from it is answered, not an error', async () => {
    await seed(WORKFLOW)
    compatibilitySync.mockRejectedValueOnce(new Error('n8n is not reachable'))
    const { status, body } = await callPut({ description: 'edited' })
    expect(status).toBe(200)
    expect(body.compatibilityWarning).toBe('n8n is not reachable')
    expect(compatibilitySync).toHaveBeenCalledTimes(1)
  })
})

describe('a Subagent deleted meanwhile (BL-753, BL-914)', () => {
  it('deleted after the route read it, before its script: 404 with the same words, nothing made again, no profile sync', async () => {
    await seed({ subagentType: 'cli' })
    const { status, body } = await callPut({ description: 'edited' }, async () => {
      await redis.sRem(`user:${USER}:subagents`, SUB)
      await redis.del(KEY)
    })
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Subagent not found: it was deleted while this edit was saved.' })
    expect(await redis.exists(KEY)).toBe(false)
    expect(syncManagedCliSubagentProfile).not.toHaveBeenCalled()
  })

  /** Runs `hook` where the route makes its second read of the record (its read-back after the write). */
  async function withReadBackHook(hook: () => Promise<void>, run: () => Promise<void>): Promise<number> {
    const realJson = redis.json
    let reads = 0
    ;(redis as any).json = new Proxy(realJson, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== 'get') return typeof value === 'function' ? value.bind(target) : value
        return async (key: string, ...rest: unknown[]) => {
          if (key === KEY) {
            reads += 1
            if (reads === 2) await hook()
          }
          return (value as any).call(target, key, ...rest)
        }
      }
    })
    try {
      await run()
      return reads
    } finally {
      ;(redis as any).json = realJson
    }
  }

  it('deleted right after the script wrote: 404 with the same words, no profile sync', async () => {
    await seed({ subagentType: 'cli' })
    const reads = await withReadBackHook(
      async () => {
        await redis.sRem(`user:${USER}:subagents`, SUB)
        await redis.del(KEY)
      },
      async () => {
        const { status, body } = await callPut({ description: 'edited' })
        expect(status).toBe(404)
        expect(body).toEqual({ error: 'Subagent not found: it was deleted while this edit was saved.' })
        expect(syncManagedCliSubagentProfile).not.toHaveBeenCalled()
      }
    )
    expect(reads).toBe(2)
  })

  it('deleted before the script (and made again by the time of a read-back): the script answered that it wrote nothing, so the route stops with the 404 and reads nothing back', async () => {
    await seed({ subagentType: 'cli' })
    // The route stops at the script's answer (it wrote nothing), so it never makes a read-back.
    const reads = await withReadBackHook(
      async () => {
        await seed({ subagentType: 'cli', displayName: 'made again', description: 'the new record' })
      },
      async () => {
        const { status, body } = await callPut({ description: 'edited' }, async () => {
          await redis.sRem(`user:${USER}:subagents`, SUB)
          await redis.del(KEY)
        })
        expect(status).toBe(404)
        expect(body).toEqual({ error: 'Subagent not found: it was deleted while this edit was saved.' })
        expect(syncManagedCliSubagentProfile).not.toHaveBeenCalled()
      }
    )
    expect(reads).toBe(1)
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('the profile sync finding the Subagent gone is a 404 too', async () => {
    await seed({ subagentType: 'cli' })
    syncManagedCliSubagentProfile.mockImplementation(async () => ({ runtime: 'codex', profileId: 'p', written: false }))
    const { status } = await callPut({ description: 'edited' })
    expect(status).toBe(404)
  })
})

describe.skipIf(!REAL)('the whole-record write is gone (real Redis)', () => {
  it('the route makes no write of the whole record at $', async () => {
    await seed()
    const execute = redis.execute.bind(redis)
    const wholeWrites: unknown[] = []
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const json = new Proxy({}, {
          get(_empty, property) {
            const value = Reflect.get(client.json, property)
            if (property === 'set' || property === 'setIfExists') {
              return async (key: string, path: string, ...rest: unknown[]) => {
                if (key === KEY && path === '$') wholeWrites.push(rest[0])
                return value.call(client.json, key, path, ...rest)
              }
            }
            return typeof value === 'function' ? value.bind(client.json) : value
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

    await callPut({ description: 'edited', codex_settings: { model: 'gpt-6' } })
    vi.restoreAllMocks()
    expect(wholeWrites).toEqual([])
    expect((await stored()).codex_settings).toEqual({ ...CODEX_BLOCK, model: 'gpt-6' })
  })
})
