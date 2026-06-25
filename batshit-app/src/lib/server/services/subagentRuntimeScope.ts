import { redis } from '$lib/server/redis'
import type { AgentDcmDisplaySettings, MCPToolSelections, SubagentRow } from '$lib/types/database'
import { buildSkillsCommandsDcmLines, getEnabledAgentSlashCapabilities } from '$lib/server/services/slashCommandCapabilities'
import { findControls } from '$lib/server/services/fabricRegistry'
import {
  buildDynamicMcpIndex,
  normalizeDcmDisplaySettings,
} from '$lib/server/services/dynamicMcpIndex'
import { resolveDynamicMcpGatewayScope } from '$lib/server/services/mcpSelectionResolver'
import { resolveCliToolSelectionScope } from '$lib/server/services/cliToolRegistry'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import { isApiSubagentType, normalizeSubagentType, type SubagentType } from '$lib/utils/subagentType'

const ARTIFACT_DCM_ALLOWED_CONTROL_IDS = ['use.artifact.*'] as const

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

async function buildSubagentArtifactLines(options: {
  userId: string
  subagentId: string
}): Promise<string[]> {
  const result = await findControls({
    userId: options.userId,
    agentId: options.subagentId,
    sourceType: 'artifact',
    query: 'artifact',
    runtimeMode: 'mode3',
    allowedControlIds: Array.from(ARTIFACT_DCM_ALLOWED_CONTROL_IDS),
    limit: 200,
    includeSchema: false,
  })

  const typedInvokeAliases = result.results.filter((entry) =>
    entry.controlId.startsWith('use.artifact.'),
  )

  if (typedInvokeAliases.length === 0) return []

  const lines: string[] = ['', 'artifacts:']
  const sortedArtifacts = [...typedInvokeAliases].sort((a, b) =>
    a.controlId.localeCompare(b.controlId),
  )
  for (const control of sortedArtifacts) {
    const hint = control.schemaHint ? ` — fields: ${control.schemaHint}` : ''
    lines.push(`- ${control.controlId}${hint}`)
  }
  lines.push(
    'artifact_hint: use.artifact.{slug} entries accept structured field inputs through Batshit Tool Use. Only discovered use.artifact entries are agent-runnable; user-only panel artifacts such as Gradio/HuggingFace embeds and ComfyUI panel artifacts are not. Do not change an artifact brain type or power source to force agent use.',
  )

  return lines
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
    subagentType: normalizeSubagentType(options.subagent, options.subagent.subagentType),
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
}): Promise<string> {
  const scope = await resolveManagedSubagentScope(options)
  const lines: string[] = []

  if (scope.projectPath) {
    lines.push(`project_path: ${scope.projectPath}`)
  } else {
    lines.push('project_path: (not set)')
  }

  const mcpIndex = await buildDynamicMcpIndex({
    userId: options.userId,
    toolSelections: scope.defaultMcpToolSelections,
    selectedGateways: scope.resolvedGateways,
    selectedCliToolIds: scope.resolvedCliToolIds,
    nativeDynamicMcpEnabled: scope.nativeToolSettings.dynamicMcpEnabled,
    cliToolsEnabled: scope.nativeToolSettings.cliToolsEnabled,
    dcmDisplaySettings: scope.dcmDisplaySettings,
  })
  if (mcpIndex.text.trim()) {
    lines.push('', mcpIndex.text.trim())
  }

  const capabilities = await getEnabledAgentSlashCapabilities(options.userId, options.subagent.id)
  const skillsLines = buildSkillsCommandsDcmLines(capabilities)
  if (skillsLines.length > 0) {
    lines.push('', ...skillsLines)
  }

  if (
    isApiSubagentType(scope.subagentType) &&
    scope.nativeToolSettings.artifactRuntimeEnabled
  ) {
    const artifactLines = await buildSubagentArtifactLines({
      userId: options.userId,
      subagentId: options.subagent.id,
    })
    if (artifactLines.length > 0) {
      lines.push(...artifactLines)
    }
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
