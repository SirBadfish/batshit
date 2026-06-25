/**
 * Dynamic MCP Tool Execute API
 * SA-009: Batshit Dynamic MCP
 *
 * POST /api/mcp/tools/execute - Execute any MCP tool by name
 *
 * Supports:
 * - Session auth (normal user session)
 * - Service token auth (batshit-server tool calls via x-batshit-service-token header)
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { logger } from '$lib/utils/logger'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import { resolveDynamicMcpGatewayScope } from '$lib/server/services/mcpSelectionResolver'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'

interface ExecuteRequest {
  userId?: string                    // Required for service token auth
  agentId?: string                   // Optional: apply per-agent gateway scope
  toolName: string                   // Full tool name (e.g., "mcp__postgres__query")
  params?: Record<string, any>       // Tool arguments
  selectedGateways?: string[]        // Optional explicit scope override
  gatewayFilter?: string[]           // Legacy alias for selectedGateways
}

interface ExecuteSuccessResponse {
  success: true
  result: any
  toolName: string
  executionTimeMs: number
}

interface ExecuteErrorResponse {
  success: false
  error: string
  toolName: string
}

type ExecuteResponse = ExecuteSuccessResponse | ExecuteErrorResponse

export const POST: RequestHandler = async ({ locals, request }) => {
  const startTime = Date.now()
  let toolName = ''

  try {
    const body = await request.json() as ExecuteRequest
    toolName = body.toolName || ''
    const params = body.params || {}

    // Validate toolName
    if (!toolName || typeof toolName !== 'string' || toolName.trim().length === 0) {
      return json({
        success: false,
        error: 'toolName is required',
        toolName: toolName || 'unknown'
      } as ExecuteErrorResponse, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })
    if (!auth) {
      return apiFailure('Unauthorized', 401, { toolName }) as Response
    }
    const userId = auth.userId
    if (auth.auth === 'service') {
      logger.debug(`[MCP Tools Execute] Service auth for user ${userId}, tool: ${toolName}`)
    }

    const selectedGateways = Array.isArray(body.selectedGateways)
      ? body.selectedGateways
      : Array.isArray(body.gatewayFilter)
        ? body.gatewayFilter
        : undefined
    const scopeResolution = await resolveDynamicMcpGatewayScope({
      userId,
      agentId: body.agentId ?? null,
      selectedGateways
    })

    // Load tools from resolved scope only.
    const { tools, metadata } = await mcpGatewayDiscovery.loadToolsForUser(
      userId,
      scopeResolution.resolvedGateways,
      undefined,  // No tool selections
      { skipFiltering: true }  // Dynamic MCP execute still bypasses per-tool filtering
    )

    // Find the requested tool
    const tool = tools[toolName]
    const meta = metadata.get(toolName)

    if (!tool) {
      // Check whether tool exists globally but is out-of-scope.
      const { tools: globalTools } = await mcpGatewayDiscovery.loadToolsForUser(
        userId,
        undefined,
        undefined,
        { skipFiltering: true }
      )
      const normalizedRequested = toolName.toLowerCase()
      const scopedNames = Object.keys(tools)
      const globalNames = Object.keys(globalTools)
      const inGlobalScope = globalNames.some((name) => name.toLowerCase() === normalizedRequested)

      if (inGlobalScope) {
        return json(
          {
            success: false,
            error:
              `Tool "${toolName}" is outside the active Dynamic MCP scope. ` +
              'Enable the relevant gateway or adjust the current agent scope.',
            toolName
          } as ExecuteErrorResponse,
          { status: 403 }
        )
      }

      // Tool not found - provide helpful error
      const suggestions = scopedNames
        .filter(t => t.toLowerCase().includes(toolName.toLowerCase().split('_')[0]))
        .slice(0, 5)

      return json({
        success: false,
        error:
          `Tool "${toolName}" not found in the active Dynamic MCP scope. ` +
          (suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}?`
            : `Found ${scopedNames.length} tools in scope.`),
        toolName
      } as ExecuteErrorResponse, { status: 404 })
    }

    logger.debug(
      `[MCP Tools Execute] Executing ${toolName} from gateway ${meta?.gatewayName || 'unknown'} ` +
        `(scope=${scopeResolution.source}, gateways=${scopeResolution.resolvedGateways.length})`
    )
    logger.debug(`[MCP Tools Execute] Params received`, {
      keys: params && typeof params === 'object' ? Object.keys(params) : []
    })

    // Execute the tool
    // The tool has already been wrapped with on-demand client creation by mcpGatewayDiscovery
    // (Story 6.6 pattern - fresh MCP client per execution)
    const executeFunc = (tool as any).execute
    if (typeof executeFunc !== 'function') {
      console.error(`[MCP Tools Execute] Tool ${toolName} has no execute function!`)
      return json({
        success: false,
        error: `Tool "${toolName}" does not have an execute function`,
        toolName
      } as ExecuteErrorResponse, { status: 500 })
    }

    logger.debug(`[MCP Tools Execute] Calling execute for ${toolName}...`)
    const result = await executeFunc(params)
    logger.debug(`[MCP Tools Execute] Result type: ${typeof result}`)
    const executionTimeMs = Date.now() - startTime

    logger.debug(`[MCP Tools Execute] ${toolName} completed in ${executionTimeMs}ms`)

    return json({
      success: true,
      result,
      toolName,
      executionTimeMs
    } as ExecuteSuccessResponse)

  } catch (error) {
    const executionTimeMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Tool execution failed'
    const errorStack = error instanceof Error ? error.stack : undefined
    console.error(`[MCP Tools Execute] Error executing ${toolName}:`, errorMessage)
    console.error(`[MCP Tools Execute] Stack:`, errorStack)

    return json({
      success: false,
      error: errorMessage,
      toolName,
      executionTimeMs
    } as ExecuteErrorResponse, { status: 500 })
  }
}
