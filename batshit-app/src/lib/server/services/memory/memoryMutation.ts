import { randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import { acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from '../appActions/settings/lifecycle'
import type { MemoryRecord } from './memoryTypes'
import { MEMORY_READ_OWNER_LUA, decodeMemoryOwner, type MemoryOwnerProof } from './memoryOwnership'
import { memoryIsDeleted, memoryIsExpired, standingMemoryTransition } from './memoryState'

export class MemoryMutationError extends Error {
  get status() { return this.outcomeUnknown ? 503 : 409 }
  get code() { return this.outcomeUnknown ? 'MEMORY_WRITE_UNCONFIRMED' : 'MEMORY_CHANGED' }
  constructor(message: string, readonly outcomeUnknown = false) { super(message); this.name = 'MemoryMutationError' }
}
export const memoryMutationUnknown = (error: unknown): boolean => error instanceof MemoryMutationError && error.outcomeUnknown
const unresolvedAgents = new Set<string>()
const OWNER_PATHS = ['$.id', '$.user_id', '$.created_at', '$.memory_enabled', '$.memoryEnabled']
const CONTEXT_PATHS = ['$.content', '$.gist', '$.trigger_terms', '$.trigger_synonyms', '$.linger_override', '$.importance', '$.event_at', '$.event_ts', '$.saved_at', '$.updated_at', '$.provenance', '$.links', '$.last_recalled_at', '$.last_recalled_ts', '$.recall_count', '$.visibility', '$.embedding_model', '$.schema_version']
const CAP_PATHS = ['$.id', '$.agent_id', '$.user_id', '$.lane', '$.media', '$.media_mode', '$.is_superseded', '$.superseded_by', '$.supersedes', '$.expires_at', '$.expires_ts', '$.deleted_at', '$.deleted_ts', '$.saved_ts', '$.purge_pending']

export interface MemoryMutationSnapshot {
  agentId: string
  lifecycle: SettingsLifecycleSnapshot
  /** Full raw preimages only for requested targets and explicit fold/session dependencies. */
  raw: Map<string, string | null>
  ownerRaw: Array<[string, string | null]>
  agentStorage: MemoryOwnerProof['storage']
  storage: Map<string, string>
  revisionRaw: string | null
  records: MemoryRecord[]
  nextExpiry: number | null
  observedTs: number
}

/** Atomic read only: target bodies plus fixed graph/cap metadata for other records. */
const READ_MEMORY_SNAPSHOT = `
${MEMORY_READ_OWNER_LUA}
local clock = redis.call('TIME')
local targets = nil
if ARGV[2] ~= '' then
  targets = {}
  for _, key in ipairs(cjson.decode(ARGV[2])) do targets[key] = true end
end
local fields = cjson.decode(ARGV[3])
local rows = {}
local seen = {}
for _, key in ipairs(redis.call('KEYS', ARGV[1])) do
  seen[key] = true
  if not targets or targets[key] then
    table.insert(rows, {key, 'full', redis.call('JSON.GET', key) or '', 'ReJSON-RL'})
  else
    table.insert(rows, {key, 'cap', redis.call('JSON.GET', key, unpack(fields)) or '', 'ReJSON-RL'})
  end
end
local agentKind, agentRaw = memoryReadOwner(KEYS[1])
for index, key in ipairs(KEYS) do
  if not seen[key] then
  if index == 1 then table.insert(rows, {key, 'full', agentRaw, agentKind})
  else
    local kind = redis.call('TYPE', key).ok
    if kind == 'string' and string.sub(key, 1, 8) ~= 'session:' then error('MEMORY_DEPENDENCY_UNREADABLE') end
    local storedKind, raw = memoryReadOwner(key)
    table.insert(rows, {key, 'full', raw, storedKind})
  end
  end
end
local owner = {}
if agentKind == 'ReJSON-RL' then
  for _, path in ipairs(cjson.decode(ARGV[4])) do table.insert(owner, {path, redis.call('JSON.GET', KEYS[1], path) or ''}) end
end
return {clock[1], clock[2], redis.call('JSON.GET', KEYS[2], '$.mutation_revision') or '', rows, owner, agentKind}
`

export async function readMemoryMutationSnapshot(agentId: string, options: {
  lifecycle?: SettingsLifecycleSnapshot; extraKeys?: string[]; targetIds?: string[]; context?: boolean
} = {}): Promise<MemoryMutationSnapshot> {
  if (unresolvedAgents.has(agentId)) throw new MemoryMutationError('An earlier memory write has an unknown outcome. Its custody is retained until this app restarts.', true)
  const agentKey = `agent:${agentId}`, foldKey = `memfold:${agentId}`
  const lifecycle = options.lifecycle ?? captureSettingsLifecycle([agentKey])
  const raw = new Map<string, string | null>(), storage = new Map<string, string>(), records: MemoryRecord[] = []
  const answer = await redis.execute(client => client.eval(READ_MEMORY_SNAPSHOT, {
    keys: [agentKey, foldKey, ...(options.extraKeys ?? []).filter(key => key !== foldKey && key !== agentKey)],
    arguments: [`memory:${escapeRedisGlob(agentId)}:*`, options.targetIds === undefined ? '' : JSON.stringify(options.targetIds.map(id => `memory:${agentId}:${id}`)), JSON.stringify(options.context ? [...CAP_PATHS, ...CONTEXT_PATHS] : CAP_PATHS), JSON.stringify(OWNER_PATHS)]
  })) as unknown[]
  if (!Array.isArray(answer) || answer.length !== 6 || !Array.isArray(answer[3]) || !Array.isArray(answer[4])) throw new Error('Memory ownership snapshot was unreadable.')
  const observedTs = Number(answer[0]) * 1000 + Math.floor(Number(answer[1]) / 1000)
  if (!Number.isFinite(observedTs)) throw new Error('Memory ownership clock was unreadable.')
  for (const row of answer[3] as unknown[][]) {
    const key = String(row[0]), value = row[2] === '' ? null : row[2]
    if (value !== null && typeof value !== 'string') throw new Error('Memory ownership read was not JSON text.')
    if (row[1] === 'full') { raw.set(key, value); storage.set(key, String(row[3])) }
    if (!key.startsWith(`memory:${agentId}:`) || value === null) continue
    const parsed = JSON.parse(value)
    const record = row[1] === 'full' ? parsed : Object.fromEntries(Object.entries(parsed).flatMap(([path, values]) => Array.isArray(values) && values.length ? [[path.slice(2), values[0]]] : []))
    if (!record || record.agent_id !== agentId || key !== `memory:${agentId}:${record.id}` || !Array.isArray(record.media ?? [])) throw new Error('A memory owner record is malformed; no change was made.')
    records.push(record as MemoryRecord)
  }
  const agent = decodeMemoryOwner(answer[5], raw.get(agentKey) ?? '', agentId, 'memory agent')
  // Keep the established browse/pending presentation order. Raw CAS entries remain
  // paired with their original keys and are never reordered or re-serialized here.
  records.sort((a, b) => b.saved_ts - a.saved_ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const ownerRaw = (answer[4] as unknown[][]).map(row => [String(row[0]), row[1] === '' ? null : String(row[1])] as [string, string | null])
  const future = records.filter(record => !memoryIsDeleted(record) && typeof record.expires_ts === 'number' && record.expires_ts > observedTs).map(record => record.expires_ts!)
  assertSettingsLifecycle(lifecycle)
  return { agentId, lifecycle, raw, storage, agentStorage: agent.proof.storage, ownerRaw, revisionRaw: answer[2] === '' ? null : String(answer[2]), records, observedTs, nextExpiry: future.length ? Math.min(...future) : null }
}

// memfold already has one memory-owned writer, agent deletion and backup inventory.
// Its revision serializes semantic/graph/cap publication without resetting block bytes.
// A restored revision is data, never a lease: lifecycle admission remains process-local.
export const COMMIT_MEMORY_MUTATION = `
local expected = cjson.decode(ARGV[1])
if redis.call('TYPE', KEYS[1]).ok ~= ARGV[7] then return 'CHANGED' end
if ARGV[7] == 'string' then
  if redis.call('GET', KEYS[1]) ~= ARGV[8] then return 'CHANGED' end
else
  for _, owner in ipairs(cjson.decode(ARGV[2])) do
    local raw = redis.call('JSON.GET', KEYS[1], owner[1])
    if owner[2] == cjson.null then if raw then return 'CHANGED' end
    elseif raw ~= owner[2] then return 'CHANGED' end
  end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'CHANGED' end
local revision = redis.call('JSON.GET', KEYS[2], '$.mutation_revision')
if ARGV[3] == '' then if revision then return 'CHANGED' end
elseif revision ~= ARGV[3] then return 'CHANGED' end
for key, basis in pairs(expected) do
  local kind = redis.call('TYPE', key).ok
  if kind ~= basis[1] then return 'CHANGED' end
  local value = false
  if kind == 'string' then value = redis.call('GET', key)
  elseif kind == 'ReJSON-RL' then value = redis.call('JSON.GET', key)
  elseif kind ~= 'none' then return 'CHANGED' end
  if basis[2] == cjson.null then if value then return 'CHANGED' end
  elseif value ~= basis[2] then return 'CHANGED' end
end
local deadline = tonumber(ARGV[5])
if deadline and deadline > 0 then
  local time = redis.call('TIME')
  if tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000) >= deadline then return 'EXPIRED' end
end
local changes = cjson.decode(ARGV[4])
for _, change in ipairs(changes) do
  if expected[change[1]] == nil and redis.call('EXISTS', change[1]) ~= 0 then return 'CHANGED' end
  if change[2] ~= cjson.null then
    local kind = redis.call('TYPE', change[1]).ok
    if kind ~= 'none' and kind ~= 'ReJSON-RL' then return 'CHANGED' end
    cjson.decode(change[2])
  end
end
for _, change in ipairs(changes) do
  if change[2] == cjson.null then redis.call('DEL', change[1])
  else redis.call('JSON.SET', change[1], '$', change[2]) end
end
if redis.call('EXISTS', KEYS[2]) == 0 then redis.call('JSON.SET', KEYS[2], '$', '{}') end
redis.call('JSON.SET', KEYS[2], '$.mutation_revision', ARGV[6])
return 'SAVED'
`

export async function commitMemoryMutation(snapshot: MemoryMutationSnapshot, changes: Map<string, unknown | null>): Promise<void> {
  const post = new Map(snapshot.records.map(record => [record.id, record]))
  const expected = new Map<string, string | null>()
  for (const [key, value] of snapshot.raw) if (!key.startsWith(`memory:${snapshot.agentId}:`) && key !== `agent:${snapshot.agentId}`) expected.set(key, value)
  for (const [key, value] of changes) {
    if (key.startsWith(`memory:${snapshot.agentId}:`)) {
      const id = key.slice(`memory:${snapshot.agentId}:`.length)
      if (post.has(id) && !snapshot.raw.has(key)) throw new Error('The affected memory body was not captured before publication.')
      if (value === null) post.delete(id)
      else {
        const record = value as MemoryRecord
        if (record.id !== id || record.agent_id !== snapshot.agentId) throw new Error('Memory publication owner mismatch.')
        for (const media of record.media ?? []) if (!media.filename.startsWith(`${snapshot.agentId}/${id}/`)) throw new Error('Memory image ownership does not match its record.')
        post.set(id, record)
      }
    }
    expected.set(key, snapshot.raw.get(key) ?? null)
  }
  const standing = standingMemoryTransition(snapshot.records, [...post.values()], snapshot.observedTs)
  if (!standing.allowed) throw new MemoryMutationError(`Always-on Awareness media is capped at 4 images per agent; this would change ${standing.oldCount} to ${standing.postCount} with over-cap growth or activation. Free a standing-image slot before restoring this memory.`)
  const encoded = JSON.stringify([...changes].map(([key, value]) => [key, value === null ? null : JSON.stringify(value)]))
  await redis.execute(async client => {
    const lease = acquireSettingsMutation(snapshot.lifecycle)
    let issued = false
    try {
      lease.check(); issued = true
      const answer = await client.eval(COMMIT_MEMORY_MUTATION, { keys: [`agent:${snapshot.agentId}`, `memfold:${snapshot.agentId}`], arguments: [JSON.stringify(Object.fromEntries([...expected].map(([key, raw]) => [key, [snapshot.storage.get(key) ?? 'none', raw]]))), JSON.stringify(snapshot.ownerRaw), snapshot.revisionRaw ?? '', encoded, String(snapshot.nextExpiry ?? 0), JSON.stringify(randomUUID()), snapshot.agentStorage, snapshot.agentStorage === 'string' ? snapshot.raw.get(`agent:${snapshot.agentId}`)! : ''] })
      if (answer !== 'SAVED' && answer !== 'CHANGED' && answer !== 'EXPIRED') throw new Error('Memory write returned an unknown result.')
      lease.settle(); issued = false
      if (answer !== 'SAVED') throw new MemoryMutationError('Memory changed or expired while this operation was being prepared. Read the saved state before trying again.')
    } catch (error) {
      if (issued) { unresolvedAgents.add(snapshot.agentId); lease.unknown(); throw new MemoryMutationError('The memory write outcome is unknown. Its media and replacement custody are retained; do not repeat the operation.', true) }
      lease.settle(); throw error
    }
  })
}

/** Access statistics are leaf updates: they neither replace content nor invalidate cap/graph snapshots. */
export async function touchMemoryRecallRecord(agentId: string, memoryId: string, original?: SettingsLifecycleSnapshot, kind: 'memory' | 'segment' = 'memory'): Promise<MemoryRecord> {
  const lifecycle = original ?? captureSettingsLifecycle([`agent:${agentId}`])
  return redis.execute(async client => {
    const lease = acquireSettingsMutation(lifecycle)
    let issued = false
    try {
      lease.check(); issued = true
      const answer = await client.eval(`
${MEMORY_READ_OWNER_LUA}
local agentKind, agentRaw = memoryReadOwner(KEYS[1])
if agentKind == 'none' then return 'UNAVAILABLE' end
local agent = cjson.decode(agentRaw)
local raw = redis.call('JSON.GET', KEYS[2])
if not raw then return 'UNAVAILABLE' end
local record = cjson.decode(raw)
if record.agent_id ~= ARGV[2] or record.user_id ~= agent.user_id then return 'UNAVAILABLE' end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if record.deleted_ts or (record.expires_ts and record.expires_ts ~= cjson.null and record.expires_ts <= now) then return 'UNAVAILABLE' end
local count = record.recall_count or 0
if type(count) ~= 'number' or count < 0 or count ~= math.floor(count) then return 'UNAVAILABLE' end
redis.call('JSON.SET', KEYS[2], '$.last_recalled_at', ARGV[1])
redis.call('JSON.SET', KEYS[2], '$.last_recalled_ts', tostring(now))
redis.call('JSON.SET', KEYS[2], '$.recall_count', tostring(count + 1))
return redis.call('JSON.GET', KEYS[2])
`, { keys: [`agent:${agentId}`, `${kind === 'segment' ? 'memseg' : 'memory'}:${agentId}:${memoryId}`], arguments: [JSON.stringify(new Date().toISOString()), agentId] })
      if (typeof answer !== 'string') throw new Error('Memory recall statistics returned an unknown result.')
      lease.settle(); issued = false
      if (answer === 'UNAVAILABLE') throw new MemoryMutationError('This memory is deleted or expired; its recall state was not changed.')
      return JSON.parse(answer) as MemoryRecord
    } catch (error) {
      if (issued) { unresolvedAgents.add(agentId); lease.unknown(); throw new MemoryMutationError('Memory recall statistics have an unknown outcome.', true) }
      lease.settle(); throw error
    }
  })
}
