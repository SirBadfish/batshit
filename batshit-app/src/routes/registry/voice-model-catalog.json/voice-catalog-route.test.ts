// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries } from '$lib/utils/builtinVoiceCatalogProjection'
import { runVoiceCatalogCasAttempt } from '$lib/utils/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot } from '$lib/types/builtinVoiceCatalog'
const read = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/upstashKv', () => ({ upstashKvGetRaw: read }))
import { GET } from './+server'

beforeEach(() => { read.mockReset() })
describe('held public voice catalog route', () => {
  it('reports no data without initialization or any write', async () => {
    read.mockResolvedValue(null)
    const response = await GET({} as never)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(read).toHaveBeenCalledExactlyOnceWith('voice-model-catalog:v1', { allowWriteTokenFallback: false, required: true, timeoutMs: 5000 })
  })
  it.each(['{broken', 'null', JSON.stringify({ schemaVersion: 2 })])('keeps corrupt data unavailable: %s', async raw => {
    read.mockResolvedValue(raw)
    const response = await GET({} as never)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Voice catalog is unavailable.' })
  })
  it('never reflects upstream error details', async () => {
    read.mockRejectedValue(Error('PRIVATE_UPSTREAM_BODY'))
    const response = await GET({} as never)
    expect(await response.text()).not.toContain('PRIVATE_UPSTREAM_BODY')
  })
  it('serves only the verified finite snapshot and keeps its digest/order', async () => {
    const nowMs = Date.now(), at = new Date(nowMs).toISOString()
    const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser'
      ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
      : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries: bundledVoiceCatalogEntries(id) }])) as BuiltinVoiceCatalogSnapshot['providers']
    const proposed = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'absent' }), collect: async () => providers, compareAndSet: async () => { throw Error('No write in route proof') } }, { initializeAbsent: true, nowMs })
    read.mockResolvedValue(JSON.stringify(proposed.snapshot))
    const response = await GET({} as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await response.json()).toEqual(proposed.snapshot)
  })
})
