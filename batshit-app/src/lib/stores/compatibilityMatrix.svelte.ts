import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'

let matrix = $state<CompatibilityMatrixSnapshot | null>(null)
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
  getIsLoading,
  isInitialized,
  setMatrix
}

export { setMatrix }
