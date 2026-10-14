import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), helper: vi.fn(), remove: vi.fn() }))
vi.mock('../localAiServers', () => ({ listLocalAiServers: mocks.list, saveKoboldManagedProfileReference: mocks.save, deleteLocalAiServerRecord: mocks.remove, saveLocalAiServers: vi.fn(), resolveLocalAiRuntimeBaseUrl: (url: string) => url }))
vi.mock('../localAiManagedProfiles', async original => ({ ...await original<typeof import('../localAiManagedProfiles')>(), managedProfileHelper: mocks.helper }))
vi.mock('../localProgramApiKeys', () => ({ readLocalProgramApiKey: async () => null }))
const REG = '11111111-1111-4111-8111-111111111111'
const MODEL = '22222222-2222-4222-8222-222222222222'
const ART = '33333333-3333-4333-8333-333333333333'
const BASE = `batshit-managed/base-${MODEL}.kcpps`
const TARGET = `batshit-managed/context-${ART}.kcpps`
const SETUP = { registrationId: REG, generationId: '44444444-4444-4444-8444-444444444444', createdAt: '2026-10-04T14:00:00Z', models: [{ id: MODEL, nativeRef: 'Qwen.gguf', servedName: 'Qwen', baseConfig: BASE }] }
let module: typeof import('../localAiModelManagement')
let nativePosts: unknown[]
let nativeFiles: string[]
let switched: boolean
let actualContext: number
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  nativePosts = []; nativeFiles = ['Qwen.gguf', BASE]; switched = false; actualContext = 60000
  mocks.list.mockReset().mockResolvedValue([{ id: 'koboldcpp', baseUrl: 'http://localhost:5001', openaiPath: '/v1', enabled: true, managedProfile: { version: 1, registrationId: REG, state: 'active' } }])
  mocks.save.mockReset().mockResolvedValue(undefined)
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.helper.mockReset().mockImplementation(async action => {
    if (action === 'validate') return SETUP
    if (action === 'prepare') { nativeFiles.push(TARGET); return { artifactId: ART, filename: TARGET, baseConfig: BASE, expectedModel: 'Qwen' } }
    if (action === 'verify') return { verified: true }
    if (action === 'list') return { registrations: [SETUP] }
    throw new Error('Unexpected helper action')
  })
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const route = new URL(String(url)).pathname
    if (init?.method === 'POST') { nativePosts.push(JSON.parse(String(init.body))); switched = true; return Response.json({ success: true }) }
    if (route === '/api/extra/version') return Response.json({ admin: 2, router: false, llm: true })
    if (route === '/api/admin/list_options') return Response.json([...nativeFiles, 'initial_model', 'unload_model'])
    if (route === '/v1/models') return Response.json({ data: [{ id: 'koboldcpp/Qwen' }] })
    if (route === '/api/extra/true_max_context_length') return Response.json({ value: switched ? actualContext : 65536 })
    if (route === '/api/extra/perf') return Response.json({ idle: 1, queue: 0, uptime: switched ? 1 : 100 })
    return new Response('{}', { status: 404 })
  }))
  module = await import('../localAiModelManagement')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function intent() {
  const state = await module.readLocalAiManagement('user-1', 'koboldcpp')
  return { registrationId: REG, modelId: MODEL, contextTokens: 60000, expectedConnectionKey: state.connectionKey!, observedModel: 'Qwen', observedContext: 65536, quiescenceConfirmed: true }
}
describe('BL-1213 actual context allocation intent', () => {
  it('sends native base first/target last only after both fresh list and content verification', async () => {
    const value = await intent()
    const answer = module.applyKoboldCppContext('user-1', value)
    await vi.advanceTimersByTimeAsync(1500)
    const result = await answer
    expect(nativePosts).toEqual([{ filename: TARGET, baseconfig: BASE }])
    expect(mocks.helper.mock.calls.map(c => c[0])).toEqual(['validate', 'prepare', 'verify'])
    expect(mocks.save).toHaveBeenCalledWith('user-1', expect.objectContaining({ desired: { modelId: MODEL, contextTokens: 60000 } }))
    expect(result).toMatchObject({ restarted: true, outcomeUnknown: true, running: { model: 'Qwen', contextLength: 60000 } })
    expect(result.message).toContain('unverified')
  })
  it('refuses a stale saved connection before helper effects', async () => {
    const value = await intent()
    const result = await module.applyKoboldCppContext('user-1', { ...value, expectedConnectionKey: '0'.repeat(64) })
    expect(result.success).toBe(false)
    expect(mocks.helper).not.toHaveBeenCalled()
    expect(nativePosts).toEqual([])
  })
  it('refuses a missing full base rather than letting native silently ignore it', async () => {
    const value = await intent()
    nativeFiles = ['Qwen.gguf']
    expect((await module.applyKoboldCppContext('user-1', value)).success).toBe(false)
    expect(mocks.helper.mock.calls.map(c => c[0])).toEqual(['validate'])
    expect(nativePosts).toEqual([])
  })
  it('preserves prepared files when the fresh target list is missing, without native dispatch', async () => {
    const value = await intent()
    mocks.helper.mockImplementation(async action => action === 'validate' ? SETUP : { artifactId: ART, filename: TARGET, baseConfig: BASE, expectedModel: 'Qwen' })
    const result = await module.applyKoboldCppContext('user-1', value)
    expect(result.message).toContain('Files were retained')
    expect(nativePosts).toEqual([])
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('refuses final base/target or ancestry drift before native dispatch', async () => {
    const value = await intent()
    const previous = mocks.helper.getMockImplementation()!
    mocks.helper.mockImplementation(async (...args) => { if (args[0] === 'verify') throw new Error('Prepared context content changed'); return previous(...args) })
    const result = await module.applyKoboldCppContext('user-1', value)
    expect(result.message).toContain('No native restart was sent')
    expect(nativePosts).toEqual([])
  })
  it('retains an actual mismatch and makes no retry or rollback', async () => {
    const value = await intent(); actualContext = 65536
    const answer = module.applyKoboldCppContext('user-1', value)
    await vi.advanceTimersByTimeAsync(1500)
    const result = await answer
    expect(result).toMatchObject({ success: false, restarted: true, running: { contextLength: 65536 } })
    expect(nativePosts).toHaveLength(1)
  })
  it('cannot use a restored inactive reference or caller-supplied path/JSON as authority', async () => {
    const value = await intent()
    mocks.list.mockResolvedValue([{ id: 'koboldcpp', baseUrl: 'http://localhost:5001', openaiPath: '/v1', enabled: true, managedProfile: { version: 1, registrationId: null, state: 'reenrollment-required' } }])
    expect((await module.applyKoboldCppContext('user-1', value)).success).toBe(false)
    expect(nativePosts).toEqual([])
    expect(module.validKoboldContextIntent({ ...value, directory: '/tmp', config: {} })).toBe(false)
    expect(module.validKoboldContextIntent({ ...value, contextTokens: '60000' })).toBe(false)
  })
  it('refuses legacy file/profile loads that would bypass an active registered setup', async () => {
    const value = await intent()
    expect((await module.loadLocalAiModel('user-1', 'koboldcpp', 'Qwen.gguf')).message).toContain('registered')
    expect((await module.applyKoboldCppProfile('user-1', BASE, { ...value, expectedModel: 'Qwen', expectedContext: 60000 })).message).toContain('registered')
    expect(nativePosts).toEqual([])
    expect(mocks.helper).not.toHaveBeenCalled()
  })
  it('does not offer the saved-file fallback when an active local registration fails validation', async () => {
    vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    mocks.helper.mockRejectedValue(new Error('Registered directory ancestry changed'))
    const state = await module.readLocalAiManagement('user-1', 'koboldcpp')
    expect(state).toMatchObject({ managedContextActive: false, canLoad: false, canApplyProfile: false })
    expect(state.managedContextReason).toContain('ancestry changed')
  })
  it.each([undefined, '', 'not-a-date', '1', '2026-02-31T00:00:00Z', SETUP.createdAt, '2026-10-05T14:00:00Z'])('uses host generation admission, never restore audit chronology %s', async restoredAt => {
    vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    const value = await intent()
    mocks.list.mockResolvedValue([{ id: 'koboldcpp', baseUrl: 'http://localhost:5001', openaiPath: '/v1', enabled: true,
      managedProfile: { version: 1, registrationId: null, state: 'reenrollment-required', restoredAt } }])
    const previous = mocks.helper.getMockImplementation()!
    mocks.helper.mockImplementation(async (...args) => {
      if (args[0] === 'list') return { registrations: [], reenrollmentRequired: true }
      if (args[0] === 'validate') throw new Error('Inactive host generation. New local enrollment required.')
      return previous(...args)
    })
    const state = await module.readLocalAiManagement('user-1', 'koboldcpp')
    expect(state.registeredSetup).toBeUndefined()
    expect(state.managedContextReason).toContain('new local enrollment')
    await expect(module.enableKoboldManagedSetup('user-1', REG, value.expectedConnectionKey)).rejects.toThrow('Inactive host generation')
    expect(mocks.save).not.toHaveBeenCalled()
    mocks.helper.mockImplementation(previous)
    expect((await module.enableKoboldManagedSetup('user-1', REG, value.expectedConnectionKey)).success).toBe(true)
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(nativePosts).toEqual([])
  })
  it('refuses a legacy grant with no verified host generation', async () => {
    vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    const value = await intent()
    mocks.helper.mockResolvedValue({ ...SETUP, generationId: undefined })
    expect((await module.enableKoboldManagedSetup('user-1', REG, value.expectedConnectionKey)).success).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects a prepared filename that is not the exact verified artifact', async () => {
    const value = await intent()
    mocks.helper.mockImplementation(async action => action === 'validate' ? SETUP : {
      artifactId: ART, filename: `batshit-managed/context-${MODEL}.kcpps`, baseConfig: BASE, expectedModel: 'Qwen'
    })
    expect((await module.applyKoboldCppContext('user-1', value)).message).toContain('did not match')
    expect(nativePosts).toEqual([])
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('preserves deletion custody while file preparation is running', async () => {
    const value = await intent()
    let release!: () => void
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    const previous = mocks.helper.getMockImplementation()!
    mocks.helper.mockImplementation(async (...args) => {
      if (args[0] === 'prepare') { entered(); await hold }
      return previous(...args)
    })
    const action = module.applyKoboldCppContext('user-1', value)
    await preparing
    const remove = vi.fn()
    await expect(module.withKoboldSettingsDeletion('user-1', remove)).rejects.toThrow('retained')
    expect(remove).not.toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(1500)
    await action
  })
  it('unloads a supported vanity/debug served model without claiming a GGUF/full-profile identity', async () => {
    vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method !== 'POST' && new URL(String(url)).pathname === '/v1/models') return Response.json({ data: [{ id: 'koboldcpp/debug-custom' }] })
      return originalFetch(url, init)
    }))
    mocks.helper.mockImplementation(async action => action === 'list' ? { registrations: [{ ...SETUP, models: [{ ...SETUP.models[0], servedName: 'debug-custom' }] }] } : SETUP)
    const state = await module.readLocalAiManagement('user-1', 'koboldcpp')
    expect(state.running?.model).toBe('debug-custom')
    expect(state.models.find(m => m.id === 'Qwen.gguf')?.loaded).toBe(false)
    expect(state.canUnloadCurrent).toBe(true)
    expect((await module.unloadLocalAiModel('user-1', 'koboldcpp', 'unload_model', state.connectionKey)).success).toBe(true)
    expect(nativePosts).toEqual([{ filename: 'unload_model' }])
  })
  it('retains deletion custody after a lost native answer until original-process replacement is proven', async () => {
    const value = await intent()
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') { nativePosts.push(JSON.parse(String(init.body))); throw new Error('Native answer lost') }
      return originalFetch(url, init)
    }))
    expect((await module.applyKoboldCppContext('user-1', value)).outcomeUnknown).toBe(true)
    const remove = vi.fn().mockResolvedValue(undefined)
    await expect(module.withKoboldSettingsDeletion('user-1', remove)).rejects.toThrow('retained')
    expect(remove).not.toHaveBeenCalled()
    switched = true
    await vi.advanceTimersByTimeAsync(1500)
    await module.withKoboldSettingsDeletion('user-1', remove)
    expect(remove).toHaveBeenCalledOnce()
    expect(nativePosts).toHaveLength(1)
  })
  it('the authenticated DELETE route preserves custody after a lost restart answer', async () => {
    const value = await intent()
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') { nativePosts.push(JSON.parse(String(init.body))); throw new Error('Native answer lost') }
      return originalFetch(url, init)
    }))
    expect((await module.applyKoboldCppContext('user-1', value)).outcomeUnknown).toBe(true)
    const { DELETE } = await import('../../../../routes/api/settings/local-ai/+server')
    const request = () => new Request('http://localhost/api/settings/local-ai', { method: 'DELETE', body: JSON.stringify({ id: 'koboldcpp' }) })
    const failure = await DELETE({ request: request(), locals: { user: { id: 'user-1' } } } as any) as Response
    expect(failure.status).toBe(500)
    expect(mocks.remove).not.toHaveBeenCalled()
    switched = true
    await vi.advanceTimersByTimeAsync(1500)
    const success = await DELETE({ request: request(), locals: { user: { id: 'user-1' } } } as any) as Response
    expect(success.status).toBe(200)
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('user-1', 'koboldcpp')
    expect(nativePosts).toHaveLength(1)
  })

})
