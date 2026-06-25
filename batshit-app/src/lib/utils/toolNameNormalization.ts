export function normalizeToolNameLower(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function slugToolName(value: string | null | undefined): string {
  return normalizeToolNameLower(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function slugToolNamePreservingHyphen(value: string | null | undefined): string {
  return normalizeToolNameLower(value)
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function collapseToolNameAlphanumeric(value: string | null | undefined): string {
  return normalizeToolNameLower(value).replace(/[^a-z0-9]+/g, '')
}

export function sanitizeToolNameForComparison(toolName: string): { sanitized: string; lower: string } {
  const sanitized = toolName
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')

  return {
    sanitized,
    lower: sanitized.toLowerCase()
  }
}

export function normalizeToolNameForLooseMatch(value: string | null | undefined): string {
  return collapseToolNameAlphanumeric(value)
}

export function normalizeAgentBrowserCommandName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\w]/g, '')
}

export function normalizeToolNameForAiSdkKey(value: string | null | undefined): string {
  return slugToolNamePreservingHyphen(value)
}

export function isDynamicMcpUseToolName(value: string | null | undefined): boolean {
  const normalized = normalizeToolNameForLooseMatch(value)
  return (
    normalized.includes('dynamicmcpuse') ||
    (normalized.includes('dynamic') && normalized.includes('mcp') && normalized.includes('use'))
  )
}

export function isDynamicMcpFindToolName(value: string | null | undefined): boolean {
  const normalized = normalizeToolNameForLooseMatch(value)
  return normalized.includes('dynamicmcpfind')
}

export function isBrokerToolUseName(value: string | null | undefined): boolean {
  const normalized = normalizeToolNameForLooseMatch(value)
  return normalized.endsWith('batshittooluse') || normalized.includes('batshittooluse')
}

export function hasSubagentToolSegment(value: string | null | undefined): boolean {
  return normalizeToolNameLower(value).includes('subagent_')
}

export function extractKnownToolNameFromRawName(
  rawToolName: string | null | undefined,
  knownToolNames: string[]
): string | null {
  if (!rawToolName) return null
  for (const knownToolName of knownToolNames) {
    if (rawToolName.includes(knownToolName)) {
      return knownToolName
    }
  }
  return null
}
