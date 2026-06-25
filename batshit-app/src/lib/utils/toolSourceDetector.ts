/**
 * Tool Source Detection Service
 *
 * Identifies where tools came from (batshit-server, MCP gateways, n8n workflows, subagents)
 * to enable proper renderer routing in the Cool Tools system.
 *
 * CRITICAL: Detection priority order MUST be maintained exactly as documented below.
 * Wrong priority order → wrong renderer → complete UI failure for affected tools.
 */

import type { IntermediateStep, ToolProvider, ToolSource, ToolSourceDetectionResult } from './toolStepTypes'
import { sanitizeToolNameForComparison } from './toolNameNormalization'
export type { ToolProvider, ToolSource, ToolSourceDetectionResult } from './toolStepTypes'

/**
 * List of batshit-server tool names
 * These tools are provided by Batshit-Server and always use the `batshit_server_` prefix
 */
const BATSHIT_SERVER_TOOL_NAMES = [
  'batshit_server_read_file',
  'batshit_server_overwrite_file',
  'batshit_server_edit_file',
  'batshit_server_list_files',
  'batshit_server_search_files',
  'batshit_server_execute_command'
] as const

const BATSHIT_SERVER_TOOL_NAME_SET = new Set(BATSHIT_SERVER_TOOL_NAMES.map((name) => name.toLowerCase()))
const BATSHIT_SERVER_BASE_NAME_SET = new Set(
  BATSHIT_SERVER_TOOL_NAMES.map((name) => name.toLowerCase().replace(/^batshit_server_/, ''))
)

const PROVIDER_NATIVE_TOOL_NAMES = new Set([
  'image_generation',
  'web_search',
  'web_search_preview',
  'file_search',
  'code_interpreter',
  'computer_use'
])

function isBatshitServerToolName(toolName: string | undefined): boolean {
  if (!toolName) return false

  const { sanitized, lower } = sanitizeToolNameForComparison(toolName)

  if (BATSHIT_SERVER_TOOL_NAME_SET.has(lower)) {
    // Allow camelCase "batshit_server_" prefix regardless of gateway casing.
    return true
  }

  const markerIndex = lower.lastIndexOf('batshit_server_')
  if (markerIndex >= 0) {
    const suffixLower = lower.slice(markerIndex + 'batshit_server_'.length)
    if (BATSHIT_SERVER_BASE_NAME_SET.has(suffixLower)) {
      const suffix = sanitized.slice(sanitized.length - suffixLower.length)
      if (suffix === suffixLower) {
        return true
      }
    }
  }

  return false
}

function isBatshitServerBaseName(toolName: string | undefined): boolean {
  if (!toolName) return false

  const { lower } = sanitizeToolNameForComparison(toolName)
  return BATSHIT_SERVER_BASE_NAME_SET.has(lower)
}

function isNativeTool(step: IntermediateStep): boolean {
  const current = typeof step.toolName === 'string' ? step.toolName.toLowerCase() : ''
  const original = typeof step.originalToolName === 'string' ? step.originalToolName.toLowerCase() : ''
  return current.startsWith('native_') || original.startsWith('native_')
}

/**
 * Detect tool source from IntermediateStep metadata
 *
 * CRITICAL: This function checks conditions in a specific priority order.
 * DO NOT reorder these checks without understanding the implications!
 *
 * Priority Order (Story 6.7b - SOURCE-FIRST):
 * 1. Explicit metadata (if present, trust it)
 * 2. Native Batshit tools
 * 3. Subagent detection (special execution context)
 * 4. batshit-server tools (by name pattern - exact or partial match)
 * 5. MCP tools (by gateway metadata)
 * 6. Workflow tools (by webhookUrl pattern)
 * 7. Fallback (unknown)
 *
 * @param step - IntermediateStep from tool execution
 * @returns Detection result with toolProvider, toolSource, and isSubagent
 */
export function detectToolSource(step: IntermediateStep): ToolSourceDetectionResult {
  // PRIORITY 1: Trust explicit metadata if present
  if (step.toolProvider && step.toolSource) {
    return {
      toolProvider: step.toolProvider as ToolProvider,
      toolSource: step.toolSource as ToolSource,
      isSubagent: step.isSubagent ?? false
    }
  }

  // PRIORITY 2: Detect Batshit native tools
  if (isNativeTool(step)) {
    return {
      toolProvider: 'batshit-server',
      toolSource: 'native-tool',
      isSubagent: false
    }
  }

  // PRIORITY 3: Detect subagent
  if (
    step.toolName === 'call_subagent' ||
    step.isSubagent === true ||
    (step.toolArgs && 'Prompt__User_Message_' in step.toolArgs)
  ) {
    return {
      toolProvider: 'subagent',
      toolSource: (step.toolSource as ToolSource) || 'unknown',
      isSubagent: true
    }
  }

  // PRIORITY 4: Detect batshit-server tools (by name pattern)
  const hasWorkflowMarkers = Boolean(step.toolArgs?.webhookUrl || step.toolArgs?.workflowId)
  const hasGatewayMarkers = Boolean(step.gatewayId || step.gatewayName)
  const isBatshitServerTool =
    isBatshitServerToolName(step.toolName) ||
    (isBatshitServerBaseName(step.toolName) && !hasWorkflowMarkers && !hasGatewayMarkers && step.toolSource !== 'workflow')

  if (isBatshitServerTool) {
    return {
      toolProvider: 'batshit-server',
      toolSource: step.toolSource || 'direct-attachment',
      isSubagent: false
    }
  }

  // PRIORITY 5: Detect MCP tools (by gateway metadata)
  // Any tool with gateway metadata is from an MCP gateway
  // Covers both Docker gateways and n8n MCP Trigger gateways
  if (step.gatewayId || step.gatewayName) {
    return {
      toolProvider: 'mcp',
      toolSource: 'mcp-gateway',
      isSubagent: false
    }
  }

  // PRIORITY 6: Detect Workflow tools (by webhook pattern)
  // Workflows have webhookUrl in args or workflowId in metadata
  if (step.toolArgs?.webhookUrl || step.toolArgs?.workflowId) {
    return {
      toolProvider: 'n8n-workflow',
      toolSource: 'workflow',
      isSubagent: false
    }
  }

  // PRIORITY 7: Detect provider-native tools (LLM built-ins)
  if (typeof step.toolName === 'string') {
    const normalized = step.toolName.toLowerCase()
    if (PROVIDER_NATIVE_TOOL_NAMES.has(normalized)) {
      return {
        toolProvider: 'llm-native',
        toolSource: 'provider-native',
        isSubagent: false
      }
    }
  }

  // PRIORITY 8: Fallback (unknown)
  // Graceful fallback for unrecognized tools
  // Never throw errors on unknown tools - just mark as unknown
  return {
    toolProvider: 'unknown',
    toolSource: 'unknown',
    isSubagent: false
  }
}
