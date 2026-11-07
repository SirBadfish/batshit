import { isBuiltinPluginMember } from '../../agentPlugins'
import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import type { AppActionsOperationPreview, AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import { appActionsDefinition } from '$lib/appActions/settings/definitions'
import { parseSkillAccessChange, type SkillAccessChange } from '$lib/appActions/skillAccess'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import type { AdapterContext } from '../managementTypes'
import type { AdapterCommitContext } from '../managementTypes'
import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import { newSlashCommandRevision, slashCommandRevisionKey, SLASH_COMMAND_REVISION_LUA } from '../../slashCommandRevisionProtocol'
import { commandEnabledForAgent } from '../../slashCommandCapabilities'
import { readSavedAccessAgentIds } from '../../agentAccessLists'
import { freezeSkillAccess, refuseSkillAccess, skillAccessLabel, SKILL_ACCESS_LIMITS, SKILL_ALIAS_PATHS, SKILL_SUBJECT_PATHS, type SkillAccessSnapshot, type SkillAlias } from './skillAccessReport'
import { acquireSettingsMutation, assertSettingsLifecycle } from './lifecycle'
import { policyContainsSubject } from './authority'
export type { SkillAccessChange } from '$lib/appActions/skillAccess'

export type SkillAccessPreview = AppActionsOperationPreview
export type SkillAliasWrite = Readonly<{
  key: string; commandId: string; skillId: string; enabledAgentIds: readonly string[]; enabledForAll?: false
}>
export type SkillAccessEffectClosure = Readonly<{
  skillIds: readonly string[]; aliasIds: readonly string[]; changedSubjects: readonly SettingsSubjectRef[]
  retainedSubjects: readonly SettingsSubjectRef[]; excluded: readonly SettingsSubjectRef[]
  universalConverted: boolean; futureAgentAccessLost: boolean; builtInWorkerAccessLost: boolean
}>
export type SkillAccessPlan = Readonly<{
  snapshot: SkillAccessSnapshot; change: SkillAccessChange; writes: readonly SkillAliasWrite[]
  targets: readonly SettingsSubjectRef[]; initialOutcomes: readonly AppActionsTargetOutcome[]
  preview: SkillAccessPreview; closure: SkillAccessEffectClosure; preimages: unknown
}>
const noWrite = (subject: SettingsSubjectRef, status: AppActionsTargetOutcome['status'], reason?: string): AppActionsTargetOutcome => ({
  subject, status, ...(reason ? { reason } : {}), saved: 'not_requested', readback: 'not_requested', visible: 'unchanged'
})
function enabled(alias: SkillAlias, id: string) { return commandEnabledForAgent(alias.record as never, id) }

/** Pure access-only planning. Neither data paths nor targets come from change input. */
export function planSkillAccessChange(ctx: AdapterContext, snapshot: SkillAccessSnapshot, raw: SkillAccessChange): SkillAccessPlan {
  ctx.assertCurrent()
  const change = parseSkillAccessChange(raw)
  if (ctx.admission.policy.management.skillAccess === 'block') refuseSkillAccess('SKILL_ACCESS_BLOCKED', 'The user blocked skill-access management.', 403)
  const entries = snapshot.manifest.entries.filter(entry => entry.status === 'available')
  if (snapshot.owner !== ctx.admission.actor.userId || entries.some(entry => !policyContainsSubject(ctx.admission.policy, entry.subject,
    ctx.admission.actor.kind === 'native' ? ctx.admission.actor.id : undefined))) refuseSkillAccess('SUBJECT_NOT_GRANTED', 'The held subjects are outside the current grant.', 403)
  if (entries.some(entry => snapshot.collidingIds.includes(entry.subject.id))) refuseSkillAccess('SKILL_SUBJECT_ID_COLLISION', 'Two stored subject kinds share an ID; access cannot distinguish them.')
  const ids = new Set(entries.map(entry => entry.subject.id))
  const writes = new Map<string, SkillAliasWrite>()
  const targets = new Map<string, SettingsSubjectRef>()
  const previews = new Map<string, SkillAccessPreview['targets'][number]>()
  const initialOutcomes: AppActionsTargetOutcome[] = snapshot.manifest.entries.filter(entry => entry.status !== 'available')
    .map(entry => noWrite(entry.subject, 'unavailable', entry.reason))
  let universalConverted = false
  for (const assignment of change.assignments) {
    const aliases = snapshot.aliases.filter(alias => alias.record.type === 'skill' && alias.record.skill_id === assignment.skillId)
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    if (aliases.some(alias => alias.record.plugin_id !== undefined || isBuiltinPluginMember(alias.record))) refuseSkillAccess('PLUGIN_MEMBER_USER_MANAGED', 'This skill belongs to a plugin. The user manages the entire plugin in Settings; this grant covers only one skill.')
    if (!aliases.length) refuseSkillAccess('SKILL_NOT_LISTED', 'An assigned skill is not in the held existing catalogue.')
    const changed = entries.filter(entry => aliases.some(alias => enabled(alias, entry.subject.id)) !== assignment.enabled)
    if (!changed.length) continue
    if (assignment.enabled) {
      const candidate = aliases.find(alias => alias.record.is_active !== false && alias.record.can_be_invoked_in_chat !== false &&
        Array.isArray(alias.record.enabled_agent_ids) && alias.record.enabled_agent_ids.every(isExactSavedAccessAgentId))
      if (!candidate) refuseSkillAccess('SKILL_ACCESS_UNAVAILABLE', 'This skill has no active, invocable alias with a valid access list. Its status was not changed.')
      const list = readSavedAccessAgentIds(candidate.record.enabled_agent_ids)!
      writes.set(candidate.key, { key: candidate.key, commandId: candidate.record.id, skillId: assignment.skillId,
        enabledAgentIds: [...list, ...changed.map(entry => entry.subject.id).filter(id => !list.includes(id))] })
    } else {
      for (const alias of aliases) {
        if (!changed.some(entry => enabled(alias, entry.subject.id))) continue
        const list = readSavedAccessAgentIds(alias.record.enabled_agent_ids)
        const universal = alias.record.enabled_for_all_agents === true || list === undefined
        let retained: string[]
        if (universal) {
          if (change.universalConversion !== 'preserve-current-population' || ctx.admission.policy.scope.mode !== 'all' || ctx.admission.policy.scope.except.length) {
            refuseSkillAccess('SKILL_UNIVERSAL_SCOPE_REQUIRED', 'Removing selected access from a universal alias needs explicit conversion and whole-population authority.', 403)
          }
          if (!snapshot.population) refuseSkillAccess('SKILL_POPULATION_UNAVAILABLE', 'The complete current subject population is unavailable for conversion.')
          retained = [...new Set(snapshot.population.subjects.map(item => item.subject.id))].filter(id => !ids.has(id)).sort()
          universalConverted = true
        } else retained = list.filter(id => !ids.has(id))
        writes.set(alias.key, { key: alias.key, commandId: alias.record.id, skillId: assignment.skillId, enabledAgentIds: retained,
          ...(alias.record.enabled_for_all_agents === true ? { enabledForAll: false as const } : {}) })
      }
    }
    const label = skillAccessLabel(aliases[0])
    for (const entry of changed) {
      const key = settingsSubjectKey(entry.subject)
      targets.set(key, entry.subject)
      const preview = previews.get(key) ?? { subject: entry.subject, label: entry.label ?? entry.subject.id, changes: [] }
      preview.changes.push({ field: assignment.skillId, label, before: !assignment.enabled, after: assignment.enabled })
      previews.set(key, preview)
    }
  }
  for (const entry of entries) if (!targets.has(settingsSubjectKey(entry.subject))) initialOutcomes.push(noWrite(entry.subject, 'unchanged'))
  const retainedSubjects = universalConverted ? snapshot.population!.subjects.map(item => item.subject).filter(subject => !ids.has(subject.id)) : []
  const closure: SkillAccessEffectClosure = { skillIds: change.assignments.map(item => item.skillId), aliasIds: [...writes.values()].map(write => write.commandId),
    changedSubjects: [...targets.values()], retainedSubjects, excluded: [...snapshot.manifest.excluded], universalConverted,
    futureAgentAccessLost: universalConverted, builtInWorkerAccessLost: universalConverted }
  const preview: SkillAccessPreview = { semanticId: 'agent.skills.access', targets: [...previews.values()], excluded: [...snapshot.manifest.excluded],
    effects: [...appActionsDefinition('agent.skills.access').effects,
      ...(universalConverted ? ['Replaces access for everyone with the named current agents. Other current agents keep access. Future agents and built-in Workers will not gain this skill automatically.'] : [])] }
  const preimages = { revision: snapshot.revision, aliases: snapshot.aliases.map(alias => ({ key: alias.key, raw: alias.raw })),
    subjects: snapshot.subjects, namespace: snapshot.namespace, lifecycle: snapshot.lifecycle, population: snapshot.population, closure }
  const plan = { snapshot, change, writes: [...writes.values()], targets: [...targets.values()], initialOutcomes, preview, closure, preimages }
  if (Buffer.byteLength(JSON.stringify({ preimages, preview, writes: plan.writes }), 'utf8') > SKILL_ACCESS_LIMITS.bytes) {
    refuseSkillAccess('SKILL_PLAN_BUDGET', 'The complete access change exceeds this operation budget.')
  }
  return freezeSkillAccess(plan)
}

export const CONDITIONAL_SKILL_ACCESS_SCRIPT = `
${SLASH_COMMAND_REVISION_LUA}
local input = cjson.decode(ARGV[1])
local revision = command_revision(KEYS[1])
if revision == nil or not valid_command_nonce(input.nonce) then return 'INVALID_REVISION' end
if revision ~= input.revision then return 'CONFLICT' end
if redis.call('JSON.TYPE', KEYS[2], '$')[1] ~= 'object' then return 'AUTHORITY_CHANGED' end
for _, entry in ipairs(input.authority) do
  if (redis.call('JSON.GET', KEYS[2], entry[1]) or '') ~= entry[2] then return 'AUTHORITY_CHANGED' end
end
local now = redis.call('TIME')
if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= input.deadlineAt then return 'EXPIRED' end
local function matches(entries, paths)
  for _, entry in ipairs(entries) do
    for index, path in ipairs(paths) do
      if (redis.call('JSON.GET', KEYS[entry.index], path) or '') ~= entry.raw[index] then return false end
    end
  end
  return true
end
if not matches(input.aliases, input.aliasPaths) or not matches(input.subjects, input.subjectPaths) then return 'CONFLICT' end
if input.population then
  for _, index in ipairs({input.population.primaryIndex, input.population.subagentIndex}) do
    local kind = redis.call('TYPE', KEYS[index]).ok
    if kind ~= 'none' and kind ~= 'set' then return 'POPULATION_CHANGED' end
    local members = redis.call('SMEMBERS', KEYS[index])
    table.sort(members)
    local expected = index == input.population.primaryIndex and input.population.primary or input.population.subagent
    if #members ~= #expected then return 'POPULATION_CHANGED' end
    for position, value in ipairs(expected) do if members[position] ~= value then return 'POPULATION_CHANGED' end end
  end
end
if type(input.writes) ~= 'table' or #input.writes == 0 or #input.writes > 256 then return 'INVALID_CHANGES' end
if type(input.timestamp) ~= 'string' or not string.match(input.timestamp, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') then return 'INVALID_CHANGES' end
local checked = {}
for _, write in ipairs(input.writes) do
  if type(write.index) ~= 'number' or not KEYS[write.index] or checked[write.index] or
    redis.call('JSON.TYPE', KEYS[write.index], '$')[1] ~= 'object' or type(write.list) ~= 'table' then return 'INVALID_CHANGES' end
  checked[write.index] = true
  for _, id in ipairs(write.list) do if type(id) ~= 'string' or #id == 0 or string.find(id, '^%s') or string.find(id, '%s$') then return 'INVALID_CHANGES' end end
  if write.global ~= nil and write.global ~= false then return 'INVALID_CHANGES' end
  if cjson.decode(redis.call('JSON.GET', KEYS[write.index], '$.type'))[1] ~= 'skill' or
    cjson.decode(redis.call('JSON.GET', KEYS[write.index], '$.skill_id'))[1] ~= write.skillId then return 'INVALID_CHANGES' end
  write.attachable = #write.list > 0 or (write.global ~= false and cjson.decode(redis.call('JSON.GET', KEYS[write.index], '$.enabled_for_all_agents'))[1] == true)
end
-- Every retained resource, value and path is checked before nonce/command effects.
redis.call('SET', KEYS[1], input.nonce)
for _, write in ipairs(input.writes) do
  local key = KEYS[write.index]
  local answer = redis.pcall('JSON.SET', key, '$.enabled_agent_ids', #write.list > 0 and cjson.encode(write.list) or '[]')
  if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'PARTIAL' end
  if write.global == false then
    answer = redis.pcall('JSON.SET', key, '$.enabled_for_all_agents', 'false')
    if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'PARTIAL' end
  end
  answer = redis.pcall('JSON.SET', key, '$.can_be_attached_to_agents', write.attachable and 'true' or 'false')
  if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'PARTIAL' end
  answer = redis.pcall('JSON.SET', key, '$.updated_at', cjson.encode(input.timestamp))
  if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'PARTIAL' end
end
return 'OK'
`

/** Node-redis's queued AbortError is the same proven no-send boundary as P2.
 * Every other issued error/partial result retains mutation custody as unknown. */
export async function writeSkillAccessPlan(ctx: AdapterCommitContext, plan: SkillAccessPlan): Promise<AppActionsTargetOutcome[]> {
  const result = (saved: 'saved' | 'unknown' | 'not_requested', reason?: string) => plan.targets.map(subject => ({
    subject, status: saved === 'saved' ? 'applied' as const : saved === 'unknown' ? 'unknown' as const :
      reason === 'skill_access_preimage_changed' ? 'conflict' as const : 'blocked' as const,
    ...(reason ? { reason } : {}), saved, readback: 'not_requested' as const,
    visible: saved === 'not_requested' ? 'unchanged' as const : 'unknown' as const
  }))
  if (!plan.writes.length) return []
  const fence = ctx.admission.fence
  const snapshot = plan.snapshot
  const signal = ctx.signal ?? ctx.execution.signal
  let issued = false
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined
  let answer: unknown
  try {
    await ctx.refreshAuthority()
    answer = await redis.execute(async client => {
      const abort = new AbortController()
      const cancel = () => abort.abort()
      const events = ['error', 'end', 'reconnecting'] as const
      for (const event of events) client.on(event, cancel)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        ctx.assertCurrent()
        assertSettingsLifecycle(snapshot.lifecycle)
        if (fence.lifecycle) assertSettingsLifecycle(fence.lifecycle)
        lease = acquireSettingsMutation({ epoch: snapshot.lifecycle.epoch, records: [...snapshot.lifecycle.records, ...(fence.lifecycle?.records ?? [])] })
        const deadlineAt = Math.min(ctx.deadlineAt, ctx.execution.deadlineAt, ctx.admission.expiresAt ?? Infinity)
        const delay = deadlineAt - Date.now()
        if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) throw new Error('operation_ended')
        timer = setTimeout(cancel, delay)
        const keys = [slashCommandRevisionKey(snapshot.owner), fence.key]
        const index = (key: string) => { let found = keys.indexOf(key); if (found < 0) { found = keys.length; keys.push(key) }; return found + 1 }
        const aliases = snapshot.aliases.map(alias => ({ index: index(alias.key), raw: alias.raw }))
        const subjects = [...snapshot.subjects, ...snapshot.namespace].map(subject => ({ index: index(subject.key), raw: subject.raw }))
        const population = plan.closure.universalConverted && snapshot.population ? { ...snapshot.population, subjects: undefined,
          primaryIndex: index(`user:${snapshot.owner}:agents`), subagentIndex: index(`user:${snapshot.owner}:subagents`) } : undefined
        const input = { revision: snapshot.revision ?? '', nonce: newSlashCommandRevision(), authority: fence.paths, deadlineAt,
          aliases, aliasPaths: SKILL_ALIAS_PATHS, subjects, subjectPaths: SKILL_SUBJECT_PATHS, population,
          writes: plan.writes.map(write => ({ index: index(write.key), skillId: write.skillId, list: write.enabledAgentIds,
            ...(write.enabledForAll === false ? { global: false } : {}) })), timestamp: new Date().toISOString() }
        lease.check(); ctx.assertCurrent(); ctx.execution.checkNative?.()
        if (!client.isOpen || !client.isReady || abort.signal.aborted) throw new Error('store_not_ready')
        for (const target of plan.targets) ctx.execution.targetStarted(target)
        try {
          issued = true
          return await client.withAbortSignal(abort.signal).eval(CONDITIONAL_SKILL_ACCESS_SCRIPT, { keys, arguments: [JSON.stringify(input)] })
        } catch (error) {
          if (abort.signal.aborted && error instanceof AbortError) issued = false
          throw error
        }
      } finally {
        for (const event of events) client.removeListener(event, cancel)
        signal.removeEventListener('abort', cancel)
        clearTimeout(timer)
      }
    })
  } catch {
    if (issued) { lease?.unknown(); return result('unknown', 'skill_access_write_unconfirmed') }
    lease?.settle()
    return result('not_requested', 'operation_no_longer_admitted')
  }
  if (answer === 'OK') {
    lease?.settle()
    const outcomes = result('saved')
    // Synchronous receipt first: no later await can erase a confirmed save.
    for (const outcome of outcomes) ctx.execution.recordOutcome(outcome)
    return outcomes
  }
  if (typeof answer === 'string' && ['CONFLICT', 'AUTHORITY_CHANGED', 'EXPIRED', 'POPULATION_CHANGED', 'INVALID_REVISION', 'INVALID_CHANGES'].includes(answer)) {
    lease?.settle()
    return result('not_requested', answer === 'CONFLICT' || answer === 'POPULATION_CHANGED' ? 'skill_access_preimage_changed' : 'operation_no_longer_admitted')
  }
  lease?.unknown()
  return result('unknown', 'skill_access_write_unconfirmed')
}
