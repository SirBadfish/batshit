import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-102 P5 (DL-102-09, DL-102-14): ONE stored key per local AI program, shared
 * by the chat transport and the memory embedder.
 *
 * Before this, chat had no key field at all (`registerLocalProvider` hardcoded
 * the literal string `local-ai`, and Josh's oMLX answered 401 for weeks), while
 * the memory system kept its own `localAi.apiKey` inside `batshit:memory_config`
 * — a second place for the same secret, and the only one not guaranteed to be
 * encrypted.
 */

const store = new Map<string, string>()
const servers: Array<{ id: string; baseUrl: string }> = [
  { id: 'lmstudio', baseUrl: 'http://localhost:1234' },
  { id: 'omlx', baseUrl: 'http://localhost:8000' },
  { id: 'llama-cpp', baseUrl: 'http://localhost:8080' }
]

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn(async (service: string) => store.get(service) ?? null),
    store: vi.fn(async (service: string, key: string) => {
      store.set(service, key)
    })
  }
}))

vi.mock('$lib/server/services/localAiServers', () => ({
  listLocalAiServers: vi.fn(async () => servers)
}))

const {
  isLocalProgramKeyService,
  readLocalProgramApiKey,
  resolveLocalProgramIdForBaseUrl,
  resolveMemoryLocalAiApiKey
} = await import('../localProgramApiKeys')

beforeEach(() => {
  store.clear()
})

describe('SA-102 local program API keys', () => {
  it('recognises every local program id and nothing else', () => {
    for (const id of ['ollama', 'dmr', 'lmstudio', 'llama-cpp', 'vllm', 'sglang', 'omlx']) {
      expect(isLocalProgramKeyService(id), id).toBe(true)
    }
    for (const id of ['openai', 'anthropic', '', null, undefined]) {
      expect(isLocalProgramKeyService(id as any), String(id)).toBe(false)
    }
  })

  it('reads a stored key for a program', async () => {
    store.set('omlx', 'sk-omlx-test')
    expect(await readLocalProgramApiKey('omlx', 'user-1')).toBe('sk-omlx-test')
    expect(await readLocalProgramApiKey('lmstudio', 'user-1')).toBeNull()
  })

  it('never reads a key without a user', async () => {
    store.set('omlx', 'sk-omlx-test')
    expect(await readLocalProgramApiKey('omlx', null)).toBeNull()
  })

  it('matches a memory-config URL to its program by origin', async () => {
    // The memory config stores the URL WITH the OpenAI path; the program record
    // stores origin and path separately.
    expect(await resolveLocalProgramIdForBaseUrl('http://localhost:8000/v1', 'u')).toBe('omlx')
    expect(await resolveLocalProgramIdForBaseUrl('http://localhost:1234', 'u')).toBe('lmstudio')
    expect(await resolveLocalProgramIdForBaseUrl('http://localhost:9999/v1', 'u')).toBeNull()
  })

  it('prefers the shared store over a legacy memory-config key', async () => {
    store.set('omlx', 'sk-from-the-shared-store')
    const result = await resolveMemoryLocalAiApiKey({
      baseUrl: 'http://localhost:8000/v1',
      configuredApiKey: 'sk-legacy-in-memory-config',
      userId: 'u'
    })
    expect(result.apiKey).toBe('sk-from-the-shared-store')
    expect(result.migratedFromMemoryConfig).toBe(true)
  })

  it('migrates a legacy memory-config key into the encrypted store', async () => {
    const result = await resolveMemoryLocalAiApiKey({
      baseUrl: 'http://localhost:8000/v1',
      configuredApiKey: 'sk-legacy-in-memory-config',
      userId: 'u'
    })
    expect(result.apiKey).toBe('sk-legacy-in-memory-config')
    expect(result.migratedFromMemoryConfig).toBe(true)
    // and it is now in the one shared store
    expect(store.get('omlx')).toBe('sk-legacy-in-memory-config')
  })

  it('keeps working when the memory URL is not a configured program', async () => {
    const result = await resolveMemoryLocalAiApiKey({
      baseUrl: 'http://some-other-host:1234/v1',
      configuredApiKey: 'sk-not-a-batshit-program',
      userId: 'u'
    })
    // Do not lose a key just because it points somewhere Batshit does not manage.
    expect(result.apiKey).toBe('sk-not-a-batshit-program')
    expect(result.migratedFromMemoryConfig).toBe(false)
  })

  it('returns nothing when there is no key anywhere', async () => {
    const result = await resolveMemoryLocalAiApiKey({
      baseUrl: 'http://localhost:8000/v1',
      configuredApiKey: null,
      userId: 'u'
    })
    expect(result.apiKey).toBeNull()
    expect(result.migratedFromMemoryConfig).toBe(false)
  })
})
