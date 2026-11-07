import { APP_ACTIONS_REVIEW_LIFETIME_MS, type AppActionsTargetOutcome, type AppActionsOperationPreview } from '$lib/appActions/settings/managementContract'
import { APP_ACTION_DEADLINE_MS } from '$lib/appActions/protocol'
import { validateAutoCompactChanges } from '$lib/appActions/settings/autoCompactPreferences'
import { settingsDefinition, settingsFieldDefinition } from '$lib/appActions/settings/definitions'
import type { ManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { settingsSubjectKey, type SettingsSubjectRef, type SettingsReportValue } from '$lib/appActions/settings/reportContract'
import { redis } from '$lib/server/redis'
import { AutoCompactSaveUnconfirmedError, type AutoCompactSnapshot } from '$lib/server/autoCompactGuard'
import { AppActionsManagementRefusal } from './authority'
import { assertSettingsLifecycle } from './lifecycle'
import { planAutoCompactChanges } from './autoCompactAdapter'
import { requireSettingsSubjectAdmission, refreshSettingsOperationAuthority, nativeSettingsSignal, type SettingsManagementAdmission, type SettingsManagementContext } from './managementActor'
import type { ConditionalSettingsStore } from './conditionalAgentSettings'
import type { createSettingsManagementReports, ManagementReportTicket } from './managementReports'
import type { createSettingsOperationRegistry } from './operationRegistry'
import { publishUserEvent } from '$lib/server/ssePublisher'

type Change = Extract<ManagedSettingsChangeInput, { op: 'change' }>
type Plan = ReturnType<typeof planAutoCompactChanges>
type Target = Readonly<{ subject: SettingsSubjectRef; snapshot: AutoCompactSnapshot; plan: Plan }>
const outcome = (subject: SettingsSubjectRef, status: AppActionsTargetOutcome['status'], reason?: string): AppActionsTargetOutcome =>
  ({ subject, status, ...(reason ? { reason } : {}), saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' })
const effective = (value: SettingsReportValue) => value.effective.state === 'known' ? `${value.source}: ${value.effective.value}` : value.effective.reason
const sameGlobal = (held: AutoCompactSnapshot, fresh: AutoCompactSnapshot, plan: Plan) => !plan.globalFields.length || held.globalType === fresh.globalType && plan.globalFields.every(field => held.globalRaw[field] === fresh.globalRaw[field])

/** Fixed preferences use the existing operation and exact Ask owners. No runtime execution. */
export async function prepareAutoCompactChange(registry: ReturnType<typeof createSettingsOperationRegistry>, reports: ReturnType<typeof createSettingsManagementReports>,
  store: ConditionalSettingsStore, context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown, input: Change,
  admission: SettingsManagementAdmission, ticket: ManagementReportTicket) {
  const changes = validateAutoCompactChanges(input.changes), mode = admission.policy.protected.contextManagement
  if (mode === 'block') throw new AppActionsManagementRefusal('SETTINGS_CHANGE_BLOCKED', 'The user blocked Context management changes.')
  if (!store.readAutoCompact) throw new AppActionsManagementRefusal('AUTO_COMPACT_READ_UNAVAILABLE', 'The Auto Compact preference owner is unavailable.', 503)
  const definition = settingsDefinition('agent.context.auto-compact'), targets: Target[] = [], initialOutcomes: AppActionsTargetOutcome[] = []
  const preview: AppActionsOperationPreview = { semanticId: definition.id, targets: [], excluded: ticket.manifest.excluded.map(subject => ({ ...subject })), effects: [...definition.effects] }
  const checkPreparation = () => {
    reports.assertCurrent(ticket)
    if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
    else if (Date.now() >= (admission.expiresAt ?? 0)) throw new AppActionsManagementRefusal('GRANT_EXPIRED', 'The token grant expired.')
    if (Date.now() >= ticket.expiresAt || input.hardDeadlineAt !== undefined && Date.now() >= input.hardDeadlineAt) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'The Auto Compact preparation expired.', 409)
  }
  for (const entry of ticket.manifest.entries) {
    if (entry.status !== 'available') { initialOutcomes.push(outcome(entry.subject, 'unavailable', entry.reason)); continue }
    requireSettingsSubjectAdmission(admission, entry.subject)
    if (entry.subject.kind !== 'primary' || entry.type !== 'api') { initialOutcomes.push(outcome(entry.subject, 'unavailable', 'auto_compact_primary_only')); continue }
    const held = ticket.autoCompact.get(settingsSubjectKey(entry.subject))
    if (!held) { initialOutcomes.push(outcome(entry.subject, 'unavailable', 'auto_compact_report_required')); continue }
    try {
      checkPreparation()
      const fresh = await store.readAutoCompact(admission.actor.userId, entry.subject.id)
      checkPreparation(); requireSettingsSubjectAdmission(admission, entry.subject)
      const plan = planAutoCompactChanges(entry, fresh.record, changes)
      if (fresh.revision !== held.revision || !sameGlobal(held, fresh, plan)) { initialOutcomes.push(outcome(entry.subject, 'conflict', 'auto_compact_changed_since_report')); continue }
      if (!Object.keys(plan.changes).length) { initialOutcomes.push(outcome(entry.subject, 'unchanged')); continue }
      if (plan.before.status !== 'available' || plan.after.status !== 'available') throw new Error('Unavailable Auto Compact plan')
      targets.push(Object.freeze({ subject: entry.subject, snapshot: fresh, plan }))
      const before = plan.before.fields, after = plan.after.fields
      preview.targets.push({ subject: entry.subject, label: entry.label ?? entry.subject.id, changes: Object.entries(plan.changes).map(([field, value]) => {
        const prior = before[field] as SettingsReportValue, next = after[field] as SettingsReportValue
        return { field, label: `${settingsFieldDefinition(definition.id, field).label} (effective ${effective(prior)} → ${effective(next)})`,
          before: prior.stored.state === 'set' ? prior.stored.value : '(unset)', after: value }
      }) })
    } catch {
      checkPreparation(); requireSettingsSubjectAdmission(admission, entry.subject)
      initialOutcomes.push(outcome(entry.subject, 'unavailable', 'auto_compact_plan_unavailable'))
    }
  }
  await refreshSettingsOperationAuthority(admission)
  checkPreparation()
  let reviewExpiresAt = Math.min(Date.now() + APP_ACTIONS_REVIEW_LIFETIME_MS, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity)
  const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw, permission: targets.length ? mode : 'allow', preview, initialOutcomes,
    preimages: { authority: admission.fence, targets }, authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt,
    async refresh() {
      await refreshSettingsOperationAuthority(admission)
      reports.assertCurrent(ticket)
      for (const target of targets) assertSettingsLifecycle(target.snapshot.lifecycle)
      if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
      if (Date.now() >= reviewExpiresAt) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'The Auto Compact review expired.', 409)
    },
    admitContext: async current => { await reports.forCapturedOperation(ticket, current, lane) },
    continuation: () => reports.continuation(ticket, ticket.context, lane),
    async execute(execution) {
      const outcomes: AppActionsTargetOutcome[] = []
      let ended: string | undefined
      for (const target of targets) {
        if (ended) { const item = outcome(target.subject, 'blocked', ended); outcomes.push(item); execution.recordOutcome(item); continue }
        let saved = false, published = false
        const deadlineAt = Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity)
        const publish = () => { if (!published) { published = true; void publishUserEvent(admission.actor.userId, { type: 'agent_settings_changed', agentId: target.subject.id, family: 'auto-compact' }) } }
        const check = () => {
          reports.assertCurrent(ticket); requireSettingsSubjectAdmission(admission, target.subject); execution.checkNative?.(); assertSettingsLifecycle(target.snapshot.lifecycle)
          if (execution.signal.aborted || Date.now() >= deadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The Auto Compact operation ended.', 409)
        }
        try {
          await refreshSettingsOperationAuthority(admission); check(); execution.targetStarted(target.subject)
          await redis.updateAgent(target.subject.id, {}, { expectedAutoCompact: target.snapshot.revision,
            autoCompactMutation: { target: target.snapshot, changes: target.plan.changes, globalFields: target.plan.globalFields, check, signal: execution.signal, deadlineAt, authority: admission.fence,
              onSaved() { saved = true; execution.recordOutcome({ subject: target.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_pending' }); publish() } } })
          let readback: AppActionsTargetOutcome['readback'] = 'unavailable'
          try {
            const current = await store.readAutoCompact!(admission.actor.userId, target.subject.id)
            const common = current.record.auto_compact_settings as Record<string, unknown> | undefined
            readback = JSON.stringify(current.lifecycle) === JSON.stringify(target.snapshot.lifecycle) && Object.entries(target.plan.changes).every(([field, value]) => common && Object.hasOwn(common, field) && common[field] === value) ? 'verified' : 'changed'
          } catch { /* Known save remains authoritative before readback. */ }
          const item: AppActionsTargetOutcome = { subject: target.subject, status: 'applied', saved: 'saved', readback, visible: 'unknown' }
          outcomes.push(item); execution.recordOutcome(item)
        } catch (error) {
          const unknown = error instanceof AutoCompactSaveUnconfirmedError
          const item: AppActionsTargetOutcome = saved ? { subject: target.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_unavailable' } : unknown
            ? { subject: target.subject, status: 'unknown', saved: 'unknown', readback: 'unavailable', visible: 'unknown', reason: 'save_outcome_unconfirmed' }
            : outcome(target.subject, (error as { status?: number })?.status === 409 ? 'conflict' : 'unavailable', 'auto_compact_unavailable_before_write')
          outcomes.push(item); execution.recordOutcome(item)
          if (unknown) { ended = 'prior_target_outcome_unknown'; publish() }
          else if (!saved && (execution.signal.aborted || Date.now() >= deadlineAt)) ended = 'operation_no_longer_admitted'
        }
      }
      return outcomes
    }
  })
  reviewExpiresAt = Date.parse(operation.reviewExpiresAt)
  return { input, admission, operation, gate: targets.length > 0 }
}
