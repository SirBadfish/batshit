export type CatalogSyncStatus = 'ok' | 'degraded'

export type CatalogSyncTrigger = 'cron' | 'admin-ui' | 'cli' | 'unknown'

export type CatalogSyncSourceStatus = {
  connectionId: string
  ok: boolean
  usedFallback: boolean
  skipped?: boolean
  fetchedCount: number
  error?: string
  warning?: string
}

export type CatalogSyncDiffItem = {
  key: string
  displayName: string
  provider?: string
  name?: string
}

export type CatalogConnectionChange = {
  key: string
  displayName: string
  addedConnections: string[]
  removedConnections: string[]
}

export type CatalogSyncDiff = {
  addedModelsTotal: number
  removedModelsTotal: number
  connectionChangesTotal: number
  addedModels: CatalogSyncDiffItem[]
  removedModels: CatalogSyncDiffItem[]
  connectionChanges: CatalogConnectionChange[]
  truncated: boolean
}

export type CatalogSyncWarningAlert = {
  active: boolean
  streak: number
  threshold: number
  message: string
}

export type CatalogSyncStoredReport = {
  id: string
  trigger: CatalogSyncTrigger
  initiatedBy?: string | null
  status: CatalogSyncStatus
  fetchedAt: string
  previousFetchedAt?: string
  counts: Record<string, number>
  models: number
  sources: CatalogSyncSourceStatus[]
  diff: CatalogSyncDiff
  warningStreak: number
  warningAlert?: CatalogSyncWarningAlert | null
}

export type CatalogSyncReportIndexEntry = {
  id: string
  fetchedAt: string
  status: CatalogSyncStatus
  trigger: CatalogSyncTrigger
  models: number
  counts: Record<string, number>
  diffTotals: {
    addedModelsTotal: number
    removedModelsTotal: number
    connectionChangesTotal: number
  }
  warningStreak: number
  warningAlert?: CatalogSyncWarningAlert | null
}
