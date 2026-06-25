type ClientEventDetails = Record<string, unknown> | undefined

type ClientEventPayload = {
  kind: string
  scope?: string
  phase?: string
  message?: string
  errorName?: string
  stack?: string
  details?: ClientEventDetails
}

let globalTelemetryInstalled = false

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      errorName: error.name,
      stack: error.stack
    }
  }
  if (typeof error === 'string') {
    return {
      message: error,
      errorName: 'Error',
      stack: undefined
    }
  }
  return {
    message: 'Unknown client error',
    errorName: 'Error',
    stack: undefined
  }
}

function buildPayload(payload: ClientEventPayload) {
  const path =
    typeof window === 'undefined'
      ? undefined
      : `${window.location.pathname}${window.location.search}${window.location.hash}`
  return JSON.stringify({
    ...payload,
    path,
    details: {
      userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
      ...payload.details
    }
  })
}

export function logClientEvent(payload: ClientEventPayload, options?: { beacon?: boolean }) {
  if (typeof window === 'undefined') return
  const body = buildPayload(payload)

  if (options?.beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const sent = navigator.sendBeacon(
      '/api/debug/client-events',
      new Blob([body], { type: 'application/json' })
    )
    if (sent) return
  }

  void fetch('/api/debug/client-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true
  }).catch(() => {
    // Client telemetry must never create user-facing failures.
  })
}

export function logClientError(kind: string, error: unknown, details?: ClientEventDetails) {
  const normalized = normalizeError(error)
  logClientEvent({
    kind,
    scope: 'client',
    message: normalized.message,
    errorName: normalized.errorName,
    stack: normalized.stack,
    details
  })
}

export function installGlobalClientTelemetry() {
  if (typeof window === 'undefined' || globalTelemetryInstalled) return
  globalTelemetryInstalled = true

  logClientEvent({
    kind: 'client-session-start',
    scope: 'webview'
  })

  window.addEventListener('error', (event) => {
    logClientEvent({
      kind: 'client-error',
      scope: 'webview',
      message: event.message,
      errorName: event.error instanceof Error ? event.error.name : 'Error',
      stack: event.error instanceof Error ? event.error.stack : undefined,
      details: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      }
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    logClientError('client-unhandled-rejection', event.reason, { source: 'window' })
  })

  window.addEventListener('pagehide', (event) => {
    logClientEvent(
      {
        kind: 'client-pagehide',
        scope: 'webview',
        details: {
          persisted: event.persisted,
          visibilityState: document.visibilityState
        }
      },
      { beacon: true }
    )
  })

  window.addEventListener('beforeunload', () => {
    logClientEvent(
      {
        kind: 'client-beforeunload',
        scope: 'webview',
        details: {
          visibilityState: document.visibilityState
        }
      },
      { beacon: true }
    )
  })
}
