// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_VOICE_CATALOG_SOURCES, BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot } from '$lib/types/builtinVoiceCatalog'
import { verifyBuiltinVoiceCatalog, voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries, effectiveVoiceCatalogModel, projectBuiltinVoiceCatalog, selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import { createBuiltinVoiceCatalogReader } from '../services/builtinVoiceCatalogCache'
import { createGlobalVoiceCatalogStore, publishBuiltinVoiceCatalog } from '../services/builtinVoiceCatalogPublisher'
import { createLocalVoiceCatalogStore, LOCAL_VOICE_CATALOG_KEY, type VoiceCatalogStringStore } from '../services/builtinVoiceCatalogStore'
import { fetchPublicVoiceCatalog, PUBLIC_VOICE_CATALOG_URL } from '../services/builtinVoiceCatalogRemote'
import { upstashKvGetRaw, upstashKvSetIfUnchanged } from '../services/upstashKv'

vi.mock('../services/upstashKv', () => ({ upstashKvGetRaw: vi.fn(), upstashKvSetIfUnchanged: vi.fn() }))
const at = '2026-10-28T03:00:00.000Z', now = Date.parse(at)

async function snapshot(sequence = 1, blocked = false) {
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => {
    const entries = bundledVoiceCatalogEntries(id)
    if (blocked && id === 'fish') Object.assign(entries[0], { admission: 'blocked', blockedReason: 'contract-changed',
      evidenceUrls: [BUILTIN_VOICE_CATALOG_SOURCES.find(source => source.providerId === id)!.urls[0]] })
    return [id, id === 'browser' ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable',
      qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries } : {
      sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: blocked && id === 'fish' ? 'blocked' : 'pending',
      lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries }]
  })) as BuiltinVoiceCatalogSnapshot['providers']
  const value: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence, generatedAt: at, revision: '0'.repeat(64), providers }
  value.revision = await voiceCatalogRevision(value)
  return verifyBuiltinVoiceCatalog(JSON.stringify(value), now)
}

function memoryStore(initial: string | null = null) {
  let raw = initial
  const store: VoiceCatalogStringStore = { read: vi.fn(async () => raw === null ? { state: 'absent' } : { state: 'present', raw }),
    compareAndSet: vi.fn(async (before, next) => { if (raw !== before) return false; raw = next; return true }) }
  return { store, raw: () => raw, replace(value: string | null) { raw = value } }
}
const cacheRaw = (value: BuiltinVoiceCatalogSnapshot) => JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: value })

describe('one ordered public catalog delivery path', () => {
  it('uses raw STRING Upstash bytes and serializes a proposed snapshot exactly once', async () => {
    const value = await snapshot(), port = createGlobalVoiceCatalogStore()
    vi.mocked(upstashKvGetRaw).mockResolvedValueOnce(null)
    expect(await port.read()).toEqual({ state: 'absent' })
    vi.mocked(upstashKvGetRaw).mockResolvedValueOnce('  raw  ')
    expect(await port.read()).toEqual({ state: 'present', raw: '  raw  ' })
    vi.mocked(upstashKvSetIfUnchanged).mockResolvedValueOnce(true)
    expect(await port.compareAndSet('  raw  ', JSON.stringify(value))).toBe(true)
    expect(upstashKvSetIfUnchanged).toHaveBeenLastCalledWith('voice-model-catalog:v1', '  raw  ', value, { timeoutMs: 5000 })
  })

  it('captures the predecessor before fresh collection and refuses a corrupt predecessor', async () => {
    const io = memoryStore('bad-json'), collect = vi.fn()
    await expect(publishBuiltinVoiceCatalog({ store: io.store, collect, nowMs: now, dryRun: false })).rejects.toThrow()
    expect(collect).not.toHaveBeenCalled()
    expect(io.store.compareAndSet).not.toHaveBeenCalled()
  })

  it('keeps an old-ready publisher from overwriting the winning same-ID block', async () => {
    const base = await snapshot(), winner = await snapshot(2, true), io = memoryStore(JSON.stringify(base))
    const collect = vi.fn(async () => { io.replace(JSON.stringify(winner)); return base.providers })
    const result = await publishBuiltinVoiceCatalog({ store: io.store, collect, nowMs: now, dryRun: false })
    expect(result.status).toBe('conflict')
    expect(result.winner?.revision).toBe(winner.revision)
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(io.raw()).toBe(JSON.stringify(winner))
  })

  it('writes only the fixed local key and refuses wrong storage types or unconfirmed writes', async () => {
    const client = { type: vi.fn(async () => 'hash'), get: vi.fn(), eval: vi.fn() }
    const port = createLocalVoiceCatalogStore(async fn => fn(client))
    await expect(port.read()).rejects.toThrow('cache_storage_type')
    expect(client.get).not.toHaveBeenCalled()
    client.eval.mockResolvedValueOnce('UNCONFIRMED')
    await expect(port.compareAndSet(null, 'next')).rejects.toThrow('cache_write_unconfirmed')
    expect(client.eval.mock.calls[0][1]).toEqual({ keys: [LOCAL_VOICE_CATALOG_KEY], arguments: ['absent', '', 'next'] })
  })

  it('deduplicates lazy refreshes and keeps runtime reads off the network', async () => {
    const value = await snapshot(), io = memoryStore(), network = vi.fn(async () => JSON.stringify(value))
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: network, now: () => now })
    expect((await reader.readCurrent()).source).toBe('bundled')
    expect(network).not.toHaveBeenCalled()
    const first = reader.refresh(), second = reader.refresh()
    expect(first).toBe(second)
    expect((await first).source).toBe('remote')
    await reader.refresh(); await reader.readCurrent()
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('retains a blocked entry across restart and offline errors without bundled resurrection', async () => {
    const value = await snapshot(2, true), io = memoryStore(cacheRaw(value))
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => { throw Error('offline') }, now: () => now + 7200000 })
    const view = await reader.refresh()
    expect(view.warning).toBe('remote-unavailable')
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    expect(projectBuiltinVoiceCatalog(view, now).find(row => row.providerId === 'fish')!.models['tts-direct-stream']).not.toContain('s2.1-pro')
    expect(io.store.compareAndSet).not.toHaveBeenCalled()
  })

  it.each(['{bad', JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: null }), JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: {}, endpoint: 'evil' })])('preserves unreadable cache bytes and exposes unavailable compatibility: %s', async raw => {
    const io = memoryStore(raw), network = vi.fn(async () => JSON.stringify(await snapshot()))
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: network, now: () => now })
    const view = await reader.refresh(true)
    expect(view.source).toBe('unavailable')
    expect(network).not.toHaveBeenCalled()
    expect(io.raw()).toBe(raw)
    expect(io.store.compareAndSet).not.toHaveBeenCalled()
    expect(projectBuiltinVoiceCatalog(view, now).flatMap(row => Object.values(row.models).flat())).toEqual([])
  })

  it('keeps safe memory block/order facts when persistent state becomes corrupt', async () => {
    const io = memoryStore(cacheRaw(await snapshot(2, true)))
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: vi.fn(), now: () => now })
    await reader.readCurrent(); io.replace('corrupt')
    const view = await reader.refresh(true)
    expect(view.source).toBe('retained'); expect(view.warning).toBe('cache-unavailable')
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    expect(io.raw()).toBe('corrupt')
  })

  it('refuses stale CDN data without advancing a successful-fetch stamp', async () => {
    const current = await snapshot(2, true), old = await snapshot(), io = memoryStore(cacheRaw(current))
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => JSON.stringify(old), now: () => now })
    const result = await reader.refresh(true)
    expect(result.warning).toBe('remote-stale')
    expect(io.raw()).toBe(cacheRaw(current)); expect(io.store.compareAndSet).not.toHaveBeenCalled()
  })

  it('refuses different valid content at equal order', async () => {
    const current = await snapshot(2, true), conflicting = await snapshot(2), io = memoryStore(cacheRaw(current))
    const result = await createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => JSON.stringify(conflicting), now: () => now }).refresh(true)
    expect(result.warning).toBe('cache-unavailable'); expect(io.raw()).toBe(cacheRaw(current))
  })

  it.each(['omitted', 'ready', 'incomplete-candidate'])('never resurrects a known block through a higher ordinary snapshot: %s', async change => {
    const current = await snapshot(2, true), incoming = structuredClone(await snapshot(3, true))
    if (change === 'omitted') incoming.providers.fish.entries.shift()
    if (change === 'ready') Object.assign(incoming.providers.fish.entries[0], { admission: 'qualified', blockedReason: undefined })
    if (change === 'incomplete-candidate') Object.assign(incoming.providers.fish.entries[0], { admission: 'candidate', blockedReason: 'qualification-required' })
    incoming.revision = await voiceCatalogRevision(incoming)
    const io = memoryStore(cacheRaw(current)), reader = createBuiltinVoiceCatalogReader({ store: io.store, now: () => now, fetchSnapshot: async () => JSON.stringify(incoming) })
    const result = await reader.refresh(true)
    expect(result.warning).toBe('cache-unavailable')
    expect(selectedVoiceCatalogCompatibility(result, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    expect(io.store.compareAndSet).not.toHaveBeenCalled()
    io.replace(cacheRaw(incoming))
    expect(selectedVoiceCatalogCompatibility(await reader.readCurrent(), 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
  })

  it('preserves an unknown-profile restriction against omission and a return to the old mapping', async () => {
    const old = structuredClone(await snapshot(2))
    Object.assign(old.providers.fish.entries[0], { admission: 'candidate', compatibilityProfileId: 'fish.future.v2', blockedReason: 'qualification-required' })
    old.revision = await voiceCatalogRevision(old)
    for (const omitted of [true, false]) {
      const incoming = structuredClone(await snapshot(3))
      if (omitted) incoming.providers.fish.entries.shift()
      incoming.revision = await voiceCatalogRevision(incoming)
      const io = memoryStore(cacheRaw(old)), reader = createBuiltinVoiceCatalogReader({ store: io.store, now: () => now, fetchSnapshot: async () => JSON.stringify(incoming) })
      const view = await reader.refresh(true)
      expect(view.warning).toBe('cache-unavailable')
      expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('candidate')
      expect(io.store.compareAndSet).not.toHaveBeenCalled()
      io.replace(cacheRaw(incoming))
      expect(selectedVoiceCatalogCompatibility(await reader.readCurrent(), 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('candidate')
    }
  })

  it('lets healthy providers advance while an unchanged wire-qualified unknown profile remains unavailable', async () => {
    const old = structuredClone(await snapshot(2))
    Object.assign(old.providers.fish.entries[0], { compatibilityProfileId: 'fish.future.v2' })
    old.revision = await voiceCatalogRevision(old)
    const next = structuredClone(old); next.sequence = 3; next.providers.openai.lastAttemptAt = '2026-10-28T03:01:00.000Z'; next.revision = await voiceCatalogRevision(next)
    const io = memoryStore(cacheRaw(old)), reader = createBuiltinVoiceCatalogReader({ store: io.store, now: () => now, fetchSnapshot: async () => JSON.stringify(next) })
    const result = await reader.refresh(true)
    expect(result.snapshot?.sequence).toBe(3)
    expect(result.warning).toBeUndefined()
    expect(selectedVoiceCatalogCompatibility(result, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('candidate')
  })

  it('conserves an incompatible exact Deepgram voice profile against an old Aura mapping', async () => {
    const old = structuredClone(await snapshot(2))
    old.providers.deepgram.entries.push({ modelId: 'aura-2-thalia-en', label: 'voice', lane: 'tts-batch', admission: 'candidate', compatibilityProfileId: 'deepgram.flux-rest.v1',
      blockedReason: 'qualification-required', qualifiedAt: null, provenance: 'bundled-legacy', evidenceUrls: [], release: 'unknown' })
    old.revision = await voiceCatalogRevision(old)
    const next = structuredClone(old); next.sequence = 3
    Object.assign(next.providers.deepgram.entries.at(-1)!, { admission: 'qualified', compatibilityProfileId: 'deepgram.aura-rest.v1', blockedReason: undefined })
    next.revision = await voiceCatalogRevision(next)
    const io = memoryStore(cacheRaw(old)), reader = createBuiltinVoiceCatalogReader({ store: io.store, now: () => now, fetchSnapshot: async () => JSON.stringify(next) })
    const result = await reader.refresh(true)
    expect(result.warning).toBe('cache-unavailable')
    expect(selectedVoiceCatalogCompatibility(result, 'deepgram', 'tts-batch', 'aura-2-thalia-en').state).toBe('candidate')
    expect(io.store.compareAndSet).not.toHaveBeenCalled()
  })

  it('rereads and adopts a higher cache winner once without stale retry', async () => {
    const old = await snapshot(), incoming = await snapshot(2), winner = await snapshot(3, true), io = memoryStore(cacheRaw(old))
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace(cacheRaw(winner)); return false })
    const view = await createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => JSON.stringify(incoming), now: () => now }).refresh(true)
    expect(view.snapshot?.sequence).toBe(3)
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
  })

  it('adopts a persisted block winner below the losing uncommitted remote proposal', async () => {
    const old = await snapshot(), incoming = await snapshot(3), winner = await snapshot(2, true), io = memoryStore(cacheRaw(old))
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace(cacheRaw(winner)); return false })
    const view = await createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => JSON.stringify(incoming), now: () => now }).refresh(true)
    expect(view.snapshot?.sequence).toBe(2)
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
  })

  it('exposes an unreadable winner and retains its bytes without retry', async () => {
    const old = await snapshot(2, true), incoming = await snapshot(3, true), io = memoryStore(cacheRaw(old))
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace('corrupt winner'); return false })
    const view = await createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => JSON.stringify(incoming), now: () => now }).refresh(true)
    expect(view.warning).toBe('cache-unavailable')
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
    expect(io.raw()).toBe('corrupt winner'); expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
  })

  it('keeps an observed higher block unavailable when a lower ready cache writer wins', async () => {
    const old = await snapshot(), blocked = await snapshot(3, true), winner = await snapshot(2), io = memoryStore(cacheRaw(old))
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace(cacheRaw(winner)); return false })
    const network = vi.fn(async () => JSON.stringify(blocked))
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: network, now: () => now })
    expect((await reader.refresh(true)).source).toBe('unavailable')
    expect((await reader.readCurrent()).source).toBe('unavailable')
    const resolved = await reader.refresh()
    expect(network).toHaveBeenCalledTimes(2) // The lower winner's fresh check cannot postpone reconciliation.
    expect(selectedVoiceCatalogCompatibility(resolved, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe('blocked')
  })

  it.each([false, true])('reconciles an unconfirmed issued block write without replay (actually stored=%s)', async stored => {
    const old = await snapshot(), blocked = await snapshot(2, true), io = memoryStore(cacheRaw(old))
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async (_before, next) => { if (stored) io.replace(next); throw Error('answer lost') })
    const reader = createBuiltinVoiceCatalogReader({ store: io.store, fetchSnapshot: async () => JSON.stringify(blocked), now: () => now })
    const view = await reader.refresh(true)
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
    expect(selectedVoiceCatalogCompatibility(view, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe(stored ? 'blocked' : 'unavailable')
    const read = await reader.readCurrent()
    expect(selectedVoiceCatalogCompatibility(read, 'fish', 'tts-direct-stream', 's2.1-pro').state).toBe(stored ? 'blocked' : 'unavailable')
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
  })

  it('binds selected semantic facts without unrelated sequence/timestamp dependencies or writes', async () => {
    const old = await snapshot(), newer = await snapshot(2), blocked = await snapshot(3, true)
    const view = (snapshot: BuiltinVoiceCatalogSnapshot) => ({ snapshot, source: 'retained' as const, checkedAt: at })
    const selected = (value: BuiltinVoiceCatalogSnapshot) => selectedVoiceCatalogCompatibility(view(value), 'fish', 'tts-direct-stream', 's2.1-pro')
    expect(selected(old)).toEqual(selected(newer))
    expect(selected(blocked).facts).not.toBe(selected(old).facts)
    expect(selectedVoiceCatalogCompatibility(view(newer), 'fish', 'tts-direct-stream', 'custom').state).toBe('unlisted')
    expect(effectiveVoiceCatalogModel('deepgram', 'flux-hannah-en', 'aura-2-thalia-en')).toBe('aura-2-thalia-en')
  })

  it('exposes failed provider attempts independently from freshness and labels unavailable choices truthfully', async () => {
    const value = structuredClone(await snapshot())
    value.providers.fish.lastVerifiedAt = at
    value.revision = await voiceCatalogRevision(value)
    const rows = projectBuiltinVoiceCatalog({ snapshot: value, source: 'retained', checkedAt: at }, now)
    expect(rows.find(row => row.providerId === 'fish')).toMatchObject({ sourceStatus: 'blocked', failure: 'incomplete', stale: false })
    expect(rows.find(row => row.providerId === 'browser')!.stale).toBe(false)
    const unavailable = projectBuiltinVoiceCatalog({ snapshot: null, source: 'unavailable', checkedAt: null }, now).find(row => row.providerId === 'fish')!
    expect(unavailable.unavailableCount).toBe(unavailable.entries.length)
  })
})

describe('fixed public metadata transport', () => {
  it('makes a credential-free bounded fixed GET and returns the raw snapshot', async () => {
    const http = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))
    expect(await fetchPublicVoiceCatalog(http)).toBe('{}')
    expect(http).toHaveBeenCalledWith(PUBLIC_VOICE_CATALOG_URL, expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) }))
  })
  it.each([206, 404, 500])('refuses a non-complete HTTP response %s', async status => {
    await expect(fetchPublicVoiceCatalog(async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }))).rejects.toThrow()
  })
  it('refuses invalid UTF8 and an oversized decoded response', async () => {
    await expect(fetchPublicVoiceCatalog(async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }))).rejects.toThrow()
    await expect(fetchPublicVoiceCatalog(async () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }))).rejects.toThrow('public_read_oversized')
  })
})
