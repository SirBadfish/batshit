import { getTypeZipSettings, shouldPreferFieldSettingsForTool } from './toolRenderMap'
import {
  normalizeCompactTool,
  resolveToolActivitySettingsName,
  type ToolOperationKind,
  type ToolRendererFamily
} from './toolActivityContract'

type Numeric = number | string | null | undefined

export interface ZipLikeMetadata {
  tokens?: Numeric
  bufferSize?: Numeric
  threshold?: Numeric
  metadata?: Record<string, any>
  name?: string
  optionalContent?: string
  content?: unknown
  type?: string
}

export interface ZipActivationOptions {
  zipType: string
  messagesFromEnd: number
  zipData?: ZipLikeMetadata | null
  agentSettings?: any
  globalSettings?: any
  toolName?: string
  fallbackTokens?: number
  isUnzipped?: boolean
  isRezipped?: boolean
  /**
   * The owning assistant message failed mid-task or was interrupted with no
   * successful completion after it (see calculateRecoveryHoldByIndex). Blocks
   * automatic compression (auto-zip and buffer aging) so the agent can still
   * see its in-flight work; manual unzip/rezip and forceCompress still win.
   */
  recoveryHold?: boolean
}

export interface ZipActivationResult {
  shouldCompress: boolean
  exceedsBuffer: boolean
  meetsThreshold: boolean
  bufferSize: number
  zipThreshold: number
  tokens: number
  autoZip: boolean
  zipDisabled: boolean
  toolName?: string
  zipType: string
  messagesFromEnd: number
  recoveryHold: boolean
}

function coerceNumber(value: Numeric): number | undefined {
  if (value === undefined || value === null) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function collapseToolAlias(value: unknown): string {
  return normalizeString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? ''
}

function isNativePackWrapperName(value: unknown): boolean {
  const collapsed = collapseToolAlias(value)
  return collapsed === 'batshittools' || collapsed === 'batshitnativetools'
}

function isSpecificOperationKind(value: unknown): value is ToolOperationKind {
  return typeof value === 'string' && value.length > 0 && value !== 'unknown_tool'
}

function rendererFamilyToOperationKind(value: unknown): ToolOperationKind | undefined {
  switch (value as ToolRendererFamily) {
    case 'read_file':
    case 'skill_read':
    case 'write_file':
    case 'edit_file':
    case 'web_search':
    case 'dynamic_find':
    case 'tool_find':
    case 'cli_tool':
    case 'subagent':
      return value as ToolOperationKind
    case 'bash':
      return 'bash'
    default:
      return undefined
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function inferIdentityFromContent(zipData?: ZipLikeMetadata | null): {
  operationKind?: ToolOperationKind
  toolName?: string
} {
  const parsed = parseMaybeJson(zipData?.content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  const payload = parsed as Record<string, any>
  const payloadToolName = normalizeString(payload.toolName)
  const payloadOperationKind = payload.operationKind
  const payloadRendererKind = rendererFamilyToOperationKind(payload.rendererFamily)
  const toolInput = {
    toolName: payloadToolName,
    originalToolName: normalizeString(payload.originalToolName),
    toolArgs: payload.toolArgs && typeof payload.toolArgs === 'object' && !Array.isArray(payload.toolArgs)
      ? payload.toolArgs
      : {},
    toolResult: payload.toolResult ?? payload.observation ?? payload.output ?? payload.result,
    metadata: payload.metadata,
    isSubagent: payload.isSubagent === true,
    toolProvider: normalizeString(payload.toolProvider)
  }

  if (isSpecificOperationKind(payloadOperationKind) || payloadRendererKind) {
    const operationKind = isSpecificOperationKind(payloadOperationKind)
      ? payloadOperationKind
      : payloadRendererKind
    return {
      operationKind,
      toolName: resolveToolActivitySettingsName(toolInput, operationKind) ?? payloadToolName
    }
  }

  const normalized = normalizeCompactTool(toolInput)

  return {
    operationKind: isSpecificOperationKind(normalized.operationKind)
      ? normalized.operationKind
      : undefined,
    toolName:
      resolveToolActivitySettingsName(toolInput, normalized.operationKind) ??
      payloadToolName
  }
}

function resolveSpecificToolName(
  operationKind: ToolOperationKind,
  explicitToolName?: string,
  metadataToolName?: string,
  contentToolName?: string
): string {
  const specificName = [metadataToolName, contentToolName, explicitToolName].find(
    (name) =>
      name &&
      name !== operationKind &&
      name !== 'unknown_tool' &&
      !isNativePackWrapperName(name)
  )

  return specificName || operationKind
}

function operationKindOwnsSettingsIdentity(operationKind: ToolOperationKind): boolean {
  return (
    operationKind !== 'dynamic_use' &&
    operationKind !== 'cli_tool' &&
    operationKind !== 'agent_browser_use'
  )
}

function resolveToolIdentity(toolName?: string, zipData?: ZipLikeMetadata | null): {
  toolName?: string
  operationKind?: ToolOperationKind
} {
  const explicitToolName = normalizeString(toolName)
  const metadataOperationKind = normalizeString(zipData?.metadata?.operationKind)
  const metadataRendererKind = rendererFamilyToOperationKind(zipData?.metadata?.rendererFamily)
  const metadataToolName =
    normalizeString(zipData?.metadata?.toolName) ??
    normalizeString(zipData?.metadata?.tool_name)
  const contentIdentity = inferIdentityFromContent(zipData)
  const operationKind = isSpecificOperationKind(metadataOperationKind)
    ? metadataOperationKind
    : metadataRendererKind ?? contentIdentity.operationKind

  if (operationKind) {
    return {
      operationKind,
      toolName: operationKindOwnsSettingsIdentity(operationKind)
        ? operationKind
        : resolveSpecificToolName(
            operationKind,
            explicitToolName,
            metadataToolName,
            contentIdentity.toolName
          )
    }
  }

  if (explicitToolName) return { toolName: explicitToolName }

  return {
    toolName:
      metadataToolName ??
      normalizeString(zipData?.name) ??
      normalizeString(zipData?.metadata?.name)
  }
}

/**
 * Calculate whether a zip should be compressed (rendered as a placeholder)
 * based on buffer/threshold rules and token counts.
 */
export function calculateZipActivation(options: ZipActivationOptions): ZipActivationResult {
  const {
    zipType,
    messagesFromEnd,
    zipData,
    agentSettings,
    globalSettings,
    toolName,
    fallbackTokens,
    isUnzipped = false,
    isRezipped = false,
    recoveryHold = false
  } = options

  const resolvedIdentity = resolveToolIdentity(toolName, zipData)
  const resolvedToolName = resolvedIdentity.toolName
  const isSubagentTool =
    zipType === 'cool_tool' &&
    (zipData?.metadata?.isSubagent === true ||
      zipData?.metadata?.subagentId ||
      zipData?.metadata?.subagentName)
  const settingsToolName = isSubagentTool ? 'subagent' : resolvedToolName
  const ignoreCustomToolSettings =
    Boolean(resolvedIdentity.operationKind) &&
    shouldPreferFieldSettingsForTool(resolvedIdentity.operationKind)

  const typeSettings = getTypeZipSettings(
    zipType,
    agentSettings,
    globalSettings,
    settingsToolName,
    { ignoreCustomToolSettings }
  )

  // Always prefer live agent/global settings so per-agent zip controls take effect even for stored zips
  let bufferSize = typeSettings.bufferSize
  let zipThreshold = typeSettings.zipThreshold
  const autoZip = Boolean(typeSettings.autoZip)
  const zipDisabled = Boolean(typeSettings.zipDisabled)

  const forceCompress = zipData?.metadata?.forceCompress === true
  if (!zipDisabled && autoZip) {
    bufferSize = 0
    zipThreshold = 0
  }

  const tokens =
    coerceNumber(zipData?.metadata?.promptTokens) ??
    coerceNumber(zipData?.metadata?.aiTokens) ??
    coerceNumber(zipData?.tokens) ??
    coerceNumber(zipData?.metadata?.tokens) ??
    (fallbackTokens !== undefined ? fallbackTokens : 0)

  const normalizedMessagesFromEnd = Math.max(0, messagesFromEnd)
  const exceedsBuffer = zipDisabled ? false : autoZip ? true : normalizedMessagesFromEnd >= bufferSize
  const meetsThreshold = zipDisabled ? false : autoZip ? true : tokens >= zipThreshold

  // Manual rezip overrides buffer/threshold to force compression.
  // Recovery hold blocks only the AUTOMATIC compression lanes (auto-zip and
  // buffer aging) — a run that died mid-task must not have its in-flight tool
  // results hidden from the agent on the next send.
  const shouldCompress =
    !zipDisabled &&
    (forceCompress ||
      isRezipped ||
      (!isUnzipped && !recoveryHold && (autoZip || (exceedsBuffer && meetsThreshold))))

  return {
    shouldCompress,
    exceedsBuffer,
    meetsThreshold,
    bufferSize,
    zipThreshold,
    tokens,
    autoZip,
    zipDisabled,
    toolName: resolvedToolName,
    zipType,
    messagesFromEnd: normalizedMessagesFromEnd,
    recoveryHold
  }
}
