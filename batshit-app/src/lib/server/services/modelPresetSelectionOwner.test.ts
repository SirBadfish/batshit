import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ records: new Map<string, any>(), sets: new Map<string, Set<string>>(), keyState: vi.fn(), local: vi.fn(), custom: vi.fn(), catalog: vi.fn(), accounts: vi.fn(), paused: vi.fn(), claudeReadiness: vi.fn(),
  beforeLeaf: undefined as undefined | (() => Promise<void>), answer: undefined as string | undefined, mutations: 0, reads: 0, rawOverride: undefined as string | undefined }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
const raw = (key: string) => f.rawOverride ?? (f.records.has(key) ? JSON.stringify([f.records.get(key)]) : '')
vi.mock('$lib/server/redis', () => ({ redis: { execute: async (fn: (client: any) => unknown) => fn({
  eval: async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
    if (keys.length === 1) { const ids = [...(f.sets.get(keys[0]) ?? [])].sort().filter(id => !args[0] || id.includes(args[0]) || f.records.get(`model:${id}`)?.modelName?.toLowerCase().includes(args[0])); return [f.sets.get(keys[0])?.size ?? 0, ids.length, ids.slice(Number(args[1]), Number(args[1]) + Number(args[2]))] }
    if (args.length <= 2) { f.reads++; if (args[1] && Buffer.byteLength(raw(keys[0]), 'utf8') > Number(args[1])) return ['TOO_LARGE']; return ['OK', f.sets.get(keys[1])?.has(args[0]) ? '1' : '0', raw(keys[0])] }
    f.mutations++; if (f.answer === 'THROW') throw new Error('answer lost'); if (f.answer) return f.answer
    if (!f.sets.get(keys[1])?.has(args[0])) return 'MISSING'
    if (raw(keys[0]) !== args[1]) return 'CONFLICT'
    f.records.delete(keys[0]); f.sets.get(keys[1])?.delete(args[0]); return 'DELETED'
  }, sendCommand: async ([, key, path]: string[]) => { const hook = f.beforeLeaf; f.beforeLeaf = undefined; if (hook) await hook(); if (!f.records.has(key)) return null; const value = f.records.get(key)?.[path.slice(2)]; return JSON.stringify(value === undefined ? [] : [value]) }
}), json: { getRaw: async (key: string, path: string) => { const match = path.match(/^\$\.models\[(\d+)\]$/); if (match) { const row = f.records.get(key)?.models?.[Number(match[1])]; return row ? JSON.stringify([row]) : null }; return raw(key) || null } } } }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { readStoredState: f.keyState, storedKeyName: (service: string, user: string) => `api_keys:${user}:${service}` } }))
vi.mock('./providers', () => ({ PROVIDER_KEY_CONFIG: [{ id: 'openai', envVar: 'OPENAI_API_KEY' }] }))
vi.mock('./localAiServers', () => ({ readStoredLocalAiServer: f.local }))
vi.mock('./customProviders', () => ({ readStoredCustomProvider: f.custom }))
vi.mock('./vercelModelCatalog', () => ({ readCatalogCacheSnapshot: f.catalog }))
vi.mock('./chatgptPlanCatalog', () => ({ chatgptPlanConnectionOptions: f.accounts }))
vi.mock('./claudePlanAdmission', async original => ({ ...await original<typeof import('./claudePlanAdmission')>(), claudePlanConfigurationReadiness: f.claudeReadiness }))
vi.mock('./pausedPlans', () => ({ pausedPlanStatuses: f.paused, PAUSED_PLANS_DEV_SWITCH_KEY: 'batshit:dev:paused_plans' }))
const owner = await import('./modelPresetSelectionOwner')
const { CODEX_CLI_RETIRED_ERROR, CLAUDE_CLI_PRESET_REFUSAL } = await import('$lib/utils/cliRuntimeIdentity')
const life = await import('./appActions/settings/lifecycle')
const user = 'selection-owner'; let sequence = 0; let id: string
function seed(extra: Record<string, any> = {}) { const preset = { id, modelName: 'Configured chat', provider: 'openai', modelId: 'fixture', effectiveModelId: 'fixture', purpose: 'chat', settings: { temperature: 0, custom: false }, pricing: {}, connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, ...extra }; f.records.set(`model:${id}`, preset); f.sets.set(`user:${user}:models`, new Set([id])); return preset }
beforeEach(() => { id = `preset_${++sequence}`; f.records.clear(); f.sets.clear(); f.mutations = 0; f.reads = 0; f.beforeLeaf = undefined; f.answer = undefined; f.rawOverride = undefined
  f.keyState.mockReset().mockResolvedValue({ raw: '[{"encrypted":"private-ciphertext"}]', state: 'readable', value: 'private-key-value' }); f.paused.mockReset().mockResolvedValue({}); f.local.mockReset(); f.custom.mockReset(); f.accounts.mockReset().mockReturnValue([]); f.catalog.mockReset(); f.claudeReadiness.mockReset() })
describe('owned nonexecuting preset selection snapshot', () => {
  it.each(['explicit', 'settings', 'inferred'] as const)('admits supported %s voice metadata only for Primary configuration, retaining the actual source cut', async location => {
    const voiceSession = { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', supportStatus: 'supported', locksVoiceModeSettings: true }
    seed({ modelId: 'gpt-realtime-2', ...(location === 'explicit' ? { voiceSession } : location === 'settings' ? { settings: { temperature: 0, flag: false, voiceSession } } : {}) })
    const source = await owner.readOwnedModelPresetSelection(user, id, 'api-primary')
    expect(source.choice.voiceSession).toEqual({ runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', adapterId: 'livekit-openai-realtime', supportStatus: 'supported', locksVoiceModeSettings: true })
    const cut = source.checks.find(check => check.key === `model:${id}`)!
    expect(cut.paths).toContainEqual(['$.modelId', '["gpt-realtime-2"]'])
    expect(cut.paths).toContainEqual(['$.voiceSession', JSON.stringify(location === 'explicit' ? [voiceSession] : [])])
    expect(cut.paths).toContainEqual(['$.settings', JSON.stringify([f.records.get(`model:${id}`).settings])])
    await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('supported only for Primary configuration')
    expect(f.mutations).toBe(0); expect(f.accounts).not.toHaveBeenCalled(); expect(f.catalog).not.toHaveBeenCalled()
    expect(JSON.stringify(source.choice)).not.toMatch(/private-key|ciphertext|https?:|headers/)
  })
  it.each(['planned', 'watchlist', 'malformed', 'malformed-lock', 'wrong-adapter'] as const)('refuses %s voice declarations instead of promoting inference to support', async invalid => {
    seed({ modelId: 'gpt-realtime-2', voiceSession: invalid === 'malformed' ? 'broken' : { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai',
      supportStatus: invalid === 'planned' || invalid === 'watchlist' ? invalid : 'supported', ...(invalid === 'wrong-adapter' ? { adapterId: 'not-an-installed-adapter' } : {}),
      ...(invalid === 'malformed-lock' ? { locksVoiceModeSettings: 'not-a-boolean' } : {}) } })
    await expect(owner.readOwnedModelPresetSelection(user, id, 'api-primary')).rejects.toBeInstanceOf(owner.ModelPresetUnavailableError)
    expect(f.mutations).toBe(0)
  })
  // SA-139 R5: the Claude Code CLI Subagent, the last user of a Claude Code CLI preset, was removed,
  // and with it the CLI selection mode. A leftover preset is refused readably in every selection,
  // like a Codex CLI one, before any key, catalogue or readiness read.
  it.each([
    ['by provider and connection', { provider: 'anthropic-claude-cli', modelId: 'claude-cli', connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli' } }],
    ['by provider alone', { provider: 'claude-cli', modelId: 'sonnet', connection: { type: 'direct', service: 'anthropic' } }],
    ['by connection id alone', { provider: 'anthropic', modelId: 'sonnet', connection: { id: 'claude-cli', type: 'direct', service: 'anthropic' } }]
  ] as const)('refuses a leftover Claude Code CLI preset %s in API and API Primary selection', async (_name, extra) => {
    seed(extra)
    for (const mode of ['api', 'api-primary'] as const) {
      const failure = await owner.readOwnedModelPresetSelection(user, id, mode).catch(error => error)
      expect(failure).toBeInstanceOf(owner.ModelPresetUnavailableError)
      expect(failure.message).toBe(CLAUDE_CLI_PRESET_REFUSAL)
    }
    for (const read of [f.keyState, f.local, f.custom, f.catalog, f.accounts, f.paused, f.claudeReadiness]) expect(read).not.toHaveBeenCalled()
    expect(f.mutations).toBe(0)
  })
  // SA-139 R1: a preset on the removed Codex CLI is refused with the retired message, and never
  // becomes Claude CLI or an API connection.
  it.each([
    ['a Codex CLI preset', { provider: 'openai-codex', modelId: 'codex-cli', connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex' } }],
    ['a Codex CLI connection without its provider', { provider: 'anthropic-claude-cli', connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex' } }],
    ['a codex provider with no connection id', { provider: 'openai-codex', connection: { type: 'direct', service: 'openai-codex' } }]
  ])('refuses %s as retired', async (_name, extra) => {
    seed(extra)
    const failure = await owner.readOwnedModelPresetSelection(user, id).catch(error => error)
    expect(failure).toBeInstanceOf(owner.ModelPresetUnavailableError)
    expect(failure.message).toContain(CODEX_CLI_RETIRED_ERROR)
    for (const read of [f.keyState, f.local, f.custom, f.catalog, f.accounts, f.paused]) expect(read).not.toHaveBeenCalled()
    expect(f.mutations).toBe(0)
  })
  it.each(['api', 'api-primary'] as const)('refuses an openai-codex service preset in %s selection as retired before any key read', async mode => {
    seed({ provider: 'openai-codex', modelId: 'codex-cli', connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex' } })
    const failure = await owner.readOwnedModelPresetSelection(user, id, mode).catch(error => error)
    expect(failure).toBeInstanceOf(owner.ModelPresetUnavailableError)
    expect(failure.message).toContain(CODEX_CLI_RETIRED_ERROR)
    for (const read of [f.keyState, f.local, f.custom, f.catalog, f.accounts, f.paused]) expect(read).not.toHaveBeenCalled()
  })
  it('keeps an API preset whose OpenAI model id contains "codex" an ordinary API selection', async () => {
    seed({ modelId: 'gpt-5-codex', effectiveModelId: 'gpt-5-codex' })
    f.catalog.mockResolvedValue({ kind: 'none', raw: '', payload: null })
    const result = await owner.readOwnedModelPresetSelection(user, id)
    expect(result.choice).toMatchObject({ id, available: true, connection: { id: 'direct:openai' } })
    expect(f.keyState).toHaveBeenCalledExactlyOnceWith('openai', user)
  })
  it('retains exact raw private proof, immutable zero/false settings and a safe choice', async () => { seed(); const result = await owner.readOwnedModelPresetSelection(user, id)
    expect(result.membership).toEqual({ key: `user:${user}:models`, member: id, present: true }); expect(result.checks).toContainEqual({ key: `api_keys:${user}:openai`, paths: [['$', '[{"encrypted":"private-ciphertext"}]']] })
    expect(result.preset.settings).toEqual({ temperature: 0, custom: false }); expect(Object.isFrozen(result.preset.settings)).toBe(true); expect(JSON.stringify(result.choice)).not.toMatch(/private-key|ciphertext|https?:|headers/)
    expect(result.choice).toMatchObject({ id, available: true, connection: { id: 'direct:openai' } }); expect(f.keyState).toHaveBeenCalledExactlyOnceWith('openai', user) })
  it('refuses foreign membership before reading keys', async () => { seed(); f.sets.clear(); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toMatchObject({ code: 'model_preset_unavailable' }); expect(f.keyState).not.toHaveBeenCalled() })
  it('distinguishes absent/unreadable keys and propagates transport failure', async () => { seed(); f.keyState.mockResolvedValueOnce({ raw: '', state: 'absent' }); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('API key under Settings'); f.keyState.mockResolvedValueOnce({ raw: '[{}]', state: 'unreadable' }); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('cannot be read'); f.keyState.mockRejectedValueOnce(new Error('storage unavailable')); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('storage unavailable') })
  it('requires an exact option and retains unavailable choices', async () => { seed({ connection: { id: 'direct:nonexistent', type: 'direct', service: 'openai' } }); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('resolved exactly'); const report = await owner.readModelPresetSelectionChoices(user); expect(report).toMatchObject({ total: 1, matching: 1, limit: 12, nextOffset: null, choices: [{ id, available: false, connection: null }] }) })
  it.each([{ purpose: 'visual' }, { connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex' } }, { voiceSession: { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', supportStatus: 'supported' } }])('excludes out-of-slice presets (%j)', async extra => { seed(extra); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toBeInstanceOf(owner.ModelPresetUnavailableError); expect(f.catalog).not.toHaveBeenCalled() })
  it('uses Local AI stored projection without probing', async () => { seed({ provider: 'ollama', connection: { id: 'direct:ollama', type: 'direct', service: 'ollama' } }); f.local.mockResolvedValue({ key: `local_provider:${user}:ollama`, raw: '[{"enabled":false}]', summary: { id: 'ollama', label: 'Ollama', enabled: false, baseUrl: 'http://private.invalid', openaiPath: '/v1' } }); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('Enable this runtime'); expect(f.keyState).toHaveBeenCalledExactlyOnceWith('ollama', user) })
  it('retains custom-provider ownership proof without reporting URL/header data', async () => {
    seed({ provider: 'custom_one', connection: { id: 'direct:custom_one', type: 'direct', service: 'custom_one' } })
    f.custom.mockResolvedValue({ key: `custom_provider:${user}:custom_one`, raw: '[{"headers":{"secret":"value"}}]', membership: { key: `user:${user}:custom_providers`, member: 'custom_one', present: true }, summary: { id: 'custom_one', label: 'Custom', apiKeyUsable: true, baseUrl: 'http://private.invalid', headers: { secret: 'value' } } })
    const result = await owner.readOwnedModelPresetSelection(user, id)
    expect(result.memberships).toHaveLength(2); expect(JSON.stringify(result.choice)).not.toMatch(/private.invalid|headers|secret|value/)
    expect(f.keyState).not.toHaveBeenCalled()
  })
  it('uses local account readiness only and requires the exact account connection', async () => {
    seed({ connection: { id: 'chatgpt-plan:account', type: 'direct', service: 'chatgpt-plan' } })
    f.accounts.mockReturnValue([{ id: 'chatgpt-plan:account', transport: 'direct', service: 'chatgpt-plan', status: 'ready' }])
    expect((await owner.readOwnedModelPresetSelection(user, id)).choice.available).toBe(true)
    f.accounts.mockReturnValue([{ id: 'chatgpt-plan:account', transport: 'direct', service: 'chatgpt-plan', status: 'locked', lockedReason: 'Reconnect this account.' }])
    await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('Reconnect this account')
    expect(f.keyState).not.toHaveBeenCalled(); expect(f.catalog).not.toHaveBeenCalled()
  })
  it('SA-139: decides a Claude plan preset by its own admission rules and configuration only, reading no API key, catalogue or Claude Code status', async () => {
    const plan = { provider: 'anthropic', modelId: 'opus', effectiveModelId: 'opus', settings: { anthropicEffort: 'high' }, connection: { id: 'claude-plan:local', type: 'direct', service: 'claude-plan' } }
    seed(plan)
    f.claudeReadiness.mockReturnValue({ state: 'unavailable', code: 'runtime_unavailable', reason: 'Claude plan replies are not available in this Batshit build yet.' })
    await expect(owner.readOwnedModelPresetSelection(user, id, 'api-primary')).rejects.toThrow('not available in this Batshit build yet')
    f.claudeReadiness.mockReturnValue({ state: 'ready' })
    expect((await owner.readOwnedModelPresetSelection(user, id, 'api-primary')).choice).toMatchObject({ available: true, connection: { id: 'claude-plan:local', transport: 'direct', service: 'claude-plan' } })
    expect((await owner.readOwnedModelPresetSelection(user, id)).choice.available).toBe(true)
    seed({ ...plan, settings: { temperature: 0 } })
    await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('does not support temperature')
    seed({ ...plan, connection: { type: 'direct', service: 'claude-plan' } })
    await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('inconsistently')
    expect(f.keyState).not.toHaveBeenCalled(); expect(f.catalog).not.toHaveBeenCalled(); expect(f.mutations).toBe(0)
  })
  it('compares only the exact raw JSON catalogue row and rejects its changed identity', async () => {
    seed({ effectiveModelId: 'openai/fixture', connection: { type: 'vercel-gateway', service: 'vercel' } })
    const row = { id: 'openai/fixture', provider: 'openai', name: 'fixture', source: 'vercel', idVariants: { 'vercel-gateway': { effectiveId: 'openai/fixture', developerId: 'openai', modelId: 'fixture' } } }
    f.catalog.mockResolvedValue({ kind: 'json', raw: '[{"large":"catalogue"}]', payload: { models: [row] } }); f.records.set('vercel:model_catalog:v1', { models: [row] })
    const result = await owner.readOwnedModelPresetSelection(user, id)
    expect(result.checks).toContainEqual({ key: 'vercel:model_catalog:v1', paths: [['$.models[0]', JSON.stringify([row])]] })
    f.records.set('vercel:model_catalog:v1', { models: [{ ...row, name: 'another-model', idVariants: { 'vercel-gateway': { effectiveId: 'different' } } }] })
    await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('changed during selection')
  })
  it('requires a cached exact gateway identifier and preserves legacy string proof', async () => { seed({ effectiveModelId: 'openai/fixture', connection: { type: 'vercel-gateway', service: 'vercel' } }); f.catalog.mockResolvedValue({ kind: 'none', raw: '', payload: null }); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('exact model identifier'); const row = { id: 'openai/fixture', provider: 'openai', name: 'fixture', source: 'vercel', idVariants: { 'vercel-gateway': { effectiveId: 'different', developerId: 'openai', modelId: 'fixture' } } }; f.catalog.mockResolvedValue({ kind: 'string', raw: '{"private":"cache"}', payload: { models: [row] } }); await expect(owner.readOwnedModelPresetSelection(user, id)).rejects.toThrow('exact model identifier'); row.idVariants['vercel-gateway'].effectiveId = 'openai/fixture'; const selected = await owner.readOwnedModelPresetSelection(user, id); expect(selected.checks).toContainEqual({ key: 'vercel:model_catalog:v1', storage: 'string', paths: [['', '{"private":"cache"}']] }) })
  it('rejects edits and raw-identical replacement during the original read', async () => { seed(); f.beforeLeaf = async () => { f.records.get(`model:${id}`).settings.temperature = 1 }; await expect(owner.readOwnedModelPresetDependency(user, id)).rejects.toThrow('changed'); f.beforeLeaf = () => life.withSettingsRecordReplacement(`model:${id}`, async () => {}); await expect(owner.readOwnedModelPresetDependency(user, id)).rejects.toBeInstanceOf(life.SettingsLifecycleRefusal) })
  it('pages deterministic labels and exposes a next offset', async () => { seed(); for (let i = 0; i < 20; i++) { const next = `p_${String(i).padStart(2, '0')}`; f.sets.get(`user:${user}:models`)!.add(next); f.records.set(`model:${next}`, { ...f.records.get(`model:${id}`), id: next, modelName: i % 2 ? 'Other' : 'Chosen' }) }; const first = await owner.readModelPresetSelectionChoices(user, { text: 'chosen', limit: 3 }); expect(first).toMatchObject({ total: 21, matching: 10, offset: 0, limit: 3, nextOffset: 3 }); expect(first.choices.map(c => c.id)).toEqual(['p_00', 'p_02', 'p_04']); const second = await owner.readModelPresetSelectionChoices(user, { text: 'chosen', limit: 3, offset: 3 }); expect(second.choices.map(c => c.id)).toEqual(['p_06', 'p_08', 'p_10']) })
})
describe('physical preset replacement custody', () => {
  it('requires admitted replacement and preserves a newer raw record', async () => { seed(); const before = raw(`model:${id}`); await expect(owner.mutateModelPresetStorage(user, id, before, 'delete')).rejects.toThrow('not admitted'); f.records.get(`model:${id}`).settings.temperature = 1; await expect(life.withSettingsRecordReplacement(`model:${id}`, () => owner.mutateModelPresetStorage(user, id, before, 'delete'))).resolves.toBe('CONFLICT'); expect(f.records.has(`model:${id}`)).toBe(true) })
  it.each(['THROW', 'PARTIAL'])('holds %s outcome through replacement and restore without replay', async answer => { seed(); const before = raw(`model:${id}`); f.answer = answer; await expect(life.withSettingsRecordReplacement(`model:${id}`, () => owner.mutateModelPresetStorage(user, id, before, 'delete'))).rejects.toMatchObject({ status: 503, uncertain: true }); await expect(life.withSettingsRecordReplacement(`model:${id}`, async () => 'retry')).rejects.toThrow('unknown'); await expect(life.withSettingsRestoreFence(async () => 'restore')).rejects.toThrow('unknown'); expect(f.mutations).toBe(1) })
})


describe('A12 private bounded original copy capture', () => {
  // SA-139 R5: an API preset (it was a Claude Code CLI one, whose copy is now refused below).
  const seedSource = () => seed({ settings: { temperature: 0.1, privateUnknown: { zero: 0, falseValue: false } } })
  const patch = () => ({ sourcePresetId: id, copyName: 'Named detached copy', parameters: [{ name: 'temperature', op: 'set' as const, value: 0.4 }] })
  it('holds actual original membership/raw/lifecycle and refuses clone/lookalike handles without reading keys or native readiness', async () => {
    const original = seedSource(), before = structuredClone(original)
    const source = await owner.captureModelPresetCopySource(user, id)
    expect(JSON.stringify(owner.modelPresetCopyChoices(source))).not.toMatch(/privateUnknown|falseValue/)
    expect(() => owner.prepareModelPresetCopy(structuredClone(source), patch())).toThrow('unavailable')
    const plan = owner.prepareModelPresetCopy(source, patch()), view = owner.modelPresetCopyPlan(plan)
    expect(view.candidate).toMatchObject({ modelName: 'Named detached copy', settings: { temperature: 0.4, privateUnknown: before.settings.privateUnknown } })
    view.candidate.settings!.privateUnknown = 'caller mutation'
    expect(owner.modelPresetCopyPlan(plan).candidate.settings!.privateUnknown).toEqual(before.settings.privateUnknown)
    expect(f.records.get(`model:${id}`)).toEqual(before)
    for (const read of [f.keyState, f.local, f.custom, f.catalog, f.accounts, f.paused]) expect(read).not.toHaveBeenCalled()
    expect(f.mutations).toBe(0)
    await life.withSettingsRecordReplacement(`model:${id}`, async () => {})
    await expect(owner.assertModelPresetCopySource(plan)).rejects.toBeInstanceOf(life.SettingsLifecycleRefusal)
  })
  it('refuses oversized and non-roundtripping numeric literals before candidate creation', async () => {
    seedSource(); f.rawOverride = JSON.stringify([{ ...f.records.get(`model:${id}`), unknown: 'x'.repeat(131073) }])
    await expect(owner.captureModelPresetCopySource(user, id)).rejects.toThrow('unreadable')
    f.rawOverride = JSON.stringify([f.records.get(`model:${id}`)]).replace('"privateUnknown":', '"lossy":9007199254740993,"privateUnknown":')
    await expect(owner.captureModelPresetCopySource(user, id)).rejects.toThrow('numeric literal')
    f.rawOverride = JSON.stringify([f.records.get(`model:${id}`)]).replace('"privateUnknown":', '"equivalent":1.0,"privateUnknown":')
    await expect(owner.captureModelPresetCopySource(user, id)).rejects.toThrow('numeric literal')
    expect(f.mutations).toBe(0)
  })
  it('refuses to copy a leftover Claude Code CLI preset (SA-139 R5: a copy would be a new one)', async () => {
    seed({ provider: 'anthropic-claude-cli', modelId: 'claude-cli', connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli' }, settings: { claude_model: 'literal-original' } })
    const before = structuredClone(f.records.get(`model:${id}`))
    const failure = await owner.captureModelPresetCopySource(user, id).catch(error => error)
    expect(failure).toBeInstanceOf(owner.ModelPresetUnavailableError)
    expect(failure.message).toBe(CLAUDE_CLI_PRESET_REFUSAL)
    expect(f.records.get(`model:${id}`)).toEqual(before)
    expect(f.mutations).toBe(0)
  })
})
