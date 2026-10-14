export type ArtifactModelMode = 'basic' | 'advanced'

export type ArtifactModelRole = 'primary' | 'visual' | 'audio' | 'utility'

export type ArtifactModelRoleSource = 'auto' | 'preset' | 'manual' | 'primary' | 'none'

// SA-072 P2: `pinokio_app` runs a Pinokio-managed app's own API through `metadata.pinokio_runtime`.
export type ArtifactBrainType = 'built_in' | 'webhook' | 'n8n_workflow' | 'custom_webhook' | 'pinokio_app' | 'none'

export interface ArtifactModelRoleConfig {
  source: ArtifactModelRoleSource
  presetId?: string | null
  modelId?: string | null
}

export interface ArtifactModelConfig {
  mode: ArtifactModelMode
  primary: ArtifactModelRoleConfig
  visual?: ArtifactModelRoleConfig
  audio?: ArtifactModelRoleConfig
  utility?: ArtifactModelRoleConfig
}
