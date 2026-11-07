import { redis } from '$lib/server/redis'
import type { AgentRow, MCPToolSelections } from '$lib/types/database'
import { isApiPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { mcpGatewayService } from './mcpGatewayService'
import { mcpGatewayDiscovery } from './mcpGatewayDiscovery'
import type { ToolMetadataMap } from './mcpGatewayTypes'
import {
  LEGACY_AGENT_MCP_SELECTION_FIELDS,
  buildDynamicOnlySelectionResetKey
} from './mcpRuntimePolicy'
import { runGatewayOrphanReferenceCleanup } from './mcpGatewayReferenceCleanup'
import { restrictP5ApiPreparedTools, type P5OriginalPreparation } from './appActions/mcp/originalTask'
import { PRIMARY_AGENT_TYPE_SOURCE_FIELDS } from '$lib/utils/primaryAgentType'
import { captureSettingsLifecycle, assertSettingsLifecycle, acquireSettingsMutation,
  type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'

interface MCPSelectionResolverOptions {
  userId: string
  agentId?: string | null
  agent?: AgentRow | null
  agentMetadata?: Record<string, any> | null
  /** Server-resolved scope for this run. Caller selections may only narrow it. */
  mcpGatewayScope?: string[] | null
  /** Untrusted discovery/execution filter, not an authority to add gateways. */
  selectedGateways?: string[] | null
  toolSelections?: MCPToolSelections | null
  /** Genuine in-process API preparation; never a body field or posted scope. */
  mcpOriginalPreparation?: P5OriginalPreparation
  includeGatewayToolMap?: boolean
}

export interface MCPSelectionResolution {
  resolvedGateways: string[]
  defaultGateways: string[] | null
  resolvedToolSelections: MCPToolSelections | undefined
  tools: ToolMetadataMap['tools']
  toolMetadata: ToolMetadataMap['metadata']
  gatewayToolMap: Record<string, string[]>
}

export interface DynamicMcpGatewayScopeResolution {
  resolvedGateways: string[]
  defaultGateways: string[] | null
  source: 'selected' | 'agent' | 'user-global'
}

/**
 * Merge agent defaults and chat overrides for MCP selections, then discover tools.
 * SA-009: MCPToolSelections is now a flat string[] of enabled tool names.
 */
export async function resolveMCPSelections(
  options: MCPSelectionResolverOptions
): Promise<MCPSelectionResolution> {
  const {
    userId,
    agentId,
    agent: preloadedAgent,
    agentMetadata,
    selectedGateways,
    toolSelections,
    includeGatewayToolMap
  } = options

  if (!userId) {
    throw new Error('Cannot resolve MCP selections without a userId')
  }

  // Dynamic-only migration (one-time): clear legacy direct tool lists.
  await runDynamicOnlySelectionReset(userId)

  // SA-096 P6 (one-time): repair references left behind by gateway deletes that
  // happened before `mcpGatewayService.delete()` swept them.
  await runGatewayOrphanReferenceCleanup(userId)

  let agent: AgentRow | null | undefined = preloadedAgent
  if (!agent && agentId) {
    agent = (await redis.get(`agent:${agentId}`)) as AgentRow | null
  }

  const scopeResolution = await resolveDynamicMcpGatewayScope({
    userId,
    agentId,
    agent,
    agentMetadata,
    // This entry point is used only while the server resolves the turn/profile. Its
    // selected gateways are the trusted chat-bar selection, which can widen defaults.
    mcpGatewayScope: selectedGateways
  })
  const { resolvedGateways, defaultGateways } = scopeResolution
  // SA-009: Tool selections are now flat string arrays
  const defaultSelections = normalizeToolSelectionsInput(
    agentMetadata?.defaultMCPToolSelections ?? agent?.defaultMCPToolSelections
  )
  const overrideSelections = normalizeToolSelectionsInput(toolSelections)
  let resolvedToolSelections = mergeToolSelections(defaultSelections, overrideSelections)

  if (agent && !isBatshitAgent(agent)) {
    resolvedToolSelections = filterBlockedTools(resolvedToolSelections)
  }
  if (options.mcpOriginalPreparation !== undefined) {
    resolvedToolSelections = restrictP5ApiPreparedTools(options.mcpOriginalPreparation, resolvedToolSelections, { userId, agentId })
  }

  const gatewayToolMap =
    includeGatewayToolMap === true
      ? await mcpGatewayDiscovery.buildGatewayToolMap({
          userId,
          selectedGatewayIds: resolvedGateways,
          toolSelections: resolvedToolSelections
        })
      : {}

  // Dynamic MCP-only runtime: gateway tools are never directly preloaded/injected.
  return {
    resolvedGateways,
    defaultGateways,
    resolvedToolSelections,
    tools: {},
    toolMetadata: new Map(),
    gatewayToolMap
  }
}

export async function resolveDynamicMcpGatewayScope(
  options: Pick<
    MCPSelectionResolverOptions,
    'userId' | 'agentId' | 'agent' | 'agentMetadata' | 'mcpGatewayScope' | 'selectedGateways'
  >
): Promise<DynamicMcpGatewayScopeResolution> {
  const { userId, agentId, agent: preloadedAgent, agentMetadata, mcpGatewayScope, selectedGateways } = options
  const hasScopedAgent =
    (typeof agentId === 'string' && agentId.trim().length > 0) ||
    preloadedAgent !== undefined ||
    agentMetadata !== undefined
  const requestedGateways = sanitizeStringArray(selectedGateways)
  const narrowToRequested = (scope: string[]): string[] =>
    requestedGateways === undefined
      ? scope
      : scope.filter((gatewayId) => requestedGateways.includes(gatewayId))

  // A supplied record must belong to this user even when a run snapshot is present.
  // A delegated per-run id need not have an `agent:` record, so the snapshot path
  // does not fetch one merely to validate an id bound by the caller's auth lane.
  if (preloadedAgent && preloadedAgent.user_id !== userId) {
    throw new Error('MCP gateway scope agent is not owned by this user')
  }
  if (agentMetadata?.user_id && agentMetadata.user_id !== userId) {
    throw new Error('MCP gateway scope metadata is not owned by this user')
  }

  // A run credential or in-process turn supplies this snapshot. Null and malformed
  // snapshots are explicit empty scopes; neither the caller's filter nor agent defaults
  // may turn them back into permission.
  if (mcpGatewayScope !== undefined) {
    const boundGateways = sanitizeStringArray(mcpGatewayScope) ?? []
    return {
      resolvedGateways: narrowToRequested(boundGateways),
      defaultGateways: null,
      source: 'selected'
    }
  }

  let agent: AgentRow | null | undefined = preloadedAgent
  if (!agent && agentId) {
    agent = (await redis.get(`agent:${agentId}`)) as AgentRow | null
  }

  // An id is not proof of ownership. Reject a stale or forged cross-user record
  // before its defaults can affect discovery.
  if (agent && agent.user_id !== userId) {
    throw new Error('MCP gateway scope agent is not owned by this user')
  }

  // A missing agent id cannot be repaired with a caller's selectedGateways list.
  // Server-supplied metadata may represent a delegated subagent rather than an
  // `agent:` record; when an id is given it must carry the same user ownership.
  if (agentId && !agent && agentMetadata && agentMetadata.user_id !== userId) {
    return { resolvedGateways: [], defaultGateways: [], source: 'agent' }
  }

  const defaultGateways = extractDefaultGateways(agentMetadata, agent)
  if (Array.isArray(defaultGateways)) {
    return {
      resolvedGateways: narrowToRequested(defaultGateways),
      defaultGateways,
      source: 'agent'
    }
  }

  if (hasScopedAgent) {
    return {
      resolvedGateways: [],
      defaultGateways: [],
      source: 'agent'
    }
  }

  const enabledGateways = await mcpGatewayService.listEnabled(userId)
  const fallbackGateways = Array.from(
    new Set(
      enabledGateways
        .map((gateway) => (typeof gateway?.id === 'string' ? gateway.id.trim() : ''))
        .filter((gatewayId) => gatewayId.length > 0)
    )
  )

  return {
    resolvedGateways: narrowToRequested(fallbackGateways),
    defaultGateways: null,
    source: 'user-global'
  }
}

function isBatshitAgent(agent: AgentRow | null) {
  if (!agent) return false
  return isApiPrimaryAgentType(normalizePrimaryAgentType(agent))
}

function filterBlockedTools(selections: MCPToolSelections | undefined) {
  if (!Array.isArray(selections)) return selections
  return selections.filter((tool) => {
    const normalized = tool?.toLowerCase?.() ?? ''
    if (!normalized) return false
    return !normalized.includes('code-mode') && !normalized.includes('code_mode')
  })
}

function extractDefaultGateways(
  agentMetadata?: Record<string, any> | null,
  agent?: AgentRow | null
): string[] | null {
  const metadataValue = agentMetadata?.defaultMCPGateways ?? agentMetadata?.default_mcp_gateways
  const agentValue = agent?.defaultMCPGateways ?? (agent as any)?.default_mcp_gateways

  if (Array.isArray(metadataValue)) {
    return sanitizeStringArray(metadataValue) ?? []
  }
  if (Array.isArray(agentValue)) {
    return sanitizeStringArray(agentValue) ?? []
  }
  return null
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)

  // Preserve empty arrays to represent "disable all"
  return Array.from(new Set(normalized))
}

/**
 * SA-009: Normalize tool selections - now just a flat string array
 */
function normalizeToolSelectionsInput(
  selections?: MCPToolSelections | null
): MCPToolSelections | undefined {
  // SA-009: MCPToolSelections is now string[]
  if (!selections) {
    return undefined
  }

  // Handle new format (flat array)
  if (Array.isArray(selections)) {
    const cleaned = selections
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
    return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined
  }

  // Legacy format (nested object) - extract all tool names and flatten
  // This handles any old data that might still be in the nested format
  if (typeof selections === 'object') {
    const allTools: string[] = []
    for (const mcpSelections of Object.values(selections)) {
      if (!mcpSelections || typeof mcpSelections !== 'object') continue
      for (const toolList of Object.values(mcpSelections as Record<string, string[] | undefined>)) {
        if (Array.isArray(toolList)) {
          toolList.forEach((t) => {
            if (typeof t === 'string' && t.trim().length > 0) {
              allTools.push(t.trim())
            }
          })
        }
      }
    }
    if (allTools.length > 0) {
      return Array.from(new Set(allTools))
    }
  }

  return undefined
}

/**
 * SA-009: Merge tool selections - just combine two string arrays
 */
export function mergeToolSelections(
  defaults?: MCPToolSelections,
  overrides?: MCPToolSelections
): MCPToolSelections | undefined {
  const defaultSet = new Set(Array.isArray(defaults) ? defaults : [])
  const hasOverrideInput = Array.isArray(overrides)
  const overrideSet = new Set(Array.isArray(overrides) ? overrides : [])

  // If overrides are provided (even an empty array), treat them as explicit.
  if (hasOverrideInput) {
    return Array.from(overrideSet).sort()
  }

  // Otherwise use defaults
  if (defaultSet.size > 0) {
    return Array.from(defaultSet).sort()
  }

  return undefined
}

const RESET_SOURCE_PATHS = [...new Set(['id', 'user_id', 'created_at', ...PRIMARY_AGENT_TYPE_SOURCE_FIELDS,
  ...LEGACY_AGENT_MCP_SELECTION_FIELDS])].map(field => `$.${field}`)
const READ_RESET_SOURCE = `-- fixed-dynamic-only-mcp-reset-read
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'INVALID'} end
local out = {'SOURCE'}
for _, path in ipairs(cjson.decode(ARGV[1])) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return out
`
const WRITE_RESET_SOURCE = `-- fixed-dynamic-only-mcp-reset-write
local paths = cjson.decode(ARGV[1])
local original = cjson.decode(ARGV[2])
local stamp = cjson.decode(ARGV[3])
if #paths ~= #original or type(stamp) ~= 'string' then return 'INVALID' end
for _, raw in ipairs(original) do if type(raw) ~= 'string' then return 'INVALID' end end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID' end
for index, path in ipairs(paths) do
  if (redis.call('JSON.GET', KEYS[1], path) or '') ~= original[index] then return 'CHANGED' end
end
for _, write in ipairs({{'$.defaultMCPToolSelections', '[]'}, {'$.default_mcp_tool_selections', '[]'}, {'$.updated_at', ARGV[3]}}) do
  local answer = redis.call('JSON.SET', KEYS[1], write[1], write[2])
  if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'UNCONFIRMED' end
end
return 'OK'
`
const WRITE_RESET_MARKER = `-- fixed-dynamic-only-mcp-reset-marker
local original = redis.call('GET', KEYS[1])
if ARGV[1] == 'absent' then
  if original then return 'CHANGED' end
elseif ARGV[1] ~= 'present' or original ~= ARGV[2] then return 'CHANGED' end
local answer = redis.call('SET', KEYS[1], ARGV[3])
if type(answer) ~= 'table' or answer.ok ~= 'OK' then return 'UNCONFIRMED' end
return 'OK'
`
class DynamicMcpResetChangedError extends Error {
  readonly code = 'dynamic_mcp_reset_changed'
  readonly status = 409
  constructor() { super('The legacy MCP reset stopped because its original source changed. Earlier confirmed resets remain saved.') }
}
class DynamicMcpResetUnconfirmedError extends Error {
  readonly code = 'dynamic_mcp_reset_unconfirmed'
  readonly status = 503
  constructor(cause?: unknown) { super('The legacy MCP reset was issued but its outcome is unconfirmed. It will not be repeated automatically.', cause === undefined ? undefined : { cause }) }
}
type ResetAttempt = { promise: Promise<void>; classified: boolean }
const resetAttempts = new Map<string, ResetAttempt>()
function resetValue(raw: unknown): unknown {
  if (typeof raw !== 'string') throw new DynamicMcpResetChangedError()
  const values: unknown = JSON.parse(raw || '[]')
  if (!Array.isArray(values) || values.length > 1) throw new DynamicMcpResetChangedError()
  return values[0]
}

/** Fixed private maintenance owner, not a way to mint human Settings consent. Original
 * source classification precedes every effect; only the two retired lists and stamp change. */
async function runDynamicOnlySelectionReset(userId: string): Promise<void> {
  const prior = resetAttempts.get(userId)
  if (prior) return prior.promise
  const attempt = { classified: false } as ResetAttempt
  attempt.promise = performDynamicOnlySelectionReset(userId, attempt).then(() => {
    resetAttempts.delete(userId) // Only a known complete marker permits the ordinary fast path.
  }, error => {
    // Before classification there is no original save to retain. After it, a later call
    // cannot recapture newer choices, replay partial progress or certify a lost marker reply.
    if (!attempt.classified) resetAttempts.delete(userId)
    throw error
  })
  resetAttempts.set(userId, attempt)
  return attempt.promise
}

async function performDynamicOnlySelectionReset(userId: string, attempt: ResetAttempt): Promise<void> {
  if (typeof userId !== 'string' || !userId.trim()) throw new DynamicMcpResetChangedError()
  const markerKey = buildDynamicOnlySelectionResetKey(userId), indexKey = `user:${userId}:agents`
  const originalLifecycle = captureSettingsLifecycle([markerKey, indexKey])
  await redis.execute(async client => {
    const marker = await client.get(markerKey)
    assertSettingsLifecycle(originalLifecycle)
    if (typeof marker === 'string' && marker.trim().length) return
    if (marker !== null && typeof marker !== 'string') throw new DynamicMcpResetChangedError()
    const ids = await client.sMembers(indexKey)
    assertSettingsLifecycle(originalLifecycle)
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new DynamicMcpResetChangedError()
    const sourcePaths = JSON.stringify(RESET_SOURCE_PATHS)
    const sources: Array<{ key: string; arguments: string[]; lifecycle: SettingsLifecycleSnapshot; createdAt: unknown; candidate: boolean }> = []
    for (const id of ids) {
      const key = `agent:${id}`, lifecycle = captureSettingsLifecycle([key])
      const answer = await client.eval(READ_RESET_SOURCE, { keys: [key], arguments: [JSON.stringify(RESET_SOURCE_PATHS)] })
      if (!Array.isArray(answer) || answer[0] !== 'SOURCE' || answer.length !== RESET_SOURCE_PATHS.length + 1) throw new DynamicMcpResetChangedError()
      const raw = answer.slice(1) as string[], values = raw.map(resetValue)
      const value = (field: string) => values[RESET_SOURCE_PATHS.indexOf(`$.${field}`)]
      if (value('id') !== id || value('user_id') !== userId) throw new DynamicMcpResetChangedError()
      attempt.classified = true
      assertSettingsLifecycle(lifecycle)
      const candidate = LEGACY_AGENT_MCP_SELECTION_FIELDS.some(field => Array.isArray(value(field)) && (value(field) as unknown[]).length > 0)
      sources.push({ key, arguments: [sourcePaths, JSON.stringify(raw), JSON.stringify(new Date().toISOString())],
        lifecycle, createdAt: value('created_at'), candidate })
    }
    // getAgents historically reset newest first. Keep that order, without its mutating
    // legacy-type normalization or its catch-and-skip partial population reads.
    sources.sort((a, b) => new Date((b.createdAt || 0) as string).getTime() - new Date((a.createdAt || 0) as string).getTime())
    for (const source of sources) assertSettingsLifecycle(source.lifecycle)
    assertSettingsLifecycle(originalLifecycle)
    const markerArguments = [marker === null ? 'absent' : 'present', marker ?? '', new Date().toISOString()]
    attempt.classified = true
    for (const source of sources.filter(source => source.candidate)) {
      const lease = acquireSettingsMutation(source.lifecycle)
      let issued = false, settled = false
      try {
        lease.check(); issued = true
        const answer = await client.eval(WRITE_RESET_SOURCE, {
          keys: [source.key], arguments: source.arguments
        })
        if (!['OK', 'CHANGED', 'MISSING', 'INVALID'].includes(answer as string)) throw new DynamicMcpResetUnconfirmedError()
        lease.settle(); settled = true
        if (answer !== 'OK') throw new DynamicMcpResetChangedError()
      } catch (error) {
        if (issued && !settled && !(error instanceof DynamicMcpResetUnconfirmedError)) throw new DynamicMcpResetUnconfirmedError(error)
        throw error
      } finally {
        if (!settled) { if (issued) lease.unknown(); else lease.settle() }
      }
    }
    const lease = acquireSettingsMutation(originalLifecycle)
    let issued = false, settled = false
    try {
      lease.check(); issued = true
      const answer = await client.eval(WRITE_RESET_MARKER, {
        keys: [markerKey], arguments: markerArguments
      })
      if (answer !== 'OK' && answer !== 'CHANGED') throw new DynamicMcpResetUnconfirmedError()
      lease.settle(); settled = true
      if (answer !== 'OK') throw new DynamicMcpResetChangedError()
    } catch (error) {
      if (issued && !settled && !(error instanceof DynamicMcpResetUnconfirmedError)) throw new DynamicMcpResetUnconfirmedError(error)
      throw error
    } finally {
      if (!settled) { if (issued) lease.unknown(); else lease.settle() }
    }
  })
}

// Export helpers for unit tests
export const __testUtils = {
  sanitizeStringArray,
  normalizeToolSelectionsInput,
  runDynamicOnlySelectionReset
}
