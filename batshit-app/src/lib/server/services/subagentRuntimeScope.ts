import { redis } from '$lib/server/redis'
import type { AgentDcmDisplaySettings, MCPToolSelections, SubagentRow } from '$lib/types/database'
import {
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities,
  type AgentSlashCapability
} from '$lib/server/services/slashCommandCapabilities'
import {
  buildDynamicMcpIndex,
  normalizeDcmDisplaySettings,
} from '$lib/server/services/dynamicMcpIndex'
import { resolveDynamicMcpGatewayScope } from '$lib/server/services/mcpSelectionResolver'
import { resolveCliToolSelectionScope } from '$lib/server/services/cliToolRegistry'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import {
  isApiSubagentType,
  isN8nSubnodeSubagentType,
  normalizeSubagentType,
  type SubagentType,
} from '$lib/utils/subagentType'

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return Array.from(new Set(normalized))
}

function normalizeToolSelections(value: unknown): MCPToolSelections | null {
  if (!Array.isArray(value)) return null
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function resolveSubagentDcmDisplaySettings(subagent: SubagentRow): AgentDcmDisplaySettings {
  const raw =
    subagent.dcmDisplaySettings ??
    (subagent as Record<string, any>).dcm_display_settings ??
    null
  return normalizeDcmDisplaySettings(raw)
}

async function resolveSessionProjectPath(
  sessionId?: string | null,
): Promise<string | null> {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalized) return null
  const session = await redis.getSession(normalized).catch(() => null)
  const metadata =
    session?.metadata && typeof session.metadata === 'object' ? session.metadata : null
  const projectPath = typeof metadata?.projectPath === 'string' ? metadata.projectPath.trim() : ''
  return projectPath || null
}

export interface SubagentResolvedScope {
  subagentType: SubagentType
  nativeToolSettings: ReturnType<typeof resolveNativeToolSettings>
  defaultMcpGateways: string[] | null
  resolvedGateways: string[]
  defaultCliToolIds: string[] | null
  resolvedCliToolIds: string[]
  defaultMcpToolSelections: MCPToolSelections | null
  dcmDisplaySettings: AgentDcmDisplaySettings
  projectPath: string | null
}

export async function resolveManagedSubagentScope(options: {
  userId: string
  subagent: SubagentRow
  sessionId?: string | null
  projectPath?: string | null
}): Promise<SubagentResolvedScope> {
  const subagentType = normalizeSubagentType(options.subagent, options.subagent.subagentType)
  if (isN8nSubnodeSubagentType(subagentType)) {
    throw new Error(
      'n8n Subnode Subagents were removed from Batshit. Delete this record from Agent Settings.'
    )
  }
  const defaultMcpGateways =
    normalizeStringArray(options.subagent.defaultMCPGateways) ??
    normalizeStringArray((options.subagent as Record<string, any>).default_mcp_gateways)
  const defaultMcpToolSelections =
    normalizeToolSelections(options.subagent.defaultMCPToolSelections) ??
    normalizeToolSelections((options.subagent as Record<string, any>).default_mcp_tool_selections)
  const defaultCliToolIds =
    normalizeStringArray(options.subagent.defaultTools) ??
    normalizeStringArray((options.subagent as Record<string, any>).default_tools)

  const gatewayScope = await resolveDynamicMcpGatewayScope({
    userId: options.userId,
    agentMetadata: {
      defaultMCPGateways: defaultMcpGateways ?? undefined,
    },
  })

  const cliScope = await resolveCliToolSelectionScope({
    userId: options.userId,
    agentMetadata: {
      defaultTools: defaultCliToolIds ?? undefined,
    },
  })

  const explicitProjectPath =
    typeof options.projectPath === 'string' ? options.projectPath.trim() : ''
  const inheritedProjectPath =
    explicitProjectPath.length > 0
      ? explicitProjectPath
      : (await resolveSessionProjectPath(options.sessionId)) ?? null

  return {
    subagentType,
    nativeToolSettings: resolveNativeToolSettings(
      options.subagent.provider_specific_settings ?? null,
    ),
    defaultMcpGateways,
    resolvedGateways: gatewayScope.resolvedGateways,
    defaultCliToolIds,
    resolvedCliToolIds: cliScope.toolIds,
    defaultMcpToolSelections,
    dcmDisplaySettings: resolveSubagentDcmDisplaySettings(options.subagent),
    projectPath: inheritedProjectPath,
  }
}

export async function buildManagedSubagentDynamicInfo(options: {
  userId: string
  subagent: SubagentRow
  sessionId?: string | null
  projectPath?: string | null
  /**
   * SA-111 P1: the canonical compiler resolves the scope and the slash capabilities once
   * per subagent per compile and passes them in, so building the DCM roster's capability
   * line costs no extra Redis work (DL-111-03: "cached per compile").
   */
  scope?: SubagentResolvedScope
  capabilities?: AgentSlashCapability[]
}): Promise<string> {
  const scope = options.scope ?? (await resolveManagedSubagentScope(options))
  const lines: string[] = []

  if (scope.projectPath) {
    lines.push(`project_path: ${scope.projectPath}`)
  } else {
    lines.push('project_path: (not set)')
  }

  // SA-096 P4: the capability index now covers Fabric and published artifact runtime tools
  // as well, so the subagent's own artifact block is gone. Subagents keep artifact runtime
  // but never the Fabric control plane (SA-064), which `allowFabricControlTools` expresses.
  const mcpIndex = await buildDynamicMcpIndex({
    userId: options.userId,
    controlAgentId: options.subagent.id,
    toolSelections: scope.defaultMcpToolSelections,
    selectedGateways: scope.resolvedGateways,
    selectedCliToolIds: scope.resolvedCliToolIds,
    nativeDynamicMcpEnabled: scope.nativeToolSettings.dynamicMcpEnabled,
    cliToolsEnabled: scope.nativeToolSettings.cliToolsEnabled,
    dcmDisplaySettings: scope.dcmDisplaySettings,
    runtime: isApiSubagentType(scope.subagentType) ? 'api' : 'cli',
    brokerToggles: {
      fetchZipEnabled: scope.nativeToolSettings.fetchZipEnabled,
      dynamicMcpEnabled: scope.nativeToolSettings.dynamicMcpEnabled,
      cliToolsEnabled: scope.nativeToolSettings.cliToolsEnabled,
      artifactRuntimeEnabled: scope.nativeToolSettings.artifactRuntimeEnabled,
      batshitToolsEnabled: scope.nativeToolSettings.batshitToolsEnabled,
      agentBrowserEnabled: scope.nativeToolSettings.agentBrowserEnabled,
    },
    allowFabricControlTools: false,
    // SA-104 P3: memory tools are PA-only in v1 (deferred subagent-memory decision).
    memoryControlsEnabled: false,
  })
  if (mcpIndex.text.trim()) {
    lines.push('', mcpIndex.text.trim())
  }

  const capabilities =
    options.capabilities ??
    (await getEnabledAgentSlashCapabilities(options.userId, options.subagent.id))
  const skillsLines = buildSkillsCommandsDcmLines(capabilities)
  if (skillsLines.length > 0) {
    lines.push('', ...skillsLines)
  }

  const content = lines.filter((line, index, all) => {
    if (line.length > 0) return true
    return index > 0 && index < all.length - 1 && all[index - 1].length > 0 && all[index + 1].length > 0
  })

  if (content.length === 0) return ''
  return `==== DYNAMIC INFO (ephemeral - not stored) ====\n${content.join('\n')}`
}

export function appendManagedSubagentDynamicInfo(
  systemPrompt: string,
  dynamicInfo: string,
): string {
  const trimmed = dynamicInfo.trim()
  if (!trimmed) return systemPrompt
  return systemPrompt ? `${systemPrompt}\n\n${trimmed}` : trimmed
}
