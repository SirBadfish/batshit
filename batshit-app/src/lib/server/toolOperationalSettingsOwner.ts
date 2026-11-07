import { createHash } from 'node:crypto'
import { acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'
import { AGENT_BROWSER_OPERATIONAL_FIELDS, resolveToolOperationalSettings, validateAgentBrowserOperationalPatch, type ToolOperationalSettings } from '$lib/utils/toolOperationalSettings'

/** Existing user-settings record only: no marker, auxiliary key, credential or execution authority. */
export const TOOL_OPERATIONS_REVISION_HEADER = 'x-batshit-tool-operations-revision'
const WEB = {
  webSearchProvider: ['web_search_default_provider', 'webSearchDefaultProvider'],
  webSearchExaSearchType: ['web_search_exa_type', 'webSearchExaType'],
  webSearchPerplexityMaxTokensPerPage: ['web_search_perplexity_max_tokens_per_page', 'webSearchPerplexityMaxTokensPerPage']
} as const
export const TOOL_OPERATION_PATHS = Object.freeze([
  '$.id', '$.user_id', '$.created_at',
  ...Object.values(WEB).flat().map(name => `$.admin_settings.${name}`), '$.admin_settings.agent_browser'
])
const own = (value: object, key: string) => Object.hasOwn(value, key)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validToken = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
export class ToolOperationsRefusal extends Error {
  readonly status = 409; readonly code = 'tool_operations_changed'
  constructor(message = 'Saved global tool options changed. Your draft was not saved; read the saved choices before trying again.') { super(message) }
}
export class ToolOperationsInvalid extends Error {
  readonly status = 400; readonly code = 'tool_operations_base_required'
  constructor(message = 'Read the saved global tool options before changing them. Nothing was saved.') { super(message) }
}
export class ToolOperationsUnconfirmed extends Error {
  readonly status = 503; readonly code = 'tool_operations_save_unconfirmed'
  constructor(readonly outcome: 'unknown' | 'partial' = 'unknown', readonly confirmedCommands: number | null = null) { super(outcome === 'partial' ? 'The global tool options save was partly applied. Its final outcome is unconfirmed; do not repeat it automatically.' : 'The global tool options save was issued but its outcome is unconfirmed. Do not repeat it automatically.') }
}
export interface ToolOperationsSnapshot {
  userId: string; exists: boolean; raw: readonly string[]; lifecycle: SettingsLifecycleSnapshot
  revision: string; values: ToolOperationalSettings
}
const READ = `
-- batshit-global-tool-operations-read-v1
if redis.call('EXISTS', KEYS[1]) == 0 then return {'ABSENT'} end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'INVALID'} end
local admin = redis.call('JSON.TYPE', KEYS[1], '$.admin_settings')[1]
local browser = redis.call('JSON.TYPE', KEYS[1], '$.admin_settings.agent_browser')[1]
if admin and admin ~= 'null' and admin ~= 'object' or browser and browser ~= 'null' and browser ~= 'object' then return {'INVALID'} end
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return out
`
function decoded(raw: string): unknown {
  const values: unknown = JSON.parse(raw)
  if (!Array.isArray(values) || values.length > 1) throw new ToolOperationsRefusal('Global tool options are unavailable. Nothing was saved.')
  return values[0]
}
export function makeToolOperationsSnapshot(userId: string, exists: boolean, raw: readonly string[], lifecycle: SettingsLifecycleSnapshot, knownAck = false): ToolOperationsSnapshot {
  if (!knownAck) assertSettingsLifecycle(lifecycle)
  if (raw.length !== TOOL_OPERATION_PATHS.length || raw.some(value => typeof value !== 'string')) throw new ToolOperationsRefusal('Global tool options are unavailable. Nothing was saved.')
  const values = raw.map(decoded)
  if (values[1] !== undefined && values[1] !== userId) throw new ToolOperationsRefusal('The global settings owner changed. Nothing was saved.')
  const admin = Object.fromEntries(TOOL_OPERATION_PATHS.slice(3).map((path, index) => [path.slice('$.admin_settings.'.length), values[index + 3]]))
  return { userId, exists, raw: [...raw], lifecycle,
    revision: `sha256:${createHash('sha256').update(JSON.stringify({ userId, exists, raw, lifecycle })).digest('hex')}`,
    values: resolveToolOperationalSettings({ admin_settings: admin }) }
}
export async function readToolOperationsSnapshot(client: { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }, userId: string): Promise<ToolOperationsSnapshot> {
  if (typeof userId !== 'string' || !userId || !userId.isWellFormed()) throw new ToolOperationsInvalid()
  const key = `user:${userId}:settings`, lifecycle = captureSettingsLifecycle([key])
  const answer = await client.eval(READ, { keys: [key], arguments: [JSON.stringify(TOOL_OPERATION_PATHS)] })
  assertSettingsLifecycle(lifecycle)
  if (Array.isArray(answer) && answer.length === 1 && answer[0] === 'ABSENT') return makeToolOperationsSnapshot(userId, false, TOOL_OPERATION_PATHS.map(() => '[]'), lifecycle)
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== TOOL_OPERATION_PATHS.length + 1) throw new ToolOperationsRefusal('Global tool options could not be read. Nothing was saved.')
  return makeToolOperationsSnapshot(userId, true, answer.slice(1) as string[], lifecycle)
}
type Operation = { kind: 'set'; path: string; value: string } | { kind: 'delete'; path: string }
const browserPath = (key: string) => `$.admin_settings.agent_browser.${key}`
const WRITABLE_PATHS = [...Object.values(WEB).flat().map(name => `$.admin_settings.${name}`), ...AGENT_BROWSER_OPERATIONAL_FIELDS.map(browserPath)]
/** Stage all finite literal intent BEFORE source IO. No input supplies a JSONPath/command. */
export function planToolOperationsChanges(input: unknown): readonly Operation[] {
  if (!object(input) || !Object.keys(input).length || Object.keys(input).some(key => !own(WEB, key) && key !== 'agentBrowser')) throw new ToolOperationsInvalid('Choose supported global tool options. Nothing was saved.')
  const ops: Operation[] = []
  for (const [key, value] of Object.entries(input)) {
    if (key === 'agentBrowser') {
      if (value !== null && !object(value)) throw new ToolOperationsInvalid('Agent Browser options must be an object or an explicit reset.')
      const entries = value === null ? AGENT_BROWSER_OPERATIONAL_FIELDS.map(name => [name, null] as const) : Object.entries(value)
      for (const [name, field] of entries) {
        if (!(AGENT_BROWSER_OPERATIONAL_FIELDS as readonly string[]).includes(name)) throw new ToolOperationsInvalid(`Unknown Agent Browser setting: ${name}.`)
        if (field === null) { ops.push({ kind: 'delete', path: browserPath(name) }); continue }
        const error = validateAgentBrowserOperationalPatch({ [name]: field })
        if (error) throw new ToolOperationsInvalid(error)
        ops.push({ kind: 'set', path: browserPath(name), value: JSON.stringify(field) })
      }
      continue
    }
    const names = WEB[key as keyof typeof WEB]
    if (value === null) { for (const name of names) ops.push({ kind: 'delete', path: `$.admin_settings.${name}` }); continue }
    if (key === 'webSearchProvider' && (typeof value !== 'string' || !['duckduckgo-html', 'exa', 'perplexity'].includes(value)) ||
        key === 'webSearchExaSearchType' && (typeof value !== 'string' || !['auto', 'fast', 'neural', 'deep'].includes(value)) ||
        key === 'webSearchPerplexityMaxTokensPerPage' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 64 || value > 4096)) throw new ToolOperationsInvalid('Choose a supported Web Search value. Nothing was saved.')
    ops.push({ kind: 'set', path: `$.admin_settings.${names[0]}`, value: JSON.stringify(value) })
  }
  if (!ops.length) throw new ToolOperationsInvalid('No global tool option changes were supplied.')
  return ops
}
/** A marker/shape alone cannot confirm an impossible saved postimage. Inspect owned facts only. */
function verifyToolOperationsPostimage(source: ToolOperationsSnapshot, saved: ToolOperationsSnapshot, ops: readonly Operation[], seed: { id: string; user_id: string; created_at: string }) {
  if (source.exists) {
    if (source.raw.slice(0, 3).some((raw, index) => saved.raw[index] !== raw)) throw new ToolOperationsUnconfirmed()
  } else if (decoded(saved.raw[0]) !== seed.id || decoded(saved.raw[1]) !== seed.user_id || decoded(saved.raw[2]) !== seed.created_at) throw new ToolOperationsUnconfirmed()
  const pathValues = new Map(TOOL_OPERATION_PATHS.map((path, index) => [path, saved.raw[index]]))
  const browserRaw = saved.raw.at(-1)!, browser = decoded(browserRaw)
  const owned = new Set(ops.map(op => op.path))
  for (const op of ops) {
    let present: boolean, value: unknown
    if (op.path.startsWith('$.admin_settings.agent_browser.')) {
      const name = op.path.slice('$.admin_settings.agent_browser.'.length)
      present = object(browser) && own(browser, name); value = object(browser) ? browser[name] : undefined
    } else {
      const raw = pathValues.get(op.path)
      if (raw === undefined) throw new ToolOperationsUnconfirmed()
      value = decoded(raw); present = value !== undefined
    }
    if (op.kind === 'delete' ? present : !present || JSON.stringify(value) !== op.value) throw new ToolOperationsUnconfirmed()
  }
  for (let index = 3; index < TOOL_OPERATION_PATHS.length - 1; index++) {
    if (!owned.has(TOOL_OPERATION_PATHS[index]) && saved.raw[index] !== source.raw[index]) throw new ToolOperationsUnconfirmed()
  }
  const browserChanges = ops.some(op => op.path.startsWith('$.admin_settings.agent_browser.'))
  if (!browserChanges && browserRaw !== source.raw.at(-1)) throw new ToolOperationsUnconfirmed()
  if (browserChanges) {
    const previous = decoded(source.raw.at(-1)!)
    for (const name of AGENT_BROWSER_OPERATIONAL_FIELDS) if (!owned.has(browserPath(name))) {
      const prior = object(previous) ? previous[name] : undefined, after = object(browser) ? browser[name] : undefined
      if (JSON.stringify(prior) !== JSON.stringify(after)) throw new ToolOperationsUnconfirmed()
    }
  }
}

export const SAVE_TOOL_OPERATIONS_SCRIPT = `
-- batshit-global-tool-operations-write-v1
if KEYS[1] ~= 'user:' .. ARGV[6] .. ':settings' then return {'INVALID'} end
local exists = redis.call('EXISTS', KEYS[1]) == 1
if (exists and '1' or '0') ~= ARGV[1] then return {'CHANGED'} end
if exists then
  local storage = redis.call('TYPE', KEYS[1]).ok
  if storage ~= 'ReJSON-RL' or redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID'} end
end
local validPaths, paths = pcall(cjson.decode, ARGV[2])
local validOriginal, original = pcall(cjson.decode, ARGV[3])
local validOps, ops = pcall(cjson.decode, ARGV[4])
if not validPaths or not validOriginal or not validOps or type(paths) ~= 'table' or type(original) ~= 'table' or type(ops) ~= 'table' or #paths ~= #original then return {'INVALID'} end
local fixed = cjson.decode('${JSON.stringify(TOOL_OPERATION_PATHS)}')
if #paths ~= #fixed then return {'INVALID'} end
for index, path in ipairs(paths) do if path ~= fixed[index] or type(original[index]) ~= 'string' then return {'INVALID'} end end
for index, path in ipairs(paths) do
  local raw = exists and (redis.call('JSON.GET', KEYS[1], path) or '') or '[]'
  if raw ~= original[index] then return {'CHANGED'} end
end
local allowed = {}
for _, path in ipairs(cjson.decode('${JSON.stringify(WRITABLE_PATHS)}')) do allowed[path] = true end
local setsAdmin, setsBrowser = false, false
for _, op in ipairs(ops) do
  if not allowed[op.path] or (op.kind ~= 'set' and op.kind ~= 'delete') then return {'INVALID'} end
  if op.kind == 'set' then
    if type(op.value) ~= 'string' or not pcall(cjson.decode, op.value) then return {'INVALID'} end
    setsAdmin = true
    if string.sub(op.path, 1, 31) == '$.admin_settings.agent_browser.' then setsBrowser = true end
  end
end
local adminType = exists and redis.call('JSON.TYPE', KEYS[1], '$.admin_settings')[1] or nil
local browserType = exists and redis.call('JSON.TYPE', KEYS[1], '$.admin_settings.agent_browser')[1] or nil
if adminType and adminType ~= 'null' and adminType ~= 'object' then return {'INVALID'} end
if browserType and browserType ~= 'null' and browserType ~= 'object' then return {'INVALID'} end
local valid, seed = pcall(cjson.decode, ARGV[5])
if not valid or type(seed) ~= 'table' or seed.user_id ~= ARGV[6] then return {'INVALID'} end
-- Only after every guard/container/value preflight succeeds do finite writes begin.
local confirmed = 0
local function write(command, path, value)
  local reply
  if command == 'JSON.SET' then reply = redis.pcall(command, KEYS[1], path, value)
  else reply = redis.pcall(command, KEYS[1], path) end
  if type(reply) == 'table' and reply.err then return false end
  if command == 'JSON.SET' and (type(reply) ~= 'table' or reply.ok ~= 'OK') then return false end
  if command == 'JSON.DEL' and type(reply) ~= 'number' then return false end
  confirmed = confirmed + 1
  return true
end
if not exists and not write('JSON.SET', '$', ARGV[5]) then return {'PARTIAL', confirmed} end
if setsAdmin and (not adminType or adminType == 'null') and not write('JSON.SET', '$.admin_settings', '{}') then return {'PARTIAL', confirmed} end
if setsBrowser and (not browserType or browserType == 'null') and not write('JSON.SET', '$.admin_settings.agent_browser', '{}') then return {'PARTIAL', confirmed} end
for _, op in ipairs(ops) do
  if not write(op.kind == 'set' and 'JSON.SET' or 'JSON.DEL', op.path, op.value) then return {'PARTIAL', confirmed} end
end
if not write('JSON.SET', '$.updated_at', ARGV[7]) then return {'PARTIAL', confirmed} end
local raw = {}
for _, path in ipairs(paths) do raw[#raw + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return {'STORED', raw}
`
export async function saveToolOperationalSettings(userId: string, expected: unknown, changes: unknown): Promise<ToolOperationsSnapshot> {
  if (!validToken(expected)) throw new ToolOperationsInvalid()
  const ops = planToolOperationsChanges(changes), encoded = JSON.stringify(ops)
  const { redis } = await import('./redis')
  return redis.execute(async client => {
    const source = await readToolOperationsSnapshot(client, userId)
    if (source.revision !== expected) throw new ToolOperationsRefusal()
    const lease = acquireSettingsMutation(source.lifecycle)
    const now = new Date().toISOString(), key = `user:${userId}:settings`
    const seed = { id: `settings_${userId}`, user_id: userId, created_at: now, updated_at: now }
    let answer: unknown, issued = false
    try {
      const args = [source.exists ? '1' : '0', JSON.stringify(TOOL_OPERATION_PATHS), JSON.stringify(source.raw), encoded,
        JSON.stringify(seed), userId, JSON.stringify(now)]
      lease.check(); issued = true
      answer = await client.eval(SAVE_TOOL_OPERATIONS_SCRIPT, { keys: [key], arguments: args })
      if (Array.isArray(answer) && answer.length === 2 && answer[0] === 'STORED' && Array.isArray(answer[1])) {
        let result: ToolOperationsSnapshot
        try {
          result = makeToolOperationsSnapshot(userId, true, answer[1] as string[], source.lifecycle, true)
          verifyToolOperationsPostimage(source, result, ops, seed)
        }
        catch { lease.unknown(); throw new ToolOperationsUnconfirmed() }
        lease.settle(); return result
      }
      if (Array.isArray(answer) && answer.length === 1 && ['CHANGED', 'INVALID'].includes(answer[0])) { lease.settle(); throw new ToolOperationsRefusal() }
      const partial = Array.isArray(answer) && answer.length === 2 && answer[0] === 'PARTIAL' && Number.isSafeInteger(answer[1]) && answer[1] >= 0 && answer[1] <= ops.length + 4
      lease.unknown(); throw new ToolOperationsUnconfirmed(partial ? 'partial' : 'unknown', partial ? (answer as unknown[])[1] as number : null)
    } catch (error) {
      if (error instanceof ToolOperationsRefusal || error instanceof ToolOperationsUnconfirmed) throw error
      if (issued) { lease.unknown(); throw new ToolOperationsUnconfirmed() }
      lease.settle(); throw error
    }
  })
}
/** Read failure propagates; a positive absent snapshot alone uses existing factory defaults. */
export async function readToolOperationalSettings(userId: string): Promise<ToolOperationalSettings> {
  const { redis } = await import('./redis')
  return redis.execute(async client => (await readToolOperationsSnapshot(client, userId)).values)
}
