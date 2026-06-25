/**
 * Workflow Tools Service for API Primary Agents
 * Story 5.7 & 5.11: Converts n8n workflows into Vercel AI SDK tools
 *
 * CRITICAL: Workflows become simple async functions
 * CRITICAL: Direct webhook execution without Ghost infrastructure
 * CRITICAL: Uses SvelteKit env system, not process.env
 * CRITICAL: Dynamic tool discovery and registration (Story 5.11)
 * CRITICAL: Use tool helper for type inference (Vercel AI SDK pattern)
 */

import { tool, dynamicTool } from 'ai'
import { logger } from '$lib/utils/logger'

// Infer tool type from the tool function return
type AITool = ReturnType<typeof tool<any, any>>

// Import new services from Story 5.11
import { workflowDiscovery } from './workflowDiscovery'
import { generateZodSchema } from './workflowSchemaGenerator'
import { callWorkflow as executeWorkflow } from './workflowExecutor'

/**
 * Load workflows as tools for Vercel AI SDK
 * Story 5.11: Dynamic discovery and registration
 * CRITICAL: Uses tool helper for type inference (Vercel pattern)
 */
export async function loadWorkflowTools(
  userId?: string,
  sessionId?: string,
  allowedWorkflows?: string[]
): Promise<Record<string, AITool>> {
  logger.debug('[WorkflowTools] Loading workflow tools', {
    userId: userId?.substring(0, 8),
    sessionId: sessionId?.substring(0, 8),
    allowedWorkflowsCount: Array.isArray(allowedWorkflows) ? allowedWorkflows.length : 0
  })

  const tools: Record<string, AITool> = {}
  const normalizedAllowList = Array.isArray(allowedWorkflows)
    ? allowedWorkflows
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter((value) => value.length > 0)
    : []
  const allowSet = new Set(normalizedAllowList)

  const workflows = await workflowDiscovery.getAvailableWorkflows()

  logger.debug('[WorkflowTools] Discovered workflows', {
    count: workflows.length
  })

  for (const workflow of workflows) {
    const toolName = workflowToToolName(workflow.name)
    const normalizedToolName = toolName.replace(/-/g, '_')
    const normalizedName = workflow.name?.toLowerCase?.() || ''
    const normalizedId = workflow.id?.toString?.().toLowerCase?.() || ''
    const normalizedWebhook = workflow.webhookUrl?.toLowerCase?.() || ''

    if (allowSet.size > 0) {
      const isAllowed =
        allowSet.has(toolName) ||
        allowSet.has(normalizedToolName) ||
        (normalizedName && allowSet.has(normalizedName)) ||
        (normalizedId && allowSet.has(normalizedId)) ||
        (normalizedWebhook && allowSet.has(normalizedWebhook))

      if (!isAllowed) {
        continue
      }
    }

    if (!workflow.webhookUrl) {
      console.warn('[WorkflowTools] Skipping workflow without webhook', {
        name: workflow.name
      })
      continue
    }

    if (userId) {
      const hasPermission = await workflowDiscovery.checkWorkflowPermission(
        workflow.id,
        userId
      )

      if (!hasPermission) {
        logger.debug('[WorkflowTools] User lacks permission for workflow', {
          workflow: workflow.name
        })
        continue
      }
    }

    const schemaResult = generateZodSchema(workflow)

    if (!schemaResult.success) {
      console.warn('[WorkflowTools] Schema generation failed', {
        workflow: workflow.name,
        error: schemaResult.error
      })
      continue
    }

    tools[toolName] = dynamicTool({
      description: workflow.description || `Execute ${workflow.name} workflow`,
      inputSchema: schemaResult.schema,
      execute: async (input) => {
        const validation = schemaResult.schema.safeParse(input)

        if (!validation.success) {
          return {
            success: false,
            error: 'Invalid parameters: ' + validation.error.message,
            workflow: workflow.name
          }
        }

        return executeWorkflow(
          workflow,
          validation.data,
          {
            sessionId,
            userId,
            timeout: 30000
          }
        )
      }
    })

    logger.debug('[WorkflowTools] Registered workflow tool', {
      name: toolName,
      fields: schemaResult.fieldCount
    })
  }

  logger.debug('[WorkflowTools] Loaded tools', {
    count: Object.keys(tools).length,
    tools: Object.keys(tools)
  })

  return tools
}

/**
 * Convert workflow name to tool-safe name
 * Must be kebab-case with no special characters
 */
function workflowToToolName(workflowName: string): string {
  return workflowName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50) // Limit length
}

/**
 * Re-export callWorkflow from executor for backward compatibility
 * Story 5.11: Now uses proper timeout handling and security
 */
export { callWorkflow } from './workflowExecutor'

/**
 * List all available workflows
 * Story 5.11: Now uses dynamic discovery
 */
export async function listAvailableWorkflows(): Promise<Array<{
  id: string
  name: string
  description: string
}>> {
  try {
    const workflows = await workflowDiscovery.getAvailableWorkflows()

    return workflows.map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description || `Workflow: ${workflow.name}`
    }))
  } catch (error: any) {
    console.error('[WorkflowTools] Error listing workflows:', error.message)
    return []
  }
}

/**
 * Force refresh workflow cache
 * Useful for development and testing
 */
export async function refreshWorkflowCache(): Promise<void> {
  await workflowDiscovery.clearCache()
  await workflowDiscovery.getAvailableWorkflows(true)
}
