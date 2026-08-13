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
 * ⚠️ REDIS 8 PATTERN: records are read with `json.get` and written back with
 * `json.set`. Never `JSON.stringify` before `json.set`.
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

export const GATEWAY_REFERENCE_CLEANUP_VERSION = 'v1'

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
        nextMap[key] = value
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

/**
 * Tool names that belonged to `removed` and are served by no surviving gateway.
 *
 * `defaultMCPToolSelections` stores bare tool names with no gateway prefix, so a
 * name shared with a gateway that still exists must be kept — dropping it would
 * silently disable a tool the user still has.
 */
export function resolveOrphanToolNames(
  removed: MCPGateway | null | undefined,
  surviving: readonly MCPGateway[]
): Set<string> {
  const removedNames = collectGatewayToolNames(removed)
  if (removedNames.size === 0) return removedNames

  for (const gateway of surviving) {
    for (const name of collectGatewayToolNames(gateway)) {
      removedNames.delete(name)
    }
  }

  return removedNames
}

export interface GatewayReferenceSweepResult {
  scanned: number
  updatedRecordKeys: string[]
  removedGatewayIds: string[]
  removedDcmKeys: string[]
  removedToolNames: string[]
}

/**
 * Sweep every agent and subagent belonging to `userId`, removing references to
 * gateway IDs that are not in the live registry.
 *
 * Fails closed: when the gateway registry cannot be read the sweep does nothing,
 * because an empty registry read would otherwise look like "every gateway was
 * deleted" and wipe legitimate selections.
 */
export async function sweepGatewayReferencesForUser(params: {
  userId: string
  orphanToolNames?: ReadonlySet<string>
}): Promise<GatewayReferenceSweepResult> {
  const userId = typeof params.userId === 'string' ? params.userId.trim() : ''
  const empty: GatewayReferenceSweepResult = {
    scanned: 0,
    updatedRecordKeys: [],
    removedGatewayIds: [],
    removedDcmKeys: [],
    removedToolNames: []
  }
  if (!userId) return empty

  return await redis.execute(async (client) => {
    const registry = (await client.json.get(`mcp_gateways:${userId}`)) as {
      gateways?: MCPGateway[]
    } | null

    if (!registry || !Array.isArray(registry.gateways)) {
      // No registry to compare against — do not guess that every reference is dead.
      return empty
    }

    const liveGatewayIds = new Set(
      registry.gateways
        .map((gateway) => (typeof gateway?.id === 'string' ? gateway.id.trim() : ''))
        .filter((id) => id.length > 0)
    )

    const isOrphanGatewayId = (gatewayId: string) => !liveGatewayIds.has(gatewayId)

    const result: GatewayReferenceSweepResult = {
      scanned: 0,
      updatedRecordKeys: [],
      removedGatewayIds: [],
      removedDcmKeys: [],
      removedToolNames: []
    }

    const targets: Array<{ setKey: string; prefix: string }> = [
      { setKey: `user:${userId}:agents`, prefix: 'agent' },
      { setKey: `user:${userId}:subagents`, prefix: 'subagent' }
    ]

    for (const target of targets) {
      let ids: string[] = []
      try {
        ids = (await client.sMembers(target.setKey)) ?? []
      } catch (error) {
        logger.warn(
          `[Gateway Cleanup] Failed to list ${target.prefix} IDs for ${userId}:`,
          error
        )
        continue
      }

      for (const id of ids) {
        if (typeof id !== 'string' || id.trim().length === 0) continue
        const recordKey = `${target.prefix}:${id}`

        let record: Record<string, any> | null = null
        try {
          record = (await client.json.get(recordKey)) as Record<string, any> | null
        } catch (error) {
          logger.warn(`[Gateway Cleanup] Failed to read ${recordKey}:`, error)
          continue
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue

        result.scanned += 1

        const pruned = pruneGatewayReferencesFromRecord(record, {
          isOrphanGatewayId,
          orphanToolNames: params.orphanToolNames
        })
        if (!pruned.changed) continue

        await client.json.set(recordKey, '$', pruned.next as any)

        result.updatedRecordKeys.push(recordKey)
        result.removedGatewayIds.push(...pruned.removedGatewayIds)
        result.removedDcmKeys.push(...pruned.removedDcmKeys)
        result.removedToolNames.push(...pruned.removedToolNames)
      }
    }

    if (result.updatedRecordKeys.length > 0) {
      logger.info(
        `[Gateway Cleanup] Removed orphaned MCP gateway references from ` +
          `${result.updatedRecordKeys.length} record(s) for ${userId}: ` +
          `${result.removedGatewayIds.length} gateway selection(s), ` +
          `${result.removedDcmKeys.length} Tool Grid key(s), ` +
          `${result.removedToolNames.length} tool selection(s)`
      )
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
