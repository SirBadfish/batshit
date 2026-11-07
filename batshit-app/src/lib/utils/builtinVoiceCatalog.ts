import { BUILTIN_VOICE_CATALOG_CONTEXT, BUILTIN_VOICE_PROVIDER_IDS } from '../data/builtinVoiceCatalog'
import { DEEPGRAM_LEGACY_VOICE_BINDINGS } from '../data/deepgramVoiceCatalog'
import type {
  BuiltinVoiceCatalogContext, BuiltinVoiceCatalogEntry, BuiltinVoiceCatalogSnapshot,
  BuiltinVoiceLane, BuiltinVoiceProviderCatalog, BuiltinVoiceProviderId, VoiceCatalogOrder, VoiceCatalogRecoveryAnchor
} from '../types/builtinVoiceCatalog'

const MAX_BYTES = 1024 * 1024
const FACT_SKEW_MS = 5 * 60_000
const encoder = new TextEncoder()
const lanes = ['tts-batch', 'tts-direct-stream', 'stt-recorded', 'stt-direct-realtime'] as const

export class BuiltinVoiceCatalogError extends Error {
  constructor(readonly code: string) { super(`Voice catalog refused: ${code}`) }
}

function refuse(code: string): never { throw new BuiltinVoiceCatalogError(code) }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('object_required')
  const record = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (Object.keys(record).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(record, key))) refuse('unexpected_or_missing_field')
  return record
}
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.length || value !== value.trim() || encoder.encode(value).length > limit || /[\u0000-\u001f\u007f]/.test(value)) refuse('invalid_string')
  return value
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) refuse('invalid_enum')
  return value as T
}
function timestamp(value: unknown, nowMs: number, futureLifecycle = false): string {
  const text = string(value, 32)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) refuse('invalid_timestamp')
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== text.replace('.000Z', 'Z')) refuse('invalid_timestamp')
  if (!futureLifecycle && parsed > nowMs + FACT_SKEW_MS) refuse('future_fact')
  return text
}
function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) refuse('invalid_order')
  return value
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) refuse('invalid_revision')
  return value
}
function order(value: unknown): VoiceCatalogOrder {
  const row = object(value, ['generation', 'sequence', 'revision'])
  return { generation: positiveInteger(row.generation), sequence: positiveInteger(row.sequence), revision: revision(row.revision) }
}
function recoveryAnchors(value: unknown): VoiceCatalogRecoveryAnchor[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) refuse('invalid_recovery_anchors')
  const anchors = value.map(value => {
    const row = object(value, ['compatibility', 'order'])
    return { compatibility: string(row.compatibility, 2048), order: order(row.order) }
  })
  if (new Set(anchors.map(anchor => JSON.stringify([anchor.compatibility, anchor.order.generation]))).size !== anchors.length) refuse('duplicate_recovery_anchor')
  return anchors
}
function urls(value: unknown, providerId: BuiltinVoiceProviderId, context: BuiltinVoiceCatalogContext): string[] {
  if (!Array.isArray(value) || value.length > 8) refuse('invalid_evidence_urls')
  const allowed = new Set(context.sources.filter(source => source.providerId === providerId).flatMap(source => [...source.urls]))
  const result = value.map(item => {
    const text = string(item, 2048)
    let url: URL
    try { url = new URL(text) } catch { return refuse('invalid_evidence_url') }
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(text)) refuse('unapproved_evidence_url')
    return text
  })
  if (new Set(result).size !== result.length) refuse('duplicate_evidence_url')
  return result
}

export function voiceCatalogEntryIdentity(providerId: BuiltinVoiceProviderId, entry: Pick<BuiltinVoiceCatalogEntry, 'lane' | 'modelId'>): string {
  return JSON.stringify([providerId, entry.lane, entry.modelId])
}

function entry(value: unknown, providerId: BuiltinVoiceProviderId, context: BuiltinVoiceCatalogContext, nowMs: number): BuiltinVoiceCatalogEntry {
  const row = object(value, ['modelId', 'label', 'lane', 'admission', 'qualifiedAt', 'provenance', 'evidenceUrls', 'release'], ['compatibilityProfileId', 'qualificationRuleId', 'requalifiedFrom', 'blockedReason', 'shutdownAt'])
  const result: BuiltinVoiceCatalogEntry = {
    modelId: string(row.modelId, 256), label: string(row.label, 200),
    lane: choice(row.lane, lanes), admission: choice(row.admission, ['qualified', 'candidate', 'blocked']),
    qualifiedAt: row.qualifiedAt === null ? null : timestamp(row.qualifiedAt, nowMs),
    provenance: choice(row.provenance, ['qualified-source', 'bundled-legacy']),
    evidenceUrls: urls(row.evidenceUrls, providerId, context), release: choice(row.release, ['unknown', 'stable', 'preview', 'deprecated'])
  }
  if (row.compatibilityProfileId !== undefined) result.compatibilityProfileId = string(row.compatibilityProfileId, 256)
  if (row.qualificationRuleId !== undefined) result.qualificationRuleId = string(row.qualificationRuleId, 256)
  if (row.requalifiedFrom !== undefined) result.requalifiedFrom = recoveryAnchors(row.requalifiedFrom)
  if (row.blockedReason !== undefined) result.blockedReason = choice(row.blockedReason, ['contract-changed', 'profile-unavailable', 'qualification-required'] as const)
  if (row.shutdownAt !== undefined) result.shutdownAt = timestamp(row.shutdownAt, nowMs, true)
  if (result.admission === 'blocked' && !result.blockedReason) refuse('blocked_reason_required')
  if (result.admission === 'qualified' && (!result.compatibilityProfileId || result.blockedReason)) refuse('invalid_qualified_entry')
  if (result.admission === 'qualified' && result.provenance === 'qualified-source' && (!result.qualifiedAt || !result.evidenceUrls.length)) refuse('qualification_evidence_required')
  return result
}

function provider(value: unknown, providerId: BuiltinVoiceProviderId, context: BuiltinVoiceCatalogContext, nowMs: number, observation = false): BuiltinVoiceProviderCatalog {
  const row = object(value, ['sourceStatus', 'discoveryCoverage', 'qualificationCoverage', 'lastAttemptAt', 'sourceUrls', 'entries'], ['lastVerifiedAt', 'failure'])
  if (!Array.isArray(row.entries) || row.entries.length > 1000) refuse('invalid_entries')
  const result: BuiltinVoiceProviderCatalog = {
    sourceStatus: choice(row.sourceStatus, ['verified', 'blocked', 'runtime-owned']),
    discoveryCoverage: choice(row.discoveryCoverage, ['complete', 'partial', 'unknown', 'not-applicable']),
    qualificationCoverage: choice(row.qualificationCoverage, ['complete', 'pending', 'blocked', 'not-applicable']),
    lastAttemptAt: timestamp(row.lastAttemptAt, nowMs), sourceUrls: urls(row.sourceUrls, providerId, context),
    entries: row.entries.map(value => entry(value, providerId, context, nowMs))
  }
  if (row.lastVerifiedAt !== undefined) result.lastVerifiedAt = timestamp(row.lastVerifiedAt, nowMs)
  if (row.failure !== undefined) result.failure = choice(row.failure, ['network', 'rate-limit', 'auth', 'malformed', 'incomplete', 'contract-changed'] as const)
  if (new Set(result.entries.map(value => voiceCatalogEntryIdentity(providerId, value))).size !== result.entries.length) refuse('duplicate_entry')
  if (result.qualificationCoverage === 'complete' && result.entries.some(value => value.admission !== 'qualified')) refuse('qualification_coverage_incomplete')
  if (providerId === 'browser') {
    if (result.sourceStatus !== 'runtime-owned' || result.discoveryCoverage !== 'not-applicable' || result.qualificationCoverage !== 'not-applicable' || result.entries.length || result.sourceUrls.length || result.lastVerifiedAt || result.failure) refuse('browser_is_runtime_owned')
  } else {
    if (result.sourceStatus === 'runtime-owned' || result.discoveryCoverage === 'not-applicable' || result.qualificationCoverage === 'not-applicable') refuse('cloud_is_not_runtime_owned')
    if (result.sourceStatus === 'verified' && (!result.lastVerifiedAt || !result.sourceUrls.length || result.failure)) refuse('verified_source_evidence_required')
    if (result.sourceStatus === 'verified' && !result.entries.length && !observation) refuse('empty_verified_cloud_source')
    if (result.sourceStatus === 'blocked' && !result.failure) refuse('source_failure_required')
  }
  return result
}

/** Strict raw JSON boundary. The detached return contains only the finite public fields. */
export function parseBuiltinVoiceCatalog(json: string, nowMs: number, context: BuiltinVoiceCatalogContext = BUILTIN_VOICE_CATALOG_CONTEXT): BuiltinVoiceCatalogSnapshot {
  if (!Number.isFinite(nowMs)) refuse('invalid_clock')
  if (typeof json !== 'string' || encoder.encode(json).length > MAX_BYTES) refuse('snapshot_too_large')
  let input: unknown
  try { input = JSON.parse(json) } catch { return refuse('malformed_json') }
  const row = object(input, ['schemaVersion', 'generation', 'sequence', 'revision', 'generatedAt', 'providers'], ['resetFrom'])
  if (row.schemaVersion !== 1) refuse('unsupported_schema')
  const records = object(row.providers, BUILTIN_VOICE_PROVIDER_IDS)
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, provider(records[id], id, context, nowMs)])) as BuiltinVoiceCatalogSnapshot['providers']
  const result: BuiltinVoiceCatalogSnapshot = {
    schemaVersion: 1, generation: positiveInteger(row.generation), sequence: positiveInteger(row.sequence),
    revision: revision(row.revision), generatedAt: timestamp(row.generatedAt, nowMs), providers
  }
  if (row.resetFrom !== undefined) result.resetFrom = order(row.resetFrom)
  if (result.generation > 1 && !result.resetFrom) refuse('unlinked_generation')
  if (result.resetFrom && (result.generation !== result.resetFrom.generation + 1 || result.sequence < 1)) refuse('invalid_reset_link')
  for (const provider of Object.values(result.providers)) for (const entry of provider.entries) for (const anchor of entry.requalifiedFrom ?? []) {
    if (anchor.order.generation > result.generation || anchor.order.generation === result.generation && anchor.order.sequence >= result.sequence) refuse('invalid_recovery_anchor_order')
  }
  return result
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? refuse('non_json_value')
}

export function voiceCatalogCanonicalContent(snapshot: BuiltinVoiceCatalogSnapshot): string {
  const { revision: _revision, ...content } = snapshot
  return canonical(content)
}

/** CPU-only WebCrypto; no key, filesystem, network or persistent state. */
export async function voiceCatalogRevision(snapshot: BuiltinVoiceCatalogSnapshot): Promise<string> {
  const bytes = encoder.encode(voiceCatalogCanonicalContent(snapshot))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyBuiltinVoiceCatalog(json: string, nowMs: number, context: BuiltinVoiceCatalogContext = BUILTIN_VOICE_CATALOG_CONTEXT): Promise<BuiltinVoiceCatalogSnapshot> {
  const snapshot = parseBuiltinVoiceCatalog(json, nowMs, context)
  if (await voiceCatalogRevision(snapshot) !== snapshot.revision) refuse('revision_content_mismatch')
  freeze(snapshot)
  return snapshot
}

function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child)
  Object.freeze(value)
}

export function voiceCatalogEntryCompatibility(providerId: BuiltinVoiceProviderId, value: BuiltinVoiceCatalogEntry, context: BuiltinVoiceCatalogContext = BUILTIN_VOICE_CATALOG_CONTEXT): { compatible: boolean; reason?: string } {
  if (value.admission !== 'qualified') return { compatible: false, reason: value.admission === 'blocked' ? value.blockedReason : 'qualification-required' }
  const profile = context.profiles.find(profile => profile.id === value.compatibilityProfileId && profile.providerId === providerId && profile.lane === value.lane)
  if (!profile) return { compatible: false, reason: 'profile-unavailable' }
  const baseline = context.baseline.some(binding => binding.providerId === providerId && binding.lane === value.lane && binding.modelId === value.modelId && binding.compatibilityProfileId === value.compatibilityProfileId && binding.admission === 'qualified') ||
    providerId === 'deepgram' && value.lane === 'tts-batch' && DEEPGRAM_LEGACY_VOICE_BINDINGS.some(binding => binding.modelId === value.modelId && binding.compatibilityProfileId === value.compatibilityProfileId)
  const rule = value.qualificationRuleId && context.rules.find(rule => rule.id === value.qualificationRuleId && rule.providerId === providerId && rule.lane === value.lane && rule.compatibilityProfileId === value.compatibilityProfileId && context.sources.some(source => source.id === rule.sourceId && source.providerId === providerId))
  if (value.qualificationRuleId && !rule) return { compatible: false, reason: 'qualification-rule-unavailable' }
  if (!baseline && (value.provenance !== 'qualified-source' || !rule)) return { compatible: false, reason: value.provenance === 'bundled-legacy' ? 'legacy-binding-unavailable' : 'qualification-rule-unavailable' }
  if (value.provenance === 'qualified-source' && (!value.qualifiedAt || !value.evidenceUrls.length)) return { compatible: false, reason: 'qualification-required' }
  return { compatible: true }
}

function baselineEntries(providerId: BuiltinVoiceProviderId, context: BuiltinVoiceCatalogContext): BuiltinVoiceCatalogEntry[] {
  return context.baseline.filter(binding => binding.providerId === providerId).map(binding => ({
    modelId: binding.modelId, label: binding.modelId, lane: binding.lane, admission: binding.admission,
    ...(binding.compatibilityProfileId ? { compatibilityProfileId: binding.compatibilityProfileId } : {}),
    qualifiedAt: null, provenance: 'bundled-legacy', evidenceUrls: [], release: 'unknown'
  }))
}

/** A10 dependency excludes daily source/attempt/order stamps and unrelated entries. */
export function voiceCatalogCompatibilityFacts(providerId: BuiltinVoiceProviderId, value: BuiltinVoiceCatalogEntry): string {
  return canonical({ providerId, lane: value.lane, modelId: value.modelId, admission: value.admission,
    compatibilityProfileId: value.compatibilityProfileId ?? null, blockedReason: value.blockedReason ?? null,
    eligible: voiceCatalogEntryCompatibility(providerId, value).compatible })
}

export type VoiceCatalogOrderDecision = 'newer' | 'same' | 'stale'

/** Compatibility fingerprint for a distinct exact-target recovery, never a timestamp/order token. */
export function voiceCatalogRestrictionFacts(providerId: BuiltinVoiceProviderId, entry: BuiltinVoiceCatalogEntry): string {
  return canonical({ providerId, lane: entry.lane, modelId: entry.modelId, admission: entry.admission,
    compatibilityProfileId: entry.compatibilityProfileId ?? null, blockedReason: entry.blockedReason ?? null,
    qualificationRuleId: entry.qualificationRuleId ?? null, provenance: entry.provenance })
}
function restrictionFloors(providerId: BuiltinVoiceProviderId, entry: BuiltinVoiceCatalogEntry) {
  const context = BUILTIN_VOICE_CATALOG_CONTEXT
  const profileKnown = context.profiles.some(profile => profile.providerId === providerId && profile.lane === entry.lane && profile.id === entry.compatibilityProfileId)
  const legacy = context.baseline.find(binding => binding.providerId === providerId && binding.lane === entry.lane && binding.modelId === entry.modelId && binding.admission === 'qualified')
    ?? (providerId === 'deepgram' && entry.lane === 'tts-batch' ? DEEPGRAM_LEGACY_VOICE_BINDINGS.find(binding => binding.modelId === entry.modelId) : undefined)
  const ruleKnown = context.rules.some(rule => rule.id === entry.qualificationRuleId && rule.providerId === providerId && rule.lane === entry.lane && rule.compatibilityProfileId === entry.compatibilityProfileId &&
    context.sources.some(source => source.id === rule.sourceId && source.providerId === providerId))
  return {
    block: entry.admission === 'blocked' || entry.blockedReason === 'contract-changed' || entry.blockedReason === 'profile-unavailable',
    unknownProfile: entry.compatibilityProfileId && !profileKnown ? entry.compatibilityProfileId : null,
    protectedProfile: entry.compatibilityProfileId && legacy && legacy.compatibilityProfileId !== entry.compatibilityProfileId ? entry.compatibilityProfileId : null,
    unknownRule: entry.qualificationRuleId && !ruleKnown ? entry.qualificationRuleId : null
  }
}
export function voiceCatalogEntryHasRestriction(providerId: BuiltinVoiceProviderId, entry: BuiltinVoiceCatalogEntry): boolean {
  return Object.values(restrictionFloors(providerId, entry)).some(Boolean)
}
/** One remaining restriction cannot mask the loss of a different previously held floor. */
function retainsRestrictionFloors(providerId: BuiltinVoiceProviderId, previous: BuiltinVoiceCatalogEntry, next: BuiltinVoiceCatalogEntry): boolean {
  const before = restrictionFloors(providerId, previous), after = restrictionFloors(providerId, next)
  return (!before.block || after.block) && (!before.unknownProfile || next.compatibilityProfileId === before.unknownProfile) &&
    (!before.protectedProfile || next.compatibilityProfileId === before.protectedProfile) &&
    (!before.unknownRule || next.qualificationRuleId === before.unknownRule && next.compatibilityProfileId === previous.compatibilityProfileId)
}
const recoveryCovers = (anchor: VoiceCatalogRecoveryAnchor, held: VoiceCatalogOrder): boolean => anchor.order.generation === held.generation &&
  (anchor.order.sequence > held.sequence || anchor.order.sequence === held.sequence && anchor.order.revision === held.revision)

/** Merge coverage without evicting older distinct restrictions; null refuses capacity/conflicts. */
export function mergeVoiceCatalogRecoveryAnchors(previous: readonly VoiceCatalogRecoveryAnchor[] | undefined, next: readonly VoiceCatalogRecoveryAnchor[] | undefined): VoiceCatalogRecoveryAnchor[] | undefined | null {
  const anchors = new Map<string, VoiceCatalogRecoveryAnchor>()
  for (const anchor of [...(previous ?? []), ...(next ?? [])]) {
    const key = JSON.stringify([anchor.compatibility, anchor.order.generation]), prior = anchors.get(key)
    if (prior && prior.order.sequence === anchor.order.sequence && prior.order.revision !== anchor.order.revision) return null
    if (!prior || anchor.order.sequence > prior.order.sequence) anchors.set(key, structuredClone(anchor))
  }
  if (anchors.size > 4) return null
  return anchors.size ? [...anchors.values()] : undefined
}

export function canRequalifyVoiceCatalogEntry(providerId: BuiltinVoiceProviderId, previous: BuiltinVoiceCatalogEntry, next: BuiltinVoiceCatalogEntry, heldOrder?: VoiceCatalogOrder): boolean {
  const rule = BUILTIN_VOICE_CATALOG_CONTEXT.rules.find(rule => rule.id === next.qualificationRuleId && rule.providerId === providerId && rule.lane === next.lane && rule.compatibilityProfileId === next.compatibilityProfileId)
  return voiceCatalogEntryIdentity(providerId, previous) === voiceCatalogEntryIdentity(providerId, next) &&
    Boolean(heldOrder && next.requalifiedFrom?.some(anchor => anchor.compatibility === voiceCatalogRestrictionFacts(providerId, previous) && recoveryCovers(anchor, heldOrder))) &&
    Boolean(rule?.requalifyFrom.includes(previous.compatibilityProfileId ?? '')) &&
    next.provenance === 'qualified-source' && voiceCatalogEntryCompatibility(providerId, next).compatible
}

/** Ordinary refresh conserves every exact identity and restriction; only an exact attested transition recovers. */
export function assertVoiceCatalogBlockConservation(previous: BuiltinVoiceCatalogSnapshot | null, incoming: BuiltinVoiceCatalogSnapshot): void {
  if (!previous) return
  for (const providerId of BUILTIN_VOICE_PROVIDER_IDS) for (const entry of previous.providers[providerId].entries) {
    const next = incoming.providers[providerId].entries.find(value => voiceCatalogEntryIdentity(providerId, value) === voiceCatalogEntryIdentity(providerId, entry))
    if (!next) refuse('known_identity_missing')
    for (const anchor of entry.requalifiedFrom ?? []) if (!next.requalifiedFrom?.some(value => value.compatibility === anchor.compatibility && recoveryCovers(value, anchor.order))) refuse('known_recovery_coverage_missing')
    if (!retainsRestrictionFloors(providerId, entry, next) &&
      (previous.generation !== incoming.generation || !canRequalifyVoiceCatalogEntry(providerId, entry, next, previous))) refuse('known_block_recovery_unqualified')
  }
}

/** Both inputs must have passed verifyBuiltinVoiceCatalog; this never writes a cache. */
export function compareVoiceCatalogAdmission(current: BuiltinVoiceCatalogSnapshot | null, incoming: BuiltinVoiceCatalogSnapshot): VoiceCatalogOrderDecision {
  if (!current) return 'newer'
  if (incoming.generation < current.generation) return 'stale'
  if (incoming.generation === current.generation) {
    if (incoming.sequence < current.sequence) return 'stale'
    if (incoming.sequence === current.sequence) {
      if (incoming.revision !== current.revision || voiceCatalogCanonicalContent(incoming) !== voiceCatalogCanonicalContent(current)) refuse('equal_order_different_content')
      return 'same'
    }
    return 'newer'
  }
  const from = incoming.resetFrom
  if (incoming.generation !== current.generation + 1 || !from || from.generation !== current.generation || from.sequence < current.sequence || (from.sequence === current.sequence && from.revision !== current.revision)) refuse('unlinked_generation')
  return 'newer'
}

function retainEntryContinuity(previous: BuiltinVoiceCatalogEntry | undefined, next: BuiltinVoiceCatalogEntry): BuiltinVoiceCatalogEntry | null {
  const anchors = mergeVoiceCatalogRecoveryAnchors(previous?.requalifiedFrom, next.admission === 'qualified' ? next.requalifiedFrom : undefined)
  if (anchors === null) return null
  const { requalifiedFrom: _anchors, ...entry } = structuredClone(next)
  const shutdown = previous?.shutdownAt && !next.shutdownAt, deprecated = previous?.release === 'deprecated' && next.release !== 'deprecated'
  const evidenceUrls = shutdown || deprecated ? [...new Set([...previous!.evidenceUrls, ...next.evidenceUrls])] : next.evidenceUrls
  if (evidenceUrls.length > 8) refuse('retained_evidence_limit')
  return { ...entry, ...(anchors ? { requalifiedFrom: anchors } : {}), ...(shutdown ? { shutdownAt: previous!.shutdownAt } : {}), ...(deprecated ? { release: 'deprecated' as const } : {}), evidenceUrls }
}

/** Source failures/absence retain exact metadata. Known blocks are never silently requalified. */
export function retainVoiceProviderEntries(providerId: BuiltinVoiceProviderId, previous: BuiltinVoiceProviderCatalog, observed: BuiltinVoiceProviderCatalog, previousOrder?: VoiceCatalogOrder): BuiltinVoiceProviderCatalog {
  const next = structuredClone(observed)
  if (providerId !== 'browser' && next.sourceStatus === 'verified' && !next.entries.length) {
    next.sourceStatus = 'blocked'
    next.failure = 'incomplete'
    next.discoveryCoverage = 'unknown'
  }
  if (next.sourceStatus === 'blocked') return { ...next, entries: structuredClone(previous.entries), lastVerifiedAt: previous.lastVerifiedAt,
    qualificationCoverage: previous.qualificationCoverage }
  const entries = new Map(previous.entries.map(value => [voiceCatalogEntryIdentity(providerId, value), structuredClone(value)]))
  for (const value of observed.entries) {
    const key = voiceCatalogEntryIdentity(providerId, value)
    let prior = entries.get(key)
    // Fresh named lifecycle evidence cannot restore compatibility or erase a known warning.
    if (prior && value.evidenceUrls.length && (value.shutdownAt || value.release === 'deprecated')) {
      const evidenceUrls = [...new Set([...prior.evidenceUrls, ...value.evidenceUrls])]
      if (evidenceUrls.length > 8) refuse('retained_evidence_limit')
      prior = { ...prior, ...(value.shutdownAt ? { shutdownAt: value.shutdownAt } : {}), ...(value.release === 'deprecated' ? { release: 'deprecated' as const } : {}), evidenceUrls }
      entries.set(key, prior)
    }
    // Recovery requires a distinct exact qualification owner, not a daily-list observation.
    if (prior && !retainsRestrictionFloors(providerId, prior, value) && !canRequalifyVoiceCatalogEntry(providerId, prior, value, previousOrder)) continue
    const explicitIncompatibility = value.evidenceUrls.length > 0 && (
      value.admission === 'blocked' && value.blockedReason === 'contract-changed'
      || value.compatibilityProfileId !== undefined && value.compatibilityProfileId !== prior?.compatibilityProfileId)
    // Missing/partial qualification facts do not invalidate a retained qualified binding.
    if (prior?.admission === 'qualified' && value.admission !== 'qualified' && !explicitIncompatibility) continue
    if (value.admission === 'blocked' && prior) {
      const evidenceUrls = [...new Set([...prior.evidenceUrls, ...value.evidenceUrls])]
      if (evidenceUrls.length > 8) refuse('retained_evidence_limit')
      const retained = retainEntryContinuity(prior, { ...prior, ...structuredClone(value), qualifiedAt: value.qualifiedAt ?? prior.qualifiedAt,
        compatibilityProfileId: value.compatibilityProfileId ?? prior.compatibilityProfileId, evidenceUrls })
      if (retained) entries.set(key, retained)
    } else {
      const retained = retainEntryContinuity(prior, value)
      if (retained) entries.set(key, retained)
    }
  }
  const values = [...entries.values()]
  const qualificationCoverage = values.some(value => value.admission === 'blocked') ? 'blocked'
    : values.some(value => value.admission === 'candidate') ? 'pending' : observed.qualificationCoverage
  return { ...next, entries: values, qualificationCoverage }
}

/** Builds an expected-value CAS proposal only; a driver must fail a losing CAS, never rebuild. */
export function nextVoiceCatalogOrder(previous: VoiceCatalogOrder | null): Pick<VoiceCatalogOrder, 'generation' | 'sequence'> {
  if (!previous) return { generation: 1, sequence: 1 }
  positiveInteger(previous.generation)
  positiveInteger(previous.sequence)
  revision(previous.revision)
  if (!Number.isSafeInteger(previous.sequence) || previous.sequence >= Number.MAX_SAFE_INTEGER) refuse('sequence_exhausted')
  return { generation: previous.generation, sequence: previous.sequence + 1 }
}

export type VoiceCatalogRead = { state: 'absent' } | { state: 'present'; raw: string }

export interface VoiceCatalogCasPorts {
  read(): Promise<VoiceCatalogRead>
  collect(previous: BuiltinVoiceCatalogSnapshot | null): Promise<BuiltinVoiceCatalogSnapshot['providers']>
  compareAndSet(expectedRaw: string | null, nextRaw: string): Promise<boolean>
  /** Code-only episode ledger. Never supplied by a JSON/catalog/options field. */
  admitEvaluatedEntry?(providerId: BuiltinVoiceProviderId, entry: BuiltinVoiceCatalogEntry): boolean
}

/** Exact detached finite entry identity used by an episode-local producer ledger. */
export function voiceCatalogEvaluatedEntryFacts(providerId: BuiltinVoiceProviderId, entry: BuiltinVoiceCatalogEntry): string {
  return canonical({ providerId, ...entry })
}

/**
 * Unbound protocol for deterministic proof. No production ports/caller are installed.
 * Raw collect assertions never qualify a new model; only the code-owned evaluated-entry port can.
 */
export async function runVoiceCatalogCasAttempt(ports: VoiceCatalogCasPorts, options: {
  nowMs: number; initializeAbsent?: boolean; dryRun?: boolean; context?: BuiltinVoiceCatalogContext
}): Promise<{ status: 'proposed' | 'stored' | 'conflict'; snapshot: BuiltinVoiceCatalogSnapshot; winner?: BuiltinVoiceCatalogSnapshot }> {
  const context = options.context ?? BUILTIN_VOICE_CATALOG_CONTEXT
  const captured = await ports.read()
  if (!captured || (captured.state !== 'absent' && captured.state !== 'present')) refuse('snapshot_read_unavailable')
  if (captured.state === 'absent' && !options.initializeAbsent) refuse('initialization_required')
  const expectedRaw = captured.state === 'present' ? captured.raw : null
  const previous = expectedRaw === null ? null : await verifyBuiltinVoiceCatalog(expectedRaw, options.nowMs, context)
  // Capture and verify the prior cut BEFORE asking the source owner for fresh observations.
  const observed = await ports.collect(previous)
  object(observed, BUILTIN_VOICE_PROVIDER_IDS)
  const providers = {} as BuiltinVoiceCatalogSnapshot['providers']
  for (const providerId of BUILTIN_VOICE_PROVIDER_IDS) {
    const next = provider(observed[providerId], providerId, context, options.nowMs, true)
    next.entries = next.entries.map(observed => {
      let value = observed
      const prior = previous?.providers[providerId].entries.find(item => voiceCatalogEntryIdentity(providerId, item) === voiceCatalogEntryIdentity(providerId, value))
      const baseline = context.baseline.some(item => item.providerId === providerId && item.lane === value.lane && item.modelId === value.modelId && item.compatibilityProfileId === value.compatibilityProfileId && item.admission === 'qualified')
      let evaluated = value.admission === 'qualified' && ports.admitEvaluatedEntry?.(providerId, value) === true && voiceCatalogEntryCompatibility(providerId, value, context).compatible
      const priorCoverage = canonical(value.requalifiedFrom ?? null) === canonical(prior?.requalifiedFrom ?? null)
      if (value.requalifiedFrom && !priorCoverage && !(evaluated && prior && canRequalifyVoiceCatalogEntry(providerId, prior, value, previous ?? undefined))) {
        const { requalifiedFrom: _recovery, ...unanchored } = value
        value = unanchored
        evaluated = false // The ledger binds the original complete entry, never this modified one.
      }
      if (value.admission !== 'qualified') return value
      const unchanged = prior?.admission === 'qualified' && voiceCatalogEvaluatedEntryFacts(providerId, prior) === voiceCatalogEvaluatedEntryFacts(providerId, value)
      if (baseline || unchanged || evaluated) return value
      // A normal list cannot bootstrap new compatibility or clear a known block.
      return { ...value, admission: 'candidate', qualifiedAt: null, blockedReason: 'qualification-required' }
    })
    if (next.entries.some(value => value.admission !== 'qualified') && next.qualificationCoverage === 'complete') next.qualificationCoverage = 'pending'
    const retained = previous?.providers[providerId] ?? { ...next, lastVerifiedAt: undefined,
      entries: baselineEntries(providerId, context),
      qualificationCoverage: context.baseline.some(binding => binding.providerId === providerId && binding.admission === 'candidate') ? 'pending' as const : next.qualificationCoverage }
    providers[providerId] = retainVoiceProviderEntries(providerId, retained, next, previous ?? undefined)
  }
  const proposal: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, ...nextVoiceCatalogOrder(previous), revision: '0'.repeat(64),
    generatedAt: new Date(options.nowMs).toISOString(), providers,
    ...(previous?.resetFrom ? { resetFrom: previous.resetFrom } : {}) }
  proposal.revision = await voiceCatalogRevision(proposal)
  const snapshot = await verifyBuiltinVoiceCatalog(JSON.stringify(proposal), options.nowMs, context)
  assertVoiceCatalogBlockConservation(previous, snapshot)
  if (options.dryRun !== false) return { status: 'proposed', snapshot }
  const acknowledgement = await ports.compareAndSet(expectedRaw, JSON.stringify(snapshot))
  if (acknowledgement === true) return { status: 'stored', snapshot }
  if (acknowledgement !== false) refuse('publication_unconfirmed')
  // A losing publication cannot rebuild/retry with its already collected source evidence.
  const winnerRead = await ports.read()
  if (!winnerRead || winnerRead.state !== 'present') refuse('winner_unavailable')
  const winner = await verifyBuiltinVoiceCatalog(winnerRead.raw, options.nowMs, context)
  if (previous && compareVoiceCatalogAdmission(previous, winner) !== 'newer') refuse('winner_not_newer')
  return { status: 'conflict', snapshot, winner }
}
