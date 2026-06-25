import { parseIconRef, type IconRef } from '$lib/icons/iconTypes'
import type { MCPGateway } from '$lib/types/database'

export interface ToolGridToolRow {
  id: string
  name: string
  description?: string
}

export interface ToolGridGroupRow {
  id: string
  name: string
  iconRef?: IconRef | null
  tools: ToolGridToolRow[]
}

export interface GatewayToolsResponse {
  mcps?: Array<{
    id?: string
    name?: string
    icon_ref?: IconRef | null
    tools?: Array<{
      id?: string
      name?: string
      description?: string
    }>
  }>
}

export function isHiddenInternalTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase()
  return (
    normalized.startsWith('mcp_fabric_') ||
    normalized.startsWith('batshit_server_dynamic_mcp_') ||
    normalized === 'batshit_server_fetch_zip'
  )
}

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.name.localeCompare(right.name))
}

function groupIdFromName(groupName: string): string {
  return groupName.toLowerCase().replace(/\s+/g, '-')
}

export function buildGatewayGroupsFromCache(gateway: MCPGateway): ToolGridGroupRow[] {
  const cachedToolNames = Array.isArray(gateway.discoveredTools)
    ? Array.from(
        new Set(
          gateway.discoveredTools
            .map((toolName) => (typeof toolName === 'string' ? toolName.trim() : ''))
            .filter((toolName) => toolName.length > 0 && !isHiddenInternalTool(toolName))
        )
      )
    : []

  const groupedTools = new Map<string, Set<string>>()
  const groupIcons = new Map<string, IconRef | null>()
  const assignedTools = new Set<string>()
  const rawGroupings = Array.isArray(gateway.toolGroupings) ? gateway.toolGroupings : []

  for (const grouping of rawGroupings) {
    const groupName = typeof grouping?.mcpName === 'string' ? grouping.mcpName.trim() : ''
    if (!groupName) continue
    groupIcons.set(groupName, parseIconRef(grouping.icon_ref))

    const toolIds = Array.isArray(grouping.toolIds)
      ? grouping.toolIds
          .map((toolId) => (typeof toolId === 'string' ? toolId.trim() : ''))
          .filter((toolId) => toolId.length > 0 && !isHiddenInternalTool(toolId))
      : []

    if (toolIds.length === 0) continue

    const current = groupedTools.get(groupName) ?? new Set<string>()
    for (const toolId of toolIds) {
      current.add(toolId)
      assignedTools.add(toolId)
    }
    groupedTools.set(groupName, current)
  }

  const groups: ToolGridGroupRow[] = Array.from(groupedTools.entries()).map(
    ([groupName, toolIds]) => ({
      id: groupIdFromName(groupName),
      name: groupName,
      iconRef: groupIcons.get(groupName) ?? null,
      tools: sortByName(Array.from(toolIds).map((toolName) => ({ id: toolName, name: toolName })))
    })
  )

  const ungroupedTools = cachedToolNames.filter((toolName) => !assignedTools.has(toolName))
  if (ungroupedTools.length > 0) {
    groups.push({
      id: 'ungrouped-tools',
      name: 'Ungrouped Tools',
      tools: sortByName(ungroupedTools.map((toolName) => ({ id: toolName, name: toolName })))
    })
  }

  return sortByName(groups)
}

export function buildGatewayGroupsFromToolsResponse(
  toolsPayload: GatewayToolsResponse
): ToolGridGroupRow[] {
  const rawGroups = Array.isArray(toolsPayload?.mcps) ? toolsPayload.mcps : []
  const groups: ToolGridGroupRow[] = []

  for (const rawGroup of rawGroups) {
    const groupName = (rawGroup?.name ?? '').trim()
    if (!groupName) continue
    const rawTools = Array.isArray(rawGroup.tools) ? rawGroup.tools : []

    const tools: ToolGridToolRow[] = []
    for (const tool of rawTools) {
      const toolName = (tool?.id ?? tool?.name ?? '').trim()
      if (!toolName || isHiddenInternalTool(toolName)) continue
      tools.push({
        id: toolName,
        name: toolName,
        description: tool.description ?? undefined
      })
    }

    if (tools.length === 0) continue

    groups.push({
      id:
        typeof rawGroup.id === 'string' && rawGroup.id.trim().length > 0
          ? rawGroup.id
          : groupIdFromName(groupName),
      name: groupName,
      iconRef: parseIconRef(rawGroup.icon_ref),
      tools: sortByName(tools)
    })
  }

  return sortByName(groups)
}

export function resolveGatewayToolGroups(
  gateway: MCPGateway,
  toolsPayload: GatewayToolsResponse
): ToolGridGroupRow[] {
  const liveGroups = buildGatewayGroupsFromToolsResponse(toolsPayload)
  return liveGroups.length > 0 ? liveGroups : buildGatewayGroupsFromCache(gateway)
}
