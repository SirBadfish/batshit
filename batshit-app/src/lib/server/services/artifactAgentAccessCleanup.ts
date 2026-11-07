import { redis } from '$lib/server/redis'
import { readArtifactAgentAccess } from '$lib/utils/agentAccessIds'

const ACCESS_PATHS = ['$.agent_allowlist', '$.metadata.agent_allowlist', '$.metadata.agentAllowlist', '$.metadata.assigned_agent_ids', '$.metadata.assignedAgentIds'] as const
const PATHS = ['$.id', '$.user_id', ...ACCESS_PATHS, '$.agent_access_scope', '$.agent_use_enabled'] as const
const LUA_PATHS = `{${PATHS.map(path => `'${path}'`).join(',')}}`
const MAX_SNAPSHOT_BYTES = 1024 * 1024
export type ArtifactAccessCleanupChange = Readonly<{ removed: number; scopePinned: boolean }>
export type ArtifactAccessCleanupResult = Readonly<
  { status: 'changed'; removed: number; scopePinned: boolean; notification: 'recorded' | 'failed' } |
  { status: 'unchanged' } |
  { status: 'refused'; reason: 'invalid_arguments' | 'artifact_missing' | 'artifact_unreadable' | 'artifact_not_owned' | 'snapshot_too_large' | 'read_unavailable' | 'conflict' | 'preflight_refused' }
>
export type ArtifactAccessCleanupContext = Readonly<{
  /** Caller-owned original lifecycle/lease check; never supplied by a request body. */
  checkBeforeIssue(): void
  /** Records the known change before any subsequent await. A throw cannot undo it. */
  onChanged(change: ArtifactAccessCleanupChange): void
}>
export class ArtifactAccessCleanupUnknownError extends Error {
  readonly code = 'ARTIFACT_ACCESS_CLEANUP_UNCONFIRMED'
  readonly outcome = 'unknown'
  constructor() { super('Artifact reference cleanup was issued but its outcome is unconfirmed. Keep custody; do not replay it.'); this.name = 'ArtifactAccessCleanupUnknownError' }
}
export function isArtifactAccessCleanupUnknown(error: unknown): error is ArtifactAccessCleanupUnknownError {
  return error instanceof ArtifactAccessCleanupUnknownError
}
const refused = (reason: Extract<ArtifactAccessCleanupResult, { status: 'refused' }>['reason']): ArtifactAccessCleanupResult => Object.freeze({ status: 'refused', reason })
const storedIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.isWellFormed()
const exactOwner = (value: unknown): value is string => storedIdentity(value) && value.trim() === value
const READ_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
local kind = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(kind) ~= 'table' or kind[1] ~= 'object' then return {'INVALID'} end
local result = {'SNAPSHOT'}
local bytes = 0
for _, path in ipairs(${LUA_PATHS}) do
  local raw = redis.pcall('JSON.GET', KEYS[1], path)
  if type(raw) ~= 'string' then return {'INVALID'} end
  bytes = bytes + #raw
  if bytes > ${MAX_SNAPSHOT_BYTES} then return {'TOO_LARGE'} end
  result[#result + 1] = raw
end
return result
`
const WRITE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
local paths = ${LUA_PATHS}
local expected = cjson.decode(ARGV[1])
local positions = cjson.decode(ARGV[2])
if #expected ~= #paths or #positions ~= 5 then return 'INVALID' end
for index, path in ipairs(paths) do
  local raw = redis.pcall('JSON.GET', KEYS[1], path)
  if type(raw) ~= 'string' or raw ~= expected[index] then return 'CONFLICT' end
end
local owner = cjson.decode(expected[2])
local id = cjson.decode(expected[1])
if #owner ~= 1 or #id ~= 1 or owner[1] ~= ARGV[4] or id[1] ~= ARGV[5] then return 'OWNER' end
local count = 0
for index, entries in ipairs(positions) do
  if type(entries) ~= 'table' then return 'INVALID' end
  local previous = -1
  if #entries > 0 then
    local kind = redis.pcall('JSON.TYPE', KEYS[1], paths[index + 2])
    if type(kind) ~= 'table' or kind[1] ~= 'array' then return 'INVALID' end
  end
  for _, position in ipairs(entries) do
    if type(position) ~= 'number' or position < 0 or position % 1 ~= 0 or position <= previous then return 'INVALID' end
    local raw = redis.pcall('JSON.GET', KEYS[1], paths[index + 2] .. '[' .. position .. ']')
    if type(raw) ~= 'string' then return 'INVALID' end
    local found = cjson.decode(raw)
    if #found ~= 1 or type(found[1]) ~= 'string' or found[1] ~= ARGV[3] then return 'INVALID' end
    previous = position; count = count + 1
  end
end
if ARGV[6] ~= 'true' and ARGV[6] ~= 'false' then return 'INVALID' end
if count == 0 then return 'UNCHANGED' end
-- All fixed paths, owner facts and exact positions were checked before this boundary.
for index, entries in ipairs(positions) do
  for position = #entries, 1, -1 do
    local answer = redis.pcall('JSON.ARRPOP', KEYS[1], paths[index + 2], entries[position])
    if type(answer) ~= 'table' or answer.err then return 'PARTIAL' end
  end
end
if ARGV[6] == 'true' then
  local answer = redis.pcall('JSON.SET', KEYS[1], '$.agent_access_scope', '"selected"')
  if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'PARTIAL' end
end
return 'CHANGED'
`
function value(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length > 1) throw new Error('Invalid fixed-path snapshot.')
  return parsed[0]
}
function accessRecord(values: unknown[]) {
  return { agent_allowlist: values[2], metadata: { agent_allowlist: values[3], agentAllowlist: values[4], assigned_agent_ids: values[5], assignedAgentIds: values[6] },
    agent_access_scope: values[7], agent_use_enabled: values[8] }
}

/** Unexposed finite owner. Caller retains its exact replacement/restore lease on unknown.
 * No automatic retry, new key, scope promotion, whole-record write or readback follows. */
export async function removeArtifactAgentReferences(
  args: Readonly<{ userId: string; artifactId: string; agentId: string }>, context: ArtifactAccessCleanupContext
): Promise<ArtifactAccessCleanupResult> {
  if (!args || !exactOwner(args.userId) || !storedIdentity(args.artifactId) || !storedIdentity(args.agentId) ||
    typeof context?.checkBeforeIssue !== 'function' || typeof context?.onChanged !== 'function') return refused('invalid_arguments')
  const { userId, artifactId, agentId } = args
  let checkFailed = false
  const check = () => { try { context.checkBeforeIssue() } catch (error) { checkFailed = true; throw error } }
  check()
  const key = `artifact:${artifactId}`
  let answer: unknown
  try {
    answer = await redis.execute(client => { check(); return client.eval(READ_SCRIPT, { keys: [key], arguments: [] }) })
  } catch (error) { if (checkFailed) throw error; return refused('read_unavailable') }
  check()
  if (Array.isArray(answer) && answer[0] === 'MISSING') return refused('artifact_missing')
  if (Array.isArray(answer) && answer[0] === 'TOO_LARGE') return refused('snapshot_too_large')
  if (!Array.isArray(answer) || answer[0] !== 'SNAPSHOT' || answer.length !== PATHS.length + 1 || answer.slice(1).some(raw => typeof raw !== 'string')) return refused('artifact_unreadable')
  const raw = answer.slice(1) as string[]
  let values: unknown[]
  try { values = raw.map(value) } catch { return refused('artifact_unreadable') }
  if (values[0] !== artifactId || values[1] !== userId) return refused('artifact_not_owned')
  const positions = values.slice(2, 7).map(list => Array.isArray(list) ? list.flatMap((entry, index) => entry === agentId ? [index] : []) : [])
  const removed = positions.reduce((count, entries) => count + entries.length, 0)
  if (!removed) return Object.freeze({ status: 'unchanged' })
  const after = [...values]
  for (let index = 2; index < 7; index++) if (Array.isArray(values[index])) after[index] = (values[index] as unknown[]).filter(entry => entry !== agentId)
  const scopePinned = readArtifactAgentAccess(accessRecord(values)).scope === 'selected' && readArtifactAgentAccess(accessRecord(after)).scope === 'all'
  let issued = false
  try {
    answer = await redis.execute(client => {
      check(); issued = true
      return client.eval(WRITE_SCRIPT, { keys: [key], arguments: [JSON.stringify(raw), JSON.stringify(positions), agentId, userId, artifactId, String(scopePinned)] })
    })
  } catch (error) { if (!issued) throw error; throw new ArtifactAccessCleanupUnknownError() }
  if (answer === 'MISSING') return refused('artifact_missing')
  if (answer === 'CONFLICT') return refused('conflict')
  if (answer === 'OWNER') return refused('artifact_not_owned')
  if (answer === 'INVALID') return refused('preflight_refused')
  if (answer === 'UNCHANGED') return Object.freeze({ status: 'unchanged' })
  if (answer !== 'CHANGED') throw new ArtifactAccessCleanupUnknownError()
  const change = Object.freeze({ removed, scopePinned })
  let notification: 'recorded' | 'failed' = 'recorded'
  try { context.onChanged(change) } catch { notification = 'failed' }
  return Object.freeze({ status: 'changed', ...change, notification })
}
