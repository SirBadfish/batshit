/**
 * BL-5 — the MCP server name every managed CLI profile gives Batshit's helper bridge
 * (`scripts/mode4-controls-mcp.cjs`), owned here once.
 *
 * A CLI shows the model an MCP tool as `mcp__<server>__<tool>`. Codex first turns every
 * character outside [A-Za-z0-9_] into `_`, and codex-cli 0.139.0 through 0.148.0 cap the
 * result at 64 bytes (0.149.0 raised it to 128): anything longer becomes a truncated head plus
 * a hash, so the model never sees the name Batshit's prompt teaches it. The old per-agent name
 * `batshit_gateway_<agent>-mode4-controls` hashed `batshit_server_bash_execute` and
 * `batshit_server_fetch_zip` for every agent, `batshit_tool_search` for an agent id over 7
 * characters, and every helper for an id over 14 and in most CLI Subagent and Worker profiles
 * (measured live on codex-cli 0.139.0, 2026-09-22). One profile is one agent and this is its
 * only helper server, so the name needs no agent in it. Fixed, it keeps the longest helper
 * (`batshit_server_agent_browser_find`) at 55 bytes for every agent, and with no hyphen Codex
 * and Claude Code show the same string.
 *
 * Browser-safe on purpose: the activity contract, which the chat page runs, recognizes the
 * name too. Server code reaches it through `mode4InternalTools.ts`, which re-exports it.
 */
export const CLI_HELPER_MCP_SERVER_NAME = 'batshit_helpers'

/** The full name a CLI shows for one helper tool: `mcp__batshit_helpers__<tool>`. */
export function buildCliHelperMcpToolName(toolName: string): string {
  return `mcp__${CLI_HELPER_MCP_SERVER_NAME}__${toolName}`
}

/**
 * Chats stored before BL-5 name the helper server per agent: `batshit_gateway_<agent>-mode4-controls`,
 * and before that `<agent>-mode4-controls`. They must keep resolving the way they always did,
 * so any server whose letters and digits contain this marker is the helper server too.
 */
const LEGACY_CLI_HELPER_SERVER_MARKER = 'mode4controls'

/** True for the helper bridge's server, as a CLI step names it (`mcp.<server>.<tool>`). */
export function isCliHelperMcpServerName(serverName: string | null | undefined): boolean {
  const normalized = typeof serverName === 'string' ? serverName.trim().toLowerCase() : ''
  if (!normalized) return false
  if (normalized === CLI_HELPER_MCP_SERVER_NAME) return true
  return normalized.replace(/[^a-z0-9]+/g, '').includes(LEGACY_CLI_HELPER_SERVER_MARKER)
}
