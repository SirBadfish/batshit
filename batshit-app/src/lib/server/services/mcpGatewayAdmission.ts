/** Server-only original MCP admission and settlement. This module must stay
 * below discovery and the physical clients: client imports here are types only. */
import * as originalAOwner from './appActions/mcp/originalTask'
import type { P5ApiOriginalRun, P5ApiManagement, P5ApiDiscoveryOwner } from './appActions/mcp/originalTask'
import { mcpGatewayService, type OriginalMcpStdioSource } from './mcpGatewayService'
import type { ResolvedStdioGatewayProcessConfig } from './mcpGatewayStdio'
import type { N8nMCPGatewayClient } from './n8nMCPGatewayClient'
import type { StdioMCPGatewayClient } from './stdioMCPGatewayClient'
import type { Tool } from 'ai'
import { z } from 'zod'
import { normalizeDcmDisplaySettings, normalizeGatewayDcmDisplaySettings, normalizeLegacyDcmGroupMode, normalizeLegacyDcmToolMode } from '$lib/utils/dcmDisplaySettings'
import { resolveMcpToolDcmVisibility } from './dynamicMcpVisibility'

/**
 * BL-454: resolve with `work`, or reject with the Stop's reason when `signal` aborts first.
 * A value that arrives after the Stop goes to `discardLate` (a started client is closed).
 * The listener is removed when either side settles.
 */
export function settleBeforeAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  discardLate: (value: T) => void
): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    let stopped = false
    const onAbort = () => {
      stopped = true
      reject(signal.reason)
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (stopped) discardLate(value)
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        if (!stopped) reject(error)
      }
    )
  })
}

declare const p5ClientBrand: unique symbol
export type P5McpClientAdmission = Readonly<{ readonly [p5ClientBrand]: true }>
type P5UseClient = { kind: 'use'; run: P5ApiOriginalRun; userId: string; gatewayId: string; source: string; keyName: string | null;
  actorIdentityRaw: string; keyReference?: { key: string; raw: string }; url: string; headers: Record<string, string>; signal?: AbortSignal;
  toolName: string; displayName: string; groupName: string; expectedSchema: unknown; arguments: Record<string, unknown>; verifiedPlan?: import('./mcpGatewayService').PreparedGatewaySave }
type P5SetupClient = {
  kind: 'setup'; run: P5ApiOriginalRun; reservation: P5ApiManagement;
  userId: string; gatewayId: string; source: string; actorIdentityRaw: string; url: string; headers: Record<string, string>; signal: AbortSignal;
  plan: import('./mcpGatewayService').PreparedGatewaySave; adapter: import('./appActions/managementTypes').AdapterContext;
  fences: readonly import('./appActions/mcp/gatewayWriteContext').GatewayRawFence[]
}
type P5DiscoveryClient = { kind: 'verified-discovery'; run: P5ApiDiscoveryOwner; plan: import('./mcpGatewayService').PreparedGatewaySave; userId: string; gatewayId: string; source: string; actorIdentityRaw: string; url: string; headers: Record<string, string>; signal: AbortSignal }
type P5OriginalDiscoveryClient = { kind: 'original-discovery'; run: P5ApiDiscoveryOwner; original: OriginalMcpStdioSource; userId: string; gatewayId: string; source: string; actorIdentityRaw: string; url: string; headers: Record<string, string>; signal: AbortSignal }
type P5OriginalObservation = { kind: 'original-observation'; run: P5ApiDiscoveryOwner; original?: OriginalMcpStdioSource; userId: string; gatewayId: string; source: string; actorIdentityRaw: string; url: string; headers: Record<string, string>; signal: AbortSignal }
type P5Client = (P5UseClient | P5SetupClient | P5DiscoveryClient | P5OriginalDiscoveryClient | P5OriginalObservation) & { original?: OriginalMcpStdioSource; stdio?: { plan?: import('./mcpGatewayService').PreparedGatewaySave; original?: OriginalMcpStdioSource; resolved: ResolvedStdioGatewayProcessConfig } }
type HeldP5Client = P5Client & { readonly client: N8nMCPGatewayClient | StdioMCPGatewayClient }
const p5Clients = new WeakMap<object, HeldP5Client>()
export function assertInitialStdioObservationIssue(handle: P5McpClientAdmission): void {
  const held = p5Clients.get(handle)
  if (!held || held.kind !== 'original-observation') throw new Error('The actual original-A observer is unavailable.')
  originalAOwner.assertP5InitialStdioIssue(held.run, handle); held.signal.throwIfAborted()
}
/** Compare, never substitute, the exact actual ordinary producer config. A
 * bounded optional comparison can only return DATA; it cannot launch late. */
export async function observeInitialStdioProduced(handle: P5McpClientAdmission, produced: ResolvedStdioGatewayProcessConfig): Promise<void> {
  const held = p5Clients.get(handle)
  if (!held || held.kind !== 'original-observation') throw new Error('The actual original-A producer observer is unavailable.')
  originalAOwner.assertP5InitialStdioObservationCurrent(held.run, handle); held.signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let matched = false
  try {
    if (held.original) {
      const deadline = Math.min(Date.now() + 5000, originalAOwner.readP5InitialStdioContext(held.run, handle).deadlineAt ?? Infinity)
      const compare = mcpGatewayService.matchOriginalMcpStdioLaunch(held.original, produced, deadline).then(() => true, () => false)
      matched = await Promise.race([compare, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())) })])
    }
  } finally { if (timer !== undefined) clearTimeout(timer) }
  originalAOwner.noteP5InitialStdioProduced(held.run, handle, matched)
  originalAOwner.assertP5InitialStdioObservationCurrent(held.run, handle); held.signal.throwIfAborted() // data cannot cross the genuine management seal
}
/** Only the actual owning STDIO map can vouch that this constructor exists. */
export function observeInitialStdioConstructor(handle: P5McpClientAdmission): void {
  const held = p5Clients.get(handle)
  if (!held || held.kind !== 'original-observation' || held.client.readHeldApiSettlement(handle).constructor !== 'started') throw new Error('The actual original-A constructor is unavailable.')
  originalAOwner.observeP5InitialStdioConstructor(held.run, handle)
}
export function readInitialStdioObservationSignal(handle: P5McpClientAdmission): AbortSignal {
  const held = p5Clients.get(handle)
  if (!held || held.kind !== 'original-observation') throw new Error('The actual original-A observation is unavailable.')
  return held.signal
}
/** Constructor reader is fixed and private-membership checked; no caller ready/purpose flag. */
function readP5McpAdmission(handle: P5McpClientAdmission) {
  const held = p5Clients.get(handle)
  if (!held) throw new Error('The actual original MCP client admission is unavailable.')
  if (held.kind === 'original-observation') throw new Error('An initial observation is not held-use authority.')
  if (held.stdio?.original) { originalAOwner.assertP5ApiOriginalStdioCurrent(held.run, held.stdio.original) }
  else if (held.stdio?.plan) mcpGatewayService.assertVerifiedMcpStdioFiles(held.stdio.plan)
  const actual = held.kind === 'setup' ? originalAOwner.readP5ApiManagementOwner(held.reservation) : held.kind === 'use' ? originalAOwner.readP5ApiMcpAuthority(held.run, held.gatewayId) : held.kind === 'original-discovery' ? (() => {
    originalAOwner.assertP5ApiOriginalStdioCurrent(held.run, held.original); return { userId: held.userId, signal: held.signal }
  })() : (() => {
    originalAOwner.assertP5ApiVerifiedMcpCurrent(held.run, held.gatewayId, held.plan)
    return { userId: held.userId, signal: held.signal }
  })()
  if (held.kind === 'setup') held.adapter.assertCurrent()
  held.signal?.throwIfAborted()
  if (actual.userId !== held.userId) throw new Error('The original MCP actor changed.')
  return { url: held.url, headers: { ...held.headers }, signal: held.signal ?? actual.signal, toolName: held.kind === 'use' ? held.toolName : undefined }
}
export function readP5McpHttpAdmission(handle: P5McpClientAdmission) {
  if (p5Clients.get(handle)?.stdio) throw new Error('The held STDIO source cannot issue HTTP.')
  return readP5McpAdmission(handle)
}
export function readP5McpStdioAdmission(handle: P5McpClientAdmission) {
  const actual = readP5McpAdmission(handle), held = p5Clients.get(handle)!
  if (!held.stdio) throw new Error('The actual retained STDIO launch is unavailable.')
  return { resolved: held.stdio.resolved, signal: actual.signal, toolName: actual.toolName }
}
function closeHeldForCaller(handle: P5McpClientAdmission) {
  const closing = heldClient(handle).closeForHeldApi(handle)
  return p5Clients.get(handle)?.stdio ? settleBeforeAbort(closing, p5Clients.get(handle)?.signal, () => {}) : closing
}
function heldClient(handle: P5McpClientAdmission) {
  const held = p5Clients.get(handle)
  if (!held) throw new Error('The actual MCP client owner is unavailable.')
  return held.client
}
/** Re-read the SAME source/ref after each awaited client stage, before the next dependent issue. */
export async function revalidateP5McpHttpAdmission(handle: P5McpClientAdmission): Promise<void> {
  const held = p5Clients.get(handle)
  if (!held) throw new Error('The actual original MCP source is unavailable.')
  if (held.kind === 'original-observation') throw new Error('Initial observation cannot issue held work.')
  readP5McpAdmission(handle)
  if (held.stdio?.original) {
    const actual = await originalAOwner.readP5ApiOriginalStdioAuthority(held.run, held.gatewayId)
    readP5McpAdmission(handle)
    if (!actual || actual.source !== held.stdio.original) throw new Error('The original A source changed.')
    await mcpGatewayService.withOriginalMcpStdioLaunch(actual.source, actual.deadlineAt, async () => {})
    const cut = await mcpGatewayService.readMcpPrerequisiteIssueCut(held.userId, actual.agentId, held.gatewayId, actual.deadlineAt, actual.fences)
    readP5McpAdmission(handle)
    if (cut.sourceRaw !== held.source || cut.actorIdentityRaw !== held.actorIdentityRaw) throw new Error('The original A changed before issue.')
    if (held.kind === 'use') assertP5ApiMcpToolDiscoverable(cut.actor, { ...cut.gateway }, actual, held.toolName, held.displayName, held.groupName)
    return
  }
  if (held.stdio?.plan) {
    await mcpGatewayService.withVerifiedMcpStdioLaunch(held.stdio.plan, async () => {})
    readP5McpAdmission(handle)
  }
  if (held.kind === 'verified-discovery' || held.kind === 'use' && held.verifiedPlan) {
    const plan = held.kind === 'verified-discovery' ? held.plan : held.verifiedPlan!
    const actual = await originalAOwner.readP5ApiVerifiedMcpAuthority(held.run, held.gatewayId)
    readP5McpAdmission(handle)
    if (!actual || actual.plan !== plan) throw new Error('The same verified C transition is unavailable.')
    const cut = await mcpGatewayService.readMcpPrerequisiteIssueCut(held.userId, actual.agentId, held.gatewayId, actual.deadlineAt, actual.fences)
    readP5McpAdmission(handle)
    if (cut.sourceRaw !== held.source || cut.sourceRaw !== mcpGatewayService.readPreparedMcpSource(plan).raw || cut.actorIdentityRaw !== held.actorIdentityRaw || !cut.gateway) throw new Error('The original verified source or actor changed before issue.')
    if (held.kind === 'use') assertP5ApiMcpToolDiscoverable(cut.actor, { ...cut.gateway }, { ...actual, gatewayId: held.gatewayId }, held.toolName, held.displayName, held.groupName)
    return
  }
  if (held.kind === 'setup') {
    const actor = originalAOwner.readP5ApiManagementOwner(held.reservation)
    await held.adapter.refreshAuthority()
    readP5McpAdmission(handle)
    const cut = await mcpGatewayService.readMcpPrerequisiteIssueCut(held.userId, actor.agentId, held.gatewayId, held.adapter.deadlineAt,
      mcpGatewayService.joinMcpPrerequisiteFences([held.adapter.admission.fence], held.fences))
    readP5McpAdmission(handle)
    if (cut.sourceRaw !== held.source || cut.actorIdentityRaw !== held.actorIdentityRaw) throw new Error('The exact setup source or actor changed before issue.')
    return
  }
  if (held.kind !== 'use') throw new Error('The held original discovery has no valid source.')
  const actor = originalAOwner.readP5ApiMcpAuthority(held.run, held.gatewayId)
  // Last asynchronous admission: fixed source/reference/current actor-DCM cut.
  // No secret resolution, policy lookup or other awaited work follows it.
  const cut = held.keyName === null
    ? await mcpGatewayService.readMcpPrerequisiteIssueCut(held.userId, actor.agentId, held.gatewayId, Math.min(actor.deadlineAt ?? Infinity, Date.now() + 120000), [])
    : await mcpGatewayService.readMcpHttpIssueCut(held.userId, actor.agentId, held.gatewayId, held.keyName)
  readP5McpAdmission(handle)
  if (cut.sourceRaw !== held.source || held.keyName !== null && (!held.keyReference || !('keyRaw' in cut) || cut.keyRaw !== held.keyReference.raw) ||
    cut.actorIdentityRaw !== held.actorIdentityRaw || !cut.gateway) throw new Error('The held MCP source, reference or API actor incarnation changed.')
  assertP5ApiMcpToolDiscoverable(cut.actor, { ...cut.gateway }, actor, held.toolName, held.displayName, held.groupName)
  readP5McpAdmission(handle)
}
function finiteMcpSchema(schema: unknown, depth = 0): asserts schema is Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 16) throw new Error('The MCP tool schema is unsupported.')
  const value = schema as Record<string, unknown>
  const allowed = new Set(['$schema','type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','description','title'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('The MCP schema uses unsupported constraints; no tool was issued.')
  const types = new Set(['object','array','string','number','integer','boolean','null'])
  if (value.type !== undefined && (Array.isArray(value.type)
    ? value.type.length === 0 || value.type.some(type => typeof type !== 'string' || !types.has(type))
    : typeof value.type !== 'string' || !types.has(value.type))) throw new Error('The MCP schema type is invalid.')
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string'))) throw new Error('The MCP schema required keys are invalid.')
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean' && (!value.additionalProperties || typeof value.additionalProperties !== 'object' || Array.isArray(value.additionalProperties))) throw new Error('The MCP schema additional-properties rule is invalid.')
  for (const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf']) {
    const limit = value[key]
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || key === 'multipleOf' && limit <= 0)) throw new Error('The MCP numeric constraint is invalid.')
  }
  for (const key of ['minItems','maxItems','minLength','maxLength']) {
    const limit = value[key]
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)) throw new Error('The MCP size constraint is invalid.')
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) throw new Error('The MCP enum constraint is invalid.')
  if (value.properties !== undefined) {
    if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) throw new Error('The MCP properties schema is invalid.')
    for (const child of Object.values(value.properties)) finiteMcpSchema(child, depth + 1)
  }
  if (value.items !== undefined) finiteMcpSchema(value.items, depth + 1)
  if (value.additionalProperties && typeof value.additionalProperties === 'object') finiteMcpSchema(value.additionalProperties, depth + 1)
}
export async function validateP5IntendedMcpArguments(expectedSchema: unknown, args: unknown): Promise<void> {
  const serialized = JSON.stringify(expectedSchema)
  if (!serialized || serialized.length > 65_536) throw new Error('The held MCP schema is unavailable or exceeds its budget.')
  finiteMcpSchema(expectedSchema)
  if (expectedSchema.type !== 'object' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('The held MCP call requires an object argument schema.')
  const argumentData = JSON.stringify(args)
  if (!argumentData || argumentData.length > 65_536) throw new Error('The intended MCP argument data exceeds the admitted original-call budget.')
  const { hashControlInput } = await import('./controlApprovals')
  const intended = z.fromJSONSchema(expectedSchema).safeParse(args)
  if (!intended.success || hashControlInput(intended.data) !== hashControlInput(args)) throw new Error('The intended MCP arguments do not match the held schema; no client was constructed.')
}
/** Actual fresh client tool, exact held identity/schema and arguments. No schema-only DTO grant. */
export async function validateP5McpHttpTool(handle: P5McpClientAdmission, name: string, tool: Tool) {
  const held = p5Clients.get(handle)
  if (!held || held.kind !== 'use' || held.toolName !== name) throw new Error('The actual MCP tool identity changed.')
  const schema = await Promise.resolve((tool.inputSchema as { jsonSchema?: unknown })?.jsonSchema ?? tool.inputSchema)
  readP5McpAdmission(handle)
  const { hashControlInput } = await import('./controlApprovals')
  readP5McpAdmission(handle)
  if (hashControlInput(schema) !== hashControlInput(held.expectedSchema)) throw new Error('The actual MCP tool schema changed.')
  const serialized = JSON.stringify(schema)
  if (!serialized || serialized.length > 65_536) throw new Error('The actual MCP tool schema exceeds its admitted budget.')
  finiteMcpSchema(schema)
  const parsed = z.fromJSONSchema(schema).safeParse(held.arguments)
  if (!parsed.success || hashControlInput(parsed.data) !== hashControlInput(held.arguments)) throw new Error('The intended MCP arguments do not match the fresh schema.')
  await revalidateP5McpHttpAdmission(handle)
  readP5McpAdmission(handle)
  return held.arguments
}
/** Setup admission can initialize/list/close only, never execute a tool. */
export function requireP5McpToolUse(handle: P5McpClientAdmission): void {
  if (p5Clients.get(handle)?.kind !== 'use') throw new Error('The actual setup client cannot execute a tool.')
}
/** Settlement identity only; valid after rights end, never new issue authority. */
export function readP5McpClientOwner(handle: P5McpClientAdmission): P5ApiDiscoveryOwner {
  const held = p5Clients.get(handle)
  if (!held) throw new Error('The actual MCP client owner is unavailable.')
  return held.run
}

/** Discovery is the trusted minting owner. Its fixed concrete clients supply
 * physical facts; neither admissions nor callers may provide a fact reader.
 * Protected methods are code organization, not an authorization boundary: the
 * real original-task owner and final source/Stop guards vouch for every handle. */
export abstract class P5McpAdmissionIssuer {
  readonly #http: N8nMCPGatewayClient
  readonly #stdio: StdioMCPGatewayClient

  protected constructor(http: N8nMCPGatewayClient, stdio: StdioMCPGatewayClient) {
    this.#http = http
    this.#stdio = stdio
  }

  protected retainP5McpClient(handle: P5McpClientAdmission, held: P5Client): void {
    p5Clients.set(handle, { ...held, client: held.stdio || held.kind === 'original-observation' ? this.#stdio : this.#http })
  }

  protected heldP5McpClient(handle: P5McpClientAdmission) { return heldClient(handle) }
  protected closeP5McpClientForCaller(handle: P5McpClientAdmission) { return closeHeldForCaller(handle) }
}

/** Fixed actual client owner facts. Missing/no issue is never claimed known close. */
export function readP5McpClientSettlement(handle: P5McpClientAdmission) {
  const run = readP5McpClientOwner(handle)
  const held = p5Clients.get(handle)!
  return { run, ...(held.kind === 'setup' ? { setup: held.reservation } : {}), ...heldClient(handle).readHeldApiSettlement(handle) }
}

/** Actual HTTP owner wakes an observation; this cannot mark ready/known. */
export function notifyP5McpClientSettlement(handle: P5McpClientAdmission): void {
  const held = p5Clients.get(handle)
  if (held) {
    const actual = heldClient(handle).readHeldApiSettlement(handle)
    if (actual.close === 'known') {
      if (held.stdio) {
        for (const name of Object.keys(held.stdio.resolved.env)) delete held.stdio.resolved.env[name]
      }
      if (actual.requests !== 'pending' && actual.requests !== 'unknown') held.headers = {}
    }
    originalAOwner.notifyP5ApiClientWork(held.run)
  }
}

/** Fixed live discoverability check for the private original, without the ordinary
 * resolver's catch/default path. Unknown reads never restore a hidden tool. */
export function assertP5ApiMcpToolDiscoverable(row: Record<string, unknown>, gateway: Record<string, unknown>,
  actor: { agentId: string; userId: string; gatewayId: string }, toolName: string, displayName: string, groupName: string): void {
  if (row.id !== actor.agentId || row.user_id !== actor.userId || row.agentType !== 'api' || typeof row.created_at !== 'string' || gateway.id !== actor.gatewayId) throw new Error('The actual Primary is unavailable.')
  // SAME ordinary resolveToolIdentity semantics: first matching exact tool ID,
  // a nonblank mcpName verbatim, otherwise Ungrouped Tools. A cached wrapper
  // cannot adopt a different current group and keep its former DCM authority.
  const groups = gateway.toolGroupings
  if (groups !== undefined && (!Array.isArray(groups) || groups.some(group => !group || typeof group !== 'object' || Array.isArray(group) ||
      typeof group.mcpName !== 'string' || !Array.isArray(group.toolIds) || group.toolIds.some((id: unknown) => typeof id !== 'string')))) throw new Error('The current MCP tool grouping is unreadable.')
  const first = Array.isArray(groups) ? groups.find(group => group.toolIds.includes(toolName)) : undefined
  const currentGroup = first?.mcpName.trim().length ? first.mcpName : 'Ungrouped Tools'
  if (currentGroup !== groupName) throw new Error('The held MCP tool group changed; discover the current tool before another choice.')
  const agentRaw = row.dcmDisplaySettings ?? row.dcm_display_settings ?? null
  const gatewayRaw = gateway.dcmDisplayDefaults ?? null
  for (const [rawIndex, raw] of [agentRaw, gatewayRaw].entries()) {
    if (raw == null) continue // actual observed absent settings use their documented defaults
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The current MCP visibility is unreadable.')
    for (const field of ['groups', 'tools'] as const) {
      const entries = (raw as Record<string, unknown>)[field]
      if (entries == null) continue
      if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error('The current MCP visibility map is unreadable.')
      for (const value of Object.values(entries)) {
        if (field === 'groups' ? !(rawIndex === 0 && value === 'use-global') && !normalizeLegacyDcmGroupMode(value) : !normalizeLegacyDcmToolMode(value)) throw new Error('The current MCP visibility mode is unsupported.')
      }
    }
  }
  const visible = resolveMcpToolDcmVisibility({ agentSettings: normalizeDcmDisplaySettings(agentRaw),
    gatewayDefaults: normalizeGatewayDcmDisplaySettings(gatewayRaw), gatewayId: actor.gatewayId, groupName,
    toolNameVariants: [toolName, displayName] })
  if (!visible.isToolDiscoverable) throw new Error('The actual MCP tool is no longer discoverable by this Primary.')
}
