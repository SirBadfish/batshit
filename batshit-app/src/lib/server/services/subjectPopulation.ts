import { newSubjectToolSettings } from '$lib/utils/toolSettingsWriteRules'
import { acquireSettingsReplacementMutation, assertSettingsRecordReplacement, SettingsLifecycleRefusal } from './appActions/settings/lifecycle'
import { newSlashCommandRevision, slashCommandRevisionKey, SLASH_COMMAND_REVISION_LUA } from './slashCommandRevisionProtocol'
import { DELETE_AGENT_WITH_WHITEBOARDS_SCRIPT } from '$lib/server/whiteboardScripts'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import { AGENT_ID_PATTERN } from './agentIdRules'
import { admitPresetReferences, preparePresetReferences, PresetReferenceWriteError, PRESET_REFERENCE_GUARD_LUA } from './modelPresetReferenceGuard'
import { managedProfileId } from './managedProfileIdentity'
import { buildCliSubagentRuntimeId, resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { withProfileFolderTurns, advanceProfileFolderTurns, markProfileFoldersUncertain } from './agentProfileFolderQueue'

type PopulationClient = { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }
type Subject = { userId: string; subjectId: string }
export class SubjectPopulationError extends Error {
  readonly status: number
  readonly code: 'SUBJECT_POPULATION_CONFLICT' | 'SUBJECT_POPULATION_UNAVAILABLE' | 'SUBJECT_POPULATION_UNCONFIRMED'
  constructor(message: string, readonly uncertain = false, conflict = false) {
    super(message)
    this.status = uncertain ? 503 : conflict ? 409 : 500
    this.code = uncertain ? 'SUBJECT_POPULATION_UNCONFIRMED' : conflict ? 'SUBJECT_POPULATION_CONFLICT' : 'SUBJECT_POPULATION_UNAVAILABLE'
  }
}
function subjectKey(subject: Subject, kind: 'primary' | 'subagent', creating = false) {
  // New identities stay canonical. Human deletion retains exact legacy IDs; it
  // never normalizes them into another record, and Lua verifies id/owner again.
  if (typeof subject.subjectId !== 'string' || !subject.subjectId.length || !subject.subjectId.isWellFormed() ||
    creating && !AGENT_ID_PATTERN.test(subject.subjectId)) throw new Error('Invalid subject identity.')
  return `${kind === 'primary' ? 'agent' : 'subagent'}:${subject.subjectId}`
}
/** The deletion owner shares only these canonical folders; old preset aliases do not
 * provide a live profile writer. Population changes still serialize with folder deletion. */
function populationProfileId(kind: 'agent' | 'subagent', row: Record<string, unknown>): string {
  if (typeof row.id !== 'string' || !row.id || typeof row.user_id !== 'string' || !row.user_id ||
    kind === 'subagent' && row.slug != null && typeof row.slug !== 'string') throw new Error('The stored profile owner is unreadable.')
  return managedProfileId(kind === 'agent' ? row.id : buildCliSubagentRuntimeId(resolveSubagentSlug({
    id: row.id, slug: row.slug as string | null | undefined
  })))
}
const READ_SUBJECT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'OK', ''} end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'INVALID_RECORD'} end
return {'OK', redis.call('JSON.GET', KEYS[1], '$')}
`
export const CREATE_SUBJECT_POPULATION_SCRIPT = `
${SLASH_COMMAND_REVISION_LUA}
${PRESET_REFERENCE_GUARD_LUA}
if not presetReferencesAvailable(ARGV[7]) then return 'PRESET_REFERENCE_CHANGED' end
local revision = command_revision(KEYS[3])
if revision == nil or not valid_command_nonce(ARGV[6]) then return 'INVALID_REVISION' end
-- Access lists name IDs without a kind (BL-187); check the opposite namespace
-- inside the same physical boundary, not only in the route's earlier read.
if not KEYS[4] then return 'INVALID_INPUT' end
if redis.call('EXISTS', KEYS[4]) ~= 0 then return 'CROSS_KIND_CONFLICT' end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'INVALID_INDEX' end
local valid, record = pcall(cjson.decode, ARGV[2])
if not valid or type(record) ~= 'table' or record.id ~= ARGV[3] or record.user_id ~= ARGV[4] then return 'INVALID_INPUT' end
if type(record.provider_specific_settings) ~= 'table' or type(record.provider_specific_settings.nativeTools) ~= 'table' or type(record.provider_specific_settings.nativeTools.typedFileToolsEnabled) ~= 'boolean' or type(record.provider_specific_settings.nativeTools.artifactRuntimeEnabled) ~= 'boolean' then return 'INVALID_INPUT' end
if ARGV[5] ~= 'create' and ARGV[5] ~= 'replace-owned' then return 'INVALID_INPUT' end
local existing = ''
if redis.call('EXISTS', KEYS[1]) == 1 then
  local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID_RECORD' end
  existing = redis.call('JSON.GET', KEYS[1], '$')
  local old = cjson.decode(existing)[1]
  if old.id ~= ARGV[3] or old.user_id ~= ARGV[4] then return 'FORBIDDEN' end
end
if existing ~= ARGV[1] or (ARGV[5] == 'create' and existing ~= '') then return 'CONFLICT' end
-- All fallible ownership, input and container checks precede this boundary.
redis.call('SET', KEYS[3], ARGV[6])
local saved = redis.pcall('JSON.SET', KEYS[1], '$', ARGV[2])
if type(saved) ~= 'table' or saved.ok ~= 'OK' then return 'PARTIAL' end
if type(redis.pcall('SADD', KEYS[2], ARGV[3])) ~= 'number' then return 'PARTIAL' end
return existing == '' and 'CREATED' or 'REPLACED'
`
export const DELETE_SUBAGENT_POPULATION_SCRIPT = `
${SLASH_COMMAND_REVISION_LUA}
local revision = command_revision(KEYS[3])
if revision == nil or not valid_command_nonce(ARGV[3]) then return 'INVALID_REVISION' end
if revision ~= ARGV[4] then return 'CONFLICT' end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'INVALID_INDEX' end
local exists = redis.call('EXISTS', KEYS[1]) == 1
if exists then
  local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID_RECORD' end
  local record = cjson.decode(redis.call('JSON.GET', KEYS[1], '$'))[1]
  if record.id ~= ARGV[1] or record.user_id ~= ARGV[2] then return 'FORBIDDEN' end
end
if not exists and redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return 'MISSING' end
redis.call('SET', KEYS[3], ARGV[3])
if type(redis.pcall('SREM', KEYS[2], ARGV[1])) ~= 'number' then return 'PARTIAL' end
if exists and redis.pcall('DEL', KEYS[1]) ~= 1 then return 'PARTIAL' end
return exists and 'DELETED' or 'MISSING'
`
function complete(answer: unknown, lease: ReturnType<typeof acquireSettingsReplacementMutation>, allowed: readonly string[]): string {
  if (typeof answer === 'string' && allowed.includes(answer)) { lease.settle(); return answer }
  if (typeof answer === 'string' && ['CONFLICT', 'FORBIDDEN', 'INVALID_RECORD', 'INVALID_REVISION', 'INVALID_INDEX', 'INVALID_INPUT', 'INVALID_WHITEBOARD', 'CROSS_KIND_CONFLICT'].includes(answer)) {
    lease.settle()
    throw new SubjectPopulationError(answer === 'INVALID_WHITEBOARD' ? 'A Whiteboard owner could not be verified. This final subject and Whiteboard deletion step was refused.' : 'The subject population changed or is unreadable. This step did not change its record or membership; earlier cleanup may already have completed.', false, answer === 'CONFLICT' || answer === 'CROSS_KIND_CONFLICT')
  }
  lease.unknown()
  throw new SubjectPopulationError('The subject save or deletion may have reached storage. Check the saved state before another change; replacement remains held while settlement is unknown.', true)
}

export async function createSubjectPopulation<T extends { id: string; user_id: string; provider_specific_settings?: unknown }>(client: PopulationClient, subject: Subject & {
  kind: 'primary' | 'subagent'; mode: 'create' | 'replace-owned'; record: T
}): Promise<{ status: 'CREATED' | 'REPLACED'; record: T }> {
  const key = subjectKey(subject, subject.kind, true)
  const record = JSON.stringify({ ...subject.record, provider_specific_settings: newSubjectToolSettings(subject.record.provider_specific_settings) })
  // One payload owns the physical write and its reference proof across awaits.
  subject = { ...subject, record: JSON.parse(record) }
  const referencePreparation = preparePresetReferences(subject.kind, subject.record)
  const revisionKey = slashCommandRevisionKey(subject.userId)
  const nextRevision = newSlashCommandRevision()
  assertSettingsRecordReplacement(key)
  try {
    const before = await client.eval(READ_SUBJECT, { keys: [key], arguments: [] })
    if (!Array.isArray(before) || before[0] !== 'OK' || typeof before[1] !== 'string') throw new Error('The existing subject record is unreadable.')
    const kind = subject.kind === 'primary' ? 'agent' : 'subagent'
    const oldRecord = before[1] ? JSON.parse(before[1])[0] as Record<string, unknown> : undefined
    const profiles = [populationProfileId(kind, subject.record), ...(oldRecord ? [populationProfileId(kind, oldRecord)] : [])]
    return await withProfileFolderTurns(profiles, async () => {
      assertSettingsRecordReplacement(key)
      await assertOriginalPopulation(client, key, before[1])
      const lease = acquireSettingsReplacementMutation(key)
      let references: Awaited<ReturnType<typeof admitPresetReferences>> | undefined
      let issued = false
      let answer: unknown
      try {
        references = await admitPresetReferences(subject.userId, subject.kind,
          { key, record: oldRecord ?? {}, paths: [] }, subject.record, referencePreparation)
        const command = { keys: [key, `user:${subject.userId}:${subject.kind === 'primary' ? 'agents' : 'subagents'}`, revisionKey, `${subject.kind === 'primary' ? 'subagent' : 'agent'}:${subject.subjectId}`],
          arguments: [before[1], record, subject.subjectId, subject.userId, subject.mode, nextRevision, references.guard] }
        lease.check(); references.check()
        advanceProfileFolderTurns(profiles)
        issued = true
        answer = await issuePopulation(profiles, () => client.eval(CREATE_SUBJECT_POPULATION_SCRIPT, command))
      } catch (error) {
        if (issued) { lease.unknown(); references?.unknown() } else { lease.settle(); references?.settle() }
        if (!issued && (error instanceof SettingsLifecycleRefusal || error instanceof PresetReferenceWriteError)) throw error
        throw new SubjectPopulationError(issued ? 'The subject save may have reached storage. Check the saved state before another change; replacement remains held while settlement is unknown.' : error instanceof Error ? error.message : 'The existing subject could not be read.', issued)
      }
      if (answer === 'PRESET_REFERENCE_CHANGED') {
        lease.settle(); references!.settle(); throw new PresetReferenceWriteError('changed')
      }
      if (typeof answer === 'string' && ['CREATED', 'REPLACED', 'CONFLICT', 'FORBIDDEN', 'INVALID_RECORD', 'INVALID_REVISION', 'INVALID_INDEX', 'INVALID_INPUT', 'CROSS_KIND_CONFLICT'].includes(answer)) references!.settle()
      else references!.unknown()
      const status = complete(answer, lease, ['CREATED', 'REPLACED']) as 'CREATED' | 'REPLACED'
      return { status, record: subject.record }
    })
  } catch (error) {
    if (error instanceof SubjectPopulationError || error instanceof SettingsLifecycleRefusal || error instanceof PresetReferenceWriteError) throw error
    throw new SubjectPopulationError(error instanceof Error ? error.message : 'The existing subject could not be read.')
  }
}

function expectedCatalogueRevision(value: unknown): string {
  if (value === null) return ''
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new SubjectPopulationError('The exact skill cleanup revision is unavailable. The final subject record and membership step was not issued.', false, true)
  return value
}

export async function deleteSubagentPopulation(client: PopulationClient, subject: Subject & { expectedCatalogueRevision: string | null }): Promise<'DELETED' | 'MISSING'> {
  const key = subjectKey(subject, 'subagent')
  const expected = expectedCatalogueRevision(subject.expectedCatalogueRevision)
  const revisionKey = slashCommandRevisionKey(subject.userId)
  const nextRevision = newSlashCommandRevision()
  assertSettingsRecordReplacement(key)
  try {
    const original = await populationProfiles(client, key, 'subagent', subject)
    const profiles = original.profiles
    const command = { keys: [key, `user:${subject.userId}:subagents`, revisionKey], arguments: [subject.subjectId, subject.userId, nextRevision, expected] }
    return await withProfileFolderTurns(profiles, async () => {
      assertSettingsRecordReplacement(key)
      await assertOriginalPopulation(client, key, original.raw)
      const lease = acquireSettingsReplacementMutation(key)
      let issued = false
      let answer: unknown
      try {
        lease.check()
        advanceProfileFolderTurns(profiles)
        issued = true
        answer = await issuePopulation(profiles, () => client.eval(DELETE_SUBAGENT_POPULATION_SCRIPT, command))
      } catch (error) {
        if (issued) lease.unknown(); else lease.settle()
        if (!issued && error instanceof SettingsLifecycleRefusal) throw error
        throw new SubjectPopulationError(issued ? 'The Subagent deletion may have reached storage. Check the saved state before another change; replacement remains held while settlement is unknown.' : 'The Subagent deletion ended before issue.', issued)
      }
      return complete(answer, lease, ['DELETED', 'MISSING']) as 'DELETED' | 'MISSING'
    })
  } catch (error) {
    if (error instanceof SubjectPopulationError || error instanceof SettingsLifecycleRefusal) throw error
    throw new SubjectPopulationError('The Subagent deletion ended before issue.')
  }
}

export async function deletePrimaryPopulation(client: PopulationClient, subject: Subject & { expectedCatalogueRevision: string | null }): Promise<'DELETED' | 'MISSING'> {
  const key = subjectKey(subject, 'primary')
  const expected = expectedCatalogueRevision(subject.expectedCatalogueRevision)
  const revisionKey = slashCommandRevisionKey(subject.userId)
  const nextRevision = newSlashCommandRevision()
  assertSettingsRecordReplacement(key)
  try {
    const original = await populationProfiles(client, key, 'agent', subject)
    const profiles = original.profiles
    const command = { keys: [key, `${key}:subagents`, `user:${subject.userId}:agents`, revisionKey],
      arguments: [subject.subjectId, subject.userId, `whiteboard:*:${escapeRedisGlob(subject.subjectId)}`, nextRevision, expected] }
    return await withProfileFolderTurns(profiles, async () => {
      assertSettingsRecordReplacement(key)
      await assertOriginalPopulation(client, key, original.raw)
      const lease = acquireSettingsReplacementMutation(key)
      let issued = false
      let answer: unknown
      try {
        lease.check()
        advanceProfileFolderTurns(profiles)
        issued = true
        answer = await issuePopulation(profiles, () => client.eval(DELETE_AGENT_WITH_WHITEBOARDS_SCRIPT, command))
      } catch (error) {
        if (issued) lease.unknown(); else lease.settle()
        if (!issued && error instanceof SettingsLifecycleRefusal) throw error
        throw new SubjectPopulationError(issued ? 'The Primary Agent deletion may have reached storage. Check the saved state before another change; replacement remains held while settlement is unknown.' : 'The Primary Agent deletion ended before issue.', issued)
      }
      return complete(answer, lease, ['DELETED', 'MISSING']) as 'DELETED' | 'MISSING'
    })
  } catch (error) {
    if (error instanceof SubjectPopulationError || error instanceof SettingsLifecycleRefusal) throw error
    throw new SubjectPopulationError('The Primary Agent deletion ended before issue.')
  }
}

async function populationProfiles(client: PopulationClient, key: string, kind: 'agent' | 'subagent', subject: Subject) {
  const before = await client.eval(READ_SUBJECT, { keys: [key], arguments: [] })
  if (!Array.isArray(before) || before[0] !== 'OK' || typeof before[1] !== 'string') throw new Error('The subject profile mapping is unreadable.')
  const row = before[1] ? JSON.parse(before[1])[0] : { id: subject.subjectId, user_id: subject.userId }
  if (row.id !== subject.subjectId || row.user_id !== subject.userId) throw new Error('The subject profile owner changed.')
  return { raw: before[1] as string, profiles: [populationProfileId(kind, row)] }
}

async function assertOriginalPopulation(client: PopulationClient, key: string, original: string): Promise<void> {
  const current = await client.eval(READ_SUBJECT, { keys: [key], arguments: [] })
  if (!Array.isArray(current) || current[0] !== 'OK' || current[1] !== original) {
    throw new SubjectPopulationError('The original subject record changed while its profile turn was queued. This step was not issued.', false, true)
  }
}

async function issuePopulation(profiles: string[], issue: () => Promise<unknown>): Promise<unknown> {
  try {
    const answer = await issue()
    if (typeof answer !== 'string' || !['CREATED', 'REPLACED', 'DELETED', 'MISSING', 'PRESET_REFERENCE_CHANGED',
      'CONFLICT', 'FORBIDDEN', 'INVALID_RECORD', 'INVALID_REVISION', 'INVALID_INDEX', 'INVALID_INPUT', 'INVALID_WHITEBOARD', 'CROSS_KIND_CONFLICT'].includes(answer)) markProfileFoldersUncertain(profiles)
    return answer
  } catch (error) { markProfileFoldersUncertain(profiles); throw error }
}
