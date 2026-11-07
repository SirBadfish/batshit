// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { RedisClientType } from 'redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { BUILTIN_VOICE_PROVIDER_IDS, BUILTIN_VOICE_CATALOG_SOURCES } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot } from '$lib/types/builtinVoiceCatalog'
import { voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries, selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import { createBuiltinVoiceCatalogReader } from '../services/builtinVoiceCatalogCache'
import { publishBuiltinVoiceCatalog } from '../services/builtinVoiceCatalogPublisher'
import { createLocalVoiceCatalogStore, GLOBAL_VOICE_CATALOG_KEY, LOCAL_VOICE_CATALOG_KEY, type VoiceCatalogStringStore } from '../services/builtinVoiceCatalogStore'
import { UPSTASH_COMPARE_AND_SET_SCRIPT } from '../services/upstashKv'

const real = process.env.VITEST_USE_REAL_REDIS === 'true'
const at = '2026-10-28T03:00:00.000Z', now = Date.parse(at)
let client: RedisClientType
const admission = useRedisTestServer({ async beforeCleanupAdmission({ adminClient, resolvedUrl }) {
  const path = process.env.VOICE_CATALOG_TEST_ALLOCATION
  if (!path) throw Error('Voice catalog proof requires the parent-supervised disposable allocation.')
  const expected = JSON.parse(readFileSync(path, 'utf8')), url = new URL(resolvedUrl)
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== expected.port || expected.port < 49152 || !/^\/(?:[1-9]|1[0-5])$/.test(url.pathname)) throw Error('Voice catalog proof endpoint not admitted.')
  const info = await adminClient.info('server'), conn = await adminClient.clientInfo(), config = await adminClient.configGet('dir')
  if (!info.includes('redis_version:8.10.1\r\n') || !info.includes(`run_id:${expected.runId}\r\n`) || !info.includes(`process_id:${expected.pid}\r\n`) ||
    config.dir !== expected.directory || conn.db !== Number(url.pathname.slice(1)) || conn.laddr !== `127.0.0.1:${expected.port}`) throw Error('Voice catalog proof instance identity changed.')
  const json = await adminClient.sendCommand(['COMMAND', 'INFO', 'JSON.GET'])
  if (!Array.isArray(json) || !json[0]) throw Error('Voice catalog proof requires Redis JSON.')
  if (/^db\d+:/m.test(await adminClient.info('keyspace'))) throw Error('Voice catalog proof instance was not initially empty.')
  client = adminClient
} })

async function snapshot(sequence = 1, blocked = false): Promise<BuiltinVoiceCatalogSnapshot> {
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => {
    const entries = bundledVoiceCatalogEntries(id)
    if (blocked && id === 'fish') Object.assign(entries[0], { admission: 'blocked', blockedReason: 'contract-changed',
      evidenceUrls: [BUILTIN_VOICE_CATALOG_SOURCES.find(source => source.providerId === id)!.urls[0]] })
    return [id, id === 'browser' ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries } : {
      sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: blocked && id === 'fish' ? 'blocked' : 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries }]
  })) as BuiltinVoiceCatalogSnapshot['providers']
  const result: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence, generatedAt: at, revision: '0'.repeat(64), providers }
  result.revision = await voiceCatalogRevision(result)
  return result
}
const cacheRaw = (snapshot: BuiltinVoiceCatalogSnapshot) => JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot })
function globalStore(): VoiceCatalogStringStore {
  return { async read() { admission.requireAdmission(); const raw = await client.get(GLOBAL_VOICE_CATALOG_KEY); return raw === null ? { state: 'absent' } : { state: 'present', raw } },
    async compareAndSet(before, next) {
      admission.requireAdmission()
      const answer = await client.eval(UPSTASH_COMPARE_AND_SET_SCRIPT, { keys: [GLOBAL_VOICE_CATALOG_KEY], arguments: [before === null ? 'absent' : 'present', before ?? '', next] })
      if (answer === 'OK') return true
      if (answer === 'CHANGED') return false
      throw Error('Global catalog proof write unconfirmed')
    } }
}
const localStore = () => createLocalVoiceCatalogStore(async operation => { admission.requireAdmission(); return operation(client) })

afterEach(async () => {
  if (real && admission.isAdmitted()) {
    await client.del([GLOBAL_VOICE_CATALOG_KEY, LOCAL_VOICE_CATALOG_KEY])
    expect(await client.exists([GLOBAL_VOICE_CATALOG_KEY, LOCAL_VOICE_CATALOG_KEY])).toBe(0)
  }
})

describe.runIf(real)('voice catalog delivery through actual raw Redis CAS', () => {
  it('initializes one raw JSON STRING atomically without TTL or double encoding', async () => {
    const value = await snapshot(), store = globalStore()
    const result = await publishBuiltinVoiceCatalog({ store, collect: async () => value.providers, nowMs: now, initializeAbsent: true, dryRun: false })
    expect(result.status).toBe('stored')
    const raw = await client.get(GLOBAL_VOICE_CATALOG_KEY)
    expect(JSON.parse(raw!).schemaVersion).toBe(1)
    expect(await client.type(GLOBAL_VOICE_CATALOG_KEY)).toBe('string')
    expect(await client.ttl(GLOBAL_VOICE_CATALOG_KEY)).toBe(-1)
  })

  it('refuses the old-ready publisher after another actual CAS publishes a block', async () => {
    const base = await snapshot(), blocked = await snapshot(2, true), store = globalStore()
    await client.set(GLOBAL_VOICE_CATALOG_KEY, JSON.stringify(base))
    const write = vi.spyOn(store, 'compareAndSet'), collect = vi.fn(async () => {
      expect(await globalStore().compareAndSet(JSON.stringify(base), JSON.stringify(blocked))).toBe(true)
      return base.providers
    })
    const result = await publishBuiltinVoiceCatalog({ store, collect, nowMs: now, dryRun: false })
    expect(result.status).toBe('conflict'); expect(result.winner?.revision).toBe(blocked.revision)
    expect(write).toHaveBeenCalledTimes(1); expect(collect).toHaveBeenCalledTimes(1)
    expect(await client.get(GLOBAL_VOICE_CATALOG_KEY)).toBe(JSON.stringify(blocked))
  })

  it('adopts a lower-than-proposal block winner, then retains it after restart/offline', async () => {
    const base = await snapshot(), incoming = await snapshot(3), blocked = await snapshot(2, true), store = localStore()
    await client.set(LOCAL_VOICE_CATALOG_KEY, cacheRaw(base))
    const reader = createBuiltinVoiceCatalogReader({ store, now: () => now, fetchSnapshot: async () => {
      expect(await localStore().compareAndSet(cacheRaw(base), cacheRaw(blocked))).toBe(true)
      return JSON.stringify(incoming)
    } })
    const view = await reader.refresh(true)
    expect(view.snapshot?.sequence).toBe(2)
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    const restarted = createBuiltinVoiceCatalogReader({ store: localStore(), now: () => now + 7200000, fetchSnapshot: async () => { throw Error('offline') } })
    expect(selectedVoiceCatalogCompatibility(await restarted.refresh(), 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    expect(await client.ttl(LOCAL_VOICE_CATALOG_KEY)).toBe(-1)
    expect(await client.get(LOCAL_VOICE_CATALOG_KEY)).toBe(cacheRaw(blocked))
  })

  it('refuses corrupt and wrong-type cache values without replacing them', async () => {
    await client.set(LOCAL_VOICE_CATALOG_KEY, 'corrupt')
    const network = vi.fn(async () => JSON.stringify(await snapshot())), store = localStore()
    expect((await createBuiltinVoiceCatalogReader({ store, fetchSnapshot: network, now: () => now }).refresh(true)).source).toBe('unavailable')
    expect(network).not.toHaveBeenCalled(); expect(await client.get(LOCAL_VOICE_CATALOG_KEY)).toBe('corrupt')
    await client.del(LOCAL_VOICE_CATALOG_KEY)
    await client.hSet(LOCAL_VOICE_CATALOG_KEY, 'keep', 'owned proof')
    await expect(store.read()).rejects.toThrow('cache_storage_type')
    await expect(store.compareAndSet(null, 'replacement')).rejects.toThrow('cache_storage_type')
    expect(await client.hGetAll(LOCAL_VOICE_CATALOG_KEY)).toEqual({ keep: 'owned proof' })
  })
})
