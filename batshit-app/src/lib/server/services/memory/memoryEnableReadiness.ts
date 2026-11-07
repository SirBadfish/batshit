import {
  BUILTIN_EMBEDDING_MODELS,
  DEFAULT_MEMORY_EMBEDDING_CONFIG,
  observeBuiltinMemoryReadiness,
  type BuiltinMemoryReadinessObservation
} from './memoryEmbedder'
import { MEMORY_CONFIG_KEY } from './memoryKeys'

export type MemoryEnableReadinessStatus = 'builtin-ready' | 'configuration-ready' | 'preparing' |
  'preparation-required' | 'configuration-unavailable'

export interface MemoryEnableReadinessSnapshot {
  readonly status: MemoryEnableReadinessStatus
  readonly reason: string
  /** Server-private, value-free stale-source evidence. Never a capability or an authorization proof. */
  readonly source: string
  readonly builtinModelId?: string
}

interface ReadinessClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const builtinObservations = new WeakMap<MemoryEnableReadinessSnapshot, BuiltinMemoryReadinessObservation>()
const SOURCE_PATTERN = /^memory-enable-v1:[a-f0-9]{40}$/
const UNAVAILABLE_REASON = 'embedding-configuration-unavailable'

/**
 * Fixed reads only: parent types precede leaves, and string lengths precede raw
 * access. sha1hex is private NONADVERSARIAL staleness evidence; same-owner
 * collisions can defeat comparison. It grants no authority or identity.
 *
 * The final physical writer embeds this same function and calls
 * memoryEnableSourceMatches(key, source) before its first write.
 */
export const MEMORY_ENABLE_SOURCE_GUARD_LUA = `
local function memoryEnableReadSource(key)
  local facts = {'memory-enable-v1'}
  local function fact(value) facts[#facts + 1] = value end
  local function finish(lane, modelId)
    return {lane = lane, modelId = modelId,
      source = 'memory-enable-v1:' .. redis.sha1hex(table.concat(facts, '|'))}
  end
  local function shape(path)
    local reply = redis.pcall('JSON.TYPE', key, path)
    if type(reply) ~= 'table' or reply.err or #reply > 1 then return nil end
    local found = reply[1] or 'absent'
    if found ~= 'absent' and found ~= 'null' and found ~= 'object' and found ~= 'array' and
      found ~= 'string' and found ~= 'integer' and found ~= 'number' and found ~= 'boolean' then return nil end
    fact(path .. ':type:' .. found)
    return found
  end
  local function stringLeaf(path, limit)
    local kind = shape(path)
    if not kind then return nil, false end
    if kind == 'absent' or kind == 'null' then return nil, true end
    if kind ~= 'string' then return nil, false end
    local lengths = redis.pcall('JSON.STRLEN', key, path)
    if type(lengths) ~= 'table' or lengths.err or #lengths ~= 1 or type(lengths[1]) ~= 'number' or
      lengths[1] < 0 or lengths[1] > limit then return nil, false end
    fact(path .. ':length:' .. tostring(lengths[1]))
    local raw = redis.pcall('JSON.GET', key, path)
    if type(raw) ~= 'string' or #raw > limit * 6 + 4 then return nil, false end
    local ok, decoded = pcall(cjson.decode, raw)
    if not ok or type(decoded) ~= 'table' or #decoded ~= 1 or type(decoded[1]) ~= 'string' or
      #decoded[1] ~= lengths[1] then return nil, false end
    fact(path .. ':raw:' .. redis.sha1hex(raw))
    return decoded[1], true
  end
  local function requiredString(path, limit)
    local value, valid = stringLeaf(path, limit)
    return valid and value ~= nil and value ~= ''
  end
  local function dimensions(path)
    local kind = shape(path)
    if kind ~= 'integer' and kind ~= 'number' then return false end
    local raw = redis.pcall('JSON.GET', key, path)
    if type(raw) ~= 'string' or #raw > 64 then return false end
    local ok, decoded = pcall(cjson.decode, raw)
    if not ok or type(decoded) ~= 'table' or #decoded ~= 1 then return false end
    local value = decoded[1]
    if type(value) ~= 'number' or value ~= value or value <= 0 or value >= math.huge or
      value ~= math.floor(value) then return false end
    fact(path .. ':raw:' .. redis.sha1hex(raw))
    return true
  end
  local keyType = redis.pcall('TYPE', key)
  if type(keyType) ~= 'table' or keyType.err or type(keyType.ok) ~= 'string' then return nil end
  fact('key:type:' .. keyType.ok)
  if keyType.ok == 'none' then
    fact('key:exists:0'); fact('selection:factory')
    return finish('builtin', '${DEFAULT_MEMORY_EMBEDDING_CONFIG.modelId}')
  end
  fact('key:exists:1')
  local root = shape('$')
  if root == 'null' then
    fact('selection:factory')
    return finish('builtin', '${DEFAULT_MEMORY_EMBEDDING_CONFIG.modelId}')
  end
  if root ~= 'object' then return nil end
  local embedding = shape('$.embedding')
  if embedding == 'absent' or embedding == 'null' then
    fact('selection:factory')
    return finish('builtin', '${DEFAULT_MEMORY_EMBEDDING_CONFIG.modelId}')
  end
  if embedding ~= 'object' then return nil end
  local lane, laneValid = stringLeaf('$.embedding.lane', 32)
  local modelId, modelValid = stringLeaf('$.embedding.modelId', 1024)
  if not laneValid or not modelValid then return nil end
  if lane ~= nil and lane ~= '' and lane ~= 'builtin' and lane ~= 'preset' and
    lane ~= 'local-ai' and lane ~= 'api' then return nil end
  if lane == nil or lane == '' or modelId == nil or modelId == '' then
    fact('selection:factory')
    return finish('builtin', '${DEFAULT_MEMORY_EMBEDDING_CONFIG.modelId}')
  end
  fact('selection:configured')
  if lane == 'builtin' then return finish(lane, modelId) end
  if lane == 'preset' then
    if shape('$.embedding.preset') ~= 'object' or
      not requiredString('$.embedding.preset.presetId', 256) or
      not requiredString('$.embedding.preset.provider', 64) or
      not requiredString('$.embedding.preset.modelName', 1024) or
      not dimensions('$.embedding.preset.dims') then return nil end
  elseif lane == 'local-ai' then
    if shape('$.embedding.localAi') ~= 'object' or
      not requiredString('$.embedding.localAi.baseUrl', 4096) or
      not requiredString('$.embedding.localAi.modelName', 1024) or
      not dimensions('$.embedding.localAi.dims') then return nil end
  elseif lane == 'api' then
    if shape('$.embedding.api') ~= 'object' or
      not requiredString('$.embedding.api.provider', 64) or
      not requiredString('$.embedding.api.modelName', 1024) or
      not dimensions('$.embedding.api.dims') then return nil end
  else return nil end
  return finish(lane)
end
local function memoryEnableSourceMatches(key, expectedSource)
  if type(expectedSource) ~= 'string' or #expectedSource ~= 57 then return false end
  local current = memoryEnableReadSource(key)
  return current ~= nil and current.source == expectedSource
end
`

const READ_MEMORY_ENABLE_READINESS_LUA = `${MEMORY_ENABLE_SOURCE_GUARD_LUA}
local source = memoryEnableReadSource(KEYS[1])
if not source then return {'UNAVAILABLE'} end
return {'OK', source.source, source.lane, source.modelId or ''}
`

function unavailable(): MemoryEnableReadinessSnapshot {
  return Object.freeze({ status: 'configuration-unavailable', reason: UNAVAILABLE_REASON, source: '' })
}

/** No factory, preparation, disk, key-store, preset, provider, index or model activity. */
export async function readMemoryEnableReadiness(client: ReadinessClient): Promise<MemoryEnableReadinessSnapshot> {
  let reply: unknown
  try {
    reply = await client.eval(READ_MEMORY_ENABLE_READINESS_LUA, { keys: [MEMORY_CONFIG_KEY], arguments: [] })
  } catch {
    return unavailable()
  }
  if (!Array.isArray(reply) || reply.length !== 4 || reply[0] !== 'OK' ||
    typeof reply[1] !== 'string' || !SOURCE_PATTERN.test(reply[1]) ||
    typeof reply[2] !== 'string' || typeof reply[3] !== 'string') return unavailable()
  const [, source, lane, modelId] = reply as [string, string, string, string]
  if (lane === 'preset' || lane === 'local-ai' || lane === 'api') {
    if (modelId !== '') return unavailable()
    return Object.freeze({ status: 'configuration-ready', reason: 'embedding-configuration-ready-runtime-unchecked', source })
  }
  if (lane !== 'builtin' || !BUILTIN_EMBEDDING_MODELS.some(spec => spec.id === modelId)) return unavailable()
  const observed = observeBuiltinMemoryReadiness(modelId)
  const status = observed.state === 'ready' ? 'builtin-ready' : observed.state
  const snapshot: MemoryEnableReadinessSnapshot = Object.freeze({ status,
    reason: observed.state === 'ready' ? 'builtin-model-ready' : observed.state === 'preparing'
      ? 'builtin-model-preparing' : 'builtin-model-preparation-required', source, builtinModelId: modelId })
  builtinObservations.set(snapshot, observed)
  return snapshot
}

export class MemoryEnableReadinessError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`Memory enablement is unavailable: ${reason}. Nothing was saved.`)
    this.name = 'MemoryEnableReadinessError'
    this.reason = reason
  }
}

/** Must run synchronously after the last client await, immediately before physical issue. */
export function assertMemoryEnableReadiness(snapshot: MemoryEnableReadinessSnapshot): void {
  if (snapshot.status === 'configuration-ready' && SOURCE_PATTERN.test(snapshot.source)) return
  if (snapshot.status === 'builtin-ready' && SOURCE_PATTERN.test(snapshot.source) &&
    builtinObservations.get(snapshot)?.isCurrent()) return
  throw new MemoryEnableReadinessError(snapshot.status === 'configuration-unavailable' ? UNAVAILABLE_REASON :
    snapshot.status === 'preparing' ? 'builtin-model-preparing' : 'builtin-model-preparation-required')
}
