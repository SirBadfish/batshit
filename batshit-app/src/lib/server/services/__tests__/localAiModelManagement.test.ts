import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

/**
 * SA-124 P8. Every expectation here is a contract measured against a running
 * program on 2026-09-20, not read from documentation. The traps are the point:
 * each one is a place where the obvious implementation looks like it works.
 */

const listLocalAiServers = vi.fn()
const readLocalProgramApiKey = vi.fn()

vi.mock('$lib/server/services/localAiServers', () => ({
  listLocalAiServers: (...args: unknown[]) => listLocalAiServers(...args),
  saveKoboldManagedProfileReference: vi.fn(),
  resolveLocalAiRuntimeBaseUrl: (url: string) => url
}))
vi.mock('$lib/server/services/localProgramApiKeys', () => ({
  readLocalProgramApiKey: (...args: unknown[]) => readLocalProgramApiKey(...args)
}))
vi.mock('$lib/utils/logger', () => ({ logger: { debug: () => {}, warn: () => {}, error: () => {} } }))

let {
  readLocalAiManagement,
  applyKoboldCppProfile,
  validKoboldProfileExpectation,
  loadLocalAiModel,
  unloadLocalAiModel,
  readLocalAiAvailability,
  isManageableProgram,
  koboldCppServedName
} = await import('../localAiModelManagement')
const { LOCAL_AI_SERVER_DEFINITIONS } = await import('$lib/data/localAiServers')

type Route = { status?: number; body: unknown }
let routes: Record<string, Route>
let calls: { url: string; method: string; body: any; headers: HeadersInit | undefined }[]

function respond(url: string, init?: RequestInit) {
  const path = url.replace(/^https?:\/\/[^/]+/, '')
  const route = routes[path]
  calls.push({
    url: path,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
    headers: init?.headers
  })
  if (!route) return Promise.resolve(new Response('not found', { status: 404 }))
  return Promise.resolve(
    new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  )
}

beforeEach(async () => {
  vi.resetModules();
  ({ readLocalAiManagement, applyKoboldCppProfile, validKoboldProfileExpectation, loadLocalAiModel, unloadLocalAiModel, readLocalAiAvailability, isManageableProgram, koboldCppServedName } = await import('../localAiModelManagement'))
  routes = {}
  calls = []
  listLocalAiServers.mockReset()
  readLocalProgramApiKey.mockReset()
  readLocalProgramApiKey.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn(respond))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function servers(id: string, enabled = true) {
  listLocalAiServers.mockResolvedValue([{ id, baseUrl: 'http://localhost:9999', openaiPath: '/v1', enabled }])
}

function koboldAdmin(files: string[], extra: Record<string, Route> = {}) {
  servers('koboldcpp')
  routes['/api/extra/version'] = { body: { admin: 1 } }
  routes['/api/admin/list_options'] = { body: [...files, 'initial_model', 'unload_model'] }
  routes['/api/extra/perf'] = { body: { idle: 1, queue: 0, uptime: 100 } }
  Object.assign(routes, extra)
}

describe('SA-124 local AI model management', () => {
  it('recognizes every actual management API without equating it to the UI capability label', () => {
    for (const yes of ['koboldcpp', 'lmstudio', 'omlx', 'ollama', 'dmr', 'llama-cpp', 'vllm', 'sglang']) {
      expect(isManageableProgram(yes), yes).toBe(true)
    }
    for (const no of ['nonsense', '', null, undefined]) {
      expect(isManageableProgram(no), no).toBe(false)
    }
  })

  it('keeps program capability copy separate from the conditional management route allowlist', () => {
    // supports.management describes the advertised in-product program capability.
    // llama.cpp is actionable only when it reports router mode; vLLM and SGLang
    // remain connect-only even though their ids are valid route inputs.
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      const advertisesManagement = ['koboldcpp', 'lmstudio', 'omlx', 'ollama', 'dmr', 'llama-cpp'].includes(definition.id)
      expect(definition.supports.management, definition.id).toBe(advertisesManagement)
    }
    for (const id of ['vllm', 'sglang']) {
      expect(isManageableProgram(id), id).toBe(true)
      expect(LOCAL_AI_SERVER_DEFINITIONS.find((definition) => definition.id === id)?.supports.management).toBe(false)
    }
  })

  it('tells a KoboldCpp user to restart with admin options instead of calling it empty', async () => {
    // The version's admin flag gates this interface. When it is on, the model
    // list must also contain both action sentinels before the folder is trusted.
    servers('koboldcpp')
    routes['/api/extra/version'] = { body: { version: '1.121', admin: 0 } }
    routes['/api/admin/list_options'] = { body: [] }

    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.manageable).toBe(false)
    expect(state.reason).toMatch(/admin access is optional/i)
    expect(state.reason).toMatch(/deliberate restart/i)
    expect(state.reason).not.toMatch(/could not reach/i)
    const action = await loadLocalAiModel('josh', 'koboldcpp', 'model.gguf')
    expect(action.success).toBe(false)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('keeps KoboldCpp control words out of the model list', async () => {
    servers('koboldcpp')
    routes['/api/extra/version'] = { body: { admin: 1 } }
    routes['/api/admin/list_options'] = {
      body: ['MythoMax.gguf', 'fast.kcpps', 'initial_model', 'unload_model']
    }

    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.models.map((m) => m.id)).toEqual(['MythoMax.gguf', 'fast.kcpps'])
    // Unload is an action, not a library entry.
    expect(state.canUnload).toBe(true)
    // Switching restarts the server; the UI must wait rather than error.
    expect(state.restartsOnSwitch).toBe(true)
  })

  it('reads LM Studio from `models`, not `data`', async () => {
    // LM Studio's management endpoint keys its array `models`. Reading `data`
    // like the OpenAI endpoint yields an empty list that looks like "no models".
    servers('lmstudio')
    routes['/api/v1/models'] = {
      body: {
        models: [
          {
            key: 'qwen/qwen3-27b',
            display_name: 'Qwen3 27B',
            size_bytes: 17_000_000_000,
            format: 'gguf',
            max_context_length: 262_144,
            loaded_instances: [{ id: 'qwen/qwen3-27b', config: { context_length: 208_384 } }]
          },
          { key: 'idle/model', display_name: 'Idle', max_context_length: 262_144, loaded_instances: [] }
        ]
      }
    }

    const state = await readLocalAiManagement('josh', 'lmstudio')
    expect(state.models).toHaveLength(2)
    expect(state.models[0].loaded).toBe(true)
    // The loaded instance's real context wins over the model's ceiling — the
    // same truth SA-102 fought for in the prompt budget.
    expect(state.models[0].contextLength).toBe(208_384)
    expect(state.models[1].loaded).toBe(false)
    expect(state.models[1].contextLength).toBeNull()
    // This card owns load/unload only; downloads remain in LM Studio.
    expect(state.canDownload).toBe(false)
  })

  it('treats an oMLX 401 as "needs a key", never as offline', async () => {
    servers('omlx')
    routes['/admin/api/models'] = { status: 401, body: { detail: 'unauthorized' } }

    const state = await readLocalAiManagement('josh', 'omlx')
    expect(state.manageable).toBe(false)
    expect(state.reason).toMatch(/key/i)
    expect(state.reason).not.toMatch(/could not reach/i)
  })

  it('treats KoboldCpp HTTP 200 with an empty admin list as unavailable, but accepts an authorized empty folder', async () => {
    servers('koboldcpp')
    routes['/api/extra/version'] = { body: { version: '1.121', admin: 1 } }
    routes['/api/admin/list_options'] = { body: [] }
    const denied = await readLocalAiManagement('josh', 'koboldcpp')
    expect(denied.manageable).toBe(false)
    expect(denied.availability).toBe('access-required')
    expect(denied.reason).toMatch(/admin model list is not accessible/i)

    for (const missingControl of [['initial_model'], ['unload_model']]) {
      routes['/api/admin/list_options'] = { body: missingControl }
      const partial = await readLocalAiManagement('josh', 'koboldcpp')
      expect(partial.manageable).toBe(false)
      expect(partial.availability).toBe('access-required')
    }

    routes['/api/admin/list_options'] = { body: ['initial_model', 'unload_model'] }
    const empty = await readLocalAiManagement('josh', 'koboldcpp')
    expect(empty.manageable).toBe(true)
    expect(empty.models).toEqual([])
    expect(empty.reason).toMatch(/no model files/i)
  })

  it('says a switched-off program is switched off, not unreachable', async () => {
    servers('lmstudio', false)
    const state = await readLocalAiManagement('josh', 'lmstudio')
    expect(state.manageable).toBe(false)
    expect(state.reason).toMatch(/switched off/i)
  })

  it('unloads LM Studio by instance_id, not by model key', async () => {
    servers('lmstudio')
    routes['/api/v1/models'] = { body: { models: [{ key: 'qwen/model', display_name: 'Qwen', loaded_instances: [
      { id: 'qwen/model:instance-a', config: { context_length: 4096 } },
      { id: 'qwen/model:instance-b', config: { context_length: 8192 } }
    ] }] } }
    routes['/api/v1/models/unload'] = { body: { instance_id: 'qwen/model:instance-b' } }

    const state = await readLocalAiManagement('josh', 'lmstudio')
    expect(state.models.map(({ id, loaded, contextLength }) => [id, loaded, contextLength])).toEqual([
      ['qwen/model:instance-a', true, 4096],
      ['qwen/model:instance-b', true, 8192]
    ])
    await unloadLocalAiModel('josh', 'lmstudio', 'qwen/model:instance-b')
    const call = calls.find((c) => c.url === '/api/v1/models/unload')
    expect(call?.body).toEqual({ instance_id: 'qwen/model:instance-b' })
    expect(call?.body).not.toHaveProperty('model')
  })

  it('loads LM Studio by `model` and reports the time it took', async () => {
    servers('lmstudio')
    routes['/api/v1/models'] = { body: { models: [{ key: 'qwen/qwen3-27b', loaded_instances: [] }] } }
    routes['/api/v1/models/load'] = {
      body: { instance_id: 'a', load_time_seconds: 24.107, status: 'loaded' }
    }

    const result = await loadLocalAiModel('josh', 'lmstudio', 'qwen/qwen3-27b')
    expect(calls.find((c) => c.url === '/api/v1/models/load')?.body).toEqual({
      model: 'qwen/qwen3-27b'
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain('24.1 seconds')
  })

  it('treats KoboldCpp’s { success: false } as a refusal with a usable message', async () => {
    // KoboldCpp jails the filename to its admin folder and answers success:false
    // for anything outside it. HTTP 200 with success:false is a real answer.
    koboldAdmin(['MythoMax.gguf'], { '/api/admin/reload_config': { body: { success: false } } })

    const result = await loadLocalAiModel('josh', 'koboldcpp', 'MythoMax.gguf')
    expect(result.success).toBe(false)
    expect(result.restarted).toBeFalsy()
    expect(result.message).toMatch(/admin folder/i)
  })

  it('refuses a traversal name KoboldCpp does not list without sending a reload', async () => {
    koboldAdmin(['MythoMax.gguf'], { '/api/admin/reload_config': { body: { success: true } } })
    const result = await loadLocalAiModel('josh', 'koboldcpp', '../escape.gguf')
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/no longer lists that model/i)
    expect(calls.some((call) => call.url === '/api/admin/reload_config' && call.method === 'POST')).toBe(false)
  })

  it('flags a successful KoboldCpp switch as a restart so callers wait', async () => {
    koboldAdmin(['MythoMax.gguf'], { '/api/admin/reload_config': { body: { success: true } } })

    const result = await loadLocalAiModel('josh', 'koboldcpp', 'MythoMax.gguf')
    expect(result.success).toBe(true)
    expect(result.restarted).toBe(true)
    expect(result.message).toMatch(/restarts/i)
  })

  it('sends an oMLX action to the per-model admin path and reads status ok', async () => {
    servers('omlx')
    routes['/admin/api/models'] = { body: { models: [
      { id: 'Qwen2.5-0.5B-Instruct-4bit', loaded: false, is_loading: false }
    ] } }
    routes['/admin/api/models/Qwen2.5-0.5B-Instruct-4bit/load'] = {
      body: { status: 'ok', model_id: 'Qwen2.5-0.5B-Instruct-4bit' }
    }

    const result = await loadLocalAiModel('josh', 'omlx', 'Qwen2.5-0.5B-Instruct-4bit')
    expect(result.success).toBe(true)
  })

  it('uses oMLX loaded and loading states, and reports 202 unloading as pending', async () => {
    servers('omlx')
    routes['/admin/api/models'] = { body: { models: [
      { id: 'loaded-model', loaded: true, is_loading: false },
      { id: 'starting-model', loaded: false, is_loading: true }
    ] } }
    routes['/admin/api/models/loaded-model/unload'] = { status: 202, body: { status: 'unloading' } }

    const state = await readLocalAiManagement('josh', 'omlx')
    expect(state.models.map(({ id, loaded, busy }) => [id, loaded, busy])).toEqual([
      ['loaded-model', true, false], ['starting-model', false, true]
    ])
    const result = await unloadLocalAiModel('josh', 'omlx', 'loaded-model')
    expect(result).toMatchObject({ success: true, pending: true })
    expect(calls.find((call) => call.url.endsWith('/loaded-model/unload'))).toMatchObject({
      method: 'POST', body: {}
    })
  })

  it('does not treat an inference API key as oMLX admin access', async () => {
    readLocalProgramApiKey.mockResolvedValue('inference-only-key')
    servers('omlx')
    routes['/admin/api/models'] = { status: 401, body: { detail: 'unauthorized' } }

    const state = await readLocalAiManagement('josh', 'omlx')
    expect(state.manageable).toBe(false)
    expect(state.availability).toBe('access-required')
    expect(state.reason).toMatch(/inference API key does not grant admin/i)
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer inference-only-key' })
  })

  it('uses llama.cpp router role and model status as its conditional management capability', async () => {
    servers('llama-cpp')
    routes['/props'] = { body: { role: 'router' } }
    routes['/models'] = { body: { data: [
      { id: 'already-loaded', status: { value: 'loaded' } },
      { id: 'still-loading', status: { value: 'loading' } },
      { id: 'not-loaded', status: { value: 'unloaded' } },
      { id: 'failed-to-start', status: { value: 'unloaded', failed: true, exit_code: 42 } }
    ] } }
    routes['/models/load'] = { body: { success: true } }
    routes['/models/unload'] = { body: { success: true } }

    const state = await readLocalAiManagement('josh', 'llama-cpp')
    expect(state.manageable).toBe(true)
    expect(state.models.map(({ id, loaded, busy }) => [id, loaded, busy])).toEqual([
      ['already-loaded', true, false], ['still-loading', false, true], ['not-loaded', false, false],
      ['failed-to-start', false, false]
    ])
    expect(state.models.find(({ id }) => id === 'not-loaded')?.unloaded).toBe(true)
    expect(state.models.find(({ id }) => id === 'failed-to-start')?.unloaded).toBe(true)
    expect(state.models.find(({ id }) => id === 'failed-to-start')?.failure).toMatch(/exit 42/i)
    expect(await loadLocalAiModel('josh', 'llama-cpp', 'not-loaded')).toMatchObject({ success: true, pending: true })
    expect(calls.find((call) => call.url === '/models/load')).toMatchObject({
      method: 'POST', body: { model: 'not-loaded' }
    })
    expect(await unloadLocalAiModel('josh', 'llama-cpp', 'already-loaded')).toMatchObject({ success: true, pending: true })
    expect(calls.find((call) => call.url === '/models/unload')).toMatchObject({
      method: 'POST', body: { model: 'already-loaded' }
    })
  })

  it('preserves llama.cpp sleeping residency and allows only native unload for that child', async () => {
    servers('llama-cpp')
    routes['/props'] = { body: { role: 'router' } }
    routes['/models'] = { body: { data: [
      { id: 'sleeping-child', status: { value: 'sleeping' } }
    ] } }
    routes['/models/load'] = { body: { success: true } }
    routes['/models/unload'] = { body: { success: true } }

    const state = await readLocalAiManagement('josh', 'llama-cpp')
    expect(state).toMatchObject({ manageable: true, canLoad: true, canUnload: true })
    expect(state.models).toEqual([expect.objectContaining({
      id: 'sleeping-child', loaded: false, sleeping: true, busy: false
    })])

    const load = await loadLocalAiModel('josh', 'llama-cpp', 'sleeping-child')
    expect(load.success).toBe(false)
    expect(load.message).toMatch(/sleeping.*new chat request wakes it automatically/i)
    expect(calls.some((call) => call.url === '/models/load' && call.method === 'POST')).toBe(false)

    expect(await unloadLocalAiModel('josh', 'llama-cpp', 'sleeping-child')).toMatchObject({
      success: true, pending: true
    })
    expect(calls.find((call) => call.url === '/models/unload')).toMatchObject({
      method: 'POST', body: { model: 'sleeping-child' }
    })
  })

  it('keeps single-model and unrecognized llama.cpp servers connect-only and sends no action', async () => {
    servers('llama-cpp')
    routes['/props'] = { body: { role: 'single' } }
    const state = await readLocalAiManagement('josh', 'llama-cpp')
    expect(state.manageable).toBe(false)
    expect(state.availability).toBe('reachable')
    expect(state.reason).toMatch(/router mode/i)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    expect(calls.some((call) => call.url === '/models')).toBe(false)
  })

  it('uses Ollama catalog plus residency and posts a prompt-free native load or unload request', async () => {
    servers('ollama')
    routes['/api/tags'] = { body: { models: [
      { name: 'qwen:latest', size: 123 }, { name: 'idle:latest', size: 456 }
    ] } }
    routes['/api/ps'] = { body: { models: [{ name: 'qwen:latest', context_length: 8192 }] } }
    routes['/api/generate'] = { body: { done: true } }

    const state = await readLocalAiManagement('josh', 'ollama')
    expect(state.connectionKey).toMatch(/^[a-f0-9]{64}$/)
    expect(state.availability).toBe('reachable')
    expect(state.models.map(({ id, loaded, contextLength }) => [id, loaded, contextLength])).toEqual([
      ['qwen:latest', true, 8192], ['idle:latest', false, null]
    ])
    const loaded = await loadLocalAiModel('josh', 'ollama', 'idle:latest', {
      expectedConnectionKey: state.connectionKey
    })
    const unload = await unloadLocalAiModel('josh', 'ollama', 'qwen:latest', state.connectionKey)
    expect(loaded.success).toBe(true)
    expect(unload.success).toBe(true)
    const posts = calls.filter((call) => call.url === '/api/generate')
    expect(posts.map(({ method, body }) => [method, body])).toEqual([
      ['POST', { model: 'idle:latest', keep_alive: -1, stream: false }],
      ['POST', { model: 'qwen:latest', keep_alive: 0, stream: false }]
    ])
    expect(posts.every(({ body }) => !Object.hasOwn(body, 'prompt'))).toBe(true)
  })

  it('treats an empty Ollama residency list as reachable with every installed model unloaded', async () => {
    servers('ollama')
    routes['/api/tags'] = { body: { models: [{ name: 'qwen:latest' }] } }
    routes['/api/ps'] = { body: { models: [] } }
    const state = await readLocalAiManagement('josh', 'ollama')
    expect(state.availability).toBe('reachable')
    expect(state.models).toMatchObject([{ id: 'qwen:latest', loaded: false, contextLength: null }])
  })

  it('re-reads saved availability through its OpenAI model path with the encrypted bearer key', async () => {
    readLocalProgramApiKey.mockResolvedValue('saved-encrypted-key')
    servers('llama-cpp')
    routes['/v1/models'] = { body: { data: [] } }
    const result = await readLocalAiAvailability('josh', 'llama-cpp')
    expect(result).toMatchObject({ availability: 'reachable', models: { data: [] } })
    expect(calls[0]).toMatchObject({
      url: '/v1/models', method: 'GET', body: null,
      headers: { 'content-type': 'application/json', authorization: 'Bearer saved-encrypted-key' }
    })
  })

  it('reports availability as access-required for 401 and unreachable for invalid model-list responses', async () => {
    servers('llama-cpp')
    routes['/v1/models'] = { status: 401, body: { error: 'unauthorized' } }
    expect(await readLocalAiAvailability('josh', 'llama-cpp')).toMatchObject({ availability: 'access-required' })
    routes['/v1/models'] = { body: { models: [] } }
    expect(await readLocalAiAvailability('josh', 'llama-cpp')).toMatchObject({ availability: 'unreachable' })
  })

  it('reports disabled availability without probing and refuses native actions without POST', async () => {
    servers('ollama', false)
    expect(await readLocalAiAvailability('josh', 'ollama')).toMatchObject({ availability: 'unreachable' })
    expect((await loadLocalAiModel('josh', 'ollama', 'qwen:latest')).success).toBe(false)
    expect((await unloadLocalAiModel('josh', 'ollama', 'qwen:latest')).success).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses an action when the saved program is switched off while its list is being checked', async () => {
    listLocalAiServers
      .mockResolvedValueOnce([{ id: 'ollama', baseUrl: 'http://localhost:9999', openaiPath: '/v1', enabled: true }])
      .mockResolvedValueOnce([{ id: 'ollama', baseUrl: 'http://localhost:9999', openaiPath: '/v1', enabled: false }])
    routes['/api/tags'] = { body: { models: [{ name: 'qwen:latest' }] } }
    routes['/api/ps'] = { body: { models: [] } }

    const result = await loadLocalAiModel('josh', 'ollama', 'qwen:latest')
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/saved connection changed/i)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('refuses a connection key captured from an older model-list response before probing', async () => {
    servers('ollama')
    const load = await loadLocalAiModel('josh', 'ollama', 'qwen:latest', {
      expectedConnectionKey: '0'.repeat(64)
    })
    const unload = await unloadLocalAiModel('josh', 'ollama', 'qwen:latest', '0'.repeat(64))
    expect(load.success).toBe(false)
    expect(unload.success).toBe(false)
    expect(load.message).toMatch(/saved connection changed/i)
    expect(calls).toEqual([])
  })

  it('refuses a base URL changed while the native model list is being checked', async () => {
    listLocalAiServers
      .mockResolvedValueOnce([{ id: 'ollama', baseUrl: 'http://old-host:11434', openaiPath: '/v1', enabled: true }])
      .mockResolvedValueOnce([{ id: 'ollama', baseUrl: 'http://new-host:11434', openaiPath: '/v1', enabled: true }])
    routes['/api/tags'] = { body: { models: [{ name: 'qwen:latest' }] } }
    routes['/api/ps'] = { body: { models: [] } }

    const result = await loadLocalAiModel('josh', 'ollama', 'qwen:latest')
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/saved connection changed during this check/i)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('refuses an API key changed while the native model list is being checked', async () => {
    servers('ollama')
    readLocalProgramApiKey.mockResolvedValueOnce('old-key').mockResolvedValueOnce('new-key')
    routes['/api/tags'] = { body: { models: [{ name: 'qwen:latest' }] } }
    routes['/api/ps'] = { body: { models: [] } }

    const result = await loadLocalAiModel('josh', 'ollama', 'qwen:latest')
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/saved connection changed during this check/i)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('keeps connection identity stable, hides it from known-tuple hashing, and rotates it on edits and module restart', async () => {
    servers('ollama')
    routes['/api/tags'] = { body: { models: [{ name: 'qwen:latest' }] } }
    routes['/api/ps'] = { body: { models: [] } }

    const firstRead = await readLocalAiManagement('josh', 'ollama')
    const repeatedRead = await readLocalAiManagement('josh', 'ollama')
    expect(firstRead.connectionKey).toBe(repeatedRead.connectionKey)
    const predictableHash = createHash('sha256')
      .update(JSON.stringify(['josh', 'ollama', 'http://localhost:9999', null]))
      .digest('hex')
    expect(firstRead.connectionKey).not.toBe(predictableHash)

    readLocalProgramApiKey.mockResolvedValue('edited-credential')
    const editedRead = await readLocalAiManagement('josh', 'ollama')
    expect(editedRead.connectionKey).not.toBe(firstRead.connectionKey)

    readLocalProgramApiKey.mockResolvedValue(null)
    vi.resetModules()
    const restartedService = await import('../localAiModelManagement')
    const restartedRead = await restartedService.readLocalAiManagement('josh', 'ollama')
    expect(restartedRead.connectionKey).not.toBe(firstRead.connectionKey)

    calls = []
    const staleAction = await restartedService.loadLocalAiModel('josh', 'ollama', 'qwen:latest', {
      expectedConnectionKey: firstRead.connectionKey
    })
    expect(staleAction.success).toBe(false)
    expect(staleAction.message).toMatch(/saved connection changed/i)
    expect(calls).toEqual([])
  })

  it('refuses stale model ids and unknown capabilities without a mutation request', async () => {
    servers('ollama')
    routes['/api/tags'] = { body: { models: [{ name: 'qwen:latest' }] } }
    routes['/api/ps'] = { body: { models: [] } }
    expect((await loadLocalAiModel('josh', 'ollama', 'removed:latest')).success).toBe(false)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)

    calls = []
    for (const program of ['vllm', 'sglang']) {
      servers(program)
      const state = await readLocalAiManagement('josh', program as 'vllm' | 'sglang')
      expect(state.manageable).toBe(false)
      expect(state.reason).toMatch(/model when you start the server/i)
      const unknown = await loadLocalAiModel('josh', program as 'vllm' | 'sglang', 'some-model')
      expect(unknown.success).toBe(false)
    }
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('sends the stored local program key as a bearer token', async () => {
    readLocalProgramApiKey.mockResolvedValue('sk-local-secret')
    servers('omlx')
    routes['/admin/api/models'] = { body: { models: [] } }

    await readLocalAiManagement('josh', 'omlx')
    const call = (globalThis.fetch as any).mock.calls[0]
    expect(call[1].headers.authorization).toBe('Bearer sk-local-secret')
  })
})

/**
 * BL-101. A KoboldCpp switch to a bare `.gguf` restarts it with its DEFAULT
 * options. Measured 2026-09-22 on Josh's Mac after one click in Batshit:
 * context 32768 -> 12288, `jinja` true -> false, `guidance` true -> false. The
 * user's own launch settings were gone and nothing said so.
 */
describe('BL-101 KoboldCpp switches keep or report the launch settings', () => {
  function kobold(list: string[], extra: Partial<Record<string, Route>> = {}) {
    servers('koboldcpp')
    routes['/api/extra/version'] = { body: { admin: 1, jinja: true, guidance: true } }
    routes['/api/admin/list_options'] = { body: [...list, 'initial_model', 'unload_model'] }
    routes['/api/extra/perf'] = { body: { idle: 1, queue: 0, uptime: 100 } }
    Object.assign(routes, extra)
  }

  it('offers the folder\'s saved-settings files as a base, as KoboldCpp\'s own UI does', async () => {
    kobold(['MythoMax.gguf', 'fast.kcpps', 'story.kcppt'])
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.settingsFiles).toEqual(['fast.kcpps', 'story.kcppt'])
    // Still loadable on their own: a .kcpps carries its own model and settings.
    expect(state.models.map((m) => m.id)).toEqual(['MythoMax.gguf', 'fast.kcpps', 'story.kcppt'])
    expect(state.canRestoreStartup).toBe(true)
  })

  it('reports what KoboldCpp says it is running with', async () => {
    kobold(['Qwen3.5-9B-Q4_K_M.gguf'], {
      '/api/extra/version': { body: { admin: 1, jinja: false, guidance: false } },
      '/api/extra/true_max_context_length': { body: { value: 12288 } },
      '/v1/models': { body: { data: [{ id: 'koboldcpp/Qwen3.5-9B-Q4_K_M' }] } }
    })
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.running).toEqual({
      model: 'Qwen3.5-9B-Q4_K_M',
      contextLength: 12288,
      chatTemplates: false,
      guidance: false
    })
  })

  it('marks the served .gguf as loaded by KoboldCpp\'s own naming rule, and no config', async () => {
    kobold(['Qwen3.5-9B-Q4_K_M.gguf', 'Llama 3.2 (3B).gguf', 'Qwen3.5-9B-Q4_K_M.kcpps'], {
      '/v1/models': { body: { data: [{ id: 'koboldcpp/Qwen3.5-9B-Q4_K_M' }] } }
    })
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.models.map((m) => [m.id, m.loaded])).toEqual([
      ['Qwen3.5-9B-Q4_K_M.gguf', true],
      ['Llama 3.2 (3B).gguf', false],
      // A settings file names its model inside; it is never claimed as loaded.
      ['Qwen3.5-9B-Q4_K_M.kcpps', false]
    ])
  })

  it('names a file the way koboldcpp.py sanitize_string does', () => {
    expect(koboldCppServedName('Llama 3.2 (3B).gguf')).toBe('Llama3.23B')
    expect(koboldCppServedName('sub/My.Model-v2_Q4.gguf')).toBe('My.Model-v2_Q4')
  })

  it('treats KoboldCpp\'s "inactive" placeholder as no model loaded', async () => {
    kobold(['MythoMax.gguf'], {
      '/v1/models': { body: { data: [{ id: 'koboldcpp/inactive' }] } }
    })
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.running?.model).toBeNull()
    expect(state.models[0].loaded).toBe(false)
  })

  it('keeps the model list when a side door does not answer', async () => {
    // No true_max_context_length and no /v1/models routes: both 404.
    kobold(['MythoMax.gguf'])
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.manageable).toBe(true)
    expect(state.models).toHaveLength(1)
    expect(state.running).toEqual({
      model: null,
      contextLength: null,
      chatTemplates: true,
      guidance: true
    })
  })

  it('sends the chosen settings file as KoboldCpp\'s baseconfig', async () => {
    kobold(['Qwen.gguf', 'fast.kcpps'], {
      '/api/admin/reload_config': { body: { success: true } }
    })
    const result = await loadLocalAiModel('josh', 'koboldcpp', 'Qwen.gguf', {
      baseConfig: 'fast.kcpps'
    })
    expect(calls.find((c) => c.url === '/api/admin/reload_config')?.body).toEqual({
      filename: 'Qwen.gguf',
      baseconfig: 'fast.kcpps'
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain('fast.kcpps')
  })

  it('refuses a settings file that is gone instead of letting KoboldCpp use its defaults', async () => {
    // KoboldCpp ignores a base config it cannot find, switches with defaults,
    // and still answers success. Batshit must not pass that along silently.
    kobold(['Qwen.gguf'], { '/api/admin/reload_config': { body: { success: true } } })
    const result = await loadLocalAiModel('josh', 'koboldcpp', 'Qwen.gguf', {
      baseConfig: 'gone.kcpps'
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('gone.kcpps')
    expect(calls.some((c) => c.url === '/api/admin/reload_config')).toBe(false)
  })

  it('refuses a base that is a model, not a settings file', async () => {
    kobold(['Qwen.gguf', 'Other.gguf'], { '/api/admin/reload_config': { body: { success: true } } })
    const result = await loadLocalAiModel('josh', 'koboldcpp', 'Qwen.gguf', {
      baseConfig: 'Other.gguf'
    })
    expect(result.success).toBe(false)
    expect(calls.some((c) => c.url === '/api/admin/reload_config')).toBe(false)
  })

  it('says so when a switch uses no settings file, and sends no baseconfig', async () => {
    kobold(['Qwen.gguf'], { '/api/admin/reload_config': { body: { success: true } } })
    const result = await loadLocalAiModel('josh', 'koboldcpp', 'Qwen.gguf')
    expect(calls.find((c) => c.url === '/api/admin/reload_config')?.body).toEqual({
      filename: 'Qwen.gguf'
    })
    expect(result.message).toContain('without a settings file')
  })

  it('goes back to the startup model and its settings, ignoring any base', async () => {
    kobold(['Qwen.gguf', 'fast.kcpps'], {
      '/api/admin/reload_config': { body: { success: true } }
    })
    const result = await loadLocalAiModel('josh', 'koboldcpp', 'initial_model', {
      baseConfig: 'fast.kcpps'
    })
    expect(calls.find((c) => c.url === '/api/admin/reload_config')?.body).toEqual({
      filename: 'initial_model'
    })
    expect(result.restarted).toBe(true)
    expect(result.message).toMatch(/started with/)
  })
})

describe('the saved Local AI servers cannot be read (BL-977)', () => {
  it('regression guard, not a proof of a fix (green on the parent code too): a list that fails fails the read, the load, and the unload, and reaches no program at any address', async () => {
    // The service is mocked here, so this pins only that `buildContext` has no catch of its own. The
    // fix is proved on the real service in `localAiServers.test.ts`: a failed read used to list every
    // program as its default, so a load or unload was sent to the DEFAULT address of the program.
    const failure = new Error('Could not read the saved Local AI servers.')
    listLocalAiServers.mockRejectedValue(failure)
    try {
      await expect(readLocalAiManagement('josh', 'lmstudio')).rejects.toBe(failure)
      await expect(loadLocalAiModel('josh', 'lmstudio', 'qwen')).rejects.toBe(failure)
      await expect(unloadLocalAiModel('josh', 'lmstudio', 'qwen')).rejects.toBe(failure)
      expect(calls).toEqual([])
    } finally {
      listLocalAiServers.mockReset()
    }
  })
})


// Native shapes are pinned to official KoboldCpp 1.122.1: admin 2 means a
// nonempty admin password, perf idle/queue are numeric and uptime is seconds.
describe('verified KoboldCpp saved-profile restart', () => {
  const MODEL = 'Qwen3.5-9B-Q4_K_M'
  const FILE = 'Qwen-large.kcpps'
  async function prepare() {
    koboldAdmin([FILE], {
      '/api/extra/version': { body: { version: '1.122.1', admin: 2, router: false, llm: true, jinja: true } },
      '/v1/models': { body: { data: [{ id: 'koboldcpp/' + MODEL }] } },
      '/api/extra/true_max_context_length': { body: { value: 16384 } },
      '/api/extra/perf': { body: { idle: 1, queue: 0, uptime: 100 } },
      '/api/admin/reload_config': { body: { success: true } }
    })
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    calls = []
    return { expectedConnectionKey: state.connectionKey!, observedModel: MODEL, observedContext: 16384,
      expectedModel: MODEL, expectedContext: 65536, quiescenceConfirmed: true }
  }
  function nativeRestart(context = 65536, resetUptime = true, oldReads = 0) {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let dispatched = false
    let perfReads = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '')
      if (path === '/api/admin/reload_config') dispatched = true
      if (path === '/api/extra/perf') {
        const reset = dispatched && resetUptime && perfReads++ >= oldReads
        routes[path].body = { idle: 1, queue: 0, uptime: reset ? (Date.now() - 1_000_000) / 1000 : 100 + (Date.now() - 1_000_000) / 1000 }
        if (reset) routes['/api/extra/true_max_context_length'].body = { value: context }
      }
      return respond(url, init)
    }))
  }
  it('sends only a listed native filename and waits past old-child answers for real allocation and restart evidence', async () => {
    const expected = await prepare()
    nativeRestart(65536, true, 1)
    const action = applyKoboldCppProfile('josh', FILE, expected)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await action).toMatchObject({ success: false, outcomeUnknown: true, restarted: true, running: { model: MODEL, contextLength: 65536 }, message: expect.stringMatching(/match.*selected settings file succeeded or startup settings recovered/) })
    expect(calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ filename: FILE }])
    expect(calls.filter(c => c.url === '/api/extra/perf')).toHaveLength(3)
  })
  it('reports a completed restart with the wrong actual allocation, with no retry or rollback', async () => {
    const expected = await prepare()
    nativeRestart(16384)
    const action = applyKoboldCppProfile('josh', FILE, expected)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await action
    expect(result).toMatchObject({ success: false, restarted: true, running: { contextLength: 16384 } })
    expect(result.message).toMatch(/16,384.*Batshit made no automatic retry or rollback/)
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('does not accept unchanged old-child readiness, even when expected model/context already match', async () => {
    const expected = await prepare()
    expected.expectedContext = 16384
    nativeRestart(16384, false)
    const action = applyKoboldCppProfile('josh', FILE, expected)
    await vi.advanceTimersByTimeAsync(181000)
    expect(await action).toMatchObject({ success: false, outcomeUnknown: true })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it.each([
    ['busy', { idle: 0, queue: 0, uptime: 10 }],
    ['queued', { idle: 1, queue: 1, uptime: 10 }],
    ['unknown idle', { queue: 0, uptime: 10 }],
    ['string idle', { idle: '1', queue: 0, uptime: 10 }],
    ['unknown uptime', { idle: 1, queue: 0 }],
    ['negative queue', { idle: 1, queue: -1, uptime: 10 }]
  ])('refuses %s native performance state before mutation', async (_name, perf) => {
    const expected = await prepare()
    routes['/api/extra/perf'].body = perf
    expect(await applyKoboldCppProfile('josh', FILE, expected)).toMatchObject({ success: false })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
  it.each(['stale key', 'removed file', 'changed loaded model', 'changed context', 'unprotected admin', 'router', 'disabled', 'missing confirmation'])('refuses %s before mutation', async condition => {
    const expected = await prepare()
    if (condition === 'stale key') expected.expectedConnectionKey = '0'.repeat(64)
    if (condition === 'removed file') routes['/api/admin/list_options'].body = ['initial_model', 'unload_model']
    if (condition === 'changed loaded model') routes['/v1/models'].body = { data: [{ id: 'koboldcpp/Other' }] }
    if (condition === 'changed context') routes['/api/extra/true_max_context_length'].body = { value: 8192 }
    if (condition === 'unprotected admin') routes['/api/extra/version'].body = { admin: 1, router: false, llm: true }
    if (condition === 'router') routes['/api/extra/version'].body = { admin: 2, router: true, llm: true }
    if (condition === 'disabled') servers('koboldcpp', false)
    if (condition === 'missing confirmation') expected.quiescenceConfirmed = false
    expect(await applyKoboldCppProfile('josh', FILE, expected)).toMatchObject({ success: false })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
  it('refuses a saved credential changed at the final native idle check', async () => {
    const expected = await prepare()
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/extra/perf')) readLocalProgramApiKey.mockResolvedValue('changed-key')
      return respond(url, init)
    }))
    expect(await applyKoboldCppProfile('josh', FILE, expected)).toMatchObject({ success: false })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
  it('keeps a lost mutation answer uncertain and excludes concurrent legacy management until it settles', async () => {
    const expected = await prepare()
    let release!: (value: Response) => void
    const answer = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { calls.push({ url, method: 'POST', body: JSON.parse(String(init.body)), headers: init.headers }); return answer }
      return respond(url, init)
    }))
    const first = applyKoboldCppProfile('josh', FILE, expected)
    await vi.waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true))
    expect(await unloadLocalAiModel('josh', 'koboldcpp', 'unload_model', expected.expectedConnectionKey)).toMatchObject({ success: false, message: expect.stringMatching(/Another KoboldCpp model action/) })
    release(new Response('{}', { status: 502 }))
    expect(await first).toMatchObject({ success: false, outcomeUnknown: true })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
    routes['/api/extra/perf'].body = { idle: 0, queue: 0, uptime: 100 }
    expect((await applyKoboldCppProfile('josh', FILE, expected)).message).toMatch(/previous.*pending or unverified/i)
  })
  it('bounds a saved-state read that never finishes after native acknowledgement', async () => {
    const expected = await prepare()
    nativeRestart()
    const normalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const response = normalFetch(url, init)
      if (init?.method === 'POST') listLocalAiServers.mockImplementation(() => new Promise(() => {}))
      return response
    }))
    const action = applyKoboldCppProfile('josh', FILE, expected)
    await vi.advanceTimersByTimeAsync(181000)
    expect(await action).toMatchObject({ success: false, outcomeUnknown: true, message: expect.stringMatching(/acknowledged.*verification did not finish/) })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('keeps protected profile changes out of the legacy unverified Load action', async () => {
    const expected = await prepare()
    expect(await loadLocalAiModel('josh', 'koboldcpp', FILE, { expectedConnectionKey: expected.expectedConnectionKey })).toMatchObject({ success: false, message: expect.stringContaining('Apply saved settings') })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
  it.each(['/api/extra/true_max_context_length', '/v1/models'])('refuses legacy protected profile Load when %s fails', async path => {
    const expected = await prepare()
    routes[path] = { status: 503, body: {} }
    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state).toMatchObject({ manageable: true, canLoad: true, canApplyProfile: false, requiresVerifiedProfile: true })
    expect(await loadLocalAiModel('josh', 'koboldcpp', FILE, { expectedConnectionKey: expected.expectedConnectionKey })).toMatchObject({ success: false, message: expect.stringContaining('Apply saved settings') })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
  it('keeps a legacy-first acknowledgement guarded until native replacement completes', async () => {
    const expected = await prepare()
    routes['/api/admin/list_options'].body = [FILE, 'Other.gguf', 'initial_model', 'unload_model']
    const legacy = await loadLocalAiModel('josh', 'koboldcpp', 'Other.gguf', { expectedConnectionKey: expected.expectedConnectionKey })
    expect(legacy).toMatchObject({ success: true, restarted: true })
    expect(await applyKoboldCppProfile('josh', FILE, expected)).toMatchObject({ success: false, outcomeUnknown: true, message: expect.stringMatching(/previous.*pending or unverified/i) })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
    routes['/api/extra/perf'].body = { idle: 1, queue: 0, uptime: 0 }
    const released = await loadLocalAiModel('josh', 'koboldcpp', 'not-listed.gguf')
    expect(released.message).toMatch(/no longer lists/)
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('refuses a legacy action if the saved key changes during the new process check', async () => {
    const expected = await prepare()
    routes['/api/admin/list_options'].body = [FILE, 'Other.gguf', 'initial_model', 'unload_model']
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/extra/perf')) readLocalProgramApiKey.mockResolvedValue('changed-key')
      return respond(url, init)
    }))
    expect(await loadLocalAiModel('josh', 'koboldcpp', 'Other.gguf', { expectedConnectionKey: expected.expectedConnectionKey })).toMatchObject({ success: false, message: expect.stringMatching(/saved connection changed/) })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
  it('does not certify profile application when native startup recovery matches the expected model/context', async () => {
    const expected = await prepare()
    // The public observations are identical for a successful selected profile
    // and a failed profile followed by native recovery of matching startup args.
    nativeRestart(65536)
    const action = applyKoboldCppProfile('josh', FILE, expected)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await action).toMatchObject({ success: false, outcomeUnknown: true, restarted: true,
      running: { model: MODEL, contextLength: 65536 }, message: expect.stringContaining('Profile application remains unverified') })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('validates verification-only expectations without inventing defaults', () => {
    for (const v of [null, {}, { expectedContext: 65536 }, { expectedConnectionKey: 'a'.repeat(64), observedModel: MODEL, observedContext: 16384, expectedModel: MODEL, expectedContext: 65536, quiescenceConfirmed: false }]) expect(validKoboldProfileExpectation(v)).toBe(false)
  })
})
