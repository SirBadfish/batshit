import { prepareAutoCompactChange } from './autoCompactOperations'
import { prepareConfiguredTtsChange } from './configuredTtsOperations'
import { assertMemoryEnableReadiness, type MemoryEnableReadinessSnapshot } from '../../memory/memoryEnableReadiness'
import { APP_ACTIONS_REVIEW_LIFETIME_MS } from '$lib/appActions/settings/managementContract'
import { parseSkillAccessChange } from '$lib/appActions/skillAccess'
import { createManagementAdapterContext } from '../adapterContext'
import { APP_ACTION_DEADLINE_MS } from '$lib/appActions/protocol'
import { settingsDefinition, settingsFieldDefinition } from '$lib/appActions/settings/definitions'
import { parseManagedSettingsChangeInput, type ManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import type { SettingsOwnerContext, SettingsFamily } from '$lib/appActions/settings/validation'
import type { AppActionsOperationPreview, AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { hashControlInput } from '$lib/server/services/controlApprovals'
import { AppActionsManagementRefusal } from './authority'
import {
  admitSettingsManagementActor, nativeSettingsSignal, refreshSettingsOperationAuthority, requireSettingsSubjectAdmission,
  SETTINGS_MANAGEMENT_CONTROL_IDS, type SettingsManagementAdmission, type SettingsManagementContext
} from './managementActor'
import { settingsFamilyRevision, type ConditionalSettingsStore, type SettingsSnapshot } from './conditionalAgentSettings'
import { admittedAgentSettings } from './managedStore'
import type { createSettingsManagementReports } from './managementReports'
import type { createSettingsOperationRegistry, SettingsOperationExecution } from './operationRegistry'
import { SUBJECT_SETTINGS_BINDINGS, MANAGEMENT_ADAPTER_BINDINGS } from '../managementAdapters'
import type { ManagementReportTicket } from './managementReports'
import { issueSettingsStandingConsent } from './standingConsent'
import { prepareModelSelectionChange } from './modelSelectionOperations'
import { prepareInstructionsChange } from './instructionOperations'
import { MCP_CONFIGURATION_DOMAIN, MCP_CONFIGURATION_ID, type McpResourceOutcome } from '$lib/appActions/settings/mcpConfiguration'
import { prepareMcpGatewayChange } from '../mcp/gatewayOperation'
import { mcpReportRequest } from '../mcp/gatewayReport'

type Registry = ReturnType<typeof createSettingsOperationRegistry>
type Reports = ReturnType<typeof createSettingsManagementReports>
type Change = Extract<ManagedSettingsChangeInput, { op: 'change' }>
type PreparedTarget = { subject: SettingsSubjectRef; revision: string; snapshot: SettingsSnapshot; changes: Change['changes']; memoryReadiness?: MemoryEnableReadinessSnapshot }
function outcome(subject: SettingsSubjectRef, status: AppActionsTargetOutcome['status'], reason?: string): AppActionsTargetOutcome {
  return { subject, status, ...(reason ? { reason } : {}), saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
}
/** Model-facing pages are bounded; the registry and human review retain every outcome. */
export function settingsOperationReceipt<T extends { operationId: string; outcomes: AppActionsTargetOutcome[]; resourceOutcomes?: McpResourceOutcome[] }>(result: T, offset = 0) {
  if (result.resourceOutcomes) {
    if (offset > result.resourceOutcomes.length) throw new AppActionsManagementRefusal('INVALID_OUTCOME_PAGE', 'That resource outcome page is beyond the held result.', 400)
    const resources = result.resourceOutcomes.slice(offset, offset + 32)
    const statuses = ['applied', 'unchanged', 'blocked', 'conflict', 'unavailable', 'unknown']
    const page = { ...result, resourceOutcomes: resources, outcomesSummary: Object.fromEntries(statuses.map(status => [status, 0])),
      resourceOutcomesSummary: Object.fromEntries(statuses.map(status => [status, result.resourceOutcomes!.filter(item => item.status === status).length])),
      outcomePage: { totalRecorded: result.resourceOutcomes.length, offset, returned: resources.length,
      remaining: result.resourceOutcomes.length - offset - resources.length, next: null } }
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 8192) throw new AppActionsManagementRefusal('OUTCOME_BUDGET', 'The resource receipt exceeds its bounded page budget.', 409)
    return page
  }
  if (offset > result.outcomes.length) throw new AppActionsManagementRefusal('INVALID_OUTCOME_PAGE', 'That outcome page is beyond the recorded results.', 400)
  const { outcomes, ...base } = result
  const counts = Object.fromEntries(['applied', 'unchanged', 'blocked', 'conflict', 'unavailable', 'unknown'].map(status => [status, outcomes.filter(item => item.status === status).length]))
  const selected: AppActionsTargetOutcome[] = []
  function build() {
    const end = offset + selected.length
    return { ...base, outcomes: [...selected], outcomesSummary: counts,
      outcomePage: { totalRecorded: outcomes.length, offset, returned: selected.length, remaining: outcomes.length - end,
        next: end < outcomes.length ? { op: 'outcome', operationId: result.operationId, outcomeOffset: end } : null } }
  }
  for (const item of outcomes.slice(offset)) {
    if (selected.length >= 32) break
    selected.push(item)
    if (Buffer.byteLength(JSON.stringify(build()), 'utf8') > 8192) { selected.pop(); break }
  }
  const page = build()
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 8192 || !selected.length && offset < outcomes.length) {
    throw new AppActionsManagementRefusal('OUTCOME_BUDGET', 'The operation receipt exceeded its bounded page budget.', 409)
  }
  return page
}
function ownerContext(admission: SettingsManagementAdmission, subject: SettingsSubjectRef, deadlineAt: number, execution?: SettingsOperationExecution): SettingsOwnerContext {
  return { actor: { kind: admission.actor.kind === 'native' ? 'agent' : 'portable', userId: admission.actor.userId,
    ...(admission.actor.kind === 'native' ? { actingAgentId: admission.actor.id } : {}) },
    subjectKind: subject.kind === 'subagent' ? 'subagent' : 'primary', authorityFence: admission.fence,
    signal: execution?.signal ?? admission.signal, deadlineAt,
    ...(execution ? { onSaved() { execution.recordOutcome({ subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_pending' }) } } : {}),
    check() {
      requireSettingsSubjectAdmission(admission, subject)
      execution?.checkNative?.()
      if ((execution?.signal ?? admission.signal)?.aborted || Date.now() >= deadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The admitted operation has ended.', 409)
    } }
}
export function createSettingsChanges(registry: Registry, reports: Reports, store: ConditionalSettingsStore) {
  async function prepareAliasAccess(context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown, input: Change,
    admission: SettingsManagementAdmission, ticket: ManagementReportTicket) {
    if (ticket.domain !== 'skill-access' || !ticket.skillAccess) throw new AppActionsManagementRefusal('REPORT_DOMAIN_MISMATCH', 'Request a held skill access report for this exact change.', 409)
    const permission = admission.policy.management.skillAccess
    if (permission === 'block') throw new AppActionsManagementRefusal('SKILL_ACCESS_BLOCKED', 'The user blocked skill access management.')
    const binding = MANAGEMENT_ADAPTER_BINDINGS['agent.skills.access']
    const extra = { assertCurrent: () => reports.assertCurrent(ticket), assertPermission() {
      if (!admission.policy.enabled || admission.policy.management.skillAccess === 'block') throw new AppActionsManagementRefusal('SKILL_ACCESS_BLOCKED', 'The user blocked skill access management.')
    } }
    const preparing = createManagementAdapterContext(admission, () => ticket.context,
      Math.min(Date.now() + 30_000, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity), extra)
    const prepared = await binding.prepare(preparing, ticket.skillAccess.handle, parseSkillAccessChange(input.changes))
    reports.assertCurrent(ticket)
    let reviewExpiresAt = Math.min(Date.now() + APP_ACTIONS_REVIEW_LIFETIME_MS, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity)
    const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw,
      permission: prepared.preview.targets.length ? permission : 'allow', preview: prepared.preview,
      preimages: { authority: admission.fence, plan: prepared.preimages, closure: prepared.closure },
      initialOutcomes: [...prepared.initialOutcomes], authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt,
      async refresh() {
        // Approval owns its immutable review clock, independent of the discovery read's TTL/budget.
        const current = createManagementAdapterContext(admission, () => ticket.context, reviewExpiresAt, {
          ...extra, ...(admission.actor.kind === 'native' ? { signal: nativeSettingsSignal(ticket.context) } : {})
        })
        await prepared.refresh(current)
        current.assertCurrent()
      },
      admitContext: async current => { await reports.forCapturedOperation(ticket, current, lane) },
      continuation: () => reports.continuation(ticket, ticket.context, lane),
      async execute(execution) {
        let published = false
        const tracked: SettingsOperationExecution = { ...execution, recordOutcome(item) {
          // The ledger records evidence synchronously before starting a value-free refresh.
          execution.recordOutcome(item)
          if (!published && (item.saved === 'saved' || item.saved === 'unknown')) {
            published = true
            void publishUserEvent(admission.actor.userId, { type: 'slash_commands_changed' })
          }
        } }
        const current = createManagementAdapterContext(admission, () => ticket.context,
          Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity), {
            ...extra, signal: execution.signal, assertCurrent() { reports.assertCurrent(ticket); execution.checkNative?.() }
          })
        return [...await binding.commit({ ...current, execution: tracked }, prepared.plan)]
      }
    })
    reviewExpiresAt = Date.parse(operation.reviewExpiresAt)
    return { input, admission, operation, gate: prepared.preview.targets.length > 0 }
  }
  async function prepare(context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown) {
    const input = parseManagedSettingsChangeInput(raw)
    const admission = await admitSettingsManagementActor(context, lane)
    if (input.op !== 'change') return { input, admission, operation: registry.outcome(input.operationId, admission.actor), gate: false }
    const existing = registry.existing(admission.actor, input.requestId, raw)
    if (existing) {
      // Already-captured operations own their immutable review clock. Revalidate
      // their exact held ticket/context without reviving its discovery-report TTL.
      const current = await registry.validatePending(existing.operationId, admission.actor, context)
      return { input, admission, operation: current, gate: current.status === 'awaiting_approval' || current.status === 'ready' }
    }
    if (input.semanticId === MCP_CONFIGURATION_ID) return mcpReportRequest(context, lane, async (check, deadlineAt) => {
      // The one request envelope starts BEFORE the initial held-resource refresh.
      const ticket = await reports.forOperation(input.reportId, context, lane, check)
      check()
      if (ticket.domain !== MCP_CONFIGURATION_DOMAIN) throw new AppActionsManagementRefusal('REPORT_DOMAIN_MISMATCH', 'Request an exact MCP resource report for this change.', 409)
      return prepareMcpGatewayChange(registry, context, lane, raw, input, admission, ticket, { check, deadlineAt }, store)
    })
    const ticket = await reports.forOperation(input.reportId, context, lane)
    if (ticket.domain === MCP_CONFIGURATION_DOMAIN) throw new AppActionsManagementRefusal('REPORT_DOMAIN_MISMATCH', 'An MCP resource report cannot grant a scalar Settings change.', 409)
    if (input.semanticId === 'agent.skills.access') return prepareAliasAccess(context, lane, raw, input, admission, ticket)
    if (ticket.domain === 'skill-access') throw new AppActionsManagementRefusal('REPORT_DOMAIN_MISMATCH', 'Request a Settings report for this exact change.', 409)
    if (input.semanticId === 'agent.model.selection' || input.semanticId === 'agent.model.preset-copy') return prepareModelSelectionChange(registry, reports, store, context, lane, raw, input, admission, ticket)
    if (input.semanticId === 'agent.voice.tts-selection') return prepareConfiguredTtsChange(registry, reports, store, context, lane, raw, input, admission, ticket)
    if (input.semanticId === 'agent.context.auto-compact') return prepareAutoCompactChange(registry, reports, store, context, lane, raw, input, admission, ticket)
    if (input.semanticId === 'agent.instructions') return prepareInstructionsChange(registry, reports, store, context, lane, raw, input, admission, ticket)
    const semanticId = input.semanticId
    const binding = SUBJECT_SETTINGS_BINDINGS[semanticId]
    const family: SettingsFamily = binding.family
    const definition = settingsDefinition(semanticId)
    const fixedPermission = definition.permission === 'ordinary' ? admission.policy.ordinaryChanges ? 'allow' : 'block' :
      admission.policy.protected[definition.permission]
    if (fixedPermission === 'block') throw new AppActionsManagementRefusal('SETTINGS_CHANGE_BLOCKED', 'The user blocked this Settings change category.')
    let permission: 'ask' | 'allow' = 'allow'
    const decisions: Array<Record<string, unknown>> = []
    const targets: PreparedTarget[] = []
    const initialOutcomes: AppActionsTargetOutcome[] = []
    const preview: AppActionsOperationPreview = { semanticId: input.semanticId, targets: [], excluded: ticket.manifest.excluded.map(ref => ({ ...ref })),
      effects: [...definition.effects] }
    for (const entry of ticket.manifest.entries) {
      if (entry.status !== 'available') { initialOutcomes.push(outcome(entry.subject, 'unavailable', entry.reason)); continue }
      requireSettingsSubjectAdmission(admission, entry.subject)
      if (!(definition.subjectKinds as readonly string[]).includes(entry.subject.kind) || !(definition.subjectTypes as readonly string[]).includes(entry.type!)) { initialOutcomes.push(outcome(entry.subject, 'unavailable', definition.unavailableReason)); continue }
      const snapshot = ticket.snapshots.get(settingsSubjectKey(entry.subject))!
      const revision = settingsFamilyRevision(snapshot, family)
      const args = { subjectAgentId: entry.subject.id, expectedRevision: revision, changes: input.changes }
      const owner = ownerContext(admission, entry.subject, Math.min(Date.now() + 30_000, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity))
      const result = await admittedAgentSettings.previewFamily(family, args, owner)
      if (result.status === 'blocked') { initialOutcomes.push(outcome(entry.subject, result.reason === 'revision_conflict' ? 'conflict' : 'unavailable', result.reason)); continue }
      if (result.status === 'no_op') { initialOutcomes.push(outcome(entry.subject, 'unchanged')); continue }
      const before = result.current!.values as Record<string, string | number | boolean>
      const changes = result.changes as Change['changes']
      decisions.push({ subject: entry.subject, category: definition.permission, permission: fixedPermission, revision, raw: snapshot.raw })
      if (fixedPermission === 'ask') permission = 'ask'
      targets.push({ subject: entry.subject, revision, snapshot, changes, ...(result.memoryReadiness ? { memoryReadiness: result.memoryReadiness } : {}) })
      preview.targets.push({ subject: entry.subject, label: entry.label ?? entry.subject.id,
        changes: Object.entries(changes).flatMap(([field, after]) => field === 'windowMode' && family === 'memory'
          ? ['floorMode', 'ceilingHeadroomMode'].map(mode => ({ field: mode, label: settingsFieldDefinition(semanticId, mode).label, before: before[mode], after: 'auto' }))
          : [{ field, label: settingsFieldDefinition(semanticId, field).label, before: result.current?.stored && Object.hasOwn(result.current.stored, field) ? result.current.stored[field] as string | number | boolean | null : before[field] ?? null, after }]) })
    }
    reports.assertCurrent(ticket)
    async function refresh() {
      await refreshSettingsOperationAuthority(admission)
      for (const target of targets) {
        const current = await store.read(target.subject.id, target.subject.kind === 'subagent' ? 'subagent' : 'primary')
        if (settingsFamilyRevision(current, family) !== target.revision) throw new AppActionsManagementRefusal('SETTINGS_PREIMAGE_CHANGED', 'A captured Settings value changed; request fresh exact changes.', 409)
        if (target.memoryReadiness) {
          const source = await store.readMemoryReadiness?.()
          if (!source || source.source !== target.memoryReadiness.source) throw new AppActionsManagementRefusal('MEMORY_SOURCE_CHANGED', 'The configured Memory source changed. Request fresh exact changes.', 409)
          assertMemoryEnableReadiness(target.memoryReadiness)
        }
      }
      reports.assertCurrent(ticket)
    }
    const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw, permission: targets.length ? permission : 'allow', preview,
      preimages: { authority: admission.fence, manifest: ticket.manifest, decisions, initialOutcomes, targets: targets.map(target => ({ subject: target.subject, revision: target.revision, raw: target.snapshot.raw, incarnationRaw: target.snapshot.incarnationRaw, ...(target.memoryReadiness ? { memorySource: target.memoryReadiness.source } : {}) })) },
      initialOutcomes, authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt, refresh,
      admitContext: async current => { await reports.forCapturedOperation(ticket, current, lane) },
      continuation: () => reports.continuation(ticket, ticket.context, lane),
      async execute(execution) {
        const outcomes = initialOutcomes.map(item => ({ ...item }))
        let ended: string | undefined
        for (const target of targets) {
          if (ended) { const blocked = outcome(target.subject, 'blocked', ended); outcomes.push(blocked); execution.recordOutcome(blocked); continue }
          try {
            await refreshSettingsOperationAuthority(admission)
            execution.checkNative?.()
            const deadlineAt = Math.min(execution.deadlineAt, admission.actor.kind === 'native' ? Date.now() + APP_ACTION_DEADLINE_MS : Infinity)
            const owner = ownerContext(admission, target.subject, deadlineAt, execution)
            if (target.memoryReadiness) {
              const captured = target.memoryReadiness
              owner.memoryEnableSource = { source: captured.source, check() { assertMemoryEnableReadiness(captured) } }
            }
            const args = { subjectAgentId: target.subject.id, expectedRevision: target.revision, changes: target.changes }
            execution.targetStarted(target.subject)
            const saved = await admittedAgentSettings.updateFamily(family, args, owner)
            const status: AppActionsTargetOutcome['status'] = saved.saved === 'unknown' ? 'unknown' : saved.saved === 'saved' ? 'applied' : saved.status === 'no_op' ? 'unchanged' : saved.reason === 'revision_conflict' ? 'conflict' : 'blocked'
            const confirmed = { subject: target.subject, status, ...(saved.reason ? { reason: saved.reason } : {}), saved: saved.saved, readback: saved.readback, visible: saved.visible }
            outcomes.push(confirmed)
            execution.recordOutcome(confirmed)
            if (saved.saved === 'saved' || saved.saved === 'unknown') await publishUserEvent(admission.actor.userId, {
              type: target.subject.kind === 'subagent' ? 'subagent_settings_changed' : 'agent_settings_changed', agentId: target.subject.id, family: definition.refreshFamily
            })
            if (status === 'unknown') ended = 'prior_target_outcome_unknown'
          } catch (error) {
            const blocked = outcome(target.subject, 'blocked', error instanceof AppActionsManagementRefusal ? error.code : 'target_unavailable_before_write')
            outcomes.push(blocked); execution.recordOutcome(blocked)
            ended = 'operation_no_longer_admitted'
          }
        }
        return outcomes
      } })
    return { input, admission, operation, gate: targets.length > 0 }
  }
  return {
    prepare,
    async standingConsent(context: SettingsManagementContext, raw: unknown) {
      const prepared = await prepare(context, 'native', raw)
      if (!prepared.gate || prepared.operation.status !== 'ready') return undefined
      return issueSettingsStandingConsent({ userId: context.userId, agentId: context.agentId!, controlId: SETTINGS_MANAGEMENT_CONTROL_IDS.nativeChange,
        inputHash: hashControlInput(raw), expiresAt: Date.now() + APP_ACTION_DEADLINE_MS })
    },
    async change(context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown) {
      const prepared = await prepare(context, lane, raw)
      if (prepared.input.op === 'outcome') return settingsOperationReceipt(prepared.operation, prepared.input.outcomeOffset)
      if (prepared.input.op === 'cancel') return settingsOperationReceipt(registry.cancel(prepared.input.operationId, prepared.admission.actor))
      if (lane === 'native') {
        if (!context.settingsNativeGate) throw new AppActionsManagementRefusal('NATIVE_APPROVAL_REQUIRED', 'The real native approval gate did not admit this operation.')
        context.settingsNativeGate()
        return settingsOperationReceipt(await registry.nativeExecute(prepared.operation.operationId, prepared.admission.actor, nativeSettingsSignal(context), () => { nativeSettingsSignal(context) }))
      }
      if (prepared.operation.status === 'awaiting_approval') return { ...settingsOperationReceipt(prepared.operation), code: 'user_approval_required',
        reviewUrl: `/app-actions/review/${prepared.operation.operationId}` }
      return settingsOperationReceipt(await registry.portableExecute(prepared.operation.operationId, prepared.admission.actor))
    }
  }
}
