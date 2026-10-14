/**
 * MCP Gateway Reference Cleanup (SA-096 P6)
 *
 * Deleting an MCP gateway used to remove only the gateway record. Every agent
 * and subagent that referenced it kept a dead gateway ID in `defaultMCPGateways`
 * and dead `${gatewayId}::${name}` keys in all four `dcmDisplaySettings` maps.
 * Those references resolve silently to nothing: the Tool Grid renders no row and
 * the DCM capability index emits no group, so an agent can look configured while
 * pointing at a gateway that no longer exists.
 *
 * SA-096 DL-8: deleting a gateway must not leave references behind, on agents or
 * on subagents.
 *
 * The sweep is written as "remove references to any gateway ID that is not in the
 * live registry" rather than "remove references to the ID just deleted", so it
 * also repairs installs that already carry orphans from earlier deletes. That is
 * why `runGatewayOrphanReferenceCleanup` can share the same code path.
 *
 * RedisJSON records stay JSON. Raw JSON.GET snapshots are compared inside Lua;
 * only invalid entries are removed, never a stale record or array replacement.
 */

import { redis } from '$lib/server/redis'
import { logger } from '$lib/utils/logger'
import { ARTIFACT_TOOL_GRID_ID, FABRIC_TOOL_GRID_ID } from '$lib/utils/toolGridBrokerFamilies'
import { CLI_TOOL_GRID_ID } from '$lib/utils/toolGridCli'
import type { MCPGateway } from '$lib/types/database'

/**
 * Must stay equal to `buildCompositeKey` in `dynamicMcpIndex.ts`. It is restated
 * here rather than imported because `dynamicMcpIndex` reaches this module through
 * `mcpSelectionResolver`, and importing it back would create a cycle. The equality
 * is pinned by a test.
 */
const COMPOSITE_KEY_SEPARATOR = '::'

/**
 * Left-hand composite-key values that are not gateway IDs and must never be
 * swept. The three Tool Grid family IDs are imported so a rename cannot drift.
 * `unknown_gateway` is the placeholder `dynamicMcpIndex` assigns when discovered
 * tool metadata carries no gateway; it is restated here for the same cycle reason
 * as the separator and is pinned by the same test.
 */
const UNKNOWN_GATEWAY_ID = 'unknown_gateway'

export const RESERVED_TOOL_GRID_IDS: ReadonlySet<string> = new Set([
  CLI_TOOL_GRID_ID,
  FABRIC_TOOL_GRID_ID,
  ARTIFACT_TOOL_GRID_ID,
  UNKNOWN_GATEWAY_ID
])

const DCM_SETTINGS_FIELDS = ['dcmDisplaySettings', 'dcm_display_settings'] as const
const GATEWAY_FIELDS = ['defaultMCPGateways', 'default_mcp_gateways'] as const
const TOOL_SELECTION_FIELDS = [
  'defaultMCPToolSelections',
  'default_mcp_tool_selections'
] as const

/** All four maps DL-8 names. */
const DCM_MAP_FIELDS = [
  'groups',
  'tools',
  'groupDisplayPreferences',
  'toolDisplayPreferences'
] as const

export const GATEWAY_REFERENCE_CLEANUP_VERSION = 'v2'

export function buildGatewayReferenceCleanupKey(userId: string): string {
  const normalized = typeof userId === 'string' ? userId.trim() : ''
  return `batshit:mcp_gateway_reference_cleanup:${GATEWAY_REFERENCE_CLEANUP_VERSION}:${normalized}`
}

export function extractGatewayIdFromCompositeKey(key: string): string | null {
  if (typeof key !== 'string') return null
  const index = key.indexOf(COMPOSITE_KEY_SEPARATOR)
  if (index <= 0) return null
  return key.slice(0, index)
}

export interface GatewayReferencePruneResult {
  changed: boolean
  next: Record<string, any>
  removedGatewayIds: string[]
  removedDcmKeys: string[]
  removedToolNames: string[]
}

/**
 * Pure record-level prune. Returns a shallow copy with orphan references removed;
 * the input record is never mutated.
 *
 * `isOrphanGatewayId` decides which gateway IDs are dead. `orphanToolNames` holds
 * bare MCP tool names that must leave `defaultMCPToolSelections` — that list is
 * flat and carries no gateway prefix, so the caller has to work out which names
 * belonged only to the removed gateway.
 */
export function pruneGatewayReferencesFromRecord(
  record: Record<string, any> | null | undefined,
  options: {
    isOrphanGatewayId: (gatewayId: string) => boolean
    orphanToolNames?: ReadonlySet<string>
  }
): GatewayReferencePruneResult {
  const source = record && typeof record === 'object' ? record : {}
  const next: Record<string, any> = { ...source }
  const removedGatewayIds: string[] = []
  const removedDcmKeys: string[] = []
  const removedToolNames: string[] = []

  const isOrphan = (gatewayId: string): boolean => {
    if (typeof gatewayId !== 'string') return false
    const trimmed = gatewayId.trim()
    if (trimmed.length === 0) return false
    if (RESERVED_TOOL_GRID_IDS.has(trimmed)) return false
    return options.isOrphanGatewayId(trimmed)
  }

  for (const field of GATEWAY_FIELDS) {
    const value = source[field]
    if (!Array.isArray(value)) continue
    const kept = value.filter((entry) => {
      if (typeof entry !== 'string' || !isOrphan(entry)) return true
      removedGatewayIds.push(entry)
      return false
    })
    if (kept.length !== value.length) {
      next[field] = kept
    }
  }

  const orphanToolNames = options.orphanToolNames
  if (orphanToolNames && orphanToolNames.size > 0) {
    for (const field of TOOL_SELECTION_FIELDS) {
      const value = source[field]
      if (!Array.isArray(value)) continue
      const kept = value.filter((entry) => {
        if (typeof entry !== 'string' || !orphanToolNames.has(entry)) return true
        removedToolNames.push(entry)
        return false
      })
      if (kept.length !== value.length) {
        next[field] = kept
      }
    }
  }

  for (const field of DCM_SETTINGS_FIELDS) {
    const settings = source[field]
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue

    let settingsChanged = false
    const nextSettings: Record<string, any> = { ...settings }

    for (const mapField of DCM_MAP_FIELDS) {
      const map = (settings as Record<string, any>)[mapField]
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue

      const nextMap: Record<string, any> = {}
      let mapChanged = false
      for (const [key, value] of Object.entries(map)) {
        const gatewayId = extractGatewayIdFromCompositeKey(key)
        if (gatewayId && isOrphan(gatewayId)) {
          removedDcmKeys.push(`${field}.${mapField}.${key}`)
          mapChanged = true
          continue
        }
        Object.defineProperty(nextMap, key, { value, enumerable: true, writable: true, configurable: true })
      }

      if (mapChanged) {
        nextSettings[mapField] = nextMap
        settingsChanged = true
      }
    }

    if (settingsChanged) {
      next[field] = nextSettings
    }
  }

  return {
    changed:
      removedGatewayIds.length > 0 ||
      removedDcmKeys.length > 0 ||
      removedToolNames.length > 0,
    next,
    removedGatewayIds,
    removedDcmKeys,
    removedToolNames
  }
}

/** Every tool name a gateway record claims to serve, from either source of truth. */
export function collectGatewayToolNames(gateway: MCPGateway | null | undefined): Set<string> {
  const names = new Set<string>()
  if (!gateway || typeof gateway !== 'object') return names

  const discovered = (gateway as MCPGateway).discoveredTools
  if (Array.isArray(discovered)) {
    for (const name of discovered) {
      if (typeof name === 'string' && name.trim().length > 0) names.add(name.trim())
    }
  }

  const groupings = (gateway as MCPGateway).toolGroupings
  if (Array.isArray(groupings)) {
    for (const grouping of groupings) {
      const toolIds = grouping?.toolIds
      if (!Array.isArray(toolIds)) continue
      for (const name of toolIds) {
        if (typeof name === 'string' && name.trim().length > 0) names.add(name.trim())
      }
    }
  }

  return names
}

export interface GatewayReferenceSweepResult {
  scanned: number
  updatedRecordKeys: string[]
  removedGatewayIds: string[]
  removedDcmKeys: string[]
  removedToolNames: string[]
}

/**
 * BL-889: snapshots are RAW JSON.GET replies, not reserialized JS values. The
 * registry and existing record must still match before any removal. Preflight
 * every path before mutation: Lua errors do not roll back earlier writes.
 * Only array entries and orphan map keys are removed; siblings never round-trip
 * through JS/cjson (including high-precision numbers in saved settings).
 */
export const PRUNE_GATEWAY_REFERENCES_SCRIPT = `
local registry = redis.call('JSON.GET', KEYS[2])
if not registry then return 'REGISTRY_UNAVAILABLE' end
if registry ~= ARGV[2] then return 'CHANGED' end
local record = redis.call('JSON.GET', KEYS[1])
if not record then return 'MISSING' end
if record ~= ARGV[1] then return 'CHANGED' end
local ops = cjson.decode(ARGV[3])
for _, op in ipairs(ops) do
  local types = redis.call('JSON.TYPE', KEYS[1], op[2])
  if #types ~= 1 then return redis.error_reply('Cleanup path unavailable') end
  if op[1] == 'pop' then
    if types[1] ~= 'array' then return redis.error_reply('Cleanup array unavailable') end
  elseif op[1] ~= 'del' then
    return redis.error_reply('Unknown cleanup operation')
  end
end
for _, op in ipairs(ops) do
  if op[1] == 'pop' then
    redis.call('JSON.ARRPOP', KEYS[1], op[2], op[3])
  else
    redis.call('JSON.DEL', KEYS[1], op[2])
  end
end
return 'OK'
`

const CLEANUP_TRIES = 3

type CleanupOp = ['pop', string, number] | ['del', string]

/** RedisJSON paths escape quotes/backslashes only, not JSON's control escapes. */
function mapEntryPath(field: string, map: string, key: string): string {
  // Buffer encoding would replace broken UTF-16, addressing a different key.
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = key.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid cleanup key encoding')
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Invalid cleanup key encoding')
    }
  }
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `$.${field}.${map}["${escaped}"]`
}

function planReferenceRemovals(record: Record<string, any>, pruned: GatewayReferencePruneResult): CleanupOp[] {
  const ops: CleanupOp[] = []
  for (const field of [...GATEWAY_FIELDS, ...TOOL_SELECTION_FIELDS]) {
    if (record[field] === pruned.next[field]) continue
    // Filter keeps order/duplicates; match the kept subsequence from the end so
    // removal indices remain valid as Redis pops in descending order.
    let keptIndex = pruned.next[field].length - 1
    for (let index = record[field].length - 1; index >= 0; index -= 1) {
      if (keptIndex >= 0 && record[field][index] === pruned.next[field][keptIndex]) keptIndex -= 1
      else ops.push(['pop', `$.${field}`, index])
    }
  }
  for (const field of DCM_SETTINGS_FIELDS) {
    if (record[field] === pruned.next[field]) continue
    for (const map of DCM_MAP_FIELDS) {
      const previous = record[field]?.[map]
      const next = pruned.next[field]?.[map]
      if (previous === next) continue
      for (const key of Object.keys(previous)) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) ops.push(['del', mapEntryPath(field, map, key)])
      }
    }
  }
  return ops
}

function readRegistry(raw: unknown): MCPGateway[] {
  if (typeof raw !== 'string') throw new Error('Gateway cleanup registry unavailable')
  const registry = JSON.parse(raw)
  if (!registry || !Array.isArray(registry.gateways) || registry.gateways.some(
    (gateway: MCPGateway) => !gateway || typeof gateway.id !== 'string' || !gateway.id.trim()
  )) throw new Error('Gateway cleanup registry malformed')
  return registry.gateways
}

/**
 * Resolver-supported pre-SA-009 shape. Keep this intact: cleanup's flat-name
 * deletion is deliberately not a legacy migration. Null optional entries and
 * empty maps/lists are legitimate; invalid non-map/non-list payloads refuse.
 */
function isLegacyToolSelections(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((gateway) => {
    if (gateway == null) return true
    if (typeof gateway !== 'object' || Array.isArray(gateway)) return false
    return Object.values(gateway).every((tools) => tools == null ||
      (Array.isArray(tools) && tools.every((name) => typeof name === 'string')))
  })
}

/** Malformed state is not proof of absence. Null/absent optional settings are legitimate. */
function validateReferenceState(record: Record<string, any>, pruneTools: boolean): void {
  for (const field of GATEWAY_FIELDS) {
    if (record[field] != null && !Array.isArray(record[field])) throw new Error(`Gateway cleanup malformed ${field}`)
  }
  if (pruneTools) {
    for (const field of TOOL_SELECTION_FIELDS) {
      if (record[field] != null && !Array.isArray(record[field]) && !isLegacyToolSelections(record[field])) {
        throw new Error(`Gateway cleanup malformed ${field}`)
      }
    }
  }
  for (const field of DCM_SETTINGS_FIELDS) {
    const settings = record[field]
    if (settings == null) continue
    if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Gateway cleanup malformed ${field}`)
    for (const map of DCM_MAP_FIELDS) {
      if (settings[map] != null && (typeof settings[map] !== 'object' || Array.isArray(settings[map]))) {
        throw new Error(`Gateway cleanup malformed ${field}.${map}`)
      }
    }
  }
}

function validateGatewayToolMetadata(gateways: MCPGateway[]): void {
  for (const gateway of gateways) {
    if (gateway.discoveredTools != null && (!Array.isArray(gateway.discoveredTools) || gateway.discoveredTools.some((name) => typeof name !== 'string'))) {
      throw new Error('Gateway cleanup unreadable discovered tools')
    }
    if (gateway.toolGroupings != null && (!Array.isArray(gateway.toolGroupings) || gateway.toolGroupings.some(
      (group) => !group || !Array.isArray(group.toolIds) || group.toolIds.some((name) => typeof name !== 'string')
    ))) throw new Error('Gateway cleanup unreadable tool groupings')
  }
}

/**
 * Prune current existing records. Three bounded attempts account for BOTH record
 * and registry changes. Missing records stay missing; unreadable state/listing,
 * failed mutations and exhausted conflicts reject so no success marker is set.
 */
export async function sweepGatewayReferencesForUser(params: {
  userId: string
  orphanToolNames?: ReadonlySet<string>
}): Promise<GatewayReferenceSweepResult> {
  const userId = typeof params.userId === 'string' ? params.userId.trim() : ''
  const result: GatewayReferenceSweepResult = {
    scanned: 0, updatedRecordKeys: [], removedGatewayIds: [], removedDcmKeys: [], removedToolNames: []
  }
  if (!userId) return result

  return await redis.execute(async (client) => {
    const registryKey = `mcp_gateways:${userId}`
    // Check even when there are no records; absence must not mark a successful repair.
    readRegistry(await client.sendCommand(['JSON.GET', registryKey]))
    const targets = [
      { setKey: `user:${userId}:agents`, prefix: 'agent' },
      { setKey: `user:${userId}:subagents`, prefix: 'subagent' }
    ]
    for (const target of targets) {
      const ids = await client.sMembers(target.setKey)
      for (const id of ids) {
        if (typeof id !== 'string' || !id.trim()) continue
        const recordKey = `${target.prefix}:${id}`
        for (let attempt = 0; attempt < CLEANUP_TRIES; attempt += 1) {
          // Raw reads preserve RedisJSON's exact serialization for CAS.
          const registryRaw = await client.sendCommand(['JSON.GET', registryKey])
          if (typeof registryRaw !== 'string') throw new Error('Gateway cleanup registry unavailable')
          const gateways = readRegistry(registryRaw)
          const recordRaw = await client.sendCommand(['JSON.GET', recordKey])
          if (recordRaw === null) break
          if (typeof recordRaw !== 'string') throw new Error(`Gateway cleanup cannot read ${recordKey}`)
          const record = JSON.parse(recordRaw)
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error(`Gateway cleanup malformed record ${recordKey}`)
          }
          validateReferenceState(record, Boolean(params.orphanToolNames?.size))
          if (params.orphanToolNames?.size) validateGatewayToolMetadata(gateways)
          if (attempt === 0) result.scanned += 1
          const liveIds = new Set(gateways.map((gateway) => gateway.id.trim()))
          // `defaultMCPToolSelections` holds bare names with no gateway prefix: a candidate that a
          // gateway in THIS registry read still serves stays selected (the script refuses the write
          // if the registry changed). BL-1396: the delete passes every name of the gateway it
          // removed and leaves this decision here.
          const orphanToolNames = new Set(params.orphanToolNames)
          for (const gateway of gateways) {
            for (const name of collectGatewayToolNames(gateway)) orphanToolNames.delete(name)
          }
          const pruned = pruneGatewayReferencesFromRecord(record, {
            isOrphanGatewayId: (id) => !liveIds.has(id), orphanToolNames
          })
          if (!pruned.changed) break
          const answer = await client.eval(PRUNE_GATEWAY_REFERENCES_SCRIPT, {
            keys: [recordKey, registryKey],
            arguments: [recordRaw, registryRaw, JSON.stringify(planReferenceRemovals(record, pruned))]
          })
          if (answer === 'MISSING') break
          if (answer === 'CHANGED') {
            if (attempt + 1 < CLEANUP_TRIES) continue
            throw new Error(`Gateway cleanup conflict limit reached for ${recordKey}`)
          }
          if (answer !== 'OK') throw new Error(`Gateway cleanup failed for ${recordKey}: ${String(answer)}`)
          result.updatedRecordKeys.push(recordKey)
          result.removedGatewayIds.push(...pruned.removedGatewayIds)
          result.removedDcmKeys.push(...pruned.removedDcmKeys)
          result.removedToolNames.push(...pruned.removedToolNames)
          break
        }
      }
    }
    if (result.updatedRecordKeys.length > 0) {
      logger.info(`[Gateway Cleanup] Removed orphaned MCP references from ${result.updatedRecordKeys.length} record(s) for ${userId}`)
    }
    return result
  })
}

/**
 * One-time per-user repair for orphans left by deletes that happened before the
 * sweep existed. Marker-guarded so it costs one Redis read after the first run,
 * matching the `runDynamicOnlySelectionReset` pattern in `mcpSelectionResolver`.
 *
 * It intentionally does not touch `defaultMCPToolSelections`: those entries are
 * bare tool names, and once a gateway is gone there is no way to tell an orphan
 * name from a name the user chose on purpose.
 */
export async function runGatewayOrphanReferenceCleanup(userId: string): Promise<void> {
  const normalized = typeof userId === 'string' ? userId.trim() : ''
  if (!normalized) return

  const markerKey = buildGatewayReferenceCleanupKey(normalized)

  try {
    const alreadyRun = await redis.execute(async (client) => {
      const marker = await client.get(markerKey)
      return typeof marker === 'string' && marker.trim().length > 0
    })
    if (alreadyRun) return

    await sweepGatewayReferencesForUser({ userId: normalized })

    await redis.execute(async (client) => {
      await client.set(markerKey, new Date().toISOString())
    })
  } catch (error) {
    // A failed repair must not block a send; the marker is not written, so the
    // next resolve retries.
    logger.warn(`[Gateway Cleanup] One-time orphan cleanup failed for ${normalized}:`, error)
  }
}
