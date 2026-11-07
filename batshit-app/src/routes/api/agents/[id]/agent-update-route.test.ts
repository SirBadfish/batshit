// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { MCP_SETTINGS_REVISION_HEADER, readMcpSettingsRevisions } from '$lib/utils/agentSettingsSectionSaves'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { buildAgentMemoryRecordFields, resolveAgentMemorySettingsDraft } from '$lib/utils/memoryControl'
import { CONFIGURED_TTS_REVISION_HEADER } from '$lib/appActions/settings/configuredTtsBaseline'
import { withSettingsRecordReplacement } from '$lib/server/services/appActions/settings/lifecycle'
import { namesModelSelection } from '$lib/server/modelSelectionGuard'
import { MODEL_SELECTION_REVISION_HEADER } from '$lib/appActions/settings/modelSelectionBaseline'
import * as ssePublisher from '$lib/server/ssePublisher'
import { namesTypedFileToolsWrite, TYPED_FILE_TOOLS_REVISION_HEADER } from '$lib/server/typedFileToolsSettingsGuard'

/**
 * `PUT /api/agents/[id]` and `GET /api/agents/[id]` on the default lane's Redis fake (the twin of
 * `redis.updateAgent`'s by-path script, BL-768).
 */

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

// Default read twins only; the global fake deliberately exposes no generic EVAL.
vi.mock('$lib/server/modelSelectionGuard', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/modelSelectionGuard')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  // SA-139 R5: the CLI selection read (`includeCli`) went with the Claude Code CLI Subagent.
  return { ...actual, readModelSelectionSnapshot: async (_client: unknown, id: string, kind: 'agent' | 'subagent', lifecycle: any, extraPaths: readonly string[] = []) => {
    const { readModelSelectionSnapshotTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
    const { captureSettingsLifecycle } = await import('$lib/server/services/appActions/settings/lifecycle')
    const targetLifecycle = lifecycle ?? captureSettingsLifecycle([`${kind}:${id}`])
    const row = await redis.json.get(`${kind}:${id}`) as Record<string, any> | null
    return readModelSelectionSnapshotTwin(id, kind, row, targetLifecycle, extraPaths)
  } }
})
vi.mock('$lib/server/configuredTtsGuard', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/configuredTtsGuard')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  return { ...actual, readConfiguredTtsSnapshot: async (_client: unknown, id: string, lifecycle: any) => {
    const { agentTypeSnapshotOf } = await import('$lib/test-utils/agentUpdateScriptTwin')
    const record = await redis.json.get(`agent:${id}`) as Record<string, unknown>
    return actual.configuredTtsSnapshotFromDetail(id, record, actual.CONFIGURED_TTS_READ_PATHS.map(path => agentTypeSnapshotOf(record, [path])), lifecycle)
  } }
})

useRedisTestServer()

const USER = 'user-agent-update-route'
const AGENT = 'ssmod_route_agent'
useSendHandlerFixture({ sessionIds: () => [], rawSessionRead: false })

const WORK_MODE = {
  bashAccessMode: 'plan',
  bashNeverAllowList: ['rm -rf *'],
  executionBackend: 'apple_container',
  typedFileToolsEnabled: false,
  artifactRuntimeEnabled: true
}

const { GET, PUT } = await import('./+server')

async function put(body: Record<string, unknown>) {
  // Ordinary modern model senders carry their original shown base. Explicit own
  // expectedModelSelection (including undefined) lets refusal cases omit it deliberately.
  if (namesModelSelection('agent', body) && !Object.hasOwn(body, 'expectedModelSelection')) {
    if (process.env.VITEST_USE_REAL_REDIS === 'true') {
      const { readModelSelectionSnapshot } = await import('$lib/server/modelSelectionGuard')
      body = { ...body, expectedModelSelection: (await redis.execute(client => readModelSelectionSnapshot(client, AGENT, 'agent'))).revision }
    } else {
      const { readModelSelectionSnapshotTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
      body = { ...body, expectedModelSelection: readModelSelectionSnapshotTwin(AGENT, 'agent', await stored()).revision }
    }
  }
  if (namesTypedFileToolsWrite(body) && !Object.hasOwn(body, 'expectedTypedFileTools')) {
    const shown = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    const expected = shown.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER)
    if (!shown.ok || !expected) throw new Error('The route fixture needs the actual shown Typed File Tools base.')
    body = { ...body, expectedTypedFileTools: expected }
  }
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
  // The real population/reference owner requires the fixture preset and its user membership.
  for (const id of ['preset-a', 'preset-b']) {
    await redis.json.set(`model:${id}`, '$', { id, modelName: 'Fixture', modelId: 'fixture-model',
      provider: 'openai', connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, settings: {} })
    await redis.sAdd(`user:${USER}:models`, id)
  }
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

describe('BL-1702 Primary route read-only metadata', () => {
  afterEach(() => vi.restoreAllMocks())

  it('BL-1702 strips attempted metadata changes before the lower writer while saving ordinary fields', async () => {
    const before = await stored()
    const writer = vi.spyOn(redis, 'updateAgent')
    expect((await put({ id: 'replacement-id', user_id: 'replacement-owner', created_at: '2099-01-01T00:00:00.000Z',
      displayName: 'Allowed route rename' })).status).toBe(200)
    const updates = writer.mock.calls.at(-1)![1]
    for (const field of ['id', 'user_id', 'created_at']) expect(updates).not.toHaveProperty(field)
    expect(await stored()).toMatchObject({ id: before.id, user_id: before.user_id, created_at: before.created_at,
      displayName: 'Allowed route rename' })
    expect(await redis.exists('agent:replacement-id')).toBe(false)
  })
  it('BL-1702 accepts an unchanged full-DTO metadata echo without forwarding it as writable fields', async () => {
    const before = await stored()
    const writer = vi.spyOn(redis, 'updateAgent')
    expect((await put({ ...before, displayName: 'Full DTO rename' })).status).toBe(200)
    const updates = writer.mock.calls.at(-1)![1]
    for (const field of ['id', 'user_id', 'created_at']) expect(updates).not.toHaveProperty(field)
    expect(await stored()).toMatchObject({ id: before.id, user_id: before.user_id, created_at: before.created_at,
      displayName: 'Full DTO rename' })
  })
})

describe('provider-settings invalidation (BL-1876)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('publishes the value-free family after the API tool switch is saved', async () => {
    let savedAtPublication: unknown
    const publish = vi.spyOn(ssePublisher, 'publishUserEvent').mockImplementation(async (_userId, event) => {
      if (event.family === 'provider-settings') savedAtPublication = (await stored()).provider_specific_settings.nativeTools.batshitToolsEnabled
    })
    expect((await put({ provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } })).status).toBe(200)
    expect(publish).toHaveBeenCalledWith(USER, { type: 'agent_settings_changed', agentId: AGENT, family: 'provider-settings' })
    await vi.waitFor(() => expect(savedAtPublication).toBe(false))
  })

  it('does not announce unrelated fields or a refused provider save', async () => {
    const publish = vi.spyOn(ssePublisher, 'publishUserEvent').mockResolvedValue(undefined)
    expect((await put({ displayName: 'Another name' })).status).toBe(200)
    expect((await put({ provider_specific_settings: [] })).status).toBe(400)
    expect(publish.mock.calls.filter(([, event]) => event.family === 'provider-settings')).toEqual([])
  })
})

describe('PUT /api/agents/[id] provider settings (BL-768)', () => {
  it('requires the actual shown tool-choice base before saving a named choice', async () => {
    const before = await stored()
    expect((await put({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } }, expectedTypedFileTools: undefined })).status).toBe(400)
    expect(await stored()).toEqual(before)
  })
  it('refuses a retired global tool option without changing the stored agent', async () => {
    const before = await stored()
    const result = await put({ provider_specific_settings: { nativeTools: { webSearchProvider: 'exa' } } })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('webSearchProvider is now a global tool option in Admin')
    expect(await stored()).toEqual(before)
  })
  it('requires an original API model base rather than silently saving an older client payload', async () => {
    const before = await stored()
    expect(await put({ primary_model_preset_id: 'preset-b', expectedModelSelection: undefined }))
      .toMatchObject({ status: 400, body: { code: 'model_selection_base_required' } })
    expect(await stored()).toEqual(before)
  })
  it('preserves an unchanged full-record policy echo, but refuses an authority edit outside Access', async () => {
    const policy = { generation: 2, policy: { enabled: true, fixture: 'server-owned' } }
    await redis.json.set(`agent:${AGENT}`, '$.app_action_policy', policy as never)
    const full = await stored()
    expect((await put({ ...full, displayName: 'Ordinary human save', app_action_policy: { policy: policy.policy, generation: 2 } })).status).toBe(200)
    expect((await stored()).app_action_policy).toEqual(policy)
    expect((await put({ app_action_policy: { ...policy, generation: 3 } })).status).toBe(400)
    expect((await stored()).app_action_policy).toEqual(policy)
  })
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

describe('A10 original human reply-voice base', () => {
  async function shownVoice() {
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(200)
    return response.headers.get(CONFIGURED_TTS_REVISION_HEADER)
  }
  it('returns the atomic original tuple header and consumes it without persisting the request hint', async () => {
    await redis.json.set('model:preset-a', '$', { id: 'preset-a', provider: 'openai', modelId: 'ordinary' })
    await redis.sAdd(`user:${USER}:models`, 'preset-a')
    const original = await shownVoice()
    expect(original).toMatch(/^sha256:[a-f0-9]{64}$/)
    const voice_profile = { tts: { providerId: 'browser', voiceId: 'system' }, stt: { providerId: 'browser' } }
    expect((await put({ voice_profile, expectedTtsSelection: original })).status).toBe(200)
    expect((await stored()).voice_profile).toEqual(voice_profile)
    expect(await stored()).not.toHaveProperty('expectedTtsSelection')
    expect(await shownVoice()).not.toBe(original)
  })
  it('refuses a missing or stale voice base before a sibling name change', async () => {
    const original = await shownVoice()
    expect(await put({ displayName: 'Must not save', voice_profile: null })).toMatchObject({ status: 400, body: { code: 'tts_selection_base_required' } })
    await redis.json.set(`agent:${AGENT}`, '$.voice_profile', { tts: { providerId: 'browser', voiceId: 'system' } })
    expect(await put({ displayName: 'Must not save', voice_profile: null, expectedTtsSelection: original })).toMatchObject({ status: 409, body: { code: 'tts_selection_changed' } })
    expect((await stored()).displayName).toBe('Route probe')
    expect((await stored()).voice_profile).toEqual({ tts: { providerId: 'browser', voiceId: 'system' } })
  })
  it.each([false, true])('uses the resulting combined model/voice lock on the default owner (initially locked: %s)', async locked => {
    for (const [id, modelId] of [['preset-a', locked ? 'gpt-realtime-2' : 'ordinary'], ['preset-b', locked ? 'ordinary' : 'gpt-realtime-2']]) {
      await redis.json.set(`model:${id}`, '$', { id, modelName: id, provider: 'openai', modelId })
      await redis.sAdd(`user:${USER}:models`, id)
    }
    await redis.json.set(`agent:${AGENT}`, '$.voice_profile', { tts: { providerId: 'google', voiceId: 'Kore' } })
    const original = await shownVoice()
    const result = await put({ primary_model_preset_id: 'preset-b', primary_model_provider: 'openai', primary_model_name: locked ? 'ordinary' : 'gpt-realtime-2',
      voice_profile: { tts: { providerId: 'browser' } }, expectedTtsSelection: original })
    expect(result.status).toBe(locked ? 200 : 409)
    if (!locked) expect(result.body.code).toBe('tts_speech_to_speech_locked')
    expect((await stored()).primary_model_preset_id).toBe(locked ? 'preset-b' : 'preset-a')
    expect((await stored()).voice_profile.tts.providerId).toBe(locked ? 'browser' : 'google')
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

  it('the route normalizes a provider-block clear to model-key clears and keeps explicit tool choices', async () => {
    // The route's BL-514 patch builder turns null into finite model-key clears;
    // it never passes a provider ancestor clear to the lower writer.
    expect((await put({ primary_model_preset_id: null, provider_specific_settings: null })).status).toBe(200)
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: WORK_MODE })
  })

  it('saves a Work-mode change, refuses an ancestor clear, and supports individual tool-key clears', async () => {
    const agentMode = { ...WORK_MODE, bashAccessMode: 'agent' }
    await put({ provider_specific_settings: { temperature: 1.2, customKnob: 5, nativeTools: agentMode } })
    expect((await stored()).provider_specific_settings.nativeTools).toEqual(agentMode)

    const before = await stored()
    expect((await put({ provider_specific_settings: { temperature: 1.2, customKnob: 5, nativeTools: null } })).status).toBe(400)
    expect(await stored()).toEqual(before)
    expect((await put({ provider_specific_settings: { nativeTools: { bashAccessMode: null, bashNeverAllowList: null, executionBackend: null } } })).status).toBe(200)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 1.2, customKnob: 5,
      nativeTools: { typedFileToolsEnabled: false, artifactRuntimeEnabled: true } })
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

describe('GET /api/agents/[id] legacy type canonicalization (BL-1637)', () => {
  afterEach(() => vi.restoreAllMocks())
  async function get() {
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    return { status: response.status, revision: response.headers.get(MODEL_SELECTION_REVISION_HEADER), body: await response.json() }
  }
  // SA-139 R4: the CLI reasoning pair header left with the CLI Primary; the model selection
  // header is the base this read pairs with the row.
  it('refuses replacement during awaited legacy canonicalization instead of pairing a new header with the old row', async () => {
    await redis.json.set(`agent:${AGENT}`, '$.mode', 'vercel-native' as never)
    const original = redis.updateAgent.bind(redis)
    vi.spyOn(redis, 'updateAgent').mockImplementationOnce(async (...args) => {
      await original(...args)
      await withSettingsRecordReplacement(`agent:${AGENT}`, async () => {})
    })
    const answer = await get()
    expect(answer.status).toBe(409)
    expect(answer.revision).toBeNull()
    expect(answer.body).not.toHaveProperty('displayName')
  })
})

/**
 * SA-139 R4 (D14): `cli` is a retired stored Primary type. A create cannot ask for it and an API
 * agent cannot name a Claude Code CLI preset; a leftover `cli` record stays readable (Settings
 * shows it so it can be deleted) and refuses every save. The delete has no type gate at all
 * (`DELETE` in `./+server.ts`), and its owners are proven in `agent-delete-route.test.ts`.
 */
describe('SA-139 R4: the Claude Code CLI Primary is a retired type', () => {
  const CLAUDE_RETIRED = {
    code: 'primary_agent_type_retired',
    error: 'The Claude Code CLI lane was removed from Batshit.',
    details: 'This agent ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new agent and pick a Claude plan model.'
  }
  // SA-139 R5 removed the Claude Code CLI Subagent, the last user of these presets.
  const CLI_PRESET_REFUSAL = 'Claude Code CLI presets were removed from Batshit. Pick another model, for example a Claude plan model.'
  const NEW_AGENT = 'ssmod_route_new_agent'
  async function create(body: Record<string, unknown>) {
    const { POST } = await import('../+server')
    const response = await POST({
      request: new Request('http://localhost/api/agents', { method: 'POST', body: JSON.stringify({ id: NEW_AGENT, displayName: 'New probe', ...body }) }),
      locals: { user: { id: USER } }
    } as any)
    return { status: response.status, body: await response.json() }
  }
  async function leftover(fields: Record<string, unknown> = {}) {
    await redis.json.set(`agent:${AGENT}`, '$', { ...await stored(), agentType: 'cli', primary_model_provider: 'claude-cli',
      primary_model_name: 'claude-cli', primary_model_connection: { type: 'direct', id: 'claude-cli', service: 'claude-cli' }, ...fields })
    return stored()
  }

  it('a create that asks for the cli type is refused 409 primary_agent_type_retired, and nothing is created', async () => {
    expect(await create({ agentType: 'cli' })).toEqual({ status: 409, body: CLAUDE_RETIRED })
    expect(await create({ agentType: 'cli', primary_model_provider: 'claude-cli' })).toEqual({ status: 409, body: CLAUDE_RETIRED })
    // A Codex-named cli create gets the Codex sentence under the same code.
    expect(await create({ agentType: 'cli', primary_model_provider: 'openai-codex', primary_model_name: 'codex' }))
      .toMatchObject({ status: 409, body: { code: 'primary_agent_type_retired', error: 'Codex CLI agents were removed from Batshit.' } })
    expect(await redis.get(`agent:${NEW_AGENT}`)).toBeNull()
  })

  it.each([
    ['provider', { primary_model_provider: 'claude-cli' }],
    ['model', { primary_model_name: 'claude-cli' }],
    ['connection id', { primary_model_connection: { type: 'direct', id: 'claude-cli' } }],
    ['connection service', { primary_model_connection: { type: 'direct', service: 'claude-cli' } }]
  ])('an API create that names a Claude Code CLI %s is refused 400, and nothing is created', async (_name, fields) => {
    expect(await create({ agentType: 'api', ...fields })).toEqual({ status: 400, body: { error: CLI_PRESET_REFUSAL } })
    expect(await create(fields)).toEqual({ status: 400, body: { error: CLI_PRESET_REFUSAL } })
    expect(await redis.get(`agent:${NEW_AGENT}`)).toBeNull()
  })

  it('a leftover cli record still answers GET, with no model, instruction, Auto Compact or Voice base', async () => {
    const record = await leftover()
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: AGENT, agentType: 'cli', displayName: record.displayName })
    expect(response.headers.get(MODEL_SELECTION_REVISION_HEADER)).toBeNull()
    expect(response.headers.get(CONFIGURED_TTS_REVISION_HEADER)).toBeNull()
    expect(await stored()).toEqual(record)
  })

  it('a legacy record whose fields name the cli lane canonicalizes to cli on GET and is refused on PUT', async () => {
    await redis.json.set(`agent:${AGENT}`, '$.agentType', 'batshit' as never)
    await redis.json.set(`agent:${AGENT}`, '$.batshitMode', 'cli' as never)
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ agentType: 'cli' })
    expect(body).not.toHaveProperty('batshitMode')
    const before = await stored()
    expect(await put({ displayName: 'Must not save' })).toEqual({ status: 409, body: CLAUDE_RETIRED })
    expect(await stored()).toEqual(before)
  })

  it.each([
    ['a rename', { displayName: 'Must not save' }],
    ['a change back to API', { agentType: 'api', displayName: 'Must not save' }],
    ['a model pick', { primary_model_preset_id: 'preset-a', primary_model_provider: 'openai', primary_model_name: 'gpt-6',
      primary_model_connection: { type: 'direct', id: 'openai', service: 'openai' } }],
    ['an old CLI reasoning save', { show_reasoning: false, preserve_reasoning: false, expectedCliReasoning: 'sha256:any' }]
  ])('a leftover cli record refuses %s with 409 primary_agent_type_retired, and nothing is written', async (_name, body) => {
    const before = await leftover({ claude_settings: { permissionMode: 'plan' } })
    expect(await put(body)).toEqual({ status: 409, body: CLAUDE_RETIRED })
    expect(await stored()).toEqual(before)
  })

  it('a live API agent cannot ask for the cli type: 400 primary_agent_type_invalid, and nothing is written', async () => {
    const before = await stored()
    expect(await put({ agentType: 'cli', displayName: 'Must not save' }))
      .toMatchObject({ status: 400, body: { code: 'primary_agent_type_invalid' } })
    expect(await stored()).toEqual(before)
  })
})


describe('human Primary Tool Settings detail/header and whole-array save contract', () => {
  async function original() {
    const response = await GET({ params: { id: AGENT }, locals: { user: { id: USER } } } as any)
    expect(response.status).toBe(200)
    return { record: await response.json(), base: readMcpSettingsRevisions(response.headers.get(MCP_SETTINGS_REVISION_HEADER))! }
  }
  it('requires original requested bases, strips metadata and advances only the actual saved leaves', async () => {
    await redis.json.set(`agent:${AGENT}`, '$.defaultMCPGateways', ['A'])
    const before = await original()
    expect(before.record.defaultMCPGateways).toEqual(['A'])
    expect(before.base.defaultMCPGateways).toMatch(/^sha256:/)
    const missing = await put({ defaultMCPGateways: ['C'], displayName: 'Must not land' })
    expect(missing).toMatchObject({ status: 400, body: { code: 'mcp_settings_base_required' } })
    expect((await stored()).displayName).toBe('Route probe')
    const saved = await put({ defaultMCPGateways: ['A','C'], expectedMcpSettings: { defaultMCPGateways: before.base.defaultMCPGateways } })
    expect(saved).toMatchObject({ status: 200, body: { mcpSettings: { values: { defaultMCPGateways: ['A','C'] } } } })
    expect(Object.keys(saved.body.mcpSettings.revisions)).toEqual(['defaultMCPGateways'])
    expect(saved.body.mcpSettings.revisions.defaultMCPGateways).not.toBe(before.base.defaultMCPGateways)
    expect(await stored()).not.toHaveProperty('expectedMcpSettings')
  })
  it('a stale non-MCP-only custom row cannot erase a newly saved MCP row or its zero/false sibling', async () => {
    const initial = [{ tool_name: 'skill_read', buffer_size: 0, auto_zip: false }]
    await redis.json.set(`agent:${AGENT}`, '$.custom_tool_settings', initial)
    const shown = await original()
    const current = [...initial, { tool_name: 'C_remote_write', zip_threshold: 0 }]
    await redis.json.set(`agent:${AGENT}`, '$.custom_tool_settings', current)
    const beforeWrite = await stored()
    expect(await put({ custom_tool_settings: [{ ...initial[0], buffer_size: 9 }], expectedMcpSettings: { custom_tool_settings: shown.base.custom_tool_settings } }))
      .toMatchObject({ status: 409, body: { code: 'mcp_settings_changed' } })
    expect(await stored()).toEqual(beforeWrite)
  })
})

describe('SA-137 P4: the agent Live File Reads override', () => {
  it('stores true and false, removes the field on null, and refuses any other value without writing', async () => {
    expect((await put({ live_file_reads: true })).status).toBe(200)
    expect((await stored()).live_file_reads).toBe(true)
    expect((await put({ live_file_reads: false })).status).toBe(200)
    expect((await stored()).live_file_reads).toBe(false)
    const refused = await put({ live_file_reads: 'yes' })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('"Refreshed File Reads" must be true or false.')
    expect((await stored()).live_file_reads).toBe(false)
    expect((await put({ live_file_reads: null })).status).toBe(200)
    expect(await stored()).not.toHaveProperty('live_file_reads')
  })
})

describe('SA-139 R1: a save that names the removed Codex CLI', () => {
  const RETIRED = { status: 409, body: { code: 'codex_cli_retired', error: 'Codex CLI agents were removed from Batshit.' } }

  it.each([
    ['provider', { primary_model_provider: 'openai-codex', primary_model_name: 'codex' }],
    ['short provider', { primary_model_provider: 'codex' }],
    ['connection', { primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'codex-cli' } }]
  ])('is refused 409 codex_cli_retired by its %s, and nothing is written', async (_name, fields) => {
    const before = await stored()
    // SA-139 R4: an API agent's save names the Codex model alone (asking for `cli` is its own 400).
    expect(await put({ ...fields, displayName: 'Must not save' })).toMatchObject(RETIRED)
    expect(await stored()).toEqual(before)
  })

  it('never stores a body codex_settings block, while the rest of the save lands', async () => {
    expect((await put({ displayName: 'Plain rename', codex_settings: { permissionMode: 'chat', model: 'gpt-6-sol' } })).status).toBe(200)
    const record = await stored()
    expect(record.displayName).toBe('Plain rename')
    expect(record).not.toHaveProperty('codex_settings')
  })

  // SA-139 R4 (D14): a leftover `cli` record refuses every save now (only its delete works); a
  // Codex-named one gets the Codex sentence under the shared code, and its record is untouched.
  it('refuses a leftover Codex agent\'s rename that names no model, without migrating its record', async () => {
    const leftover = { permissionMode: 'chat', model: 'gpt-6-sol' }
    await redis.json.set(`agent:${AGENT}`, '$', { ...await stored(), agentType: 'cli', primary_model_provider: 'openai-codex',
      primary_model_name: 'codex', primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'codex-cli' },
      codex_settings: leftover })
    const before = await stored()
    expect(await put({ displayName: 'Leftover renamed', codex_settings: { permissionMode: 'agent_full' } })).toMatchObject({
      status: 409, body: { code: 'primary_agent_type_retired', error: 'Codex CLI agents were removed from Batshit.' }
    })
    expect(await stored()).toEqual(before)
  })

  it('saves an API agent on an OpenAI model whose id contains "codex"', async () => {
    await redis.json.set('model:preset-gpt-codex', '$', { id: 'preset-gpt-codex', modelName: 'GPT-5 Codex', provider: 'openai', modelId: 'gpt-5-codex' })
    await redis.sAdd(`user:${USER}:models`, 'preset-gpt-codex')
    expect((await put({ primary_model_preset_id: 'preset-gpt-codex', primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex' })).status).toBe(200)
    expect(await stored()).toMatchObject({ agentType: 'api', primary_model_preset_id: 'preset-gpt-codex', primary_model_name: 'gpt-5-codex' })
  })
})

describe('SA-139 (Faye S13): an agent saved onto the Claude plan keeps nothing admission refuses', () => {
  const plan = { id: 'claude-plan:local', type: 'direct', service: 'claude-plan' }
  const paidCopies = { primary_model_temperature: 0.4, primary_model_max_tokens: 4096 }
  const fallbacks = async () => (await import('$lib/utils/modelPresetRuntime')).resolveAgentModelFallbacks({ preset: null, agent: await stored() })
  /** What a run's admission checks for this raw pick: the settings block and the sampling copies (as send-routed hands them). */
  const admissionPasses = async () => {
    const { assertClaudePlanRunSettings } = await import('$lib/server/services/claudePlanAdmission')
    const after = await stored()
    const sampling = Object.fromEntries(Object.entries((await fallbacks()) ?? {}).filter(([, value]) => !(Array.isArray(value) && value.length === 0)))
    return assertClaudePlanRunSettings(after.provider_specific_settings, after.primary_model_name, sampling)
  }
  beforeEach(async () => {
    // A raw (no-preset) paid pick that kept its sampling copies.
    await redis.json.set(`agent:${AGENT}`, '$', { ...await stored(), primary_model_preset_id: '', primary_model_provider: 'openai', primary_model_name: 'gpt-6',
      primary_model_connection: { id: 'openai', type: 'direct', service: 'openai' }, ...paidCopies })
  })

  it('a raw pick of the Claude plan removes the stored copies and the block\'s other model keys, and the answer says so in one sentence', async () => {
    // The paid pick's own settings block (temperature, a provider knob) is refused at every run too.
    await expect(admissionPasses()).rejects.toThrow(/does not support/)
    const result = await put({ primary_model_preset_id: '', primary_model_connection: plan, primary_model_provider: 'anthropic', primary_model_name: 'claude-haiku-5-5' })
    expect(result.status).toBe(200)
    expect(result.body.samplingCleared).toEqual({
      fields: ['primary_model_temperature', 'primary_model_max_tokens', 'provider_specific_settings.temperature', 'provider_specific_settings.customKnob'],
      notice: 'The Claude plan connection cannot take the agent\'s temperature, max tokens, model setting "temperature" and model setting "customKnob", so this save removed them.' })
    const after = await stored()
    expect(after.primary_model_connection).toEqual(plan)
    expect(after).not.toHaveProperty('primary_model_temperature')
    expect(after).not.toHaveProperty('primary_model_max_tokens')
    // The agent's own keys stay (the Work mode); nothing is left for admission to refuse.
    expect(after.provider_specific_settings).toEqual({ nativeTools: WORK_MODE })
    await expect(admissionPasses()).resolves.toEqual({ effort: null, alwaysThinking: null })
  })

  it('a raw pick that sends the old copies along clears them too', async () => {
    const result = await put({ primary_model_preset_id: '', primary_model_connection: plan, primary_model_provider: 'anthropic', primary_model_name: 'claude-haiku-5-5', ...paidCopies })
    expect(result.status).toBe(200)
    expect(result.body.samplingCleared?.fields).toEqual(['primary_model_temperature', 'primary_model_max_tokens', 'provider_specific_settings.temperature', 'provider_specific_settings.customKnob'])
    await expect(admissionPasses()).resolves.toEqual({ effort: null, alwaysThinking: null })
  })

  it('a raw pick that sends its own settings block keeps the keys the connection takes and removes the rest', async () => {
    const result = await put({ primary_model_preset_id: '', primary_model_connection: plan, primary_model_provider: 'anthropic', primary_model_name: 'claude-haiku-5-5',
      provider_specific_settings: { anthropicEffort: 'high', temperature: 0.9 } })
    expect(result.status).toBe(200)
    expect(result.body.samplingCleared?.fields).toEqual(['primary_model_temperature', 'primary_model_max_tokens', 'provider_specific_settings.temperature'])
    expect((await stored()).provider_specific_settings).toEqual({ anthropicEffort: 'high', nativeTools: WORK_MODE })
    await expect(admissionPasses()).resolves.toEqual({ effort: 'high', alwaysThinking: null })
  })

  it('an empty list a paid preset left in the block (admission refuses it) is removed too', async () => {
    await redis.json.set(`agent:${AGENT}`, '$.provider_specific_settings', { nativeTools: WORK_MODE, stopSequences: [] })
    await expect(admissionPasses()).rejects.toThrow(/does not support stopSequences/)
    const result = await put({ primary_model_preset_id: '', primary_model_connection: plan, primary_model_provider: 'anthropic', primary_model_name: 'claude-haiku-5-5' })
    expect(result.status).toBe(200)
    expect(result.body.samplingCleared?.fields).toContain('provider_specific_settings.stopSequences')
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: WORK_MODE })
    await expect(admissionPasses()).resolves.toEqual({ effort: null, alwaysThinking: null })
  })

  it('the pickers\' preset pick of a Claude plan preset already clears them (BL-515), so its answer has no note', async () => {
    const { normaliseClaudePlanPreset } = await import('$lib/server/services/claudePlanPreset')
    const { buildPickedPresetSelection } = await import('$lib/utils/modelPresetPick')
    const preset = normaliseClaudePlanPreset({ id: 'preset-plan', modelName: 'Haiku on the plan', provider: 'anthropic', modelId: 'claude-haiku-5-5', connection: plan, settings: {} } as any)
    await redis.json.set('model:preset-plan', '$', preset as any)
    await redis.sAdd(`user:${USER}:models`, 'preset-plan')
    const result = await put(buildPickedPresetSelection(preset) as any)
    expect(result.status).toBe(200)
    expect(result.body.samplingCleared).toBeUndefined()
    const after = await stored()
    expect(after.primary_model_preset_id).toBe('preset-plan')
    expect(after).not.toHaveProperty('primary_model_temperature')
    expect(after).not.toHaveProperty('primary_model_max_tokens')
  })

  it('a save that does not name the model leaves the copies alone (only a model save clears)', async () => {
    await redis.json.set(`agent:${AGENT}`, '$.primary_model_connection', plan)
    const result = await put({ displayName: 'Renamed only' })
    expect(result.status).toBe(200)
    expect(result.body.samplingCleared).toBeUndefined()
    expect(await stored()).toMatchObject(paidCopies)
  })
})

