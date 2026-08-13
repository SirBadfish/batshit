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
 */

import { redis } from '$lib/server/redis'
import { cloneIconRef, isIconRef } from '$lib/icons/iconTypes'
import type { MCPGateway, MCPGatewayRegistry, MCPToolGrouping } from '$lib/types/database'
import type { RedisJSON } from '@redis/json'
import { logger } from '$lib/utils/logger'
import { getBlockedBatshitServerGatewayReason, isBlockedBatshitServerGatewayUrl } from './mcpGatewayPolicy'
import {
  resolveOrphanToolNames,
  sweepGatewayReferencesForUser
} from './mcpGatewayReferenceCleanup'
import {
  sanitizeStdioGatewayConfig,
  validateStdioGatewayConfig
} from './mcpGatewayStdio'

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
    while (existingSlugs.has(attempt)) {
      attempt = `${baseSlug}_${counter++}`
    }
    gateway.slug = attempt
    existingSlugs.add(attempt)
    return gateway
  }

  private async ensureSlugs(userId: string, registry: MCPGatewayRegistry | null, client: any) {
    if (!registry) return
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
      if (!gateway.slug) {
        this.assignSlug(gateway, registry.gateways)
        needsSave = true
      }
    }
    if (needsSave) {
      await client.json.set(this.getKey(userId), '$', registry as unknown as RedisJSON)
    }
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
   * Create a new gateway
   *
   * ✅ CORRECT Redis 8 Pattern:
   * - Pass data object DIRECTLY to json.set
   * - NO JSON.stringify anywhere in this function
   */
  async create(userId: string, gateway: Omit<MCPGateway, 'id'> | MCPGateway): Promise<MCPGateway> {
    // Validate gateway data
    const validation = this.validateGateway(gateway)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    const key = this.getKey(userId)

    // Generate ID if not provided
    const newGateway = this.normalizeGatewayForStorage({
      ...gateway,
      id: 'id' in gateway && gateway.id ? gateway.id : crypto.randomUUID()
    } as MCPGateway)

    await redis.execute(async (client) => {
      // Get existing registry (already parsed!)
      let registry = await client.json.get(key) as MCPGatewayRegistry | null

      if (!registry) {
        registry = { gateways: [] }
      }

      // Check for duplicate ID
      if (registry.gateways.some((g: MCPGateway) => g.id === newGateway.id)) {
        throw new Error(`Gateway with ID ${newGateway.id} already exists`)
      }

      // Add new gateway
      this.assignSlug(newGateway, registry.gateways)
      registry.gateways.push(newGateway)

      // Store back (NO JSON.stringify!)
      // ⚠️ CRITICAL: Pass object directly - RedisJSON handles serialization
      await client.json.set(key, '$', registry as unknown as RedisJSON)
    })

    return newGateway
  }

  /**
   * Get all gateways for a user
   *
   * ✅ CORRECT Redis 8 Pattern:
   * - json.get returns already-parsed object
   * - NO JSON.parse anywhere in this function
   */
  async list(userId: string): Promise<MCPGateway[]> {
    const key = this.getKey(userId)

    return await redis.execute(async (client) => {
      // Get registry (already parsed!)
      const registry = await client.json.get(key) as MCPGatewayRegistry | null

      await this.ensureSlugs(userId, registry, client)
      return registry?.gateways || []
    })
  }

  /**
   * Get a specific gateway by ID
   */
  async get(userId: string, gatewayId: string): Promise<MCPGateway | null> {
    const gateways = await this.list(userId)
    return gateways.find(g => g.id === gatewayId) || null
  }

  /**
   * Update an existing gateway
   *
   * ✅ CORRECT Redis 8 Pattern:
   * - Retrieve with json.get (already parsed)
   * - Modify object
   * - Store with json.set (NO stringify)
   */
  async update(userId: string, gatewayId: string, updates: Partial<MCPGateway>): Promise<MCPGateway> {
    // Validate updates
    const validation = this.validateGateway(updates)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    const key = this.getKey(userId)

    let updatedGateway: MCPGateway

    await redis.execute(async (client) => {
      // Get existing registry (already parsed!)
      const registry = await client.json.get(key) as MCPGatewayRegistry | null

      if (!registry) {
        throw new Error('No gateways found for user')
      }

      // Find gateway index
      const index = registry.gateways.findIndex((g: MCPGateway) => g.id === gatewayId)
      if (index === -1) {
        throw new Error(`Gateway with ID ${gatewayId} not found`)
      }

      // Update gateway object
      const sanitizedUpdates = this.normalizeGatewayForStorage({ ...updates })
      if ('slug' in sanitizedUpdates) {
        delete (sanitizedUpdates as Partial<MCPGateway>).slug
      }

      updatedGateway = {
        ...registry.gateways[index],
        ...sanitizedUpdates,
        updated_at: new Date().toISOString()
      }
      registry.gateways[index] = updatedGateway

      // Store updated registry (NO JSON.stringify!)
      await client.json.set(key, '$', registry as unknown as RedisJSON)
    })

    return updatedGateway!
  }

  /**
   * Delete a gateway
   *
   * ✅ CORRECT Redis 8 Pattern:
   * - Retrieve, filter, store - all with json operations
   *
   * SA-096 DL-8: a delete also sweeps every agent and subagent reference to the
   * gateway, so no record is left pointing at an ID that resolves to nothing.
   */
  async delete(userId: string, gatewayId: string): Promise<void> {
    const key = this.getKey(userId)

    const removal = await redis.execute(async (client) => {
      // Get existing registry (already parsed!)
      const registry = await client.json.get(key) as MCPGatewayRegistry | null

      if (!registry) {
        return null // Nothing to delete
      }

      // Filter out the gateway
      const originalLength = registry.gateways.length
      const removedGateway = registry.gateways.find((g: MCPGateway) => g.id === gatewayId) ?? null
      registry.gateways = registry.gateways.filter((g: MCPGateway) => g.id !== gatewayId)

      if (registry.gateways.length === originalLength) {
        throw new Error(`Gateway with ID ${gatewayId} not found`)
      }

      // Store updated registry (NO JSON.stringify!)
      await client.json.set(key, '$', registry as unknown as RedisJSON)

      return { removedGateway, survivingGateways: registry.gateways }
    })

    if (!removal) return

    // Reference sweep runs after the registry write so it compares against the
    // post-delete live set. A sweep failure must not leave the caller believing
    // the gateway is still present.
    try {
      await sweepGatewayReferencesForUser({
        userId,
        orphanToolNames: resolveOrphanToolNames(
          removal.removedGateway,
          removal.survivingGateways
        )
      })
    } catch (error) {
      logger.error(
        `[MCP Gateway] Deleted gateway ${gatewayId} but failed to sweep references:`,
        error
      )
    }
  }

  /**
   * Enable or disable a gateway
   */
  async setEnabled(userId: string, gatewayId: string, enabled: boolean): Promise<void> {
    await this.update(userId, gatewayId, { enabled })
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
