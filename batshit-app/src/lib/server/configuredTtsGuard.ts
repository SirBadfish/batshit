import { CHECK_VOICE_CATALOG_SELECTION_LUA, type VoiceCatalogSelectionGuard } from './voiceCatalogSelectionGuard'
import { createHash } from 'node:crypto'
import { isConfiguredTtsRevision } from '$lib/appActions/settings/configuredTtsBaseline'
import { CONFIGURED_TTS_FIELDS, type ConfiguredTtsSelection } from '$lib/appActions/settings/configuredTtsPreferences'
import { PRIMARY_AGENT_TYPE_SOURCE_FIELDS, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { normalizeAgentVoiceProfile } from '$lib/utils/voiceSchema'
import { assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'
import type { AgentRecordOp } from './agentRecordUpdate'

export const CONFIGURED_TTS_IDENTITY_PATHS = [...new Set(['id', 'user_id', 'created_at', ...PRIMARY_AGENT_TYPE_SOURCE_FIELDS])].map(field => `$.${field}`)
export const CONFIGURED_TTS_VALUE_PATHS = [
  ...['providerId', 'provider', 'modelId', 'model', 'voiceId', 'profileId'].map(field => `$.voice_profile.tts.${field}`),
  '$.voice_profile.tts.providerOptions.fish.reference_id',
  ...['provider', 'model', 'voiceId', 'profileId', 'style', 'ttsItalicNarrationBehavior', 'italicNarrationBehavior'].map(field => `$.voice_profile.${field}`)
]
export const CONFIGURED_TTS_READ_PATHS = [...CONFIGURED_TTS_IDENTITY_PATHS, ...CONFIGURED_TTS_VALUE_PATHS]
export class ConfiguredTtsBaseRequiredError extends Error { readonly status = 400; readonly code = 'tts_selection_base_required'; constructor() { super('Read the saved reply voice before changing it. Nothing was saved.') } }
export class ConfiguredTtsConflictError extends Error { readonly status = 409; readonly code = 'tts_selection_changed'; constructor() { super('Saved reply voice changed. Your draft is kept; read the saved voice before another choice. Nothing was saved.') } }
export class ConfiguredTtsSaveUnconfirmedError extends Error { readonly status = 503; readonly code = 'tts_selection_save_unconfirmed'; constructor() { super('The reply voice save was issued but its outcome is unconfirmed. Do not automatically repeat it.') } }
export class ConfiguredTtsModelLockedError extends Error { readonly status = 409; readonly code = 'tts_speech_to_speech_locked'; constructor() { super('The selected speech-to-speech model controls reply voice. Nothing was saved.') } }
export function requireConfiguredTtsExpected(value: unknown): asserts value is string { if (!isConfiguredTtsRevision(value)) throw new ConfiguredTtsBaseRequiredError() }
function decode(raw: string): unknown { const values: unknown = JSON.parse(raw || '[]'); if (!Array.isArray(values) || values.length > 1) throw new ConfiguredTtsConflictError(); return values[0] }
export type ConfiguredTtsSnapshot = Readonly<{ id: string; record: Readonly<Record<string, unknown>>; paths: readonly string[]; raw: readonly string[]; parentType: string; ttsType: string; lifecycle: SettingsLifecycleSnapshot; revision: string }>
export type VoiceEngineClearBasis = Readonly<{ target: ConfiguredTtsSnapshot; fingerprint: string }>
export type TtsSourceGuard = Readonly<{ key: string; voiceCatalog: VoiceCatalogSelectionGuard } | { key: string; path: string; raw: string } | { key: string; path: string; fingerprint: string; byteLimit: number } | { key: string; typePath: string; type: string } | { key: string; member: string; present: boolean } | { key: string; members: readonly string[] }>
export type ConfiguredTtsMutation = Readonly<{ target: ConfiguredTtsSnapshot; selection: ConfiguredTtsSelection; sources: readonly TtsSourceGuard[]; sourceLifecycle: SettingsLifecycleSnapshot; check(): void; signal: AbortSignal; deadlineAt: number; onSaved?(): void; authority: { key: string; paths: readonly (readonly [string, string])[]; lifecycle?: SettingsLifecycleSnapshot } }>
export type ConfiguredTtsRawGuard = Readonly<{ paths: readonly string[]; raw: readonly string[]; parentType: string; ttsType: string; deadlineAt?: number; sources: readonly ({ keyIndex: number; voiceCatalog: VoiceCatalogSelectionGuard } | { keyIndex: number; path: string; raw: string } | { keyIndex: number; path: string; fingerprint: string; byteLimit: number } | { keyIndex: number; typePath: string; type: string } | { keyIndex: number; member: string; present: boolean } | { keyIndex: number; members: readonly string[] })[]; authority?: { keyIndex: number; paths: readonly (readonly [string, string])[] }; removeFishAlias?: boolean }>
function type(value: unknown): string { return value === undefined ? '' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value }
export function configuredTtsSnapshotFromDetail(id: string, row: Record<string, unknown>, raw: readonly string[], lifecycle: SettingsLifecycleSnapshot): ConfiguredTtsSnapshot {
  assertSettingsLifecycle(lifecycle)
  if (raw.length !== CONFIGURED_TTS_READ_PATHS.length || raw.some(value => typeof value !== 'string')) throw new ConfiguredTtsConflictError()
  const parent = row.voice_profile as Record<string, unknown> | null | undefined, parentType = type(parent), ttsType = type(parent && typeof parent === 'object' ? parent.tts : undefined)
  if (!['', 'null', 'object'].includes(parentType) || !['', 'null', 'object'].includes(ttsType)) throw new ConfiguredTtsConflictError()
  const active = CONFIGURED_TTS_READ_PATHS.map((path, index) => [path, raw[index]] as const).filter(([path]) => ttsType === 'object' ? !path.startsWith('$.voice_profile.') || path.startsWith('$.voice_profile.tts.') : !path.startsWith('$.voice_profile.tts.'))
  const paths = active.map(([path]) => path), values = active.map(([, value]) => value)
  if (values.some(value => Buffer.byteLength(value, 'utf8') > 16384)) throw new ConfiguredTtsConflictError()
  for (const [path, rawValue] of active) if (path.startsWith('$.voice_profile.') && !['style', 'ttsItalicNarrationBehavior', 'italicNarrationBehavior'].some(field => path === `$.voice_profile.${field}`)) {
    const value = decode(rawValue)
    if (value != null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value))) throw new ConfiguredTtsConflictError()
  }
  const record: Record<string, unknown> = {}
  for (const path of CONFIGURED_TTS_IDENTITY_PATHS) { const value = decode(raw[CONFIGURED_TTS_READ_PATHS.indexOf(path)]); if (value !== undefined) record[path.slice(2)] = value }
  if (record.id !== id || typeof record.user_id !== 'string') throw new ConfiguredTtsConflictError()
  const profile: Record<string, unknown> = {}, tts: Record<string, unknown> = {}
  for (const [path, rawValue] of active) {
    const value = decode(rawValue); if (value === undefined || !path.startsWith('$.voice_profile.')) continue
    if (path === '$.voice_profile.tts.providerOptions.fish.reference_id') tts.providerOptions = { fish: { reference_id: value } }
    else if (path.startsWith('$.voice_profile.tts.')) tts[path.slice('$.voice_profile.tts.'.length)] = value
    else profile[path.slice('$.voice_profile.'.length)] = value
  }
  if (ttsType === 'object') profile.tts = tts
  record.voice_profile = parentType === '' ? undefined : parentType === 'null' ? null : profile
  const revision = `sha256:${createHash('sha256').update(JSON.stringify({ id, paths, raw: values, parentType, ttsType, lifecycle })).digest('hex')}`
  return Object.freeze({ id, record: Object.freeze(record), paths: Object.freeze(paths), raw: Object.freeze(values), parentType, ttsType, lifecycle, revision })
}
const READ = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do
  local value = redis.call('JSON.GET', KEYS[1], path) or '[]'
  if string.len(value) > 16384 then return {'INVALID'} end
  out[#out+1] = value
end
local parent = redis.call('JSON.TYPE', KEYS[1], '$.voice_profile')
local tts = redis.call('JSON.TYPE', KEYS[1], '$.voice_profile.tts')
out[#out+1] = parent and parent[1] or ''; out[#out+1] = tts and tts[1] or ''
if ARGV[2] == 'engine-clear' then
  local raw = redis.call('JSON.GET', KEYS[1], '$.voice_profile') or '[]'
  if string.len(raw) > 262144 then return {'INVALID'} end
  out[#out+1] = raw
end
return out
`
export async function readConfiguredTtsSnapshot(client: { eval(script: string, args: { keys: string[]; arguments: string[] }): Promise<unknown> }, id: string, lifecycle = captureSettingsLifecycle([`agent:${id}`])): Promise<ConfiguredTtsSnapshot> {
  const answer = await client.eval(READ, { keys: [`agent:${id}`], arguments: [JSON.stringify(CONFIGURED_TTS_READ_PATHS)] })
  return configuredTtsSnapshotFromRead(id, answer, lifecycle)
}
function configuredTtsSnapshotFromRead(id: string, answer: unknown, lifecycle: SettingsLifecycleSnapshot): ConfiguredTtsSnapshot {
  assertSettingsLifecycle(lifecycle)
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== CONFIGURED_TTS_READ_PATHS.length + 3) throw new ConfiguredTtsConflictError()
  const raw = answer.slice(1, -2) as string[], row = Object.fromEntries(CONFIGURED_TTS_IDENTITY_PATHS.map((path, index) => [path.slice(2), decode(raw[index])]))
  row.voice_profile = answer.at(-2) === '' ? undefined : answer.at(-2) === 'null' ? null : answer.at(-2) === 'object' ? { ...(answer.at(-1) === 'object' ? { tts: {} } : answer.at(-1) === 'null' ? { tts: null } : answer.at(-1) === '' ? {} : { tts: [] }) } : []
  return configuredTtsSnapshotFromDetail(id, row, raw, lifecycle)
}
/** Engine deletion alone needs the corresponding raw voice block and original TTS base.
 * The raw private block is bounded inside the same EVAL before returning it to this owner. */
export async function readVoiceEngineClearRecord(client: { eval(script: string, args: { keys: string[]; arguments: string[] }): Promise<unknown> }, userId: string, id: string) {
  const lifecycle = captureSettingsLifecycle([`agent:${id}`])
  const answer = await client.eval(READ, { keys: [`agent:${id}`], arguments: [JSON.stringify(CONFIGURED_TTS_READ_PATHS), 'engine-clear'] })
  if (!Array.isArray(answer) || answer.length !== CONFIGURED_TTS_READ_PATHS.length + 4 || typeof answer.at(-1) !== 'string') throw new ConfiguredTtsConflictError()
  const raw = answer.at(-1) as string, target = configuredTtsSnapshotFromRead(id, answer.slice(0, -1), lifecycle)
  if (Buffer.byteLength(raw, 'utf8') > 262144) throw new ConfiguredTtsConflictError()
  if (target.record.user_id !== userId || !['api', 'cli'].includes(normalizePrimaryAgentType(target.record))) throw new ConfiguredTtsConflictError()
  return { voiceProfile: decode(raw), basis: Object.freeze({ target, fingerprint: createHash('sha1').update(raw).digest('hex') }) satisfies VoiceEngineClearBasis }
}
export function voiceEngineClearSource(target: ConfiguredTtsSnapshot, basis: VoiceEngineClearBasis): TtsSourceGuard {
  assertSettingsLifecycle(basis.target.lifecycle)
  if (basis.target.id !== target.id || basis.target.revision !== target.revision || !/^[a-f0-9]{40}$/.test(basis.fingerprint)) throw new ConfiguredTtsConflictError()
  return { key: `agent:${target.id}`, path: '$.voice_profile', fingerprint: basis.fingerprint, byteLimit: 262144 }
}
export function configuredTtsStoredSelection(snapshot: ConfiguredTtsSnapshot): ConfiguredTtsSelection {
  const tts = normalizeAgentVoiceProfile(snapshot.record.voice_profile)?.tts
  return Object.freeze(Object.fromEntries(CONFIGURED_TTS_FIELDS.map(field => [field, tts?.[field] ?? null]))) as ConfiguredTtsSelection
}
export function configuredTtsTupleChanges(snapshot: ConfiguredTtsSnapshot, voiceProfile: unknown) {
  const before = configuredTtsStoredSelection(snapshot), after = normalizeAgentVoiceProfile(voiceProfile)?.tts
  return CONFIGURED_TTS_FIELDS.some(field => before[field] !== (after?.[field] ?? null))
}
export function planConfiguredTtsOps(snapshot: ConfiguredTtsSnapshot, selection: ConfiguredTtsSelection): AgentRecordOp[] {
  const ops: AgentRecordOp[] = [{ op: 'ensureObject', field: 'voice_profile' }, { op: 'ensureObject', field: 'voice_profile', key: 'tts' }]
  if (snapshot.ttsType !== 'object') {
    const profile = snapshot.record.voice_profile as Record<string, unknown> | null | undefined
    if (profile && Object.hasOwn(profile, 'style')) ops.push({ op: 'set', field: 'voice_profile', key: 'tts', subkey: 'style', value: profile.style })
    const narration = profile?.ttsItalicNarrationBehavior ?? profile?.italicNarrationBehavior
    if (narration !== undefined) ops.push({ op: 'set', field: 'voice_profile', key: 'tts', subkey: 'narration', value: { italicBehavior: narration } })
  }
  for (const field of ['provider', 'model']) ops.push({ op: 'delete', field: 'voice_profile', key: 'tts', subkey: field })
  for (const field of CONFIGURED_TTS_FIELDS) ops.push(selection[field] === null ? { op: 'delete', field: 'voice_profile', key: 'tts', subkey: field } : { op: 'set', field: 'voice_profile', key: 'tts', subkey: field, value: selection[field] })
  return ops
}
export function checkConfiguredTtsIssue(mutation?: ConfiguredTtsMutation) {
  if (!mutation) return
  mutation.check(); assertSettingsLifecycle(mutation.target.lifecycle); assertSettingsLifecycle(mutation.sourceLifecycle)
  if (mutation.authority.lifecycle) assertSettingsLifecycle(mutation.authority.lifecycle)
  if (mutation.signal.aborted || !Number.isFinite(mutation.deadlineAt) || Date.now() >= mutation.deadlineAt) throw new ConfiguredTtsConflictError()
}
export function configuredTtsIssueGuard(snapshot: ConfiguredTtsSnapshot, expected: unknown, keys: string[], mutation?: ConfiguredTtsMutation, additionalSources: readonly TtsSourceGuard[] = []): ConfiguredTtsRawGuard {
  requireConfiguredTtsExpected(expected)
  const currentType = normalizePrimaryAgentType(snapshot.record)
  if (snapshot.revision !== expected || mutation && mutation.target.revision !== snapshot.revision || currentType !== 'api' && currentType !== 'cli') throw new ConfiguredTtsConflictError()
  checkConfiguredTtsIssue(mutation)
  const add = (key: string) => { let index = keys.indexOf(key); if (index < 0) { keys.push(key); index = keys.length - 1 } return index + 1 }
  return { paths: snapshot.paths, raw: snapshot.raw, parentType: snapshot.parentType, ttsType: snapshot.ttsType,
    sources: [...(mutation?.sources ?? []), ...additionalSources].map(source => 'voiceCatalog' in source ? { keyIndex: add(source.key), voiceCatalog: source.voiceCatalog } : 'fingerprint' in source ? { keyIndex: add(source.key), path: source.path, fingerprint: source.fingerprint, byteLimit: source.byteLimit } : 'path' in source ? { keyIndex: add(source.key), path: source.path, raw: source.raw } : 'typePath' in source ? { keyIndex: add(source.key), typePath: source.typePath, type: source.type } : 'members' in source ? { keyIndex: add(source.key), members: source.members } : { keyIndex: add(source.key), member: source.member, present: source.present }),
    ...(mutation ? { removeFishAlias: configuredTtsStoredSelection(snapshot).providerId === 'fish' || mutation.selection.providerId === 'fish', deadlineAt: mutation.deadlineAt, authority: { keyIndex: add(mutation.authority.key), paths: mutation.authority.paths } } : {}) }
}
export const CHECK_CONFIGURED_TTS_LUA = `
${CHECK_VOICE_CATALOG_SELECTION_LUA}
if tts.deadlineAt then local now = redis.call('TIME'); if tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000) >= tts.deadlineAt then return 'TTS_SELECTION_CHANGED' end end
local parent = redis.call('JSON.TYPE', KEYS[1], '$.voice_profile'); local nested = redis.call('JSON.TYPE', KEYS[1], '$.voice_profile.tts')
if (parent and parent[1] or '') ~= tts.parentType or (nested and nested[1] or '') ~= tts.ttsType then return 'TTS_SELECTION_CHANGED' end
for index, path in ipairs(tts.paths) do if (redis.call('JSON.GET', KEYS[1], path) or '[]') ~= tts.raw[index] then return 'TTS_SELECTION_CHANGED' end end
for _, source in ipairs(tts.sources) do
  if source.voiceCatalog then if not voice_catalog_semantic_current(source) then return 'TTS_SELECTION_CHANGED' end
  elseif source.member then if (redis.call('SISMEMBER', KEYS[source.keyIndex], source.member) == 1) ~= source.present then return 'TTS_SELECTION_CHANGED' end
  elseif source.members then
    if redis.call('SCARD', KEYS[source.keyIndex]) ~= #source.members then return 'TTS_SELECTION_CHANGED' end
    for _, member in ipairs(source.members) do if redis.call('SISMEMBER', KEYS[source.keyIndex], member) ~= 1 then return 'TTS_SELECTION_CHANGED' end end
  elseif source.typePath then local kind = redis.call('JSON.TYPE', KEYS[source.keyIndex], source.typePath); if (kind and kind[1] or '') ~= source.type then return 'TTS_SELECTION_CHANGED' end
  elseif source.fingerprint then local raw = redis.call('JSON.GET', KEYS[source.keyIndex], source.path) or '[]'; if string.len(raw) > source.byteLimit or redis.sha1hex(raw) ~= source.fingerprint then return 'TTS_SELECTION_CHANGED' end
  elseif (redis.call('JSON.GET', KEYS[source.keyIndex], source.path) or '[]') ~= source.raw then return 'TTS_SELECTION_CHANGED' end
end
if tts.authority then for _, pair in ipairs(tts.authority.paths) do if (redis.call('JSON.GET', KEYS[tts.authority.keyIndex], pair[1]) or '') ~= pair[2] then return 'TTS_SELECTION_CHANGED' end end end
`
