/** Shared model identity contracts; independent of saved presets, catalog and reasoning evidence. */
export type ModelTransport = 'vercel-gateway' | 'direct' | 'openrouter'

export type ModelPurpose = 'chat' | 'visual' | 'audio' | 'utility'

export interface ModelConnectionInfo {
  id?: string
  type: ModelTransport
  service?: string
  useDeveloperPrefix?: boolean
}
