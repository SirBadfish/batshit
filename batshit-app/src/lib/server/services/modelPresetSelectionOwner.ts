import { redis } from '$lib/server/redis'
import type { SavedModel } from '$lib/types/savedModels'
import type { CatalogConnectionOption } from '$lib/types/modelCatalog'
import { apiKeyService } from '$lib/services/apiKey.server'
import { env } from '$env/dynamic/private'
import { PROVIDER_KEY_CONFIG } from './providers'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import type { LocalAiServerId } from '$lib/types/localAi'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { getModelPresetAvailability } from '$lib/utils/modelPresetAvailability'
import { resolveModelVoiceSessionConfig, normalizeModelVoiceSessionConfig, LIVEKIT_SPEECH_TO_SPEECH_PROVIDER_PLAN } from '$lib/utils/modelVoiceSession'
import type { AgentVoicePresetSelection } from '$lib/utils/modelVoiceSession'
import { readOwnedVoicePresetFallbackSources as readVoicePresetFallbackSources } from '$lib/server/modelVoiceSelectionSource'
import { inferModelPurpose } from '$lib/utils/modelPurpose'
import { buildConnectionOptions } from './modelConnectionOptions'
import { CODEX_CLI_RETIRED_ERROR, RETIRED_CODEX_CLI_PROVIDER_IDS, CLAUDE_CLI_PRESET_REFUSAL, namesClaudeCliModel } from '$lib/utils/cliRuntimeIdentity'
import { MODEL_SETTING_KEY_LUA, CHECK_MODEL_SELECTION_LUA } from '$lib/server/modelSelectionGuard'
import type { OriginalModelSelectionCut } from './appActions/settings/modelSelectionAdapter'
import { readStoredLocalAiServer } from './localAiServers'
import { readStoredCustomProvider } from './customProviders'
import { readCatalogCacheSnapshot } from './vercelModelCatalog'
import { buildSavedModelCatalogLookup, gatewayListsCatalogRow, resolveCatalogConnectionId } from './savedModelCatalogMatch'
import { chatgptPlanConnectionOptions } from './chatgptPlanCatalog'
import { claudePlanConnectionOptions } from './claudePlanCatalog'
import { assertClaudePlanIdentity, assertClaudePlanModel, assertClaudePlanPresetSettings, ClaudePlanError, claudePlanConfigurationReadiness } from './claudePlanAdmission'
import { isClaudePlanSelection } from '$lib/utils/claudePlanConnection'
import { pausedPlanStatuses, PAUSED_PLANS_DEV_SWITCH_KEY } from './pausedPlans'
import {
  captureSettingsLifecycle, assertSettingsLifecycle, acquireSettingsReplacementMutation, acquireSettingsMutation, withSettingsRecordReplacement,
  SettingsLifecycleRefusal, type SettingsLifecycleSnapshot
} from './appActions/settings/lifecycle'
import { randomBytes } from 'node:crypto'
import { planModelPresetCopy, presetCopyParameters } from './modelManagerHelpers'
import { assertPresetCopyDestinationUnreferenced } from './modelPresetReferenceGuard'
import { isPresetParameterFact, isModelSelectionVoiceFacts, type ModelSelectionVoiceFacts, type ModelPresetCopyChanges, type ModelPresetCopyOutcome } from '$lib/appActions/settings/modelSelectionPreferences'
import type { AppActionsAuthorityFence } from './appActions/settings/authority'

export type ModelPresetCheck = { key: string; storage?: 'json' | 'string'; paths: readonly (readonly [path: string, raw: string])[] }
export type ModelPresetMembership = { key: string; member: string; present: true }
export type ModelPresetSelectionChoice = {
  id: string; label: string; connection: { id: string; transport: string; service: string | null } | null
  purpose: string; available: boolean; reason: string | null
  voiceSession?: ModelSelectionVoiceFacts
  compatibility?: readonly { kind: 'agent' | 'subagent'; id: string; available: boolean; reason: string | null }[]
}
export type OwnedModelPresetDependency = {
  preset: SavedModel; lifecycle: SettingsLifecycleSnapshot; checks: readonly ModelPresetCheck[]
  membership: ModelPresetMembership; memberships: readonly ModelPresetMembership[]
}
export type OwnedModelPresetSelection = OwnedModelPresetDependency & { choice: ModelPresetSelectionChoice }
export const MODEL_PRESET_SELECTION_LIMIT = 20
const MAX_SELECTION_BYTES = 131072
export const MODEL_PRESET_SELECTION_SOURCE_FIELDS = ['id', 'modelName', 'modelId', 'provider', 'effectiveModelId', 'catalogModelId', 'vercelSourceId',
  'isVercelImport', 'purpose', 'purposeOverride', 'settings', 'capabilities', 'compatibility', 'connection', 'voiceSession', 'unavailableReason'] as const

export class ModelPresetUnavailableError extends Error {
  readonly code = 'model_preset_unavailable'
  readonly status = 409
  constructor(message = 'This saved model preset is unavailable. Reload Settings → Models before selecting it.') { super(message); this.name = 'ModelPresetUnavailableError' }
}
export class ModelPresetStorageError extends Error {
  readonly code: 'MODEL_PRESET_CONFLICT' | 'MODEL_PRESET_UNCONFIRMED' | 'MODEL_PRESET_UNAVAILABLE'
  readonly status: number
  constructor(message: string, readonly uncertain = false, conflict = false) {
    super(message); this.name = 'ModelPresetStorageError'
    this.status = uncertain ? 503 : conflict ? 409 : 500
    this.code = uncertain ? 'MODEL_PRESET_UNCONFIRMED' : conflict ? 'MODEL_PRESET_CONFLICT' : 'MODEL_PRESET_UNAVAILABLE'
  }
}
function exactId(value: string) {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || value.includes('\0')) throw new ModelPresetUnavailableError()
  return value
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}

/** One atomic owned snapshot; raw JSON text is retained verbatim for the issue CAS. */
export const READ_MODEL_PRESET_SCRIPT = `
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'set' then return {'INVALID_INDEX'} end
local member = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 0 then return {'OK', tostring(member), ''} end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'INVALID_RECORD'} end
local raw = redis.call('JSON.GET', KEYS[1], '$')
if ARGV[2] and #raw > tonumber(ARGV[2]) then return {'TOO_LARGE'} end
local record = cjson.decode(raw)[1]
if record.id ~= ARGV[1] then return {'INVALID_RECORD'} end
return {'OK', tostring(member), raw}
`
export async function readModelPresetStorage(userId: string, presetId: string, maxBytes?: number) {
  const id = exactId(presetId)
  const answer = await redis.execute(client => client.eval(READ_MODEL_PRESET_SCRIPT,
    { keys: [`model:${id}`, `user:${userId}:models`], arguments: [id, ...(maxBytes ? [String(maxBytes)] : [])] }))
  if (!Array.isArray(answer) || answer[0] !== 'OK' || typeof answer[1] !== 'string' || !['0', '1'].includes(answer[1]) || typeof answer[2] !== 'string') {
    throw new ModelPresetStorageError('The saved model preset or its ownership index is unreadable.')
  }
  const raw = answer[2] as string
  const decoded = raw ? JSON.parse(raw) : null
  return { raw, present: answer[1] === '1', preset: decoded?.[0] as SavedModel | null }
}

/** Physical writer. Its caller must first enter this exact model's replacement fence. */
export const MUTATE_MODEL_PRESET_SCRIPT = `
${MODEL_SETTING_KEY_LUA}
local function copy_target_current(target)
  local KEYS = {target.key}
  local modelSelection = target.guard
  ${CHECK_MODEL_SELECTION_LUA}
  return 'OK'
end
local copyDeadline = nil
-- Only the fixed A12 owner can supply this private original-source admission.
if ARGV[5] and ARGV[5] ~= '' then
  local proof = cjson.decode(ARGV[5])
  copyDeadline = proof.deadline
  local clock = redis.call('TIME')
  if tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000) >= proof.deadline then return 'CONFLICT' end
  if #proof.targets == 0 then return 'CONFLICT' end
  for _, target in ipairs(proof.targets) do
    local valid, result = pcall(copy_target_current, target)
    if not valid or result ~= 'OK' then return 'CONFLICT' end
  end
  for _, index in ipairs(proof.references.indexes) do
    local shape = redis.call('TYPE', index.key).ok
    if shape ~= 'none' and shape ~= 'set' then return 'CONFLICT' end
    if redis.call('SCARD', index.key) ~= #index.ids then return 'CONFLICT' end
    local ids = redis.call('SMEMBERS', index.key)
    table.sort(ids)
    for position, id in ipairs(ids) do if index.ids[position] ~= id then return 'CONFLICT' end end
  end
  for _, target in ipairs(proof.references.targets) do
    for _, pair in ipairs(target.paths) do
      local raw = redis.pcall('JSON.GET', target.key, pair[1])
      if raw == false or raw == nil then raw = '' end
      if type(raw) ~= 'string' or raw ~= pair[2] then return 'CONFLICT' end
    end
  end
  if redis.call('TYPE', proof.index).ok ~= 'set' or redis.call('SISMEMBER', proof.index, proof.id) ~= 1 then return 'CONFLICT' end
  for _, membership in ipairs(proof.memberships) do
    if redis.call('TYPE', membership.key).ok ~= 'set' or redis.call('SISMEMBER', membership.key, membership.member) ~= 1 then return 'CONFLICT' end
  end
  for _, check in ipairs(proof.checks) do
    for _, pair in ipairs(check.paths) do
      local raw = check.storage == 'string' and redis.pcall('GET', check.key) or redis.pcall('JSON.GET', check.key, pair[1])
      if raw == false or raw == nil then raw = '' end
      if type(raw) ~= 'string' or raw ~= pair[2] then return 'CONFLICT' end
    end
  end
end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'INVALID_INDEX' end
local member = redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
local current = ''
if redis.call('EXISTS', KEYS[1]) ~= 0 then
  local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID_RECORD' end
  current = redis.call('JSON.GET', KEYS[1], '$')
  if cjson.decode(current)[1].id ~= ARGV[1] then return 'INVALID_RECORD' end
end
if ARGV[3] ~= 'create' and (not member or current == '') then return 'MISSING' end
if ARGV[3] == 'create' then
  if current ~= '' or member then return 'EXISTS' end
elseif ARGV[3] ~= 'update' and ARGV[3] ~= 'backfill' and ARGV[3] ~= 'delete' then return 'INVALID_INPUT' end
if current ~= ARGV[2] then return 'CONFLICT' end
if ARGV[3] ~= 'delete' then
  local valid, record = pcall(cjson.decode, ARGV[4])
  if not valid or type(record) ~= 'table' or record.id ~= ARGV[1] then return 'INVALID_INPUT' end
  if copyDeadline then
    local clock = redis.call('TIME')
    if tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000) >= copyDeadline then return 'CONFLICT' end
  end
  local saved = redis.pcall('JSON.SET', KEYS[1], '$', ARGV[4], ARGV[3] == 'create' and 'NX' or 'XX')
  if type(saved) ~= 'table' or saved.ok ~= 'OK' then return 'PARTIAL' end
  if ARGV[3] == 'create' and type(redis.pcall('SADD', KEYS[2], ARGV[1])) ~= 'number' then return 'PARTIAL' end
  return 'SAVED'
end
if type(redis.pcall('SREM', KEYS[2], ARGV[1])) ~= 'number' then return 'PARTIAL' end
if redis.pcall('DEL', KEYS[1]) ~= 1 then return 'PARTIAL' end
return 'DELETED'
`
export async function mutateModelPresetStorage(userId: string, presetId: string, expectedRaw: string,
  mode: 'create' | 'update' | 'backfill' | 'delete', record?: SavedModel, copy?: PresetCopyIssue): Promise<'SAVED' | 'DELETED' | 'MISSING' | 'EXISTS' | 'CONFLICT'> {
  const id = exactId(presetId)
  const encoded = mode === 'delete' ? '' : JSON.stringify(record)
  if (mode !== 'delete' && (!record || record.id !== id)) throw new ModelPresetStorageError('Invalid saved model preset.')
  return redis.execute(async client => {
    const lease = acquireSettingsReplacementMutation(`model:${id}`)
    const leases = [lease]
    let issued = false, known = false
    try {
      lease.check()
      const copyProof = copy ? copyIssueProof(copy, userId, id, mode, encoded) : ''
      if (copy) {
        // Destination drain is complete. Enroll the held original incarnations
        // synchronously before issue; identical replacements must also wait.
        for (const target of copyIssues.get(copy)!.targets) {
          leases.push(acquireSettingsMutation(target.lifecycle))
          for (const source of target.sources) leases.push(acquireSettingsMutation(source.lifecycle))
        }
      }
      issued = true
      if (copy) copyIssued(copy)
      const answer = await client.eval(MUTATE_MODEL_PRESET_SCRIPT, { keys: [`model:${id}`, `user:${userId}:models`],
        arguments: [id, expectedRaw, mode, encoded, copyProof] })
      if (typeof answer === 'string' && ['SAVED', 'DELETED', 'MISSING', 'EXISTS', 'CONFLICT'].includes(answer)) {
        known = true
        if (answer === 'SAVED' && copy) copyKnownSaved(copy)
        else if (copy) copyNotSaved(copy)
        return answer as 'SAVED' | 'DELETED' | 'MISSING' | 'EXISTS' | 'CONFLICT'
      }
      if (typeof answer === 'string' && ['INVALID_INDEX', 'INVALID_RECORD', 'INVALID_INPUT'].includes(answer)) {
        known = true
        if (copy) copyNotSaved(copy)
        throw new ModelPresetStorageError('The saved model preset changed or is unreadable. Nothing was saved.', false, true)
      }
      throw new ModelPresetStorageError('The model preset change may have reached storage. Its outcome is unknown; do not repeat it.', true)
    } catch (error) {
      if (error instanceof ModelPresetStorageError) throw error
      if (!issued && error instanceof SettingsLifecycleRefusal) throw error
      throw new ModelPresetStorageError(issued ? 'The model preset change may have reached storage. Its outcome is unknown; do not repeat it.' : 'The model preset change was not issued.', issued)
    } finally { for (const owned of leases) { if (issued && !known) owned.unknown(); else owned.settle() } }
  })
}

/** Opaque process-local original/plan/issue handles; serialized lookalikes confer no custody. */
export type PresetCopySource = Readonly<{ readonly presetCopySource: unique symbol }>
type CopySource = { userId: string; raw: string; preset: SavedModel; lifecycle: SettingsLifecycleSnapshot }
const copySources = new WeakMap<PresetCopySource, CopySource>()
export type PreparedPresetCopy = Readonly<{ readonly preparedPresetCopy: unique symbol }>
type CopyPlan = { source: CopySource; attempted: boolean; selections: Map<'api', OwnedModelPresetSelection>; candidate: SavedModel; encoded: string; review: ReturnType<typeof planModelPresetCopy>['review']; outcome: ModelPresetCopyOutcome }
const copyPlans = new WeakMap<PreparedPresetCopy, CopyPlan>()
type PresetCopyIssue = Readonly<{ readonly presetCopyIssue: unique symbol }>
const copyIssues = new WeakMap<PresetCopyIssue, { plan: CopyPlan; check(): void; deadlineAt: number; authority: AppActionsAuthorityFence; targets: readonly OriginalModelSelectionCut[];
  references?: Awaited<ReturnType<typeof assertPresetCopyDestinationUnreferenced>> }>()
const createdCopies = new WeakMap<PreparedPresetCopy, { lifecycle: SettingsLifecycleSnapshot; lease: ReturnType<typeof acquireSettingsMutation> }>()
function sourceFor(handle: PresetCopySource) {
  const source = copySources.get(handle)
  if (!source) throw new ModelPresetUnavailableError('The original copy source is unavailable.')
  assertSettingsLifecycle(source.lifecycle)
  return source
}
function planFor(handle: PreparedPresetCopy) {
  const plan = copyPlans.get(handle)
  if (!plan) throw new ModelPresetUnavailableError('The held copy plan is unavailable.')
  return plan
}
export async function captureModelPresetCopySource(userId: string, presetId: string) {
  const lifecycle = captureSettingsLifecycle([`model:${exactId(presetId)}`])
  const stored = await readModelPresetStorage(userId, presetId, MAX_SELECTION_BYTES)
  assertSettingsLifecycle(lifecycle)
  if (!stored.present || !stored.preset) throw new ModelPresetUnavailableError()
  // A faithful detached copy refuses literals JS would alter. Unknown/custom fields stay private.
  const preset = JSON.parse(stored.raw, (_key, value, context?: { source?: string }) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || !context?.source || JSON.stringify(value) !== context.source)) throw new ModelPresetUnavailableError('This preset contains a numeric literal that cannot be copied faithfully.')
    return value
  })?.[0] as SavedModel
  if (!preset || preset.id !== presetId || typeof preset.modelName !== 'string' || typeof preset.provider !== 'string' || typeof preset.modelId !== 'string' ||
    (preset.purpose ?? inferModelPurpose({ id: preset.catalogModelId ?? `${preset.provider}/${preset.modelId}`, name: preset.modelId ?? preset.modelName })) !== 'chat' || preset.voiceSession ||
    preset.settings != null && (typeof preset.settings !== 'object' || Array.isArray(preset.settings))) throw new ModelPresetUnavailableError('Choose an owned nonvoice chat preset with readable settings.')
  // SA-139 R5: a copy of a leftover Claude Code CLI preset would be a new one, and none is made.
  if (namesClaudeCliModel({ primary_model_provider: preset.provider, primary_model_name: preset.modelId, primary_model_connection: preset.connection })) {
    throw new ModelPresetUnavailableError(CLAUDE_CLI_PRESET_REFUSAL)
  }
  const handle = Object.freeze({}) as PresetCopySource
  copySources.set(handle, { userId, raw: stored.raw, preset: freeze(structuredClone(preset)), lifecycle })
  return handle
}
export function modelPresetCopyChoices(handle: PresetCopySource) {
  const { preset } = sourceFor(handle)
  return { sourcePresetId: preset.id, sourceName: preset.modelName.slice(0, 200), parameters: presetCopyParameters(preset).map(field => {
    const fact = Object.hasOwn(preset.settings ?? {}, field.name) ? preset.settings?.[field.name] === null ? { state: 'null' } : { state: 'set', value: structuredClone(preset.settings![field.name]) } : { state: 'unset' }
    return { name: field.name, label: field.label, type: field.inputType, ...(field.options ? { options: field.options } : {}),
      ...(field.min !== undefined ? { minimum: field.min } : {}), ...(field.max !== undefined ? { maximum: field.max } : {}),
      stored: isPresetParameterFact(fact) ? fact : { state: 'unavailable', reason: 'stored_parameter_unreadable' } }
  }) }
}
export function prepareModelPresetCopy(handle: PresetCopySource, changes: ModelPresetCopyChanges) {
  const source = sourceFor(handle)
  const { candidate, review } = planModelPresetCopy(source.preset, changes, randomBytes(16).toString('hex'))
  const now = new Date().toISOString()
  candidate.createdAt = now; candidate.updatedAt = now
  const encoded = JSON.stringify(candidate)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SELECTION_BYTES) throw new ModelPresetUnavailableError('The complete copy is too large.')
  const plan = Object.freeze({}) as PreparedPresetCopy
  copyPlans.set(plan, { source, attempted: false, selections: new Map(), candidate: freeze(candidate), encoded, review: freeze(review), outcome: {
    presetId: candidate.id, name: candidate.modelName, creation: 'not_requested', source: 'not_requested', assignment: 'not_started' } })
  return plan
}
export function modelPresetCopyPlan(handle: PreparedPresetCopy) {
  const plan = planFor(handle)
  return { candidate: structuredClone(plan.candidate), review: structuredClone(plan.review), outcome: structuredClone(plan.outcome) }
}
export async function assertModelPresetCopySource(handle: PreparedPresetCopy) {
  const { source } = planFor(handle)
  assertSettingsLifecycle(source.lifecycle)
  const current = await readModelPresetStorage(source.userId, source.preset.id, MAX_SELECTION_BYTES)
  assertSettingsLifecycle(source.lifecycle)
  if (!current.present || current.raw !== source.raw) throw new ModelPresetUnavailableError('The original preset changed. Request a new copy review.')
}
export async function readModelPresetCopySelection(handle: PreparedPresetCopy, mode: 'api') {
  const plan = planFor(handle)
  await assertModelPresetCopySource(handle)
  const source = await readOwnedModelPresetSelection(plan.source.userId, plan.source.preset.id, mode)
  await assertModelPresetCopySource(handle)
  if (JSON.stringify(source.lifecycle) !== JSON.stringify(plan.source.lifecycle)) throw new ModelPresetUnavailableError()
  plan.selections.set(mode, source)
  return source
}
function copyIssueProof(handle: PresetCopyIssue, userId: string, id: string, mode: string, encoded: string) {
  const issue = copyIssues.get(handle)
  if (!issue || !issue.references || mode !== 'create' || issue.plan.source.userId !== userId || issue.plan.candidate.id !== id || encoded !== issue.plan.encoded) throw new ModelPresetUnavailableError()
  issue.check(); assertSettingsLifecycle(issue.plan.source.lifecycle)
  if (issue.authority.lifecycle) assertSettingsLifecycle(issue.authority.lifecycle)
  for (const target of issue.targets) {
    assertSettingsLifecycle(target.lifecycle)
    target.sources.forEach(source => assertSettingsLifecycle(source.lifecycle))
  }
  if (Date.now() >= issue.deadlineAt) throw new ModelPresetUnavailableError('The copy operation ended before issue.')
  const targetSources = issue.targets.flatMap(target => target.sources)
  return JSON.stringify({ deadline: issue.deadlineAt, targets: issue.targets.map(target => ({ key: target.key, guard: target.guard })), references: issue.references, index: `user:${userId}:models`, id: issue.plan.source.preset.id,
    memberships: [...issue.plan.selections.values()].flatMap(source => source.memberships).concat(targetSources.flatMap(source => source.memberships ?? [source.membership])),
    checks: [{ key: `model:${issue.plan.source.preset.id}`, paths: [['$', issue.plan.source.raw]] },
      ...[...issue.plan.selections.values()].flatMap(source => source.checks), ...targetSources.flatMap(source => source.checks), issue.authority] })
}
function copyKnownSaved(handle: PresetCopyIssue) {
  const issue = copyIssues.get(handle)!
  issue.plan.outcome.creation = 'saved'
  issue.plan.outcome.source = 'unavailable'
  delete issue.plan.outcome.reason
}
function copyIssued(handle: PresetCopyIssue) {
  const plan = copyIssues.get(handle)!.plan
  plan.outcome.creation = 'unknown'; plan.outcome.reason = 'copy_creation_pending_do_not_repeat'
}
function copyNotSaved(handle: PresetCopyIssue) {
  const plan = copyIssues.get(handle)!.plan
  plan.outcome.creation = 'not_requested'; plan.outcome.reason = 'copy_not_created'
}
/** One fixed conditional create, with a synchronous actual post-replacement generation handoff. */
export async function createModelPresetCopy(handle: PreparedPresetCopy, admission: { check(): void; deadlineAt: number; authority: AppActionsAuthorityFence; targets: readonly OriginalModelSelectionCut[] }) {
  const plan = planFor(handle)
  if (plan.attempted) throw new ModelPresetUnavailableError('This copy creation cannot be replayed.')
  if (!admission.targets.length) throw new ModelPresetUnavailableError('A copy requires an executable original target cut.')
  const targets = Object.freeze([...admission.targets])
  const check = () => {
    admission.check(); assertSettingsLifecycle(plan.source.lifecycle)
    for (const target of targets) { assertSettingsLifecycle(target.lifecycle); target.sources.forEach(source => assertSettingsLifecycle(source.lifecycle)) }
  }
  check()
  plan.attempted = true
  const sourceLease = acquireSettingsMutation(plan.source.lifecycle)
  const issue = Object.freeze({}) as PresetCopyIssue
  copyIssues.set(issue, { plan, ...admission, targets, check })
  try {
    await withSettingsRecordReplacement(`model:${plan.candidate.id}`, async () => {
      // Existing reference writers enroll before issue. The replacement drains prior uses
      // and refuses new uses, including unchanged dangling historical references.
      copyIssues.get(issue)!.references = await redis.execute(client => assertPresetCopyDestinationUnreferenced(client, plan.source.userId, plan.candidate.id,
        check))
      check()
      const result = await mutateModelPresetStorage(plan.source.userId, plan.candidate.id, '', 'create', plan.candidate, issue)
      if (result !== 'SAVED') throw new ModelPresetUnavailableError('The copy identity or original source changed. Nothing was copied.')
    }, (_value, lifecycle) => {
      // No await occurs between publication generation and taking its mutation custody.
      createdCopies.set(handle, { lifecycle, lease: acquireSettingsMutation(lifecycle) })
      plan.outcome.source = 'confirmed'
    })
  } catch (error) {
    if (error instanceof ModelPresetStorageError && error.uncertain) { plan.outcome.creation = 'unknown'; sourceLease.unknown() }
    else sourceLease.settle()
    plan.outcome.assignment = 'blocked'
    plan.outcome.reason = plan.outcome.creation === 'saved' ? 'saved_copy_source_unavailable' : plan.outcome.creation === 'unknown' ? 'copy_creation_unknown_do_not_repeat' : 'copy_not_created'
    throw error
  } finally { copyIssues.delete(issue); if (plan.outcome.creation !== 'unknown') sourceLease.settle() }
}
export async function readCreatedModelPresetSelection(handle: PreparedPresetCopy, mode: 'api') {
  const plan = planFor(handle), created = createdCopies.get(handle)
  try {
    if (!created || plan.outcome.creation !== 'saved' || plan.outcome.source !== 'confirmed') throw new ModelPresetUnavailableError('The actual copy source handoff is unavailable.')
    created.lease.check()
    const source = await readOwnedModelPresetSelection(plan.source.userId, plan.candidate.id, mode)
    created.lease.check()
    if (JSON.stringify(source.lifecycle) !== JSON.stringify(created.lifecycle) || JSON.stringify(source.preset) !== plan.encoded) throw new ModelPresetUnavailableError('The created copy changed before assignment.')
    return source
  } catch (error) {
    if (plan.outcome.creation === 'saved') { plan.outcome.source = 'unavailable'; plan.outcome.reason = 'saved_copy_source_unavailable' }
    throw error
  }
}
export function finishModelPresetCopy(handle: PreparedPresetCopy, assignment: ModelPresetCopyOutcome['assignment']) {
  const plan = planFor(handle)
  plan.outcome.assignment = assignment
  createdCopies.get(handle)?.lease.settle(); createdCopies.delete(handle)
}

export async function readOwnedModelPresetDependency(userId: string, presetId: string): Promise<OwnedModelPresetDependency> {
  const id = exactId(presetId)
  const lifecycle = captureSettingsLifecycle([`model:${id}`])
  const stored = await readModelPresetStorage(userId, id)
  if (!stored.present || !stored.preset) throw new ModelPresetUnavailableError('This model preset is no longer in your saved models.')
  if (typeof stored.preset.modelId !== 'string' || typeof stored.preset.provider !== 'string' ||
    typeof stored.preset.modelName !== 'string') throw new ModelPresetUnavailableError('The saved model preset cannot be read for selection.')
  const rawFields = await redis.execute(async client => {
    // The final issue also compares the original root: these fixed leaf reads
    // describe selection inputs without serializing a different RedisJSON form.
    const values: Array<readonly [string, string]> = []
    for (const field of MODEL_PRESET_SELECTION_SOURCE_FIELDS) values.push([`$.${field}`, await client.sendCommand(['JSON.GET', `model:${id}`, `$.${field}`]) as string ?? ''])
    return values
  })
  if (rawFields.reduce((sum, [, raw]) => sum + raw.length, 0) > MAX_SELECTION_BYTES) throw new ModelPresetUnavailableError('This preset is too large for model selection.')
  const after = await readModelPresetStorage(userId, id)
  if (!after.present || after.raw !== stored.raw) throw new ModelPresetUnavailableError('This model preset changed while it was being read. Try a fresh selection.')
  assertSettingsLifecycle(lifecycle)
  const membership: ModelPresetMembership = { key: `user:${userId}:models`, member: id, present: true }
  return freeze({ preset: structuredClone(stored.preset), lifecycle, membership, memberships: [membership],
    checks: [{ key: `model:${id}`, paths: rawFields }] })
}

/** A10's fixed owned metadata cut uses this owner's id/index/lifecycle invariants and the
 * actual UI matchers. No eligibility, key, catalog/status, settings-root or profile effect. */
export async function readOwnedVoicePresetFallbackSources(userId: string, selection: AgentVoicePresetSelection, exactPresetId?: string) {
  return redis.execute(client => readVoicePresetFallbackSources(client, userId, selection, exactPresetId))
}

/** SA-139 R5: a leftover Claude Code CLI preset is never assigned; nothing runs it any more. The
 * selection read and a save that names a new preset (`modelSelectionWriteBasis` in `redis.ts`) both
 * refuse it here. */
export function assertNotClaudeCliPreset(preset: SavedModel) {
  if (namesClaudeCliModel({ primary_model_provider: preset.provider, primary_model_name: preset.modelId, primary_model_connection: resolveSavedModelConnection(preset) })) {
    throw new ModelPresetUnavailableError(CLAUDE_CLI_PRESET_REFUSAL)
  }
}

export type ModelPresetSelectionMode = 'api' | 'api-primary'
export async function readOwnedModelPresetSelection(userId: string, presetId: string, mode: ModelPresetSelectionMode = 'api'): Promise<OwnedModelPresetSelection> {
  const source = await readOwnedModelPresetDependency(userId, presetId)
  const preset = source.preset
  const connection = resolveSavedModelConnection(preset)
  const checks: ModelPresetCheck[] = [...source.checks]
  const memberships = [...source.memberships]
  const extras: NonNullable<Parameters<typeof buildConnectionOptions>[1]> = {}
  const availability: Record<string, { hasKey: boolean; source: 'user' | 'env' | null }> = {}
  let gatewayReady = false
  let options: CatalogConnectionOption[]
  const service = connection.type === 'vercel-gateway' ? 'ai_gateway' : connection.type === 'openrouter' ? 'openrouter' : connection.service ?? ''
  // SA-139 R1: a preset on the removed Codex CLI connection is never assigned.
  if (RETIRED_CODEX_CLI_PROVIDER_IDS.has(service)) throw new ModelPresetUnavailableError(`${CODEX_CLI_RETIRED_ERROR} Choose another preset.`)
  assertNotClaudeCliPreset(preset)
  if (service === 'chatgpt-plan') {
    options = chatgptPlanConnectionOptions(userId)
  } else if (isClaudePlanSelection(connection)) {
    // SA-139: the Claude plan's own admission rules decide; no API key, catalog or Claude Code status
    // is read here (configuration only). Every run is admitted again, live.
    try { assertClaudePlanIdentity(connection); assertClaudePlanPresetSettings(preset.settings, assertClaudePlanModel(preset.modelId)) }
    catch (error) { if (error instanceof ClaudePlanError) throw new ModelPresetUnavailableError(error.message); throw error }
    const readiness = claudePlanConfigurationReadiness()
    if (readiness.state !== 'ready') throw new ModelPresetUnavailableError(readiness.reason)
    options = claudePlanConnectionOptions({ ...readiness, installed: true })
  } else {
    if (LOCAL_AI_SERVER_IDS.has(service as LocalAiServerId)) {
      const stored = await readStoredLocalAiServer(userId, service as LocalAiServerId)
      extras.localServers = [stored.summary]
      checks.push({ key: stored.key, paths: [['$', stored.raw]] })
      const keyState = await apiKeyService.readStoredState(service, userId)
      checks.push({ key: apiKeyService.storedKeyName(service, userId), paths: [['$', keyState.raw]] })
      if (keyState.state === 'unreadable') throw new ModelPresetUnavailableError('The saved key for this Local AI connection cannot be read. Re-enter it in Settings → API Keys.')
    } else if (service.startsWith('custom_')) {
      const stored = await readStoredCustomProvider(userId, service)
      if (!stored) throw new ModelPresetUnavailableError('This custom provider is no longer configured.')
      extras.customProviders = [stored.summary]
      checks.push({ key: stored.key, paths: [['$', stored.raw]] }); memberships.push(stored.membership)
    } else {
      const stored = await apiKeyService.readStoredState(service, userId)
      checks.push({ key: apiKeyService.storedKeyName(service, userId), paths: [['$', stored.raw]] })
      if (stored.state === 'unreadable') throw new ModelPresetUnavailableError('The saved key for this connection cannot be read. Re-enter it in Settings → API Keys.')
      const config = PROVIDER_KEY_CONFIG.find(entry => entry.id === service)
      const variables: (keyof typeof env)[] = service === 'ai_gateway' ? ['AI_GATEWAY_API_KEY'] : config ? [config.envVar] : []
      if (service === 'fal') variables.push('FAL_KEY')
      if (service === 'stepfun') variables.push('STEP_API_KEY')
      if (service === 'huggingface') variables.push('HUGGINGFACE_API_KEY', 'HF_TOKEN')
      const savedReady = stored.state === 'readable' && Boolean(stored.value)
      const environmentReady = variables.some(name => Boolean(env[name]))
      const ready = savedReady || environmentReady
      availability[service] = { hasKey: ready, source: savedReady ? 'user' : environmentReady ? 'env' : null }
      gatewayReady = service === 'ai_gateway' && ready
    }
    // Read and recheck the exact switch around the existing paused-plan owner.
    const pausedRaw = await redis.json.getRaw(PAUSED_PLANS_DEV_SWITCH_KEY, '$') ?? ''
    extras.pausedPlans = await pausedPlanStatuses()
    if ((await redis.json.getRaw(PAUSED_PLANS_DEV_SWITCH_KEY, '$') ?? '') !== pausedRaw) throw new ModelPresetUnavailableError('Plan availability changed during selection.')
    checks.push({ key: PAUSED_PLANS_DEV_SWITCH_KEY, paths: [['$', pausedRaw]] })
    options = buildConnectionOptions({ apiKeys: {}, availability, gateway: { availability: { hasKey: gatewayReady, source: gatewayReady ? 'user' : null } } } as never, extras)
  }
  const resolvedId = resolveCatalogConnectionId(connection)
  const exactOptions = options.filter(option => option.id === resolvedId && option.transport === connection.type &&
    (connection.type !== 'direct' || option.service === connection.service))
  if (exactOptions.length !== 1) throw new ModelPresetUnavailableError('The saved model connection cannot be resolved exactly.')
  if (connection.type === 'vercel-gateway') {
    const catalog = await readCatalogCacheSnapshot()
    const match = catalog.payload ? buildSavedModelCatalogLookup(catalog.payload.models)(preset) : null
    const exactListed = (row: typeof match) => {
      const variant = row?.idVariants?.['vercel-gateway']
      return gatewayListsCatalogRow(row) && (variant ? variant.effectiveId === preset.effectiveModelId &&
        variant.developerId === preset.provider && variant.modelId === preset.modelId : row?.source === 'vercel' &&
        row.provider === preset.provider && row.name === preset.modelId && `${row.provider}/${row.name}` === preset.effectiveModelId)
    }
    if (!exactListed(match)) throw new ModelPresetUnavailableError('Vercel AI Gateway no longer lists this exact model identifier.')
    if (catalog.kind === 'json') {
      const index = catalog.payload!.models.indexOf(match!)
      const path = `$.models[${index}]`
      const raw = await redis.json.getRaw('vercel:model_catalog:v1', path)
      if (!raw || raw.length > MAX_SELECTION_BYTES) throw new ModelPresetUnavailableError('The selected cached catalogue row is unavailable for selection.')
      const decoded = JSON.parse(raw)
      const row = Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : null
      if (!row || !buildSavedModelCatalogLookup([row])(preset) || !exactListed(row)) throw new ModelPresetUnavailableError('The cached catalogue changed during selection.')
      checks.push({ key: 'vercel:model_catalog:v1', paths: [[path, raw]] })
    } else {
      if (catalog.raw.length > 2097152) throw new ModelPresetUnavailableError('The legacy cached catalogue is too large for this selection. Refresh the Model Catalog in Settings first.')
      checks.push({ key: 'vercel:model_catalog:v1', storage: 'string', paths: [['', catalog.raw]] })
    }

  }
  const purpose = preset.purpose ?? inferModelPurpose({ id: preset.catalogModelId ?? `${preset.provider}/${preset.modelId}`, name: preset.modelId ?? preset.modelName })
  const voice = resolveModelVoiceSessionConfig(preset)
  let voiceSession: ModelSelectionVoiceFacts | undefined
  if (voice) {
    if (mode !== 'api-primary') throw new ModelPresetUnavailableError('Speech-to-speech presets are supported only for Primary configuration.')
    // Keep the real resolver's top-level/settings/inferred precedence. An invalid
    // explicit declaration cannot silently become a supported inferred preset.
    for (const raw of [preset.voiceSession, preset.settings?.voiceSession]) {
      if (raw != null && (!raw || typeof raw !== 'object' || Array.isArray(raw) || !normalizeModelVoiceSessionConfig(raw))) throw new ModelPresetUnavailableError('The voice-session metadata is unreadable.')
      if (raw != null) {
        const fields = Object.fromEntries(Object.entries(raw))
        if (['requiresLiveKit', 'locksVoiceModeSettings', 'nodeSupport', 'pythonSupport'].some(key => fields[key] !== undefined && typeof fields[key] !== 'boolean') ||
          ['providerId', 'providerLabel', 'adapterId', 'defaultModelId', 'defaultVoiceId'].some(key => fields[key] !== undefined && (typeof fields[key] !== 'string' || !fields[key].isWellFormed())) ||
          fields.includes !== undefined && (!fields.includes || typeof fields.includes !== 'object' || Array.isArray(fields.includes) ||
            Object.values(fields.includes).some(value => typeof value !== 'boolean'))) throw new ModelPresetUnavailableError('The voice-session metadata is unreadable.')
      }
    }
    const plan = LIVEKIT_SPEECH_TO_SPEECH_PROVIDER_PLAN.find(plan => plan.providerId === voice.providerId && plan.supportStatus === 'supported')
    const configuredProvider = normalizeModelVoiceSessionConfig({ runtime: 'livekit', mode: 'speech-to-speech', providerId: connection.service ?? preset.provider })?.providerId
    const facts = { runtime: voice.runtime, mode: voice.mode, providerId: voice.providerId, adapterId: voice.adapterId,
      supportStatus: voice.supportStatus, locksVoiceModeSettings: voice.locksVoiceModeSettings }
    if (!plan || voice.adapterId !== plan.adapterId || connection.type !== 'direct' || configuredProvider !== voice.providerId || !isModelSelectionVoiceFacts(facts)) throw new ModelPresetUnavailableError('This voice preset has no supported exact direct LiveKit adapter connection.')
    voiceSession = facts
  } else if (purpose !== 'chat' || mode === 'api-primary' && (preset.voiceSession != null || preset.settings?.voiceSession != null)) throw new ModelPresetUnavailableError('Choose a readable compatible chat or supported speech-to-speech preset.')
  const eligible = getModelPresetAvailability({ model: { ...preset, purpose }, agentType: 'api', connectionOptions: exactOptions })
  if (eligible.disabled) throw new ModelPresetUnavailableError(eligible.disabledBecause === 'locked' ? exactOptions[0].lockedReason ?? 'This model connection is locked.' :
    eligible.disabledBecause === 'incompatible' ? 'This model preset cannot run on an agent.' : 'This saved model preset is unavailable for selection.')
  assertSettingsLifecycle(source.lifecycle)
  const option = exactOptions[0]
  return freeze({ ...source, checks, memberships, choice: { id: preset.id, label: preset.modelName.slice(0, 200),
    connection: { id: option.id, transport: option.transport, service: option.service ?? null }, purpose,
    available: true, reason: null, ...(voiceSession ? { voiceSession } : {}) } })
}

export const READ_MODEL_PRESET_CHOICES_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'set' and kind ~= 'none' then return {'INVALID_INDEX'} end
local count = redis.call('SCARD', KEYS[1])
if count > 10000 then return {'TOO_LARGE'} end
local ids = redis.call('SMEMBERS', KEYS[1])
table.sort(ids)
local matched = 0
local page = {}
for _, id in ipairs(ids) do
  if #id > 256 then return {'TOO_LARGE'} end
  local name = ''
  if ARGV[1] ~= '' then
    local label = redis.pcall('JSON.GET', 'model:' .. id, '$.modelName')
    if type(label) == 'string' then
      local valid, decoded = pcall(cjson.decode, label)
      if valid and type(decoded) == 'table' and type(decoded[1]) == 'string' then name = decoded[1] end
    end
  end
  if ARGV[1] == '' or string.find(string.lower(id), ARGV[1], 1, true) or string.find(string.lower(name), ARGV[1], 1, true) then
    if matched >= tonumber(ARGV[2]) and #page < tonumber(ARGV[3]) then table.insert(page, id) end
    matched = matched + 1
  end
end
return {count, matched, page}
`
export type ModelPresetSelectionQuery = { text?: string; offset?: number; limit?: number }
/** Authenticated human list projection only. No catalog, account, availability or write owner. */
export async function readStoredModelPresetPage(userId: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new ModelPresetUnavailableError('Invalid stored preset offset.')
  const answer = await redis.execute(client => client.eval(READ_MODEL_PRESET_CHOICES_SCRIPT, {
    keys: [`user:${userId}:models`], arguments: ['', String(offset), String(MODEL_PRESET_SELECTION_LIMIT)] }))
  if (!Array.isArray(answer) || typeof answer[0] !== 'number' || !Number.isSafeInteger(answer[0]) || answer[0] < 0 || answer[0] > 10000 || answer[0] !== answer[1] ||
    !Array.isArray(answer[2]) || answer[2].length !== Math.min(MODEL_PRESET_SELECTION_LIMIT, Math.max(0, answer[0] - offset)) ||
    answer[2].some(id => typeof id !== 'string')) throw new ModelPresetUnavailableError('The stored preset index is unavailable.')
  const total = answer[0]
  const models: SavedModel[] = []
  for (const id of answer[2] as string[]) {
    const lifecycle = captureSettingsLifecycle([`model:${id}`])
    const row = await readModelPresetStorage(userId, id, MAX_SELECTION_BYTES)
    assertSettingsLifecycle(lifecycle)
    if (!row.present || !row.preset || typeof row.preset.modelName !== 'string' || typeof row.preset.provider !== 'string' || typeof row.preset.modelId !== 'string') throw new ModelPresetUnavailableError('A stored preset row is unavailable.')
    models.push(row.preset)
    if (Buffer.byteLength(JSON.stringify(models), 'utf8') > MAX_SELECTION_BYTES) throw new ModelPresetUnavailableError('The stored preset page is too large.')
  }
  const end = offset + models.length
  const page = { projection: 'stored' as const, models, total, offset, nextOffset: end < total ? end : null }
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_SELECTION_BYTES) throw new ModelPresetUnavailableError('The stored preset page is too large.')
  return page
}
export type ModelPresetChoiceTarget = { kind: 'agent' | 'subagent'; id: string; type: 'api' }
export async function readModelPresetSelectionChoices(userId: string, query: ModelPresetSelectionQuery = {}, targets?: readonly ModelPresetChoiceTarget[]) {
  const text = (query.text ?? '').trim().toLowerCase()
  const offset = query.offset ?? 0
  const limit = query.limit ?? 12
  if (text.length > 128 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new ModelPresetUnavailableError('Invalid saved model choices query.')
  const answer = await redis.execute(client => client.eval(READ_MODEL_PRESET_CHOICES_SCRIPT,
    { keys: [`user:${userId}:models`], arguments: [text, String(offset), String(limit)] }))
  if (Array.isArray(answer) && answer[0] === 'TOO_LARGE') throw new ModelPresetUnavailableError('The saved model list is too large for this report. Narrow the saved list in Settings → Models.')
  if (!Array.isArray(answer) || typeof answer[0] !== 'number' || typeof answer[1] !== 'number' || !Array.isArray(answer[2]) ||
    answer[2].length > limit || answer[2].some(id => typeof id !== 'string')) {
    throw new ModelPresetStorageError('The saved model preset index is unreadable.')
  }
  const ids = { count: answer[0], matching: answer[1], ids: answer[2] as string[] }
  const choices: ModelPresetSelectionChoice[] = []
  for (const id of ids.ids) {
    if (targets?.length) {
      const modes = new Map<ModelPresetSelectionMode, OwnedModelPresetSelection | ModelPresetUnavailableError>()
      const compatibility: NonNullable<ModelPresetSelectionChoice['compatibility']>[number][] = []
      let display: ModelPresetSelectionChoice | undefined
      for (const target of targets) {
        const mode = target.kind === 'agent' ? 'api-primary' : 'api'
        let source = modes.get(mode)
        if (!source) {
          try { source = await readOwnedModelPresetSelection(userId, id, mode) }
          catch (error) { if (!(error instanceof ModelPresetUnavailableError)) throw error; source = error }
          modes.set(mode, source)
        }
        const reason: string | null = source instanceof ModelPresetUnavailableError ? source.message : null
        if (!(source instanceof ModelPresetUnavailableError)) display ??= source.choice
        compatibility.push({ kind: target.kind, id: target.id, available: reason === null, reason })
      }
      if (!display) {
        const stored = await readModelPresetStorage(userId, id)
        if (!stored.present || !stored.preset) continue
        display = { id, label: stored.preset.modelName.slice(0, 200), connection: null, purpose: stored.preset.purpose ?? 'unknown', available: false, reason: null }
      }
      const available = compatibility.some(target => target.available)
      choices.push({ ...display, available, reason: available ? display.reason : 'No captured target can use this preset.', compatibility })
      continue
    }
    try { choices.push((await readOwnedModelPresetSelection(userId, id)).choice) }
    catch (error) {
      if (!(error instanceof ModelPresetUnavailableError)) throw error
      // Unavailable rows retain only bounded safe display metadata, never raw settings.
      const stored = await readModelPresetStorage(userId, id)
      if (!stored.present || !stored.preset) continue
      choices.push({ id, label: typeof stored.preset.modelName === 'string' ? stored.preset.modelName.slice(0, 200) : id.slice(0, 200),
        connection: null, purpose: stored.preset.purpose ?? 'unknown', available: false, reason: error.message })
    }
  }
  return freeze({ choices, total: ids.count, matching: ids.matching, offset, limit, nextOffset: offset + ids.ids.length < ids.matching ? offset + ids.ids.length : null })
}
