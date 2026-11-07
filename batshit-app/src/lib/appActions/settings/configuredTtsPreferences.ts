export const CONFIGURED_TTS_SEMANTIC_ID = 'agent.voice.tts-selection' as const
export const CONFIGURED_TTS_FIELDS = ['providerId', 'modelId', 'voiceId', 'profileId'] as const
export type ConfiguredTtsField = typeof CONFIGURED_TTS_FIELDS[number]
export type ConfiguredTtsSelection = Readonly<Record<ConfiguredTtsField, string | null>>
export type ConfiguredTtsChanges = Readonly<
  { selection: 'inherit' } |
  { selection: 'provider'; providerId: string; modelId: string | null; voiceId: string | null } |
  { selection: 'profile'; profileId: string }
>
export function validTtsId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && value.trim() === value &&
    new TextEncoder().encode(value).length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
export function validateConfiguredTtsChanges(value: unknown): ConfiguredTtsChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Choose one configured reply voice.')
  const input = value as Record<string, unknown>
  const keys = input.selection === 'inherit' ? ['selection'] : input.selection === 'provider' ? ['selection', 'providerId', 'modelId', 'voiceId'] : input.selection === 'profile' ? ['selection', 'profileId'] : []
  if (!keys.length || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) ||
    input.selection === 'provider' && (!validTtsId(input.providerId) || ![input.modelId, input.voiceId].every(item => item === null || validTtsId(item))) ||
    input.selection === 'profile' && !validTtsId(input.profileId)) throw new Error('Invalid configured reply voice selection.')
  return Object.freeze({ ...input }) as ConfiguredTtsChanges
}

/** Safe Fish source observations; held source authority stays server-private. */
export type ConfiguredTtsAccountReadFailure = 'not_configured' | 'credential_unreadable' | 'source_changed' |
  'unsupported_catalog' | 'list_denied' | 'list_timeout' | 'list_stopped' | 'list_unavailable' | 'invalid_payload' | 'source_limit' | 'continuation_unavailable'
export type ConfiguredFishAccountChoice = Readonly<{
  source: 'provider-list'; providerId: 'fish'; voiceId: string; profileId: null; modelId: null
  label: string; labelTruncated: boolean; modelScope: 'unknown'
}>
/** Internal safe provider page; the later report owner must apply its separate wire/page budget. */
export type ConfiguredFishAccountPage = Readonly<{
  providerId: 'fish'; extent: 'credential-workspace'; observedAt: string; page: number; pageSize: 100
  choices: readonly ConfiguredFishAccountChoice[]; rawCount: number; filteredCount: number; rejectedCount: number
  reportedTotal: number | null; totalExact: boolean | null; windowLimited: boolean | null
  accessibleUpperBound: number | null; maxOffset: number | null
  hasMore: boolean | null; nextPage: number | null; limitReached: boolean
}>
export type ConfiguredFishAccountPageRead = Readonly<{ status: 'listed'; page: ConfiguredFishAccountPage } |
  { status: 'unavailable'; reason: ConfiguredTtsAccountReadFailure }>
export const CONFIGURED_FISH_ACCOUNT_LIMITS = Object.freeze({ pageRows: 32, pageBytes: 8192, heldRows: 1000, heldBytes: 262144, providerPages: 10 })
export type ConfiguredFishAccountQuery = Readonly<{ ttsCatalog: 'account'; ttsProviderId: 'fish'; ttsModelId?: string }>
export function parseConfiguredFishAccountQuery(value: unknown): ConfiguredFishAccountQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Choose one configured Fish account catalog.')
  const query = value as Record<string, unknown>
  if (Reflect.ownKeys(query).some(key => typeof key !== 'string' || !['ttsCatalog', 'ttsProviderId', 'ttsModelId'].includes(key)) || query.ttsCatalog !== 'account' || query.ttsProviderId !== 'fish' ||
      query.ttsModelId !== undefined && !validTtsId(query.ttsModelId)) throw new Error('Fish account choices require their explicit finite query.')
  return Object.freeze({ ttsCatalog: 'account', ttsProviderId: 'fish', ...(typeof query.ttsModelId === 'string' ? { ttsModelId: query.ttsModelId } : {}) })
}
export function isConfiguredFishAccountCursor(value: unknown): value is string {
  return typeof value === 'string' && /^sv1:[a-f0-9]{64}:[1-9][0-9]{0,4}$/.test(value)
}
export type ConfiguredFishAccountReportPage = Readonly<{
  schemaVersion: 1; basis: 'internal-read-snapshot'; domain: 'agent-settings'; detail: 'choices'; change: 'admitted'
  snapshotId: string; observedAt: string; subject: Readonly<{ kind: 'primary'; id: string }>
  manifest: Readonly<{ digest: string; targets: 1; excluded: 0; unavailable: 0 }>
  providerId: 'fish'; modelId: string | null; speechToSpeechLocked: boolean; localChoices: 'independent-configured-query'
  account: Readonly<{
    status: 'listed' | 'unavailable'; reason?: ConfiguredTtsAccountReadFailure
    extent: 'credential-workspace'; modelScope: 'unknown'; observedAt: string | null
    choices: readonly ConfiguredFishAccountChoice[]; observedCount: number; rawCount: number; filteredCount: number; rejectedCount: number
    reportedTotal: number | null; totalExact: boolean | null; windowLimited: boolean | null
    accessibleUpperBound: number | null; maxOffset: number | null; hasMore: boolean | null; providerPages: number; complete: boolean
  }>
  continuation: Readonly<{ totalRows: number; returned: number; remaining: number; nextCursor: string | null }>
}>
