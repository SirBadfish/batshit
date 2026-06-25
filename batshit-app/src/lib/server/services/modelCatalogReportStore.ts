import type {
  CatalogSyncReportIndexEntry,
  CatalogSyncStoredReport,
  CatalogSyncTrigger
} from '$lib/types/modelCatalogSyncReport'
import { upstashKvGet, upstashKvSet } from '$lib/server/services/upstashKv'

const REPORT_PREFIX = 'catalog:reports:v1:'
const REPORT_INDEX_KEY = 'catalog:reports:index:v1'
const REPORT_LATEST_KEY = 'catalog:reports:latest:v1'
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
  const id = report.fetchedAt
  const existing = await upstashKvGet<any>(REPORT_INDEX_KEY)
  const list = Array.isArray(existing) ? existing : []
  const normalized = list
    .map((entry) => normalizeIndexEntry(entry))
    .filter((entry): entry is CatalogSyncReportIndexEntry => Boolean(entry))

  let priorDegradedStreak = 0
  for (const entry of normalized) {
    if (entry.status !== 'degraded') break
    priorDegradedStreak += 1
  }

  const warningStreak = report.status === 'degraded' ? priorDegradedStreak + 1 : 0
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
    upstashKvSet(`${REPORT_PREFIX}${id}`, stored),
    upstashKvSet(REPORT_INDEX_KEY, nextIndex),
    upstashKvSet(REPORT_LATEST_KEY, id)
  ])

  return stored
}
