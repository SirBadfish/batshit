import { type AppActionsOperationPreview, type AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import { SETTINGS_REPORT_BYTE_LIMITS } from '$lib/appActions/settings/reportContract'
import { APP_ACTION_DEADLINE_MS } from '$lib/appActions/protocol'
import { MODEL_PRESET_COPY_ID, validateModelPresetCopyChanges, validateModelSelectionChanges, isModelSelectionReview } from '$lib/appActions/settings/modelSelectionPreferences'
import type { ManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { settingsDefinition } from '$lib/appActions/settings/definitions'
import { redis } from '$lib/server/redis'
import { ModelSelectionSaveUnconfirmedError, type ModelSelectionSnapshot, type ModelSelectionMutation, type ModelSelectionClear } from '$lib/server/modelSelectionGuard'
import { prepareModelPresetCopy, readModelPresetCopySelection, modelPresetCopyPlan, assertModelPresetCopySource, createModelPresetCopy, readCreatedModelPresetSelection, finishModelPresetCopy, readOwnedModelPresetSelection, ModelPresetUnavailableError, type OwnedModelPresetSelection, type ModelPresetSelectionMode } from '$lib/server/services/modelPresetSelectionOwner'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
import { presetModelSettings, applyAgentProviderSettingsUpdate } from '$lib/utils/agentProviderSettings'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { assertSettingsLifecycle } from './lifecycle'
import { AppActionsManagementRefusal } from './authority'
import { requireSettingsSubjectAdmission, refreshSettingsOperationAuthority,
  type SettingsManagementAdmission, type SettingsManagementContext } from './managementActor'
import type { ConditionalSettingsStore } from './conditionalAgentSettings'
import type { ManagementReportTicket, createSettingsManagementReports } from './managementReports'
import type { createSettingsOperationRegistry } from './operationRegistry'
import { planModelSelection, planModelSelectionCandidate, planModelSelectionClear, modelSelectionReview, originalModelSelectionCut, type OriginalModelSelectionCut } from './modelSelectionAdapter'

type Change = Extract<ManagedSettingsChangeInput, { op: 'change' }>
type Target = { subject: SettingsSubjectRef; snapshot: ModelSelectionSnapshot; updates: Record<string, unknown>;
  source?: OwnedModelPresetSelection; clear?: ModelSelectionClear; expectedRevision: string; originalCut?: OriginalModelSelectionCut }
const outcome = (subject: SettingsSubjectRef, status: AppActionsTargetOutcome['status'], reason?: string): AppActionsTargetOutcome =>
  ({ subject, status, ...(reason ? { reason } : {}), saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' })
function sameSource(left: OwnedModelPresetSelection, right: OwnedModelPresetSelection) {
  return sameJsonValue(left.checks, right.checks) && sameJsonValue(left.memberships, right.memberships) && sameJsonValue(left.lifecycle, right.lifecycle)
}
function alreadySelected(target: Pick<Target, 'snapshot' | 'updates'>) {
  const row = target.snapshot.record
  return Object.entries(target.updates).every(([field, value]) => field === 'provider_specific_settings'
    ? sameJsonValue(presetModelSettings(row[field]), presetModelSettings(applyAgentProviderSettingsUpdate(row[field], value)))
    : sameJsonValue(row[field] ?? null, value ?? null))
}
function currentTarget(target: Target, fresh: ModelSelectionSnapshot) {
  return fresh.revision === target.snapshot.revision
}

/** Same fixed wrappers/grant/registry and same sparse issue as API. Original private source,
 * native view and complete review are held before execution; fresh reads only confirm equality. */
export async function prepareModelSelectionChange(registry: ReturnType<typeof createSettingsOperationRegistry>,
  reports: ReturnType<typeof createSettingsManagementReports>, store: ConditionalSettingsStore,
  context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown, input: Change,
  admission: SettingsManagementAdmission, ticket: ManagementReportTicket) {
  const copying = input.semanticId === MODEL_PRESET_COPY_ID
  const copyChanges = copying ? validateModelPresetCopyChanges(input.changes) : undefined
  if (copying && !ticket.presetCopySource) throw new AppActionsManagementRefusal('COPY_SOURCE_REQUIRED', 'Use the original source-bound copy choices report.', 409)
  const copyPlan = copyChanges ? prepareModelPresetCopy(ticket.presetCopySource!, copyChanges) : undefined
  const copy = copyPlan ? modelPresetCopyPlan(copyPlan) : undefined
  const changes = copying ? { presetId: copy!.candidate.id } : validateModelSelectionChanges(input.changes)
  const clearing = 'clear' in changes && changes.clear === true
  const originalId = copyChanges?.sourcePresetId ?? changes.presetId ?? ''
  let created = false
  if (!admission.policy.ordinaryChanges) throw new AppActionsManagementRefusal('SETTINGS_CHANGE_BLOCKED', 'The user blocked ordinary Settings changes.')
  const definition = settingsDefinition(copying ? MODEL_PRESET_COPY_ID : 'agent.model.selection')
  const targets: Target[] = [], initialOutcomes: AppActionsTargetOutcome[] = []
  const sources = new Map<ModelPresetSelectionMode, OwnedModelPresetSelection | null>()
  const sourceErrors = new Map<ModelPresetSelectionMode, string>()
  const sourceMode = (entry: ManagementReportTicket['manifest']['entries'][number]): ModelPresetSelectionMode =>
    !copying && entry.subject.kind === 'primary' ? 'api-primary' : 'api'
  for (const entry of ticket.manifest.entries) {
    const mode = sourceMode(entry)
    if (clearing || entry.status !== 'available' || entry.type !== 'api' || sources.has(mode)) continue
    try { sources.set(mode, await (copyPlan ? readModelPresetCopySelection(copyPlan, 'api') : readOwnedModelPresetSelection(context.userId, originalId, mode))) }
    catch (error) { sources.set(mode, null); sourceErrors.set(mode, error instanceof ModelPresetUnavailableError ? error.message : 'owned_preset_selection_unavailable') }
  }
  await refreshSettingsOperationAuthority(admission)
  reports.assertCurrent(ticket)
  const preview: AppActionsOperationPreview = { semanticId: copying ? MODEL_PRESET_COPY_ID : 'agent.model.selection', ...(copy ? { presetCopy: copy.review } : {}), targets: [],
    excluded: ticket.manifest.excluded.map(subject => ({ ...subject })), effects: [...definition.effects] }
  for (const entry of ticket.manifest.entries) {
    if (entry.status !== 'available' || entry.type !== 'api') {
      initialOutcomes.push(outcome(entry.subject, 'unavailable', entry.reason ?? 'unsupported_model_selection_type')); continue
    }
    requireSettingsSubjectAdmission(admission, entry.subject)
    const source = sources.get(sourceMode(entry))
    const snapshot = ticket.modelSelections.get(settingsSubjectKey(entry.subject))
    if (!snapshot || !store.readSelection || !clearing && !source) { initialOutcomes.push(outcome(entry.subject, 'unavailable', sourceErrors.get(sourceMode(entry)) ?? 'owned_preset_selection_unavailable')); continue }
    const fresh = await store.readSelection(entry.subject.id, entry.subject.kind === 'subagent' ? 'subagent' : 'primary')
    reports.assertCurrent(ticket)
    if (fresh.revision !== snapshot.revision || snapshot.record.user_id !== admission.actor.userId) { initialOutcomes.push(outcome(entry.subject, 'conflict', 'model_selection_changed')); continue }
    const kind = entry.subject.kind === 'subagent' ? 'subagent' : 'agent'
    const clear = clearing ? planModelSelectionClear(snapshot, kind) : undefined
    const target: Target = { subject: entry.subject, snapshot, ...(source ? { source } : {}), ...(clear ? { clear: clear.clear } : {}),
      expectedRevision: snapshot.revision,
      updates: clear?.updates ?? (copy ? planModelSelectionCandidate(kind, snapshot, copy.candidate) : planModelSelection(kind, snapshot, source!)) }
    if (alreadySelected(target)) { initialOutcomes.push(outcome(entry.subject, 'unchanged')); continue }
    if (copyPlan) target.originalCut = originalModelSelectionCut(kind, entry.subject.id, snapshot)
    targets.push(target)
    const review: AppActionsOperationPreview['targets'][number] = { subject: entry.subject, label: entry.label ?? entry.subject.id,
      changes: [{ field: 'presetId', label: 'Saved Model', before: typeof snapshot.record.primary_model_preset_id === 'string' ? snapshot.record.primary_model_preset_id : null, after: clearing ? null : changes.presetId! }],
      ...(!copying ? { modelSelection: modelSelectionReview(kind, snapshot, target.updates, clearing, source?.choice.voiceSession) } : {}) }
    if (!copying && !isModelSelectionReview(review.modelSelection)) throw new AppActionsManagementRefusal('MODEL_SELECTION_REVIEW_UNAVAILABLE', 'The original model selection cannot be completely reviewed.', 409)
    if (clearing) preview.effects.push(`${entry.label ?? entry.subject.id}: clears only the owned model selection group. Stored native model/Fast, reasoning, permissions, legacy model and Voice fields remain. No replacement program or runtime is promised; no profile is staged.`)
    if (source?.choice.voiceSession) preview.effects.push(`${entry.label ?? entry.subject.id}: supported LiveKit speech-to-speech configuration for the next deliberate Connect only. Existing room and global Voice settings remain unchanged. Subagent, Worker and Group speech-to-speech use is excluded; readiness was not checked.`)
    preview.targets.push(review)
  }
  // Admit the complete disclosure or refuse; never drop a target or trim an effect to fit.
  if (Buffer.byteLength(JSON.stringify({ preview, initialOutcomes }), 'utf8') > SETTINGS_REPORT_BYTE_LIMITS.values) throw new AppActionsManagementRefusal('MODEL_SELECTION_REVIEW_TOO_LARGE', 'This complete model-selection review exceeds its budget. Choose fewer explicit targets.', 409)
  async function refreshSources() {
    if (copyPlan) await assertModelPresetCopySource(copyPlan)
    for (const [mode, selected] of sources) {
      if (!selected) continue
      assertSettingsLifecycle(selected.lifecycle)
      const fresh = await readOwnedModelPresetSelection(context.userId, originalId, mode)
      if (!sameSource(selected, fresh)) throw new AppActionsManagementRefusal('MODEL_PRESET_CHANGED', 'The selected preset or connection changed. Request a fresh selection.', 409)
      reports.assertCurrent(ticket)
      if (created && copyPlan) {
        // Copy sourceMode is always nonvoice API; API-primary belongs only to A3 selection.
        if (mode === 'api-primary') throw new ModelPresetUnavailableError('A copy requires a nonvoice API source.')
        const actualCopy = await readCreatedModelPresetSelection(copyPlan, mode)
        const targetSource = targets.find(target => target.snapshot.record[target.subject.kind === 'subagent' ? 'subagentType' : 'agentType'] === mode)?.source
        if (targetSource && !sameSource(targetSource, actualCopy)) throw new AppActionsManagementRefusal('MODEL_PRESET_CHANGED', 'The copy changed after creation.', 409)
      }
    }
  }
  async function refresh() {
    await refreshSettingsOperationAuthority(admission)
    await refreshSources()
    for (const target of targets) {
      if (!currentTarget(target, await store.readSelection!(target.subject.id, target.subject.kind === 'subagent' ? 'subagent' : 'primary'))) throw new AppActionsManagementRefusal('SETTINGS_PREIMAGE_CHANGED', 'A captured model/native selection changed. Choose from a fresh report.', 409)
    }
    reports.assertCurrent(ticket)
  }
  const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw, permission: 'allow', preview,
    ...(copyPlan ? { presetCopy: { current: () => modelPresetCopyPlan(copyPlan).outcome } } : {}),
    preimages: copy ? { planId: copy.review.planId, manifest: ticket.manifest.digest } : { authority: admission.fence, manifest: ticket.manifest, targets: targets.map(target => ({ subject: target.subject,
      revision: target.expectedRevision, raw: target.snapshot.raw, paths: target.snapshot.paths, lifecycle: target.snapshot.lifecycle,
      ...(target.source ? { source: { checks: target.source.checks, memberships: target.source.memberships, lifecycle: target.source.lifecycle } } : { clear: true }) })), initialOutcomes },
    initialOutcomes, authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt, refresh,
    admitContext: async current => { await reports.forCapturedOperation(ticket, current, lane) },
    continuation: () => reports.continuation(ticket, ticket.context, lane),
    async execute(execution) {
      const outcomes = initialOutcomes.map(item => ({ ...item }))
      let ended: string | undefined
      if (copyPlan && targets.length) {
        const copyDeadlineAt = Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity)
        const checkCopy = () => {
          reports.assertCurrent(ticket); execution.checkNative?.()
          for (const target of targets) {
            requireSettingsSubjectAdmission(admission, target.subject)
            assertSettingsLifecycle(target.originalCut!.lifecycle)
            target.originalCut!.sources.forEach(source => assertSettingsLifecycle(source.lifecycle))
          }
          if (execution.signal.aborted || Date.now() >= copyDeadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The copy operation ended.', 409)
        }
        try {
          await refresh(); checkCopy()
          try { await createModelPresetCopy(copyPlan, { check: checkCopy, deadlineAt: copyDeadlineAt, authority: admission.fence, targets: targets.map(target => target.originalCut!) }) }
          finally {
            // Even a later failed handoff must show the independently known surviving copy.
            if (modelPresetCopyPlan(copyPlan).outcome.creation === 'saved') void publishUserEvent(admission.actor.userId, { type: 'model_presets_changed' }).catch(() => console.warn('[App Actions] Saved copy refresh is unconfirmed.'))
          }
          checkCopy()
          const actualSource = await readCreatedModelPresetSelection(copyPlan, 'api')
          checkCopy()
          for (const target of targets) target.source = actualSource
          created = true
        } catch {
          ended = modelPresetCopyPlan(copyPlan).outcome.creation === 'unknown' ? 'copy_creation_unknown_do_not_repeat' : 'copy_unavailable_before_assignment'
        }
      }
      for (const target of targets) {
        if (ended) { const item = outcome(target.subject, 'blocked', ended); outcomes.push(item); execution.recordOutcome(item); continue }
        let saved = false
        const kind = target.subject.kind === 'subagent' ? 'subagent' : 'agent'
        const deadlineAt = Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity)
        const check = () => {
          reports.assertCurrent(ticket); requireSettingsSubjectAdmission(admission, target.subject); execution.checkNative?.()
          if (execution.signal.aborted || Date.now() >= deadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The model selection operation ended.', 409)
          assertSettingsLifecycle(target.snapshot.lifecycle)
          if (target.source) assertSettingsLifecycle(target.source.lifecycle)
        }
        try {
          await refreshSettingsOperationAuthority(admission)
          await refreshSources()
          check()
          execution.targetStarted(target.subject)
          const mutation: ModelSelectionMutation = { ...(target.clear ? { clear: target.clear } : { source: target.source! }), check, signal: execution.signal, deadlineAt, authority: admission.fence,
            onSaved() { saved = true; execution.recordOutcome({ subject: target.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_pending' }) } }
          const options = { expectedModelSelection: target.expectedRevision, modelSelectionMutation: mutation }
          if (kind === 'agent') await redis.updateAgent(target.subject.id, target.updates, options)
          else if (!await redis.updateSubagent(target.subject.id, target.updates, options)) throw new Error('The model selection target is gone.')
          let readback: AppActionsTargetOutcome['readback'] = 'unavailable'
          try {
            const current = await store.readSelection!(target.subject.id, target.subject.kind === 'subagent' ? 'subagent' : 'primary')
            readback = sameJsonValue(current.lifecycle, target.snapshot.lifecycle) && alreadySelected({ ...target, snapshot: current }) ? 'verified' : 'changed'
          } catch { /* A known save remains independent of readback. */ }
          const item: AppActionsTargetOutcome = { subject: target.subject, status: 'applied', saved: 'saved', readback, visible: 'unknown' }
          outcomes.push(item); execution.recordOutcome(item)
        } catch (error) {
          const unknown = error instanceof ModelSelectionSaveUnconfirmedError
          const item: AppActionsTargetOutcome = saved ? { subject: target.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_configuration_or_readback_unavailable' } : unknown
            ? { subject: target.subject, status: 'unknown', saved: 'unknown', readback: 'unavailable', visible: 'unknown', reason: 'save_outcome_unconfirmed' }
            : outcome(target.subject, (error as { status?: number })?.status === 409 ? 'conflict' : 'unavailable', 'model_selection_unavailable_before_write')
          outcomes.push(item); execution.recordOutcome(item)
          if (unknown) ended = 'prior_target_outcome_unknown'
          else if (execution.signal.aborted || Date.now() >= deadlineAt) ended = 'operation_no_longer_admitted'
        }
        const recorded = outcomes[outcomes.length - 1]
        if (recorded.saved === 'saved' || recorded.saved === 'unknown') void publishUserEvent(admission.actor.userId, {
          type: kind === 'subagent' ? 'subagent_settings_changed' : 'agent_settings_changed', agentId: target.subject.id, family: 'model-selection'
        }).catch(() => console.warn('[App Actions] Model selection saved; mounted refresh publication is unconfirmed.'))
      }
      if (copyPlan) finishModelPresetCopy(copyPlan, !created ? 'blocked' : outcomes.filter(item => item.saved === 'saved').length === targets.length ? 'finished' : 'partial')
      return outcomes
    } })
  return { input, admission, operation, gate: targets.length > 0 }
}
