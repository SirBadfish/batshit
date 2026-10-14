import type { ModelPurpose, ModelTransport } from '$lib/types/savedModels'

/** Published model properties, never an account's effective inference budget. */
export interface PublishedModelMetadata {
  modelId: string
  sourceUrl: string
  verifiedAt: string
  contextWindow: number
  maxOutputTokens: number
  inputModalities: Array<'text' | 'image'>
  outputModalities: Array<'text'>
}

export type CatalogModelTransport = ModelTransport | 'local'

export type CatalogModelVariantSource = 'vercel' | 'openrouter' | 'manual' | 'direct'

/**
 * BL-68: a connection's own limits, when they may differ from the merged row's.
 * `null` means this connection's limit is unknown. It is never a reason to
 * borrow the row's number, which may come from another connection.
 */
export interface CatalogConnectionLimits {
  contextWindow: number | null
  maxOutputTokens: number | null
}

export interface CatalogModelIdVariant {
  developerId: string
  modelId: string
  effectiveId: string
  source: CatalogModelVariantSource
  /**
   * BL-68 / BL-132: this connection's own limits, when they differ from the
   * row's. Always present for a connection that joined the row through a
   * reviewed identity rule (Anthropic's direct API runs Sonnet 4.5 at 200,000
   * tokens while the gateway row lists 1,000,000); present for any other
   * connection whose own source listed a different limit (DeepInfra serving a
   * model at a smaller window than the gateway). A preset for this connection
   * takes these limits instead of the row's.
   */
  limits?: CatalogConnectionLimits
  /**
   * BL-132: this connection's own price (dollars per million tokens), present
   * when its source listed one that differs from the row's. A preset for this
   * connection takes it instead of the row's price.
   */
  pricing?: CatalogConnectionPricing
}

/** BL-132: a connection's own listed price; a missing field is unknown. */
export interface CatalogConnectionPricing {
  input?: number
  output?: number
  cachedInput?: number
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
  publishedMetadata?: PublishedModelMetadata
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
   * BL-104: the local program answers EVERY request with this row's model,
   * whatever model id the request names. KoboldCpp does (outside router mode):
   * a preset saved for another model still runs, on this one. Set only when the
   * program says so; absent everywhere else.
   */
  servesEveryRequest?: boolean
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
