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
  /**
   * SA-102 P4 (DL-102-04): what the local program is ACTUALLY running this
   * model with, which is not the same number as `contextWindow`.
   *
   * `contextWindow` is the model's ceiling. LM Studio held Josh's 27B at
   * 208,384 under a 262,144 ceiling; Ollama picks a default from available
   * memory and then silently truncates a prompt that exceeds it. Batshit budgets
   * against this number when it is known, and says "unknown until loaded" when
   * it is not — never quietly falling back to the ceiling.
   */
  localContext?: LocalContextReading | null
  /**
   * SA-102 P4 (DL-102-11): the model format as the program reports it
   * (`mlx`, `gguf`, or anything else). Open-ended text, never a two-value enum:
   * there are more formats than those two and some models report none.
   */
  format?: string | null
}

/** SA-102 P4: where a local context number came from, so the UI can be honest. */
export type LocalContextSource =
  /** The program told us what this model is loaded with right now. */
  | 'loaded'
  /** The model's own maximum. Not what it is running with. */
  | 'model-max'
  /** The program can report it, but the model is not loaded yet. */
  | 'unknown-until-loaded'

export interface LocalContextReading {
  source: LocalContextSource
  /** Present only when `source` is `loaded`. */
  loadedContextWindow?: number | null
  /** The model's ceiling, when the program reports one. */
  maxContextWindow?: number | null
  /** Seconds until the program unloads this instance, when it says. Optional. */
  remainingTtlSeconds?: number | null
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
