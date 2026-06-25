import {
  normalizeCompactTool,
  resolveToolActivitySettingsName,
  type ToolOperationKind,
  type ToolRendererFamily
} from '$lib/utils/toolActivityContract'

const slugify = (val?: string | null) =>
  (val || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const isNativePackWrapperName = (value?: string | null) => {
  const collapsed = (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
  return collapsed === 'batshittools' || collapsed === 'batshitnativetools'
}

const isSpecificOperationKind = (value: unknown): value is ToolOperationKind =>
  typeof value === 'string' && value.length > 0 && value !== 'unknown_tool'

const isSpecificRendererFamily = (value: unknown): value is ToolRendererFamily =>
  typeof value === 'string' && value.length > 0 && value !== 'generic_tool'

const displayLabels: Partial<Record<ToolOperationKind, string>> = {
  read_file: 'Read File',
  skill_read: 'Skill Read',
  write_file: 'Write File',
  edit_file: 'Edit File',
  web_search: 'Web Search',
  search_files: 'Search Files',
  list_files: 'List Files',
  bash: 'Bash',
  fetch_zip: 'Fetch Zip',
  dynamic_find: 'Dynamic Tool Search',
  dynamic_use: 'MCP Tool',
  tool_find: 'Dynamic Tool Search',
  cli_tool: 'CLI Tool',
  agent_browser_find: 'Dynamic Tool Search',
  agent_browser_use: 'Agent Browser Action',
  artifact_find: 'Dynamic Tool Search',
  artifact_use: 'Artifact Tool',
  fabric_find: 'Dynamic Tool Search',
  fabric_use: 'Fabric Control',
  subagent: 'Subagent'
}

function resolveDisplayName(
  parsed: any,
  effectiveToolName: string,
  operationKind?: ToolOperationKind
) {
  if (typeof parsed.displayToolName === 'string' && parsed.displayToolName.trim().length > 0) {
    return parsed.displayToolName
  }
  if (
    operationKind &&
    (operationKind === 'dynamic_use' ||
      operationKind === 'cli_tool' ||
      operationKind === 'artifact_use' ||
      operationKind === 'fabric_use' ||
      operationKind === 'agent_browser_use') &&
    effectiveToolName !== operationKind
  ) {
    return effectiveToolName
  }
  if (
    operationKind &&
    (effectiveToolName === operationKind || isNativePackWrapperName(parsed.toolName))
  ) {
    return displayLabels[operationKind]
  }
  return undefined
}

export function buildHydratedCoolToolStep(parsed: any) {
  const sourceToolName = parsed.toolName || parsed.tool || parsed.originalToolName || 'unknown'
  const compactInput = {
    toolName: sourceToolName,
    originalToolName: parsed.originalToolName || sourceToolName,
    toolArgs: parsed.toolArgs || parsed.input || {},
    toolResult: parsed.toolResult ?? parsed.output ?? parsed.result,
    metadata: parsed.metadata || {},
    isSubagent: parsed.isSubagent === true,
    toolProvider: parsed.toolProvider
  }
  const inferred = normalizeCompactTool(compactInput)
  const operationKind = isSpecificOperationKind(parsed.operationKind)
    ? parsed.operationKind
    : inferred.operationKind
  const rendererFamily = isSpecificRendererFamily(parsed.rendererFamily) ||
    (parsed.rendererFamily === 'generic_tool' && operationKind === 'unknown_tool')
      ? parsed.rendererFamily
      : inferred.rendererFamily
  const settingsIdentity =
    isSpecificOperationKind(operationKind)
      ? resolveToolActivitySettingsName(compactInput, operationKind)
      : undefined
  const usesSpecificRuntimeTool =
    operationKind === 'dynamic_use' ||
    operationKind === 'cli_tool' ||
    operationKind === 'artifact_use' ||
    operationKind === 'fabric_use' ||
    operationKind === 'agent_browser_use'
  const toolName =
    settingsIdentity && (isNativePackWrapperName(sourceToolName) || usesSpecificRuntimeTool)
      ? settingsIdentity
      : sourceToolName

  const isNativeTool = typeof toolName === 'string' && toolName.startsWith('native_')

  const explicitSubagentName = isNativeTool
    ? undefined
    : parsed.subagentName ||
      parsed.metadata?.subagentName ||
      parsed.toolArgs?.subagentName
  const explicitSubagentId = isNativeTool
    ? undefined
    : parsed.subagentId ||
      parsed.metadata?.subagentId ||
      parsed.toolArgs?.subagentId

  const isSubagent = isNativeTool
    ? false
    : parsed.isSubagent === true ||
      toolName === 'call_subagent' ||
      !!parsed.toolArgs?.Prompt__User_Message_ ||
      !!explicitSubagentName ||
      !!explicitSubagentId

  const subagentName = isSubagent ? (explicitSubagentName || toolName) : undefined
  const subagentId = isSubagent
    ? (explicitSubagentId || (subagentName ? slugify(subagentName) : slugify(toolName)))
    : undefined

  return {
    type: parsed.type || 'tool',
    toolName,
    displayToolName: parsed.displayToolName || inferred.displayToolName || resolveDisplayName(parsed, toolName, operationKind),
    originalToolName: parsed.originalToolName || sourceToolName,
    operationKind,
    rendererFamily,
    toolCallId: parsed.toolCallId,
    toolArgs: parsed.toolArgs || parsed.input || {},
    toolResult: parsed.toolResult ?? parsed.output ?? parsed.result,
    observation: parsed.toolResult ?? parsed.output ?? parsed.result,
    error: parsed.error,
    timestamp: parsed.timestamp,
    toolProvider: parsed.toolProvider,
    toolSource: parsed.toolSource,
    gatewayId: parsed.gatewayId,
    gatewayName: parsed.gatewayName,
    gatewayType: parsed.gatewayType,
    mcpServerName: parsed.mcpServerName,
    isSubagent,
    subagentName,
    subagentId,
    agentName: parsed.agentName,
    subagentAvatar: parsed.subagentAvatar,
    rawSidecar: parsed.rawSidecar,
    storage: parsed.storage,
    metadata: {
      ...(parsed.metadata || {}),
      ...(inferred.metadata || {}),
      ...(subagentName ? { subagentName } : {}),
      ...(subagentId ? { subagentId } : {}),
      ...(isSubagent ? { isSubagent: true } : {}),
      ...(parsed.toolProvider ? { toolProvider: parsed.toolProvider } : {}),
      ...(parsed.toolSource ? { toolSource: parsed.toolSource } : {}),
      ...(parsed.gatewayId ? { gatewayId: parsed.gatewayId } : {}),
      ...(parsed.gatewayName ? { gatewayName: parsed.gatewayName } : {}),
      ...(parsed.gatewayType ? { gatewayType: parsed.gatewayType } : {}),
      ...(parsed.subagentAvatar ? { subagentAvatar: parsed.subagentAvatar } : {}),
      ...(parsed.agentName ? { agentName: parsed.agentName } : {}),
      ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
      ...(operationKind ? { operationKind } : {}),
      ...(rendererFamily ? { rendererFamily } : {}),
      ...(parsed.rawSidecar?.zipId ? { rawSidecarZipId: parsed.rawSidecar.zipId } : {})
    }
  }
}
