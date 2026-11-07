import { assertInstalledStdioLaunchCurrent } from '../../mcpGatewayStdio'
import { planFreshMcpScope } from './scopeTransition'
import type { PreparedGatewaySave, OriginalMcpStdioSource } from '../../mcpGatewayService'
import type { P5McpClientAdmission } from '../../mcpGatewayDiscovery'
import { takeCompletedToolImages, restoreCompletedToolImages, type EphemeralImageRegistry, type EphemeralImageRegistryEntry, type ToolResultImageLane } from '../../toolResultImageDelivery'
import type { PostTurnHistoryMessage, StoredReplyRecord } from '../../typesafe/jevJuiceTurn'
import { randomUUID } from 'node:crypto'
import { captureSettingsLifecycle, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from '../settings/lifecycle'
import { getActiveSessionTurn, isRegisteredRunningRequest, isSessionDeleting, bindP5WorkflowInvalidation,
  type SessionTurnEntry } from '../../streamAbortRegistry'
import type { TurnMcpGatewayAuthority } from '../../turnMcpGatewayScope'
import type { SettingsManagementContext } from '../managementTypes'
import type { P5PendingApprovalWrite, P5PendingWriteObservation } from '../../controlApprovals'
import type { ApprovalAnswerOutcome } from '../../approvalAnswerRecord'

/** Process-only continuity data. None of these handles grants an MCP effect or
 * substitutes for current App Actions/grant/reply/operation admission. */
declare const lookupBrand: unique symbol
declare const preparationBrand: unique symbol
export type P5OriginalLookup = Readonly<{ readonly [lookupBrand]: true }>
export type P5OriginalPreparation = Readonly<{ readonly [preparationBrand]: true }>
type SessionInput = { sessionId: string; session: { id?: unknown; user_id?: unknown };
  agent: { id?: unknown; user_id?: unknown }; turn: SessionTurnEntry }
type Lookup = { userId: string; agentId: string; lifecycle: SettingsLifecycleSnapshot;
  signal?: AbortSignal; deadlineAt?: number; used: boolean }
export type P5OriginalScope = Readonly<{
  gateways: readonly string[]; tools: readonly string[]
  provenance: Readonly<{ humanSelection: boolean; resumedScope?: readonly string[];
    requestedGateways?: readonly string[]; requestedTools?: readonly string[] }>
}>
type Task = { kind: 'api'; lookup: Lookup; sessionId: string; turn: SessionTurnEntry;
  taskId: string; retired: boolean; retirement: AbortController; scope?: P5OriginalScope; firstReplyId?: string;
  replies: Set<string>; runs: Set<ApiRun>; cleanup: () => void; managementTransitions: 0 | 1 | 2 | 3;
  gatewayFrontier?: readonly string[]; removedGateways: Set<string> }
const lookups = new WeakMap<object, Lookup>()
const runHandles = new WeakMap<object, ApiRun>()
const preparations = new WeakMap<object, { lookup: Lookup; input: SessionInput; retired: boolean; api?: ApiState; resolved?: P5OriginalScope; apiPart?: P5ApiReplyPart }>()
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
const ids = (values: readonly string[]): readonly string[] => {
  if (!Array.isArray(values) || values.length > 4096 || values.some(value => !validId(value))) throw new Error('invalid scope')
  return Object.freeze([...new Set(values)])
}
function currentLookup(value: Lookup): void {
  assertSettingsLifecycle(value.lifecycle)
  if (value.signal?.aborted || value.deadlineAt !== undefined && Date.now() >= value.deadlineAt) throw new Error('original request ended')
}
function currentTask(value: Task): void {
  currentLookup(value.lookup)
  if (value.retired || value.turn.stop.signal.aborted || isSessionDeleting(value.sessionId) ||
    !isRegisteredRunningRequest(value.sessionId, value.turn)) throw new Error('original request ended')
}
function retireRun(value: ApiRun): void {
  value.retired = true
  value.task.runs.delete(value)
}
function retireTask(value: Task): void {
  if (value.retired) return
  value.retired = true
  value.retirement.abort()
  value.cleanup()
  for (const run of [...value.runs]) retireRun(run)
}
export class P5OriginalBootReadRefusal extends Error {
  readonly code = 'P5_ORIGINAL_BOOT_READ_REFUSED'
  constructor() { super('The original MCP boot read is unavailable.'); this.name = 'P5OriginalBootReadRefusal' }
}

/** Called only by authenticated send-routed BEFORE its first owned Primary read.
 * Capturing later cannot repair this original incarnation/restore cut. */
export function captureP5OriginalLookup(input: { userId: string; agentId: string;
  signal?: AbortSignal; deadlineAt?: number }): P5OriginalLookup | undefined {
  try {
    if (!validId(input.userId) || !validId(input.agentId) ||
      input.deadlineAt !== undefined && !Number.isFinite(input.deadlineAt)) return undefined
    const value: Lookup = { userId: input.userId, agentId: input.agentId,
      lifecycle: captureSettingsLifecycle([`agent:${input.agentId}`]), signal: input.signal,
      deadlineAt: input.deadlineAt, used: false }
    currentLookup(value)
    const handle = Object.freeze({}) as P5OriginalLookup
    lookups.set(handle, value)
    return handle
  } catch { return undefined }
}
/** Feature-only availability. The original cut is retained even when unavailable. */
export function p5OriginalLookupCurrent(handle: P5OriginalLookup | undefined): boolean {
  const value = handle && lookups.get(handle)
  try { if (!value) return false; currentLookup(value); return true } catch { return false }
}

/** Real owned under-lock row + exact registered turn, never a session revision,
 * caller-ready flag, callback certificate or new registration. */
function ownedSession(lookup: Lookup, input: SessionInput): boolean {
  currentLookup(lookup)
  return validId(input.sessionId) && input.session.id === input.sessionId && input.session.user_id === lookup.userId &&
    input.agent.id === lookup.agentId && input.agent.user_id === lookup.userId && input.turn.kind === 'single' &&
    getActiveSessionTurn(input.sessionId) === input.turn && isRegisteredRunningRequest(input.sessionId, input.turn)
}

/** The outer authenticated request retains only its original cut/session here.
 * No task, scope or counter is minted until the actual API route resolves its scope. */
export function prepareP5OriginalTask(handle: P5OriginalLookup | undefined, input: SessionInput): P5OriginalPreparation | undefined {
  const lookup = handle && lookups.get(handle)
  try {
    if (!lookup || lookup.used) return undefined
    lookup.used = true
    if (!ownedSession(lookup, input)) return undefined
    const preparation = Object.freeze({}) as P5OriginalPreparation
    preparations.set(preparation, { lookup, retired: false, input: { sessionId: input.sessionId, turn: input.turn,
      session: { id: input.session.id, user_id: input.session.user_id }, agent: { id: input.agent.id, user_id: input.agent.user_id } } })
    return preparation
  } catch { return undefined }
}
export function retireP5OriginalPreparation(handle: P5OriginalPreparation | undefined): void {
  const original = handle && preparations.get(handle)
  if (!original) return
  if (original.api) {
    const state = original.api, pending = state.pending
    state.dormant = !!pending?.receipt && state.parts.get(pending.part)?.pendingSaved === pending.receipt && pending.run.consumed && !state.failed && !state.sealed
    if (!state.dormant) { state.sealed = true; state.media = []; if (sessionWorkflows.get(state.task.sessionId) === state) sessionWorkflows.delete(state.task.sessionId) }
    retireTask(state.task); void refreshApiState(state)
  }
  original.retired = true
}

// Settlement identity deliberately survives authority retirement. These handles
// cannot grant an effect, restore a credential, or stand in for an owning fact.
declare const requestBrand: unique symbol, saveBrand: unique symbol
export type P5OriginalRequest = Readonly<{ readonly [requestBrand]: true }>
export type P5CanonicalWrite = Readonly<{ readonly [saveBrand]: true }>
declare const heldRecipeBrand: unique symbol
/** Minted and vouched ONLY by the actual existing Settings operation registry. */
export type P5HeldMcpRecipe = Readonly<{ readonly [heldRecipeBrand]: true }>
// An index in the EXISTING original owner, not a queue/card/readiness registry.
const sessionWorkflows = new Map<string, ApiState>()
/** Actual registry/new-original/delete/Stop owners call synchronously. Rights
 * end immediately; known saves and client custody are not cleared. */
export function invalidateP5SessionWorkflow(sessionId: string): boolean {
  const workflow = sessionWorkflows.get(sessionId)
  if (!workflow) return false
  workflow.sealed = true; workflow.dormant = false; retireTask(workflow.task)
  sessionWorkflows.delete(sessionId); void refreshApiState(workflow); return true
}
const originalRequests = new WeakMap<object, ApiState>()
const canonicalWrites = new WeakMap<object, ApiState>()
/** Fixed actual save owner calls before its same await. Retirement is not a
 * renewed effect grant; only this original's registered reply can finalize. */
export function beginP5CanonicalWrite(preparation: P5OriginalPreparation | undefined, message: {
  id?: unknown; session_id?: unknown; user_id?: unknown; agent_id?: unknown; role?: unknown; metadata?: unknown; content?: unknown; intermediateSteps?: unknown
}, apiPart?: P5ApiReplyPart): P5CanonicalWrite | undefined {
  const api = preparation && preparations.get(preparation)?.api
  return api ? beginApiCanonicalWrite(api, message, apiPart) : undefined
}
/** A canonical write still belongs to Redis when bookkeeping refuses. Retain
 * restrictive custody permanently; a later saved reply cannot repair it. */
export function failP5CanonicalCustody(preparation: P5OriginalPreparation | undefined): void {
  const api = preparation && preparations.get(preparation)?.api
  if (api) api.failed = true
}
export function p5CanonicalWriteOwner(ticket: P5CanonicalWrite): P5OriginalRequest {
  const state = canonicalWrites.get(ticket)
  if (!state || !state.writes.has(ticket)) throw new P5OriginalBootReadRefusal()
  return state.handle
}
export function p5CanonicalWriteUnknown(ticket: P5CanonicalWrite): void {
  const state = canonicalWrites.get(ticket), write = state?.writes.get(ticket)
  if (!state || !write || write.state === 'saved') return
  write.state = 'unknown'
  state.failed = true; void refreshApiState(state)
}
/** A queued object alone cannot mark saved: refresh reads the real writer's private receipt. */
export function observeP5CanonicalReceipt(ticket: P5CanonicalWrite, receipt: object): void {
  const state = canonicalWrites.get(ticket)
  if (!state) throw new P5OriginalBootReadRefusal()
  // Immediate restrictive fence, not a saved/retirement certificate. The actual
  // writer's private receipt must still validate before any positive release.
  const attempt = state.writes.get(ticket)!
  state.accountingSealed.add(attempt.part)
  state.receipts.add(receipt); void refreshApiState(state)
}
export function p5CanonicalReplySealed(preparation: P5OriginalPreparation | undefined, replyId: string, apiPart?: P5ApiReplyPart): boolean {
  const api = preparation && preparations.get(preparation)?.api
  return !!api && !!apiPart && api.parts.get(apiPart)?.replyId === replyId && api.accountingSealed.has(apiPart)
}
export function p5OriginalRequestForPreparation(preparation: P5OriginalPreparation | undefined): P5OriginalRequest | undefined {
  return preparation && preparations.get(preparation)?.api?.handle
}
/** Actual outer segment calls after its loops, before promoted NEW user work.
 * This seals issuance only; it never claims physical work already settled. */
export async function sealP5OriginalPreparation(preparation: P5OriginalPreparation | undefined): Promise<void> {
  const api = preparation && preparations.get(preparation)?.api
  if (!api) return
  await refreshApiState(api)
  api.dormant = !!api.pending?.receipt && api.parts.get(api.pending.part)?.pendingSaved === api.pending.receipt && api.pending.run.consumed && !api.failed && !api.sealed
  if (!api.dormant) api.sealed = true
}
export async function refreshP5OriginalRequest(handle: P5OriginalRequest): Promise<void> {
  const state = originalRequests.get(handle)
  if (!state) throw new P5OriginalBootReadRefusal()
  return refreshApiState(state)
}


// The original owner's in-process API custody. It holds no credential, host
// process or private file generation; App Actions P5 runs for API Primaries only.
declare const apiRunBrand: unique symbol, apiPartBrand: unique symbol, apiManagementBrand: unique symbol, apiLineageBrand: unique symbol
export type P5ApiOriginalRun = Readonly<{ readonly [apiRunBrand]: true }>
/** Real current compiler preparation or actual SDK run; never body metadata. */
export type P5ApiDiscoveryOwner = P5OriginalPreparation | P5ApiOriginalRun
export type P5ApiToolNames = Readonly<{ gatewayId: string; gatewayName: string; createdAt: string; names: readonly string[] }>
export type P5ApiReplyPart = Readonly<{ readonly [apiPartBrand]: true }>
export type P5ApiManagement = Readonly<{ readonly [apiManagementBrand]: true }>
export type P5ApiCanonicalLineage = Readonly<{ readonly [apiLineageBrand]: true }>
type ApiPart = { replyId: string; version: number; saved: boolean; pendingSaved?: P5PendingApprovalWrite; run?: ApiRun }
type ApiRun = { kind: 'api'; task: Task; state: ApiState; part: P5ApiReplyPart; replyId: string;
  signal: AbortSignal; retired: boolean; handle: P5ApiOriginalRun; consumed: boolean; pause: boolean;
  approvalResumeClaimed?: boolean; managementContinued?: boolean; images?: EphemeralImageRegistry; completedToolIds?: readonly string[] }
type ApiSave = { id: string; replyId: string; part: P5ApiReplyPart; projection: StoredReplyRecord; pending?: P5PendingApprovalWrite; state: 'issued' | 'saved' | 'unknown' }
type OriginalARecord = { kind: 'other' } | { kind: 'stdio'; source: OriginalMcpStdioSource } | { kind: 'ineligible' }
type OriginalAState = { closed: boolean; capturing: boolean; records: Map<string, OriginalARecord>; ineligible: Set<string>;
  observations: Map<P5McpClientAdmission, { gatewayId: string; issued: boolean; match: 'pending' | 'matched' | 'ineligible' }> }
type ApiState = { originalA?: OriginalAState; kind: 'api'; managed: boolean; positiveClosed?: boolean; handle: P5OriginalRequest; task: Task; preparation: P5OriginalPreparation;
  parts: Map<P5ApiReplyPart, ApiPart>; writes: Map<P5CanonicalWrite, ApiSave>; receipts: Set<object>;
  accountingSealed: Set<P5ApiReplyPart>; management: Map<P5ApiManagement, { run: ApiRun; gatewayId: string;
    operationId: string; requestId: string; result: 'pending' | 'saved' | 'refused' | 'unknown'; originalAFrame?: readonly string[]; originalADeadline?: number; setup?: P5McpClientAdmission; consumed?: boolean; verifiedPlan?: PreparedGatewaySave }>;
  clients: Map<P5McpClientAdmission, { known: boolean }>; naming?: readonly P5ApiToolNames[]; dirty: boolean;
  media: Array<[string, EphemeralImageRegistryEntry]>; canonicalParts: Map<P5ApiReplyPart, StoredReplyRecord>; requestView?: { request: string; history: PostTurnHistoryMessage[] };
  pending?: { run: ApiRun; part: P5ApiReplyPart; held: P5HeldMcpRecipe; observation: P5PendingWriteObservation;
    receipt?: P5PendingApprovalWrite; inputHash: string; operationId: string; expiresAt: number; sdkApprovalId?: string; cardId?: string };
  resume?: { answer: ApprovalAnswerOutcome; pending: P5PendingApprovalWrite }; dormant: boolean;
  failed: boolean; sealed: boolean; refreshing?: Promise<void> }
const apiManagementOwners = new WeakMap<object, ApiState>()

/** DATA only, at the sole route selection resolution BEFORE compile. No task/run/effect grant. */
export function recordP5ResolvedApiScope(preparation: P5OriginalPreparation | undefined, input: {
  gateways: readonly string[]; tools: readonly string[]; authority?: TurnMcpGatewayAuthority
}): void {
  const held = preparation && preparations.get(preparation)
  if (!held || held.retired) return
  if (!ownedSession(held.lookup, held.input)) throw new P5OriginalBootReadRefusal()
  const gateways = ids(input.gateways), tools = ids(input.tools)
  if (held.resolved && (gateways.some(id => !(held.api?.task.gatewayFrontier ?? held.resolved!.gateways).includes(id)) || tools.some(id => !held.resolved!.tools.includes(id)))) throw new P5OriginalBootReadRefusal()
  if (held.api) {
    for (const id of held.api.task.gatewayFrontier ?? held.resolved?.gateways ?? []) if (!gateways.includes(id)) held.api.task.removedGateways.add(id)
    held.api.task.gatewayFrontier = gateways
  }
  held.resolved ??= Object.freeze({ gateways, tools, provenance: Object.freeze({ humanSelection: input.authority?.humanSelection === true,
    ...(input.authority?.resumedScope !== undefined ? { resumedScope: ids(input.authority.resumedScope) } : {}) }) })
}
/** Once-only read-only initial capture. Failures are DATA, never ordinary-run failure. */
export async function captureP5ApiOriginalStdioSources(preparation: P5OriginalPreparation | undefined): Promise<void> {
  const state = preparation && preparations.get(preparation)?.api
  if (!state || state.originalA) return
  assertP5ApiDiscoveryCurrent(preparation!)
  const initial: OriginalAState = { closed: false, capturing: true, records: new Map(), ineligible: new Set(), observations: new Map() }
  state.originalA = initial
  const selected = state.task.scope?.gateways ?? []
  for (const id of selected) initial.records.set(id, { kind: 'ineligible' })
  if (selected.length > 256) { initial.capturing = false; return } // SAME complete naming-data capacity; no ordinary failure
  const deadline = Math.min(state.task.lookup.deadlineAt ?? Infinity, Date.now() + 5000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const capture = (async () => {
    const { mcpGatewayService } = await import('../../mcpGatewayService')
    await Promise.all(selected.map(async id => {
      try {
        if (!initial.capturing || initial.closed || Date.now() >= deadline) return
        const source = await mcpGatewayService.captureOriginalMcpStdioSource(state.task.lookup.userId, state.task.lookup.agentId, id, deadline)
        if (initial.capturing && !initial.closed && Date.now() < deadline) initial.records.set(id, source ? { kind: 'stdio', source } : { kind: 'other' })
      } catch { /* exact ineligible record remains; no retry/current adoption */ }
    }))
  })()
  void capture.catch(() => {})
  try { await Promise.race([capture, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())) })]) }
  finally { if (timer !== undefined) clearTimeout(timer); initial.capturing = false }
}

/** Registration is synchronous before resolver/cache/import awaits. No new use grant. */
export function registerP5InitialStdioObservation(handle: P5ApiDiscoveryOwner, gatewayId: string, client: P5McpClientAdmission): boolean {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), initial = state.originalA
  if (!initial || initial.closed || initial.records.get(gatewayId)?.kind === 'other' ||
    !(state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).includes(gatewayId)) return false
  initial.observations.set(client, { gatewayId, issued: false, match: 'pending' })
  return true
}
/** Fixed actual constructor observer records identity only, never settlement. */
export function observeP5InitialStdioConstructor(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission): void {
  assertP5InitialStdioIssue(handle, client)
  const slot = apiDiscoveryState(handle).originalA!.observations.get(client)!
  if (slot.issued) throw new P5OriginalBootReadRefusal()
  slot.issued = true
}
export function readP5InitialStdioSource(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission) {
  const state = apiDiscoveryState(handle), slot = state.originalA?.observations.get(client)
  if (!slot) throw new P5OriginalBootReadRefusal()
  const record = state.originalA!.records.get(slot.gatewayId)
  return record?.kind === 'stdio' ? record.source : undefined
}
export function readP5InitialStdioContext(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission) {
  const state = apiDiscoveryState(handle)
  if (!state.originalA?.observations.has(client)) throw new P5OriginalBootReadRefusal()
  return { userId: state.task.lookup.userId, agentId: state.task.lookup.agentId,
    deadlineAt: state.task.lookup.deadlineAt, signal: state.task.lookup.signal ? AbortSignal.any([state.task.lookup.signal, state.task.turn.stop.signal]) : state.task.turn.stop.signal }
}
/** Data-only resolution may reuse a saved naming result during genuine Ask
 * resume. The actual factory/start/send still requires the stricter issue cut. */
export function assertP5InitialStdioObservationCurrent(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission): void {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), initial = state.originalA, slot = initial?.observations.get(client)
  if (!initial || !slot || initial.closed || !(state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).includes(slot.gatewayId) ||
    state.task.removedGateways.has(slot.gatewayId)) throw new P5OriginalBootReadRefusal()
}
export function assertP5InitialStdioIssue(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission): void {
  assertP5InitialStdioObservationCurrent(handle, client)
  const state = apiDiscoveryState(handle), run = runHandles.get(handle)
  if (state.pending || state.resume || run?.kind === 'api' && run.pause) throw new P5OriginalBootReadRefusal()
  const initial = state.originalA!, slot = initial.observations.get(client)!, record = initial.records.get(slot.gatewayId)
  if (slot.match === 'matched' && record?.kind === 'stdio') {
    try { assertSettingsLifecycle(record.source.lifecycle); assertInstalledStdioLaunchCurrent(record.source.launch) }
    catch { slot.match = 'ineligible'; initial.ineligible.add(slot.gatewayId) } // DATA only; preserve the actual ordinary producer
  }
}
export function noteP5InitialStdioProduced(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission, matched: boolean): void {
  const state = apiDiscoveryState(handle), initial = state.originalA, slot = initial?.observations.get(client)
  if (!initial || !slot) throw new P5OriginalBootReadRefusal()
  slot.match = matched && slot.match !== 'ineligible' ? 'matched' : 'ineligible'
  if (!matched) initial.ineligible.add(slot.gatewayId)
}

function assertOriginalADataCurrent(state: ApiState, source: OriginalMcpStdioSource): void {
  const record = state.originalA?.records.get(source.gatewayId)
  if (record?.kind !== 'stdio' || record.source !== source || state.originalA?.ineligible.has(source.gatewayId) ||
    !(state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).includes(source.gatewayId) || state.task.removedGateways.has(source.gatewayId)) throw new P5OriginalBootReadRefusal()
  assertSettingsLifecycle(source.lifecycle); assertInstalledStdioLaunchCurrent(source.launch)
}
export function assertP5ApiOriginalStdioCurrent(handle: P5ApiDiscoveryOwner, source: OriginalMcpStdioSource): void {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), run = runHandles.get(handle)
  if (!state.originalA?.closed || !state.managed || ![...state.management.values()].some(work => work.consumed) || state.pending || state.resume || run?.kind === 'api' && run.pause) throw new P5OriginalBootReadRefusal()
  assertOriginalADataCurrent(state, source)
}
export async function readP5ApiOriginalStdioAuthority(handle: P5ApiDiscoveryOwner, gatewayId: string) {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), record = state.originalA?.records.get(gatewayId)
  if (!state.originalA?.closed || record?.kind === 'other' || !state.task.scope?.gateways.includes(gatewayId)) return undefined
  if (record?.kind !== 'stdio') throw new P5OriginalBootReadRefusal()
  assertP5ApiOriginalStdioCurrent(handle, record.source)
  try {
    const { mcpGatewayService } = await import('../../mcpGatewayService')
    assertP5ApiOriginalStdioCurrent(handle, record.source)
    const deadlineAt = Math.min(state.task.lookup.deadlineAt ?? Infinity, ...[...state.management.values()].filter(work => work.consumed && work.originalADeadline !== undefined).map(work => work.originalADeadline!), Date.now() + 120000)
    const { cut, fences } = await mcpGatewayService.readOriginalMcpStdioCut(record.source, deadlineAt)
    assertP5ApiOriginalStdioCurrent(handle, record.source)
    return { source: record.source, userId: record.source.userId, agentId: record.source.agentId, gatewayId, deadlineAt,
      signal: runHandles.get(handle)?.kind === 'api' ? apiRun(handle as P5ApiOriginalRun).signal : state.task.lookup.signal ?? state.task.turn.stop.signal,
      fences: mcpGatewayService.joinMcpPrerequisiteFences(fences, cut.sourceFence ? [cut.sourceFence] : []) }
  } catch (error) { state.originalA.ineligible.add(gatewayId); state.task.removedGateways.add(gatewayId); throw error }
}

/** Promote exact physical handles only after the synchronous management seal.
 * Structural removal adopts custody but needs no original key/readiness probe. */
export async function joinP5OriginalStdioManagement(ticket: P5ApiManagement, extra: readonly import('./gatewayWriteContext').GatewayRawFence[], positive: boolean, deadlineAt: number, exclude: readonly string[] = [], reserveClients = 0, requireAllClientsSettled = true) {
  const state = apiManagementOwners.get(ticket), work = state?.management.get(ticket)
  if (!state || !work) throw new P5OriginalBootReadRefusal()
  assertP5ApiManagementCurrent(ticket, work.gatewayId)
  const initial = state.originalA
  const active = (state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).filter(id => !exclude.includes(id) && !state.task.removedGateways.has(id))
  const activeSet = new Set(active)
  const discovery = await import('../../mcpGatewayDiscovery')
  assertP5ApiManagementCurrent(ticket, work.gatewayId)
  if (initial) for (const [client, observation] of initial.observations) {
    const fact = discovery.readP5McpClientSettlement(client)
    if (p5ApiDiscoveryRequest(fact.run) !== state.handle) throw new P5OriginalBootReadRefusal()
    if (fact.constructor === 'started' && !state.clients.has(client)) state.clients.set(client, { known: false })
    if (positive && activeSet.has(observation.gatewayId) && fact.constructor === 'started' && observation.match !== 'matched') throw new P5OriginalBootReadRefusal()
  }
  await refreshApiState(state)
  assertP5ApiManagementCurrent(ticket, work.gatewayId)
  if (!positive) return []
  if (!Number.isSafeInteger(reserveClients) || reserveClients < 0 || state.clients.size + reserveClients > 32 ||
    requireAllClientsSettled && [...state.clients.values()].some(value => !value.known) ||
    initial && [...initial.observations.keys()].some(client => state.clients.get(client)?.known === false)) throw new P5OriginalBootReadRefusal()
  if (!initial && state.task.scope?.gateways.length) throw new P5OriginalBootReadRefusal()
  const service = (await import('../../mcpGatewayService')).mcpGatewayService
  const held: import('./gatewayWriteContext').GatewayRawFence[] = []
  for (const id of active) {
    if (!state.task.scope?.gateways.includes(id)) continue // consumed C owns its separate original plan
    const record = initial?.records.get(id)
    if (record?.kind === 'other') continue
    if (record?.kind !== 'stdio') throw new P5OriginalBootReadRefusal()
    try {
      assertOriginalADataCurrent(state, record.source)
      await service.withOriginalMcpStdioLaunch(record.source, Math.min(state.task.lookup.deadlineAt ?? Infinity, deadlineAt), async () => {})
      assertP5ApiManagementCurrent(ticket, work.gatewayId)
      const { cut, fences } = await service.readOriginalMcpStdioCut(record.source, Math.min(state.task.lookup.deadlineAt ?? Infinity, deadlineAt))
      held.push(...fences, ...(cut.sourceFence ? [cut.sourceFence] : []))
    } catch (error) {
      initial!.ineligible.add(id); state.task.removedGateways.add(id); throw error
    }
  }
  const joined = service.joinMcpPrerequisiteFences(extra, held)
  // Configure's one reserved setup also needs the later actual C-postimage
  // source check at target issue. Count that distinct registry path BEFORE C
  // effects; no placeholder raw/ACK enters the current atomic frame.
  if (reserveClients) {
    const registry = joined.find(fence => fence.key === `mcp_gateways:${state.task.lookup.userId}`)
    if (!registry && joined.length >= 16) throw new Error('The successor source key exceeds the existing capacity.')
    if (registry && registry.paths.length >= 64) throw new Error('The successor source path exceeds the existing capacity.')
  }
  for (const id of active) if (initial?.records.get(id)?.kind === 'stdio' &&
    ![...initial.observations.values()].some(slot => slot.gatewayId === id && slot.match === 'matched')) throw new P5OriginalBootReadRefusal()
  work.originalAFrame = Object.freeze([...exclude]); work.originalADeadline = deadlineAt
  await service.readMcpPrerequisiteIssueCut(state.task.lookup.userId, state.task.lookup.agentId, work.gatewayId,
    Math.min(state.task.lookup.deadlineAt ?? Infinity, deadlineAt), joined)
  assertP5ApiManagementCurrent(ticket, work.gatewayId)
  return service.joinMcpPrerequisiteFences(held)
}

/** Fixed server route binds the actual stored-prefix version, not body metadata. */
export function bindP5ApiReplyPart(preparation: P5OriginalPreparation | undefined, input: { replyId: string; version: number }): P5ApiReplyPart | undefined {
  const held = preparation && preparations.get(preparation)
  if (!held || held.retired) return undefined
  if (!validId(input.replyId) || !Number.isSafeInteger(input.version) || input.version < 0 || !ownedSession(held.lookup, held.input)) throw new P5OriginalBootReadRefusal()
  if (!held.resolved) return undefined
  if (!held.api) {
    invalidateP5SessionWorkflow(held.input.sessionId)
    bindP5WorkflowInvalidation(invalidateP5SessionWorkflow)
    const task: Task = { kind: 'api', lookup: held.lookup, sessionId: held.input.sessionId, turn: held.input.turn,
      taskId: randomUUID(), retired: false, retirement: new AbortController(), scope: held.resolved, firstReplyId: input.replyId,
      replies: new Set(), runs: new Set(), cleanup: () => {}, managementTransitions: 0, removedGateways: new Set() }
    const handle = Object.freeze({}) as P5OriginalRequest
    const state: ApiState = { kind: 'api', managed: false, handle, task, preparation: preparation!, parts: new Map(), writes: new Map(), receipts: new Set(),
      accountingSealed: new Set(), management: new Map(), clients: new Map(), dirty: false, media: [], canonicalParts: new Map(), dormant: false, failed: false, sealed: false }
    const stop = () => { retireTask(task); state.sealed = true; void refreshApiState(state) }
    task.turn.stop.signal.addEventListener('abort', stop, { once: true }); task.lookup.signal?.addEventListener('abort', stop, { once: true })
    task.cleanup = () => { task.turn.stop.signal.removeEventListener('abort', stop); task.lookup.signal?.removeEventListener('abort', stop) }
    originalRequests.set(handle, state); held.api = state
  }
  const state = held.api
  currentApiState(state)
  if (state.parts.size >= 32 || [...state.parts.values()].some(part => part.replyId === input.replyId && part.version >= input.version)) throw new P5OriginalBootReadRefusal()
  const part = Object.freeze({}) as P5ApiReplyPart
  state.parts.set(part, { replyId: input.replyId, version: input.version, saved: false }); state.task.replies.add(input.replyId); held.apiPart = part
  return part
}
function currentApiState(state: ApiState): void {
  if (state.kind !== 'api' || state.failed || state.sealed) throw new P5OriginalBootReadRefusal()
  currentTask(state.task)
}
function apiRun(handle: P5ApiOriginalRun): ApiRun {
  const run = runHandles.get(handle)
  if (!run || run.kind !== 'api' || run.task.kind !== 'api') throw new P5OriginalBootReadRefusal()
  return run
}
/** Only the actual primary streaming API branch calls after its model/conversion passage. */
export function associateP5ApiOriginalRun(preparation: P5OriginalPreparation | undefined, part: P5ApiReplyPart | undefined, input: {
  userId?: string; agentId?: string | null; sessionId?: string | null; replyId?: string | null; signal?: AbortSignal; delegated?: boolean
}): P5ApiOriginalRun | undefined {
  const state = preparation && preparations.get(preparation)?.api
  if (!state || !part) return undefined
  currentApiState(state)
  const record = state.parts.get(part)
  if (state.resume) throw new P5OriginalBootReadRefusal()
  // A completed SDK predicate is never a physical/result barrier. The fixed
  // brain refreshes real owner facts before this synchronous issuance check.
  for (const [before, prior] of state.parts) {
    if (before === part) break
    if (!prior.saved || state.managed && prior.run && (!prior.run.consumed || prior.run.pause && !prior.run.approvalResumeClaimed && !prior.run.managementContinued)) throw new P5OriginalBootReadRefusal()
  }
  if ([...state.clients.values()].some(work => !work.known)) throw new P5OriginalBootReadRefusal()
  if (!record || record.run || input.delegated || input.userId !== state.task.lookup.userId || input.agentId !== state.task.lookup.agentId ||
    input.sessionId !== state.task.sessionId || input.replyId !== record.replyId || !(input.signal instanceof AbortSignal) || input.signal.aborted) throw new P5OriginalBootReadRefusal()
  const handle = Object.freeze({}) as P5ApiOriginalRun
  const run: ApiRun = { kind: 'api', task: state.task, state, part, replyId: record.replyId, signal: input.signal, retired: false, handle, consumed: false, pause: false }
  record.run = run; state.task.runs.add(run); runHandles.set(handle, run)
  return handle
}
export function assertP5ApiRunCurrent(handle: P5ApiOriginalRun, context?: { userId: string; agentId?: string | null; sessionId?: string | null; messageId?: string | null; delegatedRun?: boolean }): void {
  const run = apiRun(handle)
  currentApiState(run.state)
  if (run.state.resume || run.task !== run.state.task || run.retired || run.signal.aborted || !run.state.parts.has(run.part) || run.state.parts.get(run.part)?.run !== run || context &&
    (context.delegatedRun || context.userId !== run.task.lookup.userId || context.agentId !== run.task.lookup.agentId || context.sessionId !== run.task.sessionId || context.messageId !== run.replyId)) throw new P5OriginalBootReadRefusal()
}
/** SDK Promise.all evaluates every stop predicate: never await physical work here.
 * True only closes issuance; it is NEVER a verified/save/continuation certificate. */
export function p5ApiRunMustPause(handle: P5ApiOriginalRun): boolean {
  try { const run = apiRun(handle); assertP5ApiRunCurrent(handle); return run.pause }
  catch { return true }
}
/** Notification only. Positive consumed/finish facts are read from the actual SDK owner. */
export function notifyP5ApiStreamSettlement(handle: P5ApiOriginalRun): void {
  void refreshApiState(apiRun(handle).state)
}
function beginApiCanonicalWrite(state: ApiState, message: { id?: unknown; session_id?: unknown; user_id?: unknown; agent_id?: unknown; role?: unknown; content?: unknown; metadata?: unknown; intermediateSteps?: unknown }, part?: P5ApiReplyPart): P5CanonicalWrite {
  const record = part && state.parts.get(part)
  if (!record || message.id !== record.replyId || message.user_id !== state.task.lookup.userId || message.agent_id !== state.task.lookup.agentId ||
    message.session_id !== state.task.sessionId || message.role !== 'assistant' || state.writes.size >= 32) throw new P5OriginalBootReadRefusal()
  const ticket = Object.freeze({}) as P5CanonicalWrite
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata as Record<string, unknown> : {}
  const projection: StoredReplyRecord = structuredClone({ content: message.content, intermediateSteps: message.intermediateSteps,
    metadata: Object.fromEntries(['zipReferences', 'memorySaves', 'controlErrors', 'zipControl', 'response_failed', 'error_message'].filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]])) })
  const pending = state.pending
  const approvals = metadata.toolApprovals && typeof metadata.toolApprovals === 'object' && 'approvals' in metadata.toolApprovals ? metadata.toolApprovals.approvals : undefined
  const pendingReceipt = pending?.part === part && pending.receipt && Array.isArray(approvals) && approvals.some(entry => entry && typeof entry === 'object' &&
    entry.approvalId === pending.sdkApprovalId && entry.control?.approvalId === pending.cardId) ? pending.receipt : undefined
  state.writes.set(ticket, { id: randomUUID(), replyId: record.replyId, part: part!, projection, ...(pendingReceipt ? { pending: pendingReceipt } : {}), state: 'issued' }); canonicalWrites.set(ticket, state)
  return ticket
}
async function refreshApiState(state: ApiState): Promise<void> {
  state.dirty = true
  if (state.refreshing) return state.refreshing
  state.refreshing = (async () => {
    do {
    state.dirty = false
    const streamOwner = await import('../../vercelBrain')
    for (const part of state.parts.values()) {
      if (part.run) {
        const fact = streamOwner.readP5ApiStreamSettlement(part.run.handle)
        part.run.consumed = fact?.consumerConsumed === true && fact.finishKnown === true
      }
    }
    const owner = await import('../../replyStreamRecord')
    for (const receipt of state.receipts) {
      const fact = owner.readP5CanonicalSaveReceipt(receipt), write = state.writes.get(fact.write)
      if (fact.owner !== state.handle || !write) { state.failed = true; continue }
      write.state = 'saved'; state.parts.get(write.part)!.saved = true
      if (write.pending) state.parts.get(write.part)!.pendingSaved = write.pending
      state.canonicalParts.set(write.part, write.projection); state.receipts.delete(receipt)
    }
    if (state.management.size) {
      const owner = await import('../../mcpGatewaySave')
      for (const [ticket, work] of state.management) work.result = owner.readP5ApiManagementWrite(ticket)
    }
    if (state.clients.size) {
      const owner = await import('../../mcpGatewayDiscovery')
      for (const [client, work] of state.clients) {
        const fact = owner.readP5McpClientSettlement(client)
        if (p5ApiDiscoveryRequest(fact.run) !== state.handle) throw new P5OriginalBootReadRefusal()
        const noRequest = fact.requests === 'not_started' && fact.list === 'not_started' && fact.execute === 'not_started' &&
          (fact.constructor === 'not_started' || fact.close === 'known')
        work.known = noRequest || fact.requests !== 'pending' && fact.requests !== 'unknown' && fact.initialize === 'known' &&
          (fact.list === 'known' || fact.list === 'not_started') && (fact.execute === 'known' || fact.execute === 'not_started') && fact.close === 'known'
      }
    }
    } while (state.dirty)
  })().catch(() => { state.failed = true }).finally(() => {
    state.refreshing = undefined
    if (state.dirty) return refreshApiState(state)
  })
  return state.refreshing
}
/** Actual held save-only operation joins before its first effect; no positive setup certificate. Only actual intended+approved+verified actor-subject postimages may later add C; another owned Primary stays A/[] or tighter. */
export function captureP5ApiManagement(context: SettingsManagementContext, gatewayId: string, operation: { requestId: string; operationId: string }): P5ApiManagement | undefined {
  const handle = context.p5ApiRun
  if (!handle) return undefined
  assertP5ApiRunCurrent(handle, context)
  const run = apiRun(handle), state = run.state
  const same = [...state.management].find(([, item]) => item.run === run && item.operationId === operation.operationId && item.requestId === operation.requestId && item.gatewayId === gatewayId)
  if (same) return same[0]
  if (state.positiveClosed || run.pause || state.management.size >= 3 || !validId(gatewayId) || !validId(operation.operationId) || !validId(operation.requestId)) throw new P5OriginalBootReadRefusal()
  if (state.originalA) {
    state.originalA.closed = true
    // No await/currentness loss can interleave before exact issued custody is
    // adopted. Settlement is still read only from the real client owner.
    for (const [client, slot] of state.originalA.observations) if (slot.issued && !state.clients.has(client)) state.clients.set(client, { known: false })
  }
  const ticket = Object.freeze({}) as P5ApiManagement
  state.management.set(ticket, { run, gatewayId, operationId: operation.operationId, requestId: operation.requestId, result: 'pending' })
  apiManagementOwners.set(ticket, state); run.pause = true
  state.task.managementTransitions = state.management.size as 1 | 2 | 3
  return ticket
}
export function assertP5ApiManagementCurrent(ticket: P5ApiManagement, gatewayId: string): void {
  const state = apiManagementOwners.get(ticket), work = state?.management.get(ticket)
  if (!state || !work || work.gatewayId !== gatewayId) throw new P5OriginalBootReadRefusal()
  assertP5ApiRunCurrent(work.run.handle)
  if (work.originalAFrame) for (const [id, record] of state.originalA?.records ?? []) {
    if (record.kind === 'stdio' && !work.originalAFrame.includes(id) && !state.task.removedGateways.has(id) && (state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).includes(id)) assertOriginalADataCurrent(state, record.source)
  }
}
/** Actual assembly metadata only, not readiness, consent or C authority. */
function apiDiscoveryState(handle: P5ApiDiscoveryOwner): ApiState {
  const run = runHandles.get(handle)
  if (run?.kind === 'api') return run.state
  const state = preparations.get(handle as P5OriginalPreparation)?.api
  if (!state) throw new P5OriginalBootReadRefusal()
  return state
}
export function p5ApiDiscoveryRequest(handle: P5ApiDiscoveryOwner): P5OriginalRequest { return apiDiscoveryState(handle).handle }
export function assertP5ApiDiscoveryCurrent(handle: P5ApiDiscoveryOwner): void {
  const state = apiDiscoveryState(handle), run = runHandles.get(handle)
  currentApiState(state)
  if (run?.kind === 'api') assertP5ApiRunCurrent(handle as P5ApiOriginalRun)
  else if (state.preparation !== handle || preparations.get(handle as P5OriginalPreparation)?.retired) throw new P5OriginalBootReadRefusal()
}
export function readP5ApiManagementIdentity(handle: P5ApiDiscoveryOwner) {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle)
  return { userId: state.task.lookup.userId, agentId: state.task.lookup.agentId }
}
/** Only the immediate successor of a consumed canonical/physical MCP run
 * needs message-less DCM. Later ordinary context continuations keep their path.
 * This assembly fact is not a use/readiness grant. */
export function p5ApiNeedsPrerequisiteDcm(handle: P5ApiDiscoveryOwner): boolean {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), parts = [...state.parts.values()]
  const previousRun = parts.at(-1)?.run ?? parts.at(-2)?.run
  return !!previousRun && [...state.management.values()].some(work =>
    work.consumed && work.run === previousRun && work.run.managementContinued)
}
export function recordP5ApiToolNames(handle: P5ApiDiscoveryOwner, rows: readonly P5ApiToolNames[]): void {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle)
  // Retain the full SAME ordinary assembly, before visibility filtering. DATA
  // cannot add a gateway or establish that a remote source is verified.
  if (rows.some(row => !(state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).includes(row.gatewayId))) throw new P5OriginalBootReadRefusal()
  if (rows.length > 256 || rows.reduce((count, row) => count + row.names.length, 0) > 4096 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 1048576) { state.naming = undefined; return }
  state.naming = Object.freeze(rows.map(row => Object.freeze({ ...row, names: Object.freeze([...row.names]) })))
}
export function readP5ApiZipToolNames(handle: P5ApiDiscoveryOwner, subjectId: string, gatewayId: string, saved: readonly string[]): readonly P5ApiToolNames[] {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle)
  const selection = subjectId === state.task.lookup.agentId ? state.task.gatewayFrontier ?? state.task.scope?.gateways ?? [] : ids(saved)
  return selection.filter(id => id !== gatewayId).map(id => {
    const row = state.naming?.find(item => item.gatewayId === id)
    if (!row) throw new Error('The named Zip edit needs a complete retained ordinary tool identity result; no source was contacted to guess it.')
    return row
  })
}
export function assertP5ApiVerifiedMcpCurrent(handle: P5ApiDiscoveryOwner, gatewayId: string, plan: PreparedGatewaySave): void {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), run = runHandles.get(handle)
  const work = [...state.management.values()].findLast(item => item.consumed && item.gatewayId === gatewayId && item.verifiedPlan)
  if (state.pending || state.resume || run?.kind === 'api' && run.pause ||
    !(state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).includes(gatewayId) || state.task.removedGateways.has(gatewayId) || work?.verifiedPlan !== plan) throw new P5OriginalBootReadRefusal()
}
/** The actual consumed verified transition, usable by the compiler before its
 * next ApiRun exists. The paused previous run never supplies A/use authority. */
export async function readP5ApiVerifiedMcpAuthority(handle: P5ApiDiscoveryOwner, gatewayId: string) {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), allowed = state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []
  if (!allowed.includes(gatewayId) || state.task.removedGateways.has(gatewayId)) throw new P5OriginalBootReadRefusal()
  const selected = [...state.management].findLast(([, work]) => work.consumed && work.gatewayId === gatewayId && work.verifiedPlan)
  if (!selected) return undefined // ordinary A retains its existing path
  const [ticket, work] = selected
  assertP5ApiVerifiedMcpCurrent(handle, gatewayId, work.verifiedPlan!)
  const actual = await (await import('../../mcpGatewaySave')).readP5ApiVerifiedSourceUse(ticket)
  assertP5ApiDiscoveryCurrent(handle)
  assertP5ApiVerifiedMcpCurrent(handle, gatewayId, work.verifiedPlan!)
  if (!actual?.plan || actual.plan !== work.verifiedPlan || state.management.get(ticket) !== work || !work.consumed) throw new P5OriginalBootReadRefusal()
  return Object.freeze({ userId: state.task.lookup.userId, agentId: state.task.lookup.agentId, sessionId: state.task.sessionId,
    signal: state.task.lookup.signal ?? state.task.turn.stop.signal, plan: actual.plan, intent: actual.intent, settingsIdentity: actual.settingsIdentity, fences: actual.fences, deadlineAt: actual.deadlineAt })
}
/** A real current target read observed removal. Retaining this narrowing is
 * independent of a later external re-add or same original new defaults. */
export function observeP5ApiVerifiedSourceRemoval(ticket: P5ApiManagement, subjectId: string): void {
  const state = apiManagementOwners.get(ticket), work = state?.management.get(ticket)
  if (!state || !work || !work.consumed || !work.verifiedPlan || subjectId !== state.task.lookup.agentId) return
  state.task.removedGateways.add(work.gatewayId)
  state.task.gatewayFrontier = Object.freeze((state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []).filter(id => id !== work.gatewayId))
}
export function p5ApiHasVerifiedMcpSource(handle: P5ApiDiscoveryOwner, gatewayId?: string): boolean {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle), selected = state.task.gatewayFrontier ?? state.task.scope?.gateways ?? []
  return [...state.management.values()].some(work => work.consumed && work.verifiedPlan && selected.includes(work.gatewayId) && !state.task.removedGateways.has(work.gatewayId) && (gatewayId === undefined || work.gatewayId === gatewayId))
}
/** Genuine setup owner tuple, never verified A/tool-use authority. */
export function readP5ApiManagementOwner(ticket: P5ApiManagement) {
  const state = apiManagementOwners.get(ticket), work = state?.management.get(ticket)
  if (!state || !work) throw new P5OriginalBootReadRefusal()
  assertP5ApiManagementCurrent(ticket, work.gatewayId)
  return Object.freeze({ run: work.run.handle, userId: state.task.lookup.userId, agentId: state.task.lookup.agentId,
    sessionId: state.task.sessionId, replyId: work.run.replyId, signal: work.run.signal, gatewayId: work.gatewayId,
    operationId: work.operationId, requestId: work.requestId })
}
/** One actual setup factory for this management transition, before construction. */
export function bindP5ApiSetupClientWork(ticket: P5ApiManagement, client: P5McpClientAdmission): void {
  const state = apiManagementOwners.get(ticket), work = state?.management.get(ticket)
  if (!state || !work || work.setup) throw new P5OriginalBootReadRefusal()
  assertP5ApiManagementCurrent(ticket, work.gatewayId)
  bindP5ApiClientWork(work.run.handle, client)
  work.setup = client
}
export function notifyP5ApiManagement(ticket: P5ApiManagement): void {
  const state = apiManagementOwners.get(ticket)
  if (state) void refreshApiState(state)
}
/** Actual outer fresh-segment barrier, separate from the SDK stop predicate.
 * No wait on physical flights: unknown facts refuse, late facts remain observed. */
export async function assertP5ApiFreshSegment(preparation: P5OriginalPreparation | undefined): Promise<void> {
  const state = preparation && preparations.get(preparation)?.api
  if (!state) return
  await refreshApiState(state); currentApiState(state)
  if (state.pending || state.resume || [...state.clients.values()].some(work => !work.known) ||
    [...state.management.values()].some(work => work.result === 'pending' || work.result === 'unknown') ||
    [...state.parts.values()].some(part => !part.saved || state.managed && part.run && (!part.run.consumed || part.run.pause && !part.run.approvalResumeClaimed && !part.run.managementContinued))) {
    throw new P5OriginalBootReadRefusal()
  }
}
/** The outer owner's one-use passage. No model result or public journal can
 * supply source/target/physical/canonical completion here. */
export async function takeP5ApiVerifiedContinuation(preparation: P5OriginalPreparation): Promise<Readonly<{
  gateways: readonly string[]; originalScope: P5OriginalScope; transition: number
}> | undefined> {
  const state = preparations.get(preparation)?.api
  if (!state) return undefined
  await refreshApiState(state)
  currentApiState(state)
  if (state.positiveClosed || state.pending || state.resume || !state.task.scope || [...state.clients.values()].some(work => !work.known) ||
    [...state.management.values()].some(work => work.result === 'pending' || work.result === 'unknown')) return undefined
  const selected = [...state.management].find(([, work]) => !work.consumed && work.result === 'saved')
  if (!selected) return undefined
  const [ticket, work] = selected
  const part = state.parts.get(work.run.part)
  if (!part?.saved || !state.canonicalParts.has(work.run.part) || !work.run.consumed) return undefined
  const owner = await import('../../mcpGatewaySave')
  currentApiState(state)
  const completed = await owner.readP5ApiPrerequisiteCompletion(ticket)
  currentApiState(state)
  if (!completed || state.management.get(ticket) !== work || work.consumed || !part.saved || !work.run.consumed ||
    state.pending || state.resume || [...state.clients.values()].some(client => !client.known)) return undefined
  const self = completed.intent.subject.id === state.task.lookup.agentId
  const removal = self && completed.intent.membership === 'disable' ? [work.gatewayId] : []
  const addition = self && completed.intent.membership === 'enable' && completed.plan && !state.task.removedGateways.has(work.gatewayId) ? [work.gatewayId] : []
  const previous = state.task.gatewayFrontier ?? state.task.scope.gateways
  const next = planFreshMcpScope({ gatewayIds: previous, provenance: 'inherited-run', snapshotId: `${state.task.taskId}:${state.task.managementTransitions}:before` },
    { add: addition, remove: removal }, { verifiedAdditions: addition, permittedGatewayIds: [...new Set([...previous, ...addition])].filter(id => !state.task.removedGateways.has(id)),
      nextSnapshotId: `${state.task.taskId}:${state.task.managementTransitions}:after` })
  // No awaited work after the actual final raw cut and this claim. All scope
  // additions come only from the SAME consumed approved/verified actor target.
  currentApiState(state)
  work.consumed = true; work.verifiedPlan = self && completed.intent.membership === 'enable' && !state.task.scope.gateways.includes(work.gatewayId) ? completed.plan : undefined; work.run.managementContinued = true
  for (const id of removal) state.task.removedGateways.add(id)
  state.task.gatewayFrontier = next.gatewayIds
  return Object.freeze({ gateways: next.gatewayIds, originalScope: state.task.scope, transition: state.task.managementTransitions })
}


const apiLineages = new WeakMap<object, { state: ApiState; part: P5ApiReplyPart }>()
/** Actual route's original request view only, before its first model call. No compiler/media read. */
export function recordP5ApiRequestView(preparation: P5OriginalPreparation | undefined, input: { request: unknown; history: readonly PostTurnHistoryMessage[] }): void {
  const state = preparation && preparations.get(preparation)?.api
  if (!state || state.requestView) return
  currentApiState(state)
  if ([...state.parts.values()].some(part => part.run)) throw new P5OriginalBootReadRefusal()
  const words = typeof input.request === 'string' ? input.request : Array.isArray(input.request)
    ? input.request.map(part => typeof part === 'string' ? part : part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').join('') : ''
  state.requestView = { request: words.trim(), history: [...input.history] }
}
/** Actual registered part plus actual known canonical ACKs; no body lineage marker. */
export async function captureP5ApiCanonicalLineage(preparation: P5OriginalPreparation | undefined, part: P5ApiReplyPart | undefined): Promise<P5ApiCanonicalLineage | undefined> {
  const state = preparation && preparations.get(preparation)?.api
  if (!state || !part || !state.managed) return undefined
  await refreshApiState(state); currentApiState(state)
  if (!state.parts.has(part) || !state.requestView?.request) throw new P5OriginalBootReadRefusal()
  for (const [before, record] of state.parts) {
    if (before === part) break
    if (!record.saved || !state.canonicalParts.has(before)) throw new P5OriginalBootReadRefusal()
  }
  const handle = Object.freeze({}) as P5ApiCanonicalLineage
  apiLineages.set(handle, { state, part }); return handle
}
/** Pure facts for the existing whole-reply helper, never issuance/ready authority. */
export function readP5ApiCanonicalLineage(handle: P5ApiCanonicalLineage) {
  const lineage = apiLineages.get(handle)
  if (!lineage) throw new P5OriginalBootReadRefusal()
  const { state, part } = lineage
  currentApiState(state)
  if (!state.parts.has(part) || !state.requestView?.request) throw new P5OriginalBootReadRefusal()
  // API same-ID versions save the joined prefix. Keep only its newest known part.
  const latest = new Map<string, { version: number; projection: StoredReplyRecord }>()
  for (const [before, record] of state.parts) {
    if (before === part) break
    const projection = state.canonicalParts.get(before)
    if (!record.saved || !projection) throw new P5OriginalBootReadRefusal()
    latest.set(record.replyId, { version: record.version, projection })
  }
  return { request: state.requestView.request, history: state.requestView.history,
    earlier: [...latest.values()].map(item => item.projection) }
}


/** A retained operation binds to the original, not to an old request's now-retired run. */
export function assertP5ApiOperationOwner(original: P5ApiOriginalRun, current: P5ApiOriginalRun | undefined): void {
  const first = apiRun(original)
  if (!current || apiRun(current).state !== first.state) throw new P5OriginalBootReadRefusal()
  assertP5ApiRunCurrent(current)
}
/** The actual pending writer reserves before its write; policy remains write-free. */
export async function reserveP5ApiPendingApproval(handle: P5ApiOriginalRun, held: P5HeldMcpRecipe): Promise<P5PendingWriteObservation> {
  const [registry, owner] = await Promise.all([import('../settings/managementRuntime'), import('../../controlApprovals')])
  assertP5ApiRunCurrent(handle)
  const run = apiRun(handle), state = run.state, fact = await registry.settingsOperationRegistry.readP5HeldApiMcpRecipe(held, handle)
  assertP5ApiRunCurrent(handle)
  if (state.positiveClosed || state.pending || state.management.size >= 3 || fact.expiresAt <= Date.now() || fact.userId !== run.task.lookup.userId ||
    fact.agentId !== run.task.lookup.agentId || fact.sessionId !== run.task.sessionId) throw new P5OriginalBootReadRefusal()
  const observation = owner.createP5PendingWriteObservation()
  state.pending = { run, part: run.part, held, observation, inputHash: fact.inputHash, operationId: fact.operationId, expiresAt: fact.expiresAt }
  sessionWorkflows.set(run.task.sessionId, state); run.pause = true
  return observation
}
/** Read only actual private ACKs, including issued/unknown after a writer throws. */
export async function observeP5ApiPendingApproval(handle: P5ApiOriginalRun, observation: P5PendingWriteObservation, record?: object): Promise<void> {
  const run = apiRun(handle), state = run.state, pending = state.pending
  const owner = await import('../../controlApprovals')
  if (!pending || pending.run !== run || pending.observation !== observation) throw new P5OriginalBootReadRefusal()
  const writes = owner.readP5PendingWriteObservation(observation)
  const receipt = record ? owner.observeP5PendingApprovalWrite(record) : writes.length === 1 ? writes[0] : undefined
  if (!receipt || writes.length !== 1 || receipt !== writes[0]) { state.failed = true; return }
  const fact = owner.readP5PendingApprovalWrite(receipt)
  if (fact.userId !== run.task.lookup.userId || fact.agentId !== run.task.lookup.agentId || fact.sessionId !== run.task.sessionId ||
    fact.messageId !== run.replyId || fact.controlId !== 'sys.app_settings.native.change' || fact.inputHash !== pending.inputHash) { state.failed = true; return }
  pending.receipt = receipt; pending.cardId = fact.id
  // The actual created record supplies its server SDK mapping; no posted apr_ identity.
  const sdk = record && 'sdkApprovalId' in record ? record.sdkApprovalId : undefined
  if (typeof sdk === 'string' && sdk) {
    pending.sdkApprovalId = sdk
    // A pending SDK approval can end its loop before stopWhen runs. Retain only
    // this actual completed/unconsumed registry output after the matching ACK.
    holdP5ApiToolImages(handle)
  } else state.failed = true
}
/** Routing only to a genuine dormant API pending write under the new turn lock. */
export async function pendingP5ApiApproval(input: SessionInput & { userId: string; messageId?: string | null; responses: readonly { approvalId?: unknown }[] }): Promise<P5PendingApprovalWrite | undefined> {
  const state = sessionWorkflows.get(input.sessionId)
  if (!state || state.kind !== 'api') return undefined
  await refreshApiState(state)
  const pending = state.pending
  const lookup: Lookup = { ...state.task.lookup, signal: input.turn.stop.signal, used: true }
  if (!pending?.receipt || !state.dormant || state.sealed || state.failed || input.userId !== lookup.userId || input.messageId !== pending.run.replyId ||
    !input.responses.some(response => response.approvalId === pending.sdkApprovalId) || !ownedSession(lookup, input) || Date.now() >= pending.expiresAt ||
    state.parts.get(pending.part)?.pendingSaved !== pending.receipt || !pending.run.consumed) throw new P5OriginalBootReadRefusal()
  return pending.receipt
}
/** Attach narrowing DATA only. The actual API grant writer/receipts must still be claimed before the model runs. */
export function prepareP5ApiApprovalResume(input: SessionInput & { userId: string; signal: AbortSignal; pending: P5PendingApprovalWrite; answer: ApprovalAnswerOutcome }): P5OriginalPreparation {
  const state = sessionWorkflows.get(input.sessionId)
  if (!state || state.kind !== 'api' || state.pending?.receipt !== input.pending || !state.dormant || state.failed || state.sealed || !input.answer.ok) throw new P5OriginalBootReadRefusal()
  const lookup: Lookup = { ...state.task.lookup, signal: input.signal, used: true }
  if (!ownedSession(lookup, input) || input.userId !== lookup.userId || Date.now() >= state.pending.expiresAt) throw new P5OriginalBootReadRefusal()
  const before = state.task
  const task: Task = { ...before, lookup, turn: input.turn, retired: false, retirement: new AbortController(), runs: new Set(), cleanup: () => {} }
  const stop = () => { state.sealed = true; retireTask(task); void refreshApiState(state) }
  task.turn.stop.signal.addEventListener('abort', stop, { once: true }); input.signal.addEventListener('abort', stop, { once: true })
  task.cleanup = () => { task.turn.stop.signal.removeEventListener('abort', stop); input.signal.removeEventListener('abort', stop) }
  const preparation = Object.freeze({}) as P5OriginalPreparation
  preparations.set(preparation, { lookup, input, retired: false, resolved: task.scope, api: state })
  state.preparation = preparation; state.task = task; state.resume = { pending: input.pending, answer: input.answer }; state.dormant = false
  return preparation
}
/** Exact real API decideApproval result and same-await answer ACK. */
export async function settleP5ApiApprovalResume(preparation: P5OriginalPreparation | undefined, grants: object): Promise<void> {
  const state = preparation && preparations.get(preparation)?.api
  if (!state?.resume) return
  const [broker, answers, decisions] = await Promise.all([import('../../brokerControlApprovals'), import('../../approvalAnswerRecord'), import('../../controlApprovals')])
  const resumed = state.resume, observation = broker.observeP5ApiResumeGrant(grants)
  const answer = answers.observeP5ApprovalAnswerWrite(resumed.answer)
  if (!observation || observation.pending !== resumed.pending || !answer || state.failed || state.sealed || !state.pending || Date.now() >= state.pending.expiresAt) throw new P5OriginalBootReadRefusal()
  const answered = answers.readP5ApprovalAnswerWrite(answer), decided = decisions.readP5ApprovalDecisionWrite(observation.decision)
  if (decided.pending !== resumed.pending || !['approved', 'denied'].includes(decided.status) || decided.identity.id !== state.pending.cardId ||
    answered.userId !== state.task.lookup.userId || answered.sessionId !== state.task.sessionId || answered.messageId !== state.pending.run.replyId ||
    !answered.approvalIds.includes(state.pending.sdkApprovalId!)) throw new P5OriginalBootReadRefusal()
  // No await between final current/expiry/receipt checks and one-use claims.
  currentApiState(state)
  answers.consumeP5ApprovalAnswerWrite(answer); decisions.consumeP5ApprovalDecisionWrite(observation.decision)
  state.pending.run.approvalResumeClaimed = true // actual one-use SDK answer, never a save-only continuation grant
  if (decided.status === 'denied') state.positiveClosed = true // preserve ordinary SDK denial handling under original A/[], without another setup transition
  state.resume = undefined; state.pending = undefined
}

/** Original narrowing DATA before compile/discovery, never a current/effect certificate. */
export function p5ApiPreparedScope(preparation: P5OriginalPreparation | undefined): P5OriginalScope | undefined {
  const held = preparation && preparations.get(preparation)
  return held?.api?.task.scope ?? held?.resolved
}
export function p5ApiPreparedGatewayFrontier(preparation: P5OriginalPreparation | undefined): readonly string[] | undefined {
  const held = preparation && preparations.get(preparation)
  return held?.api?.task.gatewayFrontier ?? held?.resolved?.gateways
}

/** The resolver's original-scope ceiling: only the genuine API preparation
 * may narrow merged tool defaults before discovery. DATA never widens a scope. */
export function restrictP5ApiPreparedTools(preparation: P5OriginalPreparation, selections: readonly string[] | undefined,
  identity: { userId: string; agentId?: string | null }): string[] {
  const held = preparations.get(preparation)
  if (!held?.api || held.retired || held.api.preparation !== preparation) throw new P5OriginalBootReadRefusal()
  const actor = readP5ApiManagementIdentity(preparation)
  if (actor.userId !== identity.userId || actor.agentId !== identity.agentId) throw new P5OriginalBootReadRefusal()
  const scope = p5ApiPreparedScope(preparation)
  if (!scope) throw new P5OriginalBootReadRefusal()
  return (selections ?? []).filter(id => scope.tools.includes(id))
}

/** Fixed actual API brain binds its own registry. No ready/effect permission is returned. */
export function bindP5ApiToolImages(handle: P5ApiOriginalRun, registry: EphemeralImageRegistry): void {
  assertP5ApiRunCurrent(handle)
  const run = apiRun(handle)
  if (run.images) throw new P5OriginalBootReadRefusal()
  run.images = registry
}
export function observeP5ApiStepTools(handle: P5ApiOriginalRun, completedToolIds: readonly string[]): void {
  const run = apiRun(handle)
  // Late actual output may be recorded after Stop; this does not issue another step.
  run.completedToolIds = ids(completedToolIds)
}
export function holdP5ApiToolImages(handle: P5ApiOriginalRun): void {
  const run = apiRun(handle)
  if (!run.pause || !run.images || !run.completedToolIds) return
  const pending = takeCompletedToolImages(run.images, run.completedToolIds)
  if (run.state.media.length + pending.length > 32) { run.state.failed = true; throw new P5OriginalBootReadRefusal() }
  run.state.media.push(...pending)
}
export function moveP5ApiToolImages(handle: P5ApiOriginalRun, registry: EphemeralImageRegistry, lane: ToolResultImageLane): { ids: string[]; deferred: string[] } {
  assertP5ApiRunCurrent(handle)
  const state = apiRun(handle).state, entries = state.media
  const moved = restoreCompletedToolImages(registry, entries, lane)
  state.media = []
  return moved
}

/** Fixed MCP owner may issue only within the original A/frontier; a management
 * boundary closes later positive starts even inside the SDK's parallel step. */
export function readP5ApiMcpAuthority(handle: P5ApiOriginalRun, gatewayId: string) {
  assertP5ApiRunCurrent(handle)
  const run = apiRun(handle), allowed = run.task.gatewayFrontier ?? run.task.scope?.gateways ?? []
  if (run.pause || run.state.pending || !allowed.includes(gatewayId) || run.task.removedGateways.has(gatewayId)) throw new P5OriginalBootReadRefusal()
  const verified = [...run.state.management.values()].findLast(work => work.consumed && work.gatewayId === gatewayId && work.verifiedPlan)
  return Object.freeze({ userId: run.task.lookup.userId, agentId: run.task.lookup.agentId, sessionId: run.task.sessionId,
    replyId: run.replyId, signal: run.signal, gatewayId, deadlineAt: run.task.lookup.deadlineAt, ...(verified?.verifiedPlan ? { preparedSource: verified.verifiedPlan } : {}) })
}

/** Restrictive actual client slot before construction; facts come only from the owning client. */
export function bindP5ApiClientWork(handle: P5ApiDiscoveryOwner, client: P5McpClientAdmission): void {
  assertP5ApiDiscoveryCurrent(handle)
  const state = apiDiscoveryState(handle)
  if (state.clients.size >= 32 || state.clients.has(client)) throw new P5OriginalBootReadRefusal()
  state.clients.set(client, { known: false })
}
/** Notification only; late actual facts are read from the physical owner. */
export function notifyP5ApiClientWork(handle: P5ApiDiscoveryOwner): void {
  void refreshApiState(apiDiscoveryState(handle))
}

/** The actual retained MCP Settings recipe opts into its restrictive passage.
 * This closes no unrelated effects and grants no verification/use permission. */
export function recordP5ApiManagementIntent(handle: P5ApiOriginalRun): void {
  assertP5ApiRunCurrent(handle)
  const state = apiRun(handle).state
  if (state.positiveClosed) throw new P5OriginalBootReadRefusal()
  state.managed = true
}
export function p5ApiManagedMcpActiveForDiscovery(handle: P5ApiDiscoveryOwner): boolean {
  assertP5ApiDiscoveryCurrent(handle)
  return apiDiscoveryState(handle).originalA?.closed === true
}
export function p5ApiManagedMcpActive(handle: P5ApiOriginalRun): boolean {
  return apiRun(handle).state.managed
}
