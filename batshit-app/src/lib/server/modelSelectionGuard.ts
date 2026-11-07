import { createHash } from 'node:crypto'
import { AGENT_MODEL_FIELDS } from '$lib/utils/agentSettingsSavePatch'
import { INTERNAL_SETTING_NAMES, INTERNAL_SETTING_PREFIXES, isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import { PRIMARY_AGENT_TYPE_SOURCE_FIELDS, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { normalizeSubagentType } from '$lib/utils/subagentType'
import { captureSettingsLifecycle, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'
import { buildClearedPresetSelection } from '$lib/utils/modelPresetPick'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'

export type ModelSelectionKind = 'agent' | 'subagent'
export type SelectionDependency = { key: string; paths: readonly (readonly [string, string])[]; storage?: 'json' | 'string' }
export type SelectionSourceProof = { lifecycle: SettingsLifecycleSnapshot; checks: readonly SelectionDependency[];
  membership: { key: string; member: string; present: true }; memberships?: readonly { key: string; member: string; present: true }[] }
export type ModelSelectionMutation = ({ source: SelectionSourceProof; clear?: never } | { clear: ModelSelectionClear; source?: never }) & { check(): void; signal?: AbortSignal; deadlineAt?: number;
  authority?: { key: string; paths: readonly (readonly [string, string])[]; lifecycle?: SettingsLifecycleSnapshot }; onSaved?(): void }
export type ModelSelectionRawGuard = { paths: readonly string[]; raw: readonly string[]; providerKeys?: readonly string[];
  containers?: readonly { path: string; type: string }[];
  checks?: readonly { keyIndex: number; paths: readonly (readonly [string, string])[]; storage?: 'json' | 'string' }[];
  memberships?: readonly { keyIndex: number; member: string }[]; deadlineAt?: number; clientBase?: boolean; currentType?: string }
export type ModelSelectionSnapshot = ModelSelectionRawGuard & { record: Record<string, unknown>; revision: string; lifecycle: SettingsLifecycleSnapshot; extraRaw: readonly string[] }
export type ModelSelectionClear = Readonly<{ readonly modelSelectionClear: unique symbol }>
const originalSelectionSnapshots = new WeakMap<ModelSelectionSnapshot, ModelSelectionKind>()
const clearPlans = new WeakMap<ModelSelectionClear, { kind: ModelSelectionKind; revision: string; lifecycle: SettingsLifecycleSnapshot;
  id: unknown; userId: unknown; type: unknown; resolvedType: string; presetId: unknown; updates: Readonly<Record<string, unknown>> }>()
/** Only the actual atomic original reader can prepare an absent-destination clear. */
export function prepareModelSelectionClear(target: ModelSelectionSnapshot, kind: ModelSelectionKind) {
  const type = kind === 'agent' ? normalizePrimaryAgentType(target.record) : normalizeSubagentType(target.record)
  // SA-139 R4/R5: only the live API type holds a selection; a retired `cli` record is never written.
  if (originalSelectionSnapshots.get(target) !== kind || type !== 'api' || typeof target.record.user_id !== 'string' || !target.record.user_id) throw new ModelSelectionConflictError()
  assertSettingsLifecycle(target.lifecycle)
  const updates = buildClearedPresetSelection(kind, target.record)
  const handle = Object.freeze({}) as ModelSelectionClear
  clearPlans.set(handle, { kind, revision: target.revision, lifecycle: structuredClone(target.lifecycle), id: target.record.id,
    userId: target.record.user_id, type: target.record[kind === 'agent' ? 'agentType' : 'subagentType'], resolvedType: type, presetId: target.record.primary_model_preset_id, updates: structuredClone(updates) })
  return { clear: handle, updates: { ...updates, ...(Object.keys(updates).length && kind === 'agent' && target.record.agentType !== type ? { agentType: type } : {}) } }
}
/** Only the genuine clear may carry the old preset's absence into the atomic save. */
export function assertModelSelectionClearOwner(handle: ModelSelectionClear, kind: ModelSelectionKind, id: string, userId: string, presetId: string) {
  const plan = clearPlans.get(handle)
  if (!plan || plan.kind !== kind || plan.id !== id || plan.userId !== userId || plan.presetId !== presetId) throw new ModelSelectionConflictError()
  assertSettingsLifecycle(plan.lifecycle)
}
/** A clear may detach a missing old preset, but must not adopt a foreign or malformed one. */
export const READ_CLEAR_PRESET_STATE_SCRIPT = `
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'INVALID' end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'ABSENT' end
if indexType ~= 'set' or redis.call('SISMEMBER', KEYS[2], ARGV[1]) ~= 1 then return 'INVALID' end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID' end
local id = redis.call('JSON.GET', KEYS[1], '$.id')
if not id or cjson.decode(id)[1] ~= ARGV[1] then return 'INVALID' end
return 'PRESENT'
`
/** No read, replacement capture or structural lookalike can supply the original clear plan. */
export function assertModelSelectionClear(handle: ModelSelectionClear, target: ModelSelectionSnapshot, updates: Readonly<Record<string, unknown>>, kind: ModelSelectionKind) {
  const plan = clearPlans.get(handle)
  if (!plan || plan.kind !== kind || target.revision !== plan.revision || target.record.id !== plan.id || target.record.user_id !== plan.userId ||
    target.record[kind === 'agent' ? 'agentType' : 'subagentType'] !== plan.type || !sameJsonValue(target.lifecycle, plan.lifecycle)) throw new ModelSelectionConflictError()
  assertSettingsLifecycle(plan.lifecycle)
  const resultingType = kind === 'agent' ? updates.agentType : updates.subagentType
  if (resultingType !== undefined && resultingType !== plan.resolvedType) throw new ModelSelectionConflictError()
  const modelUpdates = Object.fromEntries(Object.entries(updates).filter(([field]) => field !== 'agentType' && field !== 'subagentType'))
  if (!sameJsonValue(modelUpdates, plan.updates)) throw new ModelSelectionConflictError()
  for (const field of AGENT_MODEL_FIELDS.slice(0, 4)) {
    const value = Object.hasOwn(updates, field) ? updates[field] : target.record[field]
    if (value !== undefined && value !== null && (field === 'primary_model_connection' || value !== '')) throw new ModelSelectionConflictError()
  }
}
const IDENTITIES = AGENT_MODEL_FIELDS.slice(0, 4)
const RUNTIME_KEYS = JSON.stringify([...INTERNAL_SETTING_NAMES])
const RUNTIME_PREFIXES = JSON.stringify(INTERNAL_SETTING_PREFIXES)
/** The same finite key ownership as modelSettingsMapper; no request supplies this rule. */
export const MODEL_SETTING_KEY_LUA = `
local ownKeys = {}
for _, name in ipairs(cjson.decode('${RUNTIME_KEYS}')) do ownKeys[name] = true end
local ownPrefixes = cjson.decode('${RUNTIME_PREFIXES}')
local function modelKey(name)
  if ownKeys[name] or string.match(name, '^native[A-Z]') then return false end
  for _, prefix in ipairs(ownPrefixes) do if string.sub(name, 1, #prefix) == prefix then return false end end
  return true
end
`
export const CHECK_MODEL_SELECTION_LUA = `
if modelSelection.deadlineAt then
  local now = redis.call('TIME')
  if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= modelSelection.deadlineAt then return 'MODEL_SELECTION_EXPIRED' end
end
for _, membership in ipairs(modelSelection.memberships or {}) do
  if redis.call('SISMEMBER', KEYS[membership.keyIndex], membership.member) ~= 1 then return 'MODEL_SELECTION_CHANGED' end
end
for _, dependency in ipairs(modelSelection.checks or {}) do
  for _, entry in ipairs(dependency.paths) do
    local raw
    if dependency.storage == 'string' then raw = redis.call('GET', KEYS[dependency.keyIndex])
    else raw = redis.call('JSON.GET', KEYS[dependency.keyIndex], entry[1]) end
    if (raw or '') ~= entry[2] then return 'MODEL_SELECTION_CHANGED' end
  end
end
for index, path in ipairs(modelSelection.paths) do
  if (redis.call('JSON.GET', KEYS[1], path) or '') ~= modelSelection.raw[index] then return 'MODEL_SELECTION_CHANGED' end
end
for _, container in ipairs(modelSelection.containers or {}) do
  if (redis.call('JSON.TYPE', KEYS[1], container.path)[1] or '') ~= container.type then return 'MODEL_SELECTION_CHANGED' end
end
if modelSelection.providerKeys then
  local blockType = redis.call('JSON.TYPE', KEYS[1], '$.provider_specific_settings')[1]
  if blockType and blockType ~= 'null' and blockType ~= 'object' then return 'MODEL_SELECTION_CHANGED' end
  local block = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.provider_specific_settings') or '[]')[1]
  local expectedKeys = {}
  for _, name in ipairs(modelSelection.providerKeys) do expectedKeys[name] = true end
  if type(block) == 'table' then
    for name, _ in pairs(block) do if modelKey(name) and not expectedKeys[name] then return 'MODEL_SELECTION_CHANGED' end end
  end
end
`
export const READ_MODEL_SELECTION_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID'} end
${MODEL_SETTING_KEY_LUA}
-- Report snapshots need the same exact model proof, without loading unrelated prompt text.
local record = ARGV[4] == 'projection' and '[{}]' or redis.call('JSON.GET', KEYS[1], '$')
local paths = cjson.decode(ARGV[1])
local providerKeys = {}
if ARGV[2] == 'agent' then
  local blockType = redis.call('JSON.TYPE', KEYS[1], '$.provider_specific_settings')[1]
  if blockType and blockType ~= 'null' and blockType ~= 'object' then return {'INVALID'} end
  local block = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.provider_specific_settings') or '[]')[1]
  if block ~= nil and block ~= cjson.null and type(block) ~= 'table' then return {'INVALID'} end
  if type(block) == 'table' then for name, _ in pairs(block) do
    if modelKey(name) then providerKeys[#providerKeys + 1] = name end
  end end
  table.sort(providerKeys)
  for _, name in ipairs(providerKeys) do
    local escaped = string.gsub(string.gsub(name, '\\\\', '\\\\\\\\'), '"', '\\\\"')
    paths[#paths + 1] = '$.provider_specific_settings["' .. escaped .. '"]'
  end
end
local out = {'OK', record, cjson.encode(paths), #providerKeys == 0 and '[]' or cjson.encode(providerKeys)}
for _, path in ipairs(paths) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
for _, path in ipairs(cjson.decode(ARGV[3] or '[]')) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return out
`
export class ModelSelectionBaseRequiredError extends Error {
  readonly status = 400; readonly code = 'model_selection_base_required'
  constructor() { super('Read the saved model selection before making this choice. Nothing was saved.') }
}
/** Only server-owned dependency proofs reach the fixed ordinary record scripts. */
export function modelSelectionIssueGuard(target: ModelSelectionSnapshot, source: SelectionSourceProof | undefined,
  keys: string[], mutation?: ModelSelectionMutation, extraChecks: readonly SelectionDependency[] = []): ModelSelectionRawGuard {
  const addKey = (key: string) => { const index = keys.indexOf(key); if (index >= 0) return index + 1; keys.push(key); return keys.length }
  const checks = [...(source?.checks ?? []), ...extraChecks, ...(mutation?.authority ? [{ key: mutation.authority.key, paths: mutation.authority.paths }] : [])]
  return { paths: target.paths, raw: target.raw, ...(target.providerKeys ? { providerKeys: target.providerKeys } : {}),
    ...(target.containers ? { containers: target.containers } : {}),
    checks: checks.map(check => ({ keyIndex: addKey(check.key), paths: check.paths, ...(check.storage ? { storage: check.storage } : {}) })),
    ...(source ? { memberships: (source.memberships ?? [source.membership]).map(membership => ({ keyIndex: addKey(membership.key), member: membership.member })) } : {}),
    ...(mutation?.deadlineAt !== undefined ? { deadlineAt: mutation.deadlineAt } : {}) }
}
export class ModelSelectionConflictError extends Error {
  readonly status = 409; readonly code = 'model_selection_settings_changed'
  constructor() { super('The saved model selection changed. Read its current value and choose again; nothing was saved.') }
}
export class ModelSelectionSaveUnconfirmedError extends Error {
  readonly status = 503; readonly code = 'model_selection_save_unconfirmed'
  constructor() { super('The model selection save was issued but its outcome is unconfirmed. Check current values before making another choice; do not automatically repeat this save.') }
}
export function requireModelSelectionRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new ModelSelectionBaseRequiredError()
}
export function namesModelSelection(kind: ModelSelectionKind, updates: Record<string, unknown>): boolean {
  if ((kind === 'agent' ? AGENT_MODEL_FIELDS : IDENTITIES).some(field => Object.hasOwn(updates, field) && updates[field] !== undefined)) return true
  if (kind !== 'agent' || !Object.hasOwn(updates, 'provider_specific_settings')) return false
  const block = updates.provider_specific_settings
  return block === null || !!block && typeof block === 'object' && !Array.isArray(block) &&
    (Object.keys(block).length === 0 || Object.entries(block).some(([key, value]) => value !== undefined && !isAgentRuntimeSettingKey(key)))
}
export function modelSelectionTypePaths(kind: ModelSelectionKind) {
  return [...new Set(['id', 'user_id', 'created_at', ...(kind === 'agent' ? PRIMARY_AGENT_TYPE_SOURCE_FIELDS :
    ['subagentType', 'subagent_type', 'workflowName', 'workflow_name', 'webhookUrl', 'webhook_url'])])].map(field => `$.${field}`)
}
export function modelSelectionPaths(kind: ModelSelectionKind) {
  return [...new Set([...modelSelectionTypePaths(kind), ...(kind === 'agent' ? AGENT_MODEL_FIELDS : [...IDENTITIES, 'model']).map(field => `$.${field}`)])]
}
export function modelSelectionRevision(id: string, kind: ModelSelectionKind, guard: ModelSelectionRawGuard, lifecycle: SettingsLifecycleSnapshot) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ id, kind, ...guard, lifecycle })).digest('hex')}`
}
export async function readModelSelectionSnapshot(client: { eval(script: string, options: {keys: string[]; arguments: string[]}): Promise<unknown> },
  id: string, kind: ModelSelectionKind, lifecycle = captureSettingsLifecycle([`${kind}:${id}`]), extraPaths: readonly string[] = [], options?: { reportProjection?: true; typeFenceOnly?: true }): Promise<ModelSelectionSnapshot> {
  assertSettingsLifecycle(lifecycle)
  const answer = await client.eval(READ_MODEL_SELECTION_SCRIPT, { keys: [`${kind}:${id}`], arguments: [JSON.stringify(options?.typeFenceOnly ? modelSelectionTypePaths(kind) : modelSelectionPaths(kind)), options?.typeFenceOnly ? 'type-fence' : kind,
    JSON.stringify(extraPaths), options?.reportProjection ? 'projection' : ''] })
  assertSettingsLifecycle(lifecycle)
  if (Array.isArray(answer) && answer[0] === 'MISSING') throw Object.assign(new Error('Agent not found'), { status: 404 })
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.slice(1).some(value => typeof value !== 'string')) throw new ModelSelectionConflictError()
  const rows = JSON.parse(answer[1]); const paths = JSON.parse(answer[2]); const providerKeys = JSON.parse(answer[3])
  const raw = answer.slice(4, 4 + paths.length) as string[]
  const extraRaw = answer.slice(4 + paths.length, 4 + paths.length + extraPaths.length) as string[]
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || !Array.isArray(paths) || raw.length !== paths.length ||
    raw.some(value => !Array.isArray(JSON.parse(value || '[]')) || JSON.parse(value || '[]').length > 1) || !Array.isArray(providerKeys)) throw new ModelSelectionConflictError()
  const guard = { paths, raw, ...(kind === 'agent' && !options?.typeFenceOnly ? { providerKeys } : {}) }
  if (extraRaw.length !== extraPaths.length) throw new ModelSelectionConflictError()
  if (options?.reportProjection) {
    // Top-level fixed fields and the already-enumerated model-owned provider keys only.
    // The sparse model writer retains native keys; these report facts grant no weaker write.
    const record: Record<string, unknown> = {}
    paths.forEach((path: string, index: number) => {
      const values = JSON.parse(raw[index] || '[]')
      if (!values.length) return
      if (path.startsWith('$.provider_specific_settings[')) {
        const key = JSON.parse(path.slice('$.provider_specific_settings['.length, -1))
        const block = record.provider_specific_settings ??= Object.create(null)
        Object.defineProperty(block, key, { value: values[0], enumerable: true, writable: true, configurable: true })
      } else Object.defineProperty(record, path.slice(2), { value: values[0], enumerable: true, writable: true, configurable: true })
    })
    rows[0] = record
  }
  if (rows[0].id !== id) throw new ModelSelectionConflictError()
  if (Buffer.byteLength(JSON.stringify(guard), 'utf8') > 131072) throw new ModelSelectionConflictError()
  const snapshot: ModelSelectionSnapshot = { ...guard, record: rows[0], lifecycle, extraRaw, revision: modelSelectionRevision(id, kind, guard, lifecycle) }
  assertSettingsLifecycle(lifecycle)
  originalSelectionSnapshots.set(snapshot, kind)
  return snapshot
}
