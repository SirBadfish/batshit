import type { ModelPurpose, ModelTransport } from '$lib/types/savedModels'

export type CatalogModelTransport = ModelTransport | 'local'

export type CatalogModelVariantSource = 'vercel' | 'openrouter' | 'manual' | 'direct'

export interface CatalogModelIdVariant {
  developerId: string
  modelId: string
  effectiveId: string
  source: CatalogModelVariantSource
}

export interface CatalogModel {
  id: string
  canonicalId?: string
  provider: string
  upstreamProvider?: string | null
  name: string
  displayName: string
  description?: string
  tags?: string[]
  features?: Record<string, any>
  pricing?: any
  contextWindow?: number
  maxOutputTokens?: number
  category?: string
  purpose?: ModelPurpose
  idVariants?: Record<string, CatalogModelIdVariant>
  source?: string
  transport?: CatalogModelTransport
  connectionId?: string | null
  availableConnections?: string[]
}

export type CatalogConnectionStatus = 'ready' | 'locked'

export interface CatalogConnectionOption {
  id: string
  label: string
  transport: ModelTransport
  service?: string | null
  providers?: string[] | null
  description?: string
  status: CatalogConnectionStatus
  lockedReason?: string
  setupCommand?: string
  statusCommand?: string
  setupContext?: 'docker' | 'native'
  setupWorkingDirectory?: string
  n8nStatus?: CatalogConnectionStatus | 'unknown'
  n8nDescription?: string
  requiredN8NCredentials?: string[]
}
