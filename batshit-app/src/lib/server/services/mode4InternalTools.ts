import {
  isBrokerAvailable,
  resolveBrokerToolToggles,
  type BrokerToolToggles
} from '$lib/utils/brokerAvailability'
import {
  CLI_HELPER_MCP_SERVER_NAME,
  buildCliHelperMcpToolName
} from '$lib/utils/cliHelperToolNames'

/**
 * BL-5 — the helper bridge's MCP server name and full tool names, for the profile managers and
 * `ClaudeBridge`. The name is defined once, in `$lib/utils/cliHelperToolNames.ts`, because the
 * browser-side activity contract must recognize it too; import it from here on the server.
 */
export { CLI_HELPER_MCP_SERVER_NAME, buildCliHelperMcpToolName }

/**
 * BL-318 — the tool timeout both profile managers give the `batshit_helpers` server (Codex
 * `tool_timeout_sec`, Claude Code's per-server `timeout`). It must outlast the helper's own
 * longest wait (`CLI_HELPER_LONGEST_WAIT_MS` in `scripts/lib/cli-helper-waits.cjs`, an artifact
 * run: the longest artifact run limit plus 30 s), so a slow artifact run ends with the server's
 * own answer, never a CLI-side cut; Codex cut every helper call at 60 s without it. Pinned by
 * `cliHelperWaits.test.ts`.
 */
export const CLI_HELPER_TOOL_TIMEOUT_MS = 11 * 60_000

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

/**
 * BL-878 — does the managed CLI lane (a Codex or Claude Primary, a CLI Subagent, a Worker that
 * runs on the CLI lane) get Batshit's own Bash on top of the CLI's?
 *
 * No. Josh's rule (2026-09-28, 19:50 EDT): Codex and Claude agents have their own Bash; Batshit
 * does not give them its own as well. Agent Settings already says so (the Bash Tool switch is
 * off and greyed out for a CLI agent, "Use Claude/Codex built-in Bash Tool instead."). Before
 * this rule the shared resolver turned an absent Bash setting on, so every managed CLI run got
 * `batshit_server_bash_execute`, which runs under Batshit's Work mode and lists and not under
 * the CLI's own permission mode, and the user could not turn it off.
 *
 * This ONE constant is read in two places: `resolveEnabledMode4InternalHelperTools` (the helper
 * is not listed, so the profile managers and `ClaudeBridge` drop it with no change of their own,
 * and the full helper set still names it, so every deny list denies it) and
 * `dispatchNativeAutomationPackAction` (a `bash_execute` or a skill `script_run` that arrives on
 * the agent lane anyway is refused, because tool discovery is an authorization contract).
 * There is no setting, no environment variable, and no fallback. If Josh later picks "CLI
 * agents with only Batshit's tools" (BL-878 step 3), this rule changes, with its own plan.
 *
 * Typed `boolean` on purpose: it is a rule to be read, not a literal the compiler folds away.
 */
export const CLI_LANE_GETS_BATSHIT_BASH: boolean = false
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

export function isMode4InternalHelperTool(toolName: string | null | undefined): boolean {
  if (typeof toolName !== 'string') return false
  return MODE4_INTERNAL_HELPER_TOOL_SET.has(toolName.trim())
}

/** Snapshot what the managed CLI profile actually offers before minting its run credential. */
export function resolveManagedCliFetchZipAllowed(
  providerSettings: Record<string, any> | null | undefined,
  options: { configScope: 'managed' | 'global'; delegatedRun?: boolean }
): boolean {
  if (options.configScope !== 'managed' || options.delegatedRun === true) return false
  const toggles = resolveBrokerToolToggles(providerSettings ?? null)
  return resolveEnabledMode4InternalHelperTools(toggles)
    .includes(MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES[0])
}

export function resolveEnabledMode4InternalHelperTools(settings: {
  fetchZipEnabled?: boolean
  dynamicMcpEnabled?: boolean
  cliToolsEnabled?: boolean
  agentBrowserEnabled?: boolean
  bashEnabled?: boolean
  artifactRuntimeEnabled?: boolean
  batshitToolsEnabled?: boolean
}, options?: { hasCliTools?: boolean }): string[] {
  const enabled = new Set<string>()

  for (const toolName of MODE4_INTERNAL_SKILL_TOOL_NAMES) {
    enabled.add(toolName)
  }

  if (settings.fetchZipEnabled) {
    for (const toolName of MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES) {
      enabled.add(toolName)
    }
  }

  // BL-878: the CLI lane has its own Bash. The Bash setting decides nothing here unless the
  // named rule above allows Batshit's helper on this lane.
  if (CLI_LANE_GETS_BATSHIT_BASH && settings.bashEnabled) {
    for (const toolName of MODE4_INTERNAL_BASH_TOOL_NAMES) {
      enabled.add(toolName)
    }
  }

  // SA-096: the managed-CLI broker condition is shared with the compile path's guidance
  // gate. Rules live in $lib/utils/brokerAvailability — do not restate them here.
  const brokerToggles: BrokerToolToggles = {
    fetchZipEnabled: settings.fetchZipEnabled === true,
    dynamicMcpEnabled: settings.dynamicMcpEnabled === true,
    cliToolsEnabled: settings.cliToolsEnabled !== false,
    artifactRuntimeEnabled: settings.artifactRuntimeEnabled === true,
    batshitToolsEnabled: settings.batshitToolsEnabled === true,
    agentBrowserEnabled: settings.agentBrowserEnabled === true
  }

  if (
    isBrokerAvailable({
      runtime: 'cli',
      toggles: brokerToggles,
      hasCliTools: options?.hasCliTools === true
    })
  ) {
    for (const toolName of MODE4_INTERNAL_BATSHIT_TOOL_NAMES) {
      enabled.add(toolName)
    }
  }

  return Array.from(enabled)
}
