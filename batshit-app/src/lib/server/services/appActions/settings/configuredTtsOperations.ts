import { configuredTtsCatalogDependency } from './configuredTtsCatalogDependency'
import { sameVoiceCatalogSelection } from '$lib/server/voiceCatalogSelectionGuard'
import { APP_ACTIONS_REVIEW_LIFETIME_MS, type AppActionsOperationPreview, type AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import { APP_ACTION_DEADLINE_MS } from '$lib/appActions/protocol'
import { CONFIGURED_TTS_FIELDS, CONFIGURED_TTS_SEMANTIC_ID, validateConfiguredTtsChanges } from '$lib/appActions/settings/configuredTtsPreferences'
import type { ManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { settingsSubjectKey } from '$lib/appActions/settings/reportContract'
import { settingsDefinition } from '$lib/appActions/settings/definitions'
import { redis } from '$lib/server/redis'
import { ConfiguredTtsSaveUnconfirmedError } from '$lib/server/configuredTtsGuard'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { planConfiguredTtsSelection } from './configuredTtsAdapter'
import { checkConfiguredTtsAccountSource, assertConfiguredTtsAccountEnvironment } from './configuredTtsAccountCatalog'
import { createManagementAdapterContext } from '../adapterContext'
import { assertSettingsLifecycle } from './lifecycle'
import { AppActionsManagementRefusal } from './authority'
import { requireSettingsSubjectAdmission, refreshSettingsOperationAuthority, nativeSettingsSignal, type SettingsManagementAdmission, type SettingsManagementContext } from './managementActor'
import type { ConditionalSettingsStore } from './conditionalAgentSettings'
import type { createSettingsManagementReports, ManagementReportTicket } from './managementReports'
import type { createSettingsOperationRegistry } from './operationRegistry'
type Change = Extract<ManagedSettingsChangeInput, { op: 'change' }>
const outcome = (subject: AppActionsTargetOutcome['subject'], status: AppActionsTargetOutcome['status'], reason?: string): AppActionsTargetOutcome => ({ subject, status, ...(reason ? { reason } : {}), saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' })
export async function prepareConfiguredTtsChange(registry: ReturnType<typeof createSettingsOperationRegistry>, reports: ReturnType<typeof createSettingsManagementReports>, store: ConditionalSettingsStore,
  context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown, input: Change, admission: SettingsManagementAdmission, ticket: ManagementReportTicket) {
  const changes = validateConfiguredTtsChanges(input.changes)
  if (!admission.policy.ordinaryChanges) throw new AppActionsManagementRefusal('SETTINGS_CHANGE_BLOCKED', 'The user blocked ordinary Settings changes.')
  if (!store.readConfiguredTts) throw new AppActionsManagementRefusal('TTS_SOURCE_UNAVAILABLE', 'Configured reply voice selection is unavailable.', 503)
  const targets: Array<{ subject: AppActionsTargetOutcome['subject']; target: NonNullable<Awaited<ReturnType<NonNullable<typeof store.readConfiguredTts>>>>; plan: ReturnType<typeof planConfiguredTtsSelection> }> = []
  const initialOutcomes: AppActionsTargetOutcome[] = [], preview: AppActionsOperationPreview = { semanticId: CONFIGURED_TTS_SEMANTIC_ID, effects: [...settingsDefinition(CONFIGURED_TTS_SEMANTIC_ID).effects], targets: [], excluded: ticket.manifest.excluded.map(subject => ({ ...subject })) }
  const checkPreparation = () => {
    reports.assertCurrent(ticket)
    if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
    if (Date.now() >= ticket.expiresAt || Date.now() >= (admission.expiresAt ?? Infinity) || Date.now() >= (input.hardDeadlineAt ?? Infinity)) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'Reply voice selection expired.', 409)
  }
  for (const entry of ticket.manifest.entries) {
    if (entry.status !== 'available' || entry.subject.kind !== 'primary' || entry.type !== 'api') { initialOutcomes.push(outcome(entry.subject, 'unavailable', 'tts_primary_only')); continue }
    requireSettingsSubjectAdmission(admission, entry.subject)
    const held = ticket.configuredTts.get(settingsSubjectKey(entry.subject))
    if (!held) { initialOutcomes.push(outcome(entry.subject, 'unavailable', 'tts_report_required')); continue }
    try {
      checkPreparation()
      const target = await store.readConfiguredTts(admission.actor.userId, entry.subject.id, changes.selection === 'profile' ? changes.profileId : undefined)
      checkPreparation(); requireSettingsSubjectAdmission(admission, entry.subject)
      if (target.snapshot.revision !== held.snapshot.revision || JSON.stringify(target.guards) !== JSON.stringify(held.guards)) { initialOutcomes.push(outcome(entry.subject, 'conflict', 'tts_changed_since_report')); continue }
      const heldAccount = changes.selection === 'provider' && changes.providerId === 'fish' && changes.voiceId !== null && ticket.configuredTtsAccount?.subject.id === entry.subject.id
        ? ticket.configuredTtsAccount.find(changes.voiceId) : undefined
      const plan = planConfiguredTtsSelection(target, changes, heldAccount)
      const selectedProviderId = plan.selection.providerId ?? target.globalSelection.providerId ?? 'browser'
      const heldProvider = held.providers.find(provider => provider.id === selectedProviderId), currentProvider = target.providers.find(provider => provider.id === selectedProviderId)
      if (JSON.stringify(heldProvider?.guards) !== JSON.stringify(currentProvider?.guards)) { initialOutcomes.push(outcome(entry.subject, 'conflict', 'tts_selected_provider_changed_since_report')); continue }
      const heldCatalogDependency = configuredTtsCatalogDependency(held.catalog.voiceCatalog, plan.effectiveAfter)
      if (Boolean(heldCatalogDependency) !== Boolean(plan.catalogDependency) || heldCatalogDependency && plan.catalogDependency && (heldCatalogDependency.length !== plan.catalogDependency.length || heldCatalogDependency.some((source, index) => !sameVoiceCatalogSelection(source.voiceCatalog, plan.catalogDependency![index].voiceCatalog)))) { initialOutcomes.push(outcome(entry.subject, 'conflict', 'tts_selected_compatibility_changed_since_report')); continue }
      if (changes.selection === 'profile') {
        const old = held.profiles.find(profile => profile.id === changes.profileId), fresh = target.profiles.find(profile => profile.id === changes.profileId)
        const key = `voice_profile:${changes.profileId}`
        if (!old || !fresh) { initialOutcomes.push(outcome(entry.subject, 'unavailable', 'tts_profile_report_required')); continue }
        if (JSON.stringify(old.guard) !== JSON.stringify(fresh.guard) || JSON.stringify(old.metadataGuards) !== JSON.stringify(fresh.metadataGuards) || held.catalog.profileSource.lifecycle.epoch !== target.catalog.profileSource.lifecycle.epoch ||
          held.catalog.profileSource.lifecycle.records.find(([id]) => id === key)?.[1] !== target.catalog.profileSource.lifecycle.records.find(([id]) => id === key)?.[1]) {
          initialOutcomes.push(outcome(entry.subject, 'conflict', 'tts_selected_profile_changed_since_report')); continue
        }
      }
      if (plan.unchanged) { initialOutcomes.push(outcome(entry.subject, 'unchanged')); continue }
      targets.push({ subject: entry.subject, target, plan })
      preview.targets.push({ subject: entry.subject, label: entry.label ?? entry.subject.id, changes: CONFIGURED_TTS_FIELDS.map(field => ({ field, label: `${field} (effective ${target.effective[field] ?? 'unknown'} → ${plan.effectiveAfter[field] ?? 'unknown'})`,
        before: target.selection[field], after: plan.selection[field] })) })
    } catch (error) {
      checkPreparation()
      const reason = error instanceof Error && ['tts_speech_to_speech_locked', 'tts_provider_not_configured', 'tts_model_not_configured', 'tts_voice_catalog_source_unavailable', 'tts_profile_source_unavailable', 'tts_profile_voice_incompatible', 'tts_inherited_profile_source_unavailable', 'tts_inherited_profile_incompatible', 'tts_model_selection_unavailable', 'tts_model_lock_ambiguous', 'tts_catalog_compatibility_unavailable', 'tts_catalog_compatibility_changed'].includes(error.message) ? error.message : 'configured_tts_plan_unavailable'
      initialOutcomes.push(outcome(entry.subject, 'unavailable', reason))
    }
  }
  await refreshSettingsOperationAuthority(admission); checkPreparation()
  // Only a selected account-only fact adds this dependency. Local/static/saved choices never do.
  for (const item of targets) if (item.plan.accountChoice) {
    const ctx = createManagementAdapterContext(admission, () => ticket.context, Math.min(Date.now() + 10_000, ticket.expiresAt, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity), { assertCurrent: checkPreparation })
    const current = await checkConfiguredTtsAccountSource(ctx, item.target, item.plan.accountChoice.source)
    checkPreparation()
    if (current.status !== 'current') throw new AppActionsManagementRefusal('TTS_ACCOUNT_SOURCE_CHANGED', 'The held account source is unavailable or changed. Read a fresh report; nothing was saved.', 409)
    assertConfiguredTtsAccountEnvironment(item.plan.accountChoice.source)
  }
  let reviewExpiresAt = Math.min(Date.now() + APP_ACTIONS_REVIEW_LIFETIME_MS, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity)
  const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw, permission: 'allow', preview, initialOutcomes,
    preimages: { authority: admission.fence, targets: targets.map(item => ({ subject: item.subject, snapshot: item.target.snapshot, sourceLifecycle: item.plan.sourceLifecycle, environment: item.target.environment, selection: item.plan.selection, guards: item.plan.guards,
      ...(item.plan.accountChoice ? { accountObservation: item.plan.accountChoice } : {}) })) }, authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt,
    async refresh() {
      await refreshSettingsOperationAuthority(admission); reports.assertCurrent(ticket)
      for (const item of targets) {
        assertSettingsLifecycle(item.target.snapshot.lifecycle); assertSettingsLifecycle(item.plan.sourceLifecycle); item.target.checkEnvironment(); item.plan.checkCatalog()
        if (item.plan.accountChoice) {
          const ctx = createManagementAdapterContext(admission, () => ticket.context, Math.min(Date.now() + 10_000, reviewExpiresAt), {
            assertCurrent: () => reports.assertCurrent(ticket), ...(admission.actor.kind === 'native' ? { signal: nativeSettingsSignal(ticket.context) } : {})
          })
          const current = await checkConfiguredTtsAccountSource(ctx, item.target, item.plan.accountChoice.source)
          if (current.status !== 'current') throw new AppActionsManagementRefusal('TTS_ACCOUNT_SOURCE_CHANGED', 'The captured account source changed; this operation cannot proceed.', 409)
          assertConfiguredTtsAccountEnvironment(item.plan.accountChoice.source)
        }
      }
      reports.assertCurrent(ticket)
      if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
      if (Date.now() >= reviewExpiresAt) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'Reply voice selection expired.', 409)
    },
    admitContext: async current => { await reports.forCapturedOperation(ticket, current, lane) }, continuation: () => reports.continuation(ticket, ticket.context, lane),
    async execute(execution) {
      const outcomes: AppActionsTargetOutcome[] = []; let ended: string | undefined
      for (const item of targets) {
        if (ended) { const blocked = outcome(item.subject, 'blocked', ended); outcomes.push(blocked); execution.recordOutcome(blocked); continue }
        let saved = false, published = false
        const deadlineAt = Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity)
        const publish = () => { if (!published) { published = true; void publishUserEvent(admission.actor.userId, { type: 'agent_settings_changed', agentId: item.subject.id, family: 'voice-selection' }) } }
        const check = () => { reports.assertCurrent(ticket); requireSettingsSubjectAdmission(admission, item.subject); execution.checkNative?.(); item.target.checkEnvironment(); item.plan.checkCatalog();
          if (item.plan.accountChoice) assertConfiguredTtsAccountEnvironment(item.plan.accountChoice.source)
          assertSettingsLifecycle(item.plan.sourceLifecycle); if (execution.signal.aborted || Date.now() >= deadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'Reply voice selection ended.', 409) }
        try {
          await refreshSettingsOperationAuthority(admission); check(); execution.targetStarted(item.subject)
          await redis.updateAgent(item.subject.id, {}, { expectedTtsSelection: item.target.snapshot.revision, configuredTtsMutation: {
            target: item.target.snapshot, selection: item.plan.selection, sources: item.plan.guards, sourceLifecycle: item.plan.sourceLifecycle, check, signal: execution.signal, deadlineAt, authority: admission.fence,
            onSaved() { saved = true; execution.recordOutcome({ subject: item.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_pending' }); publish() }
          } })
          let readback: AppActionsTargetOutcome['readback'] = 'unavailable'
          try { const current = await store.readConfiguredTts!(admission.actor.userId, item.subject.id); readback = JSON.stringify(current.snapshot.lifecycle) === JSON.stringify(item.target.snapshot.lifecycle) && CONFIGURED_TTS_FIELDS.every(field => current.selection[field] === item.plan.selection[field]) ? 'verified' : 'changed' } catch { /* Save already recorded. */ }
          const applied: AppActionsTargetOutcome = { subject: item.subject, status: 'applied', saved: 'saved', readback, visible: 'unknown' }; outcomes.push(applied); execution.recordOutcome(applied)
        } catch (error) {
          const unknown = error instanceof ConfiguredTtsSaveUnconfirmedError
          const result: AppActionsTargetOutcome = saved ? { subject: item.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_unavailable' } : unknown ? { subject: item.subject, status: 'unknown', saved: 'unknown', readback: 'unavailable', visible: 'unknown', reason: 'save_outcome_unconfirmed' } : outcome(item.subject, (error as { status?: number })?.status === 409 ? 'conflict' : 'unavailable', 'tts_unavailable_before_write')
          outcomes.push(result); execution.recordOutcome(result)
          if (unknown) { ended = 'prior_target_outcome_unknown'; publish() } else if (!saved && (execution.signal.aborted || Date.now() >= deadlineAt)) ended = 'operation_no_longer_admitted'
        }
      }
      return outcomes
    } })
  reviewExpiresAt = Date.parse(operation.reviewExpiresAt)
  return { input, admission, operation, gate: targets.length > 0 }
}
