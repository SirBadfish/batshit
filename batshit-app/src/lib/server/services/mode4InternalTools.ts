/**
 * The names of the managed CLI helper tools, and the rules about them that outlive the helper
 * bridge (SA-139 R5 removed its last user, the Claude Code CLI Subagent, and the bridge itself).
 * API dynamic MCP still hides these names (`nativeToolConstants.ts`), because batshit-server's
 * own MCP serves them, and stored chats still name them.
 */

/**
 * Delegation limits (2026-10-24) — a tool timeout Claude Code must never reach first: the Claude
 * plan run's `MCP_TOOL_TIMEOUT` (`claudePlanRun.ts`), where a Batshit tool call can be a Subagent
 * or Worker run with no time limit unless its Subagent sets one. Seven days is past any run and
 * inside what Node's `setTimeout` can hold (2^31 - 1 ms, about 24.8 days; a longer value fires at
 * once). SA-139 R4 removed its first user, the CLI Primary's Subagent bridge.
 */
export const DELEGATION_BRIDGE_TOOL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

export const MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES = ['batshit_server_fetch_zip'] as const
export const MODE4_INTERNAL_BATSHIT_TOOL_NAMES = [
  'batshit_tool_search',
  'batshit_tool_use'
] as const
export const MODE4_INTERNAL_DYNAMIC_MCP_TOOL_NAMES = [
  'batshit_server_dynamic_mcp_find',
  'batshit_server_dynamic_mcp_use'
] as const
export const MODE4_INTERNAL_CLI_TOOL_NAMES = [
  'batshit_server_cli_tool_find',
  'batshit_server_cli_tool_use'
] as const
export const MODE4_INTERNAL_AGENT_BROWSER_TOOL_NAMES = [
  'batshit_server_agent_browser_find',
  'batshit_server_agent_browser_use'
] as const
export const MODE4_INTERNAL_BASH_TOOL_NAMES = ['batshit_server_bash_execute'] as const

export const MODE4_INTERNAL_SKILL_TOOL_NAMES = ['native_skill'] as const
export const MODE4_INTERNAL_ARTIFACT_TOOL_NAMES = [
  'mcp_artifact_find',
  'mcp_artifact_use'
] as const
export const MODE4_INTERNAL_CONTROL_TOOL_NAMES = [
  'mcp_fabric_find',
  'mcp_fabric_use'
] as const

export const MODE4_INTERNAL_HELPER_TOOL_NAMES = [
  ...MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES,
  ...MODE4_INTERNAL_BATSHIT_TOOL_NAMES,
  ...MODE4_INTERNAL_DYNAMIC_MCP_TOOL_NAMES,
  ...MODE4_INTERNAL_CLI_TOOL_NAMES,
  ...MODE4_INTERNAL_AGENT_BROWSER_TOOL_NAMES,
  ...MODE4_INTERNAL_BASH_TOOL_NAMES,
  ...MODE4_INTERNAL_SKILL_TOOL_NAMES,
  ...MODE4_INTERNAL_ARTIFACT_TOOL_NAMES,
  ...MODE4_INTERNAL_CONTROL_TOOL_NAMES
] as const

export const MODE4_INTERNAL_HELPER_TOOL_SET = new Set<string>(MODE4_INTERNAL_HELPER_TOOL_NAMES)
