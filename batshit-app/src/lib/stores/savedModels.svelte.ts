import type { SavedModel } from '$lib/types/savedModels'

// State management
let savedModels = $state<SavedModel[]>([])
let isLoading = $state(false)
let initialized = false

function setSavedModels(models: SavedModel[]) {
  // Clone to avoid accidental mutation elsewhere
  savedModels = [...models]
  initialized = true
}

function upsertSavedModel(model: SavedModel) {
  const index = savedModels.findIndex((m) => m.id === model.id)
  if (index === -1) {
    savedModels = [model, ...savedModels]
  } else {
    const next = [...savedModels]
    next[index] = model
    savedModels = next
  }
  initialized = true
}

function removeSavedModel(id: string) {
  savedModels = savedModels.filter((m) => m.id !== id)
}

// Load saved models from API
export async function loadSavedModels() {
  // Don't start new load if already loading
  if (isLoading) {
    return
  }

  isLoading = true

  try {
    const response = await fetch('/api/user/saved-models')

    if (response.ok) {
      const data = await response.json()
      // Handle both array response and object with models property
      const models = Array.isArray(data) ? data : data.models || []
      setSavedModels(models)
    } else {
      console.error('[SavedModels Store] Failed response:', response.status, response.statusText)
    }
  } catch (error) {
    console.error('[SavedModels Store] Failed to load saved models:', error)
    savedModels = []
  } finally {
    isLoading = false
  }
}

// Export getters that return reactive state directly
export function getSavedModels(): SavedModel[] {
  return savedModels
}

export function getIsLoading(): boolean {
  return isLoading
}

export function isInitialized(): boolean {
  return initialized
}

export const savedModelsStore = {
  loadSavedModels,
  getSavedModels,
  getIsLoading,
  isInitialized,
  setSavedModels,
  upsertSavedModel,
  removeSavedModel
}

// Named exports for direct use
export { setSavedModels, upsertSavedModel, removeSavedModel }

// Don't auto-initialize - let components control when to load
