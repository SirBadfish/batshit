import { createHash } from 'node:crypto'
import { AUTO_COMPACT_COMMON_FIELDS, type AutoCompactField, type AutoCompactChanges } from '$lib/appActions/settings/autoCompactPreferences'
import { PRIMARY_AGENT_TYPE_SOURCE_FIELDS, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { captureSettingsLifecycle, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'

export const AUTO_COMPACT_PATHS = AUTO_COMPACT_COMMON_FIELDS.map(field => `$.auto_compact_settings["${field}"]`)
export const AUTO_COMPACT_READ_PATHS = [...new Set(['id', 'user_id', 'created_at', ...PRIMARY_AGENT_TYPE_SOURCE_FIELDS])].map(field => `$.${field}`)
export class AutoCompactBaseRequiredError extends Error {
  readonly status = 400; readonly code = 'auto_compact_base_required'
  constructor() { super('Read the saved Auto Compact preferences before changing them. Nothing was saved.') }
}
export class AutoCompactConflictError extends Error {
  readonly status = 409; readonly code = 'auto_compact_settings_changed'
  constructor() { super('Auto Compact preferences changed. Your draft is kept; read the saved preferences before another choice. Nothing was saved.') }
}
export class AutoCompactSaveUnconfirmedError extends Error {
  readonly status = 503; readonly code = 'auto_compact_save_unconfirmed'
  constructor() { super('The Auto Compact save was issued but its outcome is unconfirmed. Do not automatically repeat it.') }
}
export function requireAutoCompactExpected(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new AutoCompactBaseRequiredError()
}
function value(raw: string): unknown {
  const values = JSON.parse(raw || '[]')
  if (!Array.isArray(values) || values.length > 1) throw new AutoCompactConflictError()
  return values[0]
}
export type AutoCompactSnapshot = Readonly<{ id: string; record: Readonly<Record<string, unknown>>; paths: readonly string[]; raw: readonly string[];
  parentType: string; globalType: string; globalRaw: Readonly<Record<AutoCompactField, string>>; lifecycle: SettingsLifecycleSnapshot; revision: string }>
export function makeAutoCompactSnapshot(id: string, pairs: readonly (readonly [string, string])[], parentType: string, globalType: string,
  globalRaw: Readonly<Record<AutoCompactField, string>>, lifecycle: SettingsLifecycleSnapshot): AutoCompactSnapshot {
  assertSettingsLifecycle(lifecycle)
  const map = new Map(pairs), record = Object.fromEntries(pairs.filter(([path]) => !AUTO_COMPACT_PATHS.includes(path)).map(([path, raw]) => [path.slice(2), value(raw)]))
  if (record.id !== id || typeof record.user_id !== 'string') throw new AutoCompactConflictError()
  // Auto Compact is a live Primary's setting. A leftover retired record (`cli`, `n8n`) is fenced on
  // all its type fields and still reads (Settings shows it for delete); only a save refuses it.
  const canonical = record.agentType === 'api'
  const identity = ['$.id', '$.user_id', '$.created_at', ...(canonical ? ['$.agentType'] : PRIMARY_AGENT_TYPE_SOURCE_FIELDS.map(field => `$.${field}`))]
  const paths = [...identity, ...AUTO_COMPACT_PATHS]
  if (paths.some(path => !map.has(path))) throw new AutoCompactConflictError()
  const raw = paths.map(path => map.get(path)!)
  const common = Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.flatMap((field, index) => { const item = value(map.get(AUTO_COMPACT_PATHS[index])!); return item === undefined ? [] : [[field, item]] }))
  record.auto_compact_settings = parentType === '' ? undefined : parentType === 'null' ? null : parentType === 'object' ? common : 'invalid_container'
  const global = Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.flatMap(field => { const item = value(globalRaw[field]); return item === undefined ? [] : [[field, item]] }))
  record.__autoCompactGlobal = globalType === '' ? undefined : globalType === 'null' ? null : globalType === 'object' ? global : 'invalid_container'
  const revision = `sha256:${createHash('sha256').update(JSON.stringify({ id, parentType, paths, raw, lifecycle })).digest('hex')}`
  return Object.freeze({ id, record: Object.freeze(record), paths: Object.freeze(paths), raw: Object.freeze(raw), parentType, globalType, globalRaw: Object.freeze({ ...globalRaw }), lifecycle, revision })
}
const READ_AUTO_COMPACT = `
-- BATSHIT_AUTO_COMPACT_SNAPSHOT_V1: fixed common leaves only, never model/prompt.
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID'} end
local targetType = redis.call('JSON.TYPE', KEYS[1], '$.auto_compact_settings')
local globalType = redis.call('JSON.TYPE', KEYS[2], '$.global_auto_compact_settings')
local out = {'OK', targetType and targetType[1] or '', globalType and globalType[1] or ''}
local function bounded(key, path, identity)
  if ARGV[3] == '0' then return redis.call('JSON.GET', key, path) or '' end
  local types = redis.call('JSON.TYPE', key, path)
  local t = types and types[1] or 'absent'
  if t == 'absent' then return redis.call('JSON.GET', key, path) or '' end
  if t == 'null' then return '[null]' end
  if t == 'string' then
    local lengths = redis.call('JSON.STRLEN', key, path)
    if not lengths or lengths[1] > (identity and 1024 or 32) then return '["invalid_saved_common"]' end
  elseif t ~= 'integer' and t ~= 'number' and t ~= 'boolean' then return '["invalid_saved_common"]' end
  return redis.call('JSON.GET', key, path) or ''
end
for index, path in ipairs(cjson.decode(ARGV[1])) do out[#out+1] = bounded(KEYS[1], path, index <= ${AUTO_COMPACT_READ_PATHS.length}) end
for _, path in ipairs(cjson.decode(ARGV[2])) do out[#out+1] = ARGV[3] == '0' and '[]' or bounded(KEYS[2], path, false) end
return out
`
export async function readAutoCompactSnapshot(client: { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }, id: string,
  userId: string, lifecycle = captureSettingsLifecycle([`agent:${id}`]), bounded = true): Promise<AutoCompactSnapshot> {
  assertSettingsLifecycle(lifecycle)
  const paths = [...AUTO_COMPACT_READ_PATHS, ...AUTO_COMPACT_PATHS]
  const answer = await client.eval(READ_AUTO_COMPACT, { keys: [`agent:${id}`, `user:${userId}:settings`], arguments: [JSON.stringify(paths), JSON.stringify(AUTO_COMPACT_COMMON_FIELDS.map(field => `$.global_auto_compact_settings["${field}"]`)), bounded ? '1' : '0'] })
  assertSettingsLifecycle(lifecycle)
  if (Array.isArray(answer) && answer[0] === 'MISSING') throw Object.assign(new Error('Agent not found'), { status: 404 })
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== paths.length + 6 || answer.slice(1).some(raw => typeof raw !== 'string')) throw new AutoCompactConflictError()
  return makeAutoCompactSnapshot(id, paths.map((path, index) => [path, answer[index + 3]]), answer[1], answer[2],
    Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.map((field, index) => [field, answer[paths.length + 3 + index]])) as Record<AutoCompactField, string>, lifecycle)
}
/** Atomic ordinary detail GET already has the full human record and these raw fixed paths. */
export function autoCompactSnapshotFromDetail(id: string, record: Record<string, unknown>, raw: readonly string[], lifecycle: SettingsLifecycleSnapshot) {
  const paths = [...AUTO_COMPACT_READ_PATHS, ...AUTO_COMPACT_PATHS]
  const block = record.auto_compact_settings
  const type = !Object.hasOwn(record, 'auto_compact_settings') ? '' : block === null ? 'null' : Array.isArray(block) ? 'array' : typeof block
  return makeAutoCompactSnapshot(id, paths.map((path, index) => [path, raw[index]]), type, '', { mode: '[]', triggerMode: '[]', remainingTokens: '[]' }, lifecycle)
}
export type AutoCompactMutation = Readonly<{ target: AutoCompactSnapshot; changes: AutoCompactChanges; globalFields: readonly AutoCompactField[];
  check(): void; signal: AbortSignal; deadlineAt: number; onSaved?(): void;
  authority: { key: string; paths: readonly (readonly [string, string])[]; lifecycle?: SettingsLifecycleSnapshot } }>
export type AutoCompactRawGuard = Readonly<{ clientBase: true; paths: readonly string[]; raw: readonly string[]; parentType: string; deadlineAt?: number;
  global?: { keyIndex: number; parentType: string; paths: readonly (readonly [string, string])[] }; authority?: { keyIndex: number; paths: readonly (readonly [string, string])[] } }>
export function checkAutoCompactIssue(mutation?: AutoCompactMutation) {
  if (!mutation) return
  mutation.check(); assertSettingsLifecycle(mutation.target.lifecycle)
  if (mutation.authority.lifecycle) assertSettingsLifecycle(mutation.authority.lifecycle)
  if (mutation.signal.aborted || !Number.isFinite(mutation.deadlineAt) || Date.now() >= mutation.deadlineAt) throw new AutoCompactConflictError()
}
export function autoCompactIssueGuard(snapshot: AutoCompactSnapshot, expected: unknown, keys: string[], mutation?: AutoCompactMutation): AutoCompactRawGuard {
  requireAutoCompactExpected(expected)
  if (snapshot.revision !== expected || mutation && mutation.target.revision !== snapshot.revision || normalizePrimaryAgentType(snapshot.record) !== 'api') throw new AutoCompactConflictError()
  checkAutoCompactIssue(mutation)
  const add = (key: string) => { let index = keys.indexOf(key); if (index < 0) { keys.push(key); index = keys.length - 1 } return index + 1 }
  return { clientBase: true, paths: snapshot.paths, raw: snapshot.raw, parentType: snapshot.parentType,
    ...(mutation ? { deadlineAt: mutation.deadlineAt, authority: { keyIndex: add(mutation.authority.key), paths: mutation.authority.paths } } : {}),
    ...(mutation?.globalFields.length ? { global: { keyIndex: add(`user:${snapshot.record.user_id}:settings`), parentType: mutation.target.globalType,
      paths: mutation.globalFields.map(field => [`$.global_auto_compact_settings["${field}"]`, mutation.target.globalRaw[field]] as const) } } : {}) }
}
export const CHECK_AUTO_COMPACT_LUA = `
if not compact.clientBase then return 'AUTO_COMPACT_BASE_REQUIRED' end
if compact.deadlineAt then
  local now = redis.call('TIME')
  if tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000) >= compact.deadlineAt then return 'AUTO_COMPACT_EXPIRED' end
end
if (redis.call('JSON.TYPE', KEYS[1], '$.auto_compact_settings')[1] or '') ~= compact.parentType then return 'AUTO_COMPACT_CHANGED' end
for index, path in ipairs(compact.paths) do
  if (redis.call('JSON.GET', KEYS[1], path) or '') ~= compact.raw[index] then return 'AUTO_COMPACT_CHANGED' end
end
if compact.global then
  local globalType = redis.call('JSON.TYPE', KEYS[compact.global.keyIndex], '$.global_auto_compact_settings')
  if (globalType and globalType[1] or '') ~= compact.global.parentType then return 'AUTO_COMPACT_CHANGED' end
  for _, pair in ipairs(compact.global.paths) do if (redis.call('JSON.GET', KEYS[compact.global.keyIndex], pair[1]) or '') ~= pair[2] then return 'AUTO_COMPACT_CHANGED' end end
end
if compact.authority then
  for _, pair in ipairs(compact.authority.paths) do if (redis.call('JSON.GET', KEYS[compact.authority.keyIndex], pair[1]) or '') ~= pair[2] then return 'AUTO_COMPACT_CHANGED' end end
end
`
