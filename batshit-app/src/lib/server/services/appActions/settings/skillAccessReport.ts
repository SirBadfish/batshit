import { isBuiltinPluginMember } from '../../agentPlugins'
import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import { isCanonicalAgentId } from '$lib/utils/agentId'
import { redis } from '$lib/server/redis'
import type { SlashCommandRow } from '$lib/types/database'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import type { AdapterContext } from '../managementTypes'
import { parseSkillAccessQuery, type SkillAccessQuery } from '$lib/appActions/skillAccess'
export type { SkillAccessQuery } from '$lib/appActions/skillAccess'
import { commandEnabledForAgent } from '../../slashCommandCapabilities'
import { slashCommandRevisionKey } from '../../slashCommandRevision'
import { AppActionsManagementRefusal, policyContainsSubject } from './authority'
import { captureSettingsLifecycle, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from './lifecycle'
import { ownedSettingsRecord, settingsSubjectType, type SettingsSubjectManifest } from './subjects'

export const SKILL_ACCESS_LIMITS = Object.freeze({ skills: 32, commands: 256, subjects: 256, bytes: 1024 * 1024 })
export const SKILL_ALIAS_PATHS = [
  '$.id', '$.user_id', '$.type', '$.skill_id', '$.name', '$.displayName', '$.is_active',
  '$.can_be_invoked_in_chat', '$.plugin_id', '$.enabled_for_all_agents', '$.enabled_agent_ids', '$.created_at'
] as const
export const SKILL_SUBJECT_PATHS = ['$.id', '$.user_id', '$.agentType', '$.subagentType', '$.created_at'] as const
export const READ_SKILL_METADATA_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID'} end
local result = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do result[#result + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return result
`
export type SkillAlias = Readonly<{
  key: string
  raw: readonly string[]
  record: Readonly<Partial<SlashCommandRow> & { id: string; user_id: string; type: 'skill' | 'prompt' }>
}>
export type SkillSubjectSnapshot = Readonly<{ key: string; subject: SettingsSubjectRef; raw: readonly string[] }>
export type SkillAccessChoice = Readonly<{ skillId: string; label: string; aliases: readonly string[]; available: boolean; reason?: 'plugin_user_managed' }>
export type SkillAccessRow = Readonly<{
  skillId: string; subject: SettingsSubjectRef; effective: boolean | null; reason?: string
  aliases: readonly Readonly<{ commandId: string; active: boolean; invocable: boolean; enabled: boolean;
    source: 'global' | 'absent-list' | 'list' | 'none' | 'invalid' }>[]
}>
export type SkillAccessReportHandle = Readonly<{ kind: 'skill-access-report' }>
export type SkillAccessRead = Readonly<{ handle: SkillAccessReportHandle; choices: readonly SkillAccessChoice[]; rows: readonly SkillAccessRow[] }>
export type SkillAccessSnapshot = Readonly<{
  owner: string; actor: string; revision: string | null; aliases: readonly SkillAlias[]; manifest: SettingsSubjectManifest
  subjects: readonly SkillSubjectSnapshot[]; lifecycle: SettingsLifecycleSnapshot
  namespace: readonly SkillSubjectSnapshot[]; collidingIds: readonly string[]
  population: null | Readonly<{ primary: readonly string[]; subagent: readonly string[]; subjects: readonly SkillSubjectSnapshot[] }>
}>
const snapshots = new WeakMap<SkillAccessReportHandle, SkillAccessSnapshot>()
const canonicalSkillId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9_]{1,128}$/.test(value)
export function freezeSkillAccess<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSkillAccess(child)
    Object.freeze(value)
  }
  return value
}
function actorKey(ctx: AdapterContext) {
  const actor = ctx.admission.actor
  return JSON.stringify([actor.userId, actor.kind, actor.id, actor.generation, actor.sessionId ?? null])
}
export function refuseSkillAccess(code: string, message: string, status = 409): never {
  throw new AppActionsManagementRefusal(code, message, status)
}
export function skillAccessSnapshot(ctx: AdapterContext, handle: SkillAccessReportHandle): SkillAccessSnapshot {
  ctx.assertCurrent()
  const saved = snapshots.get(handle)
  if (!saved || saved.owner !== ctx.admission.actor.userId || saved.actor !== actorKey(ctx)) {
    refuseSkillAccess('SKILL_REPORT_NOT_HELD', 'Request a current skill-access report before changing access.')
  }
  assertSettingsLifecycle(saved.lifecycle)
  return saved
}
function metadata(raw: readonly string[], paths: readonly string[]): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  raw.forEach((text, index) => {
    const values: unknown = JSON.parse(text)
    if (!Array.isArray(values) || values.length > 1) refuseSkillAccess('SKILL_METADATA_UNAVAILABLE', 'The saved skill metadata is unreadable.')
    if (values.length) record[paths[index].slice(2)] = values[0]
  })
  return record
}
function source(alias: SkillAlias): SkillAccessRow['aliases'][number]['source'] {
  if (alias.record.enabled_for_all_agents === true) return 'global'
  if (!Object.hasOwn(alias.record, 'enabled_agent_ids')) return 'absent-list'
  if (!Array.isArray(alias.record.enabled_agent_ids) || alias.record.enabled_agent_ids.some(id => !isExactSavedAccessAgentId(id))) return 'invalid'
  return alias.record.enabled_agent_ids.length ? 'list' : 'none'
}
export function skillAccessLabel(alias: SkillAlias): string {
  for (const value of [alias.record.displayName, alias.record.name]) {
    if (typeof value === 'string' && value.trim() && value.length <= 200 && value.isWellFormed()) return value
  }
  return alias.record.skill_id ?? alias.record.id
}
/** Uses the actual runtime predicate; no second access rule. */
export function projectSkillAccess(aliases: readonly SkillAlias[], query: SkillAccessQuery, manifest: SettingsSubjectManifest) {
  const grouped = new Map<string, SkillAlias[]>()
  for (const alias of aliases) {
    if (alias.record.type !== 'skill') continue
    if (!canonicalSkillId(alias.record.skill_id)) refuseSkillAccess('SKILL_BINDING_UNAVAILABLE', 'A saved skill alias has an invalid binding; the catalogue was not treated as empty.')
    const list = grouped.get(alias.record.skill_id) ?? []
    list.push(alias); grouped.set(alias.record.skill_id, list)
  }
  const choices = [...grouped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([skillId, list]) => {
    list.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    const label = skillAccessLabel(list[0])
    const pluginManaged = list.some(alias => alias.record.plugin_id !== undefined || isBuiltinPluginMember(alias.record))
    return { skillId, label, aliases: list.map(alias => alias.record.id), available: !pluginManaged, ...(pluginManaged ? { reason: 'plugin_user_managed' as const } : {}) }
  })
  const ids = parseSkillAccessQuery(query).skillIds
  const rows: SkillAccessRow[] = []
  for (const skillId of ids ?? []) {
    const list = grouped.get(skillId) ?? []
    const pluginManaged = list.some(alias => alias.record.plugin_id !== undefined || isBuiltinPluginMember(alias.record))
    for (const entry of manifest.entries) {
      if (pluginManaged) {
        rows.push({ skillId, subject: entry.subject, effective: null, reason: 'plugin_user_managed', aliases: [] })
        continue
      }
      const summaries = (entry.status === 'available' ? list : []).map(alias => ({ commandId: alias.record.id, active: alias.record.is_active !== false,
        invocable: alias.record.can_be_invoked_in_chat !== false,
        enabled: commandEnabledForAgent(alias.record as SlashCommandRow, entry.subject.id), source: source(alias) }))
      rows.push({ skillId, subject: entry.subject,
        effective: entry.status === 'available' && list.length ? summaries.some(alias => alias.enabled) : null,
        ...(entry.status !== 'available' ? { reason: entry.reason ?? 'subject_unavailable' } : !list.length ? { reason: 'skill_not_listed' } : {}), aliases: summaries })
    }
  }
  return freezeSkillAccess({ choices, rows })
}

/** Pure metadata reads only: no slash-command GET, seeding, filesystem or skill loader. */
export async function readSkillAccess(ctx: AdapterContext, query: SkillAccessQuery, manifest: SettingsSubjectManifest): Promise<SkillAccessRead> {
  ctx.assertCurrent()
  const userId = ctx.admission.actor.userId
  if (manifest.ownerUserId !== userId || manifest.entries.length > SKILL_ACCESS_LIMITS.subjects) refuseSkillAccess('SKILL_SUBJECTS_INVALID', 'The captured subjects are unavailable.')
  const known = manifest.entries.filter(entry => entry.status === 'available')
  for (const entry of known) if (!policyContainsSubject(ctx.admission.policy, entry.subject, ctx.admission.actor.kind === 'native' ? ctx.admission.actor.id : undefined)) {
    refuseSkillAccess('SUBJECT_NOT_GRANTED', 'A captured subject is outside the user grant.')
  }
  const initialLifecycle = captureSettingsLifecycle(known.flatMap(entry => [`agent:${entry.subject.id}`, `subagent:${entry.subject.id}`]))
  const revisionKey = slashCommandRevisionKey(userId)
  const captured = await redis.execute(async client => {
    let bytes = 0
    async function raw(key: string, paths: readonly string[], allowMissing = false) {
      ctx.assertCurrent()
      const answer = await client.eval(READ_SKILL_METADATA_SCRIPT, { keys: [key], arguments: [JSON.stringify(paths)] })
      ctx.assertCurrent()
      if (allowMissing && Array.isArray(answer) && answer[0] === 'MISSING') return paths.map(() => '')
      if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== paths.length + 1 || answer.slice(1).some(value => typeof value !== 'string')) {
        refuseSkillAccess('SKILL_METADATA_UNAVAILABLE', 'The saved skill or subject metadata is unavailable.')
      }
      const values = answer.slice(1) as string[]
      bytes += Buffer.byteLength(JSON.stringify(values), 'utf8') + Buffer.byteLength(key, 'utf8')
      if (bytes > SKILL_ACCESS_LIMITS.bytes) refuseSkillAccess('SKILL_METADATA_BUDGET', 'The complete skill metadata exceeds this operation budget.')
      return values
    }
    async function revision() {
      const value = await client.get(revisionKey)
      if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) refuseSkillAccess('SKILL_REVISION_UNAVAILABLE', 'The command revision is unreadable.')
      return value
    }
    const before = await revision()
    const keys = new Set<string>()
    let cursor = '0'
    do {
      ctx.assertCurrent()
      const page = await client.scan(cursor, { MATCH: `slash_command:${userId}:*`, COUNT: 512 })
      ctx.assertCurrent()
      cursor = page.cursor
      for (const key of page.keys) keys.add(key)
      if (keys.size > SKILL_ACCESS_LIMITS.commands) refuseSkillAccess('SKILL_CATALOGUE_BUDGET', 'The complete command catalogue exceeds 256 records.')
    } while (cursor !== '0')
    const aliases: SkillAlias[] = []
    for (const key of [...keys].sort()) {
      const values = await raw(key, SKILL_ALIAS_PATHS)
      const record = metadata(values, SKILL_ALIAS_PATHS)
      if (typeof record.id !== 'string' || key !== `slash_command:${userId}:${record.id}` || record.user_id !== userId || record.type !== 'skill' && record.type !== 'prompt') {
        refuseSkillAccess('SKILL_METADATA_UNAVAILABLE', 'A saved command has invalid identity metadata.')
      }
      aliases.push({ key, raw: values, record: record as SkillAlias['record'] })
    }
    let population: SkillAccessSnapshot['population'] = null
    let lifecycle = initialLifecycle
    const subjects: SkillSubjectSnapshot[] = []
    const knownKeys = new Set(known.map(entry => settingsSubjectKey(entry.subject)))
    // Available selected targets remain strict. An optional retention row cannot
    // downgrade, drop or retarget one of these managed subjects.
    for (const entry of known) {
      const subject = entry.subject
      const key = `${subject.kind === 'subagent' ? 'subagent' : 'agent'}:${subject.id}`
      const values = await raw(key, SKILL_SUBJECT_PATHS)
      const record = metadata(values, SKILL_SUBJECT_PATHS)
      if (!ownedSettingsRecord(subject, record, userId) || !settingsSubjectType(subject, record)) refuseSkillAccess('SKILL_SUBJECT_CHANGED', 'A captured subject changed; request a fresh report.')
      subjects.push({ key, subject, raw: values })
    }
    const namespace: SkillSubjectSnapshot[] = []
    const collidingIds = new Set<string>()
    for (const entry of known) {
      const subject = { kind: entry.subject.kind === 'subagent' ? 'primary' as const : 'subagent' as const, id: entry.subject.id }
      const key = `${subject.kind === 'subagent' ? 'subagent' : 'agent'}:${subject.id}`
      const values = await raw(key, SKILL_SUBJECT_PATHS, true)
      namespace.push({ key, subject, raw: values })
      if (values[0] && ownedSettingsRecord(subject, metadata(values, SKILL_SUBJECT_PATHS), userId)) collidingIds.add(subject.id)
    }
    if (ctx.admission.policy.scope.mode === 'all' && !ctx.admission.policy.scope.except.length) {
      // Complete retention is optional for ordinary rows, mandatory for conversion.
      // An unsupported/missing/oversized population remains explicitly unavailable;
      // the complete manifest (including unavailable rows) is returned unchanged.
      const beforePopulationBytes = bytes
      try {
        const [primary, subagent] = await Promise.all([client.sMembers(`user:${userId}:agents`), client.sMembers(`user:${userId}:subagents`)])
        ctx.assertCurrent()
        if (primary.length + subagent.length > SKILL_ACCESS_LIMITS.subjects) throw new Error('population_budget')
        const refs = new Map(known.map(entry => [settingsSubjectKey(entry.subject), entry.subject]))
        for (const [kind, ids] of [['primary', primary], ['subagent', subagent]] as const) for (const id of ids) {
          if (!isCanonicalAgentId(id)) throw new Error('population_identity')
          refs.set(`${kind}:${id}`, { kind, id })
        }
        assertSettingsLifecycle(initialLifecycle)
        const fullLifecycle = captureSettingsLifecycle([...refs.values()].flatMap(ref => [`agent:${ref.id}`, `subagent:${ref.id}`]))
        const retained: SkillSubjectSnapshot[] = []
        for (const subject of refs.values()) {
          if (knownKeys.has(settingsSubjectKey(subject))) continue
          const key = `${subject.kind === 'subagent' ? 'subagent' : 'agent'}:${subject.id}`
          const values = await raw(key, SKILL_SUBJECT_PATHS)
          const record = metadata(values, SKILL_SUBJECT_PATHS)
          if (!ownedSettingsRecord(subject, record, userId) || !settingsSubjectType(subject, record)) throw new Error('population_subject_unavailable')
          retained.push({ key, subject, raw: values })
        }
        ctx.assertCurrent(); assertSettingsLifecycle(fullLifecycle)
        population = { primary: [...primary].sort(), subagent: [...subagent].sort(), subjects: [...subjects, ...retained] }
        lifecycle = fullLifecycle
        subjects.push(...retained)
      } catch {
        // Cancellation, authority and actual selected-subject replacement still refuse.
        ctx.assertCurrent(); assertSettingsLifecycle(initialLifecycle)
        bytes = beforePopulationBytes
      }
    }
    if (await revision() !== before) refuseSkillAccess('SKILL_CATALOGUE_CHANGED', 'The skill catalogue changed during the read. Request a fresh report.')
    assertSettingsLifecycle(lifecycle)
    return { owner: userId, actor: actorKey(ctx), revision: before, aliases, manifest: structuredClone(manifest), subjects, namespace,
      collidingIds: [...collidingIds], population, lifecycle }
  })
  await ctx.refreshAuthority()
  ctx.assertCurrent()
  assertSettingsLifecycle(captured.lifecycle)
  assertSettingsLifecycle(initialLifecycle)
  const projected = projectSkillAccess(captured.aliases, query, captured.manifest)
  const handle = Object.freeze({ kind: 'skill-access-report' as const })
  snapshots.set(handle, freezeSkillAccess(captured))
  return freezeSkillAccess({ handle, ...projected })
}
