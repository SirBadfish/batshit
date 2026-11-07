import { normalizeArtifactModelConfig } from '$lib/utils/artifactModelConfig'
import { normalizeAgentAutoCompactSettings, normalizeGlobalAutoCompactSettings } from '$lib/utils/contextCompaction'
import { resolveMemoryWindowSettings } from '$lib/utils/memoryControl'
import {
  acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, assertSettingsRecordReplacement,
  SettingsLifecycleRefusal, type SettingsLifecycleSnapshot
} from './appActions/settings/lifecycle'
import type { OwnedModelPresetDependency } from './modelPresetSelectionOwner'
import { MEMORY_CONFIG_KEY } from './memory/memoryKeys'

export type PresetReferenceOwner = 'primary' | 'subagent' | 'settings' | 'memory' | 'artifact'
type RecordValue = Record<string, any>
type Client = { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }
const fields = {
  primary: ['primary_model_preset_id', 'auto_compact_settings', 'memory_window', 'memoryWindow'],
  subagent: ['primary_model_preset_id'], settings: ['global_auto_compact_settings'],
  memory: ['embedding'], artifact: ['model_config', 'model']
} as const
const id = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null

type ReferenceUse = { slot: string; id: string; literal: string | undefined }
/** The same effective modes as the deletion scan, retaining the exact active storage leaf. */
function referenceUses(kind: PresetReferenceOwner, record: RecordValue, literals: RecordValue = record): ReferenceUse[] {
  const result: ReferenceUse[] = []
  const add = (slot: string, selected: unknown, literal: unknown) => {
    const selectedId = id(selected)
    if (selectedId) result.push({ slot, id: selectedId, literal: JSON.stringify(literal) })
  }
  if (kind === 'primary' || kind === 'subagent') add('primary_model_preset_id', record.primary_model_preset_id, literals.primary_model_preset_id)
  if (kind === 'primary') {
    const compact = normalizeAgentAutoCompactSettings(record.auto_compact_settings)
    if (compact.modelMode === 'preset') add('auto_compact_settings.modelPresetId', compact.modelPresetId, literals.auto_compact_settings?.modelPresetId)
    const field = record.memory_window == null ? 'memoryWindow' : 'memory_window'
    add(`${field}.summary_model_preset_id`, resolveMemoryWindowSettings(record).summaryModelPresetId, literals[field]?.summary_model_preset_id)
  }
  if (kind === 'settings') {
    const compact = normalizeGlobalAutoCompactSettings(record.global_auto_compact_settings)
    if (compact.modelMode === 'preset') add('global_auto_compact_settings.modelPresetId', compact.modelPresetId, literals.global_auto_compact_settings?.modelPresetId)
  }
  if (kind === 'memory' && record.embedding?.lane === 'preset') add('embedding.preset.presetId', record.embedding.preset?.presetId, literals.embedding?.preset?.presetId)
  if (kind === 'artifact') {
    const config = normalizeArtifactModelConfig(record.model_config ?? null, typeof record.model === 'string' ? record.model : null)
    for (const role of ['primary', 'visual', 'audio', 'utility'] as const) {
      const value = config[role]
      const storedRole = role === 'visual' && record.model_config?.visual == null ? 'vision' : role
      if (value?.source === 'preset') add(`model_config.${storedRole}.presetId`, value.presetId, literals.model_config?.[storedRole]?.presetId)
    }
  }
  return result
}
export function presetReferenceIds(kind: PresetReferenceOwner, record: RecordValue): string[] {
  return [...new Set(referenceUses(kind, record).map(use => use.id))]
}

export function presetReferencePaths(kind: PresetReferenceOwner, writtenFields?: readonly string[]): string[] {
  const identity = kind === 'primary' || kind === 'subagent' || kind === 'artifact' ? ['id', 'user_id'] : []
  return [...identity, ...fields[kind].filter(field => !writtenFields || writtenFields.includes(field))].map(field => `$.${field}`)
}
function projection(record: RecordValue, paths: readonly string[]) {
  return Object.fromEntries(paths.map(path => [path.slice(2), record[path.slice(2)]]))
}
export type PresetReferencePreparation = Readonly<{
  epoch: SettingsLifecycleSnapshot | null
  candidates: ReadonlyMap<string, SettingsLifecycleSnapshot | null>
  target?: SettingsLifecycleSnapshot
}>
/** Request-local facts only. Capture before the owner's first await/queue. */
export function preparePresetReferences(kind: PresetReferenceOwner, input: RecordValue, target?: SettingsLifecycleSnapshot): PresetReferencePreparation {
  // Tentative facts cannot preempt an existing owner when the resulting save has no preset use.
  let epoch: SettingsLifecycleSnapshot | null
  try { epoch = captureSettingsLifecycle([]) }
  catch (error) { if (!(error instanceof SettingsLifecycleRefusal)) throw error; epoch = null }
  const candidates = new Map<string, SettingsLifecycleSnapshot | null>()
  for (const value of presetReferenceIds(kind, input)) {
    try { candidates.set(value, captureSettingsLifecycle([`model:${value}`])) }
    catch { candidates.set(value, null) }
  }
  return { epoch, candidates, ...(target ? { target } : {}) }
}

export class PresetReferenceWriteError extends Error {
  readonly status: number
  readonly code: string
  readonly outcome: 'not_written' | 'unknown'
  constructor(kind: 'changed' | 'invalid' | 'unavailable' | 'unknown', readonly details?: Record<string, unknown>) {
    super(kind === 'unknown'
      ? details?.record === 'saved'
        ? 'The Artifact record was saved, but its index publication is unconfirmed. Preset reference custody is held; do not repeat this creation.'
        : 'The preset reference save was issued but its outcome is unconfirmed. Its custody is held; do not repeat the save.'
      : kind === 'invalid'
        ? 'A new model reference must name one of your existing saved presets. Nothing was saved.'
        : kind === 'unavailable'
          ? 'The saved preset reference could not be checked. Nothing was saved.'
          : 'The preset or saved reference changed while this save was pending. Nothing was saved. Reload before another change.')
    this.name = 'PresetReferenceWriteError'
    this.status = kind === 'invalid' ? 400 : kind === 'changed' ? 409 : 503
    this.code = `MODEL_PRESET_REFERENCE_${kind.toUpperCase()}`
    this.outcome = kind === 'unknown' ? 'unknown' : 'not_written'
  }
}

const READ_REFERENCE_SNAPSHOT = `
-- BATSHIT_PRESET_REFERENCE_SNAPSHOT_V1
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'INVALID'} end
local root = redis.call('JSON.GET', KEYS[1], '$')
if ARGV[2] and #root > tonumber(ARGV[2]) then return {'TOO_LARGE'} end
local result = {'OK', root}
local bytes = #root
for _, path in ipairs(cjson.decode(ARGV[1])) do
  local raw = redis.pcall('JSON.GET', KEYS[1], path)
  if type(raw) ~= 'string' then return {'INVALID'} end
  bytes = bytes + #raw
  if ARGV[2] and bytes > tonumber(ARGV[2]) then return {'TOO_LARGE'} end
  result[#result + 1] = raw
end
return result
`
export type PresetReferenceSnapshot = { key: string; record: RecordValue; paths: Array<[string, string]>; exists?: boolean; rootRaw?: string | null; extraRawPaths?: Array<[string, string]> }
/** Only the fixed reference containers need a lossless literal view. This is not a data serializer. */
export function presetReferenceLiterals(paths: readonly (readonly [string, string])[]): RecordValue {
  const nativeJson = JSON as typeof JSON & { rawJSON(source: string): unknown }
  return Object.fromEntries(paths.map(([path, raw]) => [path.slice(2), raw
    ? JSON.parse(raw, (_key, value, context?: { source?: string }) =>
      typeof value === 'number' && context?.source ? nativeJson.rawJSON(context.source) : value)?.[0]
    : undefined]))
}
export async function readPresetReferenceSnapshot(client: Client, key: string, kind: PresetReferenceOwner,
  writtenFields?: readonly string[], maxBytes?: number, extraPaths: readonly string[] = []): Promise<PresetReferenceSnapshot> {
  const referencePaths = presetReferencePaths(kind, writtenFields)
  const paths = [...new Set([...referencePaths, ...extraPaths])]
  const answer = await client.eval(READ_REFERENCE_SNAPSHOT, { keys: [key], arguments: [JSON.stringify(paths), ...(maxBytes ? [String(maxBytes)] : [])] })
  if (Array.isArray(answer) && answer.length === 1 && answer[0] === 'MISSING') {
    return { key, record: {}, paths: referencePaths.map(path => [path, '']), exists: false, ...(extraPaths.length ? { rootRaw: null, extraRawPaths: extraPaths.map(path => [path, '']) as Array<[string, string]> } : {}) }
  }
  if (!Array.isArray(answer) || answer[0] !== 'OK' || typeof answer[1] !== 'string' || answer.length !== paths.length + 2 ||
    answer.slice(2).some(value => typeof value !== 'string')) throw new PresetReferenceWriteError('unavailable')
  const record = JSON.parse(answer[1])?.[0]
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new PresetReferenceWriteError('unavailable')
  const captured = new Map(paths.map((path, index) => [path, answer[index + 2] as string]))
  return { key, record, paths: referencePaths.map(path => [path, captured.get(path)!]), exists: true,
    ...(extraPaths.length ? { rootRaw: answer[1], extraRawPaths: extraPaths.map(path => [path, captured.get(path)!]) as Array<[string, string]> } : {}) }
}

const READ_COPY_REFERENCE_POPULATION = `
local out = {}
local bytes = 0
for _, index in ipairs(KEYS) do
  local kind = redis.call('TYPE', index).ok
  if kind ~= 'none' and kind ~= 'set' then return {'INVALID_INDEX'} end
  if redis.call('SCARD', index) > 10000 then return {'TOO_LARGE'} end
  local ids = redis.call('SMEMBERS', index)
  for _, id in ipairs(ids) do
    bytes = bytes + #id
    if #id > 256 or bytes > 131072 then return {'TOO_LARGE'} end
  end
  table.sort(ids)
  out[#out + 1] = ids
end
return out
`
/** Fixed copy-destination admission only. The caller holds that model's replacement fence,
 * which drains accepted references and prevents new admissions. Normal human list readers
 * can migrate/filter; this cut must instead refuse incomplete indexed populations. */
export async function assertPresetCopyDestinationUnreferenced(client: Client, userId: string, presetId: string, check: () => void) {
  const current = () => { assertSettingsRecordReplacement(`model:${presetId}`); check() }
  current()
  const keys = [`user:${userId}:agents`, `user:${userId}:subagents`, `user:${userId}:artifacts`]
  const population = await client.eval(READ_COPY_REFERENCE_POPULATION, {
    keys, arguments: [] })
  current()
  if (!Array.isArray(population) || population.length !== 3 || population.some(ids => !Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id || !id.isWellFormed()))) throw new PresetReferenceWriteError('unavailable')
  let bytes = 0
  const targets: Array<{ key: string; paths: Array<[string, string]> }> = []
  const inspect = async (kind: PresetReferenceOwner, key: string, indexedId?: string) => {
    const source = await readPresetReferenceSnapshot(client, key, kind, undefined, 131072)
    current()
    targets.push({ key, paths: source.paths })
    bytes += Buffer.byteLength(JSON.stringify(source.record), 'utf8')
    if (bytes > 131072 || indexedId && (source.record.id !== indexedId || source.record.user_id !== userId)) throw new PresetReferenceWriteError('unavailable')
    for (const field of fields[kind]) {
      const value = source.record[field]
      if (field === 'primary_model_preset_id' || field === 'model') {
        if (value != null && typeof value !== 'string') throw new PresetReferenceWriteError('unavailable')
      } else if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new PresetReferenceWriteError('unavailable')
    }
    if (presetReferenceIds(kind, source.record).includes(presetId)) throw new PresetReferenceWriteError('changed')
  }
  for (const [index, kind] of ['primary', 'subagent', 'artifact'].entries()) {
    for (const id of population[index] as string[]) await inspect(kind as 'primary' | 'subagent' | 'artifact', `${kind === 'primary' ? 'agent' : kind}:${id}`, id)
  }
  await inspect('settings', `user:${userId}:settings`)
  await inspect('memory', MEMORY_CONFIG_KEY)
  return { indexes: keys.map((key, index) => ({ key, ids: population[index] as string[] })), targets }
}

/** Imported into the actual owner's EVAL, before its first write. No network/authority lookup. */
export const PRESET_REFERENCE_GUARD_LUA = `
local function presetReferencesAvailable(encoded)
  if not encoded or encoded == '' then return true end
  local proof = cjson.decode(encoded)
  for _, target in ipairs(proof.targets) do
    for _, pair in ipairs(target.paths) do
      local raw = redis.pcall('JSON.GET', target.key, pair[1])
      if raw == false or raw == nil then raw = '' end
      if type(raw) ~= 'string' or raw ~= pair[2] then return false end
    end
  end
  for _, source in ipairs(proof.sources) do
    local indexType = redis.call('TYPE', source.index).ok
    if indexType ~= 'none' and indexType ~= 'set' then return false end
    if (redis.call('SISMEMBER', source.index, source.id) == 1) ~= source.member then return false end
    if source.exists then
      local shape = redis.pcall('JSON.TYPE', source.key, '$')
      if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return false end
      local found = cjson.decode(redis.call('JSON.GET', source.key, '$.id'))[1]
      if found ~= source.id then return false end
    elseif redis.call('EXISTS', source.key) ~= 0 then return false end
  end
  for _, check in ipairs(proof.checks) do
    for _, pair in ipairs(check.paths) do
      local raw = redis.pcall('JSON.GET', check.key, pair[1])
      if raw == false or raw == nil then raw = '' end
      if type(raw) ~= 'string' or raw ~= pair[2] then return false end
    end
  end
  return true
end
`

export async function admitPresetReferences(userId: string, kind: PresetReferenceOwner,
  before: PresetReferenceSnapshot, after: RecordValue, preparation: PresetReferencePreparation,
  dependency?: OwnedModelPresetDependency, afterLiterals?: RecordValue) {
  const epoch = preparation.epoch
  if (!epoch) throw new PresetReferenceWriteError('changed')
  assertSettingsLifecycle(epoch)
  if (preparation.target) assertSettingsLifecycle(preparation.target)
  const paths = before.paths.map(([path]) => path)
  const previous = new Map(referenceUses(kind, paths.length ? projection(before.record, paths) : before.record,
    paths.length ? presetReferenceLiterals(before.paths) : before.record).map(use => [use.slot, use]))
  const uses = referenceUses(kind, paths.length ? projection(after, paths) : after,
    afterLiterals ? paths.length ? projection(afterLiterals, paths) : afterLiterals : after)
  const resulting = [...new Set(uses.map(use => use.id))]
  const unchanged = (value: string) => uses.filter(use => use.id === value).every(use => {
    const saved = previous.get(use.slot)
    return saved?.id === value && saved.literal === use.literal
  })
  const snapshots: SettingsLifecycleSnapshot[] = [epoch, ...(preparation.target ? [preparation.target] : [])]
  const sources: Array<{ key: string; index: string; id: string; member: boolean; exists: boolean }> = []
  for (const value of resulting) {
    if (!value.isWellFormed() || value.includes('\0')) {
      if (unchanged(value)) continue // Literal historical data cannot name an admissible preset.
      throw new PresetReferenceWriteError('invalid')
    }
    const lifecycle = preparation.candidates.has(value) ? preparation.candidates.get(value) : captureSettingsLifecycle([`model:${value}`])
    if (!lifecycle) throw new PresetReferenceWriteError('changed')
    assertSettingsLifecycle(lifecycle)
    // Reuse the exact saved-model storage/ownership owner, without chat eligibility or credentials.
    const stored = await (await import('./modelPresetSelectionOwner')).readModelPresetStorage(userId, value)
    assertSettingsLifecycle(lifecycle)
    if ((!stored.present || !stored.preset) && !unchanged(value)) throw new PresetReferenceWriteError('invalid')
    // An unchanged foreign historical ID is data, not authority to hold another
    // owner's preset replacement. Its negative membership is still checked in Lua.
    if (stored.present) snapshots.push(lifecycle)
    sources.push({ key: `model:${value}`, index: `user:${userId}:models`, id: value,
      member: stored.present, exists: Boolean(stored.preset) })
  }
  if (dependency) {
    if (!resulting.includes(dependency.membership.member)) throw new PresetReferenceWriteError('changed')
    assertSettingsLifecycle(dependency.lifecycle)
    snapshots.push(dependency.lifecycle)
  }
  for (const snapshot of snapshots) assertSettingsLifecycle(snapshot)
  const lease = acquireSettingsMutation({ epoch: epoch.epoch, records: snapshots.flatMap(snapshot => snapshot.records) })
  return { ...lease, guard: JSON.stringify({ targets: [{ key: before.key, paths: before.paths }], sources,
    checks: dependency?.checks ?? [] }) }
}

export function completePresetReferenceWrite(lease: Awaited<ReturnType<typeof admitPresetReferences>>, answer: unknown,
  knownAnswers: readonly string[]) {
  if (answer === 'PRESET_REFERENCE_CHANGED') { lease.settle(); throw new PresetReferenceWriteError('changed') }
  if (typeof answer === 'string' && knownAnswers.includes(answer)) { lease.settle(); return }
  lease.unknown()
  throw new PresetReferenceWriteError('unknown')
}
