/** SA-104 — shared Memory panel view types. */

export interface MemoryEmbeddingDraft {
  lane: 'builtin' | 'preset' | 'local-ai' | 'api'
  modelId: string
  /** preset lane (2026-08-26): the user-facing non-builtin path. */
  preset: {
    presetId: string
    /** Display snapshot of the saved config (server re-snapshots on save). */
    provider: string
    modelName: string
    /** 0 = auto-detect on save. */
    dims: number
    documentPrefix: string
    queryPrefix: string
  }
  /** Legacy raw-field lanes: shown only when already stored. */
  localAi: {
    baseUrl: string
    modelName: string
    apiKey: string
    documentPrefix: string
    queryPrefix: string
    dims: number
  }
  api: {
    provider: string
    modelName: string
    dims: number
  }
}

/** Slim saved-model option for the embedding preset picker. */
export interface MemoryPresetOption {
  id: string
  modelId: string
  modelName: string
  provider: string
  purpose?: string
}
