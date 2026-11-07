import { jsonTextOf } from '$lib/server/redisJsonCompareAndWrite'
import { AbortError } from 'redis'
import type { AdapterContext } from '../managementTypes'
import type { SettingsRedisClient } from '../settings/conditionalAgentSettings'
import { acquireSettingsMutation, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from '../settings/lifecycle'
import { AppActionsManagementRefusal } from '../settings/authority'
import { isProfileText } from './profilePrimitives'

// The normal human CAS remains unchanged. This UNEXPOSED writer binds original
// target/authority/source/key preimages and Redis TIME. The genuine operation's
// actor/approval/normalized-postimage issuer is still required before exposure.
export const CONDITIONAL_MCP_GATEWAY_WRITE_SCRIPT = `
local fences = cjson.decode(ARGV[5])
for index, checks in ipairs(fences) do
  for _, check in ipairs(checks) do
    if (redis.call('JSON.GET', KEYS[index + 1], check[1]) or '') ~= check[2] then return 'AUTHORITY_CHANGED' end
  end
end
local now = redis.call('TIME')
if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[4]) then return 'EXPIRED' end
if (redis.call('JSON.GET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 'CONFLICT' end
local written = redis.call('JSON.SET', KEYS[1], ARGV[1], ARGV[3])
if type(written) == 'table' and written.ok == 'OK' then
  -- The write is already KNOWN even when its additional raw evidence is unavailable.
  -- Never turn a failed post-read into an apparent unwritten command/retry.
  local postPath = ARGV[1]
  if postPath == '$' then
    -- CREATE writes the registry, but the retained source evidence belongs only
    -- to its exact assigned gateway. Do not bind unrelated source rows.
    local count = redis.pcall('JSON.ARRLEN', KEYS[1], '$.gateways')
    if type(count) ~= 'table' or type(count[1]) ~= 'number' or count[1] > 256 then return {'SAVED_POSTIMAGE_UNAVAILABLE'} end
    local found = nil
    for index = 0, count[1] - 1 do
      local identity = redis.pcall('JSON.GET', KEYS[1], '$.gateways[' .. index .. '].id')
      if type(identity) ~= 'string' then return {'SAVED_POSTIMAGE_UNAVAILABLE'} end
      local valid, ids = pcall(cjson.decode, identity)
      if not valid or type(ids) ~= 'table' then return {'SAVED_POSTIMAGE_UNAVAILABLE'} end
      if ids[1] == ARGV[6] then
        if found ~= nil then return {'SAVED_POSTIMAGE_UNAVAILABLE'} end
        found = index
      end
    end
    if found == nil then return {'SAVED_POSTIMAGE_UNAVAILABLE'} end
    postPath = '$.gateways[' .. found .. ']'
  end
  local post = redis.pcall('JSON.GET', KEYS[1], postPath)
  if type(post) ~= 'string' then return {'SAVED_POSTIMAGE_UNAVAILABLE'} end
  return {'OK', post}
end
return 'UNWRITTEN'
`
export type GatewayRawFence = Readonly<{ key: string; paths: readonly (readonly [string, string])[] }>
/** Finite MCP raw frame only. Map insertion order preserves the actual first
 * destination/target key; same key/path/raw dedupes, conflict never wins. */
export function joinMcpRawFences(...groups: readonly (readonly GatewayRawFence[])[]): GatewayRawFence[] {
  const keys = new Map<string, Map<string, string>>()
  for (const group of groups) for (const fence of group) {
    if (!fence.key || !fence.paths.length) throw new Error('Invalid server-owned MCP raw fence.')
    let paths = keys.get(fence.key)
    if (!paths) { paths = new Map(); keys.set(fence.key, paths) }
    for (const [path, raw] of fence.paths) {
      if (!path.startsWith('$') || typeof raw !== 'string') throw new Error('Invalid server-owned MCP raw fence.')
      if (paths.has(path) && paths.get(path) !== raw) throw new Error('The required original MCP raw facts conflict.')
      paths.set(path, raw)
    }
  }
  if (keys.size > 16 || [...keys.values()].some(paths => paths.size > 64)) throw new Error('The complete original A+C cut exceeds its existing capacity.')
  return [...keys].map(([key, paths]) => ({ key, paths: [...paths] }))
}

declare const gatewayWriteBrand: unique symbol
export type GatewayManagementWriteContext = Readonly<{ readonly [gatewayWriteBrand]: true }>
type ContextInput = Readonly<{
  mode: 'create' | 'update'
  gatewayId: string
  expectedRaw: string
  approvedPostimage: unknown
  adapter: AdapterContext
  fences: readonly GatewayRawFence[]
  additionalLifecycle?: SettingsLifecycleSnapshot
  beforeIssue(): void
  onSaved(postWriteRaw?: string): void
}>
type WriteState = {
  mode: 'create' | 'update'; gatewayId: string; expectedRaw: string; userId: string; registryKey: string
  approvedLogicalWrite: string; adapter: AdapterContext; originalActor: string; lifecycle: SettingsLifecycleSnapshot
  fences: readonly GatewayRawFence[]; signals: readonly AbortSignal[]; deadlineAt: number
  assertCurrent(): void; beforeIssue(): void; onSaved(postWriteRaw?: string): void
  phase: 'fresh' | 'claimed' | 'issued' | 'saved' | 'refused' | 'unknown'
}
const writes = new WeakMap<object, WriteState>()
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]))
  return value
}
/** Only UPDATE owns a generated updated_at. CREATE is an exact postimage. The
 * serialization compared here is the SAME one later sent to Redis, never a
 * second getter/toJSON evaluation. No secret-derived fingerprint is exported. */
function logicalWrite(mode: 'create' | 'update', gatewayId: string, serialized: string): string {
  const snapshot = JSON.parse(serialized) as Record<string, unknown>
  const logicalGateway = (gateway: unknown, update: boolean) => {
    if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway) || (gateway as Record<string, unknown>).id !== gatewayId) throw new Error('Invalid approved gateway postimage.')
    if (!update) return gateway
    const { updated_at: _ownedTimestamp, ...logical } = gateway as Record<string, unknown>
    return logical
  }
  let logical: unknown
  if (mode === 'update') logical = logicalGateway(snapshot, true)
  else {
    if (!Array.isArray(snapshot.gateways) || snapshot.gateways.filter(row => row && typeof row === 'object' && (row as Record<string, unknown>).id === gatewayId).length !== 1) throw new Error('Invalid approved registry postimage.')
    logical = { ...snapshot, gateways: snapshot.gateways.map(row => row && typeof row === 'object' && (row as Record<string, unknown>).id === gatewayId ? logicalGateway(row, false) : row) }
  }
  return jsonTextOf(ordered(logical))
}
const actorIdentity = (adapter: AdapterContext) => {
  const actor = adapter.admission.actor
  return JSON.stringify([actor.userId, actor.kind, actor.id, actor.generation, actor.sessionId])
}
function requireWrite(context: GatewayManagementWriteContext): WriteState {
  const state = writes.get(context)
  if (!state) throw new AppActionsManagementRefusal('MCP_WRITE_CUSTODY_REQUIRED', 'The original gateway write is unavailable.', 409)
  return state
}
function assertCurrent(state: WriteState): void {
  assertSettingsLifecycle(state.lifecycle)
  state.assertCurrent()
  if (actorIdentity(state.adapter) !== state.originalActor || !Number.isFinite(state.deadlineAt) || state.signals.some(signal => signal.aborted) || Date.now() >= state.deadlineAt) {
    throw new AppActionsManagementRefusal('MCP_OPERATION_ENDED', 'The original gateway operation has ended.', 409)
  }
}
/** Unexposed operation-input binding, NOT authentication/approval by itself.
 * A genuine MCP operation issuer/approved normalization owner is not wired yet;
 * structural AdapterContext or a callback must never be advertised as that proof. */
export function createGatewayManagementWriteContext(input: ContextInput): GatewayManagementWriteContext {
  if (!isProfileText(input.gatewayId, 128) ||
    typeof input.expectedRaw !== 'string' || !input.expectedRaw.isWellFormed() || !['create', 'update'].includes(input.mode) ||
    !input.adapter.admission.fence.lifecycle || input.adapter.admission.fence.paths.length === 0 || !Number.isFinite(input.adapter.deadlineAt)) {
    throw new AppActionsManagementRefusal('MCP_WRITE_CUSTODY_REQUIRED', 'The exact admitted MCP write custody is unavailable.', 409)
  }
  input.adapter.assertCurrent()
  const userId = input.adapter.admission.actor.userId
  if (!isProfileText(userId, 128)) throw new Error('An owned gateway destination is required.')
  const fences = joinMcpRawFences([input.adapter.admission.fence], input.fences).map(fence => Object.freeze({ key: fence.key,
    paths: Object.freeze(fence.paths.map(([jsonPath, raw]) => Object.freeze([jsonPath, raw] as const))) }))
  if (fences.some(fence => !fence.key || fence.paths.length === 0 || fence.paths.some(([jsonPath, raw]) => !jsonPath.startsWith('$') || typeof raw !== 'string'))) {
    throw new Error('Invalid server-owned MCP raw fence.')
  }
  const actorLifecycle = input.adapter.admission.fence.lifecycle
  if (input.additionalLifecycle && input.additionalLifecycle.epoch !== actorLifecycle.epoch) throw new Error('The original target lifecycle changed.')
  const joinedLifecycle = { epoch: actorLifecycle.epoch, records: [...actorLifecycle.records, ...(input.additionalLifecycle?.records ?? [])] }
  assertSettingsLifecycle(joinedLifecycle)
  const state: WriteState = { mode: input.mode, gatewayId: input.gatewayId, expectedRaw: input.expectedRaw,
    userId, registryKey: 'mcp_gateways:' + userId, approvedLogicalWrite: logicalWrite(input.mode, input.gatewayId, jsonTextOf(input.approvedPostimage)),
    adapter: input.adapter, originalActor: actorIdentity(input.adapter),
    lifecycle: structuredClone(joinedLifecycle), fences: Object.freeze(fences),
    signals: Object.freeze([...new Set([input.adapter.signal, input.adapter.admission.signal].filter((signal): signal is AbortSignal => signal !== undefined))]),
    deadlineAt: Math.min(input.adapter.deadlineAt, input.adapter.admission.expiresAt ?? Infinity),
    assertCurrent: input.adapter.assertCurrent.bind(input.adapter), beforeIssue: input.beforeIssue, onSaved: input.onSaved, phase: 'fresh' }
  assertCurrent(state)
  const value = Object.freeze({}) as GatewayManagementWriteContext
  writes.set(value, state)
  return value
}
export function assertGatewayManagementDestination(context: GatewayManagementWriteContext, mode: 'create' | 'update', gatewayId: string, userId: string, key: string): void {
  const state = requireWrite(context)
  if (state.mode !== mode || state.gatewayId !== gatewayId || state.userId !== userId ||
    state.registryKey !== key || key !== 'mcp_gateways:' + userId) {
    throw new AppActionsManagementRefusal('MCP_DESTINATION_CONFLICT', 'The approved gateway destination does not match this operation.', 409)
  }
  assertCurrent(state)
}
export function assertGatewayManagementWriteContext(context: GatewayManagementWriteContext, mode: 'create' | 'update', gatewayId: string, raw: string, key: string): void {
  const state = requireWrite(context)
  assertGatewayManagementDestination(context, mode, gatewayId, state.userId, key)
  if (state.expectedRaw !== raw) {
    throw new AppActionsManagementRefusal('MCP_CONFIGURATION_CONFLICT', 'The approved exact gateway configuration changed; no write was issued.', 409)
  }
  assertCurrent(state)
  if (state.phase !== 'fresh') throw new AppActionsManagementRefusal('MCP_WRITE_ALREADY_ISSUED', 'Reconcile this operation’s existing gateway write; it cannot issue again.', 409)
}
export type GatewayConditionalClient = SettingsRedisClient
export class GatewayManagementWriteUnconfirmed extends Error {
  readonly code = 'MCP_GATEWAY_WRITE_UNCONFIRMED'
  constructor(readonly gatewaySaved: boolean, readonly gatewayId: string, cause: unknown) {
    super(gatewaySaved ? 'The gateway was saved, but its operation journal did not confirm.' : 'The issued gateway write has an unknown outcome; reconcile its original assigned ID before another effect.', { cause })
    this.name = 'GatewayManagementWriteUnconfirmed'
  }
}
/** Call after actual Redis client acquisition. Never retry an issued/unknown command. */
export async function writeManagedGateway(client: GatewayConditionalClient, context: GatewayManagementWriteContext,
  input: { mode: 'create' | 'update'; gatewayId: string; key: string; path: string; raw: string; value: unknown }): Promise<void> {
  const state = requireWrite(context)
  const operation = Object.freeze({ mode: input.mode, gatewayId: input.gatewayId, key: input.key, path: input.path, raw: input.raw })
  assertGatewayManagementWriteContext(context, operation.mode, operation.gatewayId, operation.raw, operation.key)
  const serialized = jsonTextOf(input.value)
  if (logicalWrite(operation.mode, operation.gatewayId, serialized) !== state.approvedLogicalWrite) {
    throw new AppActionsManagementRefusal('MCP_INTENT_CONFLICT', 'The normalized gateway write does not match its immutable approved postimage.', 409)
  }
  if (operation.mode === 'create' ? operation.path !== '$' : !/^\$\.gateways\[(?:0|[1-9][0-9]*)\]$/.test(operation.path)) {
    throw new AppActionsManagementRefusal('MCP_DESTINATION_CONFLICT', 'The gateway write path does not match its fixed operation kind.', 409)
  }
  const lease = acquireSettingsMutation(state.lifecycle)
  const abort = new AbortController()
  const cancelled = () => abort.abort()
  const events = ['error', 'end', 'reconnecting'] as const
  let deadline: ReturnType<typeof setTimeout> | undefined
  let claimed = false, issued = false, settled = false, saved = false
  try {
    for (const event of events) client.on(event, cancelled)
    for (const signal of state.signals) {
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) cancelled()
    }
    const deadlineAt = state.deadlineAt
    const delay = deadlineAt - Date.now()
    if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) throw new AppActionsManagementRefusal('MCP_OPERATION_ENDED', 'The original gateway operation has ended.', 409)
    deadline = setTimeout(cancelled, delay)
    // This is the final synchronous lifecycle/Stop/deadline boundary before EVAL.
    const admit = () => {
      lease.check(); assertCurrent(state)
      if (!client.isOpen || !client.isReady || abort.signal.aborted) throw new AppActionsManagementRefusal('MCP_STORE_NOT_READY', 'The gateway write was not issued to an available store.', 409)
    }
    // Claim synchronously before hooks/issue: parallel same-context entries join the
    // operation flight above this leaf; they cannot both issue a registry effect.
    if (state.phase !== 'fresh') throw new AppActionsManagementRefusal('MCP_WRITE_ALREADY_ISSUED', 'The exact gateway write has already been claimed.', 409)
    state.phase = 'claimed'
    claimed = true
    admit()
    state.beforeIssue()
    admit()
    let answer: unknown
    try {
      const command = client.withAbortSignal(abort.signal)
      // The actual node-redis command receives its abort signal. Recheck AFTER
      // command acquisition as well; a due clock check cannot rely on timers.
      admit()
      issued = true
      state.phase = 'issued'
      answer = await command.eval(CONDITIONAL_MCP_GATEWAY_WRITE_SCRIPT, {
        keys: [operation.key, ...state.fences.map(item => item.key)],
        arguments: [operation.path, operation.raw, serialized, String(deadlineAt), JSON.stringify(state.fences.map(item => item.paths)), operation.gatewayId]
      })
    } catch (error) {
      // Same installed node-redis contract as conditionalAgentSettings: AbortError
      // with this aborted command proves removal from toWrite BEFORE send.
      if (abort.signal.aborted && error instanceof AbortError) {
        issued = false
        throw new AppActionsManagementRefusal('MCP_WRITE_UNSENT', 'Stop, deadline or disconnect removed the unsent gateway command. Reconcile this operation before continuing.', 409)
      }
      throw error
    }
    const savedAnswer = Array.isArray(answer) && ['OK', 'SAVED_POSTIMAGE_UNAVAILABLE'].includes(String(answer[0]))
    if (!savedAnswer && !['AUTHORITY_CHANGED', 'EXPIRED', 'CONFLICT', 'UNWRITTEN'].includes(String(answer))) throw new Error('Unexpected conditional gateway write answer.')
    lease.settle(); settled = true
    state.phase = savedAnswer ? 'saved' : 'refused'
    if (!savedAnswer) throw new AppActionsManagementRefusal(`MCP_WRITE_${String(answer)}`, 'The approved MCP write was refused without changing the gateway.', 409)
    saved = true
    // The old known-write observer still runs when optional raw evidence cannot
    // be used. Only the full prerequisite owner requires a valid actual tuple.
    const postRaw = Array.isArray(answer) && answer.length === 2 && answer[0] === 'OK' && typeof answer[1] === 'string' &&
      answer[1].isWellFormed() && Buffer.byteLength(answer[1], 'utf8') <= 1048576 ? answer[1] : undefined
    state.onSaved(postRaw)
  } catch (error) {
    // A known script refusal is settled. A rejected issued EVAL is ambiguous.
    if (!issued) { lease.settle(); if (claimed && (state.phase === 'claimed' || state.phase === 'issued')) state.phase = 'refused' }
    else if (!settled) { state.phase = 'unknown'; lease.unknown(); throw new GatewayManagementWriteUnconfirmed(false, state.gatewayId, error) }
    else if (saved) throw new GatewayManagementWriteUnconfirmed(true, state.gatewayId, error)
    throw error
  } finally {
    for (const event of events) client.removeListener(event, cancelled)
    for (const signal of state.signals) signal.removeEventListener('abort', cancelled)
    if (deadline !== undefined) clearTimeout(deadline)
  }
}
