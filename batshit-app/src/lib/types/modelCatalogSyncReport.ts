export type CatalogSyncStatus = 'ok' | 'degraded'

export type CatalogSyncTrigger = 'cron' | 'admin-ui' | 'cli' | 'unknown'

export type CatalogSyncSourceStatus = {
  connectionId: string
  ok: boolean
  usedFallback: boolean
  skipped?: boolean
  fetchedCount: number
  /** Missing upstream IDs retained pending retirement evidence; not published deletions. */
  pendingRemovalIds?: string[]
  confirmedRemovalIds?: string[]
  /** Saved IDs excluded by a reviewed connection incompatibility policy, not provider retirement. */
  policyRemovalIds?: string[]
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

/**
 * BL-68: two entries of one connection landed in one merged row. The row keeps
 * the variant it has always published; the others become rows of their own
 * (`split`), unless another row already uses their canonical id (`dropped`).
 */
export type CatalogSyncVariantCollision = {
  group: string
  connectionId: string
  kept: string
  split: string[]
  dropped: string[]
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
  /** BL-68: absent on reports stored before 2026-09-22. */
  variantCollisions?: CatalogSyncVariantCollision[]
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
