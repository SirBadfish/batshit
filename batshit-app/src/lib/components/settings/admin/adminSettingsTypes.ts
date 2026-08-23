export const DEFAULT_N8N_EXECUTION_SEARCH_LIMIT = 60
export const MAX_N8N_EXECUTION_SEARCH_LIMIT = 250
export const DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT = 6
export const DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT = 6
export const DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS = 240
export const DEFAULT_DCM_TOOL_NAME_THRESHOLD = 6
export const DEFAULT_GOON_LIP_SYNC_LAB_ENABLED = false
export const MAX_DCM_SCHEMA_HINT_LIMIT = 20
export const MIN_DCM_SCHEMA_HINT_MAX_CHARS = 80
export const MAX_DCM_SCHEMA_HINT_MAX_CHARS = 1000
export const MAX_DCM_TOOL_NAME_THRESHOLD = 100

export type NativeWebSearchProvider = 'duckduckgo-html' | 'exa' | 'perplexity'
export type ExaSearchType = 'auto' | 'fast' | 'neural' | 'deep'

export const DEFAULT_WEB_SEARCH_PROVIDER: NativeWebSearchProvider = 'duckduckgo-html'
export const DEFAULT_WEB_SEARCH_EXA_TYPE: ExaSearchType = 'auto'
export const DEFAULT_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE = 1024
export const WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS = [512, 1024, 2048, 4096]

export const WEB_SEARCH_PROVIDER_LABELS: Record<NativeWebSearchProvider, string> = {
  'duckduckgo-html': 'DuckDuckGo (built-in, no key)',
  exa: 'Exa',
  perplexity: 'Perplexity'
}

export const EXA_SEARCH_TYPE_LABELS: Record<ExaSearchType, string> = {
  auto: 'Auto (recommended)',
  fast: 'Fast',
  neural: 'Neural',
  deep: 'Deep'
}

export const WEB_SEARCH_PROVIDER_ALIASES: Record<string, NativeWebSearchProvider> = {
  duckduckgo: 'duckduckgo-html',
  ddg: 'duckduckgo-html',
  'duckduckgo-html': 'duckduckgo-html',
  exa: 'exa',
  perplexity: 'perplexity'
}

export type AdminSettingsState = {
  n8nExecutionSearchLimit: number
  dcmSchemaHintRequiredLimit: number
  dcmSchemaHintOptionalLimit: number
  dcmSchemaHintMaxChars: number
  dcmToolNameThreshold: number
  goonLipSyncLabEnabled: boolean
  webSearchDefaultProvider: NativeWebSearchProvider
  webSearchExaType: ExaSearchType
  webSearchPerplexityMaxTokensPerPage: number
}

export type BackupPreflightSummary = {
  ok: true
  manifest: {
    app: { name: 'Batshit'; version: string }
    createdAt: string
    options: { includeSecrets: boolean }
    contents: {
      redisRecordCount: number
      fileAssetCount: number
      fileAssetBytes: number
      groups: Array<{
        id: string
        label: string
        classification: string
        recordCount: number
        fileAssetCount: number
      }>
    }
    secrets: {
      included: boolean
      excludedRecordCount: number
      redactedFieldCount: number
      warning: string
    }
    externalReferences: string[]
  }
  redisRecordCount: number
  fileAssetCount: number
  fileAssetBytes: number
  requiresDestructiveConfirmation: boolean
  currentRecordCount: number
  sourceUserId: string
  targetUserId: string
  userRemapRequired: boolean
  warnings: string[]
  stage: {
    id: string
    filename: string
    archiveBytes: number
    sha256: string
    expiresAt: string
  }
  disk: {
    requiredBytes: number
    availableBytes: number
    sufficient: boolean
    restoredFileBytes: number
    rollbackBytes: number
    restorePlanBytes: number
  }
}

export type DiagnosticsPreviewSummary = {
  schemaVersion: number
  createdAt: string
  filename: string
  app: {
    name: 'Batshit'
    version: string
  }
  runtime: {
    mode: string
    label: string
    platform: string
    arch: string
    node: string
    pid: number
    uptimeSeconds: number
    cwd: string
  }
  health: {
    ok: boolean
    checks: {
      redis: boolean
      systemPromptDefaults: boolean
    }
    errors: string[]
  }
  environment: Record<string, string | boolean | null>
  contents: {
    included: Array<{
      path: string
      label: string
      description: string
    }>
    logFiles: Array<{
      entryName: string
      source: string
      sizeBytes: number
      includedBytes: number
      truncated: boolean
      modifiedAt: string
      sample: string
    }>
    totalLogBytes: number
  }
  safety: {
    redactionApplied: boolean
    redactionPatterns: string[]
    notIncluded: string[]
    warnings: string[]
  }
}

export type GoonAssetAuditSummary = {
  uploadRecordCount: number
  referencedRecordCount: number
  orphanRecordCount: number
  uploadBytes: number
  orphanBytes: number
  byType: Array<{
    uploadType: string
    uploadRecordCount: number
    referencedRecordCount: number
    orphanRecordCount: number
    uploadBytes: number
    orphanBytes: number
  }>
  orphans: Array<{
    uploadType: string
    filename: string
    size: number
  }>
}

export type GoonAssetCleanupResult = {
  deletedCount: number
  deletedBytes: number
  failed: Array<{ filename: string; uploadType: string; error: string }>
}

export type CoreSystemPromptSummary = {
  id: string
  redisKey: string
  label: string
  description: string
  warning: string
  defaultFile: string
  defaultVersion: string
  matchesDefault: boolean
  customized: boolean
  newDefaultAvailable: boolean
  lastUpdated: string | null
}

export type CoreSystemPromptDetail = CoreSystemPromptSummary & {
  value: string
  defaultValue: string
}

export function formatBackupDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function formatBackupBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

export function formatGoonUploadType(value: string) {
  if (value === 'goons') return 'Goon VRMs'
  return value
    .replace(/^goon_?/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function visibleGoonAssetTypeRows(audit: GoonAssetAuditSummary | null) {
  return (audit?.byType ?? []).filter(
    (entry) => entry.uploadRecordCount > 0 || entry.orphanRecordCount > 0
  )
}

export function clampNumber(value: unknown, min: number, max: number) {
  const num = typeof value === 'number' ? value : parseInt(value as string, 10)
  if (Number.isNaN(num)) return min
  return Math.min(Math.max(num, min), max)
}

export function normalizeWebSearchProvider(value: unknown): NativeWebSearchProvider {
  if (typeof value !== 'string') return DEFAULT_WEB_SEARCH_PROVIDER
  const normalized = value.trim().toLowerCase()
  if (!normalized) return DEFAULT_WEB_SEARCH_PROVIDER
  return WEB_SEARCH_PROVIDER_ALIASES[normalized] ?? DEFAULT_WEB_SEARCH_PROVIDER
}

export function normalizeExaSearchType(value: unknown): ExaSearchType {
  if (typeof value !== 'string') return DEFAULT_WEB_SEARCH_EXA_TYPE
  const normalized = value.trim().toLowerCase()
  if (!normalized) return DEFAULT_WEB_SEARCH_EXA_TYPE
  return normalized === 'fast' || normalized === 'neural' || normalized === 'deep'
    ? normalized
    : DEFAULT_WEB_SEARCH_EXA_TYPE
}

export function normalizeWebSearchProviderForAvailability(
  provider: NativeWebSearchProvider,
  availability: Record<'exa' | 'perplexity', boolean>
): NativeWebSearchProvider {
  if (provider === 'exa' && !availability.exa) return DEFAULT_WEB_SEARCH_PROVIDER
  if (provider === 'perplexity' && !availability.perplexity) return DEFAULT_WEB_SEARCH_PROVIDER
  return provider
}
