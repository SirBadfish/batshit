import type {
  CatalogSyncReportIndexEntry,
  CatalogSyncStoredReport,
  CatalogSyncTrigger
} from '$lib/types/modelCatalogSyncReport'
import { upstashKvGet, upstashKvSet, withUpstashKvLock } from '$lib/server/services/upstashKv'

const REPORT_PREFIX = 'catalog:reports:v1:'
const REPORT_INDEX_KEY = 'catalog:reports:index:v1'
const REPORT_LATEST_KEY = 'catalog:reports:latest:v1'
/**
 * BL-295: held while a report is stored. The index is one value each store
 * reads, extends and writes back, so two syncs storing at once (the cron and an
 * Admin sync) lost one entry, and both counted the same degraded streak.
 * Lives 30 s at most (`withUpstashKvLock`).
 */
const REPORT_INDEX_LOCK_KEY = 'catalog:reports:index:lock:v1'
/** Each Upstash request made while the lock is held: one read and three parallel writes stay inside its 30 s. */
const LOCKED_REQUEST_TIMEOUT_MS = 10_000
const WARNING_ALERT_STREAK_THRESHOLD = 2

const MAX_INDEX_ENTRIES = 50

function normalizeIndexEntry(raw: any): CatalogSyncReportIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : null
  if (!id) return null

  const fetchedAt = typeof raw.fetchedAt === 'string' ? raw.fetchedAt : id
  const status = raw.status === 'degraded' ? 'degraded' : 'ok'
  const trigger: CatalogSyncTrigger =
    raw.trigger === 'cron' || raw.trigger === 'admin-ui' || raw.trigger === 'cli'
      ? raw.trigger
      : 'unknown'
  const models = typeof raw.models === 'number' ? raw.models : 0
  const counts = raw.counts && typeof raw.counts === 'object' ? (raw.counts as Record<string, number>) : {}
  const diffTotals = raw.diffTotals && typeof raw.diffTotals === 'object'
    ? {
        addedModelsTotal: typeof raw.diffTotals.addedModelsTotal === 'number' ? raw.diffTotals.addedModelsTotal : 0,
        removedModelsTotal: typeof raw.diffTotals.removedModelsTotal === 'number' ? raw.diffTotals.removedModelsTotal : 0,
        connectionChangesTotal: typeof raw.diffTotals.connectionChangesTotal === 'number' ? raw.diffTotals.connectionChangesTotal : 0
      }
    : { addedModelsTotal: 0, removedModelsTotal: 0, connectionChangesTotal: 0 }
  const warningStreak = typeof raw.warningStreak === 'number' ? Math.max(0, raw.warningStreak) : 0
  const warningAlert =
    raw.warningAlert && typeof raw.warningAlert === 'object'
      ? {
          active: Boolean(raw.warningAlert.active),
          streak: typeof raw.warningAlert.streak === 'number' ? Math.max(0, raw.warningAlert.streak) : 0,
          threshold:
            typeof raw.warningAlert.threshold === 'number'
              ? Math.max(1, raw.warningAlert.threshold)
              : WARNING_ALERT_STREAK_THRESHOLD,
          message: typeof raw.warningAlert.message === 'string' ? raw.warningAlert.message : ''
        }
      : null

  return {
    id,
    fetchedAt,
    status,
    trigger,
    models,
    counts,
    diffTotals,
    warningStreak,
    warningAlert
  }
}

/**
 * BL-255: the degraded runs just before this one. The index keeps only the last
 * MAX_INDEX_ENTRIES reports, so counting it alone stops at 50 (the alert said 51
 * forever). Each stored report carries its own streak, so the newest one carries
 * the whole count; counting the index still covers entries stored before the
 * streak was recorded.
 */
function priorDegradedStreak(newestFirst: CatalogSyncReportIndexEntry[]): number {
  let counted = 0
  for (const entry of newestFirst) {
    if (entry.status !== 'degraded') break
    counted += 1
  }
  const newest = newestFirst[0]
  const carried = newest?.status === 'degraded' ? newest.warningStreak : 0
  return Math.max(counted, carried)
}

export async function listCatalogSyncReports(limit = 20): Promise<CatalogSyncReportIndexEntry[]> {
  const raw = await upstashKvGet<any>(REPORT_INDEX_KEY)
  const list = Array.isArray(raw) ? raw : []
  const normalized = list
    .map((entry) => normalizeIndexEntry(entry))
    .filter((entry): entry is CatalogSyncReportIndexEntry => Boolean(entry))

  const safeLimit = Math.max(1, Math.min(limit, 50))
  return normalized.slice(0, safeLimit)
}

export async function getCatalogSyncReport(id: string): Promise<CatalogSyncStoredReport | null> {
  if (!id?.trim()) return null
  const key = `${REPORT_PREFIX}${id.trim()}`
  const raw = await upstashKvGet<any>(key)
  if (!raw || typeof raw !== 'object') return null
  return raw as CatalogSyncStoredReport
}

export async function storeCatalogSyncReport({
  trigger,
  initiatedBy,
  report
}: {
  trigger: CatalogSyncTrigger
  initiatedBy?: string | null
  report: Omit<CatalogSyncStoredReport, 'id' | 'trigger' | 'initiatedBy' | 'warningStreak' | 'warningAlert'>
}): Promise<CatalogSyncStoredReport> {
  return withUpstashKvLock(REPORT_INDEX_LOCK_KEY, () => storeReportHoldingIndexLock({ trigger, initiatedBy, report }))
}

async function storeReportHoldingIndexLock({
  trigger,
  initiatedBy,
  report
}: Parameters<typeof storeCatalogSyncReport>[0]): Promise<CatalogSyncStoredReport> {
  const id = report.fetchedAt
  const existing = await upstashKvGet<any>(REPORT_INDEX_KEY, { timeoutMs: LOCKED_REQUEST_TIMEOUT_MS })
  const list = Array.isArray(existing) ? existing : []
  const normalized = list
    .map((entry) => normalizeIndexEntry(entry))
    .filter((entry): entry is CatalogSyncReportIndexEntry => Boolean(entry))

  const warningStreak =
    report.status === 'degraded'
      ? priorDegradedStreak(normalized.filter((entry) => entry.id !== id)) + 1
      : 0
  const warningAlert =
    warningStreak >= WARNING_ALERT_STREAK_THRESHOLD
      ? {
          active: true,
          streak: warningStreak,
          threshold: WARNING_ALERT_STREAK_THRESHOLD,
          message: `Catalog sync has been degraded for ${warningStreak} consecutive runs.`
        }
      : null

  const stored: CatalogSyncStoredReport = {
    id,
    trigger,
    initiatedBy,
    ...report,
    warningStreak,
    warningAlert
  }

  const indexEntry: CatalogSyncReportIndexEntry = {
    id,
    fetchedAt: stored.fetchedAt,
    status: stored.status,
    trigger: stored.trigger,
    models: stored.models,
    counts: stored.counts,
    diffTotals: {
      addedModelsTotal: stored.diff.addedModelsTotal,
      removedModelsTotal: stored.diff.removedModelsTotal,
      connectionChangesTotal: stored.diff.connectionChangesTotal
    },
    warningStreak: stored.warningStreak,
    warningAlert: stored.warningAlert
  }

  const nextIndex = [indexEntry, ...normalized.filter((entry) => entry.id !== id)]
    .slice(0, MAX_INDEX_ENTRIES)

  await Promise.all([
    upstashKvSet(`${REPORT_PREFIX}${id}`, stored, { timeoutMs: LOCKED_REQUEST_TIMEOUT_MS }),
    upstashKvSet(REPORT_INDEX_KEY, nextIndex, { timeoutMs: LOCKED_REQUEST_TIMEOUT_MS }),
    upstashKvSet(REPORT_LATEST_KEY, id, { timeoutMs: LOCKED_REQUEST_TIMEOUT_MS })
  ])

  return stored
}
