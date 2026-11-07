/**
 * Cool Tools Zip Adapter
 * Story 4.4: Cool Tools Integration with Stream-to-Zip Architecture
 *
 * CRITICAL: This is the ONLY file that knows Cool Tools are special!
 * All Cool Tools special handling is isolated here. The rest of the zip
 * system treats Cool Tools as just another zip type ('cool_tool').
 */

import type { ZipReference } from './zipService'
import { createZipFromContent } from './zipService'
import type { AgentRow } from '$lib/types/database'
import { canonicalToolName, getToolSettings, shouldPreferFieldSettingsForTool } from '$lib/utils/toolRenderMap'
import { mapBashCommandToMode4Tool, mapBashCommandToRendererTool } from '$lib/server/services/bashCommandMapper'
import { parseManagedApplyPatchCommand } from '$lib/utils/managedApplyPatch'
import type { IntermediateStep } from '$lib/utils/toolResultProcessor'
import { normalizeToolStep, toolStepFailureMessage } from '$lib/utils/toolResultProcessor'
import {
  TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS,
  TOOL_ACTIVITY_SCHEMA_VERSION,
  modelFacingMcpText,
  normalizeCompactTool,
  resolveToolActivitySettingsName,
  shouldForceCompressToolPayload,
  shouldRetainRawSidecar,
  toolOutputCut,
  type ToolOperationKind,
  type ToolRendererFamily
} from '$lib/utils/toolActivityContract'
import {
  buildCoolToolAiContent,
  parseCoolToolPayload,
  buildCoolToolAiContentWithSources,
  type CoolToolAiContentPart,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import { isBrokerToolUseName } from '$lib/utils/toolNameNormalization'
import { isToolModelCutView } from '$lib/utils/toolModelTextSizeGuard'
import { isTransientContextControlToolStep } from '$lib/utils/memoryControl'
import { API_UTILITY_CONTROL_IDS } from '$lib/utils/apiUtilityControls'
import { validShellReadSplit, type FileReadView, type ShellReadSplitPart } from '$lib/utils/shellReadSplit'
import { fileReadSourceFromProof, type FileReadSource } from '$lib/utils/fileReadSource'
import { verifyFileReadProofSeal } from '$lib/server/services/fileReadProofSeal'
import { TYPED_READ_FILE_TOOL, typedReadResultFromBytes } from '$lib/server/services/typedFileTools'
import { logger } from '$lib/utils/logger'
import { withZipStateLock } from './services/zipStateLock'
import { openSkillSessionRead, type SkillSessionActor } from './services/skillSessions'
import { redis } from './redis'
import { publishUserEvent } from './ssePublisher'
import { originalCoolToolReadDigest } from './services/coolToolPromptTokens'
import {
  normalizeToolPayload,
  parseJsonIfLikely,
  unwrapToolTextArray,
  unwrapDynamicMcpStep as unwrapDynamicMcpStepPayload
} from '$lib/utils/toolPayloadUnwrap'

type ReservedZipIdSource = Map<string, string> | Record<string, string | undefined>

type CoolToolZipAdapterOptions = {
  reservedZipIdsByToolCallId?: ReservedZipIdSource
  /** Only the Primary turn owner supplies this, never a tool result or delegated run. */
  skillSessionActor?: Omit<SkillSessionActor, 'sessionId'>
  /** Actual delivery owner only; checked inside the shared lock, before any RAW write. */
  beforeSkillReadPersist?: () => Promise<void>
}

function isSkillLifecycleProducer(tool: NormalizedCoolTool): boolean {
  const name = tool.originalToolName || tool.toolName
  if (name === 'native_batshit_tool_use') {
    return tool.metadata?.apiUtilityControlId === API_UTILITY_CONTROL_IDS.skill &&
      tool.metadata?.apiUtilityRef === `batshit:${API_UTILITY_CONTROL_IDS.skill}` && tool.toolSource === 'native-tool'
  }
  if (name === 'native_skill') return tool.toolProvider !== 'mcp' || tool.mcpServerName === 'batshit_helpers'
  return name === 'mcp.batshit_helpers.native_skill' || name === 'mcp__batshit_helpers__native_skill'
}

type NormalizedCoolTool = {
  schemaVersion: number
  type: 'tool'
  toolName: string
  displayToolName?: string
  originalToolName?: string
  operationKind: ToolOperationKind
  rendererFamily: ToolRendererFamily
  toolCallId?: string
  toolArgs: any
  toolResult: any
  observation?: any
  error?: any
  timestamp: string
  toolProvider?: string
  toolSource?: string
  gatewayId?: string
  gatewayName?: string
  gatewayType?: string
  mcpServerName?: string
  isSubagent?: boolean
  subagentId?: string
  subagentName?: string
  subagentAvatar?: string
  agentName?: string
  rawSidecar?: {
    status: 'stored' | 'not_retained'
    zipId?: string
    reason?: string
  }
  storage?: {
    compacted: boolean
    truncated: boolean
    binaryLikeOmitted: boolean
    forceCompress: boolean
  }
  metadata?: Record<string, any>
}

type PreparedCoolTool = {
  payload: NormalizedCoolTool
  rawSidecarContent: string | null
  /** The raw sidecar's content whether or not it is kept (SA-137's refresh reads it). */
  rawSidecarCandidate: string
  rawSidecarReason?: string
  rawTokens: number
  compactTokens: number
  forceCompress: boolean
  modelFacingResultTokens: number
}

const normalizeToolResultShape = (input: any): any =>
  normalizeToolPayload(input, {
    textArrays: false,
    singlePropertyKeys: ['result', 'output', 'data', 'content']
  })


/**
 * Helper to handle circular references when stringifying tool results
 */
function getCircularReplacer() {
  const seen = new WeakSet()
  return (key: string, value: any) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]"
      }
      seen.add(value)
    }
    return value
  }
}

/**
 * Calculate approximate token count for content
 * Matches the standard calculation used elsewhere in the system
 */
function calculateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function normalizeLineCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.trunc(value))
}

function countTextLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

function extractLineCountText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    const textItems = value
      .map((item) =>
        item && typeof item === 'object' && typeof (item as any).text === 'string'
          ? (item as any).text
          : typeof item === 'string'
            ? item
            : null
      )
      .filter((item): item is string => item !== null)
    return textItems.length > 0 ? textItems.join('\n') : null
  }

  const record = value as Record<string, any>
  const directText =
    record.content ??
    record.fileContent ??
    record.skillMarkdown ??
    record.preview ??
    record.response ??
    record.output ??
    record.result ??
    record.data

  if (typeof directText === 'string') return directText

  const streamText = [record.stdout, record.stderr]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .join('\n')
  return streamText || null
}

/**
 * A known lane's own size, when its output does not sit in a field `extractLineCountText` reads.
 *
 * The size in a zip description must describe what the tool produced, never the stored renderer
 * JSON. An edit's output is its diff, a search's is its matching lines, and a command that
 * printed nothing printed nothing — each of those used to fall through to the JSON fallback
 * below, so every edit read about `- 8 lines`, a one-match search `- 17 lines`, and a silent
 * `mkdir` `- 11 lines` (F-P6-5 follow-up item 3).
 */
function laneResultLineCount(tool: NormalizedCoolTool): number | undefined {
  const result =
    tool.toolResult && typeof tool.toolResult === 'object' && !Array.isArray(tool.toolResult)
      ? (tool.toolResult as Record<string, any>)
      : null
  if (!result) return undefined

  switch (tool.operationKind) {
    case 'edit_file': {
      const diff = [result.diff, result.patch].find((value) => typeof value === 'string')
      return typeof diff === 'string' ? countTextLines(diff) : undefined
    }
    case 'bash': {
      const streams = [result.stdout, result.stderr].filter(
        (value): value is string => typeof value === 'string'
      )
      return streams.length > 0 ? countTextLines(streams.filter(Boolean).join('\n')) : undefined
    }
    case 'search_files': {
      if (!Array.isArray(result.results)) return undefined
      const total =
        typeof result.totalMatches === 'number'
          ? result.totalMatches
          : result.results.reduce(
              (sum: number, entry: any) => sum + (typeof entry?.matchCount === 'number' ? entry.matchCount : 0),
              0
            )
      return normalizeLineCount(total) ?? undefined
    }
    default:
      return undefined
  }
}

function inferCoolToolResultLineCount(tool: NormalizedCoolTool): number | undefined {
  const result = tool.toolResult
  const metadata = tool.metadata

  const explicit =
    normalizeLineCount((result as any)?.lineCount) ??
    normalizeLineCount((result as any)?.numLines) ??
    normalizeLineCount((result as any)?.totalLines) ??
    normalizeLineCount((metadata as any)?.lineCount) ??
    normalizeLineCount((metadata as any)?.resultLineCount)
  if (explicit !== null) return explicit

  const laneCount = laneResultLineCount(tool)
  if (laneCount !== undefined) return laneCount

  const text = extractLineCountText(result)
  if (text !== null) return countTextLines(text)

  if (result && typeof result === 'object') {
    try {
      return countTextLines(JSON.stringify(result, getCircularReplacer(), 2))
    } catch {
      return undefined
    }
  }

  if (result != null) return 1
  return undefined
}

function formatMode1NativePackDisplayName(
  operationKind: ToolOperationKind,
  rendererFamily: ToolRendererFamily
): string | undefined {
  switch (operationKind) {
    case 'read_file':
      return 'Read File'
    case 'skill_read':
      return 'Skill Read'
    case 'write_file':
      return 'Write File'
    case 'edit_file':
      return 'Edit File'
    case 'web_search':
      return 'Web Search'
    case 'search_files':
      return 'Search Files'
    case 'list_files':
      return 'List Files'
    case 'fetch_zip':
      return 'Fetch Zip'
    case 'bash':
      return 'Bash'
    case 'dynamic_find':
      return 'Dynamic Tool Search'
    case 'dynamic_use':
      return 'MCP Tool'
    case 'tool_find':
      return 'Dynamic Tool Search'
    case 'cli_tool':
      return 'CLI Tool'
    case 'agent_browser_find':
      return 'Dynamic Tool Search'
    case 'agent_browser_use':
      return 'Agent Browser Action'
    case 'artifact_find':
      return 'Dynamic Tool Search'
    case 'artifact_use':
      return 'Artifact Tool'
    case 'fabric_find':
      return 'Dynamic Tool Search'
    case 'fabric_use':
      return 'Fabric Control'
    case 'subagent':
      return 'Subagent'
    case 'unknown_tool':
    default:
      if (rendererFamily === 'generic_tool') return undefined
      return rendererFamily
  }
}

function isMode1NativePackToolName(toolName: string): boolean {
  const normalized = toolName.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'batshitnativetools' || normalized === 'batshittools'
}

/**
 * Get effective settings for Cool Tools
 * Follows the hierarchical settings pattern
 */
/**
 * Validate and normalize intermediate steps data
 * Returns null if data is invalid
 */
function normalizeDynamicResult(value: unknown): unknown {
  let result = parseJsonIfLikely(value)
  result = unwrapToolTextArray(result)
  if (typeof result === 'string') {
    result = parseJsonIfLikely(result)
  }
  result = normalizeToolResultShape(result)
  return result
}

function unwrapDynamicMcpStep(step: any): {
  toolName: string
  params?: Record<string, any> | null
  result?: unknown
  executionTimeMs?: number
  wrapperToolName: string
} | null {
  return unwrapDynamicMcpStepPayload(step, { normalizeResult: normalizeDynamicResult })
}

function isN8nMcpTriggerToolName(toolName: string): boolean {
  const lowered = toolName.toLowerCase()
  return lowered === 'n8n_mcp_trigger' || lowered.includes('mcp_trigger')
}

function isN8nMcpResponseWrapper(value: unknown): boolean {
  const looksLikeResponseContainer = (container: any): boolean => {
    if (!container || typeof container !== 'object' || Array.isArray(container)) return false
    const response = (container as any).response ?? (container as any).responses
    if (!Array.isArray(response) || response.length === 0) return false
    const first = response[0]
    if (!first || typeof first !== 'object') return false
    return typeof (first as any).text === 'string' || (first as any).json !== undefined
  }

  if (Array.isArray(value) && value.length === 1) return looksLikeResponseContainer(value[0])
  return looksLikeResponseContainer(value as any)
}

function extractN8nMcpTriggerToolCall(step: any): {
  toolName: string
  toolArgs: Record<string, any>
  toolCallId?: string
} | null {
  const action = step?.action
  if (!action || typeof action !== 'object') return null

  const toolCalls: any[] = []

  const messageLogs = Array.isArray(action.messageLog)
    ? action.messageLog
    : Array.isArray(action.message_log)
      ? action.message_log
      : []

  for (const entry of messageLogs) {
    if (!entry || typeof entry !== 'object') continue
    const kwargs = (entry as any).kwargs
    const directToolCalls =
      (kwargs && ((kwargs as any).tool_calls || (kwargs as any).toolCalls)) ||
      (entry as any).tool_calls ||
      (entry as any).toolCalls

    if (Array.isArray(directToolCalls)) {
      toolCalls.push(...directToolCalls)
      continue
    }

    if (typeof directToolCalls === 'string') {
      const parsed = parseJsonIfLikely(directToolCalls)
      if (Array.isArray(parsed)) toolCalls.push(...parsed)
    }
  }

  const parsedLog = parseJsonIfLikely((action as any).log)
  if (parsedLog && typeof parsedLog === 'object' && !Array.isArray(parsedLog)) {
    toolCalls.push({ args: parsedLog })
  }

  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue

    const rawArgs =
      (call as any).args ??
      (call as any).arguments ??
      (call as any).function?.arguments ??
      (call as any).function?.args

    const parsedArgs = parseJsonIfLikely(rawArgs)
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) continue

    const argsRecord = parsedArgs as Record<string, any>
    const toolName = typeof argsRecord.tool === 'string'
      ? argsRecord.tool
      : typeof (call as any).function?.name === 'string'
        ? (call as any).function.name
        : typeof (call as any).name === 'string'
          ? (call as any).name
          : null

    if (!toolName || typeof toolName !== 'string' || isN8nMcpTriggerToolName(toolName)) continue

    const toolCallId = typeof argsRecord.id === 'string'
      ? argsRecord.id
      : typeof (call as any).id === 'string'
        ? (call as any).id
        : undefined

    const toolArgs = { ...argsRecord }
    delete (toolArgs as any).tool
    delete (toolArgs as any).id

    return {
      toolName,
      toolArgs,
      toolCallId
    }
  }

  return null
}

function isCliToolUseToolName(toolName: string | undefined): boolean {
  if (!toolName) return false
  const normalized = toolName.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized.includes('clitooluse')
}

function unwrapCliToolUseStep(step: any): {
  toolId: string
  title?: string
} | null {
  const wrapperToolName = step?.toolName || step?.tool || step?.action?.tool
  if (!isCliToolUseToolName(wrapperToolName)) return null

  const rawResult =
    step?.toolResult ??
    step?.output ??
    step?.result ??
    step?.toolOutput ??
    step?.observation
  const parsed =
    typeof rawResult === 'string' ? parseJsonIfLikely(rawResult) : rawResult
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const toolId =
    typeof (parsed as any).toolId === 'string'
      ? (parsed as any).toolId.trim()
      : typeof (parsed as any).tool_id === 'string'
        ? (parsed as any).tool_id.trim()
        : ''
  if (!toolId) return null

  return {
    toolId,
    title:
      typeof (parsed as any).title === 'string' && (parsed as any).title.trim().length > 0
        ? (parsed as any).title.trim()
        : undefined
  }
}

function normalizeIntermediateStep(step: any): any | null {
  if (!step || typeof step !== 'object') return null

  const normalized = { ...step }

  const toolName =
    normalized.tool ||
    normalized.toolName ||
    normalized.action?.tool ||
    normalized.name

  if (!toolName) return null

  normalized.tool = toolName

  // n8n AI Agent wraps MCP tool calls as `n8n_MCP_Trigger`. The real tool is
  // nested in messageLog/log; unwrap so Cool Tool renderers can route correctly.
  if (typeof toolName === 'string' && isN8nMcpTriggerToolName(toolName)) {
    const unwrapped = extractN8nMcpTriggerToolCall(normalized)
    if (unwrapped) {
      normalized.originalToolName = normalized.originalToolName || toolName
      normalized.tool = unwrapped.toolName
      if (normalized.toolName !== undefined) normalized.toolName = unwrapped.toolName
      if (unwrapped.toolArgs && Object.keys(unwrapped.toolArgs).length > 0) {
        normalized.input = unwrapped.toolArgs
      }
      if (unwrapped.toolCallId && normalized.toolCallId === undefined) {
        normalized.toolCallId = unwrapped.toolCallId
      }
    }
  }

  if (normalized.toolInput !== undefined && normalized.input === undefined) {
    normalized.input = normalized.toolInput
  }
  if (normalized.toolArgs !== undefined && normalized.input === undefined) {
    normalized.input = normalized.toolArgs
  }
  if (normalized.action?.toolInput !== undefined && normalized.input === undefined) {
    normalized.input = normalized.action.toolInput
  }
  if (normalized.action?.tool_input !== undefined && normalized.input === undefined) {
    normalized.input = normalized.action.tool_input
  }

  if (normalized.toolResult !== undefined && normalized.output === undefined) {
    normalized.output = normalized.toolResult
  }
  if (normalized.result !== undefined && normalized.output === undefined) {
    normalized.output = normalized.result
  }
  if (normalized.observation !== undefined && normalized.output === undefined) {
    normalized.output = normalized.observation
  }

  if (normalized.action?.toolCallId !== undefined && normalized.toolCallId === undefined) {
    normalized.toolCallId = normalized.action.toolCallId
  }

  // If a tool result comes back as a JSON string (common for n8n intermediateSteps),
  // parse it so zips store clean JSON instead of double-encoded strings.
  if (normalized.output !== undefined) {
    normalized.output = parseJsonIfLikely(normalized.output)
  }
  if (normalized.toolResult !== undefined) {
    normalized.toolResult = parseJsonIfLikely(normalized.toolResult)
  }

  return normalized
}

/**
 * Transform a single intermediate step to a zippable format
 * Preserves the exact structure for Cool Tools renderers
 */
function sanitizeText(text: unknown): string {
  if (text == null) return ''

  if (typeof text !== 'string') {
    try {
      const serialized = JSON.stringify(text, getCircularReplacer())
      return typeof serialized === 'string' ? serialized : String(text)
    } catch {
      return String(text)
    }
  }

  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t+/g, '    ')
}

function normalizeDescriptionHint(value: unknown, maxChars = 120): string | undefined {
  if (value == null) return undefined
  const normalized = String(value)
    .replace(/[{}]/g, (char) => (char === '{' ? '(' : ')'))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /([?&][^=&\s]*(?:token|secret|password|api[_-]?key|auth|credential)[^=&\s]*=)[^&\s]+/gi,
      '$1[redacted]'
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1=[redacted]'
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')

  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  const keepStart = Math.ceil((maxChars - 5) * 0.6)
  const keepEnd = Math.floor((maxChars - 5) * 0.4)
  return `${normalized.slice(0, keepStart)} ... ${normalized.slice(normalized.length - keepEnd)}`
    .replace(/\[redacte?\s+\.\.\.\s+/gi, '[redacted] ... ')
    .replace(/\[redacted?\s*$/gi, '[redacted]')
}

function firstDescriptionString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeDescriptionHint(value)
    if (normalized) return normalized
  }
  return undefined
}

function quotedDescription(value: unknown): string | undefined {
  const normalized = normalizeDescriptionHint(value, 80)
  return normalized ? `"${normalized.replace(/"/g, "'")}"` : undefined
}

function formatCount(value: unknown, singular: string, plural = `${singular}s`): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const count = Math.max(0, Math.trunc(value))
  return `${count} ${count === 1 ? singular : plural}`
}

function lineSize(value: number | undefined): string | undefined {
  return formatCount(value, 'line')
}

function totalFromResult(result: any, keys: string[]): number | undefined {
  if (!result || typeof result !== 'object') return undefined
  for (const key of keys) {
    const value = result[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function arrayCountFromResult(result: any, keys: string[]): number | undefined {
  if (!result || typeof result !== 'object') return undefined
  for (const key of keys) {
    const value = result[key]
    if (Array.isArray(value)) return value.length
  }
  return undefined
}

function prettyControlTarget(value: unknown): string | undefined {
  const normalized = normalizeDescriptionHint(value, 96)
  if (!normalized) return undefined
  return normalized
    .replace(/^sys[._-]+/i, '')
    .replace(/^[a-z]+[._-]+fabric[._-]+/i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function descriptionStatusForTool(tool: NormalizedCoolTool): string | undefined {
  const result = tool.toolResult
  if (tool.error) return 'error'

  // A tool's own `code` is not a command's exit code (F-P6-5): a WebFetch reports its page's HTTP
  // status there, and `exit 200` in the description read as a failed tool. A command's exit code is
  // `exitCode` by now: `normalizeToolStep` rebuilds a command's result with its `code` there.
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : undefined
  if (typeof exitCode === 'number') return `exit ${exitCode}`
  if (result?.interrupted === true) return 'interrupted'
  if (result?.success === false || result?.ok === false || result?.error) return 'error'
  if (result?.success === true || result?.ok === true) return 'success'

  if (
    tool.operationKind === 'dynamic_use' ||
    tool.operationKind === 'agent_browser_use' ||
    tool.operationKind === 'artifact_use' ||
    tool.operationKind === 'fabric_use' ||
    tool.operationKind === 'cli_tool'
  ) {
    return 'success'
  }

  return undefined
}

function descriptionTargetForTool(tool: NormalizedCoolTool): string | undefined {
  const args = tool.toolArgs || {}
  const result = tool.toolResult || {}
  const path = firstDescriptionString(
    args.filePath,
    args.path,
    result.filePath,
    result.absolutePath,
    result.referencePath,
    result.path
  )
  const dir = firstDescriptionString(
    args.dirPath,
    args.path,
    args.cwd,
    args.workingDir,
    args.projectPath,
    result.dirPath,
    result.path,
    result.cwd
  )
  const query = firstDescriptionString(args.query, args.pattern, result.query)

  if (
    (tool.rendererFamily === 'read_file' ||
      tool.rendererFamily === 'write_file' ||
      tool.rendererFamily === 'edit_file') &&
    path
  ) {
    return path
  }

  switch (tool.operationKind) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return path
    case 'skill_read': {
      const skill = firstDescriptionString(args.skillId, result.skillId, result.skillName)
      const skillPath = firstDescriptionString(args.path, result.path, result.referencePath)
      if (skill && skillPath) return `${skill}/${skillPath}`
      return skill || skillPath
    }
    case 'search_files': {
      const quotedQuery = quotedDescription(query)
      if (quotedQuery && dir) return `${quotedQuery} in ${dir}`
      return quotedQuery || dir
    }
    case 'list_files':
      return dir
    case 'bash':
      return firstDescriptionString(
        args.innerCommand,
        args.command,
        result.innerCommand,
        result.command
      )
    case 'web_search':
    case 'dynamic_find':
    case 'tool_find':
    case 'agent_browser_find':
    case 'artifact_find':
    case 'fabric_find':
      return quotedDescription(query)
    case 'fetch_zip':
      return firstDescriptionString(args.zipId, args.id, result.zipId, result.id)
    case 'dynamic_use':
    case 'agent_browser_use':
      return firstDescriptionString(args.toolName, args.tool_name, result.toolName, result.tool, tool.toolName)
    case 'cli_tool':
      return firstDescriptionString(result.title, args.toolId, result.toolId, tool.toolName)
    case 'artifact_use':
      return firstDescriptionString(
        prettyControlTarget(args.controlId),
        args.artifactSlug,
        args.artifactId,
        result.artifactSlug,
        result.artifactId,
        tool.toolName
      )
    case 'fabric_use':
      return firstDescriptionString(
        prettyControlTarget(args.controlId),
        prettyControlTarget(result.controlId),
        args.action,
        result.action,
        tool.toolName
      )
    case 'subagent':
      return firstDescriptionString(tool.subagentName, result.subagentName, tool.agentName)
    case 'unknown_tool':
    default:
      return firstDescriptionString(
        path,
        quotedDescription(query),
        args.url,
        result.url,
        args.controlId,
        result.controlId,
        args.toolName,
        result.toolName,
        args.command,
        result.command,
        tool.displayToolName,
        tool.toolName
      )
  }
}

function descriptionSizeForTool(
  tool: NormalizedCoolTool,
  resultLineCount: number | undefined
): string | undefined {
  const result = tool.toolResult || {}

  switch (tool.operationKind) {
    case 'list_files':
    case 'search_files':
    case 'bash': {
      // BL-8: an output its lane cut holds only the first entries, matches, or lines.
      const size =
        tool.operationKind === 'list_files'
          ? formatCount(
              totalFromResult(result, ['totalItems', 'totalEntries']) ??
                arrayCountFromResult(result, ['files', 'items', 'entries']),
              'entry',
              'entries'
            ) || lineSize(resultLineCount)
          : lineSize(resultLineCount)
      return size && toolOutputCut(result) ? `first ${size}` : size
    }
    case 'dynamic_find':
    case 'tool_find':
    case 'agent_browser_find':
    case 'artifact_find':
    case 'fabric_find':
    case 'web_search':
      return (
        formatCount(
          totalFromResult(result, ['totalMatches', 'totalResults', 'count', 'total']) ??
            arrayCountFromResult(result, ['results', 'items']),
          'result'
        ) || lineSize(resultLineCount)
      )
    default:
      return lineSize(resultLineCount)
  }
}

function buildZipDescriptionHints(
  tool: NormalizedCoolTool,
  resultLineCount: number | undefined
): Record<string, string> {
  const label = normalizeDescriptionHint(
    (typeof tool.metadata?.rendererTitle === 'string' ? tool.metadata.rendererTitle : undefined) ||
      (tool.operationKind === 'unknown_tool' ? tool.toolName : tool.operationKind),
    44
  )
  const target = descriptionTargetForTool(tool)
  const status = descriptionStatusForTool(tool)
  const size = descriptionSizeForTool(tool, resultLineCount)

  return {
    ...(label ? { zipDescriptionLabel: label } : {}),
    ...(target ? { zipDescriptionTarget: target } : {}),
    ...(status ? { zipDescriptionStatus: status } : {}),
    ...(size ? { zipDescriptionSize: size } : {})
  }
}

function buildCoolToolMetadata(step: any, normalized: IntermediateStep): Record<string, any> {
  return {
    ...(normalized as any).metadata,
    ...(step.metadata || {}),
    ...(normalized.subagentName ? { subagentName: normalized.subagentName } : {}),
    ...(normalized.agentName ? { agentName: normalized.agentName } : {}),
    ...(normalized.isSubagent ? { isSubagent: true } : {}),
    ...(step.gatewayId ? { gatewayId: step.gatewayId } : {}),
    ...(step.gatewayName ? { gatewayName: step.gatewayName } : {}),
    ...(step.gatewayType ? { gatewayType: step.gatewayType } : {}),
    ...(step.mcpServerName ? { mcpServerName: step.mcpServerName } : {}),
    ...(step.subagentId ? { subagentId: step.subagentId } : {}),
    ...(step.subagentAvatar ? { subagentAvatar: step.subagentAvatar } : {})
  }
}

/**
 * BL-233 review (finding 2): every lane classifies a shell command once, with the shared mapper.
 * The API lane does it in send-routed (its result carries `mappedToolName`), Claude in
 * its adapter (it names the step for the mapper's answer). A command step no lane's mapper saw
 * (batshit-server's own `execute_command`, a third-party MCP tool) is
 * classified here by the SAME mapper, so it is stored as that mapping and never by a second
 * reading of its text (`normalizeToolStep` reads only a result's shape). The mapper is
 * deterministic: a Claude (or saved Codex) step it already named a command gets the same answer again.
 */
function applySharedCommandMapping(base: IntermediateStep): void {
  if (canonicalToolName(base.toolName) !== 'execute_command') return
  const result = base.toolResult
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as any).mappedToolName === 'string') {
    return
  }
  const args =
    base.toolArgs && typeof base.toolArgs === 'object' && !Array.isArray(base.toolArgs)
      ? (base.toolArgs as Record<string, any>)
      : {}
  const command = [
    args.command,
    args.cmd,
    args.innerCommand,
    result && typeof result === 'object' && !Array.isArray(result) ? (result as any).command : undefined
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (!command) return
  const mapping = mapBashCommandToMode4Tool(command)
  if (mapping.toolName === 'batshit_server_execute_command') return
  base.toolName = mapping.toolName
  base.toolArgs = { ...args, ...mapping.args }
}

function prepareCoolTool(step: any): PreparedCoolTool {
  const base: IntermediateStep = {
    type:
      step.type === 'tool_error' || step.type === 'error' || step.error
        ? 'tool_error'
        : 'tool',
    toolName: step.toolName || step.tool || step.action?.tool || 'tool',
    originalToolName: step.originalToolName || step.toolName || step.tool,
    toolArgs: step.input ?? step.toolInput ?? step.toolArgs ?? {},
    toolResult: step.output ?? step.toolResult ?? step.result ?? step.toolOutput,
    error:
      typeof step.error === 'string'
        ? step.error
        : step.error
          ? String(step.error)
          : undefined,
    timestamp: step.timestamp || new Date().toISOString(),
    toolProvider: step.toolProvider,
    toolSource: step.toolSource,
    gatewayId: step.gatewayId,
    gatewayName: step.gatewayName,
    gatewayType: step.gatewayType,
    mcpServerName: step.mcpServerName,
    isSubagent: step.isSubagent,
    subagentName: step.subagentName,
    agentName: step.agentName
  }

  const dynamicUnwrap = unwrapDynamicMcpStep(step)
  if (dynamicUnwrap) {
    base.originalToolName = base.originalToolName || dynamicUnwrap.wrapperToolName
    base.toolName = dynamicUnwrap.toolName || base.toolName
    if (dynamicUnwrap.params && Object.keys(dynamicUnwrap.params).length > 0) {
      base.toolArgs = dynamicUnwrap.params
    }
    if (dynamicUnwrap.result !== undefined) {
      base.toolResult = dynamicUnwrap.result
    }

    const metadata = (base as any).metadata && typeof (base as any).metadata === 'object'
      ? { ...(base as any).metadata }
      : {}
    if (dynamicUnwrap.executionTimeMs) {
      metadata.executionTime = dynamicUnwrap.executionTimeMs
    }
    metadata.dynamicMcp = {
      wrapperToolName: dynamicUnwrap.wrapperToolName
    }
    ;(base as any).metadata = metadata

    if (typeof base.toolName === 'string' && /^batshit_server_/i.test(base.toolName)) {
      base.toolProvider = 'batshit-server'
      base.toolSource = 'direct-attachment'
      base.gatewayId = undefined
      base.gatewayName = undefined
      base.gatewayType = undefined
      base.mcpServerName = undefined
    }
  }

  const cliUnwrap = unwrapCliToolUseStep(step)
  if (cliUnwrap) {
    base.originalToolName = base.originalToolName || base.toolName
    base.toolName = cliUnwrap.toolId
    const metadata = (base as any).metadata && typeof (base as any).metadata === 'object'
      ? { ...(base as any).metadata }
      : {}
    metadata.cliTool = {
      toolId: cliUnwrap.toolId,
      ...(cliUnwrap.title ? { title: cliUnwrap.title } : {})
    }
    ;(base as any).metadata = metadata
  }

  applySharedCommandMapping(base)

  const sourceToolName = base.toolName
  const normalized = normalizeToolStep(base)

  const rawToolArgs =
    normalized.toolArgs ||
    step.input ||
    step.toolInput ||
    step.toolArgs ||
    {}
  const toolArgs =
    rawToolArgs && typeof rawToolArgs === 'object' && !Array.isArray(rawToolArgs)
      ? { ...rawToolArgs }
      : {}
  const preserveNativePackInput =
    isMode1NativePackToolName(normalized.toolName || '') ||
    isMode1NativePackToolName(sourceToolName || '') ||
    isMode1NativePackToolName(normalized.originalToolName || '')
  const preserveBrokerUseInput =
    isBrokerToolUseName(normalized.toolName) ||
    isBrokerToolUseName(sourceToolName) ||
    isBrokerToolUseName(normalized.originalToolName)
  if (
    !preserveNativePackInput &&
    !preserveBrokerUseInput &&
    normalized.toolName !== 'execute_command' &&
    normalized.toolName !== 'edit_file'
  ) {
    delete (toolArgs as any).command
    delete (toolArgs as any).input
  }

  const rawCandidate = step.toolResult ?? step.output ?? step.result
  // CLI MCP text blocks are the bytes the model actually saw. A compact saved card must
  // never make an oversized model result look small to next-turn size admission.
  const modelFacingResultText = modelFacingMcpText(rawCandidate)
  const structuredToolNames = new Set([
    'read_file',
    'write_file',
    'edit_file',
    'list_files',
    'search_files',
    'execute_command',
    'subagent'
  ])
  const preferNormalizedResult = structuredToolNames.has(normalized.toolName || '')
  const rawHasNumericKeys =
    rawCandidate &&
    typeof rawCandidate === 'object' &&
    !Array.isArray(rawCandidate) &&
    Object.keys(rawCandidate).some((key) => /^\d+$/.test(key))
  const shouldPreferRaw = Array.isArray(rawCandidate) || rawHasNumericKeys
  const candidateResult =
    preferNormalizedResult && !shouldPreferRaw
      ? normalized.toolResult
      : (rawCandidate ?? normalized.toolResult)
  const rawResult = normalizeToolResultShape(
    isN8nMcpResponseWrapper(rawCandidate) ? normalized.toolResult : candidateResult
  )
  const toolResult = typeof rawResult === 'string'
    ? sanitizeText(rawResult)
    : Array.isArray(rawResult)
      ? rawResult
        : rawResult && typeof rawResult === 'object'
        ? {
            ...rawResult,
            ...(rawResult.content ? { content: sanitizeText((rawResult as any).content) } : {})
          }
        : rawResult

  const mergedMetadata = buildCoolToolMetadata(step, normalized)
  const compactInput = {
    // This is the actual SDK producer name, before canonicalToolName folds the
    // broker to fabric_use. Strict utility presentation must see that provenance.
    toolName: sourceToolName === 'native_batshit_tool_use' ? sourceToolName : normalized.toolName || sourceToolName || 'tool',
    originalToolName: normalized.originalToolName || sourceToolName,
    toolArgs,
    // Preserve the actual MCP text blocks for display normalization. Saved Codex steps
    // returned structured_content:null, and their wrapper otherwise stringified content[] as
    // JSON here. The normalizer decides presentation only, and never trusts ids inside this text.
    toolResult: modelFacingResultText !== null && isToolModelCutView(modelFacingResultText)
      ? [{ type: 'text', text: modelFacingResultText }]
      : toolResult,
    metadata: mergedMetadata,
    isSubagent: normalized.isSubagent,
    toolProvider: normalized.toolProvider
  }
  const compact = normalizeCompactTool(compactInput)
  const utilityChild = compact.operationKind === 'subagent' && compact.metadata?.apiUtilityControlId === API_UTILITY_CONTROL_IDS.subagent &&
    compact.metadata?.isSubagent === true ? compact.metadata : undefined
  const compactToolResult =
    compact.operationKind === 'subagent' &&
    compact.toolResult &&
    typeof compact.toolResult === 'object' &&
    !Array.isArray(compact.toolResult) &&
    Array.isArray((normalized.toolResult as any)?.intermediateSteps)
      ? {
          ...compact.toolResult,
          intermediateSteps: (normalized.toolResult as any).intermediateSteps
        }
      : compact.toolResult

  const normalizedToolName = (normalized.toolName || sourceToolName || '').trim().toLowerCase()
  const settingsIdentity = resolveToolActivitySettingsName(compactInput, compact.operationKind)
  const effectiveToolName =
    normalized.isSubagent || normalized.toolProvider === 'subagent'
      ? 'subagent'
      : settingsIdentity || normalized.toolName || sourceToolName || 'tool'
  const inferredDisplayToolName =
    sourceToolName && sourceToolName !== normalized.toolName ? sourceToolName : undefined
  // A lane's own label for its step comes next (the Claude adapter names Claude Code's `Agent` helper
  // `Claude Code Helper`, SA-111 P4): the card showed the raw tool name until it was read here (BL-15).
  const displayToolName =
    compact.displayToolName ??
    step.displayToolName ??
    (isMode1NativePackToolName(normalizedToolName)
      ? effectiveToolName && effectiveToolName !== compact.operationKind
        ? effectiveToolName
        : formatMode1NativePackDisplayName(compact.operationKind, compact.rendererFamily)
      : inferredDisplayToolName)

  const payload: NormalizedCoolTool = {
    schemaVersion: TOOL_ACTIVITY_SCHEMA_VERSION,
    type: 'tool',
    toolName: effectiveToolName,
    displayToolName,
    originalToolName: normalized.originalToolName || sourceToolName,
    operationKind: compact.operationKind,
    rendererFamily: compact.rendererFamily,
    toolCallId: (step as any).toolCallId || (step as any).id,
    toolArgs: compact.toolArgs,
    toolResult: compactToolResult,
    observation: compactToolResult,
    error: normalized.error ?? base.error,
    timestamp: normalized.timestamp || new Date().toISOString(),
    toolProvider: normalized.toolProvider,
    toolSource: normalized.toolSource,
    gatewayId: normalized.gatewayId,
    gatewayName: normalized.gatewayName,
    gatewayType: normalized.gatewayType,
    mcpServerName: normalized.mcpServerName,
    isSubagent: utilityChild ? true : normalized.isSubagent,
    subagentName: utilityChild ? utilityChild.subagentName : normalized.subagentName,
    subagentId: utilityChild ? utilityChild.subagentId : (step as any).subagentId,
    subagentAvatar: utilityChild ? utilityChild.subagentAvatar : (step as any).subagentAvatar,
    agentName: normalized.agentName,
    rawSidecar: {
      status: 'not_retained',
      reason: compact.rawReason || 'not-needed-for-main-payload'
    },
    storage: {
      compacted: compact.flags.compacted,
      truncated: compact.flags.truncated,
      binaryLikeOmitted: compact.flags.binaryLikeOmitted,
      forceCompress: false
    },
    metadata: {
      ...mergedMetadata,
      ...(compact.metadata ?? {}),
      operationKind: compact.operationKind,
      rendererFamily: compact.rendererFamily
    }
  }

  const rawSidecarPayload = {
    schemaVersion: TOOL_ACTIVITY_SCHEMA_VERSION,
    type: 'tool_raw',
    toolName: payload.toolName,
    displayToolName: payload.displayToolName,
    originalToolName: payload.originalToolName,
    toolProvider: payload.toolProvider,
    toolSource: payload.toolSource,
    operationKind: payload.operationKind,
    rendererFamily: payload.rendererFamily,
    toolCallId: payload.toolCallId,
    toolArgs,
    toolResult,
    error: payload.error,
    timestamp: payload.timestamp,
    metadata: payload.metadata
  }
  const rawSidecarContent = JSON.stringify(rawSidecarPayload, getCircularReplacer())
  const rawTokens = calculateTokens(rawSidecarContent)
  const compactTokens = calculateTokens(JSON.stringify(payload, getCircularReplacer()))
  const retainRawSidecar = shouldRetainRawSidecar({
    policy: compact.rawSidecarPolicy,
    compacted: compact.flags.compacted,
    truncated: compact.flags.truncated,
    binaryLikeOmitted: compact.flags.binaryLikeOmitted,
    rawTokens,
    compactTokens
  })
  const forceCompress = shouldForceCompressToolPayload({
    rawTokens,
    compactTokens
  })

  payload.storage = {
    compacted: compact.flags.compacted,
    truncated: compact.flags.truncated,
    binaryLikeOmitted: compact.flags.binaryLikeOmitted,
    forceCompress
  }
  payload.rawSidecar = retainRawSidecar
    ? {
        status: 'stored'
      }
    : {
        status: 'not_retained',
        reason: compact.rawReason || 'compact-main-payload'
      }
  payload.metadata = {
    ...(payload.metadata || {}),
    forceCompress,
    compacted: compact.flags.compacted,
    truncated: compact.flags.truncated,
    binaryLikeOmitted: compact.flags.binaryLikeOmitted
  }

  return {
    payload,
    rawSidecarContent: retainRawSidecar ? rawSidecarContent : null,
    rawSidecarCandidate: rawSidecarContent,
    rawSidecarReason: compact.rawReason,
    rawTokens,
    compactTokens,
    forceCompress,
    modelFacingResultTokens: modelFacingResultText === null ? 0 : calculateTokens(modelFacingResultText)
  }
}

function normalizeCoolTool(step: any): NormalizedCoolTool {
  return prepareCoolTool(step).payload
}

function transformStepToContent(step: any): string {
  try {
    const prepared = prepareCoolTool(step)
    return JSON.stringify(prepared.payload, getCircularReplacer())
  } catch (error) {
    console.error('[CoolToolZipAdapter] Failed to stringify tool result:', error)
    return JSON.stringify({
      tool: step.tool || step.action?.tool || 'unknown',
      error: 'Failed to serialize tool result',
      originalError: error?.toString()
    }, getCircularReplacer())
  }
}

/**
 * BL-1652: a command that read several files is stored as one zip per file it read, plus one
 * Bash zip for what its other commands printed (`ls`, `npm test`), when the native Bash result
 * carries a split proven against the files (`readSplit`, `nativeTools.ts` and `shellReadSplit.ts`)
 * that still covers its stdout exactly. Each part is an ordinary step: a Read File of that file
 * alone, whose command (`cd <dir> && cat a.js`) is what the dead-copy ledger and holds read, so an
 * edit of one file retires that file's copy only. Every part keeps the call's `toolCallId`; a
 * separators-only remainder (`echo ---`) is dropped. Any other step is returned as it is.
 */
type ShellReadSplitStepPart = { index: number; of: number; command: string }

/**
 * SA-137: the native Bash tool's read proof (`fileReadProof`, sent only with live file reads on)
 * for one stored part: the run's proof, the part's index in the run's split (null for a one-file
 * read), and the file the part names. The zip adapter turns it into the zip's `fileReadSource`.
 */
type FileReadProofPart = { proof: unknown; part: number | null; file?: string }
type ExpandedStep = { step: any; part: ShellReadSplitStepPart | null; readProof?: FileReadProofPart }

/** The step with its read proof taken out of every place a result can sit; the stored payload never keeps it. */
function withoutFileReadProof(step: any): any {
  const strip = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('fileReadProof' in value)) return value
    const { fileReadProof: _proof, ...rest } = value as Record<string, unknown>
    return rest
  }
  const next = { ...step }
  for (const key of ['output', 'toolResult', 'toolOutput', 'result', 'observation'] as const) {
    if (key in next) next[key] = strip(next[key])
  }
  return next
}

/**
 * SA-136 P2b: the API lane's typed `read_file`, by its exact registered name (`buildMode3NativeTools`
 * adds it on the API lane only), carries its own read proof: one read, part null. The stored
 * payload never keeps the proof, and the descriptor is written only when its in-process seal
 * verifies (`adaptCoolToolsToZipSystem`), so a tool of the same name on another lane, or a posted
 * result, is data. Null for any other step.
 */
function expandTypedFileRead(step: any): ExpandedStep[] | null {
  if (step?.originalToolName !== 'read_file') return null
  const output = step?.output
  const result = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, any>) : null
  if (!result || !('fileReadProof' in result)) return null
  return [{ step: withoutFileReadProof(step), part: null, readProof: { proof: result.fileReadProof, part: null } }]
}

/**
 * The API lane's own Bash tool, by its exact name: only `buildMode3NativeTools`' `native_bash_execute`
 * asks for a split (review: a last-part match let `mcp__any__native_bash_execute` through).
 */
function isNativeBashCall(name: unknown): boolean {
  return name === 'native_bash_execute'
}

function expandShellReadSplit(step: any): ExpandedStep[] {
  const output = step?.output
  const result = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, any>) : null
  // Only the native Bash tool's own local run writes a split (review: a tool result of any other
  // origin that carries the same field, an MCP or n8n answer, is data and stays one zip).
  const nativeOrigin = isNativeBashCall(step?.originalToolName) && result?.backend === 'local' && typeof result?.mappedReason === 'string'
  // SA-137: the read proof travels only from the native Bash tool's own run, and the adapter still
  // checks its in-process seal (`fileReadProofSeal.ts`), so a proof posted from anywhere else is data.
  // Round 2: a run inside a sandbox that mounts the host workspace (Apple Container, Docker Sandbox)
  // proves its single-file read host-side too; its proof travels when it names the run's own backend.
  const proofBackend = (result?.fileReadProof as { backend?: unknown } | undefined)?.backend
  const proofOrigin = isNativeBashCall(step?.originalToolName) && typeof result?.mappedReason === 'string' &&
    (result?.backend === 'local' || result?.backend === 'apple_container' || result?.backend === 'docker_sandbox') &&
    proofBackend === result?.backend
  const proof = proofOrigin && result && 'fileReadProof' in result ? result.fileReadProof : undefined
  // A proof the gate did not accept (another backend than the run's, a posted copy) is never stored either.
  const whole = (): ExpandedStep[] =>
    proof === undefined
      ? [{ step: isNativeBashCall(step?.originalToolName) ? withoutFileReadProof(step) : step, part: null }]
      : [{ step: withoutFileReadProof(step), part: null, readProof: { proof, part: null } }]
  const split = result && nativeOrigin ? validShellReadSplit(result.readSplit, result.stdout) : null
  if (!result || !split) return whole()
  const kept = split.parts.filter((part) => part.kind === 'read' || (!part.separatorsOnly && part.end > part.start))
  if (kept.length < 2) return whole()
  const { readSplit: _readSplit, truncated: _truncated, fileReadProof: _fileReadProof, ...baseResult } = result
  const args = step.input && typeof step.input === 'object' && !Array.isArray(step.input) ? step.input : {}
  const originalToolName = args.originalToolName ?? step.originalToolName ?? 'native_bash_execute'
  return kept.map((part: ShellReadSplitPart, index) => {
    const splitPart: ShellReadSplitStepPart = { index, of: kept.length, command: split.command }
    const text = result.stdout.slice(part.start, part.end)
    const isRead = part.kind === 'read'
    const toolName = isRead ? 'batshit_server_read_file' : 'native_bash_execute'
    const partArgs = isRead
      ? { command: part.command, innerCommand: part.command, filePath: part.path, path: part.path, originalToolName }
      : { command: part.command, innerCommand: part.command, originalToolName }
    const { originalToolName: _origin, ...mappedInput } = partArgs
    const partResult = {
      ...baseResult,
      input: partArgs,
      command: part.command,
      stdout: text,
      stderr: '',
      mappedToolName: toolName,
      mappedToolInput: mappedInput,
      mappedReason: isRead ? 'read-command' : 'fallback-command',
      shellReadSplitPart: splitPart
    }
    return {
      part: splitPart,
      ...(isRead && proof !== undefined ? { readProof: { proof, part: split.parts.indexOf(part), file: part.path } } : {}),
      step: {
        ...withoutFileReadProof(step),
        tool: toolName,
        toolName,
        originalToolName,
        input: partArgs,
        toolInput: partArgs,
        toolArgs: partArgs,
        output: partResult,
        toolResult: partResult,
        metadata: { ...(step.metadata || {}), shellReadSplitPart: splitPart }
      }
    }
  })
}

/** A folder as a shell word: bare when it is plain, single-quoted otherwise. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * SA-126 item 2: a native Bash call that applied a managed patch and then ran the commands after
 * it (`managedApplyPatch.afterPatch`, `nativeTools.ts`) is stored as two ordinary parts, in call
 * order, through the same per-call part path as BL-1652's reads (one `toolCallId`, the same part
 * ids and Tool Note line):
 *
 * - part 0, the patch: a successful managed edit, whatever the commands after it did, so the card,
 *   the AI view, its label, holds and the dead-copy ledger keep the applied-edit fact even when the
 *   call failed (Ashe's contract). Before, such a call was stored as a failed edit (the run's exit
 *   code and output), which every reader takes for "nothing was written".
 * - part 1, the commands: their run (exit code, output, Stop, timeout, cut, shell, backend), as the
 *   shared mapper reads their text (`npm test` is Bash, `cat a.js` a Read of the file as patched).
 *   Its command is `cd <folder> && <what ran>` when the patch had a `cd`: a label, never run.
 *
 * Each part gets its own step error: the call's ("The command failed with exit code 1.") belongs
 * to part 1 only. Any other step is returned as it is.
 */
function expandManagedPatchAfterCommand(step: any): ExpandedStep[] | null {
  const output = step?.output
  const result = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, any>) : null
  const patch = result?.managedApplyPatch
  const nativeOrigin = isNativeBashCall(step?.originalToolName) && typeof result?.mappedReason === 'string'
  if (!result || !nativeOrigin || !patch || patch.applied !== true || typeof patch.afterPatch?.command !== 'string') return null
  const originalCommand = typeof result.command === 'string' ? result.command : ''
  const parsed = parseManagedApplyPatchCommand(originalCommand)
  if (parsed.kind !== 'managed' || !parsed.afterPatch) return null

  const args = step.input && typeof step.input === 'object' && !Array.isArray(step.input) ? step.input : {}
  const originalToolName = args.originalToolName ?? step.originalToolName ?? 'native_bash_execute'
  const {
    managedApplyPatch: _patch, shell: _shell, stopped: _stopped, reason: _reason, error: _error, errorCode: _errorCode,
    stdout: _stdout, stderr: _stderr, exitCode: _exitCode, signal: _signal, timedOut: _timedOut, truncated: _truncated,
    sandboxName: _sandboxName, neverReturned: _neverReturned, fileReadProof: _fileReadProof, ...callResult
  } = result
  // BL-1978: the call was still running when BL-1959's Stop rule ended the stream; its patch had
  // applied (it reported so), and the commands after it returned no result.
  const neverReturned = result.neverReturned === true
  const parts: Array<{ toolName: string; input: Record<string, any>; result: Record<string, any> }> = []

  // Part 0: the patch, applied.
  const { afterPatch: _after, afterPatchStarted: _started, ...appliedPatch } = patch
  parts.push({
    toolName: step.toolName,
    input: args,
    result: {
      ...callResult,
      success: true,
      blocked: false,
      stdout: `Managed apply_patch applied ${appliedPatch.operationsApplied ?? 0} operation(s).`,
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      managedApplyPatch: appliedPatch
    }
  })

  // Part 1: the commands after it, as they ran (or why they never started).
  const command = `${parsed.cdPath !== null ? `cd ${shellWord(parsed.cdPath)} && ` : ''}${patch.afterPatch.command}`
  const mapping = mapBashCommandToRendererTool(command)
  const neverStarted = !neverReturned && patch.afterPatchStarted !== true
  const partArgs = { ...(mapping.args || {}), command, innerCommand: command, originalToolName }
  const { originalToolName: _origin, ...mappedInput } = partArgs
  const { mappedToolName: _m, mappedToolInput: _mi, mappedReason: _mr, diff: _diff, ...runFacts } = callResult
  parts.push({
    toolName: mapping.toolName,
    input: partArgs,
    result: {
      ...runFacts,
      success: result.success === true,
      blocked: false,
      command,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      timedOut: result.timedOut === true,
      truncated: result.truncated === true,
      ...(result.shell ? { shell: result.shell } : {}),
      ...(result.sandboxName ? { sandboxName: result.sandboxName } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.stopped ? { stopped: true } : {}),
      ...(neverReturned ? { neverReturned: true } : {}),
      ...(neverStarted
        ? { reason: result.stopped ? 'Never started: the reply was stopped after the patch applied.' : result.reason, neverStarted: true }
        : result.reason ? { reason: result.reason } : {}),
      mappedToolName: mapping.toolName,
      mappedToolInput: mappedInput,
      mappedReason: mapping.reason
    }
  })

  return parts.map((entry, index) => {
    const splitPart: ShellReadSplitStepPart = { index, of: parts.length, command: originalCommand }
    const partResult = { ...entry.result, input: entry.input, shellReadSplitPart: splitPart }
    const error = toolStepFailureMessage(entry.toolName, entry.input, partResult)
    return {
      part: splitPart,
      step: {
        ...step,
        tool: entry.toolName,
        toolName: entry.toolName,
        originalToolName,
        input: entry.input,
        toolInput: entry.input,
        toolArgs: entry.input,
        output: partResult,
        toolResult: partResult,
        error,
        type: error ? 'tool_error' : 'tool',
        success: !error,
        metadata: { ...(step.metadata || {}), shellReadSplitPart: splitPart }
      }
    }
  })
}

/**
 * A split part's own zip id, from its call's reserved id: the first part takes the reserved id,
 * a later part a fixed id made from it, so both zip-writing sites (the stream and the finish)
 * would store the same id for the same part. It keeps zipService's id shape (`<type>_<ms>_<tail>`)
 * and never an all-digit tail (BL-853).
 */
function shellReadSplitZipId(reservedZipId: string | undefined, part: ShellReadSplitStepPart | null): string | undefined {
  if (!reservedZipId || !part || part.index === 0) return reservedZipId
  const match = reservedZipId.match(/^([a-zA-Z][a-zA-Z0-9_-]*_\d{10,17})_[a-z0-9]{5,12}$/)
  if (!match) return undefined
  let hash = 0x811c9dc5
  for (const char of `${reservedZipId}#${part.index}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${match[1]}_s${part.index.toString(36)}${hash.toString(36).padStart(7, '0').slice(0, 7)}`
}

function getReservedZipIdForToolCall(
  source: ReservedZipIdSource | undefined,
  toolCallId: string | undefined
): string | undefined {
  if (!source || !toolCallId) return undefined
  if (source instanceof Map) return source.get(toolCallId)
  return source[toolCallId]
}

/**
 * Main adapter function - transforms intermediateSteps to standard zip references
 *
 * This is the ONLY place in the entire codebase that knows Cool Tools
 * have a special format (intermediateSteps array). Once transformed,
 * they become standard zips that flow through the existing system.
 *
 * @param intermediateSteps - Array of tool execution results from Batshit tool transports
 * @param sessionId - Current session ID
 * @param messageId - Current message ID
 * @param agentSettings - Agent settings including buffer/threshold
 * @returns Array of standard zip references
 */
export async function adaptCoolToolsToZipSystem(
  intermediateSteps: any[] | null | undefined,
  sessionId: string,
  messageId: string,
  agentSettings: Partial<AgentRow> = {},
  globalSettings: Record<string, any> | undefined = undefined,
  options: CoolToolZipAdapterOptions = {}
): Promise<ZipReference[]> {
  // Defensive programming - handle all edge cases gracefully
  if (!intermediateSteps || !Array.isArray(intermediateSteps)) {
    return []
  }

  if (intermediateSteps.length === 0) {
    return []
  }

  // Transform each step, handling errors gracefully
  const zipReferences: ZipReference[] = []
  const validSteps: {
    index: number
    prepared: PreparedCoolTool
    part: ShellReadSplitStepPart | null
    fileReadSource: FileReadSource | null
  }[] = []

  // First pass: validate and prepare all steps
  intermediateSteps.forEach((step, index) => {
    const validStep = normalizeIntermediateStep(step)
    if (!validStep) return
    // SA-104 P3 (DL-104-17): memory tools are exempt from zip-first treatment. Their
    // responses are summary-first references by contract, and remembered content is
    // persisted across turns only through the DCM insert channel — a cool-tool zip here would double-store
    // memory content as tool output. Tradeoff: memory broker calls render no persistent
    // cool-tool card (Execution Viewer still records them).
    if (isTransientContextControlToolStep(validStep)) {
      logger.debug('[CoolToolZipAdapter] Skipping zip for memory control step (DL-104-17)', {
        toolName: validStep?.toolName ?? validStep?.tool ?? null
      })
      return
    }
    // A call's parts: a patch and the commands after it (SA-126 item 2), or a split read (BL-1652).
    for (const { step: partStep, part, readProof } of
      expandManagedPatchAfterCommand(validStep) ?? expandTypedFileRead(validStep) ?? expandShellReadSplit(validStep)) {
      const prepared = prepareCoolTool(partStep)
      // SA-137: a proven read of one file, bound to this chat, this reply and this call.
      const fileReadSource =
        readProof && prepared.payload.operationKind === 'read_file' && verifyFileReadProofSeal(readProof.proof)
          ? fileReadSourceFromProof(readProof.proof, {
              sessionId,
              messageId,
              toolCallId: prepared.payload.toolCallId,
              part: readProof.part,
              ...(readProof.file !== undefined ? { file: readProof.file } : {})
            })
          : null
      validSteps.push({ index, prepared, part, fileReadSource })
    }
  })

  // If no valid steps, return empty
  if (validSteps.length === 0) {
    return []
  }

  // Deduplicate by toolCallId only to avoid multiple cool_tool zips for a single
  // execution when transports emit duplicate lifecycle events. If toolCallId is missing, assume each entry is distinct.
  const seenCallIds = new Set<string>()
  const dedupedSteps: typeof validSteps = []
  for (const entry of validSteps) {
    const callId = entry.prepared.payload.toolCallId
    if (callId) {
      const key = entry.part ? `id:${callId}#${entry.part.index}` : `id:${callId}`
      if (seenCallIds.has(key)) continue
      seenCallIds.add(key)
    }
    dedupedSteps.push(entry)
  }

  // Second pass: ZIP-FIRST APPROACH
  // ALWAYS create zips for ALL tools - buffer/threshold control RENDERING only (in compileForAI)
  for (let i = 0; i < dedupedSteps.length; i++) {
    const { index, prepared, part, fileReadSource } = dedupedSteps[i]
    const writeStep = async () => {
    const step = prepared.payload
    const reservedZipId = shellReadSplitZipId(
      getReservedZipIdForToolCall(options.reservedZipIdsByToolCallId, step.toolCallId),
      part
    )
    const resultLineCount = inferCoolToolResultLineCount(step)
    const zipDescriptionHints = buildZipDescriptionHints(step, resultLineCount)
    let previousSkillZip: any = null
    if (reservedZipId && step.operationKind === 'skill_read' && options.skillSessionActor) {
      try {
        previousSkillZip = await redis.json.get(`zip:${reservedZipId}`)
        const receipt = previousSkillZip?.metadata?.skillSessionReadReceipt ?? previousSkillZip?.metadata?.skillSessionAdmission
        if (receipt) {
          if (previousSkillZip.metadata?.sessionId !== sessionId || previousSkillZip.metadata?.messageId !== messageId ||
              previousSkillZip.metadata?.toolCallId !== step.toolCallId || receipt.agentId !== options.skillSessionActor.agentId) {
            throw new Error('An earlier skill read belongs to another execution owner.')
          }
          const oldPayload = parseCoolToolPayload(previousSkillZip.content)
          const incoming = oldPayload && shouldPreferRawSidecarForAiExpansion(oldPayload)
            ? parseCoolToolPayload(prepared.rawSidecarContent) : step
          if (!incoming || receipt.transcriptSha256 !== originalCoolToolReadDigest(incoming)) {
            throw new Error('An earlier admitted skill read changed during same-call replay.')
          }
          zipReferences.push({ zipId: reservedZipId, placeholder: `{{ZIP_COOL_TOOL_${index}}}`,
            reference: `{{batshit-zip:${reservedZipId}:::${previousSkillZip.description || 'Skill read'}}}`,
            position: { start: index, end: index }, skillSessionChanged: false,
            ...(!previousSkillZip.metadata?.skillSessionAdmission ? { skillSessionError:
              'This earlier skill read was not confirmed open. Make a new skill read if you still need it; replaying the old call cannot open it.' } : {}) })
          return
        }
      } catch (error) {
        console.error('[CoolToolZipAdapter] Refused an unverifiable skill read replay:', error)
        zipReferences.push({ reference: '', skillSessionError:
          'Batshit could not verify the earlier skill read, so it did not rewrite or reopen it. Make a new skill read if needed.' })
        return
      }
    }

    if (step.operationKind === 'skill_read' && options.beforeSkillReadPersist) await options.beforeSkillReadPersist()

    if (prepared.rawSidecarContent) {
      try {
        const rawSidecarZip = await createZipFromContent(
          prepared.rawSidecarContent,
          'tool_raw',
          sessionId,
          messageId,
          {
            language: 'json',
            toolName: step.toolName || 'tool',
            operationKind: step.operationKind,
            rendererFamily: step.rendererFamily,
            rawSidecar: true,
            toolCallId: step.toolCallId,
            resultLineCount,
            contentLineCount: resultLineCount,
            description: `Raw tool payload: ${step.displayToolName || step.toolName || 'tool'}`,
            reason: prepared.rawSidecarReason
          }
        )

        if (rawSidecarZip?.zipId) {
          step.rawSidecar = {
            status: 'stored',
            zipId: rawSidecarZip.zipId,
            reason: prepared.rawSidecarReason
          }
          if (step.metadata) {
            step.metadata.rawSidecarZipId = rawSidecarZip.zipId
          }
        }
      } catch (error) {
        console.error('[CoolToolZipAdapter] Failed to create raw sidecar zip:', error)
        step.rawSidecar = {
          status: 'not_retained',
          reason: 'raw-sidecar-write-failed'
        }
      }
    }

    const rawSidecarPayload =
      prepared.rawSidecarContent && shouldPreferRawSidecarForAiExpansion(step)
        ? parseCoolToolPayload(prepared.rawSidecarContent)
        : null
    const promptPayload = rawSidecarPayload || step
    let content = JSON.stringify(step, getCircularReplacer())
    const promptContent = buildCoolToolAiContent(
      step.rawSidecar?.zipId || `${messageId}:${index}`,
      {
        content,
        metadata: step.metadata || {}
      },
      promptPayload
    )
    const promptTokens = Math.max(calculateTokens(promptContent), prepared.modelFacingResultTokens)
    const promptForceCompress = promptTokens >= TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS
    // Stored JSON can repeat/escape the body. Only the transcript the model reads
    // determines the size stamp; activation rechecks that live estimate (BL-493/494).
    const forceCompress = promptForceCompress
    if (forceCompress !== prepared.forceCompress) {
      step.storage = {
        compacted: step.storage?.compacted ?? false,
        truncated: step.storage?.truncated ?? false,
        binaryLikeOmitted: step.storage?.binaryLikeOmitted ?? false,
        forceCompress
      }
      step.metadata = {
        ...(step.metadata || {}),
        forceCompress
      }
    }
    content = JSON.stringify(step, getCircularReplacer())
    const storageTokens = calculateTokens(content)

    try {
      const toolName = step.toolName || 'tool'
      const settingsToolName =
        step.isSubagent || step.toolProvider === 'subagent'
          ? 'subagent'
          : step.operationKind === 'dynamic_use' || step.operationKind === 'cli_tool'
            ? toolName
            : step.operationKind || toolName
      const toolSettings = getToolSettings(settingsToolName, agentSettings, globalSettings, {
        ignoreCustomToolSettings:
          Boolean(step.operationKind) && shouldPreferFieldSettingsForTool(step.operationKind)
      })
      const bufferSize = toolSettings.buffer_size
      const threshold = toolSettings.zip_threshold

      // Create metadata for the Cool Tool
      const metadata = {
        toolName,
        displayToolName: step.displayToolName,
        operationKind: step.operationKind,
        rendererFamily: step.rendererFamily,
        ...zipDescriptionHints,
        toolIndex: index,
        tokens: promptTokens,
        aiTokens: promptTokens,
        promptTokens,
        aiChars: promptContent.length,
        storageTokens,
        storageChars: content.length,
        tokenBasis: prepared.modelFacingResultTokens > calculateTokens(promptContent)
          ? 'model_facing_mcp_text'
          : 'ai_expanded',
        originalType: 'cool_tool',
        bufferSize,
        threshold,
        toolCallId: step.toolCallId,
        toolProvider: step.toolProvider,
        toolSource: step.toolSource,
        gatewayId: step.gatewayId,
        gatewayName: step.gatewayName,
        gatewayType: step.gatewayType,
        mcpServerName: step.mcpServerName,
        isSubagent: step.isSubagent === true,
        subagentId: step.subagentId,
        subagentName: step.subagentName,
        subagentAvatar: step.subagentAvatar,
        agentName: step.agentName,
        timestamp: step.timestamp,
        forceCompress,
        rawSidecarZipId: step.rawSidecar?.zipId,
        resultLineCount,
        contentLineCount: resultLineCount,
        ...(part ? { shellReadSplitPart: part } : {}),
        ...(fileReadSource ? { fileReadSource } : {})
      }

      // ⭐ ZIP-FIRST: Create permanent zip for EVERY tool (no conditional check)
      // Buffer/threshold settings are applied later in compileForAI() for activation/rendering
      // This ensures ALL tools are stored in Redis as zips, and activation is controlled at render time
      const persist = async () => {
        // A reserved zip is rewritten by lifecycle/finalize retries. Preserve its original
        // consumed-read stamp only when this same reply and call own it.
        const previous = previousSkillZip
        const admission = previous?.metadata?.sessionId === sessionId && previous?.metadata?.messageId === messageId &&
          previous?.metadata?.toolCallId === step.toolCallId ? previous?.metadata?.skillSessionAdmission : undefined
        if (admission && admission.transcriptSha256 !== originalCoolToolReadDigest(promptPayload)) {
          throw new Error('An admitted skill read changed during same-call replay; its original stored read was retained.')
        }
        const result = await createZipFromContent(
        content,
        'cool_tool',
        sessionId,
        messageId,
        { ...metadata, ...(admission ? { skillSessionAdmission: admission } : {}),
          ...(options.skillSessionActor && step.operationKind === 'skill_read' && isSkillLifecycleProducer(step)
            ? { skillSessionReadReceipt: { agentId: options.skillSessionActor.agentId,
                transcriptSha256: originalCoolToolReadDigest(promptPayload) } } : {}) },
        reservedZipId ? { zipId: reservedZipId } : undefined
      )
        let skillSessionChanged = false
        let skillSessionError: string | undefined
        if (options.skillSessionActor && step.operationKind === 'skill_read' && isSkillLifecycleProducer(step)) {
          try {
            skillSessionChanged = await openSkillSessionRead({
              ...options.skillSessionActor, sessionId, messageId, rawZipId: result.zipId
            })
          } catch (error) { skillSessionError = error instanceof Error ? error.message : String(error) }
        }
        return { ...result, skillSessionChanged, skillSessionError }
      }
      const result = options.skillSessionActor && step.operationKind === 'skill_read'
        ? await withZipStateLock(sessionId, persist) : await persist()

      if (result) {
        const reference: ZipReference = {
          zipId: result.zipId,
          placeholder: `{{ZIP_COOL_TOOL_${index}}}`,
          reference: result.reference,
          position: {
            start: index,
            end: index
          }
        }
        zipReferences.push(reference)
        reference.skillSessionChanged = result.skillSessionChanged
        reference.skillSessionError = result.skillSessionError
        if (result.skillSessionChanged && options.skillSessionActor) {
          try {
            await publishUserEvent(options.skillSessionActor.userId, {
              type: 'zip_state_changed', sessionId, source: 'agent', opened: [result.zipId], rezipped: []
            })
          } catch {
            reference.skillSessionError = 'The skill opened, but Batshit could not refresh the live skill indicator. Refresh the chat to read its current state.'
          }
        }
      }
    } catch (error) {
      console.error(`[CoolToolZipAdapter] Failed to create zip for tool ${i}:`, error)
      if (options.skillSessionActor && step.operationKind === 'skill_read') {
        zipReferences.push({ reference: '', skillSessionError:
          'Batshit could not confirm the stored skill read, so it did not rewrite or reopen that read. Check open_skills before continuing.' })
      }
      // Continue processing other tools even if one fails
    }
    }
    if (options.skillSessionActor && prepared.payload.operationKind === 'skill_read') await withZipStateLock(sessionId, writeStep)
    else await writeStep()
  }

  return zipReferences
}

/**
 * SA-137: whether this stored copy's transcript can be rebuilt for today's file: a native Bash read
 * in a Bash view (`refreshedReadTranscript`), or SA-136's typed `read_file`, by its exact registered
 * name, in its typed view (`refreshedTypedReadTranscript`).
 */
export function canRefreshReadTranscript(stored: Record<string, any> | null | undefined, view: FileReadView): boolean {
  if (stored?.operationKind !== 'read_file') return false
  return view.kind === 'typed' ? stored.originalToolName === TYPED_READ_FILE_TOOL : isNativeBashCall(stored.originalToolName)
}

type RefreshedReadTranscript = { text: string; parts: CoolToolAiContentPart[]; promptTokens: number }

/**
 * SA-137 (live file reads): a stored Read File copy as the model would read it had its command printed
 * `stdout` now: the same pipeline a fresh read takes (`prepareCoolTool` on the stored call with the
 * new output), so the transcript has the same form (sanitized tabs and line ends, the same preview
 * cut, the raw sidecar's full text when the preview was cut), and the same prompt-token count the
 * adapter would stamp. Nothing is stored. Null for anything that is not a native Bash Read File.
 */
export function refreshedReadTranscript(
  zipId: string,
  stored: Record<string, any>,
  storedMetadata: Record<string, any>,
  stdout: string
): RefreshedReadTranscript | null {
  if (stored?.operationKind !== 'read_file' || !isNativeBashCall(stored.originalToolName)) return null
  const args = storedToolArgs(stored)
  const command = typeof args.innerCommand === 'string' ? args.innerCommand : typeof args.command === 'string' ? args.command : null
  if (!command) return null
  const prepared = prepareCoolTool({
    ...storedCallFields(stored),
    input: args,
    output: {
      success: true,
      blocked: false,
      command,
      stdout,
      stderr: '',
      exitCode: 0,
      backend: 'local',
      mappedToolName: 'read_file',
      mappedReason: 'read-command',
      originalToolName: stored.originalToolName,
      input: args
    }
  })
  return transcriptOfPrepared(zipId, stored, storedMetadata, prepared)
}

/**
 * SA-137 with SA-136: a stored typed `read_file` copy as the model would read a fresh call with the
 * same arguments on a file whose whole text is `fileText` now. The result is the tool's own
 * (`typedReadResultFromBytes`: its decoding, slicing and facts), prepared and formatted as the
 * adapter stores a fresh call. The stored arguments must give exactly the descriptor's `view`, as the
 * read's proof derived it. Null where they do not, where the tool would refuse those bytes, or where
 * the range no longer shows whole lines in full (cut, one partial line, or starting past the end of
 * a file that shrank): such a read is never proven, so it is never refreshed either.
 */
export function refreshedTypedReadTranscript(
  zipId: string,
  stored: Record<string, any>,
  storedMetadata: Record<string, any>,
  fileText: string,
  view: FileReadView
): RefreshedReadTranscript | null {
  if (stored?.operationKind !== 'read_file' || stored.originalToolName !== TYPED_READ_FILE_TOOL || view.kind !== 'typed') return null
  const args = storedToolArgs(stored)
  const filePath = typeof stored.toolResult?.filePath === 'string' ? stored.toolResult.filePath : null
  if (typeof args.path !== 'string' || !filePath) return null
  const offset = args.offset === undefined ? undefined : args.offset
  const limit = args.limit === undefined ? undefined : args.limit
  if ((offset !== undefined && !Number.isSafeInteger(offset)) || (limit !== undefined && !Number.isSafeInteger(limit))) return null
  // The range the proof derived from these same arguments (`typedReadProof`).
  const startLine = offset && offset > 0 ? offset : 1
  const endLine = limit && limit > 0 ? startLine + limit - 1 : null
  if (view.startLine !== startLine || view.endLine !== endLine) return null
  const input = { path: args.path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }
  const result = typedReadResultFromBytes(input, filePath, Buffer.from(fileText, 'utf8'))
  const facts = (result as Record<string, any> | null)?.typedFileRead
  if (!result || result.success !== true || !facts || facts.truncated || (result as Record<string, any>).partialLine) return null
  if (!facts.empty && facts.endLine < facts.startLine) return null
  return transcriptOfPrepared(zipId, stored, storedMetadata, prepareCoolTool({ ...storedCallFields(stored), input: args, output: result }))
}

function storedToolArgs(stored: Record<string, any>): Record<string, any> {
  return stored.toolArgs && typeof stored.toolArgs === 'object' && !Array.isArray(stored.toolArgs) ? stored.toolArgs : {}
}

/** The stored call's own fields a fresh read of it would carry. */
function storedCallFields(stored: Record<string, any>) {
  return {
    toolName: stored.toolName,
    originalToolName: stored.originalToolName,
    toolCallId: stored.toolCallId,
    timestamp: stored.timestamp,
    toolProvider: stored.toolProvider,
    toolSource: stored.toolSource,
    mcpServerName: stored.mcpServerName
  }
}

function transcriptOfPrepared(
  zipId: string,
  stored: Record<string, any>,
  storedMetadata: Record<string, any>,
  prepared: PreparedCoolTool
): RefreshedReadTranscript {
  // The compile expands the raw sidecar when the copy has one and its policy prefers it (a cut
  // preview, or an empty content). The stored copy's sidecar counts, so an unchanged file reads
  // exactly as stored; a refresh whose preview is now cut keeps the full text as a fresh read would.
  const storedSidecarId = typeof stored.rawSidecar?.zipId === 'string'
    ? stored.rawSidecar.zipId
    : typeof storedMetadata?.rawSidecarZipId === 'string' ? storedMetadata.rawSidecarZipId : null
  const sidecarId = storedSidecarId ?? (prepared.rawSidecarContent ? `${zipId}:refreshed-raw` : null)
  const payload = sidecarId
    ? { ...(prepared.payload as Record<string, any>), rawSidecar: { status: 'stored', zipId: sidecarId } }
    : (prepared.payload as Record<string, any>)
  const rawPayload = sidecarId && shouldPreferRawSidecarForAiExpansion(payload)
    ? parseCoolToolPayload(prepared.rawSidecarCandidate)
    : null
  const content = JSON.stringify(payload, getCircularReplacer())
  const formatted = buildCoolToolAiContentWithSources(zipId, { content, metadata: storedMetadata }, rawPayload ?? payload)
  return {
    text: formatted.text,
    parts: formatted.parts,
    promptTokens: Math.max(calculateTokens(formatted.text), prepared.modelFacingResultTokens)
  }
}

/**
 * Check if agent has Cool Tools settings configured
 * Helper for UI components to know if Cool Tools zipping is active
 */
export function hasSubagentToolSettings(settings: Partial<AgentRow>): boolean {
  return !!(
    settings.buffer_size_subagent !== undefined ||
    settings.zip_threshold_subagent !== undefined
  )
}

/**
 * Get default Cool Tools settings
 * Used when initializing new agents or UI components
 */
export function getDefaultSubagentSettings(): {
  buffer_size_subagent: number
  zip_threshold_subagent: number
} {
  return {
    buffer_size_subagent: 2,
    zip_threshold_subagent: 0
  }
}
