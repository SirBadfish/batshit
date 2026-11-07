import { isCanonicalAgentId } from '$lib/utils/agentId'
import { redis } from '$lib/server/redis'
import { createHash } from 'node:crypto'
import { publishUserEvent } from '$lib/server/ssePublisher'
import {
  APP_ACTIONS_POLICY_REFRESH_FAMILY, APP_ACTIONS_PORTABLE_REFRESH_EVENT, APP_ACTIONS_PORTABLE_MAX_LIFETIME_MS,
  defaultAppActionsPolicy, parseAppActionsPolicy, parseAppActionsPortableGrant,
  type AppActionsNativePolicyResponse, type AppActionsPortableGrantResponse, type AppActionsSubjectChoice,
  type AppActionsNativePolicyRecord, type AppActionsPortableGrant, type AppActionsPolicy
} from '$lib/appActions/settings/managementContract'
import { settingsSubjectKey, reportObject, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { ownedSettingsRecord, settingsSubjectType, settingsSubjectLabel } from './subjects'
import { acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './lifecycle'

export class AppActionsManagementRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message); this.name = 'AppActionsManagementRefusal' }
}
export function validAuthorityGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
}
export type AppActionsAuthorityFence = { key: string; paths: Array<[string, string]>; lifecycle?: SettingsLifecycleSnapshot }
const READ_AUTHORITY_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'MISSING'} end
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return out
`
async function readAuthoritySnapshot(key: string, paths: string[]) {
  const lifecycle = captureSettingsLifecycle([key])
  const answer = await redis.execute(client => client.eval(READ_AUTHORITY_SCRIPT, { keys: [key], arguments: [JSON.stringify(paths)] }))
  assertSettingsLifecycle(lifecycle)
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== paths.length + 1) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The current authority is unavailable.', 409)
  const values: unknown[] = []
  const fence: AppActionsAuthorityFence = { key, paths: [], lifecycle }
  for (let i = 0; i < paths.length; i++) {
    const raw = answer[i + 1]
    if (typeof raw !== 'string') throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The current authority is unreadable.', 409)
    const parsed = raw === '' ? [] : JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length > 1) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The current authority is unreadable.', 409)
    values.push(parsed[0])
    fence.paths.push([paths[i], raw])
  }
  return { values, fence }
}
export function readNativePolicy(value: unknown): AppActionsNativePolicyRecord | null {
  if (value === undefined || value === null) return null
  const record = reportObject(value, ['generation', 'policy'])
  if (!validAuthorityGeneration(record.generation) || record.generation < 1) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The saved App Actions policy is unreadable.', 409)
  return { generation: record.generation, policy: parseAppActionsPolicy(record.policy) }
}
export function policyContainsSubject(policy: AppActionsPolicy, subject: SettingsSubjectRef, actorAgentId?: string): boolean {
  if (!policy.enabled || subject.kind !== 'primary' && subject.kind !== 'subagent') return false
  const key = settingsSubjectKey(subject)
  if (policy.scope.except.some(ref => settingsSubjectKey(ref) === key)) return false
  return policy.scope.mode === 'all' || policy.scope.mode === 'self' && subject.kind === 'primary' && subject.id === actorAgentId ||
    policy.scope.mode === 'selected' && policy.scope.subjects.some(ref => settingsSubjectKey(ref) === key)
}
function assertTokenId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new AppActionsManagementRefusal('INVALID_ID', 'Invalid agent or token identifier.', 400)
}
export async function appActionsSubjectChoices(userId: string): Promise<AppActionsSubjectChoice[]> {
  return redis.execute(async client => {
    const [agents, subagents] = await Promise.all([client.sMembers(`user:${userId}:agents`), client.sMembers(`user:${userId}:subagents`)])
    if (agents.length + subagents.length > 256) throw new AppActionsManagementRefusal('SUBJECT_LIMIT', 'There are more than 256 agents. Use a narrower explicitly selected scope.', 409)
    const choices: AppActionsSubjectChoice[] = []
    for (const [kind, ids] of [['primary', agents], ['subagent', subagents]] as const) {
      for (const id of [...ids].sort()) {
        if (typeof id !== 'string' || !id.isWellFormed()) throw new AppActionsManagementRefusal('SUBJECT_INDEX_UNAVAILABLE', 'The agent index is unreadable.', 409)
        const subject = { kind, id }
        const record = await client.json.get(`${kind === 'primary' ? 'agent' : 'subagent'}:${id}`)
        const owned = ownedSettingsRecord(subject, record, userId)
        const type = owned ? settingsSubjectType(subject, record) : undefined
        const reason = !isCanonicalAgentId(id) ? 'unsupported_subject_id' as const : !owned ? 'subject_unavailable' as const : !type ? 'unsupported_subject_type' as const : undefined
        choices.push({ subject, type: type ?? 'unknown', available: reason === undefined,
          label: settingsSubjectLabel(subject, owned ? record.displayName : undefined), ...(reason ? { reason } : {}) })
      }
    }
    return choices
  })
}
export async function readNativePolicyAuthority(userId: string, agentId: string) {
  if (!isCanonicalAgentId(agentId)) throw new AppActionsManagementRefusal('INVALID_ID', 'Invalid agent identifier.', 400)
  const snapshot = await readAuthoritySnapshot(`agent:${agentId}`, ['$.id', '$.user_id', '$.agentType', '$.app_action_policy', '$.created_at'])
  if (snapshot.values[0] !== agentId || snapshot.values[1] !== userId || snapshot.values[2] !== 'api') {
    throw new AppActionsManagementRefusal('AGENT_NOT_OWNED', 'That live Primary Agent is unavailable.', 404)
  }
  if (typeof snapshot.values[4] !== 'string' || !snapshot.values[4]) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The agent identity is unreadable.', 409)
  const subjectRevision = `sha256:${createHash('sha256').update(JSON.stringify([snapshot.fence.lifecycle,
    snapshot.fence.paths.filter(([path]) => path !== '$.app_action_policy')])).digest('hex')}`
  return { key: snapshot.fence.key, raw: snapshot.fence.paths[3][1], record: readNativePolicy(snapshot.values[3]), fence: snapshot.fence, subjectRevision }
}
export async function nativePolicyResponse(userId: string, agentId: string): Promise<AppActionsNativePolicyResponse> {
  const authority = await readNativePolicyAuthority(userId, agentId)
  return { success: true, agentId, generation: authority.record?.generation ?? 0, subjectRevision: authority.subjectRevision,
    policy: authority.record?.policy ?? defaultAppActionsPolicy(), subjects: await appActionsSubjectChoices(userId) }
}
export const SAVE_NATIVE_APP_ACTIONS_POLICY_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'MISSING' end
local row = cjson.decode(redis.call('JSON.GET', KEYS[1], '$'))[1]
if row.id ~= ARGV[1] or row.user_id ~= ARGV[2] or row.agentType ~= 'api' then return 'FORBIDDEN' end
if (redis.call('JSON.GET', KEYS[1], '$.app_action_policy') or '') ~= ARGV[3] then return 'CONFLICT' end
if (redis.call('JSON.GET', KEYS[1], '$.created_at') or '') ~= ARGV[6] or (redis.call('JSON.GET', KEYS[1], '$.agentType') or '') ~= ARGV[7] then return 'CONFLICT' end
local policy = cjson.decode(ARGV[4])
if type(policy) ~= 'table' or type(policy.generation) ~= 'number' or policy.generation < 1 then return 'INVALID' end
redis.call('JSON.SET', KEYS[1], '$.app_action_policy', ARGV[4])
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[5])
return 'OK'
`
export async function saveNativePolicy(userId: string, agentId: string, input: unknown): Promise<AppActionsNativePolicyResponse> {
  const body = reportObject(input, ['expectedGeneration', 'expectedSubjectRevision', 'policy'])
  if (!validAuthorityGeneration(body.expectedGeneration)) throw new AppActionsManagementRefusal('INVALID_GENERATION', 'Reload the current policy before saving.', 400)
  let policy: AppActionsPolicy
  try { policy = parseAppActionsPolicy(body.policy) }
  catch { throw new AppActionsManagementRefusal('INVALID_POLICY', 'Choose a valid App Actions policy.', 400) }
  if (body.expectedGeneration >= Number.MAX_SAFE_INTEGER - 1) throw new AppActionsManagementRefusal('GENERATION_EXHAUSTED', 'This authority generation cannot be advanced.', 409)
  const authority = await readNativePolicyAuthority(userId, agentId)
  if ((authority.record?.generation ?? 0) !== body.expectedGeneration || body.expectedSubjectRevision !== authority.subjectRevision) throw new AppActionsManagementRefusal('POLICY_CONFLICT', 'The agent identity or policy changed. Reload it before saving.', 409)
  const record = { generation: body.expectedGeneration + 1, policy }
  const lifecycle = await policySubjectLifecycle(userId, policy, [authority.key])
  assertSettingsLifecycle(authority.fence.lifecycle!)
  const answer = await writeInSettingsLifecycle(lifecycle, client => client.eval(SAVE_NATIVE_APP_ACTIONS_POLICY_SCRIPT, {
    keys: [authority.key], arguments: [agentId, userId, authority.raw, JSON.stringify(record), JSON.stringify(new Date().toISOString()),
      authority.fence.paths.find(([path]) => path === '$.created_at')![1], authority.fence.paths.find(([path]) => path === '$.agentType')![1]]
  }))
  if (answer !== 'OK') throw new AppActionsManagementRefusal('POLICY_CONFLICT', 'The agent or policy changed; the policy was not saved.', 409)
  await publishUserEvent(userId, { type: 'agent_settings_changed', agentId, family: APP_ACTIONS_POLICY_REFRESH_FAMILY })
  try { return await nativePolicyResponse(userId, agentId) }
  catch { throw new AppActionsManagementRefusal('AUTHORITY_SAVED_READBACK_UNAVAILABLE', 'The policy was saved, but its current readback is unavailable. Check the saved policy before another change.', 503) }
}
export async function readPortableAppActionsAuthority(userId: string, tokenId: string, requireEnabled = true) {
  assertTokenId(tokenId)
  const key = `portable_skill_token:${userId}:${tokenId}`
  const snapshot = await readAuthoritySnapshot(key, ['$.id', '$.userId', '$.revokedAt', '$.families', '$.authorityGeneration', '$.appActionsGrant', '$.label'])
  const [id, owner, revokedAt, families, savedGeneration, savedGrant, label] = snapshot.values
  if (id !== tokenId || owner !== userId || revokedAt !== null || !Array.isArray(families) ||
    requireEnabled && !families.includes('app-actions')) throw new AppActionsManagementRefusal('TOKEN_NOT_ALLOWED', 'This token does not have App Actions authority.')
  const generation = savedGeneration === undefined ? 0 : savedGeneration
  if (!validAuthorityGeneration(generation)) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'The token authority is unreadable.', 409)
  const grant = parseAppActionsPortableGrant(savedGrant ?? null)
  if (requireEnabled && (!grant?.policy.enabled || Date.parse(grant.expiresAt) <= Date.now())) throw new AppActionsManagementRefusal('GRANT_EXPIRED_OR_DISABLED', 'The token App Actions grant is disabled or expired.')
  // Label is presentation only; an execution stamp or label edit does not revoke authority.
  snapshot.fence.paths.pop()
  return { key, generation, grant, hasAppActionsFamily: families.includes('app-actions'), fence: snapshot.fence, label: typeof label === 'string' ? label.slice(0, 80) : 'Portable token' }
}
export async function portableGrantResponse(userId: string, tokenId: string): Promise<AppActionsPortableGrantResponse> {
  const current = await readPortableAppActionsAuthority(userId, tokenId, false)
  return { success: true, tokenId, authorityGeneration: current.generation, grant: current.grant, subjects: await appActionsSubjectChoices(userId) }
}
export const SAVE_PORTABLE_APP_ACTIONS_GRANT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'MISSING' end
local row = cjson.decode(redis.call('JSON.GET', KEYS[1], '$'))[1]
if row.id ~= ARGV[1] or row.userId ~= ARGV[2] or row.revokedAt ~= cjson.null then return 'FORBIDDEN' end
local generation = row.authorityGeneration
if generation == nil then generation = 0 end
if type(generation) ~= 'number' or generation < 0 or generation ~= math.floor(generation) or generation >= 9007199254740991 or generation ~= tonumber(ARGV[3]) then return 'CONFLICT' end
local families = {}
for _, family in ipairs(row.families or {}) do if family ~= 'app-actions' then families[#families + 1] = family end end
if ARGV[4] ~= 'null' then families[#families + 1] = 'app-actions' end
local encoded = #families > 0 and cjson.encode(families) or '[]'
redis.call('JSON.SET', KEYS[1], '$.families', encoded)
redis.call('JSON.SET', KEYS[1], '$.appActionsGrant', ARGV[4])
redis.call('JSON.SET', KEYS[1], '$.authorityGeneration', ARGV[5])
redis.call('JSON.SET', KEYS[1], '$.updatedAt', ARGV[6])
return 'OK'
`
export async function savePortableGrant(userId: string, tokenId: string, input: unknown): Promise<AppActionsPortableGrantResponse> {
  const body = reportObject(input, ['expectedAuthorityGeneration', 'grant'])
  if (!validAuthorityGeneration(body.expectedAuthorityGeneration)) throw new AppActionsManagementRefusal('INVALID_GENERATION', 'Reload the token before saving.', 400)
  const expectedAuthorityGeneration = body.expectedAuthorityGeneration
  let grant: AppActionsPortableGrant | null
  try { grant = parseAppActionsPortableGrant(body.grant) }
  catch { throw new AppActionsManagementRefusal('INVALID_GRANT', 'Choose a valid explicit App Actions subject grant and expiry.', 400) }
  if (expectedAuthorityGeneration >= Number.MAX_SAFE_INTEGER - 1) throw new AppActionsManagementRefusal('GENERATION_EXHAUSTED', 'This authority generation cannot be advanced.', 409)
  if (grant && (Date.parse(grant.expiresAt) <= Date.now() || Date.parse(grant.expiresAt) > Date.now() + APP_ACTIONS_PORTABLE_MAX_LIFETIME_MS)) {
    throw new AppActionsManagementRefusal('INVALID_EXPIRY', 'Choose an expiry within the next 30 days.', 400)
  }
  const current = await readPortableAppActionsAuthority(userId, tokenId, false)
  const lifecycle = grant ? await policySubjectLifecycle(userId, grant.policy, [current.key]) : current.fence.lifecycle!
  assertSettingsLifecycle(current.fence.lifecycle!)
  const answer = await writeInSettingsLifecycle(lifecycle, client => client.eval(SAVE_PORTABLE_APP_ACTIONS_GRANT_SCRIPT, {
    keys: [current.key], arguments: [tokenId, userId, String(expectedAuthorityGeneration), JSON.stringify(grant), String(expectedAuthorityGeneration + 1), JSON.stringify(new Date().toISOString())]
  }))
  if (answer !== 'OK') throw new AppActionsManagementRefusal('GRANT_CONFLICT', 'The token authority changed; the grant was not saved.', 409)
  await publishUserEvent(userId, { type: APP_ACTIONS_PORTABLE_REFRESH_EVENT, tokenId, authorityGeneration: expectedAuthorityGeneration + 1 })
  try { return await portableGrantResponse(userId, tokenId) }
  catch { throw new AppActionsManagementRefusal('AUTHORITY_SAVED_READBACK_UNAVAILABLE', 'The grant was saved, but its current readback is unavailable. Check the saved access before another change.', 503) }
}

function subjectRecordKey(subject: SettingsSubjectRef) { return `${subject.kind === 'primary' ? 'agent' : 'subagent'}:${subject.id}` }
async function policySubjectLifecycle(userId: string, policy: AppActionsPolicy, keys: string[]) {
  const subjects = [...policy.scope.subjects, ...policy.scope.except]
  const lifecycle = captureSettingsLifecycle([...keys, ...subjects.map(subjectRecordKey)])
  for (const subject of subjects) {
    const row = await redis.json.get(subjectRecordKey(subject))
    if (!ownedSettingsRecord(subject, row, userId) || !settingsSubjectType(subject, row)) {
      throw new AppActionsManagementRefusal('SUBJECT_UNAVAILABLE', 'A selected subject is no longer available. Reload the current agents.', 409)
    }
  }
  assertSettingsLifecycle(lifecycle)
  return lifecycle
}
async function writeInSettingsLifecycle<T>(lifecycle: SettingsLifecycleSnapshot, write: (client: { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }) => Promise<T>): Promise<T> {
  return redis.execute(async client => {
    const lease = acquireSettingsMutation(lifecycle)
    try { const answer = await write(client); lease.settle(); return answer }
    catch { lease.unknown(); throw new AppActionsManagementRefusal('AUTHORITY_SAVE_UNCONFIRMED', 'The authority save may have reached storage. Reload before making another change; replacement is held while settlement is unknown.', 503) }
  })
}

/** Delete only shrinks explicitly selected grants. An exclusion never silently
 * disappears and a reused ID cannot inherit a selected subject's old grant. */
export async function sweepAppActionsSubjectReferences(userId: string, subject: SettingsSubjectRef): Promise<void> {
  const [agents, tokens] = await Promise.all([
    redis.sMembers(`user:${userId}:agents`), redis.sMembers(`portable_skill_tokens:${userId}`)
  ])
  const subjectKey = settingsSubjectKey(subject)
  for (const [kind, ids] of [['native', agents], ['portable', tokens]] as const) {
    for (const id of ids) {
      if (kind === 'native' && subject.kind === 'primary' && id === subject.id) continue
      const key = kind === 'native' ? `agent:${id}` : `portable_skill_token:${userId}:${id}`
      for (let attempt = 0; attempt < 3; attempt++) {
        const path = kind === 'native' ? '$.app_action_policy' : '$.appActionsGrant'
        const snapshot = await readAuthoritySnapshot(key, [path, kind === 'native' ? '$.user_id' : '$.userId', '$.authorityGeneration'])
        if (snapshot.values[1] !== userId) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'An App Actions grant could not be checked before deletion.', 409)
        const saved = kind === 'native' ? readNativePolicy(snapshot.values[0]) : parseAppActionsPortableGrant(snapshot.values[0] ?? null)
        if (!saved) break
        const policy = saved.policy
        if (!policy.scope.subjects.some(ref => settingsSubjectKey(ref) === subjectKey)) break
        const nextPolicy = { ...policy, scope: { ...policy.scope, subjects: policy.scope.subjects.filter(ref => settingsSubjectKey(ref) !== subjectKey) } }
        const generation = kind === 'native' ? (saved as AppActionsNativePolicyRecord).generation : snapshot.values[2] ?? 0
        if (!validAuthorityGeneration(generation) || generation >= Number.MAX_SAFE_INTEGER - 1) throw new AppActionsManagementRefusal('AUTHORITY_UNAVAILABLE', 'An App Actions generation could not be advanced before deletion.', 409)
        const next = kind === 'native' ? { generation: generation + 1, policy: nextPolicy } : { ...(saved as AppActionsPortableGrant), policy: nextPolicy }
        const answer = await writeInSettingsLifecycle(snapshot.fence.lifecycle!, client => client.eval(`
if (redis.call('JSON.GET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 'CONFLICT' end
if ARGV[4] ~= '' and (redis.call('JSON.GET', KEYS[1], '$.authorityGeneration') or '') ~= ARGV[4] then return 'CONFLICT' end
redis.call('JSON.SET', KEYS[1], ARGV[1], ARGV[3])
if ARGV[4] ~= '' then redis.call('JSON.SET', KEYS[1], '$.authorityGeneration', ARGV[5]) end
return 'OK'`, { keys: [key], arguments: [path, snapshot.fence.paths[0][1], JSON.stringify(next),
          kind === 'portable' ? snapshot.fence.paths[2][1] : '', String(generation + 1)] }))
        if (answer === 'OK') {
          await publishUserEvent(userId, kind === 'native' ? { type: 'agent_settings_changed', agentId: id, family: APP_ACTIONS_POLICY_REFRESH_FAMILY } :
            { type: APP_ACTIONS_PORTABLE_REFRESH_EVENT, tokenId: id, authorityGeneration: generation + 1 })
          break
        }
        if (attempt === 2) throw new AppActionsManagementRefusal('GRANT_CONFLICT', 'An App Actions grant changed during deletion. Retry deletion.', 409)
      }
    }
  }
}
