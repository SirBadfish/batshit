/**
 * MCP Gateway Discovery Service
 *
 * Unified service for discovering tools from multiple gateway types.
 * Handles parallel discovery with error isolation.
 *
 * Story 5.22: Unified gateway architecture
 * Story 5.23: Per-tool selection and filtering
 */

import { mcpGatewayService } from './mcpGatewayService'
import { dockerMCPGatewayClient } from './dockerMCPGatewayClient'
import { n8nMCPGatewayClient } from './n8nMCPGatewayClient'
import { buildDockerGatewayHeaders, buildDockerGatewayUrl } from './dockerGatewayConfig'
import { getBlockedBatshitServerGatewayReason, isBlockedBatshitServerGatewayUrl } from './mcpGatewayPolicy'
import type { MCPGateway, MCPToolSelections } from '$lib/types/database'
import type { Tool } from 'ai'
import { logger } from '$lib/utils/logger'
import { tool, jsonSchema } from 'ai' // ✅ Added jsonSchema for JSON Schema to Zod conversion
import { createMCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apiKeyService } from '$lib/services/apiKey.server'
import { stdioMCPGatewayClient } from './stdioMCPGatewayClient'
import { rewriteN8nGatewayUrlForRuntime } from './runtimeUrlRewrites'
import type { GatewayMetadata, ToolMetadataMap, ToolWithName } from './mcpGatewayTypes'

/**
 * SA-009: Discovery options for controlling tool loading behavior
 */
export interface DiscoveryOptions {
  /** When true, skip tool filtering entirely - return ALL discovered tools (for Dynamic MCP find) */
  skipFiltering?: boolean
  /** Optional project path for cwdPolicy=project stdio MCP gateways */
  projectPath?: string | null
}

export interface GatewayDiscoveryResult {
  gatewayId: string
  gatewayName: string
  gatewayType: string
  gateway: MCPGateway  // Added for tool wrapping (Story 6.6)
  tools: ToolWithName[]
  success: boolean
  error?: string
}

export class MCPGatewayDiscovery {
  /**
   * Sanitize name for OpenAI API compatibility
   * OpenAI tool names must match: ^[a-zA-Z0-9_-]+$
   * Replaces spaces and invalid characters with underscores
   *
   * @param name - Gateway or tool name to sanitize
   * @returns Sanitized name safe for OpenAI API
   */
  private sanitizeToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  /**
   * Discover tools from a single gateway
   *
   * @param gateway - Gateway configuration
   * @param userId - Optional user ID for resolving auth tokens
   * @returns Discovery result with tools or error
   */
  async discoverFromGateway(
    gateway: MCPGateway,
    userId?: string,
    options?: DiscoveryOptions
  ): Promise<GatewayDiscoveryResult> {
    gateway = await this.applyRuntimeGatewayUrl(gateway, userId)
    const result: GatewayDiscoveryResult = {
      gatewayId: gateway.id,
      gatewayName: gateway.name,
      gatewayType: gateway.type,
      gateway: gateway,  // Store for tool wrapping (Story 6.6)
      tools: [],
      success: false
    }

    try {
      if (!gateway.enabled) {
        result.error = 'Gateway is disabled'
        return result
      }

      if (isBlockedBatshitServerGatewayUrl(gateway.url)) {
        result.error = getBlockedBatshitServerGatewayReason()
        logger.warn(`[Gateway Discovery] Blocked by policy: ${gateway.name} (${gateway.url})`)
        return result
      }

      const authToken = await this.resolveGatewayAuthToken(gateway, userId)
      const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : undefined

      if (
        gateway.type !== 'docker-catalog' &&
        gateway.type !== 'n8n-mcp-client' &&
        gateway.type !== 'stdio' &&
        !gateway.url
      ) {
        result.error = 'Gateway URL is missing'
        return result
      }

      // Route to appropriate client based on gateway type
      switch (gateway.type) {
        case 'docker-catalog':
          result.tools = await dockerMCPGatewayClient.discoverTools()
          break

        case 'n8n-mcp-trigger':
        case 'n8n-instance-mcp': {
          const gatewayUrl = gateway.url!
          result.tools = await n8nMCPGatewayClient.discoverTools(gatewayUrl, { headers: authHeaders })
          break
        }

        case 'n8n-mcp-client': {
          const toolNames = Array.isArray(gateway.metadata?.toolNames)
            ? gateway.metadata?.toolNames
            : Array.isArray(gateway.discoveredTools)
              ? gateway.discoveredTools
              : []

          result.tools = toolNames.map((name: string) => {
            const sanitized = this.sanitizeToolName(name)
          const placeholder = tool({
            description: `Direct n8n MCP client tool "${name}" discovered from the associated workflow. Execution occurs inside n8n.`,
            inputSchema: jsonSchema({
              type: 'object',
              additionalProperties: true,
              description: 'Inputs are forwarded to the n8n MCP client node inside the workflow.'
            }),
            strict: false,
            execute: async () => ({
              warning: 'Direct MCP client nodes execute within n8n workflows and cannot be invoked directly via batshit.',
              tool: name
            })
          })

            return { ...placeholder, name: sanitized } as ToolWithName
          })

          result.success = true
          break
        }

        case 'custom': {
          const gatewayUrl = gateway.url!
          result.tools = await n8nMCPGatewayClient.discoverTools(gatewayUrl, { headers: authHeaders })
          break
        }

        case 'stdio':
          result.tools = await stdioMCPGatewayClient.discoverTools({
            gateway,
            userId,
            projectPath: options?.projectPath
          })
          break

        default:
          result.error = `Unknown gateway type: ${gateway.type}`
          return result
      }

      result.success = true
      logger.debug(`[Gateway Discovery] Discovered ${result.tools.length} tools from ${gateway.name}`)
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Discovery failed'
      console.error(`[Gateway Discovery] Failed to discover from ${gateway.name}:`, error)
    }

    return result
  }

  /**
   * Discover tools from multiple gateways in parallel
   *
   * Error isolation: One gateway failure doesn't break others
   *
   * @param gateways - Array of gateway configurations
   * @returns Array of discovery results
   */
  async discoverFromMultipleGateways(
    gateways: MCPGateway[],
    userId?: string,
    options?: DiscoveryOptions
  ): Promise<GatewayDiscoveryResult[]> {
    logger.debug(`[Gateway Discovery] Discovering from ${gateways.length} gateways in parallel`)

    // Discover from all gateways in parallel
    // Use Promise.allSettled for error isolation
    const results = await Promise.allSettled(
      gateways.map(gateway => this.discoverFromGateway(gateway, userId, options))
    )

    // Extract results, marking failures
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value
      } else {
        // Promise was rejected
        const gateway = gateways[index]
        return {
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          gatewayType: gateway.type,
          gateway: gateway,  // Store for tool wrapping (Story 6.6)
          tools: [],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : 'Unknown error'
        }
      }
    })
  }

  /**
   * Filter tools based on enabled tool list (SA-009: Flat list model)
   *
   * Simple model: if tool is in the enabledTools list, include it.
   * If not in list, exclude it (unless build-context injection applies).
   *
   * @param tools - Discovered tools
   * @param gatewayId - Gateway ID (for logging only)
   * @param gatewayName - Gateway name (for logging only)
   * @param enabledTools - Flat array of enabled tool names
   * @returns Filtered tools based on enabled list
   */
  filterToolsBySelection(
    tools: ToolWithName[],
    gatewayId: string,
    gatewayName: string,
    enabledTools?: MCPToolSelections
  ): ToolWithName[] {
    // SA-009: enabledTools is now a flat string[] (or undefined)
    const enabledSet = new Set(Array.isArray(enabledTools) ? enabledTools : [])
    const hasSelections = enabledSet.size > 0

    // If no selections, nothing is enabled.
    if (!hasSelections) {
      logger.debug(`[Tool Filtering] No tools enabled for gateway ${gatewayId} - returning 0 tools`)
      return []
    }

    const filteredTools: ToolWithName[] = []

    for (const tool of tools) {
      // SA-009: Simple check - is this tool in the enabled list?
      if (enabledSet.has(tool.name)) {
        filteredTools.push(tool)
      }
    }

    logger.debug(`[Tool Filtering] Gateway ${gatewayId}: Filtered ${tools.length} tools to ${filteredTools.length}`)

    return filteredTools
  }

  /**
   * Extract MCP name from namespaced tool name
   * Format: "Redis_get" -> "Redis"
   */
  private extractMCPName(toolName: string): string | null {
    const parts = toolName.split('_')
    return parts.length > 1 ? parts[0] : null
  }

  /**
   * Extract tool name from namespaced tool name
   * Format: "Redis_get" -> "get"
   */
  private extractToolName(toolName: string): string {
    const parts = toolName.split('_')
    return parts.length > 1 ? parts.slice(1).join('_') : toolName
  }

  /**
   * Resolve the normalized identity for a tool
   * Determines group display name and sanitized identifiers
   */
  private resolveToolIdentity(
    tool: ToolWithName,
    gateway: MCPGateway,
    fallbackGatewayName: string
  ): {
    displayGroupName: string
    sanitizedGroupName: string
    sanitizedToolName: string
  } {
    const grouping = gateway.toolGroupings?.find((group) => group.toolIds.includes(tool.name))
    const groupLabel = grouping?.mcpName?.trim()?.length
      ? grouping!.mcpName
      : 'Ungrouped Tools'

    const sanitizedGroupName = grouping?.mcpName?.trim()?.length
      ? this.sanitizeToolName(grouping!.mcpName)
      : ''

    const sanitizedToolName = this.sanitizeToolName(tool.name) || 'tool'

    return {
      displayGroupName: groupLabel || fallbackGatewayName || 'Ungrouped Tools',
      sanitizedGroupName,
      sanitizedToolName
    }
  }

  /**
   * Sanitize tool parameters schema for OpenAI compatibility
   *
   * OpenAI requires schemas to have `type: "object"`. Some MCP servers
   * may return invalid schemas like `type: "None"` which causes OpenAI
   * to reject the entire request.
   *
   * @param params - Original tool parameters schema
   * @returns Sanitized schema safe for OpenAI
   */
  private sanitizeToolParameters(params: any): any {
    // Log EVERYTHING for debugging
    logger.debug(`[Schema Sanitization] Input params:`, JSON.stringify(params, null, 2))

    if (!params || typeof params !== 'object') {
      // No schema or invalid - use default empty object schema
      logger.debug(`[Schema Sanitization] No params or invalid object, using default schema`)
      return {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }

    // Recursive sanitization to handle nested schemas
    const sanitize = (schema: any): any => {
      if (!schema || typeof schema !== 'object') {
        return schema
      }

      const result = Array.isArray(schema) ? [...schema] : { ...schema }

      // CRITICAL: If this looks like a property definition but has no type, add one
      // This prevents Zod parser errors about undefined typeName
      if (!Array.isArray(result) && !('type' in result) && (result.properties || result.items || result.description)) {
        logger.debug(`[Schema Sanitization] Property missing type field, defaulting to "object"`)
        result.type = 'object'
      }

      // Fix invalid type values at any level
      if ('type' in result) {
        const typeValue = result.type

        // Check if type is invalid (None, none, null, undefined, empty string, or contains "None")
        if (
          typeValue === 'None' ||
          typeValue === 'none' ||
          typeValue === '"None"' ||  // String containing "None" with quotes
          typeValue === null ||
          typeValue === undefined ||
          typeValue === '' ||
          !typeValue ||
          String(typeValue).toLowerCase().includes('none')
        ) {
          logger.debug(`[Schema Sanitization] Invalid type detected: "${typeValue}" -> Replacing with "object"`)
          result.type = 'object'
        }
      }

      // Ensure object type has properties
      if (result.type === 'object' && !result.properties) {
        result.properties = {}
      }

      // Recursively sanitize properties
      if (result.properties && typeof result.properties === 'object') {
        const sanitizedProps: any = {}
        for (const [key, value] of Object.entries(result.properties)) {
          sanitizedProps[key] = sanitize(value)
        }
        result.properties = sanitizedProps
      }

      // Recursively sanitize items (for arrays)
      if (result.items) {
        result.items = sanitize(result.items)
      }

      // Recursively sanitize anyOf, oneOf, allOf
      if (result.anyOf) {
        result.anyOf = result.anyOf.map(sanitize)
      }
      if (result.oneOf) {
        result.oneOf = result.oneOf.map(sanitize)
      }
      if (result.allOf) {
        result.allOf = result.allOf.map(sanitize)
      }

      return result
    }

    const sanitized = sanitize(params)

    logger.debug(`[Schema Sanitization] Final sanitized schema:`, JSON.stringify(sanitized, null, 2))
    return sanitized
  }

  /**
   * Wrap an MCP tool with on-demand client execution
   *
   * CRITICAL FIX (Story 6.6): MCP tools from mcpClient.tools() have execute functions
   * that reference the MCP client. But we close the client after discovery to prevent
   * resource leaks. This wrapper creates a fresh client on-demand for each execution.
   *
   * @param originalTool - The MCP tool from mcpClient.tools()
   * @param gateway - Gateway configuration (for recreating client)
   * @param toolName - Tool name (for logging)
   * @returns Wrapped tool with on-demand client execution
   */
  private wrapMCPToolWithOnDemandClient(
    originalTool: ToolWithName,
    gateway: MCPGateway,
    toolName: string,
    executionContext?: {
      userId?: string
      projectPath?: string | null
    }
  ): Tool {
    if (gateway.type === 'n8n-mcp-client') {
      // Synthetic n8n MCP clients execute entirely within n8n workflows.
      // The placeholder tool returned from discovery already exposes a safe stub.
      return originalTool
    }

    // 🎯 CRITICAL FIX: MCP tools have inputSchema.jsonSchema, NOT .parameters
    // Extract the schema from the correct location
    const schema = (originalTool as any).inputSchema?.jsonSchema || (originalTool as any).inputSchema
    const sanitizedSchema = this.sanitizeToolParameters(schema)

    logger.debug(`[Tool Wrapping] ${toolName} FINAL schema being passed to tool():`, JSON.stringify(sanitizedSchema, null, 2))

    // ✅ BUG-009 FIX: Wrap JSON Schema with jsonSchema() helper for Vercel AI SDK compatibility
    // tool() expects a Zod schema, but MCP tools provide JSON Schema
    // jsonSchema() converts JSON Schema to a format the SDK can parse
    const wrappedSchema = jsonSchema(sanitizedSchema)

    return tool({
      description: originalTool.description,
      inputSchema: wrappedSchema,  // ✅ Use wrapped schema instead of raw JSON Schema
      strict: false,
      execute: async (args: any) => {
        let mcpClient: any | undefined

        try {
          logger.debug(`[MCP Tool Execution] Creating fresh client for ${toolName} on ${gateway.name}`)

          if (gateway.type === 'stdio') {
            const {
              client,
              stderrChunks,
              toolCallTimeoutMs
            } = await stdioMCPGatewayClient.createClient({
              gateway,
              userId: executionContext?.userId,
              projectPath: executionContext?.projectPath
            })
            mcpClient = client

            const tools = await mcpClient.tools()
            const targetTool = tools[originalTool.name]
            if (!targetTool || !targetTool.execute) {
              throw new Error(`Tool ${originalTool.name} not found in STDIO gateway ${gateway.name}`)
            }

            let timeoutId: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () =>
                  reject(new Error(`STDIO tool call timed out after ${toolCallTimeoutMs}ms`)),
                toolCallTimeoutMs
              )
            })

            try {
              return await Promise.race([targetTool.execute(args), timeout])
            } catch (error) {
              const stderr = stderrChunks.join('').trim()
              if (stderr) {
                throw new Error(
                  `${error instanceof Error ? error.message : 'STDIO tool execution failed'} (${stderr})`
                )
              }
              throw error
            } finally {
              if (timeoutId) clearTimeout(timeoutId)
            }
          }

          // Create fresh MCP client for this execution
          // ⚠️ CRITICAL: Don't specify sessionId - let transport handle it (same as discovery)
          const gatewayUrl =
            gateway.type === 'docker-catalog'
              ? buildDockerGatewayUrl('/mcp')
              : gateway.url

          if (!gatewayUrl) {
            throw new Error(`Gateway ${gateway.name} is missing its MCP URL`)
          }
          const url = new URL(gatewayUrl)
          let headers: Record<string, string> | undefined
          if (gateway.type === 'docker-catalog') {
            headers = buildDockerGatewayHeaders()
          } else if (gateway.type === 'n8n-instance-mcp' && typeof gateway.metadata?.authToken === 'string') {
            headers = { Authorization: `Bearer ${gateway.metadata.authToken}` }
          } else if (gateway.type === 'custom' && typeof gateway.metadata?.authToken === 'string') {
            headers = { Authorization: `Bearer ${gateway.metadata.authToken}` }
          }

          const transport = new StreamableHTTPClientTransport(
            url,
            headers ? { requestInit: { headers } } : undefined
          )
          mcpClient = await createMCPClient({ transport })

          // Get the tools from this client
          const tools = await mcpClient.tools()

          // Find and execute the specific tool
          const targetTool = tools[originalTool.name]
          if (!targetTool || !targetTool.execute) {
            throw new Error(`Tool ${originalTool.name} not found in gateway ${gateway.name}`)
          }

          // Execute the tool
          const result = await targetTool.execute(args)
          logger.debug(`[MCP Tool Execution] Successfully executed ${toolName}`)

          // FIX: Unwrap MCP result if it's wrapped in content array
          // MCP returns: {content: [{type: 'text', text: '...'}]}
          // We need: the actual text value
          if (result && result.content && Array.isArray(result.content) && result.content[0]?.text) {
            logger.debug(`[MCP Tool Execution] Unwrapping MCP content structure`);
            let unwrapped = result.content[0].text;

            // Check if the text itself is a JSON string that needs parsing
            if (typeof unwrapped === 'string' && (unwrapped.startsWith('[') || unwrapped.startsWith('{'))) {
              try {
                const parsed = JSON.parse(unwrapped);
                logger.debug(`[MCP Tool Execution] Further unwrapping JSON string`);
                return parsed;
              } catch (e) {
                // Not valid JSON, return as-is
                return unwrapped;
              }
            }

            return unwrapped;
          }

          return result
        } catch (error) {
          console.error(`[MCP Tool Execution] Error executing ${toolName}:`, error)
          throw error
        } finally {
          // ✅ CRITICAL: Always close the client after execution
          if (mcpClient) {
            try {
              await mcpClient.close()
              logger.debug(`[MCP Tool Execution] Closed client for ${toolName}`)
            } catch (closeError) {
              console.error(`[MCP Tool Execution] Error closing client for ${toolName}:`, closeError)
            }
          }
        }
      }
    })
  }

  /**
   * Load tools for a user from their selected gateways
   * Story 6.4: Now returns both tools AND gateway metadata for CleanTools detection
   * SA-009: DiscoveryOptions.skipFiltering bypasses all filtering (for Dynamic MCP find)
   *
   * @param userId - User ID
   * @param selectedGatewayIds - Optional array of gateway IDs to load (if empty, loads all enabled)
   * @param toolSelections - Optional tool selections for filtering (Story 5.23)
   * @param discoveryOptions - SA-009: Discovery behavior options (skipFiltering for Dynamic MCP)
   * @returns Tools mapped by name AND metadata map for detection
   */
  async loadToolsForUser(
    userId: string,
    selectedGatewayIds?: string[],
    toolSelections?: MCPToolSelections,
    discoveryOptions?: DiscoveryOptions
  ): Promise<ToolMetadataMap> {
    try {
      // Get all enabled gateways first
      const allGateways = await mcpGatewayService.listEnabled(userId)
      const gatewaysWithAuth = await this.applyUserAuthTokens(allGateways, userId)

      // Filter by selectedGatewayIds if provided
      // ✅ FIX: Distinguish between undefined (load all) and [] (load none)
      const gateways = selectedGatewayIds !== undefined
        ? gatewaysWithAuth.filter(g => selectedGatewayIds.includes(g.id))  // Includes [] case (returns [])
        : gatewaysWithAuth  // Only when undefined (no selection made)

      logger.debug(
        `[Gateway Discovery] Loading ${gateways.length}/${allGateways.length} gateways for user ${userId}` +
        (selectedGatewayIds ? ` (${selectedGatewayIds.length} selected)` : ' (all enabled)')
      )

      if (gateways.length === 0) {
        logger.debug(`[Gateway Discovery] No gateways to load for user ${userId}`)
        return { tools: {}, metadata: new Map() }
      }

      // Discover from all gateways in parallel
      const startTime = performance.now()
      const resolvedDiscoveryOptions: DiscoveryOptions = {
        ...discoveryOptions
      }

      const results = await this.discoverFromMultipleGateways(
        gateways.map(g => ({ ...g })),
        userId,
        resolvedDiscoveryOptions
      )
      const discoveryTime = performance.now() - startTime

      // Aggregate tools from all successful discoveries
      // Story 6.4: Also track metadata for each tool
      const allTools: Record<string, Tool> = {}
      const toolMetadata = new Map<string, GatewayMetadata>()
      let totalDiscovered = 0
      let totalFiltered = 0
      for (const result of results) {
        if (result.success) {
          totalDiscovered += result.tools.length

          // Apply tool filtering (SA-009: ALWAYS filter, undefined = all disabled)
          // SA-009: skipFiltering bypasses all filtering (for Dynamic MCP find)
          const filterStartTime = performance.now()
          let filteredTools: ToolWithName[]

          if (resolvedDiscoveryOptions.skipFiltering) {
            // SA-009: Dynamic MCP find needs ALL tools, skip filtering entirely
            filteredTools = result.tools
            logger.debug(`[Tool Filtering] SA-009: skipFiltering=true - returning all ${result.tools.length} tools`)
          } else {
            // SA-009: Always apply filtering - undefined toolSelections means all tools disabled
            // so new tools default to disabled until explicitly selected.
            filteredTools = this.filterToolsBySelection(
              result.tools,
              result.gatewayId,
              result.gatewayName,
              toolSelections
            )
          }
          const filterTime = performance.now() - filterStartTime

          // Log filtering performance
          if (toolSelections && filterTime > 10) {
            logger.warn(`[Tool Filtering] Filtering took ${filterTime.toFixed(2)}ms for ${result.gatewayName}`)
          }

          // Convert array to object with tool names as keys
          // Story 6.4: Also track gateway metadata for each tool
          // Story 6.6: Wrap MCP tools with on-demand client execution (CRITICAL FIX!)
          // CRITICAL: Sanitize gateway name for OpenAI API compatibility (spaces → underscores)
          for (const tool of filteredTools) {
            const identity = this.resolveToolIdentity(tool, result.gateway, result.gatewayName)

            let toolKey = identity.sanitizedToolName

            // Ensure uniqueness across gateways (fallback to gateway namespace on collision)
            if (allTools[toolKey]) {
              const fallbackNamespace = this.sanitizeToolName(result.gatewayName)
              toolKey = `${fallbackNamespace}_${identity.sanitizedToolName}`
            }

            // STORY 6.6 CRITICAL FIX: Wrap tool with on-demand client execution
            // Raw MCP tools have execute functions that reference closed clients.
            // This wrapper creates fresh clients on-demand for each execution.
            const wrappedTool = this.wrapMCPToolWithOnDemandClient(
              tool,
              result.gateway,
              toolKey,
              {
                userId,
                projectPath: resolvedDiscoveryOptions.projectPath
              }
            )
            allTools[toolKey] = wrappedTool

            // Store metadata for this tool
            const normalizedGatewayType: GatewayMetadata['gatewayType'] =
              result.gatewayType === 'docker-catalog'
                ? 'docker'
                : result.gatewayType === 'n8n-mcp-trigger'
                  ? 'n8n-mcp-trigger'
                  : result.gatewayType === 'n8n-instance-mcp'
                    ? 'n8n-instance-mcp'
                    : result.gatewayType === 'stdio'
                      ? 'stdio'
                    : result.gatewayType === 'n8n-mcp-client'
                      ? 'n8n-mcp-client'
                      : 'custom'

            toolMetadata.set(toolKey, {
              gatewayId: result.gatewayId,
              gatewayName: result.gatewayName, // Keep original name in metadata
              gatewayType: normalizedGatewayType,
              mcpServerName: identity.displayGroupName,
              originalToolName: tool.name
            })

            totalFiltered++
          }
        } else {
          console.warn(`[Gateway Discovery] Gateway ${result.gatewayName} failed: ${result.error}`)
        }
      }

      const totalTime = performance.now() - startTime

      logger.info(
        `[Gateway Discovery] Loaded ${totalFiltered} tools (${totalDiscovered} discovered, ` +
        `${totalDiscovered - totalFiltered} filtered out) from ${gateways.length} gateways in ${totalTime.toFixed(2)}ms` +
        ` [Story 6.4: with metadata]`
      )

      // Warn if filtering overhead is high (> 50ms target from AC25)
      const filteringOverhead = totalTime - discoveryTime
      if (filteringOverhead > 50) {
        logger.warn(
          `[Performance] Tool filtering overhead: ${filteringOverhead.toFixed(2)}ms ` +
          `(exceeds 50ms target from Story 5.23 AC25)`
        )
      }

      return {
        tools: allTools,
        metadata: toolMetadata
      }
    } catch (error) {
      console.error('[Gateway Discovery] Error loading tools for user:', error)
      return { tools: {}, metadata: new Map() }
    }
  }

  /**
   * Refresh tool discovery for a specific gateway
   *
   * @param userId - User ID
   * @param gatewayId - Gateway ID to refresh
   * @returns Discovery result
   */
  async refreshGateway(userId: string, gatewayId: string): Promise<GatewayDiscoveryResult> {
    const gateway = await mcpGatewayService.get(userId, gatewayId)

    if (!gateway) {
      // Create a minimal gateway object for the error case
      const unknownGateway: MCPGateway = {
        id: gatewayId,
        name: 'Unknown',
        type: 'custom',
        url: '',
        enabled: false,
        created_at: new Date().toISOString()
      }
      return {
        gatewayId,
        gatewayName: 'Unknown',
        gatewayType: 'unknown',
        gateway: unknownGateway,
        tools: [],
        success: false,
        error: 'Gateway not found'
      }
    }

    // Discover tools
    const result = await this.discoverFromGateway(gateway, userId)

    // Update gateway with discovered tools if successful
    if (result.success) {
      await mcpGatewayService.updateDiscoveredTools(
        userId,
        gatewayId,
        result.tools.map(t => t.name)
      )
    }

    return result
  }

  /**
   * Health check for a specific gateway
   *
   * @param gateway - Gateway configuration
   * @returns Health status
   */
  async healthCheck(
    gateway: MCPGateway,
    userId?: string
  ): Promise<{ available: boolean; error?: string; toolCount?: number }> {
    try {
      gateway = await this.applyRuntimeGatewayUrl(gateway, userId)
      const authToken = await this.resolveGatewayAuthToken(gateway, userId)
      const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : undefined

      if (
        gateway.type !== 'docker-catalog' &&
        gateway.type !== 'stdio' &&
        gateway.type !== 'n8n-mcp-client' &&
        !gateway.url
      ) {
        return { available: false, error: 'Gateway URL is missing' }
      }

      switch (gateway.type) {
        case 'docker-catalog':
          return await dockerMCPGatewayClient.healthCheck()

        case 'n8n-mcp-trigger':
        case 'n8n-instance-mcp':
        case 'custom': {
          const gatewayUrl = gateway.url!
          return await n8nMCPGatewayClient.healthCheck(gatewayUrl, undefined, { headers: authHeaders })
        }

        case 'stdio':
          return await stdioMCPGatewayClient.healthCheck({ gateway, userId })

        default:
          return { available: false, error: 'Unsupported gateway type' }
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Health check failed'
      }
    }
  }

  private async applyUserAuthTokens(gateways: MCPGateway[], userId: string): Promise<MCPGateway[]> {
    let n8nInstanceToken: string | null = null
    let n8nApiUrl: string | null = null
    try {
      n8nInstanceToken = await apiKeyService.retrieve('n8n_instance_mcp_token', userId)
    } catch (error) {
      console.warn('[Gateway Discovery] Failed to load n8n instance MCP token', error)
    }
    try {
      n8nApiUrl = await apiKeyService.retrieve('n8n_api_url', userId)
    } catch (error) {
      console.warn('[Gateway Discovery] Failed to load n8n API URL', error)
    }

    // Resolve auth keys for custom gateways with authKeyName
    const customAuthTokens = new Map<string, string>()
    for (const gw of gateways) {
      if (gw.authKeyName && !customAuthTokens.has(gw.authKeyName)) {
        try {
          const token = await apiKeyService.retrieve(gw.authKeyName, userId)
          if (token) customAuthTokens.set(gw.authKeyName, token)
        } catch (error) {
          console.warn(`[Gateway Discovery] Failed to load auth key "${gw.authKeyName}"`, error)
        }
      }
    }

    return gateways.map((gateway) => {
      gateway = rewriteN8nGatewayUrlForRuntime(gateway, n8nApiUrl)

      // Custom gateways with authKeyName — inject resolved token
      if (gateway.authKeyName && customAuthTokens.has(gateway.authKeyName)) {
        const metadata = { ...(gateway.metadata ?? {}), authToken: customAuthTokens.get(gateway.authKeyName) }
        return { ...gateway, metadata }
      }

      if (gateway.type !== 'n8n-instance-mcp') return gateway
      const metadata = { ...(gateway.metadata ?? {}) }
      if ('authToken' in metadata) {
        delete (metadata as Record<string, any>).authToken
      }
      if (n8nInstanceToken) {
        metadata.authToken = n8nInstanceToken
      }
      return {
        ...gateway,
        metadata
      }
    })
  }

  private async applyRuntimeGatewayUrl(gateway: MCPGateway, userId?: string): Promise<MCPGateway> {
    if (
      gateway.type !== 'n8n-mcp-trigger' &&
      gateway.type !== 'n8n-instance-mcp' &&
      gateway.type !== 'n8n-mcp-client'
    ) {
      return gateway
    }

    let n8nApiUrl: string | null = null
    if (userId) {
      try {
        n8nApiUrl = await apiKeyService.retrieve('n8n_api_url', userId)
      } catch (error) {
        console.warn('[Gateway Discovery] Failed to load n8n API URL', error)
      }
    }

    return rewriteN8nGatewayUrlForRuntime(gateway, n8nApiUrl)
  }

  private async resolveGatewayAuthToken(gateway: MCPGateway, userId?: string): Promise<string | null> {
    // Custom gateways with authKeyName — resolve from API Keys store
    if (gateway.authKeyName && userId) {
      try {
        const token = await apiKeyService.retrieve(gateway.authKeyName, userId)
        return token || null
      } catch (error) {
        console.warn(`[Gateway Discovery] Failed to resolve auth key "${gateway.authKeyName}" for custom gateway`, error)
        return null
      }
    }
    if (gateway.type === 'n8n-instance-mcp' && userId) {
      try {
        const token = await apiKeyService.retrieve('n8n_instance_mcp_token', userId)
        return token || null
      } catch (error) {
        console.warn('[Gateway Discovery] Failed to resolve n8n instance MCP token', error)
        return null
      }
    }
    if (gateway.type === 'n8n-instance-mcp') {
      return typeof gateway.metadata?.authToken === 'string' ? gateway.metadata.authToken : null
    }
    if (gateway.type === 'stdio') {
      return null
    }
    return typeof gateway.metadata?.authToken === 'string' ? gateway.metadata.authToken : null
  }

  async buildGatewayToolMap(params: {
    userId: string
    selectedGatewayIds?: string[] | null
    toolSelections?: MCPToolSelections | null
    discoveryOptions?: DiscoveryOptions
  }): Promise<Record<string, string[]>> {
    const enabledGateways = await this.applyUserAuthTokens(
      await mcpGatewayService.listEnabled(params.userId),
      params.userId
    )
    const hasExplicitGatewaySelection = Array.isArray(params.selectedGatewayIds)
    const selectedGatewaySet = hasExplicitGatewaySelection
      ? new Set(params.selectedGatewayIds)
      : null
    const enabledToolSet = new Set(Array.isArray(params.toolSelections) ? params.toolSelections : [])
    const gateways = selectedGatewaySet
      ? enabledGateways.filter((gateway) => selectedGatewaySet.has(gateway.id))
      : enabledGateways

    if (gateways.length === 0 || enabledToolSet.size === 0) {
      return {}
    }

    const results = await this.discoverFromMultipleGateways(
      gateways,
      params.userId,
      params.discoveryOptions
    )

    const gatewayToolMap: Record<string, string[]> = {}
    for (const result of results) {
      if (!result.success) continue
      const selectedTools = result.tools
        .map((tool) => tool.name)
        .filter((toolName) => enabledToolSet.has(toolName))
        .sort()
      if (selectedTools.length > 0) {
        gatewayToolMap[result.gatewayId] = selectedTools
      }
    }

    return gatewayToolMap
  }

}

// Export singleton instance
export const mcpGatewayDiscovery = new MCPGatewayDiscovery()
