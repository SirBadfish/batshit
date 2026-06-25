import { formatToolDisplayName } from '$lib/utils/toolNameFormatter'
import { normalizeCompactTool } from '$lib/utils/toolActivityContract'

export type ToolActivitySummaryStatus = 'success' | 'error' | 'loading'

export type ToolActivityGroup = {
  id: string
  items: Array<{ segment: any; index: number }>
  summary: Array<{ label: string; status: ToolActivitySummaryStatus }>
}

export function isToolActivitySegment(segment: any): boolean {
  return segment?.type === 'cool_tool' || (segment?.type === 'batshit' && segment?.zipType === 'cool_tool')
}

function getNormalizedZipId(rawZipId: string): string {
  return rawZipId.replace(/-cool_tool-\d+$/, '-cool_tool-0')
}

function inferNormalizedPayload(segment: any, payload: any) {
  const toolName =
    payload?.toolName ||
    payload?.originalToolName ||
    segment?.toolName ||
    segment?.name

  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null
  }

  const normalized = normalizeCompactTool({
    toolName,
    originalToolName: payload?.originalToolName,
    toolArgs:
      payload?.toolArgs ||
      payload?.toolInput ||
      payload?.input ||
      segment?.toolData?.toolArgs ||
      segment?.toolData?.toolInput ||
      segment?.intermediateStep?.toolArgs ||
      segment?.intermediateStep?.toolInput ||
      {},
    toolResult:
      payload?.toolResult ??
      payload?.observation ??
      payload?.output ??
      payload?.result ??
      segment?.toolData?.toolResult ??
      segment?.intermediateStep?.toolResult ??
      segment?.intermediateStep?.observation,
    metadata: payload?.metadata || segment?.metadata,
    isSubagent: payload?.isSubagent === true || segment?.isSubagent === true,
    toolProvider: payload?.toolProvider || segment?.toolProvider
  })

  return {
    ...payload,
    operationKind: normalized.operationKind,
    rendererFamily: normalized.rendererFamily
  }
}

function hasSpecificNormalizedIdentity(payload: any): boolean {
  if (!payload) return false
  return (
    (typeof payload.rendererFamily === 'string' && payload.rendererFamily !== 'generic_tool') ||
    (typeof payload.operationKind === 'string' && payload.operationKind !== 'unknown_tool')
  )
}

function resolveToolActivityPayload(segment: any, coolToolFromZip?: Map<string, any>) {
  const inlinePayload =
    segment?.toolData ||
    segment?.intermediateStep

  if (hasSpecificNormalizedIdentity(inlinePayload) || inlinePayload?.error) {
    return inlinePayload
  }

  const inferredInlinePayload = inferNormalizedPayload(segment, inlinePayload)
  if (hasSpecificNormalizedIdentity(inferredInlinePayload)) {
    return inferredInlinePayload
  }

  if (!(coolToolFromZip instanceof Map)) return null

  const rawZipId =
    typeof segment?.zipId === 'string'
      ? segment.zipId
      : typeof segment?.id === 'string'
        ? segment.id
        : ''

  if (!rawZipId) return null

  const normalizedZipId = getNormalizedZipId(rawZipId)
  const hydratedPayload = coolToolFromZip.get(rawZipId) || coolToolFromZip.get(normalizedZipId) || null
  if (hasSpecificNormalizedIdentity(hydratedPayload) || hydratedPayload?.error) {
    return hydratedPayload
  }

  const inferredHydratedPayload = inferNormalizedPayload(segment, hydratedPayload)
  return hasSpecificNormalizedIdentity(inferredHydratedPayload) ? inferredHydratedPayload : null
}

function shortToolTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed
}

function formatUseActionLabel(payload: any): string | null {
  const operationKind = payload?.operationKind
  const family =
    operationKind === 'dynamic_use'
      ? 'MCP'
      : operationKind === 'cli_tool'
        ? 'CLI'
        : operationKind === 'artifact_use'
          ? 'Artifact'
          : operationKind === 'fabric_use'
            ? 'Fabric'
            : operationKind === 'agent_browser_use'
              ? 'Agent Browser'
              : null

  if (!family) return null

  const explicitDisplayName =
    shortToolTarget(payload?.displayToolName) ||
    shortToolTarget(payload?.metadata?.rendererTitle)
  if (explicitDisplayName) {
    return explicitDisplayName
  }

  const target =
    shortToolTarget(payload?.toolName) ||
    shortToolTarget(payload?.toolArgs?.target) ||
    shortToolTarget(payload?.toolArgs?.toolName) ||
    shortToolTarget(payload?.toolArgs?.toolId) ||
    shortToolTarget(payload?.toolArgs?.ref) ||
    shortToolTarget(payload?.toolResult?.target) ||
    shortToolTarget(payload?.toolResult?.toolId) ||
    shortToolTarget(payload?.toolResult?.toolName)

  if (!target || target === operationKind) return family
  const formattedTarget = formatToolDisplayName(target)
  if (formattedTarget !== target) return formattedTarget
  return `${family}: ${target}`
}

export function formatToolActivityLabel(segment: any, coolToolFromZip?: Map<string, any>): string {
  const payload = resolveToolActivityPayload(segment, coolToolFromZip)
  const useActionLabel = formatUseActionLabel(payload)
  if (useActionLabel) return useActionLabel

  const raw =
    payload?.rendererFamily ||
    payload?.operationKind ||
    segment?.toolName ||
    segment?.name ||
    'tool'

  const labelKey = String(raw)
  if (labelKey === 'bash') return 'Bash'
  if (labelKey === 'skill_read') return 'Skill Read'
  if (labelKey === 'web_search') return 'Web Search'
  if (labelKey === 'dynamic_find') return 'Dynamic Tool Search'
  if (labelKey === 'generic_tool') return 'Tool'
  return formatToolDisplayName(labelKey)
}

function formatToolActivityStatus(segment: any, coolToolFromZip?: Map<string, any>): ToolActivitySummaryStatus {
  const payload = resolveToolActivityPayload(segment, coolToolFromZip)

  if (segment?.isPending) return 'loading'
  if (payload?.error || segment?.toolData?.error || segment?.intermediateStep?.error) return 'error'
  return 'success'
}

export function buildToolActivityGroups(
  segments: any[],
  messageId: string,
  coolToolFromZip?: Map<string, any>
) {
  const groups = new Map<number, ToolActivityGroup>()
  const continuations = new Set<number>()

  let index = 0
  while (index < segments.length) {
    const segment = segments[index]
    if (!isToolActivitySegment(segment)) {
      index += 1
      continue
    }

    const items: Array<{ segment: any; index: number }> = []
    const summary: Array<{ label: string; status: ToolActivitySummaryStatus }> = []
    let cursor = index

    while (cursor < segments.length && isToolActivitySegment(segments[cursor])) {
      const item = segments[cursor]
      items.push({ segment: item, index: cursor })
      summary.push({
        label: formatToolActivityLabel(item, coolToolFromZip),
        status: formatToolActivityStatus(item, coolToolFromZip)
      })
      if (cursor > index) continuations.add(cursor)
      cursor += 1
    }

    const first = items[0]?.segment
    groups.set(index, {
      id: `${messageId || 'message'}-tool-group-${index}-${first?.zipId || first?.id || first?.toolId || 'tool'}`,
      items,
      summary
    })
    index = cursor
  }

  return { groups, continuations }
}
