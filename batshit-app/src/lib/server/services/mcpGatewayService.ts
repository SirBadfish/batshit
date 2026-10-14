/**
 * MCP Gateway Service
 *
 * Manages MCP gateway configurations with unified CRUD operations.
 * Supports multiple gateway types: docker-catalog, n8n-mcp-trigger, n8n-instance-mcp, custom
 *
 * ⚠️ CRITICAL REDIS 8 PATTERN WARNINGS:
 * - NEVER use JSON.stringify before redis.json.set
 * - NEVER use JSON.parse after redis.json.get
 * - RedisJSON handles serialization automatically
 * - Pass objects DIRECTLY to json.set
 * - Retrieved data is ALREADY parsed from json.get
 *
 * Risk Profile: DATA-001 (Critical) - Double stringification will corrupt data
 * Test Coverage: P0 tests verify no double stringification
 *
 * BL-1371: every registry write is a compare-and-set on the raw RedisJSON text
 * (`redis.json.getRaw` / `setIfUnchanged` / `delIfUnchanged`), so a write that lands between
 * another writer's read and its write is never overwritten. The value goes to Redis once, as the
 * JSON text `json.set` sends (raw `JSON.SET` inside the script), never stringified twice.
 */

import { redis } from '$lib/server/redis'
import { cloneIconRef, isIconRef } from '$lib/icons/iconTypes'
import type {
  MCPGateway,
  MCPGatewayRegistry,
  MCPGatewayStdioConfig,
  MCPToolGrouping
} from '$lib/types/database'
import { logger } from '$lib/utils/logger'
import { isCliSubagentBridgeServerSegment } from '$lib/utils/cliSubagentToolNames'
import { getBlockedBatshitServerGatewayReason, isBlockedBatshitServerGatewayUrl } from './mcpGatewayPolicy'
import {
  collectGatewayToolNames,
  sweepGatewayReferencesForUser
} from './mcpGatewayReferenceCleanup'
import {
  sanitizeStdioGatewayConfig,
  validateStdioGatewayConfig
} from './mcpGatewayStdio'
import {
  STDIO_RECORD_KEEPING_FIELDS,
  gatewayToolSettingsChanged,
  mcpToolListCache
} from './mcpToolListCache'

/** What a Refresh or a Test learned about a STDIO gateway (its record keeping). */
export type StdioCheckResult = Pick<
  MCPGatewayStdioConfig,
  'lastTestStatus' | 'lastTestAt' | 'lastError' | 'toolCount'
>

/**
 * BL-550: a Refresh or a Test writes back what it learned, and nothing else, into the gateway as
 * it is when the check ENDS. The check takes seconds (a process start), and the user can save a
 * new argument meanwhile; writing the launch read before the check put the old one back.
 *
 * One step inside Redis: find the gateway by id, refuse when it is gone (`MISSING`) or is no
 * longer a STDIO gateway with a launch (`NOT_STDIO`), then set each named field at its own path
 * under `stdioConfig`. Nothing else in the registry is read into the write.
 *
 * KEYS[1] the user's registry; ARGV[1] the gateway id; then pairs of field name and its value as
 * JSON text.
 */
export const RECORD_STDIO_CHECK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
local count = redis.call('JSON.ARRLEN', KEYS[1], '$.gateways')[1]
if type(count) ~= 'number' then return 'MISSING' end
local index = nil
for position = 0, count - 1 do
  local ids = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.gateways[' .. position .. '].id'))
  if ids[1] == ARGV[1] then
    index = position
    break
  end
end
if index == nil then return 'MISSING' end
local at = '$.gateways[' .. index .. ']'
local kind = cjson.decode(redis.call('JSON.GET', KEYS[1], at .. '.type'))[1]
if kind ~= 'stdio' or redis.call('JSON.TYPE', KEYS[1], at .. '.stdioConfig')[1] ~= 'object' then
  return 'NOT_STDIO'
end
for position = 2, #ARGV, 2 do
  redis.call('JSON.SET', KEYS[1], at .. '.stdioConfig.' .. ARGV[position], ARGV[position + 1])
end
return 'OK'
`

/** The text with each lone UTF-16 surrogate replaced by U+FFFD. */
function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

/**
 * BL-550: the record keeping belongs to the check. A settings save that sends the STDIO launch
 * keeps what is stored at the moment of the write, whatever the sender's copy says, so a save
 * built before a Refresh answered cannot put the old result back.
 */
function keepStoredStdioRecordKeeping(
  incoming: MCPGatewayStdioConfig,
  stored: MCPGatewayStdioConfig | undefined
): MCPGatewayStdioConfig {
  const next: Record<string, unknown> = { ...incoming }
  const current: Record<string, unknown> = stored && typeof stored === 'object' ? { ...stored } : {}
  for (const field of STDIO_RECORD_KEEPING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(current, field)) {
      next[field] = current[field]
    } else {
      delete next[field]
    }
  }
  return next as unknown as MCPGatewayStdioConfig
}

/**
 * BL-1371: a registry write reads again and rebuilds from fresh objects at most this many times
 * (the first try and two more), with no wait between, then gives up. Each refused try proves that
 * another write was stored, so the tries always make progress.
 */
const REGISTRY_WRITE_TRIES = 3

/**
 * BL-1371: a registry write found the stored gateways changed by another write at every one of
 * its tries. Nothing of it was stored. The gateway routes answer 409.
 */
export class GatewayRegistryConflictError extends Error {
  constructor() {
    super(
      `The MCP gateways kept changing while this was being saved (${REGISTRY_WRITE_TRIES} tries), so nothing was saved. Try again.`
    )
    this.name = 'GatewayRegistryConflictError'
  }
}

/**
 * What `update` writes: the fields to change, or a SYNCHRONOUS function of the gateway as it is
 * stored at the try's compare-and-set that answers them (BL-1371). The function runs again on
 * every try, so it must only compute: no I/O, no `await`.
 */
export type GatewayUpdate =
  | Partial<MCPGateway>
  | ((stored: Readonly<MCPGateway>) => Partial<MCPGateway>)

/** The JSONPath of one gateway in the registry. */
function gatewayPath(index: number): string {
  return `$.gateways[${index}]`
}

/** The registry from `JSON.GET key $` (a one-entry array), or null for a missing key. */
function parseRegistryText(raw: string | null): MCPGatewayRegistry | null {
  if (raw === null) return null
  const matches = JSON.parse(raw)
  if (!Array.isArray(matches) || matches.length !== 1) {
    throw new Error('The MCP gateway registry read answered an unexpected shape.')
  }
  return matches[0] as MCPGatewayRegistry
}

export class MCPGatewayService {
  private readonly VALID_GROUP_MODES = new Set([
    'group+tools+hints',
    'group+tools+names',
    'group-only',
    'hidden'
  ])

  private readonly VALID_TOOL_MODES = new Set([
    'inherit',
    'name+hint',
    'name-only',
    'hidden'
  ])

  private mapLegacyGroupMode(value: unknown): string | null {
    if (typeof value !== 'string') return null
    if (value === 'group+tools') return 'group+tools+hints'
    if (this.VALID_GROUP_MODES.has(value)) return value
    return null
  }

  private mapLegacyToolMode(value: unknown): string | null {
    if (typeof value !== 'string') return null
    if (value === 'group+tools') return 'name+hint'
    if (this.VALID_TOOL_MODES.has(value)) return value
    return null
  }

  private sanitizeToolGroupings(input: unknown): MCPGateway['toolGroupings'] {
    if (!Array.isArray(input)) return undefined

    const normalized = input
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const raw = entry as Record<string, unknown>
        const rawName = raw.mcpName
        const name = typeof rawName === 'string' ? rawName.trim() : ''
        if (!name) return null

        const rawToolIds = raw.toolIds
        const toolIds = Array.isArray(rawToolIds)
          ? Array.from(
              new Set(
                rawToolIds
                  .map((toolId) => (typeof toolId === 'string' ? toolId.trim() : ''))
                  .filter((toolId) => toolId.length > 0)
              )
            )
          : []

        const grouping: MCPToolGrouping = {
          mcpName: name,
          toolIds
        }

        const rawIconRef = Object.prototype.hasOwnProperty.call(raw, 'icon_ref')
          ? raw.icon_ref
          : raw.iconRef
        if (rawIconRef !== undefined) {
          if (rawIconRef === null) {
            grouping.icon_ref = null
          } else if (isIconRef(rawIconRef)) {
            grouping.icon_ref = cloneIconRef(rawIconRef)
          } else {
            throw new Error('toolGroupings.icon_ref must be a valid icon picker reference')
          }
        }

        return grouping
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

    return normalized.length > 0 ? normalized : []
  }

  private sanitizeDcmDisplayDefaults(input: unknown): MCPGateway['dcmDisplayDefaults'] {
    if (!input || typeof input !== 'object') return undefined

    const raw = input as Record<string, unknown>
    const groupsRaw = raw.groups
    const toolsRaw = raw.tools

    const groups: Record<string, any> = {}
    if (groupsRaw && typeof groupsRaw === 'object') {
      for (const [key, value] of Object.entries(groupsRaw)) {
        const mapped = this.mapLegacyGroupMode(value)
        if (mapped && typeof key === 'string' && key.trim().length > 0) {
          groups[key] = mapped
        }
      }
    }

    const tools: Record<string, any> = {}
    if (toolsRaw && typeof toolsRaw === 'object') {
      for (const [key, value] of Object.entries(toolsRaw)) {
        const mapped = this.mapLegacyToolMode(value)
        if (mapped && typeof key === 'string' && key.trim().length > 0) {
          tools[key] = mapped
        }
      }
    }

    return {
      version: 1,
      groups,
      tools
    }
  }

  private sanitizeIconRef(input: unknown): MCPGateway['icon_ref'] {
    if (input === undefined) return undefined
    if (input === null) return null
    if (!isIconRef(input)) {
      throw new Error('icon_ref must be a valid icon picker reference')
    }
    return cloneIconRef(input)
  }

  private normalizeGatewayForStorage<T extends Partial<MCPGateway>>(gateway: T): T {
    const normalized = { ...gateway }
    if ('icon_ref' in normalized) {
      normalized.icon_ref = this.sanitizeIconRef(normalized.icon_ref)
    }
    if ('toolGroupings' in normalized) {
      normalized.toolGroupings = this.sanitizeToolGroupings(normalized.toolGroupings)
    }
    if ('dcmDisplayDefaults' in normalized) {
      normalized.dcmDisplayDefaults = this.sanitizeDcmDisplayDefaults(
        normalized.dcmDisplayDefaults
      )
    }
    if ('stdioConfig' in normalized) {
      normalized.stdioConfig = sanitizeStdioGatewayConfig(normalized.stdioConfig)
    }
    return normalized
  }

  private slugify(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  private assignSlug(gateway: MCPGateway, existing: MCPGateway[]) {
    if (gateway.slug?.trim()) {
      return gateway
    }
    const existingSlugs = new Set(
      existing
        .map((entry) => entry.slug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0)
        .map((slug) => slug.trim())
    )

    const baseName = gateway.name?.trim() || gateway.id || 'gateway'
    const baseSlug = this.slugify(baseName) || 'gateway'
    let attempt = baseSlug
    let counter = 1
    // BL-271: the slug is Batshit's hidden id for the gateway (the name the user typed is
    // kept as typed). It also names the gateway's MCP server in managed CLI profiles
    // (`batshit_gateway_<slug>`), so it skips every name a Subagent bridge can take, as it
    // skips another gateway's slug; otherwise "Cody Subagents" became agent cody's bridge.
    while (existingSlugs.has(attempt) || isCliSubagentBridgeServerSegment(attempt)) {
      attempt = `${baseSlug}_${counter++}`
    }
    gateway.slug = attempt
    existingSlugs.add(attempt)
    return gateway
  }

  /**
   * Brings a registry read up to the stored shape (groupings, display defaults, slugs), in place.
   * Answers null when nothing changed, else the warnings to log once the write is stored. Only
   * computes: `list` writes the result with a compare-and-set (BL-1371).
   */
  private normalizeRegistry(registry: MCPGatewayRegistry): string[] | null {
    const warnings: string[] = []
    let needsSave = false
    for (const gateway of registry.gateways) {
      const normalizedGroupings = this.sanitizeToolGroupings(gateway.toolGroupings)
      const existingGroupings = gateway.toolGroupings
      if (JSON.stringify(existingGroupings ?? null) !== JSON.stringify(normalizedGroupings ?? null)) {
        gateway.toolGroupings = normalizedGroupings
        needsSave = true
      }
      const normalizedDcmDefaults = this.sanitizeDcmDisplayDefaults(gateway.dcmDisplayDefaults)
      if (
        JSON.stringify(gateway.dcmDisplayDefaults ?? null) !==
        JSON.stringify(normalizedDcmDefaults ?? null)
      ) {
        gateway.dcmDisplayDefaults = normalizedDcmDefaults
        needsSave = true
      }
      if (gateway.slug && isCliSubagentBridgeServerSegment(gateway.slug.trim())) {
        // BL-271: a slug saved (or restored) before the save-time rule may still be a
        // Subagent bridge's server name; it gets a new one here, once. Only Batshit's hidden id
        // changes; the gateway's name stays as the user typed it.
        const previous = gateway.slug
        gateway.slug = undefined
        this.assignSlug(gateway, registry.gateways)
        warnings.push(
          `[MCPGatewayService] Gateway "${gateway.name}" had the internal id "${previous}", which is a Subagent bridge's MCP server name; it is now "${gateway.slug}" (BL-271).`
        )
        needsSave = true
      }
      if (!gateway.slug) {
        this.assignSlug(gateway, registry.gateways)
        needsSave = true
      }
    }
    return needsSave ? warnings : null
  }

  /** The registry as stored now, with its raw text for a compare-and-set (BL-1371). */
  private async readRegistry(key: string): Promise<{ raw: string | null; registry: MCPGatewayRegistry | null }> {
    const raw = await redis.json.getRaw(key, '$')
    return { raw, registry: parseRegistryText(raw) }
  }

  /**
   * BL-1371: the gateway at `index` as stored now, with its raw text, or null when that element is
   * no longer this gateway (another write deleted it or shifted the list between the two reads):
   * the try is refused before anything is computed from a sibling.
   */
  private async readGatewayAt(
    key: string,
    index: number,
    gatewayId: string
  ): Promise<{ raw: string; gateway: MCPGateway } | null> {
    const raw = await redis.json.getRaw(key, gatewayPath(index))
    if (raw === null) return null
    const matches = JSON.parse(raw)
    if (!Array.isArray(matches) || matches.length > 1) {
      throw new Error('The MCP gateway read answered an unexpected shape.')
    }
    const gateway = matches[0]
    if (!gateway || typeof gateway !== 'object' || gateway.id !== gatewayId) return null
    return { raw, gateway: gateway as MCPGateway }
  }

  private assertValid(gateway: Partial<MCPGateway>) {
    const validation = this.validateGateway(gateway)
    if (!validation.valid) {
      throw new Error(validation.error)
    }
  }

  /** A merge function's answer, refused when it is not a plain synchronous result (BL-1371). */
  private runMerge(
    merge: (stored: Readonly<MCPGateway>) => Partial<MCPGateway>,
    stored: MCPGateway
  ): Partial<MCPGateway> {
    const answer = merge(stored) as unknown
    if (
      !answer ||
      typeof answer !== 'object' ||
      Array.isArray(answer) ||
      typeof (answer as { then?: unknown }).then === 'function'
    ) {
      throw new Error('A gateway update function must answer the fields to write, synchronously.')
    }
    return answer as Partial<MCPGateway>
  }

  /**
   * Get Redis key for user's gateway registry
   */
  private getKey(userId: string): string {
    return `mcp_gateways:${userId}`
  }

  /**
   * Validate gateway type
   */
  private isValidGatewayType(type: string): type is 'docker-catalog' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom' | 'stdio' | 'n8n-mcp-client' {
    return ['docker-catalog', 'n8n-mcp-trigger', 'n8n-instance-mcp', 'custom', 'stdio', 'n8n-mcp-client'].includes(type)
  }

  /**
   * Validate gateway URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url)
      // Only allow http and https schemes
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Validate gateway data before operations
   */
  private validateGateway(gateway: Partial<MCPGateway>): { valid: boolean; error?: string } {
    if (gateway.type && !this.isValidGatewayType(gateway.type)) {
      return { valid: false, error: `Invalid gateway type: ${gateway.type}` }
    }

    const gatewayType = gateway.type

    if (gatewayType !== 'stdio' && gateway.url && !this.isValidUrl(gateway.url)) {
      return { valid: false, error: `Invalid gateway URL: ${gateway.url}` }
    }

    if (gatewayType !== 'stdio' && gateway.url && isBlockedBatshitServerGatewayUrl(gateway.url)) {
      return { valid: false, error: getBlockedBatshitServerGatewayReason() }
    }

    if (gateway.name && gateway.name.trim().length === 0) {
      return { valid: false, error: 'Gateway name cannot be empty' }
    }

    if (gatewayType === 'stdio' || gateway.stdioConfig !== undefined) {
      const validation = validateStdioGatewayConfig(sanitizeStdioGatewayConfig(gateway.stdioConfig))
      if (!validation.valid) {
        return validation
      }
    }

    return { valid: true }
  }

  /**
   * Create a new gateway.
   *
   * BL-1371: a compare-and-set on the whole registry (`$`, '' when there is none yet), because the
   * slug depends on every other gateway. Each try builds the gateway again from the caller's input,
   * so a slug picked by a refused try is never kept or answered.
   */
  async create(userId: string, gateway: Omit<MCPGateway, 'id'> | MCPGateway): Promise<MCPGateway> {
    this.assertValid(gateway)

    const key = this.getKey(userId)
    const id = 'id' in gateway && gateway.id ? gateway.id : crypto.randomUUID()

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { raw, registry: stored } = await this.readRegistry(key)
      const registry = stored ?? { gateways: [] }
      const newGateway = this.normalizeGatewayForStorage({ ...gateway, id } as MCPGateway)

      if (registry.gateways.some((g: MCPGateway) => g.id === id)) {
        throw new Error(`Gateway with ID ${id} already exists`)
      }

      this.assignSlug(newGateway, registry.gateways)
      registry.gateways.push(newGateway)

      if (!(await redis.json.setIfUnchanged(key, '$', raw ?? '', registry))) continue

      // Saved tool lists are kept until the user changes the tool settings (mcpToolListCache.ts).
      mcpToolListCache.clearGateway(userId, id)
      return newGateway
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Get all gateways for a user.
   *
   * A read that needs normalizing (a missing slug, an older grouping or display shape) writes the
   * normalized registry with a compare-and-set on `$` (BL-1371). When another write landed first it
   * reads and normalizes again; it answers only a registry it stored, or a read that needed no
   * write, never a copy whose write was refused (its slugs might never be stored).
   */
  async list(userId: string): Promise<MCPGateway[]> {
    const key = this.getKey(userId)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { raw, registry } = await this.readRegistry(key)
      if (!registry) return []

      const warnings = this.normalizeRegistry(registry)
      if (warnings === null) return registry.gateways || []

      if (!(await redis.json.setIfUnchanged(key, '$', raw!, registry))) continue

      for (const warning of warnings) logger.warn(warning)
      return registry.gateways
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Get a specific gateway by ID
   */
  async get(userId: string, gatewayId: string): Promise<MCPGateway | null> {
    const gateways = await this.list(userId)
    return gateways.find(g => g.id === gatewayId) || null
  }

  /**
   * Update an existing gateway.
   *
   * BL-1371: a compare-and-set on THIS gateway's raw text (`$.gateways[i]`), so a write to another
   * gateway never conflicts. Each try finds the gateway, reads its element again and checks the id
   * (a delete can shift the list between the two reads), builds the next copy from that stored
   * element (`updates` may be a synchronous function of it), and writes only while the element is
   * still that text. A gateway deleted meanwhile is "not found" and is never written again. Only the
   * stored try clears saved tool lists, and it is the copy answered (a function that answers no
   * fields writes nothing and answers the gateway as read).
   */
  async update(userId: string, gatewayId: string, updates: GatewayUpdate): Promise<MCPGateway> {
    if (typeof updates !== 'function') this.assertValid(updates)

    const key = this.getKey(userId)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { registry } = await this.readRegistry(key)
      if (!registry) {
        throw new Error('No gateways found for user')
      }

      const index = registry.gateways.findIndex((g: MCPGateway) => g.id === gatewayId)
      if (index === -1) {
        throw new Error(`Gateway with ID ${gatewayId} not found`)
      }

      const snapshot = await this.readGatewayAt(key, index, gatewayId)
      if (!snapshot) continue
      const stored = snapshot.gateway

      let requested: Partial<MCPGateway>
      if (typeof updates === 'function') {
        // The function gets its own copy; `stored` stays the element as read.
        requested = this.runMerge(updates, JSON.parse(JSON.stringify(stored)))
        // Nothing to change for the gateway as stored (the token migration found another token):
        // no write, so nothing for a concurrent save to retry over. It answers the stored copy.
        if (Object.keys(requested).length === 0) return stored
        this.assertValid(requested)
      } else {
        requested = updates
      }

      const sanitizedUpdates = this.normalizeGatewayForStorage({ ...requested })
      if ('slug' in sanitizedUpdates) {
        delete (sanitizedUpdates as Partial<MCPGateway>).slug
      }
      if (sanitizedUpdates.stdioConfig) {
        sanitizedUpdates.stdioConfig = keepStoredStdioRecordKeeping(
          sanitizedUpdates.stdioConfig,
          stored.stdioConfig
        )
      }
      const updatedGateway: MCPGateway = {
        ...stored,
        ...sanitizedUpdates,
        updated_at: new Date().toISOString()
      }

      if (!(await redis.json.setIfUnchanged(key, gatewayPath(index), snapshot.raw, updatedGateway))) continue

      // Any edit but the record keeping a lookup or a Test writes back is the user changing the
      // tool settings, so the next send asks the tool server again (mcpToolListCache.ts).
      if (gatewayToolSettingsChanged(stored, updatedGateway)) {
        mcpToolListCache.clearGateway(userId, gatewayId)
      }
      return updatedGateway
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Delete a gateway.
   *
   * BL-1371: a compare-and-set delete of THIS gateway's element, found and id-checked as in
   * `update`. The saved tool lists and the reference sweep follow only the stored delete, with the
   * tool names of the gateway as it was removed.
   *
   * SA-096 DL-8: a delete also sweeps every agent and subagent reference to the
   * gateway, so no record is left pointing at an ID that resolves to nothing.
   */
  async delete(userId: string, gatewayId: string): Promise<void> {
    const key = this.getKey(userId)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { registry } = await this.readRegistry(key)
      if (!registry) {
        return // Nothing to delete
      }

      const index = registry.gateways.findIndex((g: MCPGateway) => g.id === gatewayId)
      if (index === -1) {
        throw new Error(`Gateway with ID ${gatewayId} not found`)
      }

      const snapshot = await this.readGatewayAt(key, index, gatewayId)
      if (!snapshot) continue
      if (!(await redis.json.delIfUnchanged(key, gatewayPath(index), snapshot.raw))) continue

      mcpToolListCache.clearGateway(userId, gatewayId)

      // Reference sweep runs after the registry write so it compares against the
      // post-delete live set. A sweep failure must not leave the caller believing
      // the gateway is still present.
      // BL-1396: every tool name of the gateway as it was removed is a candidate. The sweep keeps
      // a name that a gateway in the registry as it reads it still serves, and its compare-and-set
      // refuses a write when the registry changed. This try's earlier read must not decide: a
      // sibling deleted meanwhile is still in it, so two overlapping deletes of gateways that serve
      // the same tool would each keep that tool's selection.
      try {
        await sweepGatewayReferencesForUser({
          userId,
          orphanToolNames: collectGatewayToolNames(snapshot.gateway)
        })
      } catch (error) {
        logger.error(
          `[MCP Gateway] Deleted gateway ${gatewayId} but failed to sweep references:`,
          error
        )
      }
      return
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Enable or disable a gateway
   */
  async setEnabled(userId: string, gatewayId: string, enabled: boolean): Promise<void> {
    await this.update(userId, gatewayId, { enabled })
  }

  /**
   * BL-550: write what a Refresh or a Test learned about a STDIO gateway (`RECORD_STDIO_CHECK_SCRIPT`).
   * Only the fields given are written, each at its own path, into the record as it is now; a
   * field left out keeps its stored value. Answers `NOT_STDIO` (nothing written) when the gateway
   * is no longer a STDIO gateway, and throws "not found" (like `update`) when it was deleted.
   * The saved tool lists stay: this is record keeping, not the user changing the tool settings.
   */
  async recordStdioCheckResult(
    userId: string,
    gatewayId: string,
    result: StdioCheckResult
  ): Promise<'OK' | 'NOT_STDIO'> {
    for (const field of Object.keys(result)) {
      if (!STDIO_RECORD_KEEPING_FIELDS.has(field)) {
        throw new Error(`${field} is not a STDIO check field`)
      }
    }
    // The error is stored as `sanitizeStdioGatewayConfig` stored it (trimmed; empty is none), with
    // any lone UTF-16 half replaced, because RedisJSON refuses the escape `JSON.stringify` writes
    // for one. It goes first: a refused value then stops the script before anything is written.
    const fields: Array<[string, unknown]> = []
    if (result.lastError !== undefined) {
      const lastError =
        typeof result.lastError === 'string' ? wellFormedText(result.lastError).trim() || null : null
      fields.push(['lastError', lastError])
    }
    for (const field of ['lastTestStatus', 'lastTestAt', 'toolCount'] as const) {
      if (result[field] !== undefined) fields.push([field, result[field]])
    }
    const fieldArguments = fields.flatMap(([field, value]) => [field, JSON.stringify(value)])

    const answer = await redis.execute((client) =>
      client.eval(RECORD_STDIO_CHECK_SCRIPT, {
        keys: [this.getKey(userId)],
        arguments: [gatewayId, ...fieldArguments]
      })
    )
    if (answer === 'OK' || answer === 'NOT_STDIO') return answer
    if (answer === 'MISSING') throw new Error(`Gateway with ID ${gatewayId} not found`)
    throw new Error(`The STDIO check result of gateway ${gatewayId} answered ${String(answer)}.`)
  }

  /**
   * Update discovered tools for a gateway
   */
  async updateDiscoveredTools(userId: string, gatewayId: string, tools: string[]): Promise<void> {
    await this.update(userId, gatewayId, {
      discoveredTools: tools,
      lastDiscovery: Date.now()
    })
  }

  /**
   * Get all enabled gateways for a user
   */
  async listEnabled(userId: string): Promise<MCPGateway[]> {
    const gateways = await this.list(userId)
    return gateways.filter(g => g.enabled)
  }

  /**
   * Get gateways by type
   */
  async listByType(
    userId: string,
    type: 'docker-catalog' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom' | 'stdio'
  ): Promise<MCPGateway[]> {
    const gateways = await this.list(userId)
    return gateways.filter(g => g.type === type)
  }

  /**
   * Check if a gateway exists
   */
  async exists(userId: string, gatewayId: string): Promise<boolean> {
    const gateway = await this.get(userId, gatewayId)
    return gateway !== null
  }
}

// Export singleton instance
export const mcpGatewayService = new MCPGatewayService()
