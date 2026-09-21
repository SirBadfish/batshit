import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-124 P8. Every expectation here is a contract measured against a running
 * program on 2026-09-20, not read from documentation. The traps are the point:
 * each one is a place where the obvious implementation looks like it works.
 */

const listLocalAiServers = vi.fn()
const readLocalProgramApiKey = vi.fn()

vi.mock('$lib/server/services/localAiServers', () => ({
  listLocalAiServers: (...args: unknown[]) => listLocalAiServers(...args),
  resolveLocalAiRuntimeBaseUrl: (url: string) => url
}))
vi.mock('$lib/server/services/localProgramApiKeys', () => ({
  readLocalProgramApiKey: (...args: unknown[]) => readLocalProgramApiKey(...args)
}))
vi.mock('$lib/utils/logger', () => ({ logger: { debug: () => {}, warn: () => {}, error: () => {} } }))

const {
  readLocalAiManagement,
  loadLocalAiModel,
  unloadLocalAiModel,
  isManageableProgram
} = await import('../localAiModelManagement')

type Route = { status?: number; body: unknown }
let routes: Record<string, Route>
let calls: { url: string; method: string; body: any }[]

function respond(url: string, init?: RequestInit) {
  const path = url.replace(/^https?:\/\/[^/]+/, '')
  const route = routes[path]
  calls.push({
    url: path,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null
  })
  if (!route) return Promise.resolve(new Response('not found', { status: 404 }))
  return Promise.resolve(
    new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  )
}

beforeEach(() => {
  routes = {}
  calls = []
  readLocalProgramApiKey.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn(respond))
})
afterEach(() => vi.unstubAllGlobals())

function servers(id: string, enabled = true) {
  listLocalAiServers.mockResolvedValue([{ id, baseUrl: 'http://localhost:9999', enabled }])
}

describe('SA-124 local AI model management', () => {
  it('only claims the three programs that can actually load a model', () => {
    for (const yes of ['koboldcpp', 'lmstudio', 'omlx']) {
      expect(isManageableProgram(yes), yes).toBe(true)
    }
    // These three take one model per process from a launch flag. Listing models
    // Batshit cannot load would be a library of dead entries (DL-124-13).
    for (const no of ['llama-cpp', 'vllm', 'sglang', 'ollama', 'dmr', 'nonsense']) {
      expect(isManageableProgram(no), no).toBe(false)
    }
  })

  it('tells a KoboldCpp user to restart with admin options instead of calling it empty', async () => {
    // list_options answers [] both when admin mode is off and when the folder is
    // empty, so `admin` in the version response is the only honest probe.
    servers('koboldcpp')
    routes['/api/extra/version'] = { body: { version: '1.121', admin: 0 } }
    routes['/api/admin/list_options'] = { body: [] }

    const state = await readLocalAiManagement('josh', 'koboldcpp')
    expect(state.manageable).toBe(false)
    expect(state.reason).toContain('--admin --admindir')
    expect(state.reason).not.toMatch(/could not reach/i)
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
          { key: 'idle/model', display_name: 'Idle', loaded_instances: [] }
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
    // There is no HTTP download endpoint; offering one would be a dead button.
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

  it('says a switched-off program is switched off, not unreachable', async () => {
    servers('lmstudio', false)
    const state = await readLocalAiManagement('josh', 'lmstudio')
    expect(state.manageable).toBe(false)
    expect(state.reason).toMatch(/switched off/i)
  })

  it('unloads LM Studio by instance_id, not by model key', async () => {
    // They match on a single load, which hides the bug until someone loads the
    // same model twice.
    servers('lmstudio')
    routes['/api/v1/models/unload'] = { body: { instance_id: 'qwen/qwen3-27b' } }

    await unloadLocalAiModel('josh', 'lmstudio', 'qwen/qwen3-27b')
    const call = calls.find((c) => c.url === '/api/v1/models/unload')
    expect(call?.body).toEqual({ instance_id: 'qwen/qwen3-27b' })
    expect(call?.body).not.toHaveProperty('model')
  })

  it('loads LM Studio by `model` and reports the time it took', async () => {
    servers('lmstudio')
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
    servers('koboldcpp')
    routes['/api/admin/reload_config'] = { body: { success: false } }

    const result = await loadLocalAiModel('josh', 'koboldcpp', '../escape.gguf')
    expect(result.success).toBe(false)
    expect(result.restarted).toBeFalsy()
    expect(result.message).toMatch(/admin folder/i)
  })

  it('flags a successful KoboldCpp switch as a restart so callers wait', async () => {
    servers('koboldcpp')
    routes['/api/admin/reload_config'] = { body: { success: true } }

    const result = await loadLocalAiModel('josh', 'koboldcpp', 'MythoMax.gguf')
    expect(result.success).toBe(true)
    expect(result.restarted).toBe(true)
    expect(result.message).toMatch(/restarts/i)
  })

  it('sends an oMLX action to the per-model admin path and reads status ok', async () => {
    servers('omlx')
    routes['/admin/api/models/Qwen2.5-0.5B-Instruct-4bit/load'] = {
      body: { status: 'ok', model_id: 'Qwen2.5-0.5B-Instruct-4bit' }
    }

    const result = await loadLocalAiModel('josh', 'omlx', 'Qwen2.5-0.5B-Instruct-4bit')
    expect(result.success).toBe(true)
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
