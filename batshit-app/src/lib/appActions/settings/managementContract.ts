import { MODEL_PRESET_COPY_ID, validateModelPresetCopyChanges, isModelPresetCopyReview, isModelPresetCopyOutcome, type ModelPresetCopyReview, type ModelPresetCopyOutcome } from './modelSelectionPreferences'
import { isCanonicalAgentId } from '$lib/utils/agentId'
import { parseSettingsSubjectSelector, isUnsupportedSettingsSubjectRef, reportObject, settingsSubjectKey, type SettingsSubjectRef } from './reportContract'
import { SETTINGS_CHANGE_IDS, type SettingsChangeId } from './definitions'
import { parseSkillAccessChange, SKILL_ACCESS_INPUT_LIMIT } from '$lib/appActions/skillAccess'
import { SETTINGS_CHANGE_PARSERS } from './managementInput'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
import { isInstructionsReview, type InstructionsReview } from './instructionReview'
import { INSTRUCTION_LIMITS } from './instructionPreferences'
import { CONFIGURED_TTS_FIELDS, validTtsId, validateConfiguredTtsChanges, type ConfiguredTtsSelection } from './configuredTtsPreferences'
import { isModelSelectionReviewChanges, isModelSelectionReview, validateModelSelectionChanges, type ModelSelectionReview } from './modelSelectionPreferences'
import { SETTINGS_REPORT_BYTE_LIMITS } from './reportContract'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_BUDGET_MS, mcpConfigurationEffects, mcpConfigurationTargetsMatch, isMcpOperationId, isMcpReportId, isMcpConfigurationReview, isMcpResourceOutcome,
  parseMcpConfigurationChanges, type McpConfigurationReview, type McpResourceOutcome } from './mcpConfiguration'

/** Browser-safe P2 wire contract. Only authenticated server owners issue authority or effects. */
export const APP_ACTIONS_POLICY_VERSION = 1 as const
export const APP_ACTIONS_PROTECTED_CATEGORIES = ['instructions', 'memorySettings', 'contextManagement'] as const
export const APP_ACTIONS_MANAGEMENT_EXCEPTIONS = ['skillAccess', 'mcpManagement', 'runtimeManagement'] as const
export type AppActionsPermissionMode = 'block' | 'ask' | 'allow'
export type AppActionsProtectedCategory = typeof APP_ACTIONS_PROTECTED_CATEGORIES[number]
export type AppActionsManagementException = typeof APP_ACTIONS_MANAGEMENT_EXCEPTIONS[number]
export type AppActionsSubjectScope = {
  mode: 'self' | 'selected' | 'all'
  subjects: SettingsSubjectRef[]
  except: SettingsSubjectRef[]
}
export type AppActionsPolicy = {
  version: typeof APP_ACTIONS_POLICY_VERSION
  enabled: boolean
  ordinaryChanges: boolean
  scope: AppActionsSubjectScope
  protected: Record<AppActionsProtectedCategory, AppActionsPermissionMode>
  management: Record<AppActionsManagementException, AppActionsPermissionMode>
}
export type AppActionsNativePolicyRecord = { generation: number; policy: AppActionsPolicy }
export type AppActionsPortableGrant = { policy: AppActionsPolicy; expiresAt: string }
export type AppActionsSubjectChoice = { subject: SettingsSubjectRef; label: string; type: 'api' | 'cli' | 'unknown'; available: boolean; reason?: 'unsupported_subject_id' | 'subject_unavailable' | 'unsupported_subject_type' }
export type AppActionsNativePolicyResponse = {
  success: true
  agentId: string
  generation: number
  subjectRevision: string
  policy: AppActionsPolicy
  subjects: AppActionsSubjectChoice[]
}
export type AppActionsPolicySaveRequest = { expectedGeneration: number; expectedSubjectRevision: string; policy: AppActionsPolicy }
export type AppActionsPortableGrantResponse = {
  success: true
  tokenId: string
  authorityGeneration: number
  grant: AppActionsPortableGrant | null
  subjects: AppActionsSubjectChoice[]
}
export type AppActionsPortableGrantSaveRequest = { expectedAuthorityGeneration: number; grant: AppActionsPortableGrant | null }
export type AppActionsTargetOutcome = {
  subject: SettingsSubjectRef
  status: 'applied' | 'unchanged' | 'blocked' | 'conflict' | 'unavailable' | 'unknown'
  reason?: string
  saved: 'saved' | 'not_requested' | 'unknown'
  readback: 'verified' | 'unavailable' | 'changed' | 'not_requested'
  visible: 'unknown' | 'unchanged'
  /** Configuration publication is independent of a definitive structured-data save. */
  configuration?: 'saved' | 'unchanged' | 'blocked' | 'unconfirmed'
}
export type AppActionsOperationStatus = 'awaiting_approval' | 'ready' | 'running' | 'completed' | 'denied' | 'cancelled' | 'expired' | 'blocked' | 'unknown_outcome'
export type ScalarAppActionsOperationPreview = {
  semanticId: SettingsChangeId
  targets: Array<{
    subject: SettingsSubjectRef
    label: string
    changes: Array<{ field: string; label: string; before: string | number | boolean | null; after: string | number | boolean | null }>
    modelSelection?: ModelSelectionReview
  }>
  excluded: SettingsSubjectRef[]
  effects: string[]
  /** Exact user-only disclosure. Model-facing operation receipts omit the whole preview. */
  presetCopy?: ModelPresetCopyReview
  instructions?: InstructionsReview
}
export type AppActionsOperationPreview = ScalarAppActionsOperationPreview | {
  semanticId: typeof MCP_CONFIGURATION_ID; targets: ScalarAppActionsOperationPreview['targets']; excluded: SettingsSubjectRef[]; effects: string[]
  resource: McpConfigurationReview; instructions?: never; presetCopy?: never
}
export type AppActionsOperationReview = {
  operationId: string
  intentDigest: string
  status: AppActionsOperationStatus
  actor: { kind: 'portable'; label: string }
  preview: AppActionsOperationPreview
  reviewExpiresAt: string
  hardDeadlineAt: string | null
  executionBudgetMs: number
  executionDeadlineAt: string | null
  canDecide: boolean
  outcomes: AppActionsTargetOutcome[]
  resourceOutcomes?: McpResourceOutcome[]
  presetCopyOutcome?: ModelPresetCopyOutcome
  reason?: string
}
export type AppActionsApprovalPreview = {
  controlId: 'sys.app_settings.native.change'
  input: Record<string, unknown>
  operationId: string
  intentDigest: string
  preview: AppActionsOperationPreview
  reviewExpiresAt: string
  hardDeadlineAt: string | null
  executionBudgetMs: number
  /** Captured nonexecuting rows; never progress claims or an extra execution grant. */
  initialOutcomes?: AppActionsTargetOutcome[]
}
/** Native disclosure only. Existing operations retain their full execution outcome validator. */
export function isAppActionsInitialOutcomes(value: unknown, executable: readonly SettingsSubjectRef[] = []): value is AppActionsTargetOutcome[] {
  try {
    if (!Array.isArray(value) || value.length + executable.length > 256) return false
    const seen = new Set(executable.map(settingsSubjectKey))
    if (seen.size !== executable.length) return false
    return value.every(item => {
      const outcome = item as AppActionsTargetOutcome
      if (!outcome || !['blocked', 'conflict', 'unavailable', 'unchanged'].includes(outcome.status) ||
        outcome.saved !== 'not_requested' || outcome.readback !== 'not_requested' || outcome.visible !== 'unchanged' ||
        outcome.reason !== undefined && !text(outcome.reason, 200)) return false
      if (!(outcome.status === 'unavailable' && outcome.reason === 'unsupported_subject_id' && isUnsupportedSettingsSubjectRef(outcome.subject))) {
        parseSettingsSubjectSelector({ subjects: [outcome.subject] })
      }
      const key = settingsSubjectKey(outcome.subject)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch { return false }
}
export type AppActionsOperationResponse = { success: true; operation: AppActionsOperationReview }
export type AppActionsOperationDecisionRequest = { decision: 'approve' | 'deny'; intentDigest: string }
export type AppActionsManagementErrorResponse = { success: false; error: string; code: string }

export const APP_ACTIONS_POLICY_REFRESH_FAMILY = 'app-actions-policy' as const
export const APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID = 'sys.app_settings.native.change' as const
export const APP_ACTIONS_PORTABLE_REFRESH_EVENT = 'portable_skill_authority_changed' as const
export const APP_ACTIONS_PORTABLE_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000
export const APP_ACTIONS_PORTABLE_MAX_LIFETIME_MS = 30 * APP_ACTIONS_PORTABLE_DEFAULT_LIFETIME_MS
export const APP_ACTIONS_REVIEW_LIFETIME_MS = 10 * 60 * 1000
export const APP_ACTIONS_EXECUTION_BUDGET_MS = 30 * 1000
export const APP_ACTIONS_MANAGEMENT_ROUTES = Object.freeze({
  nativePolicy: (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/app-actions-policy`,
  portableGrant: (tokenId: string) => `/api/portable-skills/tokens/${encodeURIComponent(tokenId)}/app-actions-grant`,
  operation: (operationId: string) => `/api/app/settings/operations/${encodeURIComponent(operationId)}`,
  decision: (operationId: string) => `/api/app/settings/operations/${encodeURIComponent(operationId)}/decision`,
  reviewPage: (operationId: string) => `/app-actions/review/${encodeURIComponent(operationId)}`
})

export function defaultAppActionsPolicy(portable = false): AppActionsPolicy {
  return { version: 1, enabled: false, ordinaryChanges: true,
    scope: { mode: portable ? 'selected' : 'self', subjects: [], except: [] },
    protected: { instructions: 'ask', memorySettings: 'ask', contextManagement: 'ask' },
    management: { skillAccess: 'ask', mcpManagement: 'ask', runtimeManagement: 'ask' } }
}

function generation(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function mode(value: unknown): value is AppActionsPermissionMode { return value === 'block' || value === 'ask' || value === 'allow' }
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && value.length <= max && value.isWellFormed() }
/** Expanded disclosure facts, not an alternative mutation input or source of authority. */
function configuredTtsPreviewTuple(value: unknown): ConfiguredTtsSelection | null {
  if (!Array.isArray(value) || value.length !== CONFIGURED_TTS_FIELDS.length) return null
  const fields = new Set<string>()
  for (const change of value) {
    if (!change || !(CONFIGURED_TTS_FIELDS as readonly unknown[]).includes(change.field) || fields.has(change.field) ||
      !text(change.label, 600) || new TextEncoder().encode(change.label).length > 600 ||
      ![change.before, change.after].every(fact => fact === null || validTtsId(fact))) return null
    fields.add(change.field)
  }
  const after = Object.fromEntries(value.map(change => [change.field, change.after])) as ConfiguredTtsSelection
  // BEFORE may be a sparse legacy record. Only the issued AFTER is a coherent selection.
  if (after.providerId === null ? CONFIGURED_TTS_FIELDS.some(field => after[field] !== null) :
    after.profileId !== null && after.voiceId === null) return null
  return after
}
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
export function parseAppActionsPolicy(value: unknown, portable = false): AppActionsPolicy {
  const record = reportObject(value, ['version', 'enabled', 'ordinaryChanges', 'scope', 'protected', 'management'])
  const scope = reportObject(record.scope, ['mode', 'subjects', 'except'])
  if (record.version !== 1 || typeof record.enabled !== 'boolean' || typeof record.ordinaryChanges !== 'boolean' ||
    !['self', 'selected', 'all'].includes(String(scope.mode)) || portable && scope.mode === 'self' ||
    !Array.isArray(scope.subjects) || !Array.isArray(scope.except)) throw new Error('Invalid App Actions policy.')
  const parseRefs = (refs: unknown[]) => {
    if (!refs.length) return []
    const parsed = parseSettingsSubjectSelector({ subjects: refs })
    if (!('subjects' in parsed) || parsed.subjects.some(ref => ref.kind !== 'primary' && ref.kind !== 'subagent')) throw new Error('Only stored agents can be granted App Actions scope.')
    return parsed.subjects.map(ref => ({ ...ref }))
  }
  const protectedModes = reportObject(record.protected, APP_ACTIONS_PROTECTED_CATEGORIES)
  const managementModes = reportObject(record.management, APP_ACTIONS_MANAGEMENT_EXCEPTIONS)
  if (APP_ACTIONS_PROTECTED_CATEGORIES.some(key => !mode(protectedModes[key])) ||
    APP_ACTIONS_MANAGEMENT_EXCEPTIONS.some(key => !mode(managementModes[key]))) throw new Error('Choose Block, Ask first or Allow for each category.')
  const subjects = parseRefs(scope.subjects)
  const except = parseRefs(scope.except)
  if (scope.mode !== 'selected' && subjects.length) throw new Error('Only Selected scope accepts a subject list.')
  return { version: 1, enabled: record.enabled, ordinaryChanges: record.ordinaryChanges,
    scope: { mode: scope.mode as AppActionsSubjectScope['mode'], subjects, except },
    protected: Object.fromEntries(APP_ACTIONS_PROTECTED_CATEGORIES.map(key => [key, protectedModes[key]])) as AppActionsPolicy['protected'],
    management: Object.fromEntries(APP_ACTIONS_MANAGEMENT_EXCEPTIONS.map(key => [key, managementModes[key]])) as AppActionsPolicy['management'] }
}
export function parseAppActionsPortableGrant(value: unknown): AppActionsPortableGrant | null {
  if (value === null) return null
  const record = reportObject(value, ['policy', 'expiresAt'])
  if (!iso(record.expiresAt)) throw new Error('Choose a valid App Actions expiry.')
  return { policy: parseAppActionsPolicy(record.policy, true), expiresAt: record.expiresAt }
}
function choices(value: unknown): value is AppActionsSubjectChoice[] {
  return Array.isArray(value) && value.length <= 256 && value.every(item => {
    try {
      if (!(item?.available === false && item.reason === 'unsupported_subject_id' && isUnsupportedSettingsSubjectRef(item.subject))) parseSettingsSubjectSelector({ subjects: [item?.subject] })
      return text(item.label) && typeof item.available === 'boolean' &&
        (['api', 'cli'].includes(item.type) || item.available === false && item.type === 'unknown')
    } catch { return false }
  })
}
export function isAppActionsNativePolicyResponse(value: unknown): value is AppActionsNativePolicyResponse {
  try {
    const record = value as AppActionsNativePolicyResponse
    return record?.success === true && isCanonicalAgentId(record.agentId) && generation(record.generation) &&
      /^sha256:[a-f0-9]{64}$/.test(record.subjectRevision) && choices(record.subjects) && !!parseAppActionsPolicy(record.policy)
  } catch { return false }
}
export function isAppActionsPortableGrantResponse(value: unknown): value is AppActionsPortableGrantResponse {
  try {
    const record = value as AppActionsPortableGrantResponse
    return record?.success === true && text(record.tokenId, 128) && generation(record.authorityGeneration) && choices(record.subjects) &&
      (record.grant === null || !!parseAppActionsPortableGrant(record.grant))
  } catch { return false }
}
export function isAppActionsOperationResponse(value: unknown): value is AppActionsOperationResponse {
  try {
    const envelope = value as AppActionsOperationResponse
    const record = envelope?.operation
    if (record?.preview?.semanticId === MCP_CONFIGURATION_ID) {
      const resource = record.preview.resource
      if (!isMcpConfigurationReview(resource)) return false
      const full = resource.variant === 'prerequisite'
      return envelope.success === true && isMcpOperationId(record.operationId) && /^[a-f0-9]{64}$/.test(record.intentDigest) &&
        Object.keys(record.preview).every(key => ['semanticId', 'targets', 'excluded', 'effects', 'resource'].includes(key)) &&
        ['awaiting_approval', 'ready', 'running', 'completed', 'denied', 'cancelled', 'expired', 'blocked', 'unknown_outcome'].includes(record.status) &&
        record.actor?.kind === 'portable' && text(record.actor.label, 80) && iso(record.reviewExpiresAt) &&
        (record.hardDeadlineAt === null || iso(record.hardDeadlineAt)) && (record.executionDeadlineAt === null || iso(record.executionDeadlineAt)) &&
        record.executionBudgetMs === MCP_CONFIGURATION_BUDGET_MS && typeof record.canDecide === 'boolean' &&
        mcpConfigurationTargetsMatch(resource, record.preview.targets) && Array.isArray(record.preview.excluded) && record.preview.excluded.length === 0 &&
        JSON.stringify(record.preview.effects) === JSON.stringify(mcpConfigurationEffects(resource)) && record.preview.instructions === undefined &&
        new TextEncoder().encode(JSON.stringify(record.preview)).length <= 65_536 &&
        Array.isArray(record.outcomes) && record.outcomes.length <= (full ? 1 : 0) && record.outcomes.every(outcome => resource.variant === 'prerequisite' &&
          sameJsonValue(outcome.subject, resource.intent.subject) && ['applied', 'unchanged', 'blocked', 'conflict', 'unavailable', 'unknown'].includes(outcome.status) &&
          ['saved', 'not_requested', 'unknown'].includes(outcome.saved) && ['verified', 'unavailable', 'changed', 'not_requested'].includes(outcome.readback) &&
          ['unknown', 'unchanged'].includes(outcome.visible) && (outcome.reason === undefined || text(outcome.reason, 200))) &&
        Array.isArray(record.resourceOutcomes) && record.resourceOutcomes.length <= 1 &&
        record.resourceOutcomes.every(outcome => isMcpResourceOutcome(outcome) && outcome.resource.gatewayId === resource.resource.gatewayId &&
          (full ? outcome.variant === 'prerequisite' : outcome.variant === undefined))
    }
    if (envelope?.success !== true || !record || !/^aso_[a-f0-9]{24}_[a-f0-9]{32}$/.test(record.operationId) ||
      !/^[a-f0-9]{64}$/.test(record.intentDigest) ||
      !['awaiting_approval', 'ready', 'running', 'completed', 'denied', 'cancelled', 'expired', 'blocked', 'unknown_outcome'].includes(record.status) ||
      record.actor?.kind !== 'portable' || !text(record.actor.label, 80) || !iso(record.reviewExpiresAt) ||
      record.hardDeadlineAt !== null && !iso(record.hardDeadlineAt) || record.executionDeadlineAt !== null && !iso(record.executionDeadlineAt) ||
      !Number.isSafeInteger(record.executionBudgetMs) || record.executionBudgetMs <= 0 || record.executionBudgetMs > APP_ACTIONS_EXECUTION_BUDGET_MS ||
      typeof record.canDecide !== 'boolean' || !record.preview || !(SETTINGS_CHANGE_IDS as readonly unknown[]).includes(record.preview.semanticId) ||
      !Array.isArray(record.preview.targets) || record.preview.targets.length > 256 || !Array.isArray(record.preview.excluded) ||
      !Array.isArray(record.preview.effects) || record.preview.effects.some(effect => !text(effect, 500)) || !Array.isArray(record.outcomes)) return false
    parseSettingsSubjectSelector({ allAgents: true, except: record.preview.excluded })
    const instructions = record.preview.semanticId === 'agent.instructions'
    if (instructions ? !isInstructionsReview(record.preview.instructions, record.preview.targets) ||
      new TextEncoder().encode(JSON.stringify(record.preview)).byteLength > INSTRUCTION_LIMITS.previewBytes : record.preview.instructions !== undefined) return false
    const copy = record.preview.semanticId === MODEL_PRESET_COPY_ID
    if (copy ? !isModelPresetCopyReview(record.preview.presetCopy) || !isModelPresetCopyOutcome(record.presetCopyOutcome) ||
      record.presetCopyOutcome.presetId !== record.preview.presetCopy.copyPresetId || record.presetCopyOutcome.name !== record.preview.presetCopy.copyName :
      record.preview.presetCopy !== undefined || record.presetCopyOutcome !== undefined) return false
    const aliasAccess = record.preview.semanticId === 'agent.skills.access'
    if ((record.preview.semanticId === 'agent.model.selection' || record.preview.semanticId === MODEL_PRESET_COPY_ID) && new TextEncoder().encode(JSON.stringify(record.preview)).byteLength > SETTINGS_REPORT_BYTE_LIMITS.values) return false
    for (const target of record.preview.targets) {
      parseSettingsSubjectSelector({ subjects: [target.subject] })
      if (record.preview.semanticId === 'agent.voice.tts-selection') {
        if (target.subject.kind !== 'primary' || !text(target.label) || !configuredTtsPreviewTuple(target.changes)) return false
        continue
      }
      if ((record.preview.semanticId === 'agent.model.selection' || record.preview.semanticId === MODEL_PRESET_COPY_ID)) {
        const selection = record.preview.semanticId === 'agent.model.selection'
        if (!text(target.label) || selection && (!['primary', 'subagent'].includes(target.subject.kind) || !isModelSelectionReview(target.modelSelection) ||
          target.modelSelection.role.endsWith('-subagent') !== (target.subject.kind === 'subagent')) ||
          !isModelSelectionReviewChanges(target.changes, selection && target.modelSelection?.intent === 'clear')) return false
        if (selection) {
          const facts = target.modelSelection!, selected = target.changes.find(change => change.field === 'presetId')!
          if ((facts.presetBefore.state === 'set' ? facts.presetBefore.value : null) !== selected.before ||
            facts.intent === 'select' && (facts.presetAfter.state !== 'set' || facts.presetAfter.value !== selected.after)) return false
        }
        if (copy && target.changes.find(change => change.field === 'presetId')?.after !== record.preview.presetCopy!.copyPresetId) return false
        continue
      }
      if (!text(target.label) || !Array.isArray(target.changes) || !target.changes.length || target.changes.length > (aliasAccess ? SKILL_ACCESS_INPUT_LIMIT : record.preview.semanticId === 'agent.memory.preferences' ? 8 : 5) ||
        target.changes.some(change => !text(change.field, aliasAccess ? 128 : 64) || !text(change.label) ||
          ![null, 'string', 'number', 'boolean'].includes(change.before === null ? null : typeof change.before) ||
          ![null, 'string', 'number', 'boolean'].includes(change.after === null ? null : typeof change.after) ||
          typeof change.before === 'string' && !text(change.before) || typeof change.after === 'string' && !text(change.after))) return false
    }
    for (const target of record.preview.targets) {
      if (record.preview.semanticId === 'agent.skills.access') {
        if (target.changes.some(change => typeof change.before !== 'boolean' || typeof change.after !== 'boolean')) return false
        parseSkillAccessChange({ assignments: target.changes.map(change => ({ skillId: change.field, enabled: change.after })) })
      } else if (record.preview.semanticId === 'agent.instructions') {
        // The fixed table validator above binds exact leaves and literal disclosure.
      } else if (record.preview.semanticId === 'agent.voice.tts-selection') {
        // The fixed tuple above validates expanded facts without reparsing them as tagged mutations.
      } else if ((record.preview.semanticId === 'agent.model.selection' || record.preview.semanticId === MODEL_PRESET_COPY_ID)) {
        // The preset mutation and expanded human-only CLI facts were checked separately above.
      } else if (record.preview.semanticId === 'agent.memory.preferences') {
        if (target.changes.some(change => change.field === 'windowMode') || new Set(target.changes.map(change => change.field)).size !== target.changes.length) return false
        const modes = target.changes.filter(change => change.field === 'floorMode' || change.field === 'ceilingHeadroomMode')
        if (modes.length && (modes.length !== 2 || modes.some(change => change.after !== 'auto' || change.before !== 'auto' && change.before !== 'custom'))) return false
        SETTINGS_CHANGE_PARSERS['agent.memory.preferences']({ ...Object.fromEntries(target.changes.filter(change => !modes.includes(change)).map(change => [change.field, change.after])), ...(modes.length ? { windowMode: 'auto' } : {}) })
      } else for (const change of target.changes) SETTINGS_CHANGE_PARSERS[record.preview.semanticId]({ [change.field]: change.after })
    }
    return record.outcomes.every(outcome => {
      if (!(outcome.status === 'unavailable' && outcome.reason === 'unsupported_subject_id' && isUnsupportedSettingsSubjectRef(outcome.subject))) parseSettingsSubjectSelector({ subjects: [outcome.subject] })
      return ['applied', 'unchanged', 'blocked', 'conflict', 'unavailable', 'unknown'].includes(outcome.status) &&
        ['saved', 'not_requested', 'unknown'].includes(outcome.saved) && ['verified', 'unavailable', 'changed', 'not_requested'].includes(outcome.readback) &&
        ['unknown', 'unchanged'].includes(outcome.visible)
        && (outcome.configuration === undefined || ['saved', 'unchanged', 'blocked', 'unconfirmed'].includes(outcome.configuration))
    })
  } catch { return false }
}
/** Presentation sanity/binding only. Server-held operations and the real approval gate own authority. */
export function isAppActionsApprovalPreviewForControl(value: unknown, control: unknown): value is AppActionsApprovalPreview {
  try {
    const preview = value as AppActionsApprovalPreview
    const owner = control as { controlId?: unknown; input?: unknown }
    if (!preview || owner?.controlId !== APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID || preview.controlId !== owner.controlId ||
      !owner.input || !sameJsonValue(preview.input, owner.input) || preview.input.op !== 'change' ||
      preview.preview?.semanticId !== preview.input.semanticId || !text(preview.input.requestId, 160) || !text(preview.input.reportId, 80)) return false
    if (preview.preview.semanticId === MCP_CONFIGURATION_ID) {
      const changes = parseMcpConfigurationChanges(preview.input.changes)
      const resource = preview.preview.resource
      if (!isMcpConfigurationReview(resource)) return false
      if (resource.variant === 'prerequisite') {
        if (!changes.target || !sameJsonValue(changes.target, resource.intent) ||
          (resource.sourceAction === 'save' ? changes.source?.candidateId !== resource.candidateId :
            changes.source !== undefined && (resource.mode === 'remove' || changes.source.candidateId !== resource.candidateId))) return false
      } else if (changes.target || changes.source?.candidateId !== resource.candidateId) return false
      if (!isMcpReportId(preview.input.reportId) || !/^[a-f0-9]{24}:[A-Za-z0-9_.:-]{1,128}$/.test(String(preview.input.requestId)) ||
        preview.operationId.slice(4, 28) !== preview.input.reportId.slice(4, 28) || preview.input.requestId.slice(0, 24) !== preview.input.reportId.slice(4, 28) ||
        (preview.input.hardDeadlineAt === undefined ? preview.hardDeadlineAt !== null : typeof preview.input.hardDeadlineAt !== 'number' ||
          !Number.isSafeInteger(preview.input.hardDeadlineAt) || preview.hardDeadlineAt !== new Date(preview.input.hardDeadlineAt).toISOString()) ||
        !Array.isArray(preview.initialOutcomes) || preview.initialOutcomes.length !== 0) return false
      return isAppActionsOperationResponse({ success: true, operation: { operationId: preview.operationId, intentDigest: preview.intentDigest,
        status: 'awaiting_approval', actor: { kind: 'portable', label: '' }, preview: preview.preview, reviewExpiresAt: preview.reviewExpiresAt,
        hardDeadlineAt: preview.hardDeadlineAt, executionBudgetMs: preview.executionBudgetMs, executionDeadlineAt: null, canDecide: false, outcomes: [], resourceOutcomes: [] } })
    }
    if ((preview.preview.semanticId === 'agent.instructions' || preview.preview.semanticId === 'agent.context.auto-compact' || preview.preview.semanticId === 'agent.memory.preferences' || preview.preview.semanticId === 'agent.voice.tts-selection' || preview.preview.semanticId === 'agent.model.selection' || preview.preview.semanticId === MODEL_PRESET_COPY_ID) && preview.initialOutcomes === undefined) return false
    const initialOutcomes = preview.initialOutcomes ?? []
    if (!isAppActionsInitialOutcomes(initialOutcomes, preview.preview.targets.map(target => target.subject))) return false
    if (!isAppActionsOperationResponse({ success: true, operation: {
      operationId: preview.operationId, intentDigest: preview.intentDigest, status: 'awaiting_approval', actor: { kind: 'portable', label: '' },
      preview: preview.preview, reviewExpiresAt: preview.reviewExpiresAt, hardDeadlineAt: preview.hardDeadlineAt,
      executionBudgetMs: preview.executionBudgetMs, executionDeadlineAt: null, canDecide: false, outcomes: initialOutcomes, ...(preview.preview.semanticId === MODEL_PRESET_COPY_ID && preview.preview.presetCopy ? { presetCopyOutcome: { presetId: preview.preview.presetCopy.copyPresetId, name: preview.preview.presetCopy.copyName, creation: 'not_requested', source: 'not_requested', assignment: 'not_started' } } : {})
    } })) return false
    if (preview.preview.semanticId === 'agent.voice.tts-selection') {
      const changes = validateConfiguredTtsChanges(preview.input.changes)
      return preview.preview.targets.every(target => {
        const after = configuredTtsPreviewTuple(target.changes)!
        return changes.selection === 'inherit' ? CONFIGURED_TTS_FIELDS.every(field => after[field] === null) :
          changes.selection === 'provider' ? after.profileId === null && after.providerId === changes.providerId && after.modelId === changes.modelId && after.voiceId === changes.voiceId :
          after.profileId === changes.profileId
      })
    }
    if (preview.preview.semanticId === MODEL_PRESET_COPY_ID) {
      const changes = validateModelPresetCopyChanges(preview.input.changes), copy = preview.preview.presetCopy!
      return copy.sourcePresetId === changes.sourcePresetId && copy.copyName === changes.copyName &&
        copy.parameters.length === changes.parameters.length && copy.parameters.every((row, index) => {
          const edit = changes.parameters[index]
          return row.name === edit.name && sameJsonValue(row.after, edit.op === 'unset' ? { state: 'unset' } : { state: 'set', value: edit.value })
        }) && preview.preview.targets.every(target => target.changes.find(change => change.field === 'presetId')?.after === copy.copyPresetId)
    }
    if (preview.preview.semanticId === 'agent.model.selection') {
      const changes = validateModelSelectionChanges(preview.input.changes)
      return preview.preview.targets.every(target => changes.clear === true
        ? target.modelSelection?.intent === 'clear' && target.changes.find(change => change.field === 'presetId')?.after === null
        : target.modelSelection?.intent === 'select' && target.changes.find(change => change.field === 'presetId')?.after === changes.presetId)
    }
    return true
  } catch { return false }
}
