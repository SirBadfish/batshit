export type ClientN8nRuntimeStatus = {
  healthy: boolean
  reachable: boolean
  status: number | null
  effectiveUrl: string
  error: string | null
}

let status = $state<ClientN8nRuntimeStatus | null>(null)
let loading = $state(false)
let error = $state<string | null>(null)
let loadedAt = $state<number | null>(null)

const STATUS_TTL_MS = 10_000

export function getStatus() {
  return status
}

export function getLoading() {
  return loading
}

export function getError() {
  return error
}

export function hasChecked() {
  return status !== null || error !== null
}

export function isUnavailable() {
  return status !== null && status.healthy !== true
}

export async function refreshN8nRuntimeStatus({ force = false }: { force?: boolean } = {}) {
  if (loading) return status
  if (!force && loadedAt && Date.now() - loadedAt < STATUS_TTL_MS) {
    return status
  }

  loading = true
  error = null

  try {
    const response = await fetch('/api/native-tools/n8n/runtime')
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      const message =
        typeof payload?.error === 'string' && payload.error.trim().length > 0
          ? payload.error
          : 'Failed to load n8n runtime status.'
      throw new Error(message)
    }

    status = (await response.json()) as ClientN8nRuntimeStatus
    loadedAt = Date.now()
    return status
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load n8n runtime status.'
    loadedAt = Date.now()
    return status
  } finally {
    loading = false
  }
}
