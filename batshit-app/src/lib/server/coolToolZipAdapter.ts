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
import { getToolSettings, shouldPreferFieldSettingsForTool } from '$lib/utils/toolRenderMap'
import type { IntermediateStep } from '$lib/utils/toolResultProcessor'
import { normalizeToolStep } from '$lib/utils/toolResultProcessor'
import {
  TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS,
  TOOL_ACTIVITY_SCHEMA_VERSION,
  normalizeCompactTool,
  resolveToolActivitySettingsName,
  shouldForceCompressToolPayload,
  shouldRetainRawSidecar,
  type ToolOperationKind,
  type ToolRendererFamily
} from '$lib/utils/toolActivityContract'
import {
  buildCoolToolAiContent,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import { isBrokerToolUseName } from '$lib/utils/toolNameNormalization'
import { isMemoryControlToolStep } from '$lib/utils/memoryControl'
import { logger } from '$lib/utils/logger'
import {
  normalizeToolPayload,
  parseJsonIfLikely,
  unwrapToolTextArray,
  unwrapDynamicMcpStep as unwrapDynamicMcpStepPayload
} from '$lib/utils/toolPayloadUnwrap'

type ReservedZipIdSource = Map<string, string> | Record<string, string | undefined>

type CoolToolZipAdapterOptions = {
  reservedZipIdsByToolCallId?: ReservedZipIdSource
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
  rawSidecarReason?: string
  rawTokens: number
  compactTokens: number
  forceCompress: boolean
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

  const exitCode =
    typeof result?.exitCode === 'number'
      ? result.exitCode
      : typeof result?.code === 'number'
        ? result.code
        : undefined
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
      return (
        formatCount(
          totalFromResult(result, ['totalItems', 'totalEntries']) ??
            arrayCountFromResult(result, ['files', 'items', 'entries']),
          'entry',
          'entries'
        ) || lineSize(resultLineCount)
      )
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
    toolName: normalized.toolName || sourceToolName || 'tool',
    originalToolName: normalized.originalToolName || sourceToolName,
    toolArgs,
    toolResult,
    metadata: mergedMetadata,
    isSubagent: normalized.isSubagent,
    toolProvider: normalized.toolProvider
  }
  const compact = normalizeCompactTool(compactInput)
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
  const displayToolName =
    compact.displayToolName ??
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
    isSubagent: normalized.isSubagent,
    subagentName: normalized.subagentName,
    subagentId: (step as any).subagentId,
    subagentAvatar: (step as any).subagentAvatar,
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
    rawSidecarReason: compact.rawReason,
    rawTokens,
    compactTokens,
    forceCompress
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
  const validSteps: { index: number; prepared: PreparedCoolTool }[] = []

  // First pass: validate and prepare all steps
  intermediateSteps.forEach((step, index) => {
    const validStep = normalizeIntermediateStep(step)
    if (!validStep) return
    // SA-104 P3 (DL-104-17): memory tools are exempt from zip-first treatment. Their
    // responses are summary-first references by contract, and remembered content is
    // persisted across turns only through the DCM insert channel — a cool-tool zip here would double-store
    // memory content as tool output. Tradeoff: memory broker calls render no persistent
    // cool-tool card (Execution Viewer still records them).
    if (isMemoryControlToolStep(validStep)) {
      logger.debug('[CoolToolZipAdapter] Skipping zip for memory control step (DL-104-17)', {
        toolName: validStep?.toolName ?? validStep?.tool ?? null
      })
      return
    }
    const prepared = prepareCoolTool(validStep)
    validSteps.push({ index, prepared })
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
      const key = `id:${callId}`
      if (seenCallIds.has(key)) continue
      seenCallIds.add(key)
    }
    dedupedSteps.push(entry)
  }

  // Second pass: ZIP-FIRST APPROACH
  // ALWAYS create zips for ALL tools - buffer/threshold control RENDERING only (in compileForAI)
  for (let i = 0; i < dedupedSteps.length; i++) {
    const { index, prepared } = dedupedSteps[i]
    const step = prepared.payload
    const reservedZipId = getReservedZipIdForToolCall(
      options.reservedZipIdsByToolCallId,
      step.toolCallId
    )
    const resultLineCount = inferCoolToolResultLineCount(step)
    const zipDescriptionHints = buildZipDescriptionHints(step, resultLineCount)

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
    const promptTokens = calculateTokens(promptContent)
    const promptForceCompress = promptTokens >= TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS
    const forceCompress = prepared.forceCompress || promptForceCompress
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
        tokenBasis: 'ai_expanded',
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
        contentLineCount: resultLineCount
      }

      // ⭐ ZIP-FIRST: Create permanent zip for EVERY tool (no conditional check)
      // Buffer/threshold settings are applied later in compileForAI() for activation/rendering
      // This ensures ALL tools are stored in Redis as zips, and activation is controlled at render time
      const result = await createZipFromContent(
        content,
        'cool_tool',
        sessionId,
        messageId,
        metadata,
        reservedZipId ? { zipId: reservedZipId } : undefined
      )

      if (result) {
        zipReferences.push({
          zipId: result.zipId,
          placeholder: `{{ZIP_COOL_TOOL_${index}}}`,
          reference: result.reference,
          position: {
            start: index,
            end: index
          }
        })
      }
    } catch (error) {
      console.error(`[CoolToolZipAdapter] Failed to create zip for tool ${i}:`, error)
      // Continue processing other tools even if one fails
    }
  }

  return zipReferences
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
