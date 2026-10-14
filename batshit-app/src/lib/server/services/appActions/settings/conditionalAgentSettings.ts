import { createHash } from 'node:crypto'
import {
  resolveAgentMemoryEnabled, resolveMemoryLaneBudgets, resolveMemoryLingerTurns,
  resolveMemoryRecallLingerTurns
} from '$lib/utils/memoryControl'
import { planRecordFieldOps } from '$lib/server/agentRecordUpdate'
import {
  refuseSettings, requireOwnActor, validateOwnRead, validateOwnUpdate,
  type IdentityPreferenceChanges, type IdentityPreferenceValues, type MemoryPreferenceChanges,
  type MemoryPreferenceValues, type SettingsFamily, type SettingsOwnerContext
} from '$lib/appActions/settings/validation'

// Only these paths can be read or changed. The internal raw budget block never
// leaves this service: its exact bytes are used solely for a conditional write.
export const SETTINGS_SNAPSHOT_PATHS = [
  '$.id', '$.user_id', '$.agentType', '$.displayName', '$.memory_enabled',
  '$.memory_lane_budgets', '$.memoryLaneBudgets', '$.memory_linger_turns',
  '$.memoryLingerTurns', '$.memory_recall_linger_turns', '$.memoryRecallLingerTurns', '$.memoryEnabled'
] as const

export const READ_SETTINGS_SNAPSHOT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID_RECORD'} end
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do
  out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or ''
end
return out
`

// Every ownership/revision/value/container check precedes the first mutation.
// The caller also validates through the existing planner before EVAL. Lua has
// no rollback on an error, so no fallible shape discovery occurs after writes.
export const CONDITIONAL_SETTINGS_WRITE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'INVALID_RECORD' end
local function value(path)
  local raw = redis.call('JSON.GET', KEYS[1], path)
  if not raw then return nil end
  return cjson.decode(raw)[1]
end
if value('$.id') ~= ARGV[1] or value('$.user_id') ~= ARGV[2] then return 'FORBIDDEN' end
local agentType = value('$.agentType')
if agentType ~= 'api' and agentType ~= 'cli' then return 'UNSUPPORTED_PRIMARY' end
local expected = cjson.decode(ARGV[3])
for _, entry in ipairs(expected) do
  if (redis.call('JSON.GET', KEYS[1], entry[1]) or '') ~= entry[2] then return 'CONFLICT' end
end
local family = ARGV[4]
local changes = cjson.decode(ARGV[5])
local timestampValid, timestamp = pcall(cjson.decode, ARGV[6])
if not timestampValid or type(timestamp) ~= 'string' or not string.match(timestamp, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') then return 'INVALID_TIMESTAMP' end
local paths = {
  onMyMind = '$.memory_lane_budgets.on_my_mind',
  triggers = '$.memory_lane_budgets.triggers',
  recalled = '$.memory_lane_budgets.recalled',
  triggerLingerTurns = '$.memory_linger_turns',
  recallLingerTurns = '$.memory_recall_linger_turns'
}
local count = 0
local budgets = false
for name, newValue in pairs(changes) do
  count = count + 1
  if family == 'identity' then
    if name ~= 'displayName' or type(newValue) ~= 'string' or #newValue == 0 or #newValue > 600 then return 'INVALID_CHANGES' end
  elseif family == 'memory' then
    if not paths[name] or type(newValue) ~= 'number' or newValue ~= math.floor(newValue) then return 'INVALID_CHANGES' end
    local maximum = (name == 'triggerLingerTurns' or name == 'recallLingerTurns') and 8 or 20000
    if newValue < 0 or newValue > maximum then return 'INVALID_CHANGES' end
    if name == 'onMyMind' or name == 'triggers' or name == 'recalled' then budgets = true end
  else return 'INVALID_CHANGES' end
end
if count == 0 then return 'INVALID_CHANGES' end
if budgets then
  local budgetType = redis.call('JSON.TYPE', KEYS[1], '$.memory_lane_budgets')[1]
  if budgetType and budgetType ~= 'null' and budgetType ~= 'object' then return 'INVALID_BUDGET_SHAPE' end
  if (not budgetType or budgetType == 'null') and value('$.memoryLaneBudgets') ~= nil and value('$.memoryLaneBudgets') ~= cjson.null then
    return 'LEGACY_BUDGETS'
  end
end
-- Mutation boundary: every path is fixed and every JSON value prevalidated.
if budgets and redis.call('JSON.TYPE', KEYS[1], '$.memory_lane_budgets')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[1], '$.memory_lane_budgets', '{}')
end
if family == 'identity' then
  redis.call('JSON.SET', KEYS[1], '$.displayName', cjson.encode(changes.displayName))
else
  for name, newValue in pairs(changes) do redis.call('JSON.SET', KEYS[1], paths[name], cjson.encode(newValue)) end
end
redis.call('JSON.SET', KEYS[1], '$.updated_at', cjson.encode(timestamp))
return 'OK'
`

type Snapshot = { raw: readonly string[] }
export type SettingsRead<V> = { subjectAgentId: string; revision: string; values: V; memoryEnabled?: boolean }
export type SettingsWriteResult<V, C> = {
  status: 'completed' | 'no_op' | 'blocked' | 'unknown_outcome'
  reason?: string
  saved: 'saved' | 'not_requested' | 'unknown'
  readback: 'verified' | 'unavailable' | 'changed' | 'not_requested'
  visible: 'unknown' | 'unchanged'
  current?: SettingsRead<V>
  inverse?: { subjectAgentId: string; expectedRevision: string; changes: C }
  inverseUnavailable?: string
}
type SettingsEvalClient = {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export type SettingsRedisClient = SettingsEvalClient & {
  readonly isOpen: boolean
  readonly isReady: boolean
  withAbortSignal(signal: AbortSignal): SettingsEvalClient
  on(event: 'error' | 'end' | 'reconnecting', listener: () => void): unknown
  removeListener(event: 'error' | 'end' | 'reconnecting', listener: () => void): unknown
}
export type SettingsRedisExecutor = <T>(operation: (client: SettingsRedisClient) => Promise<T>) => Promise<T>
class SettingsSaveAdmissionRefusal extends Error {
  constructor(readonly reason: string) { super(reason) }
}
export type ConditionalSettingsStore = {
  read(subjectAgentId: string): Promise<Snapshot>
  write(subjectAgentId: string, userId: string, family: SettingsFamily, before: Snapshot, changes: MemoryPreferenceChanges | IdentityPreferenceChanges, admit?: () => void, signal?: AbortSignal, deadlineAt?: number): Promise<string>
}

export function createConditionalSettingsStore(execute: SettingsRedisExecutor, isCommandAbortError: (error: unknown) => boolean): ConditionalSettingsStore {
  return {
    async read(subjectAgentId) {
      const answer = await execute(client => client.eval(READ_SETTINGS_SNAPSHOT_SCRIPT, {
        keys: [`agent:${subjectAgentId}`], arguments: [JSON.stringify(SETTINGS_SNAPSHOT_PATHS)]
      }))
      if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== SETTINGS_SNAPSHOT_PATHS.length + 1 || answer.slice(1).some(item => typeof item !== 'string')) {
        if (Array.isArray(answer) && answer[0] === 'MISSING') refuseSettings('agent_not_found')
        refuseSettings('agent_record_unavailable')
      }
      const raw = answer.slice(1) as string[]
      // Check RedisJSON's real JSONPath shape (one-element array or []), never
      // assume json.get's root-object answer has the same wire shape.
      for (const item of raw) parseSnapshotValue(item)
      return { raw }
    },
    async write(subjectAgentId, userId, family, before, changes, admit, signal, deadlineAt) {
      if (family === 'identity') planRecordFieldOps('displayName', (changes as IdentityPreferenceChanges).displayName, new Set())
      const indices = familyIndices(family)
      const expected = indices.map(index => [SETTINGS_SNAPSHOT_PATHS[index], before.raw[index]])
      let issued = false
      let answer: unknown
      try { answer = await execute(async client => {
        // execute awaits getClient/reconnection before calling us. Admission and
        // readiness must therefore be checked here, immediately before issue.
        const abort = new AbortController()
        const disconnected = () => abort.abort()
        const cancelled = () => abort.abort()
        const events = ['error', 'end', 'reconnecting'] as const
        for (const event of events) client.on(event, disconnected)
        signal?.addEventListener('abort', cancelled, { once: true })
        if (signal?.aborted) cancelled()
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          const options = {
            keys: [`agent:${subjectAgentId}`],
            arguments: [subjectAgentId, userId, JSON.stringify(expected), family, JSON.stringify(changes), JSON.stringify(new Date().toISOString())]
          }
          if (deadlineAt !== undefined) {
            const delay = deadlineAt - Date.now()
            if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) throw new SettingsSaveAdmissionRefusal('operation_no_longer_admitted')
            deadline = setTimeout(cancelled, delay)
          }
          try { admit?.() } catch { throw new SettingsSaveAdmissionRefusal('operation_no_longer_admitted') }
          if (!client.isOpen || !client.isReady || abort.signal.aborted) throw new SettingsSaveAdmissionRefusal('settings_store_not_ready')
          try {
            const command = client.withAbortSignal(abort.signal)
            issued = true
            return await command.eval(CONDITIONAL_SETTINGS_WRITE_SCRIPT, options)
          } catch (error) {
            // Installed node-redis removes the abort listener when a command
            // leaves toWrite. Its AbortError proves this command was not sent.
            if (abort.signal.aborted && isCommandAbortError(error)) throw new SettingsSaveAdmissionRefusal(signal?.aborted || deadlineAt !== undefined && deadlineAt <= Date.now() ? 'operation_no_longer_admitted' : 'settings_store_disconnected_before_write')
            throw error
          }
        } finally {
          for (const event of events) client.removeListener(event, disconnected)
          signal?.removeEventListener('abort', cancelled)
          if (deadline !== undefined) clearTimeout(deadline)
        }
      }) } catch (error) {
        if (error instanceof SettingsSaveAdmissionRefusal) throw error
        if (!issued) throw new SettingsSaveAdmissionRefusal('settings_store_unavailable_before_write')
        throw error
      }
      if (typeof answer !== 'string') throw new Error('Invalid conditional Settings save answer.')
      return answer
    }
  }
}

function parseSnapshotValue(raw: string): unknown {
  if (raw === '') return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { refuseSettings('invalid_settings_snapshot') }
  if (!Array.isArray(value) || value.length > 1) refuseSettings('invalid_settings_snapshot')
  return value[0]
}
function familyIndices(family: SettingsFamily): readonly number[] {
  return family === 'memory' ? [0, 1, 2, 5, 6, 7, 8, 9, 10] : [0, 1, 2, 3]
}
function revision(snapshot: Snapshot, family: SettingsFamily): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(familyIndices(family).map(index => snapshot.raw[index]))).digest('hex')}`
}
function assertOwner(snapshot: Snapshot, context: SettingsOwnerContext, subjectAgentId: string): void {
  if (parseSnapshotValue(snapshot.raw[0]) !== subjectAgentId || parseSnapshotValue(snapshot.raw[1]) !== context.actor.userId) refuseSettings('agent_not_owned')
  const type = parseSnapshotValue(snapshot.raw[2])
  if (type !== 'api' && type !== 'cli') refuseSettings('unsupported_primary_agent')
}
function memoryValues(snapshot: Snapshot): MemoryPreferenceValues {
  const agent = {
    memory_lane_budgets: parseSnapshotValue(snapshot.raw[5]), memoryLaneBudgets: parseSnapshotValue(snapshot.raw[6]),
    memory_linger_turns: parseSnapshotValue(snapshot.raw[7]), memoryLingerTurns: parseSnapshotValue(snapshot.raw[8]),
    memory_recall_linger_turns: parseSnapshotValue(snapshot.raw[9]), memoryRecallLingerTurns: parseSnapshotValue(snapshot.raw[10])
  }
  const budgets = resolveMemoryLaneBudgets(agent)
  return { onMyMind: budgets.onMyMind, triggers: budgets.triggers, recalled: budgets.recalled,
    triggerLingerTurns: resolveMemoryLingerTurns(agent), recallLingerTurns: resolveMemoryRecallLingerTurns(agent) }
}
function identityValues(snapshot: Snapshot): IdentityPreferenceValues {
  const displayName = parseSnapshotValue(snapshot.raw[3])
  if (typeof displayName !== 'string' || displayName.length > 200 || !displayName.isWellFormed()) refuseSettings('display_name_unavailable')
  return { displayName }
}
function budgetWriteRefusal(snapshot: Snapshot, changes: Record<string, unknown>): string | undefined {
  if (!['onMyMind', 'triggers', 'recalled'].some(key => Object.hasOwn(changes, key))) return undefined
  const canonical = parseSnapshotValue(snapshot.raw[5])
  if (canonical !== undefined && canonical !== null && (typeof canonical !== 'object' || Array.isArray(canonical))) return 'invalid_budget_shape'
  const legacy = parseSnapshotValue(snapshot.raw[6])
  if ((canonical === undefined || canonical === null) && legacy !== undefined && legacy !== null) return 'legacy_budget_settings_require_human'
}
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: 'memory'): SettingsRead<MemoryPreferenceValues>
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: 'identity'): SettingsRead<IdentityPreferenceValues>
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: SettingsFamily) {
  return { subjectAgentId, revision: revision(snapshot, family),
    values: family === 'memory' ? memoryValues(snapshot) : identityValues(snapshot),
    ...(family === 'memory' ? { memoryEnabled: resolveAgentMemoryEnabled({ memory_enabled: parseSnapshotValue(snapshot.raw[4]), memoryEnabled: parseSnapshotValue(snapshot.raw[11]) }) } : {}) }
}

export function createOwnAgentSettingsExecutors(store: ConditionalSettingsStore) {
  async function preview(family: SettingsFamily, args: unknown, context: SettingsOwnerContext) {
    const request = family === 'memory' ? validateOwnUpdate(args, 'memory') : validateOwnUpdate(args, 'identity')
    requireOwnActor(context, request.subjectAgentId)
    const snapshot = await store.read(request.subjectAgentId)
    context.check(); assertOwner(snapshot, context, request.subjectAgentId)
    const current = family === 'memory' ? publicRead(snapshot, request.subjectAgentId, 'memory') : publicRead(snapshot, request.subjectAgentId, 'identity')
    if (current.revision !== request.expectedRevision) return { status: 'blocked' as const, reason: 'revision_conflict', saved: 'not_requested' as const, visible: 'unchanged' as const }
    const changes = Object.fromEntries(Object.entries(request.changes).filter(([key, value]) => value !== (current.values as Record<string, unknown>)[key]))
    const reason = family === 'memory' ? budgetWriteRefusal(snapshot, changes) : undefined
    if (reason) return { status: 'blocked' as const, reason, saved: 'not_requested' as const, visible: 'unchanged' as const }
    return { status: Object.keys(changes).length ? 'preview' as const : 'no_op' as const, saved: 'not_requested' as const, visible: 'unchanged' as const,
      requiresConfirmation: family === 'memory', current, changes }
  }
  async function readMemory(args: unknown, context: SettingsOwnerContext) {
    const { subjectAgentId } = validateOwnRead(args)
    requireOwnActor(context, subjectAgentId)
    const snapshot = await store.read(subjectAgentId)
    context.check(); assertOwner(snapshot, context, subjectAgentId)
    return publicRead(snapshot, subjectAgentId, 'memory')
  }
  async function readIdentity(args: unknown, context: SettingsOwnerContext) {
    const { subjectAgentId } = validateOwnRead(args)
    requireOwnActor(context, subjectAgentId)
    const snapshot = await store.read(subjectAgentId)
    context.check(); assertOwner(snapshot, context, subjectAgentId)
    return publicRead(snapshot, subjectAgentId, 'identity')
  }
  async function update(family: SettingsFamily, args: unknown, context: SettingsOwnerContext): Promise<SettingsWriteResult<MemoryPreferenceValues | IdentityPreferenceValues, MemoryPreferenceChanges | IdentityPreferenceChanges>> {
    const request = family === 'memory' ? validateOwnUpdate(args, 'memory') : validateOwnUpdate(args, 'identity')
    if (!context.signal) refuseSettings('operation_cancellation_signal_required')
    requireOwnActor(context, request.subjectAgentId)
    const before = await store.read(request.subjectAgentId)
    context.check(); assertOwner(before, context, request.subjectAgentId)
    if (revision(before, family) !== request.expectedRevision) return { status: 'blocked', reason: 'revision_conflict', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    const beforeValues = family === 'memory' ? memoryValues(before) : identityValues(before)
    const changes = Object.fromEntries(Object.entries(request.changes).filter(([key, value]) => value !== (beforeValues as Record<string, unknown>)[key]))
    if (!Object.keys(changes).length) return { status: 'no_op', saved: 'not_requested', readback: 'verified', visible: 'unchanged', current: family === 'memory' ? publicRead(before, request.subjectAgentId, 'memory') : publicRead(before, request.subjectAgentId, 'identity') }
    const shapeRefusal = family === 'memory' ? budgetWriteRefusal(before, changes) : undefined
    if (shapeRefusal) return { status: 'blocked', reason: shapeRefusal, saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    context.check()
    let answer: string
    try { answer = await store.write(request.subjectAgentId, context.actor.userId, family, before, changes as MemoryPreferenceChanges | IdentityPreferenceChanges, () => requireOwnActor(context, request.subjectAgentId), context.signal, context.deadlineAt) }
    catch (error) {
      if (error instanceof SettingsSaveAdmissionRefusal) return { status: 'blocked', reason: error.reason, saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
      return { status: 'unknown_outcome', reason: 'save_outcome_unconfirmed', saved: 'unknown', readback: 'unavailable', visible: 'unknown' }
    }
    if (answer !== 'OK') {
      const reasons: Record<string, string> = { CONFLICT: 'revision_conflict', MISSING: 'agent_not_found', FORBIDDEN: 'agent_not_owned', UNSUPPORTED_PRIMARY: 'unsupported_primary_agent', INVALID_BUDGET_SHAPE: 'invalid_budget_shape', LEGACY_BUDGETS: 'legacy_budget_settings_require_human', INVALID_RECORD: 'invalid_agent_record', INVALID_CHANGES: 'invalid_changes', INVALID_TIMESTAMP: 'invalid_save_timestamp' }
      const reason = reasons[answer]
      if (!reason) return { status: 'unknown_outcome', reason: 'unexpected_save_answer', saved: 'unknown', readback: 'unavailable', visible: 'unknown' }
      return { status: 'blocked', reason, saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    }
    // OK proves the save. A later outage never takes that evidence away.
    let after: Snapshot
    try { after = await store.read(request.subjectAgentId); assertOwner(after, context, request.subjectAgentId) }
    catch { return { status: 'completed', reason: 'saved_readback_unavailable', saved: 'saved', readback: 'unavailable', visible: 'unknown', inverseUnavailable: 'readback_unavailable' } }
    let current: SettingsRead<MemoryPreferenceValues | IdentityPreferenceValues>
    try { current = family === 'memory' ? publicRead(after, request.subjectAgentId, 'memory') : publicRead(after, request.subjectAgentId, 'identity') }
    catch { return { status: 'completed', reason: 'saved_readback_unavailable', saved: 'saved', readback: 'unavailable', visible: 'unknown', inverseUnavailable: 'readback_unavailable' } }
    if (Object.entries(changes).some(([key, value]) => (current.values as Record<string, unknown>)[key] !== value)) {
      return { status: 'completed', reason: 'saved_then_changed', saved: 'saved', readback: 'changed', visible: 'unknown', current, inverseUnavailable: 'settings_changed_after_save' }
    }
    const inverseChanges: Record<string, unknown> = {}
    const canonical = parseSnapshotValue(before.raw[5])
    for (const key of Object.keys(changes)) {
      const previous = family === 'identity' ? parseSnapshotValue(before.raw[3]) :
        key === 'triggerLingerTurns' ? parseSnapshotValue(before.raw[7]) : key === 'recallLingerTurns' ? parseSnapshotValue(before.raw[9]) :
          canonical && typeof canonical === 'object' && !Array.isArray(canonical) ? (canonical as Record<string, unknown>)[key === 'onMyMind' ? 'on_my_mind' : key] : undefined
      const max = key.endsWith('LingerTurns') ? 8 : 20_000
      if (family === 'identity' ? typeof previous !== 'string' || !previous.trim() || previous.trim() !== previous || previous.length > 200 || !previous.isWellFormed() : typeof previous !== 'number' || !Number.isInteger(previous) || previous < 0 || previous > max) {
        return { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown', current, inverseUnavailable: 'previous_values_cannot_be_restored_losslessly' }
      }
      inverseChanges[key] = previous
    }
    return { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown', current,
      inverse: { subjectAgentId: request.subjectAgentId, expectedRevision: current.revision, changes: inverseChanges as MemoryPreferenceChanges | IdentityPreferenceChanges } }
  }
  return { readMemory, readIdentity,
    previewMemory: (args: unknown, context: SettingsOwnerContext) => preview('memory', args, context),
    previewIdentity: (args: unknown, context: SettingsOwnerContext) => preview('identity', args, context),
    updateMemory: (args: unknown, context: SettingsOwnerContext) => update('memory', args, context) as Promise<SettingsWriteResult<MemoryPreferenceValues, MemoryPreferenceChanges>>,
    updateIdentity: (args: unknown, context: SettingsOwnerContext) => update('identity', args, context) as Promise<SettingsWriteResult<IdentityPreferenceValues, IdentityPreferenceChanges>> }
}
