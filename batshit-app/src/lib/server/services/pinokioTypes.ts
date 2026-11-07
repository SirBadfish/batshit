/** Shared Pinokio result contracts; no provider/service runtime dependency. */
export type PinokioUnavailableReason =
  | 'containerized'
  | 'unsupported_platform'
  | 'not_installed'
  | 'unsupported_version'
  | 'pterm_missing'
  | 'not_running'

export type PinokioAppState = 'offline' | 'starting' | 'online'

export interface PinokioAppStatus {
  appId: string
  title: string
  state: PinokioAppState
  running: boolean
  ready: boolean
  readyUrl: string | null
  /** `true` or `false` only after `--probe`; `null` when the probe was not asked for. */
  probe: boolean | null
  path: string | null
  lastError: string | null
  /** Present only for an explicitly selected saved remote machine. */
  machineId?: string
  machineRevision?: number
  machineLabel?: string
  externalReadyUrls?: string[]
  excludedExternalReadyUrls?: number
}

export interface PinokioSearchApp {
  appId: string
  title: string
  description: string | null
  state: PinokioAppState
  running: boolean
  ready: boolean
  readyUrl: string | null
}

export interface PinokioSearchResult {
  query: string
  apps: PinokioSearchApp[]
  /** Apps a peer machine reported; left out, because this story is local only (DL-07). */
  skippedRemote: number
  machineId?: string
  machineRevision?: number
  machineLabel?: string
}

export interface PinokioLogs {
  appId: string
  script: string | null
  lineCount: number | null
  lines: string[]
  truncated: boolean
  machineId?: string
  machineRevision?: number
  machineLabel?: string
}

export interface PinokioRunResult {
  appId: string
  title: string
  /** True when the app was already online and ready: nothing was started. */
  alreadyRunning: boolean
  /** True when the app answered its probe before the wait ended. */
  ready: boolean
  state: PinokioAppState
  readyUrl: string | null
  alsoStarted: string[]
  waitedMs: number
  message: string
  /** The last lines `pterm run` printed, when the app was not ready in time. */
  outputTail?: string[]
  machineId?: string
  machineRevision?: number
  machineLabel?: string
  externalReadyUrls?: string[]
  /** Remote projection inventory, not an attestation that every listed app was started. */
  declaredAlsoStarts?: string[]
  launchFingerprint?: string
  launchState?: 'ready' | 'pending' | 'unknown'
  readiness?: 'native_http_probe' | 'unknown'
  nativeScriptReady?: null
  nativeControlOutcome?: 'blocked' | 'cancelled'
  observationEnded?: 'cancelled' | 'timeout'
  dependencyRead?: 'native_projection_unattested'
}

export type PinokioFailureKind = 'unavailable' | 'not_found' | 'refused' | 'error'

export type PinokioOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false
      kind: PinokioFailureKind
      message: string
      reason?: PinokioUnavailableReason
      code?: string
      /** A short excerpt of what `pterm` printed, for an unrecognised answer. */
      raw?: string
    }

export interface PinokioStartPreview {
  appId: string
  title: string
  state: PinokioAppState
  ready: boolean
  /** Recursive REQUIRES inventory, sorted. Remote native metadata is explicitly unattested. */
  alsoStarts: string[]
  machineId?: string
  machineRevision?: number
  machineLabel?: string
  launchFingerprint?: string
  dependencyRead?: 'native_projection_unattested'
}
