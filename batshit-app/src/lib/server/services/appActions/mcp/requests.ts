import { parseManagedSettingsReportInput, parseManagedSettingsChangeInput } from '$lib/appActions/settings/managementInput'
import { MCP_CONFIGURATION_DOMAIN, MCP_CONFIGURATION_ID, isMcpReportId, type McpConfigurationChanges } from '$lib/appActions/settings/mcpConfiguration'
import { boundedMcpJson, invalidMcpInput, mcpObject, mcpRevision, mcpText } from './requestValidation'

// One parser-complete intent. No disconnected settingsIdentity/selection DTO
// can bypass the adopted browser-safe finite source/Primary/Zip contract.
export type McpReportRequest = ReturnType<typeof parseManagedSettingsReportInput>
export type McpChanges = McpConfigurationChanges
export type McpChangeRequest = Extract<ReturnType<typeof parseManagedSettingsChangeInput>, { op: 'change' }> & Readonly<{ semanticId: typeof MCP_CONFIGURATION_ID; changes: McpConfigurationChanges }>
/** The same four-ref Settings wire, never the retired six-ref/page/ISO envelope. */
export function parseMcpReportRequest(value: unknown): McpReportRequest {
  const parsed = parseManagedSettingsReportInput(value)
  if (parsed.domain !== MCP_CONFIGURATION_DOMAIN && !isMcpReportId(parsed.reportId)) return invalidMcpInput('INVALID_MCP_REPORT_OPERATION')
  return parsed
}
export function parseMcpChangeRequest(value: unknown) {
  const parsed = parseManagedSettingsChangeInput(value)
  if (parsed.op === 'change' && parsed.semanticId !== MCP_CONFIGURATION_ID) return invalidMcpInput('INVALID_MCP_CHANGE_OPERATION')
  return parsed
}
export function parseMcpUseRequest(value: unknown) {
  boundedMcpJson(value, 24_576)
  const row = mcpObject(value, ['op', 'semanticId', 'reportId', 'requestId', 'gatewayId', 'toolName', 'expectedSchemaRevision', 'arguments'],
    ['op', 'semanticId', 'reportId', 'requestId', 'gatewayId', 'toolName', 'expectedSchemaRevision', 'arguments'])
  if (row.op !== 'use' || row.semanticId !== 'mcp.tool.invoke') invalidMcpInput('INVALID_MCP_USE_OPERATION')
  const args = mcpObject(row.arguments, Object.keys(row.arguments && typeof row.arguments === 'object' ? row.arguments : {}))
  boundedMcpJson(args)
  return Object.freeze({ op: 'use' as const, semanticId: 'mcp.tool.invoke' as const, reportId: mcpText(row.reportId, 80), requestId: mcpText(row.requestId, 160),
    gatewayId: mcpText(row.gatewayId), toolName: mcpText(row.toolName, 256), expectedSchemaRevision: mcpRevision(row.expectedSchemaRevision), arguments: JSON.parse(JSON.stringify(args)) as Record<string, unknown> })
}
export function parseMcpOutcomeRequest(value: unknown) {
  const parsed = parseManagedSettingsChangeInput(value)
  if (parsed.op !== 'outcome' && parsed.op !== 'cancel') return invalidMcpInput('INVALID_MCP_OUTCOME_OPERATION')
  return parsed
}
