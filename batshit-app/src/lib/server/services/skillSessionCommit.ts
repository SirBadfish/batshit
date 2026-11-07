import { redis } from '$lib/server/redis'
import type { UnzippedItem } from '$lib/services/zipping'
import { readSkillSessionRecord, type SkillSessionRecord } from '$lib/utils/skillSessions'
import { hasRedisGlobCharacters } from '$lib/utils/redisGlob'
import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import { acquireSettingsMutation, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'

/** Exact raw preimages captured by the owning policy decision. Never refresh these at commit. */
export type SkillSessionSourceGuard =
  | { kind: 'json'; key: string; raw: string | null }
  | { kind: 'string'; key: string; raw: string | null }
  | { kind: 'list'; key: string; values: readonly string[] }
export type SkillSessionRawGuard = SkillSessionSourceGuard

export type SkillSessionZipChange = {
  zipId: string
  hold?: UnzippedItem
  closeBy?: 'user' | 'agent' | 'inferred'
  rawZipId?: string
  transcriptSha256?: string
  reason?: 'skill_superseded' | 'user_skill_release' | 'user_skill_zip' | 'user_skill_hold_expired'
}

export interface SkillSessionCommitInput {
  record: SkillSessionRecord
  changes: readonly SkillSessionZipChange[]
  guards: readonly SkillSessionSourceGuard[]
  lifecycle: SettingsLifecycleSnapshot
  /** Synchronous turn/deletion fence, checked after client acquisition at physical issuance. */
  beforeIssue?: () => void
}
export type SkillSessionCommitResult = { status: 'applied' } | { status: 'changed'; reason: string }

export class SkillSessionCommitError extends Error {
  readonly code = 'SKILL_SESSION_COMMIT_UNCONFIRMED'
  constructor(message: string, readonly outcome: 'unknown' | 'partial', readonly confirmedCommands: number | null = null) {
    super(message)
    this.name = 'SkillSessionCommitError'
  }
}

type Write = { command: 'JSON.SET' | 'SADD' | 'SREM' | 'DEL'; key: number; path?: '$' | '$.metadata.skillSessionAdmission'; value?: string; member?: string }
export interface PreparedSkillSessionCommit {
  keys: string[]
  guards: Array<{ kind: SkillSessionSourceGuard['kind']; key: number; raw?: string | null; values?: string[] }>
  writes: Write[]
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
// Matches POST /api/sessions without normalizing an existing user's chosen identity.
const sessionIdAllowed = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes(':') && !hasRedisGlobCharacters(value)
const invalid = (reason: string): never => { throw new Error(`Invalid skill-session commit: ${reason}. No writes were issued.`) }
const json = (value: unknown): string => {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') return invalid('a value is not JSON data')
  return encoded
}
function rootOf(raw: string): unknown {
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length !== 1) return invalid('a JSON root preimage is not an exact JSON.GET $ reply')
  return value[0]
}

/** Build only the finite lifecycle/zip commands below. No input supplies an executable command/path. */
export function prepareSkillSessionCommit(input: SkillSessionCommitInput): PreparedSkillSessionCommit {
  const { record } = input
  if (!record || !text(record.userId) || !sessionIdAllowed(record.sessionId)) return invalid('the lifecycle owner is invalid')
  readSkillSessionRecord(record, record.sessionId, record.userId)
  if (!Array.isArray(input.guards) || !Array.isArray(input.changes)) return invalid('the batch inventories are invalid')
  const lifecycleKey = `skill_sessions:${record.sessionId}`
  const sessionKey = `session:${record.sessionId}`
  const sources = new Map<string, SkillSessionSourceGuard>()
  for (const guard of input.guards) {
    if (!guard || !['json', 'string', 'list'].includes(guard.kind) || typeof guard.key !== 'string') return invalid('a source guard is invalid')
    if (guard.kind === 'list') {
      if (!Array.isArray(guard.values) || guard.values.some((value: unknown) => typeof value !== 'string')) return invalid('a message-list preimage is invalid')
    } else {
      if (guard.raw !== null && typeof guard.raw !== 'string') return invalid('a source is unknown rather than explicitly absent')
      if (guard.kind === 'json' && guard.raw !== null) rootOf(guard.raw)
    }
    const previous = sources.get(guard.key)
    if (previous && (previous.kind !== guard.kind || (previous.kind === 'list' && guard.kind === 'list'
      ? json(previous.values) !== json(guard.values) : (previous as { raw: unknown }).raw !== (guard as { raw: unknown }).raw))) return invalid('conflicting captures name the same source')
    sources.set(guard.key, guard.kind === 'list' ? { ...guard, values: [...guard.values] } : { ...guard })
  }
  const prior = sources.get(lifecycleKey)
  const session = sources.get(sessionKey)
  if (prior?.kind !== 'json' || session?.kind !== 'json' || session.raw === null) return invalid('lifecycle and live session root captures are required')
  const sessionOwner = rootOf(session.raw) as any
  if (!sessionOwner || typeof sessionOwner !== 'object' || Array.isArray(sessionOwner) || sessionOwner.id !== record.sessionId || sessionOwner.user_id !== record.userId) return invalid('the session capture belongs to another owner')
  const old = prior.raw === null ? null : readSkillSessionRecord(rootOf(prior.raw), record.sessionId, record.userId)
  if (prior.raw !== null && !old) return invalid('a present lifecycle is unreadable')
  const entries = [...(old?.entries ?? []), ...record.entries]
  const agents = new Set(entries.map(entry => entry.agentId))
  const readIds = new Set(entries.flatMap(entry => entry.reads.map(read => read.zipId)))
  const rawIds = new Set(entries.flatMap(entry => entry.reads.map(read => read.rawZipId)))
  const messageIds = new Set(entries.flatMap(entry => [entry.openedMessageId, ...entry.reads.map(read => read.messageId)]))
  for (const guard of sources.values()) if (guard.kind === 'list' && guard.key === `messages:${record.sessionId}`) {
    for (const messageId of guard.values) messageIds.add(messageId)
  }
  const suffix = (key: string, prefix: string) => key.startsWith(prefix) && text(key.slice(prefix.length))
  for (const guard of sources.values()) {
    const key = guard.key
    const allowed = guard.kind === 'list' ? key === `messages:${record.sessionId}`
      : guard.kind === 'string' ? key === `slash_command_revision:${record.userId}`
        : key === lifecycleKey || key === sessionKey || key === 'batshit:typesafe_config' ||
          key.startsWith('agent:') && agents.has(key.slice(6)) && isExactSavedAccessAgentId(key.slice(6)) ||
          suffix(key, `slash_command:${record.userId}:`) || suffix(key, `agent_plugin:${record.userId}:`) ||
          key.startsWith(`message:${record.sessionId}:`) && messageIds.has(key.slice(`message:${record.sessionId}:`.length)) ||
          key.startsWith(`unzipped_item:${record.sessionId}:`) && readIds.has(key.slice(`unzipped_item:${record.sessionId}:`.length)) ||
          key.startsWith(`rezipped_item:${record.sessionId}:`) && readIds.has(key.slice(`rezipped_item:${record.sessionId}:`.length)) ||
          key.startsWith('zip:') && rawIds.has(key.slice(4))
    if (!allowed) return invalid('a source is outside this finite owner inventory')
  }
  const keys: string[] = []
  const index = (key: string) => { let at = keys.indexOf(key); if (at < 0) { keys.push(key); at = keys.length - 1 }; return at + 1 }
  const guards = [...sources.values()].map(guard => guard.kind === 'list'
    ? { kind: guard.kind, key: index(guard.key), values: [...guard.values] }
    : { kind: guard.kind, key: index(guard.key), raw: guard.raw })
  const writes: Write[] = []
  const requireJson = (key: string, exists = false) => {
    const source = sources.get(key)
    if (source?.kind !== 'json' || exists && source.raw === null) return invalid('every JSON mutation needs its original root preimage')
  }
  const seen = new Set<string>()
  for (const change of input.changes) {
    if (!change || !text(change.zipId) || !readIds.has(change.zipId) || seen.has(change.zipId)) return invalid('a changed zip is missing, duplicated or outside the lifecycle')
    seen.add(change.zipId)
    const openKey = `unzipped_item:${record.sessionId}:${change.zipId}`
    const closedKey = `rezipped_item:${record.sessionId}:${change.zipId}`
    requireJson(openKey); requireJson(closedKey)
    if (change.hold) {
      const hold = change.hold
      if (hold.zipId !== change.zipId || hold.sessionId !== record.sessionId || typeof hold.permanent !== 'boolean' || !['user', 'agent', 'inferred'].includes(hold.source ?? '')) return invalid('a hold does not belong to this lifecycle')
      if (hold.agentId && (!isExactSavedAccessAgentId(hold.agentId) || !agents.has(hold.agentId))) return invalid('a hold names another reader')
      if (change.rawZipId) {
        if (!rawIds.has(change.rawZipId) || !hold.skillSession || !hold.agentId || !/^[a-f0-9]{64}$/.test(change.transcriptSha256 ?? '')) return invalid('an admission lacks its original reader and transcript digest')
        const matching = entries.some(entry => entry.agentId === hold.agentId && entry.skillId === hold.skillSession!.skillId && entry.generation === hold.skillSession!.generation && entry.reads.some(read => read.zipId === change.zipId && read.rawZipId === change.rawZipId))
        if (!matching) return invalid('an admission does not match its recorded read')
        requireJson(`zip:${change.rawZipId}`, true)
        writes.push({ command: 'JSON.SET', key: index(`zip:${change.rawZipId}`), path: '$.metadata.skillSessionAdmission', value: json({ agentId: hold.agentId, ...hold.skillSession, transcriptSha256: change.transcriptSha256 }) })
      }
      writes.push({ command: 'SADD', key: index(`unzipped:${record.sessionId}`), member: change.zipId },
        { command: 'SREM', key: index(`rezipped:${record.sessionId}`), member: change.zipId },
        { command: 'DEL', key: index(closedKey) }, { command: 'JSON.SET', key: index(openKey), path: '$', value: json(hold) })
    } else {
      if (change.rawZipId || change.transcriptSha256 || change.closeBy !== undefined && !['user', 'agent', 'inferred'].includes(change.closeBy) || change.reason !== undefined && !['skill_superseded', 'user_skill_release', 'user_skill_zip', 'user_skill_hold_expired'].includes(change.reason)) return invalid('a close mutation has invalid state')
      writes.push({ command: 'SREM', key: index(`unzipped:${record.sessionId}`), member: change.zipId },
        { command: 'DEL', key: index(openKey) }, { command: 'SADD', key: index(`rezipped:${record.sessionId}`), member: change.zipId },
        { command: 'JSON.SET', key: index(closedKey), path: '$', value: json({ zipId: change.zipId, sessionId: record.sessionId,
          source: change.closeBy ?? 'agent', rezippedAt: Date.now(), reason: change.reason ?? 'skill_closed', toldAgent: true }) })
    }
  }
  writes.push({ command: 'JSON.SET', key: index(lifecycleKey), path: '$', value: json(record) })
  return { keys, guards, writes }
}

/** All reads/type/path/value checks precede the first write. Lua itself does not roll back. */
export const SKILL_SESSION_COMMIT_SCRIPT = `
local guards = cjson.decode(ARGV[1])
local writes = cjson.decode(ARGV[2])
for _, guard in ipairs(guards) do
  local key = KEYS[guard.key]
  if not key then return {'INVALID', 'guard_key'} end
  local kind = redis.call('TYPE', key).ok
  if guard.kind == 'list' then
    if kind ~= 'none' and kind ~= 'list' then return {'CHANGED', 'source_type'} end
    local current = redis.call('LRANGE', key, 0, -1)
    if #current ~= #guard.values then return {'CHANGED', 'message_list'} end
    for index, value in ipairs(current) do if value ~= guard.values[index] then return {'CHANGED', 'message_list'} end end
  else
    local expectedKind = guard.kind == 'json' and 'ReJSON-RL' or 'string'
    if guard.raw == cjson.null then
      if kind ~= 'none' then return {'CHANGED', 'source_presence'} end
    else
      if kind ~= expectedKind then return {'CHANGED', 'source_type'} end
      local current = guard.kind == 'json' and redis.call('JSON.GET', key, '$') or redis.call('GET', key)
      if current ~= guard.raw then return {'CHANGED', 'source_value'} end
    end
  end
end
for _, write in ipairs(writes) do
  local key = KEYS[write.key]
  if not key then return {'INVALID', 'write_key'} end
  local kind = redis.call('TYPE', key).ok
  if write.command == 'SADD' or write.command == 'SREM' then
    if kind ~= 'none' and kind ~= 'set' then return {'INVALID', 'set_type'} end
    if type(write.member) ~= 'string' then return {'INVALID', 'set_member'} end
  elseif write.command == 'JSON.SET' then
    if kind ~= 'none' and kind ~= 'ReJSON-RL' then return {'INVALID', 'json_type'} end
    if write.path ~= '$' and write.path ~= '$.metadata.skillSessionAdmission' then return {'INVALID', 'json_path'} end
    local ok, value = pcall(cjson.decode, write.value)
    if not ok or type(value) ~= 'table' then return {'INVALID', 'json_value'} end
    if write.path ~= '$' then
      if kind ~= 'ReJSON-RL' then return {'INVALID', 'missing_zip'} end
      local types = redis.call('JSON.TYPE', key, '$.metadata')
      if #types ~= 1 or types[1] ~= 'object' then return {'INVALID', 'zip_metadata'} end
    end
  elseif write.command == 'DEL' then
    if kind ~= 'none' and kind ~= 'ReJSON-RL' then return {'INVALID', 'delete_type'} end
  else return {'INVALID', 'write_command'} end
end
local confirmed = 0
for _, write in ipairs(writes) do
  local result
  if write.command == 'JSON.SET' then result = redis.pcall('JSON.SET', KEYS[write.key], write.path, write.value)
  elseif write.command == 'DEL' then result = redis.pcall('DEL', KEYS[write.key])
  else result = redis.pcall(write.command, KEYS[write.key], write.member) end
  if type(result) == 'table' and result.err then return {'PARTIAL', tostring(confirmed), 'command_error'} end
  local ok = write.command == 'JSON.SET' and type(result) == 'table' and result.ok == 'OK'
    or write.command ~= 'JSON.SET' and type(result) == 'number' and (result == 0 or result == 1)
  if not ok then return {'PARTIAL', tostring(confirmed), 'unconfirmed_command'} end
  confirmed = confirmed + 1
end
return {'APPLIED', tostring(confirmed)}
`

const unresolved = new Set<string>()
const inFlight = new Set<string>()

/** Physical issuance is the only write door. Known CAS refusals never retry or write. */
export async function commitSkillSessionState(input: SkillSessionCommitInput): Promise<SkillSessionCommitResult> {
  const prepared = prepareSkillSessionCommit(input)
  const scope = `session:${input.record.sessionId}`
  if (unresolved.has(scope)) throw new SkillSessionCommitError('An earlier skill-session write is unconfirmed. Its custody is retained; do not retry.', 'unknown')
  if (inFlight.has(scope)) return { status: 'changed', reason: 'another skill-session commit is still settling' }
  const lifecycle: SettingsLifecycleSnapshot = { epoch: input.lifecycle.epoch, records: input.lifecycle.records.map(([key, revision]) => [key, revision]) }
  if (!lifecycle.records.some(([key]) => key === scope)) return invalid('the captured lifecycle does not fence this session')
  const args = [json(prepared.guards), json(prepared.writes)]
  inFlight.add(scope)
  try {
    return await redis.execute(async (client) => {
      if (unresolved.has(scope)) throw new SkillSessionCommitError('An earlier skill-session write is unconfirmed. Do not retry.', 'unknown')
      const lease = acquireSettingsMutation(lifecycle)
      let issued = false
      try {
        const check = input.beforeIssue?.() as unknown
        if (check && typeof (check as Promise<unknown>).then === 'function') return invalid('the issue fence must be synchronous')
        lease.check()
        issued = true
        const answer = await client.eval(SKILL_SESSION_COMMIT_SCRIPT, { keys: prepared.keys, arguments: args })
        if (Array.isArray(answer) && answer[0] === 'APPLIED' && Number(answer[1]) === prepared.writes.length) {
          lease.settle(); issued = false
          return { status: 'applied' } as const
        }
        if (Array.isArray(answer) && (answer[0] === 'CHANGED' || answer[0] === 'INVALID') && typeof answer[1] === 'string') {
          lease.settle(); issued = false
          return { status: 'changed', reason: answer[1] } as const
        }
        if (Array.isArray(answer) && answer[0] === 'PARTIAL' && /^\d+$/.test(String(answer[1])) && Number(answer[1]) <= prepared.writes.length) {
          throw new SkillSessionCommitError('A skill-session batch stopped after some commands may have applied. Its custody is retained; do not retry.', 'partial', Number(answer[1]))
        }
        throw new SkillSessionCommitError('The skill-session write returned an unconfirmed outcome. Do not retry.', 'unknown')
      } catch (error) {
        if (issued) {
          unresolved.add(scope); lease.unknown()
          if (error instanceof SkillSessionCommitError) throw error
          throw new SkillSessionCommitError('The skill-session write may have reached Redis. Its outcome is unknown; do not retry.', 'unknown')
        }
        lease.settle()
        throw error
      }
    })
  } finally { inFlight.delete(scope) }
}
