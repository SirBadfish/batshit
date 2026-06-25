function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function buildInlineCoolToolStep(segmentToolData: Record<string, any> | null | undefined, fallbackToolName: string) {
  if (!isPlainObject(segmentToolData)) return null

  const metadata = isPlainObject(segmentToolData.metadata) ? { ...segmentToolData.metadata } : {}
  const toolName =
    typeof segmentToolData.toolName === 'string'
      ? segmentToolData.toolName
      : typeof segmentToolData.tool === 'string'
        ? segmentToolData.tool
        : fallbackToolName
  const displayToolName =
    typeof segmentToolData.displayToolName === 'string'
      ? segmentToolData.displayToolName
      : typeof metadata.displayToolName === 'string'
        ? metadata.displayToolName
        : undefined
  const operationKind =
    typeof segmentToolData.operationKind === 'string'
      ? segmentToolData.operationKind
      : typeof metadata.operationKind === 'string'
        ? metadata.operationKind
        : undefined
  const rendererFamily =
    typeof segmentToolData.rendererFamily === 'string'
      ? segmentToolData.rendererFamily
      : typeof metadata.rendererFamily === 'string'
        ? metadata.rendererFamily
        : undefined
  const toolArgs = segmentToolData.toolArgs ?? segmentToolData.toolInput ?? segmentToolData.input ?? {}
  const toolResult =
    segmentToolData.toolResult ??
    segmentToolData.observation ??
    segmentToolData.output ??
    segmentToolData.result

  return {
    ...segmentToolData,
    toolName,
    originalToolName:
      typeof segmentToolData.originalToolName === 'string'
        ? segmentToolData.originalToolName
        : toolName,
    ...(displayToolName ? { displayToolName } : {}),
    ...(operationKind ? { operationKind } : {}),
    ...(rendererFamily ? { rendererFamily } : {}),
    toolArgs,
    toolResult,
    observation: segmentToolData.observation ?? toolResult,
    timestamp: segmentToolData.timestamp || new Date().toISOString(),
    metadata: {
      ...metadata,
      ...(displayToolName ? { displayToolName } : {}),
      ...(operationKind ? { operationKind } : {}),
      ...(rendererFamily ? { rendererFamily } : {})
    }
  }
}
