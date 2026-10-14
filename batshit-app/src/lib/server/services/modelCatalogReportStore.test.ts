/**
 * BL-255: the degraded-run streak is kept with each stored report, so it keeps
 * counting past the 50 reports the index retains, and a healthy run resets it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, unknown>()
const upstashKvGet = vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null))
const upstashKvSet = vi.fn(async (key: string, value: unknown) => {
  store.set(key, value)
})

// The index lock (BL-295) has its own suite: modelCatalogReportStore.concurrency.test.ts.
const withUpstashKvLock = vi.fn(async (_key: string, task: () => Promise<unknown>) => task())

vi.mock('$lib/server/services/upstashKv', () => ({ upstashKvGet, upstashKvSet, withUpstashKvLock }))

const { storeCatalogSyncReport } = await import('./modelCatalogReportStore')

const INDEX_KEY = 'catalog:reports:index:v1'

function report(status: 'ok' | 'degraded', fetchedAt: string) {
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

function indexEntry(index: number, status: 'ok' | 'degraded', warningStreak?: number) {
  const fetchedAt = new Date(Date.UTC(2026, 7, 1) + index * 3_600_000).toISOString()
  return {
    id: fetchedAt,
    fetchedAt,
    status,
    trigger: 'cron',
    models: 1,
    counts: {},
    diffTotals: { addedModelsTotal: 0, removedModelsTotal: 0, connectionChangesTotal: 0 },
    ...(warningStreak === undefined ? {} : { warningStreak })
  }
}

/** The index as it stood on 2026-09-25: 50 retained reports, all degraded, newest first. */
function fullDegradedIndex(newestStreak: number) {
  return Array.from({ length: 50 }, (_, offset) =>
    indexEntry(100 - offset, 'degraded', newestStreak - offset)
  )
}

beforeEach(() => {
  store.clear()
  upstashKvGet.mockClear()
  upstashKvSet.mockClear()
})

describe('BL-255 catalog warning streak', () => {
  it('keeps counting past the 50 reports the index retains', async () => {
    store.set(INDEX_KEY, fullDegradedIndex(51))

    const stored = await storeCatalogSyncReport({
      trigger: 'cron',
      report: report('degraded', '2026-09-26T11:00:00.000Z')
    })

    expect(stored.warningStreak).toBe(52)
    expect(stored.warningAlert?.streak).toBe(52)
    expect(stored.warningAlert?.message).toContain('52 consecutive runs')
    const index = store.get(INDEX_KEY) as Array<{ warningStreak: number }>
    expect(index).toHaveLength(50)
    expect(index[0].warningStreak).toBe(52)
  })

  it('grows by one on each further degraded run', async () => {
    store.set(INDEX_KEY, fullDegradedIndex(51))
    await storeCatalogSyncReport({ trigger: 'cron', report: report('degraded', '2026-09-26T11:00:00.000Z') })
    const next = await storeCatalogSyncReport({
      trigger: 'cli',
      report: report('degraded', '2026-09-27T11:00:00.000Z')
    })
    expect(next.warningStreak).toBe(53)
  })

  it('a healthy run resets the streak and clears the alert, and the next bad run starts at 1', async () => {
    store.set(INDEX_KEY, fullDegradedIndex(51))

    const healthy = await storeCatalogSyncReport({
      trigger: 'cron',
      report: report('ok', '2026-09-26T11:00:00.000Z')
    })
    expect(healthy.warningStreak).toBe(0)
    expect(healthy.warningAlert).toBeNull()

    const afterHealthy = await storeCatalogSyncReport({
      trigger: 'cron',
      report: report('degraded', '2026-09-27T11:00:00.000Z')
    })
    expect(afterHealthy.warningStreak).toBe(1)
    expect(afterHealthy.warningAlert).toBeNull()
  })

  it('counts an older index whose entries carry no stored streak (the control for legacy reports)', async () => {
    store.set(INDEX_KEY, [
      indexEntry(3, 'degraded'),
      indexEntry(2, 'degraded'),
      indexEntry(1, 'ok'),
      indexEntry(0, 'degraded')
    ])
    const stored = await storeCatalogSyncReport({
      trigger: 'cron',
      report: report('degraded', '2026-09-26T11:00:00.000Z')
    })
    expect(stored.warningStreak).toBe(3)
  })

  it('does not count a re-stored report twice', async () => {
    const first = await storeCatalogSyncReport({ trigger: 'cron', report: report('degraded', '2026-09-26T11:00:00.000Z') })
    expect(first.warningStreak).toBe(1)
    const again = await storeCatalogSyncReport({ trigger: 'cron', report: report('degraded', '2026-09-26T11:00:00.000Z') })
    expect(again.warningStreak).toBe(1)
  })
})
