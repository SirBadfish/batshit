import { redis } from '$lib/server/redis'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from '../appActions/settings/lifecycle'
import type { MemoryRecord, MemorySegmentRecord } from './memoryTypes'

/** JSON and legacy JSON-in-STRING owners are supported without changing storage. */
export const MEMORY_READ_OWNER_LUA = `
local function memoryReadOwner(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return kind, '' end
  local raw
  if kind == 'ReJSON-RL' then raw = redis.call('JSON.GET', key)
  elseif kind == 'string' then raw = redis.call('GET', key)
  else error('MEMORY_OWNER_UNREADABLE') end
  if not raw then error('MEMORY_OWNER_UNREADABLE') end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then error('MEMORY_OWNER_UNREADABLE') end
  return kind, raw
end
`

export interface MemoryOwnerProof {
  id: string
  userId: string
  storage: 'ReJSON-RL' | 'string'
  /** Exact immutable creation leaf, including absence versus null. */
  created: string | null
}

export function decodeMemoryOwner(kind: unknown, raw: unknown, id: string, label: string): {
  proof: MemoryOwnerProof; record: Record<string, any>; raw: string
} {
  if (kind === 'none') throw new Error(`The ${label} no longer exists.`)
  if ((kind !== 'ReJSON-RL' && kind !== 'string') || typeof raw !== 'string' || !raw) throw new Error(`The ${label} owner is unreadable.`)
  const record = JSON.parse(raw)
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== id || typeof record.user_id !== 'string' || !record.user_id) throw new Error(`The ${label} owner is malformed.`)
  if (Object.hasOwn(record, 'created_at') && record.created_at !== null && typeof record.created_at !== 'string') throw new Error(`The ${label} creation identity is malformed.`)
  const created = Object.hasOwn(record, 'created_at') ? JSON.stringify(record.created_at) : null
  if (created === undefined) throw new Error(`The ${label} creation identity is unreadable.`)
  return { proof: { id, userId: record.user_id, storage: kind, created }, record, raw }
}

export function sameMemoryOwner(original: MemoryOwnerProof, current: MemoryOwnerProof): boolean {
  return original.id === current.id && original.userId === current.userId && original.storage === current.storage && original.created === current.created
}

export const READ_MEMORY_OBSERVATION = `
-- BATSHIT_MEMORY_OBSERVATION_V1: bounded, read-only, one server observation.
${MEMORY_READ_OWNER_LUA}
local clock = redis.call('TIME')
local agentKind, agentRaw = memoryReadOwner(KEYS[1])
local sessionKind, sessionRaw = 'none', ''
if KEYS[2] ~= '' then sessionKind, sessionRaw = memoryReadOwner(KEYS[2]) end
local rows = {}
for index = 3, #KEYS do table.insert(rows, {KEYS[index], redis.call('JSON.GET', KEYS[index]) or ''}) end
return {clock[1], clock[2], agentKind, agentRaw, sessionKind, sessionRaw, rows}
`

/** Callers bound this to one media record or the recall tool's at-most-eight ids. */
export async function readMemoryObservation(options: {
  agentId: string
  userId?: string
  sessionId?: string
  memoryIds?: string[]
  segmentIds?: string[]
  lifecycle?: SettingsLifecycleSnapshot
  expectedAgent?: MemoryOwnerProof
  expectedSession?: MemoryOwnerProof
  requireEnabled?: boolean
}) {
  const agentKey = `agent:${options.agentId}`
  const lifecycle = options.lifecycle ?? captureSettingsLifecycle([agentKey, ...(options.sessionId ? [`session:${options.sessionId}`] : [])])
  const memoryIds = [...new Set(options.memoryIds ?? [])], segmentIds = [...new Set(options.segmentIds ?? [])]
  if (memoryIds.length + segmentIds.length > 8) throw new Error('A memory observation accepts at most eight requested records.')
  const keys = [agentKey, options.sessionId ? `session:${options.sessionId}` : '', ...memoryIds.map(id => `memory:${options.agentId}:${id}`), ...segmentIds.map(id => `memseg:${options.agentId}:${id}`)]
  const reply = await redis.execute(client => client.eval(READ_MEMORY_OBSERVATION, { keys, arguments: [] })) as unknown[]
  assertSettingsLifecycle(lifecycle)
  if (!Array.isArray(reply) || reply.length !== 7 || !Array.isArray(reply[6])) throw new Error('Memory ownership observation was unreadable.')
  const nowTs = Number(reply[0]) * 1000 + Math.floor(Number(reply[1]) / 1000)
  if (!Number.isFinite(nowTs)) throw new Error('Memory ownership clock was unreadable.')
  const agent = decodeMemoryOwner(reply[2], reply[3], options.agentId, 'memory agent')
  if (options.userId && agent.proof.userId !== options.userId || options.expectedAgent && !sameMemoryOwner(options.expectedAgent, agent.proof)) throw new Error('The memory agent owner changed.')
  if (options.requireEnabled && !resolveAgentMemoryEnabled(agent.record)) throw new Error('Memory is no longer enabled for this agent.')
  const session = options.sessionId ? decodeMemoryOwner(reply[4], reply[5], options.sessionId, 'originating chat') : null
  if (session && session.proof.userId !== agent.proof.userId || options.expectedSession && (!session || !sameMemoryOwner(options.expectedSession, session.proof))) throw new Error('The originating chat owner changed.')
  const records = new Map<string, MemoryRecord>(), segments = new Map<string, MemorySegmentRecord>()
  for (const row of reply[6] as unknown[][]) {
    const key = String(row[0]), raw = row[1]
    if (raw === '') continue
    if (typeof raw !== 'string') throw new Error('A memory record was unreadable.')
    const record = JSON.parse(raw)
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.agent_id !== options.agentId || record.user_id !== agent.proof.userId) throw new Error('A memory record owner is malformed.')
    if (key === `memory:${options.agentId}:${record.id}` && memoryIds.includes(record.id)) records.set(record.id, record)
    else if (key === `memseg:${options.agentId}:${record.id}` && segmentIds.includes(record.id)) segments.set(record.id, record)
    else throw new Error('A memory record does not match its requested owner.')
  }
  return { agent: agent.record, agentOwner: agent.proof, sessionOwner: session?.proof ?? null, records, segments, nowTs, lifecycle }
}
