export type BuiltinVoiceProviderId =
  | 'browser' | 'google' | 'openai' | 'elevenlabs' | 'deepgram' | 'fish' | 'mistral'
  | 'minimax' | 'mimo' | 'alibaba' | 'inworld' | 'cartesia' | 'async' | 'stepfun' | 'azure'

export type BuiltinVoiceLane = 'tts-batch' | 'tts-direct-stream' | 'stt-recorded' | 'stt-direct-realtime'
export type VoiceCatalogAdmission = 'qualified' | 'candidate' | 'blocked'
export type VoiceCatalogBlockReason = 'contract-changed' | 'profile-unavailable' | 'qualification-required'
export type VoiceCatalogFailure = 'network' | 'rate-limit' | 'auth' | 'malformed' | 'incomplete' | 'contract-changed'

/** Public facts only. An entry never carries a transport target, option mapping or authority. */
export interface BuiltinVoiceCatalogEntry {
  modelId: string
  label: string
  lane: BuiltinVoiceLane
  admission: VoiceCatalogAdmission
  compatibilityProfileId?: string
  qualificationRuleId?: string
  requalifiedFrom?: VoiceCatalogRecoveryAnchor[]
  qualifiedAt: string | null
  provenance: 'qualified-source' | 'bundled-legacy'
  evidenceUrls: string[]
  blockedReason?: VoiceCatalogBlockReason
  release: 'unknown' | 'stable' | 'preview' | 'deprecated'
  shutdownAt?: string
}

export interface BuiltinVoiceProviderCatalog {
  sourceStatus: 'verified' | 'blocked' | 'runtime-owned'
  discoveryCoverage: 'complete' | 'partial' | 'unknown' | 'not-applicable'
  qualificationCoverage: 'complete' | 'pending' | 'blocked' | 'not-applicable'
  lastAttemptAt: string
  lastVerifiedAt?: string
  sourceUrls: string[]
  entries: BuiltinVoiceCatalogEntry[]
  failure?: VoiceCatalogFailure
}

export interface VoiceCatalogOrder {
  generation: number
  sequence: number
  revision: string
}

/** Bounded proof of the exact blocked catalog cut covered by an approved recovery. */
export interface VoiceCatalogRecoveryAnchor {
  compatibility: string
  order: VoiceCatalogOrder
}

export interface BuiltinVoiceCatalogSnapshot extends VoiceCatalogOrder {
  schemaVersion: 1
  generatedAt: string
  resetFrom?: VoiceCatalogOrder
  providers: Record<BuiltinVoiceProviderId, BuiltinVoiceProviderCatalog>
}

/** A compiled identity binding, not a remotely supplied strategy. */
export interface BuiltinVoiceCatalogProfile {
  readonly id: string
  readonly providerId: Exclude<BuiltinVoiceProviderId, 'browser'>
  readonly lane: BuiltinVoiceLane
  readonly version: number
}

export interface BuiltinVoiceCatalogSource {
  /** Provenance allowlist only; this record installs no parser or qualification rule. */
  readonly id: string
  readonly providerId: BuiltinVoiceProviderId
  readonly urls: readonly string[]
}

/** Exact current compiled inventory. Unknown legacy dates remain unknown. */
export interface BuiltinVoiceCatalogBaselineBinding {
  readonly providerId: Exclude<BuiltinVoiceProviderId, 'browser'>
  readonly lane: BuiltinVoiceLane
  readonly modelId: string
  readonly compatibilityProfileId?: string
  readonly admission: 'qualified' | 'candidate'
}

export interface BuiltinVoiceCatalogRule {
  readonly id: string
  readonly providerId: Exclude<BuiltinVoiceProviderId, 'browser'>
  readonly lane: BuiltinVoiceLane
  readonly compatibilityProfileId: string
  readonly sourceId: string
  readonly parserId: string
  readonly requalifyFrom: readonly string[]
}

export interface BuiltinVoiceCatalogContext {
  readonly rules: readonly BuiltinVoiceCatalogRule[]
  readonly profiles: readonly BuiltinVoiceCatalogProfile[]
  readonly sources: readonly BuiltinVoiceCatalogSource[]
  readonly baseline: readonly BuiltinVoiceCatalogBaselineBinding[]
}

export type VoiceCatalogView = {
  snapshot: BuiltinVoiceCatalogSnapshot | null
  source: 'remote' | 'retained' | 'bundled' | 'unavailable'
  checkedAt: string | null
  warning?: 'cache-unavailable' | 'remote-unavailable' | 'remote-stale' | 'cache-conflict'
}
