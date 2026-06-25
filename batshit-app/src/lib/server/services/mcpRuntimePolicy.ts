export const MCP_RUNTIME_EXECUTION_MODE = 'dynamic-only' as const
export const DYNAMIC_ONLY_SELECTION_RESET_VERSION = 'v1'
const DYNAMIC_ONLY_SELECTION_RESET_PREFIX = `batshit:mcp_dynamic_only_reset:${DYNAMIC_ONLY_SELECTION_RESET_VERSION}`

export const LEGACY_AGENT_MCP_SELECTION_FIELDS = [
  'defaultMCPToolSelections',
  'default_mcp_tool_selections'
] as const

export function buildDynamicOnlySelectionResetKey(userId: string): string {
  const normalized = typeof userId === 'string' ? userId.trim() : ''
  return `${DYNAMIC_ONLY_SELECTION_RESET_PREFIX}:${normalized}`
}
