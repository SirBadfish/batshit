export interface AutomaticBackupConfig {
  revision: string
  ownerUserId: string
  enabled: boolean
  cadence: 'daily' | 'weekly'
  folder: string | null
  afterUpdates: boolean
  enabledAt: string | null
}

export interface AutomaticBackupStartup {
  ready: boolean
  buildId: string
  dataGeneration: string
  error?: string
  warning?: string
}

export interface AutomaticBackupView {
  config: AutomaticBackupConfig
  defaultFolder: string
  startup: AutomaticBackupStartup
  running: boolean
  lastSuccess: { createdAt: string; path: string; bytes: number } | null
  retainedCount: number
  nextDueAt: string | null
  lastAttemptAt: string | null
  error: string | null
  cleanupFailures: Array<{ path: string; message: string }>
  preservedFolders: Array<{ folder: string; backupCount: number }>
  preservedFiles: Array<{ path: string; originalPath: string; message: string }>
  unavailableCopies: Array<{ path: string; state: 'missing' | 'changed' | 'unreadable'; message: string }>
}
