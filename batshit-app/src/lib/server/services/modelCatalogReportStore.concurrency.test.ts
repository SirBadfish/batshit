/**
 * BL-295: two catalog sync reports stored at the same time (the daily cron and a
 * manual Admin sync) each read the index, add their own entry, and write the
 * whole index back, so the second write erased the first run's entry.
 *
 * This drives the real report store and the real Upstash helper against a small
 * fake of Upstash's REST API (GET /get/<key>, POST /set/<key>, and a command
 * array POSTed to the base URL), with every index read held back one timer tick
 * so the two stores interleave the way two server processes do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE = 'https://kv.zcmodels.invalid'
const INDEX_KEY = 'catalog:reports:index:v1'

type Stored = { value: string; expiresAt: number | null }

function fakeUpstash() {
  const store = new Map<string, Stored>()
  const commands: string[][] = []
  const live = (key: string) => {
    const hit = store.get(key)
    if (!hit) return null
    if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
      store.delete(key)
      return null
    }
    return hit
  }
  const reply = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 })

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = decodeURIComponent(url.pathname)
    if (method === 'GET' && path.startsWith('/get/')) {
      const key = path.slice('/get/'.length)
      // Read now, answer a tick later: the other writer runs in between, as
      // it does when two server processes store a report at the same time.
      const value = live(key)?.value ?? null
      await new Promise((resolve) => setTimeout(resolve, 5))
      return reply(value)
    }
    if (method === 'POST' && path.startsWith('/set/')) {
      store.set(path.slice('/set/'.length), { value: String(init?.body), expiresAt: null })
      return reply('OK')
    }
    if (method === 'POST' && (path === '/' || path === '')) {
      const command = JSON.parse(String(init?.body)) as string[]
      commands.push(command)
      const [name, ...args] = command
      if (name.toUpperCase() === 'SET') {
        const [key, value, ...options] = args
        const upper = options.map((option) => String(option).toUpperCase())
        const pxAt = upper.indexOf('PX')
        if (upper.includes('NX') && live(key)) return reply(null)
        store.set(key, { value, expiresAt: pxAt >= 0 ? Date.now() + Number(options[pxAt + 1]) : null })
        return reply('OK')
      }
      if (name.toUpperCase() === 'EVAL') {
        // The compare-and-delete release: delete KEYS[1] only while it still holds ARGV[1].
        const [, numKeys, key, token] = args
        expect(numKeys).toBe('1')
        if (live(key)?.value === token) {
          store.delete(key)
          return reply(1)
        }
        return reply(0)
      }
      return new Response(JSON.stringify({ error: `unsupported ${name}` }), { status: 400 })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  })

  return { store, commands, fetchImpl }
}

function report(fetchedAt: string, status: 'ok' | 'degraded' = 'ok') {
  return {
    status,
    fetchedAt,
    counts: {},
    models: 1,
    sources: [],
    diff: {
      addedModelsTotal: 0,
      removedModelsTotal: 0,
      connectionChangesTotal: 0,
      addedModels: [],
      removedModels: [],
      connectionChanges: [],
      truncated: false
    }
  }
}

let upstash: ReturnType<typeof fakeUpstash>

beforeEach(() => {
  upstash = fakeUpstash()
  vi.stubGlobal('fetch', upstash.fetchImpl)
  vi.stubEnv('KV_REST_API_URL', BASE)
  vi.stubEnv('KV_REST_API_TOKEN', 'zcmodels-write-token')
  vi.stubEnv('KV_REST_API_READ_ONLY_TOKEN', 'zcmodels-read-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('BL-295 two catalog reports stored at once', () => {
  it('keeps both runs in the report index', async () => {
    const { storeCatalogSyncReport } = await import('./modelCatalogReportStore')

    await Promise.all([
      storeCatalogSyncReport({ trigger: 'cron', report: report('2026-09-27T06:00:00.000Z') }),
      storeCatalogSyncReport({ trigger: 'admin-ui', report: report('2026-09-27T06:00:01.000Z') })
    ])

    const index = JSON.parse(upstash.store.get(INDEX_KEY)!.value) as Array<{ id: string }>
    expect(index.map((entry) => entry.id).sort()).toEqual([
      '2026-09-27T06:00:00.000Z',
      '2026-09-27T06:00:01.000Z'
    ])
    // Both records exist, and the lock is gone once both are done.
    expect(upstash.store.has('catalog:reports:v1:2026-09-27T06:00:00.000Z')).toBe(true)
    expect(upstash.store.has('catalog:reports:v1:2026-09-27T06:00:01.000Z')).toBe(true)
    expect([...upstash.store.keys()].filter((key) => key.includes('lock'))).toEqual([])
  })

  it('counts a degraded streak across two degraded runs stored at once', async () => {
    const { storeCatalogSyncReport } = await import('./modelCatalogReportStore')

    const stored = await Promise.all([
      storeCatalogSyncReport({ trigger: 'cron', report: report('2026-09-27T06:00:00.000Z', 'degraded') }),
      storeCatalogSyncReport({ trigger: 'admin-ui', report: report('2026-09-27T06:00:01.000Z', 'degraded') })
    ])

    expect(stored.map((entry) => entry.warningStreak).sort()).toEqual([1, 2])
  })
})

describe('BL-295 review: no Upstash call made for a report can hang past the lock', () => {
  it('gives every call a time limit, so a stuck request cannot outlast the 30 s lock', async () => {
    const { storeCatalogSyncReport } = await import('./modelCatalogReportStore')

    await storeCatalogSyncReport({ trigger: 'cron', report: report('2026-09-27T06:00:00.000Z') })

    const calls = upstash.fetchImpl.mock.calls.map(([input, init]) => ({
      what: `${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input)).pathname}`,
      limited: init?.signal instanceof AbortSignal
    }))
    // The lock, the index read, the three writes, and the release.
    expect(calls).toHaveLength(6)
    expect(calls.filter((call) => !call.limited)).toEqual([])
  })
})
