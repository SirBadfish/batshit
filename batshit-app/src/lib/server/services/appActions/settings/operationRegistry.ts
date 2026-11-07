import type { P5ApiOriginalRun } from '../mcp/originalTask'
import { MODEL_PRESET_COPY_ID, isModelPresetCopyReview, isModelPresetCopyOutcome, type ModelPresetCopyOutcome } from '$lib/appActions/settings/modelSelectionPreferences'
import { randomBytes } from 'node:crypto'
import { hashControlInput } from '$lib/server/services/controlApprovals'
import {
  APP_ACTIONS_EXECUTION_BUDGET_MS, APP_ACTIONS_REVIEW_LIFETIME_MS,
  type AppActionsApprovalPreview, type AppActionsOperationPreview, type AppActionsOperationReview, type AppActionsOperationStatus, type AppActionsTargetOutcome
} from '$lib/appActions/settings/managementContract'
import { AppActionsManagementRefusal } from './authority'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import type { SettingsManagementContext, SettingsOperationActor, SettingsOperationExecution } from '../managementTypes'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_BUDGET_MS, MCP_REPORT_BUDGET_MS, mcpConfigurationTargetsMatch, isMcpConfigurationReview, isMcpResourceOutcome, type McpConfigurationResource, type McpResourceOutcome } from '$lib/appActions/settings/mcpConfiguration'
import type { P5HeldMcpRecipe } from '../mcp/originalTask'
export type { SettingsOperationActor, SettingsOperationExecution } from '../managementTypes'

export type SettingsOperationRecipe = {
  actor: SettingsOperationActor
  requestId: string
  input: unknown
  preview: AppActionsOperationPreview
  preimages: unknown
  initialOutcomes?: AppActionsTargetOutcome[]
  permission: 'ask' | 'allow'
  authorityExpiresAt?: number
  hardDeadlineAt?: number
  resource?: McpConfigurationResource
  presetCopy?: { current(): ModelPresetCopyOutcome }
  refresh(): Promise<void>
  admitContext?(context: SettingsManagementContext): Promise<void>
  execute(context: SettingsOperationExecution): Promise<AppActionsTargetOutcome[]>
  continuation?(): Promise<Record<string, unknown>>
}
type StoredOperation = {
  apiOwner?: P5ApiOriginalRun
  id: string; inputHash: string; intentDigest: string; recipe: SettingsOperationRecipe
  status: AppActionsOperationStatus; reviewExpiresAt: number; executionDeadlineAt: number | null
  outcomes: AppActionsTargetOutcome[]; reason?: string; abort: AbortController; flight?: Promise<void>
  resourceOutcomes: McpResourceOutcome[]
  continuation?: Record<string, unknown>; continuationUnavailable?: string
}
function actorKey(actor: SettingsOperationActor): string { return `${actor.userId}:${actor.kind}:${actor.id}:${actor.sessionId ?? ''}` }
function clone<T>(value: T): T { return structuredClone(value) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
/** Boot-local, finite replay ledger. IDs/tombstones are never evicted into write eligibility. */
export function createSettingsOperationRegistry(now = () => Date.now()) {
  const boot = randomBytes(12).toString('hex')
  const operations = new Map<string, StoredOperation>()
  const requests = new Map<string, string>()
  const heldMcpRecipes = new WeakMap<object, StoredOperation>()
  function recordOutcome(op: StoredOperation, outcome: AppActionsTargetOutcome) {
    const key = settingsSubjectKey(outcome.subject)
    const index = op.outcomes.findIndex(item => settingsSubjectKey(item.subject) === key)
    // Later uncertainty cannot erase an already confirmed effect from this operation.
    if (index >= 0 && op.outcomes[index].saved === 'saved' && outcome.saved !== 'saved') return
    if (index < 0) op.outcomes.push(clone(outcome)); else op.outcomes[index] = clone(outcome)
  }
  function read(id: string, actor?: SettingsOperationActor): StoredOperation {
    if (!id.startsWith(`aso_${boot}_`)) throw new AppActionsManagementRefusal('STALE_OPERATION', 'That operation belongs to a different app start. Its result may be unknown; do not repeat the change.', 409)
    const op = operations.get(id)
    if (!op) throw new AppActionsManagementRefusal('OPERATION_NOT_FOUND', 'That operation is unavailable.', 404)
    if (actor && (actorKey(actor) !== actorKey(op.recipe.actor) || actor.generation !== op.recipe.actor.generation)) throw new AppActionsManagementRefusal('OPERATION_NOT_ALLOWED', 'This operation belongs to different authority.')
    if ((op.status === 'ready' || op.status === 'awaiting_approval') && now() >= op.reviewExpiresAt) { op.status = 'expired'; op.reason = 'review_expired' }
    return op
  }
  function result(op: StoredOperation) {
    return clone({ operationId: op.id, intentDigest: op.intentDigest, status: op.status, outcomes: op.outcomes,
      totalTargets: op.recipe.preview.targets.length + (op.recipe.initialOutcomes?.length ?? 0),
      outcomesPending: op.recipe.preview.targets.length + (op.recipe.initialOutcomes?.length ?? 0) - op.outcomes.length,
      ...(op.recipe.presetCopy ? { presetCopyOutcome: op.recipe.presetCopy.current() } : {}),
      ...(op.recipe.resource ? { resourceOutcomes: op.resourceOutcomes, totalResources: 1, resourcesPending: 1 - op.resourceOutcomes.length } : {}),
      ...(op.continuation ? { continuation: op.continuation } : {}),
      ...(op.continuationUnavailable ? { continuationUnavailable: op.continuationUnavailable } : {}),
      ...(op.reason ? { reason: op.reason } : {}), reviewExpiresAt: new Date(op.reviewExpiresAt).toISOString(),
      executionBudgetMs: budget(op), executionDeadlineAt: op.executionDeadlineAt === null ? null : new Date(op.executionDeadlineAt).toISOString() })
  }
  function budget(op: StoredOperation) { return op.recipe.resource ? MCP_CONFIGURATION_BUDGET_MS : APP_ACTIONS_EXECUTION_BUDGET_MS }
  async function refreshForReview(op: StoredOperation, context?: SettingsManagementContext) {
    const read = async () => {
      if (op.apiOwner) (await import('../mcp/originalTask')).assertP5ApiOperationOwner(op.apiOwner, context?.p5ApiRun)
      if (context) await op.recipe.admitContext?.(context); await op.recipe.refresh() }
    if (!op.recipe.resource) return read()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([read(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AppActionsManagementRefusal('MCP_REVIEW_READ_ENDED', 'The MCP review read expired without issuing a change.', 409)),
          Math.max(0, Math.min(op.recipe.actor.kind === 'portable' ? 5000 : MCP_REPORT_BUDGET_MS, op.reviewExpiresAt - now())))
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  function review(op: StoredOperation): AppActionsOperationReview {
    if (op.recipe.actor.kind !== 'portable') throw new AppActionsManagementRefusal('NATIVE_APPROVAL_REQUIRED', 'Use the original chat approval for this operation.', 409)
    return { ...result(op), actor: { kind: 'portable', label: op.recipe.actor.label }, preview: clone(op.recipe.preview),
      hardDeadlineAt: op.recipe.hardDeadlineAt === undefined ? null : new Date(op.recipe.hardDeadlineAt).toISOString(), canDecide: op.status === 'awaiting_approval' }
  }
  function capture(recipe: SettingsOperationRecipe) {
    if (recipe.preview.semanticId === MODEL_PRESET_COPY_ID ? !recipe.presetCopy || !isModelPresetCopyReview(recipe.preview.presetCopy) ||
      !isModelPresetCopyOutcome(recipe.presetCopy.current()) || recipe.presetCopy.current().presetId !== recipe.preview.presetCopy.copyPresetId ||
      recipe.presetCopy.current().name !== recipe.preview.presetCopy.copyName : recipe.presetCopy !== undefined || recipe.preview.presetCopy !== undefined) {
      throw new AppActionsManagementRefusal('PRESET_COPY_RECIPE_REQUIRED', 'The held original copy recipe is unavailable.', 409)
    }
    if (recipe.preview.semanticId === MCP_CONFIGURATION_ID ? !recipe.resource || !isMcpConfigurationReview(recipe.preview.resource) ||
      recipe.resource.gatewayId !== recipe.preview.resource.resource.gatewayId || !mcpConfigurationTargetsMatch(recipe.preview.resource, recipe.preview.targets) || recipe.preview.excluded.length !== 0 ||
      !!recipe.initialOutcomes?.length : recipe.resource !== undefined) throw new AppActionsManagementRefusal('MCP_RESOURCE_RECIPE_REQUIRED', 'The exact resource recipe is unavailable.', 409)
    if (!recipe.requestId.startsWith(`${boot}:`) || recipe.requestId.length > 160) throw new AppActionsManagementRefusal('STALE_REQUEST_NAMESPACE', 'Use the current report boot namespace for a new operation.', 409)
    const key = `${actorKey(recipe.actor)}:${recipe.requestId}`
    const inputHash = hashControlInput(recipe.input)
    const found = requests.get(key)
    if (found) {
      const op = read(found, recipe.actor)
      if (op.inputHash !== inputHash) throw new AppActionsManagementRefusal('OPERATION_INTENT_CHANGED', 'A request ID cannot be reused for different changes.', 409)
      return result(op)
    }
    if (operations.size >= 2048 || [...operations.values()].filter(op => actorKey(op.recipe.actor) === actorKey(recipe.actor)).length >= 128) {
      throw new AppActionsManagementRefusal('OPERATION_CAPACITY', 'The operation ledger is full; no new change was admitted.', 503)
    }
    const reviewExpiresAt = Math.min(now() + APP_ACTIONS_REVIEW_LIFETIME_MS, recipe.authorityExpiresAt ?? Infinity, recipe.hardDeadlineAt ?? Infinity)
    if (reviewExpiresAt <= now()) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'The captured deadline has expired.', 409)
    const frozenRecipe = { ...recipe, ...(recipe.resource ? { resource: freeze(clone(recipe.resource)) } : {}), input: freeze(clone(recipe.input)), actor: freeze(clone(recipe.actor)), preview: freeze(clone(recipe.preview)), preimages: freeze(clone(recipe.preimages)), initialOutcomes: freeze(clone(recipe.initialOutcomes ?? [])) }
    const intentDigest = hashControlInput({ boot, actor: frozenRecipe.actor, inputHash, preimages: frozenRecipe.preimages,
      preview: frozenRecipe.preview, initialOutcomes: frozenRecipe.initialOutcomes, reviewExpiresAt, hardDeadlineAt: recipe.hardDeadlineAt ?? null })
    const id = `aso_${boot}_${recipe.resource ? 'mcp_config_' : ''}${randomBytes(16).toString('hex')}`
    const op: StoredOperation = { id, inputHash, intentDigest, recipe: frozenRecipe,
      status: recipe.permission === 'ask' ? 'awaiting_approval' : 'ready', reviewExpiresAt,
      executionDeadlineAt: null, outcomes: clone(recipe.initialOutcomes ?? []), resourceOutcomes: [], abort: new AbortController() }
    operations.set(id, op); requests.set(key, id)
    return result(op)
  }
  async function start(op: StoredOperation, actor: SettingsOperationActor, nativeStop?: AbortSignal, checkNative?: () => void) {
    if (op.flight) return op.recipe.resource ? joinResourceFlight(op, actor.kind === 'portable') : result(op)
    if (!['ready'].includes(op.status)) return result(op)
    if (nativeStop?.aborted) { op.status = 'cancelled'; op.reason = 'caller_stopped'; return result(op) }
    // Reserve execution synchronously before any awaited authority read: one approval, one flight.
    op.status = 'running'
    op.executionDeadlineAt = Math.min(now() + budget(op), op.recipe.authorityExpiresAt ?? Infinity, op.recipe.hardDeadlineAt ?? Infinity)
    const stop = () => op.abort.abort(nativeStop?.reason ?? 'caller_stopped')
    nativeStop?.addEventListener('abort', stop, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let finishWait!: () => void
    const deadline = new Promise<void>(resolve => {
      finishWait = resolve
      timer = setTimeout(() => {
        op.abort.abort('execution_deadline')
        if (op.status === 'running') { op.status = 'unknown_outcome'; op.reason = 'execution_deadline_settlement_pending' }
        resolve()
      }, Math.max(0, op.executionDeadlineAt! - now()))
    })
    op.flight = (async () => {
      let executionStarted = false
      try {
        await op.recipe.refresh()
        if (op.abort.signal.aborted || now() >= op.executionDeadlineAt!) throw new AppActionsManagementRefusal('OPERATION_EXPIRED', 'The operation ended before execution.', 409)
        executionStarted = true
        const outcomes = await op.recipe.execute({ signal: op.abort.signal, deadlineAt: op.executionDeadlineAt!, actor, nativeStop, checkNative,
          targetStarted(subject) {
            if (!op.recipe.preview.targets.some(target => settingsSubjectKey(target.subject) === settingsSubjectKey(subject))) throw new Error('Target is outside this operation')
            recordOutcome(op, { subject, status: 'unknown', reason: 'target_execution_pending', saved: 'unknown', readback: 'not_requested', visible: 'unknown' })
          },
          recordOutcome: outcome => recordOutcome(op, outcome),
          ...(op.recipe.resource ? { recordResourceOutcome(outcome: McpResourceOutcome) {
            if (!isMcpResourceOutcome(outcome) || outcome.resource.gatewayId !== op.recipe.resource!.gatewayId) throw new Error('Resource is outside this operation')
            if (op.resourceOutcomes[0]?.saved === 'saved' && outcome.saved !== 'saved') return
            op.resourceOutcomes = [clone(outcome)]
          } } : {}) })
        for (const outcome of outcomes) recordOutcome(op, outcome)
        op.status = op.recipe.presetCopy?.current().creation === 'unknown' || op.outcomes.some(outcome => outcome.status === 'unknown') || op.resourceOutcomes.some(outcome => outcome.status === 'unknown') ||
          op.recipe.resource && op.resourceOutcomes.length !== 1 ? 'unknown_outcome' : 'completed'
        if (op.status === 'completed') delete op.reason
        if (op.status === 'completed' && op.recipe.continuation) {
          try { op.continuation = clone(await op.recipe.continuation()) }
          catch { op.continuationUnavailable = 'fresh_preconditions_unavailable' }
        }
      } catch (error) {
        op.status = executionStarted ? 'unknown_outcome' : 'blocked'
        op.reason = executionStarted ? 'operation_execution_outcome_unknown' : error instanceof AppActionsManagementRefusal ? error.code : 'operation_failed_before_effect'
      } finally {
        if (timer) clearTimeout(timer)
        nativeStop?.removeEventListener('abort', stop)
        finishWait()
      }
    })()
    if (op.recipe.resource) return joinResourceFlight(op, actor.kind === 'portable')
    await Promise.race([op.flight, deadline])
    return result(op)
  }
  async function joinResourceFlight(op: StoredOperation, portable: boolean) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([op.flight, new Promise<void>(resolve => { timer = setTimeout(resolve,
        Math.max(0, Math.min(portable ? 5000 : Infinity, (op.executionDeadlineAt ?? now()) - now()))) })])
      return result(op)
    } finally { if (timer) clearTimeout(timer) }
  }
  return {
    boot, capture,
    /** Fixed in-process original owner only; no data/preview creates this binding. */
    async bindP5ApiMcpOperation(context: SettingsManagementContext, input: unknown): Promise<P5HeldMcpRecipe | undefined> {
      if (!context.p5ApiRun) return undefined
      const { assertP5ApiRunCurrent, assertP5ApiOperationOwner, recordP5ApiManagementIntent } = await import('../mcp/originalTask')
      if (context.actorType !== 'in-process' || context.delegatedRun || !input || typeof input !== 'object' || !('requestId' in input) || typeof input.requestId !== 'string') throw new AppActionsManagementRefusal('ORIGINAL_RECIPE_UNAVAILABLE', 'The API operation owner is unavailable.', 409)
      assertP5ApiRunCurrent(context.p5ApiRun, context)
      const id = requests.get(`${context.userId}:native:${context.agentId}:${context.sessionId}:${input.requestId}`)
      if (!id) throw new AppActionsManagementRefusal('ORIGINAL_RECIPE_UNAVAILABLE', 'The retained API operation is unavailable.', 409)
      const op = read(id)
      if (!op.recipe.resource || op.recipe.preview.semanticId !== MCP_CONFIGURATION_ID) return undefined // other Settings families retain their ordinary API approval path
      if (op.inputHash !== hashControlInput(input)) throw new AppActionsManagementRefusal('ORIGINAL_RECIPE_UNAVAILABLE', 'The exact retained API recipe is unavailable.', 409)
      if (op.apiOwner) assertP5ApiOperationOwner(op.apiOwner, context.p5ApiRun)
      else op.apiOwner = context.p5ApiRun
      recordP5ApiManagementIntent(context.p5ApiRun)
      const held = Object.freeze({}) as P5HeldMcpRecipe
      heldMcpRecipes.set(held, op); return held
    },
    async readP5HeldApiMcpRecipe(held: P5HeldMcpRecipe, run: P5ApiOriginalRun) {
      const { assertP5ApiOperationOwner } = await import('../mcp/originalTask')
      const op = heldMcpRecipes.get(held)
      if (!op?.apiOwner || read(op.id) !== op || !op.recipe.resource || op.status !== 'awaiting_approval') throw new AppActionsManagementRefusal('ORIGINAL_RECIPE_UNAVAILABLE', 'The actual API recipe is unavailable.', 409)
      assertP5ApiOperationOwner(op.apiOwner, run)
      return Object.freeze({ userId: op.recipe.actor.userId, agentId: op.recipe.actor.id, sessionId: op.recipe.actor.sessionId,
        operationId: op.id, requestId: op.recipe.requestId, inputHash: op.inputHash, expiresAt: op.reviewExpiresAt })
    },
    /** SAME retained recipe only while its actual consumed-consent flight runs.
     * This is distinct from pending approval readers and grants no new consent. */
    async readP5ExecutingApiMcpRecipe(run: P5ApiOriginalRun, operation: { operationId: string; requestId: string }) {
      const { assertP5ApiOperationOwner } = await import('../mcp/originalTask')
      const op = read(operation.operationId)
      if (!op.apiOwner) throw new AppActionsManagementRefusal('ORIGINAL_RECIPE_UNAVAILABLE', 'The genuine executing API owner is unavailable.', 409)
      assertP5ApiOperationOwner(op.apiOwner, run)
      if ( op.recipe.requestId !== operation.requestId || op.status !== 'running' || !op.flight ||
        op.abort.signal.aborted || op.executionDeadlineAt === null || now() >= op.executionDeadlineAt ||
        op.inputHash !== hashControlInput(op.recipe.input) || op.recipe.preview.semanticId !== MCP_CONFIGURATION_ID ||
        !isMcpConfigurationReview(op.recipe.preview.resource) || op.recipe.preview.resource.variant !== 'prerequisite') {
        throw new AppActionsManagementRefusal('ORIGINAL_RECIPE_UNAVAILABLE', 'The genuine executing MCP prerequisite is unavailable.', 409)
      }
      return Object.freeze({ userId: op.recipe.actor.userId, agentId: op.recipe.actor.id, sessionId: op.recipe.actor.sessionId,
        operationId: op.id, requestId: op.recipe.requestId, inputHash: op.inputHash, resource: op.recipe.preview.resource,
        deadlineAt: op.executionDeadlineAt })
    },
    existing(actor: SettingsOperationActor, requestId: string, input: unknown) {
      const id = requests.get(`${actorKey(actor)}:${requestId}`)
      if (!id) return null
      const op = read(id, actor)
      if (op.inputHash !== hashControlInput(input)) throw new AppActionsManagementRefusal('OPERATION_INTENT_CHANGED', 'A request ID cannot be reused for different changes.', 409)
      return result(op)
    },
    nativeApprovalPreview(userId: string, agentId: string, sessionId: string, requestId: string): AppActionsApprovalPreview | null {
      const id = requests.get(`${userId}:native:${agentId}:${sessionId}:${requestId}`)
      if (!id) return null
      const op = read(id)
      return clone({ operationId: op.id, intentDigest: op.intentDigest, preview: op.recipe.preview,
        initialOutcomes: op.recipe.initialOutcomes ?? [],
        controlId: 'sys.app_settings.native.change' as const, input: op.recipe.input as Record<string, unknown>,
        reviewExpiresAt: new Date(op.reviewExpiresAt).toISOString(), executionBudgetMs: budget(op),
        hardDeadlineAt: op.recipe.hardDeadlineAt === undefined ? null : new Date(op.recipe.hardDeadlineAt).toISOString() })
    },
    outcome(id: string, actor: SettingsOperationActor) { return result(read(id, actor)) },
    async validatePending(id: string, actor: SettingsOperationActor, context?: SettingsManagementContext) {
      const op = read(id, actor)
      if (op.status === 'awaiting_approval' || op.status === 'ready') {
        await refreshForReview(op, context)
      }
      return result(read(id, actor))
    },
    async nativeExecute(id: string, actor: SettingsOperationActor, signal: AbortSignal, checkNative: () => void) {
      const op = read(id, actor)
      if (actor.kind !== 'native') throw new AppActionsManagementRefusal('NATIVE_APPROVAL_REQUIRED', 'Wrong operation lane.')
      // Called only by Fabric after its real native approval/standing-policy gate.
      if (op.status === 'awaiting_approval') op.status = 'ready'
      return start(op, actor, signal, checkNative)
    },
    async portableExecute(id: string, actor: SettingsOperationActor) {
      const op = read(id, actor)
      if (actor.kind !== 'portable') throw new AppActionsManagementRefusal('TOKEN_REQUIRED', 'Wrong operation lane.')
      return start(op, actor)
    },
    async humanReview(userId: string, id: string) {
      const op = read(id)
      if (op.recipe.actor.userId !== userId) throw new AppActionsManagementRefusal('OPERATION_NOT_ALLOWED', 'That operation belongs to another user.')
      if (op.status === 'awaiting_approval' || op.status === 'ready') await refreshForReview(op)
      return review(read(id))
    },
    async decide(userId: string, id: string, digest: string, decision: 'approve' | 'deny') {
      const op = read(id)
      if (op.recipe.actor.userId !== userId || op.intentDigest !== digest || op.recipe.actor.kind !== 'portable') throw new AppActionsManagementRefusal('OPERATION_NOT_ALLOWED', 'The operation identity or exact intent does not match.')
      if (op.status !== 'awaiting_approval') throw new AppActionsManagementRefusal('OPERATION_ALREADY_DECIDED', 'This operation has already been answered or expired.', 409)
      // Claim the answer before awaiting, so a second click cannot spend it.
      op.status = decision === 'deny' ? 'denied' : 'ready'
      if (decision === 'approve') {
        if (op.recipe.resource) {
          // Consent is already consumed. Current authority/preimages refresh inside the
          // ONE retained execution flight, so the portable decision observes it within5s.
          if (now() >= op.reviewExpiresAt) { op.status = 'expired'; op.reason = 'review_expired' }
          else await start(op, op.recipe.actor)
          return review(op)
        }
        try { await op.recipe.refresh() } catch (error) { op.status = 'blocked'; op.reason = 'authority_or_preimages_changed'; throw error }
        if (now() >= op.reviewExpiresAt) { op.status = 'expired'; op.reason = 'review_expired' }
        else await start(op, op.recipe.actor)
      }
      return review(op)
    },
    cancel(id: string, actor: SettingsOperationActor) {
      const op = read(id, actor)
      if (op.status === 'running' || op.status === 'unknown_outcome' && op.flight) { op.abort.abort('cancelled'); op.reason = 'cancellation_requested_settlement_pending' }
      else if (op.status === 'ready' || op.status === 'awaiting_approval') { op.status = 'cancelled'; op.abort.abort('cancelled') }
      return result(op)
    }
  }
}
