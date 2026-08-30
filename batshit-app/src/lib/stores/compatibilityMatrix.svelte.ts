import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'
import type { N8nCompatibilitySyncStatus } from '$lib/server/services/n8nParameterCompatibility'

export type N8nCompatibilityState = {
  hasWorkflowSubagents: boolean
  localSnapshotAvailable: boolean
  fetchedAt: string | null
  syncStatus: N8nCompatibilitySyncStatus | null
}

let matrix = $state<CompatibilityMatrixSnapshot | null>(null)
let n8nState = $state<N8nCompatibilityState>({
  hasWorkflowSubagents: false,
  localSnapshotAvailable: false,
  fetchedAt: null,
  syncStatus: null
})
let isLoading = $state(false)
let initialized = false

function setMatrix(next: CompatibilityMatrixSnapshot | null) {
  matrix = next
  initialized = true
}

export async function loadCompatibilityMatrix() {
  if (isLoading) return
  isLoading = true

  try {
    const response = await fetch('/api/compatibility-matrix')
    if (response.ok) {
      const payload = await response.json()
      const data = payload?.data ?? payload
      if (data && Array.isArray(data.entries)) {
        setMatrix(data)
      } else {
        setMatrix(null)
      }
      const nextN8nState = payload?.n8n
      n8nState = {
        hasWorkflowSubagents: nextN8nState?.hasWorkflowSubagents === true,
        localSnapshotAvailable: nextN8nState?.localSnapshotAvailable === true,
        fetchedAt: typeof nextN8nState?.fetchedAt === 'string' ? nextN8nState.fetchedAt : null,
        syncStatus:
          nextN8nState?.syncStatus && typeof nextN8nState.syncStatus === 'object'
            ? nextN8nState.syncStatus
            : null
      }
    } else {
      console.error('[CompatibilityMatrix Store] Failed response:', response.status, response.statusText)
      setMatrix(null)
    }
  } catch (error) {
    console.error('[CompatibilityMatrix Store] Failed to load compatibility matrix:', error)
    setMatrix(null)
  } finally {
    isLoading = false
  }
}

export function getCompatibilityMatrix(): CompatibilityMatrixSnapshot | null {
  return matrix
}

export function getMatrixEntries() {
  return matrix?.entries ?? []
}

export function getN8nState(): N8nCompatibilityState {
  return n8nState
}

export function getIsLoading(): boolean {
  return isLoading
}

export function isInitialized(): boolean {
  return initialized
}

export const compatibilityMatrixStore = {
  loadCompatibilityMatrix,
  getCompatibilityMatrix,
  getMatrixEntries,
  getN8nState,
  getIsLoading,
  isInitialized,
  setMatrix
}

export { setMatrix }
