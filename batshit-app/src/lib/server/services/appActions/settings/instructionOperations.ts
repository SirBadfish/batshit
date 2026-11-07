import { APP_ACTIONS_REVIEW_LIFETIME_MS, type AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import { APP_ACTION_DEADLINE_MS } from '$lib/appActions/protocol'
import { validateInstructionsChanges } from '$lib/appActions/settings/instructionPreferences'
import { settingsDefinition } from '$lib/appActions/settings/definitions'
import type { ManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { redis } from '$lib/server/redis'
import { instructionLeaves, makeInstructionsSnapshot, InstructionsSaveUnconfirmedError, type InstructionsSnapshot } from '$lib/server/instructionsGuard'
import { AppActionsManagementRefusal } from './authority'
import { assertSettingsLifecycle } from './lifecycle'
import { planInstructionsChanges, type InstructionsPlan } from './instructionAdapter'
import { buildInstructionsPreview, InstructionsPreviewRefusal } from './instructionPreview'
import type { InstructionTextRead } from './instructionTextSnapshot'
import { requireSettingsSubjectAdmission, refreshSettingsOperationAuthority, nativeSettingsSignal,
  type SettingsManagementAdmission, type SettingsManagementContext } from './managementActor'
import type { ConditionalSettingsStore } from './conditionalAgentSettings'
import type { createSettingsManagementReports, ManagementReportTicket } from './managementReports'
import type { createSettingsOperationRegistry } from './operationRegistry'
import { publishUserEvent } from '$lib/server/ssePublisher'

type Change = Extract<ManagedSettingsChangeInput, { op: 'change' }>
type Target = Readonly<{ subject: SettingsSubjectRef; snapshot: InstructionsSnapshot; plan: InstructionsPlan }>
const outcome = (subject: SettingsSubjectRef, status: AppActionsTargetOutcome['status'], reason?: string): AppActionsTargetOutcome =>
  ({ subject, status, ...(reason ? { reason } : {}), saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' })
const sameLifecycle = (left: InstructionTextRead, right: InstructionTextRead) => JSON.stringify(left.lifecycle) === JSON.stringify(right.lifecycle)
function beforeRecord(read: InstructionTextRead, prompt: boolean): Record<string, unknown> {
  const record = { ...read.record }
  if (prompt) {
    const descriptor = read.customPrompt
    if (!descriptor || descriptor.read !== 'available') throw new Error('Invalid saved instructions')
    if (descriptor.stored === 'set') {
      if (typeof read.text !== 'string') throw new Error('Missing captured text')
      record.system_prompt = read.text
    } else if (descriptor.representation === 'null') record.system_prompt = null
  }
  return record
}
function sameIdentity(held: InstructionTextRead, fresh: InstructionTextRead) {
  const type = held.subject.kind === 'primary' ? 'agentType' : 'subagentType'
  return sameLifecycle(held, fresh) && ['id', 'user_id', 'created_at', type].every(field => held.record[field] === fresh.record[field])
}
function savedPlan(read: InstructionTextRead, plan: InstructionsPlan): boolean {
  const record = beforeRecord(read, plan.effects.customPromptChanged)
  return plan.writes.every(write => write.op === 'delete' ? !Object.hasOwn(record, write.field) :
    Object.hasOwn(record, write.field) && record[write.field] === write.value)
}

/** Same existing operation/Ask owner; no instruction text enters model-facing receipts. */
export async function prepareInstructionsChange(registry: ReturnType<typeof createSettingsOperationRegistry>, reports: ReturnType<typeof createSettingsManagementReports>,
  store: ConditionalSettingsStore, context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown, input: Change,
  admission: SettingsManagementAdmission, ticket: ManagementReportTicket) {
  const changes = validateInstructionsChanges(input.changes)
  const mode = admission.policy.protected.instructions
  if (mode === 'block') throw new AppActionsManagementRefusal('SETTINGS_CHANGE_BLOCKED', 'The user blocked instruction changes.')
  if (!store.readInstructions) throw new AppActionsManagementRefusal('INSTRUCTIONS_READ_UNAVAILABLE', 'The fixed instruction owner is unavailable.', 503)
  const prompt = Object.hasOwn(changes, 'customPrompt')
  const inclusion = Object.hasOwn(changes, 'includeGlobalPrompt')
  const targets: Target[] = []
  const rows: Parameters<typeof buildInstructionsPreview>[0][number][] = []
  const initialOutcomes: AppActionsTargetOutcome[] = []
  const definition = settingsDefinition('agent.instructions')
  const checkPreparation = () => {
    reports.assertCurrent(ticket)
    if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
    else if (Date.now() >= (admission.expiresAt ?? 0)) throw new AppActionsManagementRefusal('GRANT_EXPIRED', 'The token grant expired.')
    if (input.hardDeadlineAt !== undefined && Date.now() >= input.hardDeadlineAt) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'The instruction change deadline expired.', 409)
  }
  for (const entry of ticket.manifest.entries) {
    if (entry.status !== 'available') { initialOutcomes.push(outcome(entry.subject, 'unavailable', entry.reason)); continue }
    requireSettingsSubjectAdmission(admission, entry.subject)
    const held = ticket.instructions.get(settingsSubjectKey(entry.subject))
    if (!held) { initialOutcomes.push(outcome(entry.subject, 'unavailable', 'instructions_report_required')); continue }
    if (prompt && (!held.promptPreimage || held.customPrompt?.read !== 'available')) {
      initialOutcomes.push(outcome(entry.subject, 'unavailable', held.customPrompt?.read === 'too_large' ? 'instructions_text_too_large' : 'saved_instructions_invalid')); continue
    }
    try {
      checkPreparation()
      const fresh = await store.readInstructions(admission.actor.userId, entry.subject.id, entry.subject.kind === 'subagent' ? 'subagent' : 'primary', { includeText: prompt, prompt })
      checkPreparation(); requireSettingsSubjectAdmission(admission, entry.subject)
      if (!sameIdentity(held, fresh) || prompt && held.promptPreimage !== fresh.promptPreimage || inclusion &&
        new Map(held.raw).get('$.include_global_prompt') !== new Map(fresh.raw).get('$.include_global_prompt')) {
        initialOutcomes.push(outcome(entry.subject, 'conflict', 'instructions_changed_since_report')); continue
      }
      const before = beforeRecord(fresh, prompt)
      const plan = planInstructionsChanges(entry, before, changes)
      if (!plan.writes.length) { initialOutcomes.push(outcome(entry.subject, 'unchanged')); continue }
      const fields = instructionLeaves(plan.updates)
      const snapshot = makeInstructionsSnapshot(entry.subject.id, entry.subject.kind === 'subagent' ? 'subagent' : 'agent', fresh.raw, fresh.lifecycle, fields)
      targets.push(Object.freeze({ subject: entry.subject, snapshot, plan }))
      rows.push({ subject: entry.subject, label: entry.label ?? entry.subject.id, before, plan })
      // A partial table can only grow. Refuse the whole operation before reading more
      // subjects if its complete disclosure already cannot fit; never drop rows to fit.
      buildInstructionsPreview(rows, ticket.manifest.excluded, definition.effects)
    } catch (error) {
      if (error instanceof InstructionsPreviewRefusal) throw new AppActionsManagementRefusal(error.code, error.message, 409)
      checkPreparation(); requireSettingsSubjectAdmission(admission, entry.subject)
      initialOutcomes.push(outcome(entry.subject, 'unavailable', 'instructions_plan_unavailable'))
    }
  }
  const preview = buildInstructionsPreview(rows, ticket.manifest.excluded, definition.effects)
  await refreshSettingsOperationAuthority(admission)
  checkPreparation()
  let reviewExpiresAt = Math.min(Date.now() + APP_ACTIONS_REVIEW_LIFETIME_MS, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity)
  const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw,
    permission: targets.length ? mode : 'allow', preview, initialOutcomes, preimages: { authority: admission.fence, targets },
    authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt,
    async refresh() {
      await refreshSettingsOperationAuthority(admission)
      reports.assertCurrent(ticket)
      for (const target of targets) assertSettingsLifecycle(target.snapshot.lifecycle)
      if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
      if (Date.now() >= reviewExpiresAt) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'The instruction review expired.', 409)
    },
    admitContext: async current => { await reports.forCapturedOperation(ticket, current, lane) },
    continuation: () => reports.continuation(ticket, ticket.context, lane),
    async execute(execution) {
      const outcomes: AppActionsTargetOutcome[] = []
      let ended: string | undefined
      for (const target of targets) {
        if (ended) { const item = outcome(target.subject, 'blocked', ended); outcomes.push(item); execution.recordOutcome(item); continue }
        let saved = false, published = false
        const kind = target.subject.kind === 'subagent' ? 'subagent' : 'agent'
        const deadlineAt = Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity)
        const publish = () => {
          if (published) return
          published = true
          void publishUserEvent(admission.actor.userId, { type: kind === 'subagent' ? 'subagent_settings_changed' : 'agent_settings_changed', agentId: target.subject.id, family: 'instructions' })
        }
        const check = () => {
          reports.assertCurrent(ticket); requireSettingsSubjectAdmission(admission, target.subject); execution.checkNative?.()
          assertSettingsLifecycle(target.snapshot.lifecycle)
          if (execution.signal.aborted || Date.now() >= deadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The instruction operation ended.', 409)
        }
        try {
          await refreshSettingsOperationAuthority(admission)
          check(); execution.targetStarted(target.subject)
          const options = { expectedInstructions: target.snapshot.revisions, instructionsMutation: { target: target.snapshot, check,
            signal: execution.signal, deadlineAt, authority: admission.fence,
            onSaved() { saved = true; execution.recordOutcome({ subject: target.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_pending' }); publish() } } }
          if (kind === 'agent') await redis.updateAgent(target.subject.id, target.plan.updates, options)
          else if (!await redis.updateSubagent(target.subject.id, target.plan.updates, options)) throw new Error('The instruction target is gone.')
          let readback: AppActionsTargetOutcome['readback'] = 'unavailable'
          try {
            const current = await store.readInstructions!(admission.actor.userId, target.subject.id, target.subject.kind === 'subagent' ? 'subagent' : 'primary',
              { includeText: target.plan.effects.customPromptChanged, prompt: target.plan.effects.customPromptChanged })
            readback = JSON.stringify(current.lifecycle) === JSON.stringify(target.snapshot.lifecycle) && savedPlan(current, target.plan) ? 'verified' : 'changed'
          } catch { /* The synchronous known-save ledger owns evidence before this read. */ }
          const item: AppActionsTargetOutcome = { subject: target.subject, status: 'applied', saved: 'saved', readback, visible: 'unknown' }
          outcomes.push(item); execution.recordOutcome(item)
        } catch (error) {
          const unknown = error instanceof InstructionsSaveUnconfirmedError
          const item: AppActionsTargetOutcome = saved ? { subject: target.subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_unavailable' } : unknown
            ? { subject: target.subject, status: 'unknown', saved: 'unknown', readback: 'unavailable', visible: 'unknown', reason: 'save_outcome_unconfirmed' }
            : outcome(target.subject, (error as { status?: number })?.status === 409 ? 'conflict' : 'unavailable', 'instructions_unavailable_before_write')
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
