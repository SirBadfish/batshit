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
  DELEGATED_RUN_BROKER_SCOPE,
  resolveDelegatedRunBrokerInputs,
} from '$lib/utils/brokerAvailability'
import {
  isCliSubagentType,
  isN8nSubnodeSubagentType,
  normalizeSubagentType,
  type SubagentType,
} from '$lib/utils/subagentType'
import { buildCliSubagentProviderSettings } from '$lib/server/services/cliSubagentProfile'
import { COMPILED_TAG, compiledElement } from '$lib/utils/compiledChatTags'

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
    // BL-81 follow-up: a CLI Subagent or Worker runs with its CLI profile's settings (Fetch Zip
    // and Batshit Tools off), so its DCM index and its credential's control list are built from
    // those, the same settings its helper gets. An API Subagent keeps its own toggles.
    nativeToolSettings: resolveNativeToolSettings(
      isCliSubagentType(subagentType)
        ? buildCliSubagentProviderSettings(options.subagent)
        : options.subagent.provider_specific_settings ?? null,
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
   * A caller that has already resolved the scope or the slash capabilities can pass them in,
   * so they are not read twice. (The chat compiler no longer builds a subagent's
   * `<dynamic_info>`: it resolves only the roster facts, 2026-09-18.)
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
  // but never the Fabric control plane (SA-064), nor memory (SA-104, a deferred decision), DMs
  // (SA-113: no inbox, no identity), schedules (SA-115: nothing that outlives the run) or the
  // judgment tool (SA-120: the primary decides). `DELEGATED_RUN_BROKER_SCOPE` holds all six.
  //
  // BL-81: the runtime, the toggles and the flags come from the same two definitions the
  // delegated control scope is minted from (`resolveDelegatedRunAllowedControlIds`), so the
  // tools this index offers are exactly the tools a CLI run's credential allows.
  const brokerInputs = resolveDelegatedRunBrokerInputs(scope)
  const mcpIndex = await buildDynamicMcpIndex({
    userId: options.userId,
    controlAgentId: options.subagent.id,
    toolSelections: scope.defaultMcpToolSelections,
    selectedGateways: scope.resolvedGateways,
    selectedCliToolIds: scope.resolvedCliToolIds,
    nativeDynamicMcpEnabled: scope.nativeToolSettings.dynamicMcpEnabled,
    cliToolsEnabled: scope.nativeToolSettings.cliToolsEnabled,
    dcmDisplaySettings: scope.dcmDisplaySettings,
    runtime: brokerInputs.runtime,
    brokerToggles: brokerInputs.toggles,
    ...DELEGATED_RUN_BROKER_SCOPE,
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
  // BL-225: the same `<dynamic_info>` element a primary's DCM is (SA-128), through the one
  // builder that disarms this grammar's tags inside the lines.
  return compiledElement(COMPILED_TAG.dynamicInfo, content.join('\n'))
}

export function appendManagedSubagentDynamicInfo(
  systemPrompt: string,
  dynamicInfo: string,
): string {
  const trimmed = dynamicInfo.trim()
  if (!trimmed) return systemPrompt
  return systemPrompt ? `${systemPrompt}\n\n${trimmed}` : trimmed
}
