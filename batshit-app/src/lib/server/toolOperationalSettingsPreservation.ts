import { acquireSettingsMutation, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'
import { makeToolOperationsSnapshot, TOOL_OPERATION_PATHS, ToolOperationsInvalid, type ToolOperationsSnapshot } from './toolOperationalSettingsOwner'

export class UserSettingsSourceChanged extends Error {
  readonly status = 409; readonly code = 'user_settings_changed'
  constructor() { super('Saved user settings changed during this save. Nothing was saved; read the saved settings before trying again.') }
}
const own = (value: object, key: string) => Object.hasOwn(value, key)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const TOOL_OPERATIONS_PRESERVATION_PATHS = Object.freeze([...TOOL_OPERATION_PATHS, '$.admin_settings'])
const FIELDS = TOOL_OPERATION_PATHS.slice(3).map(path => path.slice('$.admin_settings.'.length))

/** Whole legacy blocks may not author the new group or restore retired inheritance. */
export function refuseWholeToolOperationsWrite(updates: { admin_settings?: unknown; global_tool_grid_settings?: unknown }) {
  const grid = updates.global_tool_grid_settings
  if (grid !== undefined && grid !== null && !object(grid)) throw new ToolOperationsInvalid('Global Tool Grid settings must be an object or null. Nothing was saved.')
  const admin = updates.admin_settings
  if (object(admin) && FIELDS.some(field => own(admin, field))) throw new ToolOperationsInvalid('Save global Web Search and Agent Browser options through their current Admin controls. Nothing was saved.')
  if (object(grid) && own(grid, 'typed_file_tools')) throw new ToolOperationsInvalid('Typed File Tools is an explicit choice in each agent\'s Tools settings. Nothing was saved.')
}
interface SettingsPostimage { admin_settings?: unknown }

/** Preservation is not new edit consent: discard stale parsed copies and retain current RAW values. */
export function prepareToolOperationsPreservation(userId: string, settings: SettingsPostimage, source: { key: string; exists?: boolean; rootRaw?: string | null; record: Record<string, any>; paths: Array<[string, string]>; extraRawPaths?: Array<[string, string]> }, lifecycle: SettingsLifecycleSnapshot, adminExplicit = false) {
  if (source.key !== `user:${userId}:settings` || typeof source.exists !== 'boolean') throw new ToolOperationsInvalid('The original global tool settings source is unavailable.')
  if (source.exists ? typeof source.rootRaw !== 'string' : source.rootRaw !== null) throw new ToolOperationsInvalid('The original user settings source is unavailable.')
  const rootRaw = source.rootRaw as string | null // Narrowed by the strict presence/type guard above.
  const priorAdmin = source.record.admin_settings
  if (priorAdmin !== undefined && priorAdmin !== null && !object(priorAdmin) || object(priorAdmin) && priorAdmin.agent_browser !== undefined && priorAdmin.agent_browser !== null && !object(priorAdmin.agent_browser)) throw new ToolOperationsInvalid('Saved global tool options are malformed. Nothing was saved.')
  const values = new Map([...source.paths, ...(source.extraRawPaths ?? [])])
  const raw = TOOL_OPERATION_PATHS.map(path => source.exists ? values.get(path) : '[]')
  if (raw.some(value => typeof value !== 'string')) throw new ToolOperationsInvalid('The original global tool settings source is unavailable.')
  const snapshot = makeToolOperationsSnapshot(userId, source.exists, raw as string[], lifecycle)
  if (!adminExplicit) {
    const adminRaw = source.exists ? values.get('$.admin_settings') : '[]'
    if (typeof adminRaw !== 'string') throw new ToolOperationsInvalid('The original Admin settings source is unavailable.')
    const decoded: unknown = JSON.parse(adminRaw)
    if (!Array.isArray(decoded) || decoded.length > 1) throw new ToolOperationsInvalid('The original Admin settings source is unavailable.')
    if (decoded.length) settings.admin_settings = decoded[0]; else delete settings.admin_settings
    return { snapshot, literal: decoded.length ? adminRaw.trim().slice(1, -1) : undefined, adminRaw, rootRaw }
  }
  const input = settings.admin_settings
  if (input !== undefined && input !== null && !object(input)) throw new ToolOperationsInvalid('Admin settings must be an object or null. Nothing was saved.')
  const next = { ...(object(input) ? input : {}) }
  for (const name of FIELDS) delete next[name]
  const rawFields: string[] = []
  for (let index = 3; index < TOOL_OPERATION_PATHS.length; index++) {
    const raw = snapshot.raw[index].trim(), decoded: unknown = JSON.parse(raw)
    if (!Array.isArray(decoded) || decoded.length > 1) throw new ToolOperationsInvalid('Saved global tool options are unavailable.')
    if (!decoded.length) continue
    const name = FIELDS[index - 3]
    next[name] = decoded[0]
    rawFields.push(`${JSON.stringify(name)}:${raw.slice(1, -1)}`)
  }
  // Keep the response's known globals aligned with actual storage. The raw literal owns publication.
  if (rawFields.length || object(input)) settings.admin_settings = next
  let literal: string | undefined
  if (rawFields.length || object(input)) {
    const ordinary = { ...next }
    for (const name of FIELDS) delete ordinary[name]
    const plain = JSON.stringify(ordinary)
    literal = `${plain.slice(0, -1)}${plain === '{}' || !rawFields.length ? '' : ','}${rawFields.join(',')}}`
  }
  return { snapshot, literal, adminRaw: undefined, rootRaw }
}

/** Embed before the existing Goon/preset/type guards and single final JSON.SET. */
export const CHECK_TOOL_OPERATIONS_PRESERVATION_LUA = `
if not ARGV[6] or ARGV[6] == '' then return 'TOOL_OPERATIONS_CHANGED' end
local toolSource = cjson.decode(ARGV[6])
local exists = redis.call('EXISTS', KEYS[1]) == 1
if (exists and true or false) ~= toolSource.exists then return 'TOOL_OPERATIONS_CHANGED' end
if exists then
  local kind = redis.call('TYPE', KEYS[1]).ok
  if kind ~= 'ReJSON-RL' or redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'TOOL_OPERATIONS_CHANGED' end
end
if exists and (redis.call('JSON.GET', KEYS[1], '$.global_tool_grid_settings.typed_file_tools') or '') ~= '[]' then return 'TOOL_OPERATIONS_CHANGED' end
if toolSource.adminRaw ~= nil then
  local raw = exists and (redis.call('JSON.GET', KEYS[1], '$.admin_settings') or '') or '[]'
  if raw ~= toolSource.adminRaw then return 'TOOL_OPERATIONS_CHANGED' end
end
local paths = cjson.decode('${JSON.stringify(TOOL_OPERATION_PATHS)}')
if type(toolSource.raw) ~= 'table' or #toolSource.raw ~= #paths then return 'TOOL_OPERATIONS_CHANGED' end
for index, path in ipairs(paths) do
  local raw = exists and (redis.call('JSON.GET', KEYS[1], path) or '') or '[]'
  if raw ~= toolSource.raw[index] then return 'TOOL_OPERATIONS_CHANGED' end
end
`
/** Preserve the existing specialized asset/preset/recovery refusals, then fence the final root. */
export const CHECK_USER_SETTINGS_ROOT_LUA = `
local rootRaw = exists and redis.call('JSON.GET', KEYS[1], '$') or cjson.null
if rootRaw ~= toolSource.rootRaw then return 'USER_SETTINGS_CHANGED' end
`
export function toolOperationsPreservationArgument(snapshot: ToolOperationsSnapshot, adminRaw: string | undefined, rootRaw: string | null): string {
  return JSON.stringify({ exists: snapshot.exists, raw: snapshot.raw, rootRaw, ...(adminRaw !== undefined ? { adminRaw } : {}) })
}
export const acquireToolOperationsPreservation = (snapshot: ToolOperationsSnapshot) => acquireSettingsMutation(snapshot.lifecycle)
