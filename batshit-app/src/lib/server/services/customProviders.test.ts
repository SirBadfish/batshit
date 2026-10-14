/**
 * BL-587: an edit of a custom provider that keeps its saved key reads that key
 * BEFORE anything is written. A provider restored from a backup that leaves
 * secrets out has its three key fields nulled (`backupRestoreService`
 * `redactSecretFields`); the edit used to write the record and then answer 400
 * while decrypting them. Real encryption, an in-memory stand-in for Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: { ENCRYPTION_KEY: 'bl587-test-encryption-key-0123456789abcdef' }
}))

const store = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  sets: new Map<string, Set<string>>(),
  writes: [] as string[]
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: async (run: (client: unknown) => Promise<unknown>) =>
      run({
        json: {
          get: async (key: string) => (store.docs.has(key) ? structuredClone(store.docs.get(key)) : null),
          set: async (key: string, _path: string, value: unknown) => {
            store.writes.push(key)
            store.docs.set(key, structuredClone(value))
          }
        },
        del: async (key: string) => {
          store.docs.delete(key)
        }
      }),
    sMembers: async (key: string) => [...(store.sets.get(key) ?? [])],
    sAdd: async (key: string, member: string) => {
      store.sets.set(key, new Set([...(store.sets.get(key) ?? []), member]))
    },
    sRem: async (key: string, member: string) => {
      store.sets.get(key)?.delete(member)
    }
  }
}))

import { listCustomProviders, listCustomProvidersForRuntime, upsertCustomProvider } from './customProviders'

const USER = 'user-1'
const KEY = 'acme-secret-0123456789'

async function createProvider() {
  const created = await upsertCustomProvider(USER, { label: 'Acme', baseUrl: 'https://acme.invalid/v1', apiKey: KEY })
  return { created, recordKey: `custom_provider:${USER}:${created.id}` }
}

/** The shape a restore writes from a backup that leaves secrets out. */
function restoreWithoutSecrets(recordKey: string) {
  const record = store.docs.get(recordKey) as Record<string, unknown>
  store.docs.set(recordKey, { ...record, apiKeyEncrypted: null, apiKeyIv: null, apiKeyAuthTag: null })
  store.writes.length = 0
  return structuredClone(store.docs.get(recordKey))
}

describe('BL-587: editing a custom provider whose saved key is missing or unreadable', () => {
  beforeEach(() => {
    store.docs.clear()
    store.sets.clear()
    store.writes.length = 0
  })

  it('refuses an edit that keeps a restored provider\'s missing key, and writes nothing', async () => {
    const { created, recordKey } = await createProvider()
    const restored = restoreWithoutSecrets(recordKey)

    await expect(
      upsertCustomProvider(USER, { id: created.id, label: 'Acme Renamed', baseUrl: 'https://acme.invalid/v2', apiKey: null })
    ).rejects.toThrow('Custom provider "Acme" has no saved API key (a backup that leaves secrets out does not carry it). Enter its API key to save it.')

    expect(store.writes).toEqual([])
    expect(store.docs.get(recordKey)).toEqual(restored)
  })

  it('saves a restored provider once its key is entered again', async () => {
    const { created, recordKey } = await createProvider()
    restoreWithoutSecrets(recordKey)

    const saved = await upsertCustomProvider(USER, {
      id: created.id,
      label: 'Acme Renamed',
      baseUrl: 'https://acme.invalid/v1',
      apiKey: 'EMPTY'
    })

    expect(saved.label).toBe('Acme Renamed')
    expect(saved.maskedKey).not.toBe('****')
    expect(store.writes).toEqual([recordKey])
    const [runtime] = await listCustomProvidersForRuntime(USER)
    expect(runtime).toMatchObject({ id: created.id, label: 'Acme Renamed', apiKey: 'EMPTY' })
  })

  it('refuses an edit that keeps a key it cannot decrypt, and writes nothing', async () => {
    const { created, recordKey } = await createProvider()
    const record = store.docs.get(recordKey) as Record<string, unknown>
    store.docs.set(recordKey, { ...record, apiKeyAuthTag: '00'.repeat(16) })
    const before = structuredClone(store.docs.get(recordKey))
    store.writes.length = 0

    await expect(
      upsertCustomProvider(USER, { id: created.id, label: 'Acme Renamed', baseUrl: 'https://acme.invalid/v1' })
    ).rejects.toThrow('The saved API key of custom provider "Acme" cannot be read. Enter its API key again to save it.')

    expect(store.writes).toEqual([])
    expect(store.docs.get(recordKey)).toEqual(before)
  })

  it('keeps a readable saved key on an edit that enters none (the control)', async () => {
    const { created, recordKey } = await createProvider()
    store.writes.length = 0

    const saved = await upsertCustomProvider(USER, { id: created.id, label: 'Acme Renamed', baseUrl: 'https://acme.invalid/v1' })

    expect(saved).toMatchObject({ id: created.id, label: 'Acme Renamed', maskedKey: created.maskedKey })
    expect(store.writes).toEqual([recordKey])
    const [runtime] = await listCustomProvidersForRuntime(USER)
    expect(runtime.apiKey).toBe(KEY)
  })
})

describe('Packet 5 finding 1: the saved key\'s usability reaches the summary, never the key', () => {
  beforeEach(() => {
    store.docs.clear()
    store.sets.clear()
    store.writes.length = 0
  })

  it('marks a restored or unreadable key not usable, a readable one usable, and lists only usable ones for the run', async () => {
    const ok = await upsertCustomProvider(USER, { label: 'Working', baseUrl: 'https://ok.invalid/v1', apiKey: KEY })
    const restored = await upsertCustomProvider(USER, { label: 'Restored', baseUrl: 'https://restored.invalid/v1', apiKey: KEY })
    const broken = await upsertCustomProvider(USER, { label: 'Broken', baseUrl: 'https://broken.invalid/v1', apiKey: KEY })
    restoreWithoutSecrets(`custom_provider:${USER}:${restored.id}`)
    const brokenKey = `custom_provider:${USER}:${broken.id}`
    store.docs.set(brokenKey, { ...(store.docs.get(brokenKey) as Record<string, unknown>), apiKeyAuthTag: '00'.repeat(16) })

    const summaries = await listCustomProviders(USER)
    const usable = Object.fromEntries(summaries.map((summary) => [summary.id, summary.apiKeyUsable]))
    expect(usable).toEqual({ [ok.id]: true, [restored.id]: false, [broken.id]: false })
    // Yes or no only: no key, no ciphertext, no decrypted text.
    const sent = JSON.stringify(summaries)
    expect(sent).not.toContain(KEY)
    expect(sent).not.toMatch(/apiKeyEncrypted|apiKeyIv|apiKeyAuthTag/)
    // The run registers exactly the providers the summary calls usable.
    expect((await listCustomProvidersForRuntime(USER)).map((provider) => provider.id)).toEqual([ok.id])
    expect(store.writes).toEqual([])
  })

  it('reports usable once the key is entered again', async () => {
    const created = await upsertCustomProvider(USER, { label: 'Restored', baseUrl: 'https://restored.invalid/v1', apiKey: KEY })
    restoreWithoutSecrets(`custom_provider:${USER}:${created.id}`)
    const saved = await upsertCustomProvider(USER, { id: created.id, label: 'Restored', baseUrl: 'https://restored.invalid/v1', apiKey: 'EMPTY' })
    expect(saved.apiKeyUsable).toBe(true)
    expect((await listCustomProviders(USER))[0].apiKeyUsable).toBe(true)
  })
})
