import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_BUDGET_MS, parseMcpConfigurationChanges, composeMcpManagementMode, mcpConfigurationEffects, type McpGatewaySaveReview } from '$lib/appActions/settings/mcpConfiguration'
import { APP_ACTIONS_REVIEW_LIFETIME_MS } from '$lib/appActions/settings/managementContract'
import type { ManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { apiKeyService } from '$lib/services/apiKey.server'
import { mcpGatewayService } from '../../mcpGatewayService'
import type { ConditionalSettingsStore } from '../settings/conditionalAgentSettings'
import { hashControlInput } from '../../controlApprovals'
import { savePreparedMcpPrerequisite, savePreparedMcpGateway } from '../../mcpGatewaySave'
import type { createSettingsOperationRegistry } from '../settings/operationRegistry'
import { createManagementAdapterContext } from '../adapterContext'
import { AppActionsManagementRefusal } from '../settings/authority'
import { nativeSettingsSignal, type SettingsManagementAdmission, type SettingsManagementContext } from '../settings/managementActor'
import { assertMcpReportCurrent, refreshMcpReport, type McpGatewayReportTicket } from './gatewayReport'
import { captureP5ApiManagement, assertP5ApiOperationOwner } from './originalTask'

type Registry = ReturnType<typeof createSettingsOperationRegistry>
type Change = Extract<ManagedSettingsChangeInput, { op: 'change' }>
/** The only production prepared-plan issuer is this existing, genuinely approved registry recipe. */
export async function prepareMcpGatewayChange(registry: Registry, context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown,
  input: Change, admission: SettingsManagementAdmission, ticket: McpGatewayReportTicket, request: Readonly<{ check(): void; deadlineAt: number }>, store: ConditionalSettingsStore) {
  request.check()
  const change = parseMcpConfigurationChanges(input.changes), held = ticket.prepared
  if (change.target !== undefined) return preparePrerequisite(registry, context, lane, raw, input, admission, ticket, request, store, change)
  if (input.semanticId !== MCP_CONFIGURATION_ID || !held || held.review.candidateId !== change.source.candidateId) {
    throw new AppActionsManagementRefusal('MCP_CANDIDATE_REQUIRED', 'Use this report’s exact held source candidate.', 409)
  }
  const permission = admission.policy.management.mcpManagement
  if (permission === 'block') throw new AppActionsManagementRefusal('MCP_MANAGEMENT_BLOCKED', 'The user blocked MCP management.')
  const review: McpGatewaySaveReview = structuredClone(held.review)
  const preview = { semanticId: MCP_CONFIGURATION_ID, targets: [] as [], excluded: [] as [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: review }
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 65_536) throw new AppActionsManagementRefusal('MCP_PREVIEW_BUDGET', 'The complete MCP review exceeds its budget.', 409)
  const refs = [...new Set([...(review.after.savedKeyRef ? [review.after.savedKeyRef] : []), ...(review.after.stdio?.envRefs.map(row => row.savedKeyRef) ?? [])])]
  let reviewExpiresAt = Math.min(Date.now() + APP_ACTIONS_REVIEW_LIFETIME_MS, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity)
  async function refresh(checkRequest: () => void = () => {}) {
    await refreshMcpReport(ticket, ticket.context, lane, checkRequest)
    checkRequest()
    assertMcpReportCurrent(ticket)
    await mcpGatewayService.assertPreparedGatewayCurrent(held!.plan)
    checkRequest()
    assertMcpReportCurrent(ticket)
    for (const ref of refs) {
      const current = await apiKeyService.readReferenceState(ref, admission.actor.userId)
      checkRequest()
      const original = held!.keyFences.find(fence => fence.key === current.key)
      if (!original || original.paths.length !== 1 || original.paths[0][0] !== '$' || original.paths[0][1] !== current.raw || !current.present || !current.shapeValid) {
        throw new AppActionsManagementRefusal('MCP_KEY_REFERENCE_CHANGED', 'A held saved-key reference changed. Request a fresh plan.', 409)
      }
      assertMcpReportCurrent(ticket)
    }
    if (Date.now() >= reviewExpiresAt) throw new AppActionsManagementRefusal('REVIEW_EXPIRED', 'The exact MCP review expired.', 409)
  }
  await refresh(request.check)
  request.check()
  const heldApiRun = context.p5ApiRun
  let capturedOperationId: string | undefined
  const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw, preview, resource: review.resource,
    permission, initialOutcomes: [], authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt,
    // No encrypted/raw source/key cut, structural AdapterContext or opaque token enters cloned/digested DTOs.
    preimages: { planId: review.planId, disclosure: review }, refresh,
    async admitContext(current) { await refreshMcpReport(ticket, current, lane) },
    async execute(execution) {
      if (!execution.recordResourceOutcome || execution.deadlineAt > Date.now() + MCP_CONFIGURATION_BUDGET_MS) throw new AppActionsManagementRefusal('MCP_RESOURCE_RECIPE_REQUIRED', 'The real MCP execution recipe is unavailable.', 409)
      const adapter = createManagementAdapterContext(ticket.admission, () => ticket.context, execution.deadlineAt, {
        signal: execution.signal,
        assertCurrent() { assertMcpReportCurrent(ticket); execution.checkNative?.() },
        assertPermission() { if (ticket.admission.policy.management.mcpManagement === 'block') throw new AppActionsManagementRefusal('MCP_MANAGEMENT_BLOCKED', 'The user blocked MCP management.') }
      })
      adapter.assertCurrent()
      if (lane === 'native') nativeSettingsSignal(ticket.context)
      // After the real consumed approval, BEFORE effect. Only the genuine in-process
      // API run can join its original task; portable and ordinary saves do not.
      if (!capturedOperationId) throw new AppActionsManagementRefusal('MCP_RESOURCE_RECIPE_REQUIRED', 'The original execution recipe is unavailable.', 409)
      if (heldApiRun) {
        // Missing/new in-process context must never downgrade a held API recipe.
        assertP5ApiOperationOwner(heldApiRun, ticket.context.p5ApiRun)
      }
      const apiOriginal = lane === 'native' ? captureP5ApiManagement(ticket.context, review.resource.gatewayId,
        { requestId: input.requestId, operationId: capturedOperationId }) : undefined
      await savePreparedMcpGateway({ plan: held.plan, resource: review.resource, adapter, fences: held.keyFences,
        hasKeyReferences: refs.length > 0, record: execution.recordResourceOutcome, p5ApiManagement: apiOriginal })
      return []
    } })
  capturedOperationId = operation.operationId
  if (context.p5ApiRun) await registry.bindP5ApiMcpOperation(context, raw)
  reviewExpiresAt = Date.parse(operation.reviewExpiresAt)
  // A registry write remains a real effect even with zero scalar targets.
  return { input, admission, operation, gate: true }
}

/** One additional finite recipe in the SAME registry/executor, not a second runner. */
async function preparePrerequisite(registry: Registry, context: SettingsManagementContext, lane: 'native' | 'portable', raw: unknown,
  input: Change, admission: SettingsManagementAdmission, ticket: McpGatewayReportTicket, request: Readonly<{ check(): void; deadlineAt: number }>,
  store: ConditionalSettingsStore, change: Extract<ReturnType<typeof parseMcpConfigurationChanges>, { target: object }>) {
  const held = ticket.prerequisite, prepared = ticket.prepared
  if (input.semanticId !== MCP_CONFIGURATION_ID || !held || store !== ticket.store || lane !== 'native' || !context.p5ApiRun ||
    hashControlInput(change.target) !== hashControlInput(held.intent) ||
    change.source && change.source.candidateId !== held.review.candidateId || held.review.sourceAction === 'save' && !change.source) {
    throw new AppActionsManagementRefusal('MCP_PREREQUISITE_REQUIRED', 'Use this exact original API prerequisite report and complete intent.', 409)
  }
  const permission = composeMcpManagementMode(admission.policy.management.mcpManagement, admission.policy.protected.contextManagement, !!held.intent.zip)
  if (permission === 'block') throw new AppActionsManagementRefusal('MCP_PREREQUISITE_BLOCKED', 'The user blocked part of this complete prerequisite.')
  const review = structuredClone(held.review)
  const preview = { semanticId: MCP_CONFIGURATION_ID, targets: [{ ...review.target, subject: { ...review.target.subject }, changes: review.target.changes.map(row => ({ ...row })) }],
    excluded: [], effects: [...mcpConfigurationEffects(review)], resource: review }
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 65536) throw new AppActionsManagementRefusal('MCP_PREVIEW_BUDGET', 'The complete MCP prerequisite exceeds its review budget.', 409)
  let reviewExpiresAt = Math.min(Date.now() + APP_ACTIONS_REVIEW_LIFETIME_MS, admission.expiresAt ?? Infinity, input.hardDeadlineAt ?? Infinity)
  async function refresh(check: () => void = () => {}) {
    await refreshMcpReport(ticket, ticket.context, lane, check); check(); assertMcpReportCurrent(ticket)
    if (prepared) { await mcpGatewayService.assertPreparedGatewayCurrent(prepared.plan); check(); assertMcpReportCurrent(ticket) }
    const names = [...new Set([...(review.after?.savedKeyRef ? [review.after.savedKeyRef] : []), ...(review.after?.stdio?.envRefs.map(row => row.savedKeyRef) ?? [])])]
    for (const original of prepared?.keyFences ?? []) {
      const matching = names.filter(name => apiKeyService.storedKeyName(name, admission.actor.userId) === original.key)
      if (matching.length !== 1) throw new AppActionsManagementRefusal('MCP_KEY_REFERENCE_CHANGED', 'The exact saved-key source changed.', 409)
      const current = await apiKeyService.readReferenceState(matching[0], admission.actor.userId); check(); assertMcpReportCurrent(ticket)
      if (!current.present || !current.shapeValid || current.key !== original.key || original.paths.length !== 1 || original.paths[0][0] !== '$' || original.paths[0][1] !== current.raw) throw new AppActionsManagementRefusal('MCP_KEY_REFERENCE_CHANGED', 'The exact saved-key source changed.', 409)
    }
    if (Date.now() >= reviewExpiresAt) throw new AppActionsManagementRefusal('REVIEW_EXPIRED', 'The exact prerequisite review expired.', 409)
  }
  await refresh(request.check); request.check()
  const heldRun = context.p5ApiRun
  let operationId: string | undefined
  const operation = registry.capture({ actor: admission.actor, requestId: input.requestId, input: raw, preview, resource: review.resource,
    permission, authorityExpiresAt: admission.expiresAt, hardDeadlineAt: input.hardDeadlineAt,
    preimages: { planId: review.planId, disclosure: review }, initialOutcomes: [], refresh,
    async admitContext(current) { await refreshMcpReport(ticket, current, lane) },
    async execute(execution) {
      if (!operationId || !execution.recordResourceOutcome) throw new AppActionsManagementRefusal('MCP_RESOURCE_RECIPE_REQUIRED', 'The real prerequisite execution is unavailable.', 409)
      assertP5ApiOperationOwner(heldRun, ticket.context.p5ApiRun)
      const adapter = createManagementAdapterContext(ticket.admission, () => ticket.context, execution.deadlineAt, {
        signal: execution.signal,
        assertCurrent() { assertMcpReportCurrent(ticket); execution.checkNative?.() },
        assertPermission() {
          if (composeMcpManagementMode(ticket.admission.policy.management.mcpManagement, ticket.admission.policy.protected.contextManagement, !!review.intent.zip) === 'block') throw new AppActionsManagementRefusal('MCP_PREREQUISITE_BLOCKED', 'The user blocked part of the complete prerequisite.')
        }
      })
      adapter.assertCurrent()
      const original = captureP5ApiManagement(ticket.context, review.resource.gatewayId, { requestId: input.requestId, operationId })
      if (!original) throw new AppActionsManagementRefusal('MCP_ORIGINAL_REQUIRED', 'The actual original API owner is unavailable.', 409)
      await savePreparedMcpPrerequisite({ plan: prepared?.plan, review, target: held.postimage, store, adapter, fences: prepared?.keyFences ?? [], original,
        record: execution.recordResourceOutcome, recordTarget: execution.recordOutcome })
      return []
    } })
  operationId = operation.operationId
  await registry.bindP5ApiMcpOperation(context, raw)
  reviewExpiresAt = Date.parse(operation.reviewExpiresAt)
  return { input, admission, operation, gate: true }
}
