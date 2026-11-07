import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureSettingsLifecycle } from './lifecycle'
const fixture = vi.hoisted(() => ({ records: {} as Record<string, Record<string, unknown>>, forbidden: vi.fn(() => { throw new Error('effectful owner called') }) }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { readConfiguredState: vi.fn(async (service: string, userId: string) => ({ key: `api_keys:${userId}:${service}`, raw: service === 'openai' ? '[{"encrypted":"CIPHERTEXT"}]' : '[]', configured: service === 'openai', readable: true })) } }))
vi.mock('$lib/server/services/voiceService', () => ({
  configuredBuiltinTtsCatalog: () => [{ id: 'browser', label: 'Browser', models: [], voices: [], defaultModel: null, defaultVoice: 'system', catalog: 'configured-subset' },
    { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini-tts', 'tts-1'], voices: ['alloy', 'marin'], defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'alloy', catalog: 'static-complete' },
    { id: 'alibaba', label: 'Alibaba', models: ['qwen-audio-3.1-tts-plus'], voices: ['Cherry'], defaultModel: 'qwen3-tts-flash', defaultVoice: 'Cherry', catalog: 'static-complete' }],
  buildVoiceProviderSummary: fixture.forbidden, listVoices: fixture.forbidden, synthesizeSpeech: fixture.forbidden, checkByoSpeechStatus: fixture.forbidden
}))
vi.mock('$lib/server/services/voiceEngineRegistry', () => ({ readConfiguredVoiceEngineSelectionSource: vi.fn(async () => ({ engines: [{ id: 'byo:closed', label: 'Configured Closed Engine', enabled: true, supportsTts: true, model: 'saved_model', voice: 'saved_voice', voices: [] }], complete: true, guard: { key: 'voice_engine_registry:u', path: '$', fingerprint: 'a'.repeat(40), byteLimit: 262144 } })), getVoiceEngineRecordByProviderId: fixture.forbidden, listVoiceEngineManagerView: fixture.forbidden }))
vi.mock('$lib/server/services/voiceProfileRecords', async () => ({ readConfiguredVoiceProfiles: vi.fn(async () => ({ profiles: [], count: 0, complete: true, lifecycle: captureSettingsLifecycle([]) })) }))
vi.mock('$lib/server/redis', () => {
  const valueAt = (key: string, path: string) => path === '$' ? fixture.records[key] : path.slice(2).split('.').reduce<unknown>((value, field) => value && typeof value === 'object' ? (value as Record<string, unknown>)[field] : undefined, fixture.records[key])
  const rawAt = (key: string, path: string) => { const value = valueAt(key, path); return value === undefined ? '[]' : JSON.stringify([value]) }
  const kind = (value: unknown) => value === undefined ? '' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const client = { type: vi.fn(async () => 'none'), get: vi.fn(async () => null), sIsMember: vi.fn(async () => true), eval: vi.fn(async (script: string, args: { keys: string[]; arguments: string[] }) => {
    if (script.includes('-- QWEN_TTS_ORIGINAL_WORKSPACE')) return [...(JSON.parse(args.arguments[0]) as string[]).map(path => kind(valueAt(args.keys[0], path))), ...(JSON.parse(args.arguments[1]) as string[]).map(path => rawAt(args.keys[0], path))]
    if (script.includes('-- fixed-agent-voice-model-source')) return ['OK', ...(JSON.parse(args.arguments[0]) as string[]).map(path => rawAt(args.keys[0], path)), kind(valueAt(args.keys[0], '$.primary_model_connection'))]
    if (script.includes('-- fixed-voice-model-index-source')) return ['OK', ...Object.keys(fixture.records).filter(key => key.startsWith('model:')).map(key => key.slice(6)).sort()]
    if (script.includes('-- fixed-voice-model-record-source')) {
      if (args.keys.slice(1).some(key => !fixture.records[key])) return ['INVALID']
      const paths = JSON.parse(args.arguments[1]) as string[]
      return ['OK', ...args.keys.slice(1).flatMap(key => [...paths.map(path => rawAt(key, path)), kind(valueAt(key, '$.connection'))])]
    }
    const key = args.keys[0], paths: string[] = JSON.parse(args.arguments[0])
    return key.startsWith('agent:') ? ['OK', ...paths.map(path => rawAt(key, path)), kind(valueAt(key, '$.voice_profile')), kind(valueAt(key, '$.voice_profile.tts'))] :
      [kind(valueAt(key, '$.voice_settings')), kind(valueAt(key, '$.voice_settings.tts')), ...paths.map(path => rawAt(key, path))]
  }) }
  return { redis: { execute: async (read: (client: unknown) => unknown) => read(client), json: { getRaw: vi.fn(async (key: string, path: string) => { const raw = rawAt(key, path); return raw === '[]' ? null : raw }) } } }
})
import { configuredTtsChoices, readConfiguredTtsTarget } from './configuredTtsSources'
import { env } from '$env/dynamic/private'
import { readConfiguredVoiceProfiles } from '$lib/server/services/voiceProfileRecords'
beforeEach(() => {
  fixture.forbidden.mockClear()
  delete env.OPENAI_API_KEY
  delete env.ALIBABA_CLOUD_API_KEY
  fixture.records = { 'agent:a10_source': { id: 'a10_source', user_id: 'u', agentType: 'api', created_at: '2026-10-17', voice_profile: { tts: { providerId: 'openai' } } }, 'user:u:settings': { voice_settings: { tts: { providerId: 'browser' }, stt: { secretSibling: 'DO_NOT_PROJECT' } } } }
})
describe('pure configured TTS source and actual saved model lock', () => {
  it('allows legitimate absent optional preset and a configured closed engine without health/list/setup calls', async () => {
    const target = await readConfiguredTtsTarget('u', 'a10_source')
    expect(target.catalog.voiceCatalog).toMatchObject({ snapshot: null, source: 'bundled' })
    expect(target.locked).toBe(false)
    expect(target.providers.find(provider => provider.id === 'byo:closed')).toMatchObject({ configured: 'yes', enabled: true })
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('keeps private encrypted/endpoint/sibling preimages out of the finite DTO', async () => {
    const dto = configuredTtsChoices(await readConfiguredTtsTarget('u', 'a10_source'))
    expect(JSON.stringify(dto)).not.toMatch(/CIPHERTEXT|PRIVATE_ENDPOINT|DO_NOT_PROJECT|baseUrl|authToken|guards/)
    expect(dto.providers.find(provider => provider.id === 'openai')).toMatchObject({ catalog: 'static-complete', configured: 'yes' })
  })
  it('captures Qwen global and engine endpoint facts without publishing endpoint values', async () => {
    env.ALIBABA_CLOUD_API_KEY = 'key'
    const globalEndpoint = 'https://global.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    const engineEndpoint = 'https://engine.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    fixture.records['user:u:settings'] = { voice_settings: { tts: { providerId: 'alibaba', common: { endpoint: globalEndpoint } }, ttsEngineSettings: { alibaba: { common: { endpoint: engineEndpoint } } } } }
    const target = await readConfiguredTtsTarget('u', 'a10_source')
    expect(target.catalog.qwenWorkspace).toMatchObject({ global: 'singapore', engine: 'beijing', globalAvailable: true, engineAvailable: true })
    const choices = configuredTtsChoices(target, { ttsProviderId: 'alibaba', ttsModelId: 'qwen-audio-3.1-tts-plus' })
    expect(choices.choices.some(choice => choice.voiceId === 'longanlingxin_v3.1')).toBe(true)
    expect(JSON.stringify({ target, choices })).not.toContain(globalEndpoint)
    expect(JSON.stringify({ target, choices })).not.toContain(engineEndpoint)
    expect(target.catalog.qwenWorkspace.engineGuards).toContainEqual(expect.objectContaining({ path: '$.voice_settings.ttsEngineSettings.alibaba.common.endpoint', fingerprint: expect.any(String) }))
  })
  it('bounds private environment input before fingerprinting and guards changed environment without retaining its value', async () => {
    env.OPENAI_API_KEY = 'test-private-env-original'
    const target = await readConfiguredTtsTarget('u', 'a10_source')
    expect(JSON.stringify({ ...target, checkEnvironment: undefined })).not.toContain('test-private-env-original')
    env.OPENAI_API_KEY = 'test-private-env-changed'
    expect(() => target.checkEnvironment()).toThrow('tts_configured_environment_changed')
    env.OPENAI_API_KEY = 'x'.repeat(16385)
    await expect(readConfiguredTtsTarget('u', 'a10_source')).rejects.toThrow('tts_configured_environment_unavailable')
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('retains inferred speech-to-speech lock from the actual selected owned preset', async () => {
    fixture.records['agent:a10_source'].primary_model_preset_id = 'preset'
    fixture.records['model:preset'] = { id: 'preset', modelName: 'Realtime', user_id: 'u', provider: 'openai', modelId: 'gpt-realtime-2' }
    expect((await readConfiguredTtsTarget('u', 'a10_source')).locked).toBe(true)
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('distinguishes a missing nonempty preset reference from optional absence', async () => {
    fixture.records['agent:a10_source'].primary_model_preset_id = 'missing'
    await expect(readConfiguredTtsTarget('u', 'a10_source')).rejects.toThrow('tts_model_selection_unavailable')
  })
  it('retains the actual inferred saved-model fallback lock and joins its exact source/index guards', async () => {
    fixture.records['agent:a10_source'].primary_model_provider = 'openai'
    fixture.records['agent:a10_source'].primary_model_name = 'gpt-realtime-2'
    fixture.records['model:fallback'] = { id: 'fallback', modelName: 'Realtime', provider: 'openai', modelId: 'gpt-realtime-2' }
    const target = await readConfiguredTtsTarget('u', 'a10_source')
    expect(target.locked).toBe(true)
    expect(target.guards).toContainEqual({ key: 'user:u:models', members: ['fallback'] })
    expect(target.guards).toContainEqual({ key: 'model:fallback', path: '$.modelId', raw: '["gpt-realtime-2"]' })
    expect(fixture.forbidden).not.toHaveBeenCalled()
  })
  it('BL-1686 guards every fallback connection discriminator even for a nonmatch', async () => {
    Object.assign(fixture.records['agent:a10_source'], { primary_model_provider: 'openai', primary_model_name: 'gpt-realtime-2', primary_model_connection: { type: 'direct', service: 'openai' } })
    fixture.records['model:fallback'] = { id: 'fallback', provider: 'openai', modelId: 'other', effectiveModelId: 'gpt-realtime-2', connection: { type: 'vercel-gateway', service: 'vercel' } }
    const target = await readConfiguredTtsTarget('u', 'a10_source')
    expect(target.locked).toBe(false)
    for (const path of ['$.connection.id', '$.connection.type', '$.connection.service', '$.isVercelImport']) expect(target.guards).toContainEqual(expect.objectContaining({ key: 'model:fallback', path }))
    expect(target.guards).toContainEqual({ key: 'model:fallback', typePath: '$.connection', type: 'object' })
  })
  it('BL-1689 excludes an irrelevant other-provider profile from mutation guards and lifecycle', async () => {
    fixture.records['user:u:settings'] = { voice_settings: { tts: { providerId: 'fish', profileId: 'fish_saved' } } }
    vi.mocked(readConfiguredVoiceProfiles).mockResolvedValueOnce({ count: 1, complete: true, lifecycle: captureSettingsLifecycle(['voice_profile:fish_saved']), profiles: [
      { id: 'fish_saved', name: 'Fish', providerId: 'fish', voiceId: 'saved', modelId: null, guard: { key: 'voice_profile:fish_saved', path: '$', fingerprint: 'a'.repeat(40), byteLimit: 65536 }, metadataGuards: [], membership: { key: 'user:u:voice_profiles', member: 'fish_saved', present: true } }
    ] })
    const target = await readConfiguredTtsTarget('u', 'a10_source')
    expect(target.effective.profileId).toBeNull()
    expect(target.guards.some(guard => guard.key === 'voice_profile:fish_saved')).toBe(false)
    expect(target.sourceLifecycle.records.some(([key]) => key === 'voice_profile:fish_saved')).toBe(false)
  })
  it('allows a genuinely unmatched optional selection and refuses only conflicting fallback lock truth', async () => {
    fixture.records['agent:a10_source'].primary_model_provider = 'openai'
    fixture.records['agent:a10_source'].primary_model_name = 'ordinary-unmatched'
    expect((await readConfiguredTtsTarget('u', 'a10_source')).locked).toBe(false)
    fixture.records['agent:a10_source'].primary_model_provider = ''
    fixture.records['agent:a10_source'].primary_model_name = 'openai/gpt-realtime-2'
    fixture.records['model:fallback'] = { id: 'fallback', modelName: 'Realtime', provider: 'openai', modelId: 'gpt-realtime-2' }
    await expect(readConfiguredTtsTarget('u', 'a10_source')).rejects.toThrow('tts_model_lock_ambiguous')
  })
})
