import { getTypeZipSettings, shouldPreferFieldSettingsForTool } from './toolRenderMap'
import {
  normalizeCompactTool,
  resolveToolActivitySettingsName,
  type ToolOperationKind,
  type ToolRendererFamily
} from './toolActivityContract'
import type { DeadCopyReason } from './zipDeadCopies'
import { classifyToolResultSize, resolveToolResultPromptTokens, type ToolResultSizeGuard } from './toolResultSizeGuard'

type Numeric = number | string | null | undefined

export interface ZipLikeMetadata {
  tokens?: Numeric
  promptTokens?: Numeric
  aiTokens?: Numeric
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
  /** Judge Juice opens are automatic, not explicit Holds; they never open a large result. */
  isInferredUnzipped?: boolean
  isRezipped?: boolean
  /**
   * The owning assistant message failed mid-task or was interrupted with no
   * successful completion after it (see calculateRecoveryHoldByIndex). Blocks
   * automatic compression (auto-zip and buffer aging) so the agent can still
   * see its in-flight work; explicit Holds, rezips and the size guard still win.
   */
  recoveryHold?: boolean
  /**
   * SA-129 P1 (DL-01): this zip is a dead copy of a file read (`findDeadCopies`), and how many of
   * its author's replies had finished when it died. A dead copy compresses whatever the buffer or
   * Auto/Normal setting says; only an `Off` row and a user unzip keep it open.
   */
  deadCopy?: { reason: DeadCopyReason; repliesUntilDead: number } | null
  /**
   * The unzip is the user's (a user lock). An agent's or Batshit's (`inferred`) unzip does not
   * keep a dead copy open. Only read beside `deadCopy`.
   */
  isUserUnzipped?: boolean
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
  /** The size rule that won activation, based on the model-facing transcript. */
  sizeGuard: ToolResultSizeGuard
  /** Set when the dead-copy rule keeps this zip compressed (DL-01). */
  deadCopy: DeadCopyReason | null
  /**
   * The compressed reference says why (`DEAD_COPY_REASON_TEXT`): the copy died while the
   * automatic rules still kept it open. A copy that had already aged out of its buffer when it
   * died keeps its plain reference, so an old history line never changes when the agent reads
   * the file again much later (append-only history; cache forensics `historyStability`).
   */
  deadCopyNamed: boolean
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
 * SA-129 P1 (DL-03): what an expanded read says on the last reply it is open. P2 added the second
 * way to keep it: hold the file (`zipHoldWords.ts`).
 */
export const READ_COMPRESS_HINT_LAST_REPLY = 'Compresses after this reply. Note what you need or hold the file.'

/**
 * SA-129 P1 (DL-03): the one line an expanded `read_file` or `skill_read` transcript carries, so
 * the agent can always tell when the result compresses. Built at compile time from the activation,
 * never stored in the zip. Null when nothing will compress it on its own: an `Off` row, a result
 * below the size floor, or an unzip (a hold says who holds it instead: `describeHeldReadHint`).
 *
 * The line stays the same from one compile to the next until the last reply the result is open
 * (`Compresses N replies after it was read.`, then `Compresses after this reply.`): a countdown would change
 * an earlier history line on every send and break the prompt cache there each time, where a
 * buffer compression changes it once.
 */
export function describeReadCompressHint(
  activation: ZipActivationResult,
  options: { isUnzipped: boolean }
): string | null {
  if (activation.shouldCompress || activation.zipDisabled || options.isUnzipped) return null
  // An Auto result is open only through a recovery hold, which ends when this reply completes.
  if (activation.autoZip) return activation.recoveryHold ? READ_COMPRESS_HINT_LAST_REPLY : null
  if (!activation.meetsThreshold) return null
  if (activation.messagesFromEnd + 1 >= activation.bufferSize) return READ_COMPRESS_HINT_LAST_REPLY
  // Reached only with a buffer of 2 or more.
  return `Compresses ${activation.bufferSize} replies after it was read.`
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
    isInferredUnzipped = false,
    isRezipped = false,
    recoveryHold = false,
    deadCopy = null,
    isUserUnzipped = false
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

  if (!zipDisabled && autoZip) {
    bufferSize = 0
    zipThreshold = 0
  }

  const tokens =
    (zipType === 'cool_tool'
      ? resolveToolResultPromptTokens(zipData)
      : coerceNumber(zipData?.metadata?.promptTokens) ?? coerceNumber(zipData?.metadata?.aiTokens)) ??
    coerceNumber(zipData?.tokens) ??
    coerceNumber(zipData?.metadata?.tokens) ??
    (fallbackTokens !== undefined ? fallbackTokens : 0)

  const normalizedMessagesFromEnd = Math.max(0, messagesFromEnd)
  const exceedsBuffer = zipDisabled ? false : autoZip ? true : normalizedMessagesFromEnd >= bufferSize
  const meetsThreshold = zipDisabled ? false : autoZip ? true : tokens >= zipThreshold

  // The guard applies to tool results, not image/error and other non-tool zip families.
  // Old forceCompress stamps counted renderer JSON and cannot decide prompt exposure.
  const size = zipType === 'cool_tool' ? classifyToolResultSize(tokens) : null
  const tooLarge = size === 'too_large'
  const large = size !== null
  const explicitHold = isUnzipped && !isInferredUnzipped
  // Manual rezip overrides buffer/threshold to force compression.
  // Recovery hold blocks only the AUTOMATIC compression lanes (auto-zip and
  // buffer aging) — a run that died mid-task must not have its in-flight tool
  // results hidden from the agent on the next send.
  // A dead copy (DL-01) is outdated or duplicated, so neither a recovery hold nor an
  // agent's or Batshit's unzip keeps it open; an Off row and a user unzip do.
  const deadCopyApplies = !tooLarge && Boolean(deadCopy) && !zipDisabled && !(isUnzipped && isUserUnzipped)
  const sizeGuard: ToolResultSizeGuard = tooLarge
    ? 'too_large'
    : !zipDisabled && !isRezipped && !deadCopyApplies && !explicitHold && large
      ? 'large'
      : null
  const shouldCompress =
    tooLarge || (!zipDisabled &&
    (
      isRezipped ||
      deadCopyApplies ||
      (!explicitHold && large) ||
      (!isUnzipped && !recoveryHold && (autoZip || (exceedsBuffer && meetsThreshold)))))
  // Auto (buffer 0) always reads as already compressed here, so an Auto copy is never named.
  const deadCopyNamed =
    deadCopyApplies &&
    !large &&
    !isRezipped &&
    !(meetsThreshold && (deadCopy?.repliesUntilDead ?? 0) >= bufferSize)

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
    recoveryHold,
    sizeGuard,
    deadCopy: deadCopyApplies && deadCopy ? deadCopy.reason : null,
    deadCopyNamed
  }
}
