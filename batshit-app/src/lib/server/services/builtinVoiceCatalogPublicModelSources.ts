import { createHash } from 'node:crypto'
import { VOICE_SOURCE_HTTP_CONTRACTS } from './builtinVoiceCatalogSourceHttp'

const architectures = ['base','nova','nova-2','nova-3','polaris','whisper','aura','aura-2','unknown'] as const
type Architecture = typeof architectures[number]
type TriState = boolean | 'unknown'
type Reason = 'documented' | 'missing-input' | 'invalid-input' | 'invalid-timestamp' | 'oversized' | 'malformed-json'
  | 'malformed-envelope' | 'empty' | 'invalid-identity' | 'duplicate-identity' | 'conflicting-uuid' | 'invalid-capability'
type Capture = { body: string; retrievedAt: string }
type Evidence = { sourceUrl: string; sourceDigest: string; retrievedAt: string }
interface ElevenLabsModel {
  modelId: string
  canDoTts: TriState; canDoVoiceConversion: TriState; canUseStyle: TriState
  canUseSpeakerBoost: TriState; servesProVoices: TriState; requiresAlphaAccess: TriState
}
interface DeepgramModel {
  kind: 'stt' | 'tts'; modelId: string; version: string; uuid: string
  batch: TriState; streaming: TriState; formattedOutput: TriState
  architecture: Architecture | null
}
type Observation<T> = {
  structuralCoverage: 'complete-public-response' | 'insufficient'
  classificationCoverage: 'complete' | 'partial' | 'unknown'
  reason: Reason; evidence: Evidence | null; models: T[]
}
class SourceFailure extends Error { constructor(readonly reason: Reason) { super(reason) } }
const fail = (reason: Reason): never => { throw new SourceFailure(reason) }
const MAX_ROWS = 1000, MAX_ID_BYTES = 256, MAX_BYTES = 1024 * 1024
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('malformed-envelope')
  return value as Record<string, unknown>
}
function capture(value: unknown, now: number): Capture {
  const input = row(value), body = input.body, retrievedAt = input.retrievedAt
  if (Object.keys(input).some(key => !['body', 'retrievedAt'].includes(key)) || typeof body !== 'string'
    || !body.isWellFormed() || body.includes('\0')) throw new SourceFailure('invalid-input')
  if (byteLength(body) > MAX_BYTES) return fail('oversized')
  if (typeof retrievedAt !== 'string' || !Number.isFinite(now) || !Number.isFinite(Date.parse(retrievedAt))
    || new Date(retrievedAt).toISOString() !== retrievedAt || Date.parse(retrievedAt) > now + 300_000) throw new SourceFailure('invalid-timestamp')
  return { body, retrievedAt }
}
function parseJson(body: string): unknown { try { return JSON.parse(body) } catch { return fail('malformed-json') } }
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return fail('malformed-envelope')
  if (!value.length) return fail('empty')
  if (value.length > MAX_ROWS) return fail('oversized')
  return value
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.trim() !== value
    || byteLength(value) > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) return fail('invalid-identity')
  return value
}
function boolean(value: Record<string, unknown>, key: string): TriState {
  if (!Object.hasOwn(value, key)) return 'unknown'
  const declared = value[key]
  if (typeof declared !== 'boolean') return fail('invalid-capability')
  return declared
}
function observation<T>(input: unknown, sourceUrl: string, now: number, inspect: (value: unknown) => T[], classified: (models: T[]) => boolean): Observation<T> {
  let evidence: Evidence | null = null
  try {
    if (input === undefined) return { structuralCoverage: 'insufficient', classificationCoverage: 'unknown', reason: 'missing-input', evidence: null, models: [] }
    const original = capture(input, now)
    evidence = { sourceUrl, sourceDigest: hash(original.body), retrievedAt: original.retrievedAt }
    const models = inspect(parseJson(original.body))
    return { structuralCoverage: 'complete-public-response', classificationCoverage: classified(models) ? 'complete' : 'partial', reason: 'documented', evidence, models }
  } catch (error) {
    return { structuralCoverage: 'insufficient', classificationCoverage: 'unknown', reason: error instanceof SourceFailure ? error.reason : 'invalid-input', evidence, models: [] }
  }
}

/** Pure supplied public response; no transport/profile/voice/account qualification. */
export function inspectElevenLabsPublicModels(input: unknown, now = Date.now()) {
  const result = observation<ElevenLabsModel>(input, VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsModels.url, now, value => {
    const seen = new Set<string>()
    return list(value).map(value => {
      const model = row(value), modelId = identity(model.model_id)
      if (seen.has(modelId)) return fail('duplicate-identity'); seen.add(modelId)
      return { modelId, canDoTts: boolean(model, 'can_do_text_to_speech'), canDoVoiceConversion: boolean(model, 'can_do_voice_conversion'),
        canUseStyle: boolean(model, 'can_use_style'), canUseSpeakerBoost: boolean(model, 'can_use_speaker_boost'),
        servesProVoices: boolean(model, 'serves_pro_voices'), requiresAlphaAccess: boolean(model, 'requires_alpha_access') }
    })
  }, models => models.every(model => model.canDoTts !== 'unknown'))
  return { sourceId: 'elevenlabs-public-models-v1', parserId: 'elevenlabs-public-models-json-v1', providerId: 'elevenlabs',
    observation: result, readiness: 'candidate', qualificationCoverage: 'pending',
    proofGaps: ['model-specific-transport-voice-controls-and-guidance', 'actual-response-and-errors'],
    outsideCatalogQualification: ['account-private-voice-eligibility'] } as const
}

function deepgramRows(value: unknown): DeepgramModel[] {
  const envelope = row(value)
  if (Object.keys(envelope).some(key => !['stt', 'tts', 'languages'].includes(key))) return fail('malformed-envelope')
  if (Object.hasOwn(envelope, 'languages')) row(envelope.languages) // Public annotation only; never projected/followed.
  const seen = new Set<string>(), uuids = new Map<string, string>(), models: DeepgramModel[] = []
  for (const kind of ['stt', 'tts'] as const) {
    for (const value of list(envelope[kind])) {
      const item = row(value), modelId = identity(item.canonical_name), version = identity(item.version), uuid = identity(item.uuid)
      const tuple = JSON.stringify([kind, modelId, version, uuid])
      if (seen.has(tuple)) return fail('duplicate-identity')
      if (uuids.has(uuid) && uuids.get(uuid) !== tuple) return fail('conflicting-uuid')
      seen.add(tuple); uuids.set(uuid, tuple)
      const declaredArchitecture = item.architecture === undefined ? null : identity(item.architecture)
      const architecture = declaredArchitecture === null ? null : architectures.includes(declaredArchitecture as Architecture) ? declaredArchitecture as Architecture : 'unknown'
      models.push({ kind, modelId, version, uuid, architecture, batch: boolean(item, 'batch'), streaming: boolean(item, 'streaming'), formattedOutput: boolean(item, 'formatted_output') })
    }
  }
  return models
}
const tuple = (model: DeepgramModel) => JSON.stringify([model.kind, model.modelId, model.version, model.uuid])

/** Separate public captures, not an atomic model-list read or a merged verification timestamp. */
export function inspectDeepgramPublicModels(input: unknown, now = Date.now()) {
  let captures: Record<string, unknown> = {}
  try { captures = row(input); if (Object.keys(captures).some(key => !['latest', 'all'].includes(key))) captures = {} } catch { /* Both failed observations stay explicit. */ }
  const classified = (models: DeepgramModel[]) => models.every(model => model.kind !== 'stt' || model.batch !== 'unknown' && model.streaming !== 'unknown')
  const latest = observation(captures.latest, VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url, now, deepgramRows, classified)
  const all = observation(captures.all, VOICE_SOURCE_HTTP_CONTRACTS.deepgramAll.url, now, deepgramRows, classified)
  const retained = new Set(all.models.map(tuple))
  const pairedCoverage = latest.structuralCoverage !== 'complete-public-response' || all.structuralCoverage !== 'complete-public-response'
    ? 'partial' : latest.models.every(model => retained.has(tuple(model))) ? 'source-consistent' : 'inconsistent'
  return { sourceId: 'deepgram-public-models-v1', parserId: 'deepgram-public-models-json-v1', providerId: 'deepgram',
    observations: { latest, all }, pairedCoverage, atomicSnapshot: false, readiness: 'candidate', qualificationCoverage: 'pending',
    proofGaps: ['effective-target-transport-voice-controls-and-guidance', 'actual-response-and-errors', 'recorded-versus-realtime-admission'],
    outsideCatalogQualification: ['account-private-voice-eligibility'] } as const
}
