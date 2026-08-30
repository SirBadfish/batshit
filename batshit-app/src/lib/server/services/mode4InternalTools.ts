import { isBrokerAvailable, type BrokerToolToggles } from '$lib/utils/brokerAvailability'

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

export const MODE4_INTERNAL_HELPERS_SUFFIX = 'mode4-controls'

export function isMode4InternalHelperTool(toolName: string | null | undefined): boolean {
  if (typeof toolName !== 'string') return false
  return MODE4_INTERNAL_HELPER_TOOL_SET.has(toolName.trim())
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

  if (settings.bashEnabled) {
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

export function buildMode4InternalHelpersGatewayId(agentId: string): string {
  return `${agentId}-${MODE4_INTERNAL_HELPERS_SUFFIX}`
}

export function buildMode4InternalHelpersGatewaySlug(agentSlugOrId: string): string {
  return `${agentSlugOrId}-${MODE4_INTERNAL_HELPERS_SUFFIX}`
}
