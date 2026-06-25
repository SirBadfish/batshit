export type ArtifactModelMode = 'basic' | 'advanced'

export type ArtifactModelRole = 'primary' | 'visual' | 'audio' | 'utility'

export type ArtifactModelRoleSource = 'auto' | 'preset' | 'manual' | 'primary' | 'none'

export type ArtifactBrainType = 'built_in' | 'webhook' | 'n8n_workflow' | 'custom_webhook' | 'none'

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
