import { buildCompactEditPreview, extractManagedPatchFromSources } from './editDiff'
import { formatBatshitToolTargetDisplayName } from './toolNameFormatter'
import {
  collapseToolNameAlphanumeric,
  normalizeToolNameLower as normalizeName,
  slugToolName
} from './toolNameNormalization'
import { countTextLines, extractWriteContentFromSources } from './writePreview'

export const TOOL_ACTIVITY_SCHEMA_VERSION = 1
export const TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS = 10_000

const FILE_PREVIEW_CHARS = 150_000
const FILE_PREVIEW_LINES = 4_000
const READ_PREVIEW_CHARS = FILE_PREVIEW_CHARS
const READ_PREVIEW_LINES = FILE_PREVIEW_LINES
const WRITE_PREVIEW_CHARS = FILE_PREVIEW_CHARS
const WRITE_PREVIEW_LINES = FILE_PREVIEW_LINES
const EDIT_PREVIEW_CHARS = FILE_PREVIEW_CHARS
const EDIT_PREVIEW_LINES = FILE_PREVIEW_LINES
const BASH_STDOUT_PREVIEW_CHARS = 6_000
const BASH_STDOUT_PREVIEW_LINES = 220
const BASH_STDERR_PREVIEW_CHARS = 2_500
const BASH_STDERR_PREVIEW_LINES = 120
const WEB_SEARCH_RESULT_LIMIT = 8
const WEB_SEARCH_SNIPPET_CHARS = 400
const LIST_ITEM_LIMIT = 200
const SEARCH_FILE_LIMIT = 20
const SEARCH_MATCH_LIMIT = 5
const GENERIC_MAX_DEPTH = 4
const GENERIC_MAX_KEYS = 24
const GENERIC_MAX_ARRAY_ITEMS = 20
const GENERIC_MAX_STRING_CHARS = 2_000
const BINARY_LIKE_MIN_CHARS = 512
const FETCH_ZIP_CONTENT_PREVIEW_CHARS = 16_000
const FETCH_ZIP_CONTENT_PREVIEW_LINES = 800

export type ToolOperationKind =
  | 'read_file'
  | 'skill_read'
  | 'write_file'
  | 'edit_file'
  | 'web_search'
  | 'search_files'
  | 'list_files'
  | 'bash'
  | 'fetch_zip'
  | 'dynamic_find'
  | 'dynamic_use'
  | 'tool_find'
  | 'cli_tool'
  | 'agent_browser_find'
  | 'agent_browser_use'
  | 'artifact_find'
  | 'artifact_use'
  | 'fabric_find'
  | 'fabric_use'
  | 'subagent'
  | 'unknown_tool'

export type ToolRendererFamily =
  | 'read_file'
  | 'skill_read'
  | 'write_file'
  | 'edit_file'
  | 'web_search'
  | 'list_files'
  | 'bash'
  | 'dynamic_find'
  | 'tool_find'
  | 'cli_tool'
  | 'generic_tool'
  | 'subagent'

export type ToolRawSidecarPolicy = 'always' | 'limited' | 'never'

export interface CompactToolFlags {
  compacted: boolean
  truncated: boolean
  binaryLikeOmitted: boolean
}

export interface CompactToolNormalization {
  operationKind: ToolOperationKind
  rendererFamily: ToolRendererFamily
  displayToolName?: string
  toolArgs: Record<string, any>
  toolResult: any
  flags: CompactToolFlags
  rawSidecarPolicy: ToolRawSidecarPolicy
  rawReason?: string
  metadata?: Record<string, any>
}

export type CompactToolInput = {
  toolName?: string
  originalToolName?: string
  toolArgs?: Record<string, any> | null
  toolResult?: any
  metadata?: Record<string, any> | null
  isSubagent?: boolean
  toolProvider?: string
}

type TextPreview = {
  text: string
  truncated: boolean
}

const MODE4_INTERNAL_HELPER_SUFFIX = 'mode4-controls.'
const MODE4_INTERNAL_HELPER_TOOL_NAMES = new Set([
  'batshit_tool_search',
  'batshit_tool_use',
  'batshit_server_dynamic_mcp_find',
  'batshit_server_dynamic_mcp_use',
  'batshit_server_cli_tool_find',
  'batshit_server_cli_tool_use',
  'batshit_server_fetch_zip',
  'batshit_server_bash_execute',
  'mcp_artifact_find',
  'mcp_artifact_use',
  'mcp_fabric_find',
  'mcp_fabric_use',
  'native_skill',
  'native_skill_reference'
])

function canonicalizeMode4HelperSegment(value: string | undefined | null): string {
  return slugToolName(value)
}

function collapseAlphaNumeric(value: string | undefined | null): string {
  return collapseToolNameAlphanumeric(value)
}

function normalizeInternalMode4HelperName(value: string | undefined | null): string {
  const normalized = normalizeName(value)
  if (!normalized.startsWith('mcp.')) {
    return normalized
  }

  const parts = normalized.split('.')
  if (parts.length < 3) return normalized

  const toolSegment = parts.pop() ?? normalized
  const serverSegment = parts.slice(1).join('.')
  const isMode4HelperServer =
    collapseAlphaNumeric(serverSegment).includes('mode4controls') ||
    normalized.includes(MODE4_INTERNAL_HELPER_SUFFIX)

  if (!isMode4HelperServer) {
    return normalized
  }

  const canonicalTool = canonicalizeMode4HelperSegment(toolSegment)
  return MODE4_INTERNAL_HELPER_TOOL_NAMES.has(canonicalTool) ? canonicalTool : normalized
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

function unwrapSingleItemArray(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

function isNativeAutomationPackName(value: string | undefined | null): boolean {
  const collapsed = collapseAlphaNumeric(value)
  return collapsed === 'batshitnativetools' || collapsed === 'batshittools'
}

function isNativeAutomationEnvelope(value: unknown): value is Record<string, any> {
  return (
    isPlainObject(value) &&
    typeof value.action === 'string' &&
    ('data' in value || 'error' in value) &&
    ('success' in value || 'backend' in value || 'context' in value)
  )
}

function getNativeAutomationEnvelope(value: unknown): Record<string, any> | null {
  const candidate = unwrapSingleItemArray(parseMaybeJson(value))
  return isNativeAutomationEnvelope(candidate) ? candidate : null
}

function unwrapNativeAutomationData(value: unknown): unknown {
  const candidate = getNativeAutomationEnvelope(value)
  if (!candidate) {
    return unwrapMcpTextContentPayload(value)
  }
  return candidate.data ?? candidate
}

function unwrapMcpTextContentPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return value

  const candidate = unwrapSingleItemArray(parseMaybeJson(value))

  if (Array.isArray(candidate)) {
    if (candidate.length === 1) {
      return unwrapMcpTextContentPayload(candidate[0], depth + 1)
    }
    return candidate
  }

  if (!isPlainObject(candidate)) return candidate

  const content = candidate.content
  if (typeof content === 'string') {
    const parsedContent = parseMaybeJson(content)
    if (isPlainObject(parsedContent) || Array.isArray(parsedContent)) {
      return unwrapMcpTextContentPayload(parsedContent, depth + 1)
    }
  }
  if (isPlainObject(content)) {
    return unwrapMcpTextContentPayload(content, depth + 1)
  }
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0]
    if (isPlainObject(first) && 'text' in first) {
      const textPayload = parseMaybeJson(first.text)
      if (isPlainObject(textPayload) || Array.isArray(textPayload)) {
        return unwrapMcpTextContentPayload(textPayload, depth + 1)
      }
    }
  }

  if (
    candidate.text !== undefined &&
    candidate.output === undefined &&
    candidate.result === undefined &&
    candidate.data === undefined
  ) {
    const textPayload = parseMaybeJson(candidate.text)
    if (isPlainObject(textPayload) || Array.isArray(textPayload)) {
      return unwrapMcpTextContentPayload(textPayload, depth + 1)
    }
  }

  return candidate
}

function extractNativeMappedToolName(value: unknown): string | null {
  const normalized = unwrapNativeAutomationData(value)
  if (!isPlainObject(normalized)) return null

  const candidate =
    typeof normalized.mappedToolName === 'string'
      ? normalized.mappedToolName
      : typeof normalized.mapped_tool_name === 'string'
        ? normalized.mapped_tool_name
        : null

  return candidate && candidate.trim().length > 0 ? candidate.trim() : null
}

function extractNativeMappedToolInput(value: unknown): Record<string, any> | null {
  const normalized = unwrapNativeAutomationData(value)
  if (!isPlainObject(normalized)) return null

  if (isPlainObject(normalized.mappedToolInput)) {
    return { ...normalized.mappedToolInput }
  }

  if (isPlainObject(normalized.mapped_tool_input)) {
    return { ...normalized.mapped_tool_input }
  }

  return null
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function pickPlainObject(value: unknown): Record<string, any> | null {
  return isPlainObject(value) ? value : null
}

function normalizeExplicitOperationKind(value: unknown): ToolOperationKind | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  switch (normalized) {
    case 'read_file':
    case 'skill_read':
    case 'write_file':
    case 'edit_file':
    case 'web_search':
    case 'search_files':
    case 'list_files':
    case 'bash':
    case 'fetch_zip':
    case 'dynamic_find':
    case 'dynamic_use':
    case 'tool_find':
    case 'cli_tool':
    case 'agent_browser_find':
    case 'agent_browser_use':
    case 'artifact_find':
    case 'artifact_use':
    case 'fabric_find':
    case 'fabric_use':
    case 'subagent':
    case 'unknown_tool':
      return normalized as ToolOperationKind
    default:
      return null
  }
}

function firstSpecificToolName(
  operationKind: ToolOperationKind,
  ...values: unknown[]
): string | undefined {
  for (const value of values) {
    const candidate = firstString(value)
    if (!candidate) continue
    if (candidate === operationKind || candidate === 'unknown_tool') continue
    if (isNativeAutomationPackName(candidate)) continue
    return candidate
  }
  return undefined
}

function collectNativeInputRecords(toolArgs: Record<string, any>, toolResult: unknown) {
  const mappedInput = extractNativeMappedToolInput(toolResult)
  const resultData = pickPlainObject(unwrapNativeAutomationData(toolResult))
  const directInput = pickPlainObject(toolArgs.input)
  const argumentsRecord = pickPlainObject(toolArgs.arguments)
  const nestedInput = pickPlainObject(argumentsRecord?.input)
  const params = pickPlainObject(toolArgs.params)
  const nestedParams = pickPlainObject(argumentsRecord?.params)

  return {
    mappedInput,
    resultData,
    directInput,
    nestedInput,
    params,
    nestedParams
  }
}

export function resolveToolActivitySettingsName(
  input: CompactToolInput,
  operationKind: ToolOperationKind = resolveToolOperationKind(input)
): string | undefined {
  const toolArgs = input.toolArgs && isPlainObject(input.toolArgs) ? input.toolArgs : {}
  const nestedToolArgs = extractNestedToolArgs(toolArgs)
  const {
    mappedInput,
    resultData,
    directInput,
    nestedInput,
    params,
    nestedParams
  } = collectNativeInputRecords(toolArgs, input.toolResult)

  switch (operationKind) {
    case 'dynamic_use':
      return (
        firstSpecificToolName(
          operationKind,
          resultData?.toolName,
          resultData?.tool_name,
          resultData?.name,
          resultData?.tool,
          mappedInput?.toolName,
          mappedInput?.tool_name,
          directInput?.toolName,
          directInput?.tool_name,
          nestedInput?.toolName,
          nestedInput?.tool_name,
          params?.toolName,
          params?.tool_name,
          nestedParams?.toolName,
          nestedParams?.tool_name,
          toolArgs.toolName,
          toolArgs.tool_name
        ) || operationKind
      )
    case 'cli_tool':
      return (
        firstSpecificToolName(
          operationKind,
          resultData?.toolId,
          resultData?.tool_id,
          resultData?.target,
          resultData?.id,
          mappedInput?.toolId,
          mappedInput?.tool_id,
          directInput?.toolId,
          directInput?.tool_id,
          nestedInput?.toolId,
          nestedInput?.tool_id,
          params?.toolId,
          params?.tool_id,
          nestedParams?.toolId,
          nestedParams?.tool_id,
          toolArgs.toolId,
          toolArgs.tool_id,
          extractTargetFromTypedRef(resultData?.ref),
          extractTargetFromTypedRef(toolArgs.ref),
          extractTargetFromTypedRef(nestedToolArgs.ref)
        ) || operationKind
      )
    case 'artifact_use':
    case 'fabric_use':
      return (
        firstSpecificToolName(
          operationKind,
          resultData?.target,
          resultData?.controlId,
          resultData?.control_id,
          resultData?.toolName,
          resultData?.tool_name,
          directInput?.controlId,
          directInput?.control_id,
          nestedInput?.controlId,
          nestedInput?.control_id,
          toolArgs.controlId,
          toolArgs.control_id,
          extractTargetFromTypedRef(resultData?.ref),
          extractTargetFromTypedRef(toolArgs.ref),
          extractTargetFromTypedRef(nestedToolArgs.ref),
          extractTargetFromTypedRef(directInput?.ref),
          extractTargetFromTypedRef(nestedInput?.ref)
        ) || operationKind
      )
    case 'agent_browser_use':
      return (
        firstSpecificToolName(
          operationKind,
          resultData?.toolName,
          resultData?.tool_name,
          directInput?.toolName,
          directInput?.tool_name,
          nestedInput?.toolName,
          nestedInput?.tool_name,
          params?.toolName,
          params?.tool_name,
          nestedParams?.toolName,
          nestedParams?.tool_name,
          toolArgs.toolName,
          toolArgs.tool_name
        ) || operationKind
      )
    case 'unknown_tool':
      return firstSpecificToolName(
        operationKind,
        input.toolName,
        input.originalToolName,
        resultData?.toolName,
        resultData?.tool_name,
        resultData?.tool,
        resultData?.name
      )
    default:
      return operationKind
  }
}

function resolveOperationKindFromNames(names: string[]): ToolOperationKind | null {
  if (names.includes('batshit_server_read_file') || names.includes('read_file')) return 'read_file'
  if (
    names.includes('batshit_server_write_file') ||
    names.includes('write_file') ||
    names.includes('batshit_server_overwrite_file') ||
    names.includes('overwrite_file')
  ) {
    return 'write_file'
  }
  if (names.includes('batshit_server_edit_file') || names.includes('edit_file')) return 'edit_file'
  if (names.includes('batshit_server_list_files') || names.includes('list_files')) return 'list_files'
  if (names.includes('batshit_server_search_files') || names.includes('search_files')) return 'search_files'
  if (
    names.includes('batshit_server_fetch_zip') ||
    names.includes('native_fetch_zip') ||
    names.includes('fetch_zip')
  ) {
    return 'fetch_zip'
  }
  if (
    names.includes('batshit_server_dynamic_mcp_find') ||
    names.includes('dynamic_mcp_find') ||
    names.includes('native_dynamic_mcp_find')
  ) {
    return 'dynamic_find'
  }
  if (
    names.includes('batshit_tool_search') ||
    names.includes('native_batshit_tool_search')
  ) {
    return 'tool_find'
  }
  if (
    names.includes('batshit_tool_use') ||
    names.includes('native_batshit_tool_use')
  ) {
    return null
  }
  if (
    names.includes('batshit_server_dynamic_mcp_use') ||
    names.includes('dynamic_mcp_use') ||
    names.includes('native_dynamic_mcp_use')
  ) {
    return 'dynamic_use'
  }
  if (
    names.includes('native_artifact_find') ||
    names.includes('mcp_artifact_find')
  ) {
    return 'artifact_find'
  }
  if (
    names.includes('native_artifact_use') ||
    names.includes('mcp_artifact_use')
  ) {
    return 'artifact_use'
  }
  if (
    names.includes('native_fabric_find') ||
    names.includes('mcp_fabric_find')
  ) {
    return 'fabric_find'
  }
  if (
    names.includes('native_fabric_use') ||
    names.includes('mcp_fabric_use')
  ) {
    return 'fabric_use'
  }
  if (
    names.includes('batshit_server_cli_tool_find') ||
    names.includes('cli_tool_find') ||
    names.includes('native_cli_tool_find')
  ) {
    return 'tool_find'
  }
  if (
    names.includes('batshit_server_cli_tool_use') ||
    names.includes('cli_tool_use') ||
    names.includes('native_cli_tool_use')
  ) {
    return 'cli_tool'
  }
  if (names.includes('native_agent_browser_find') || names.includes('agent_browser_find')) {
    return 'agent_browser_find'
  }
  if (names.includes('native_agent_browser_use') || names.includes('agent_browser_use')) {
    return 'agent_browser_use'
  }
  if (
    names.includes('native_web_search') ||
    names.includes('web_search') ||
    names.includes('codex_web_search') ||
    names.includes('claude_web_search')
  ) {
    return 'web_search'
  }
  if (
    names.includes('native_bash_execute') ||
    names.includes('batshit_server_bash_execute') ||
    names.includes('batshit_server_execute_command') ||
    names.includes('execute_command')
  ) {
    return 'bash'
  }

  return null
}

function extractTargetFromTypedRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return undefined
  return trimmed.slice(separatorIndex + 1).trim() || undefined
}

function extractFamilyFromTypedRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return undefined
  const family = trimmed.slice(0, separatorIndex).trim().toLowerCase()
  switch (family) {
    case 'mcp':
    case 'cli':
    case 'artifact':
    case 'fabric':
    case 'agent_browser':
      return family
    default:
      return undefined
  }
}

function extractNestedToolArgs(toolArgs: Record<string, any> | null | undefined): Record<string, any> {
  if (isPlainObject(toolArgs?.arguments)) return toolArgs.arguments
  if (isPlainObject(toolArgs?.params)) return toolArgs.params
  return {}
}

function resolveBrokerOperationKind(toolArgs: Record<string, any>, toolResult: unknown): ToolOperationKind | null {
  const nestedToolArgs = extractNestedToolArgs(toolArgs)
  const nativeInputs = collectNativeInputRecords(toolArgs, toolResult)
  const resultData = pickPlainObject(unwrapNativeAutomationData(toolResult))
  const family =
    firstString(
      resultData?.family,
      extractFamilyFromTypedRef(resultData?.ref),
      extractFamilyFromTypedRef(toolArgs.ref),
      extractFamilyFromTypedRef(nestedToolArgs.ref),
      extractFamilyFromTypedRef(nativeInputs.directInput?.ref),
      extractFamilyFromTypedRef(nativeInputs.nestedInput?.ref)
    )?.toLowerCase()
  const target = firstString(
    resultData?.target,
    resultData?.controlId,
    resultData?.control_id,
    extractTargetFromTypedRef(resultData?.ref),
    extractTargetFromTypedRef(toolArgs.ref),
    extractTargetFromTypedRef(nestedToolArgs.ref),
    extractTargetFromTypedRef(nativeInputs.directInput?.ref),
    extractTargetFromTypedRef(nativeInputs.nestedInput?.ref)
  )

  switch (family) {
    case 'mcp':
      return 'dynamic_use'
    case 'cli':
      return 'cli_tool'
    case 'artifact':
      return 'artifact_use'
    case 'fabric':
      if (target === 'sys.zip.fetch') return 'fetch_zip'
      return 'fabric_use'
    case 'agent_browser':
      return 'agent_browser_use'
    default:
      return null
  }
}

function omitControlWrapperFields(record: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!record) return null
  const compact: Record<string, any> = {}
  const blocked = new Set([
    'ref',
    'family',
    'target',
    'controlId',
    'control_id',
    'dryRun',
    'dry_run',
    'allowRisky',
    'allow_risky',
    'userId',
    'user_id',
    'agentId',
    'agent_id',
    'selectedGateways',
    'selected_gateways'
  ])

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue
    if (blocked.has(key)) continue
    if (key === 'arguments' || key === 'params') continue
    compact[key] = value
  }

  return Object.keys(compact).length > 0 ? compact : null
}

function extractControlTarget(toolArgs: Record<string, any>, toolResult: unknown): string | undefined {
  const nestedToolArgs = extractNestedToolArgs(toolArgs)
  const nativeInputs = collectNativeInputRecords(toolArgs, toolResult)
  const resultData = pickPlainObject(unwrapNativeAutomationData(toolResult))

  return firstString(
    resultData?.target,
    resultData?.controlId,
    resultData?.control_id,
    toolArgs.controlId,
    toolArgs.control_id,
    nestedToolArgs.controlId,
    nestedToolArgs.control_id,
    nativeInputs.directInput?.controlId,
    nativeInputs.directInput?.control_id,
    nativeInputs.nestedInput?.controlId,
    nativeInputs.nestedInput?.control_id,
    extractTargetFromTypedRef(resultData?.ref),
    extractTargetFromTypedRef(toolArgs.ref),
    extractTargetFromTypedRef(nestedToolArgs.ref),
    extractTargetFromTypedRef(nativeInputs.directInput?.ref),
    extractTargetFromTypedRef(nativeInputs.nestedInput?.ref)
  )
}

function extractControlInputPayload(toolArgs: Record<string, any>, toolResult: unknown): Record<string, any> {
  const nestedToolArgs = extractNestedToolArgs(toolArgs)
  const nativeInputs = collectNativeInputRecords(toolArgs, toolResult)
  const resultData = pickPlainObject(unwrapNativeAutomationData(toolResult))
  const resultInput = pickPlainObject(resultData?.input)
  const nestedResultInput = resultInput ? pickPlainObject(extractNestedToolArgs(resultInput)) : null

  const candidates = [
    pickPlainObject(nativeInputs.directInput?.input),
    pickPlainObject(nativeInputs.nestedInput?.input),
    nativeInputs.nestedInput,
    nativeInputs.directInput,
    pickPlainObject(nestedToolArgs.input),
    resultInput,
    nestedResultInput,
    omitControlWrapperFields(nestedToolArgs),
    omitControlWrapperFields(toolArgs)
  ]

  for (const candidate of candidates) {
    if (candidate && Object.keys(candidate).length > 0) return { ...candidate }
  }

  return {}
}

function extractArtifactDisplayName(controlInput: Record<string, any>, resultData: Record<string, any> | null): string | undefined {
  return firstString(
    resultData?.artifactName,
    resultData?.artifact?.name,
    resultData?.result?.artifactName,
    resultData?.result?.artifact?.name,
    controlInput.name,
    controlInput.artifactName,
    resultData?.artifact?.slug,
    resultData?.result?.artifact?.slug,
    controlInput.slug
  )
}

function extractArtifactControlResultData(resultData: Record<string, any> | null): Record<string, any> | null {
  if (!resultData) return null

  const candidates = [
    pickPlainObject(resultData.result),
    pickPlainObject(resultData.output),
    pickPlainObject(resultData.data),
    resultData
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (
      'artifact' in candidate ||
      'artifactView' in candidate ||
      'artifactUpdate' in candidate ||
      'diff' in candidate ||
      'patch' in candidate ||
      'content' in candidate
    ) {
      return candidate
    }
  }

  return resultData
}

function getArtifactPayload(resultData: Record<string, any> | null): Record<string, any> | null {
  const artifact = pickPlainObject(resultData?.artifact)
  if (artifact) return artifact
  return pickPlainObject(resultData?.result?.artifact)
}

function extractArtifactHtmlContent(
  controlInput: Record<string, any>,
  resultData: Record<string, any> | null
): string | undefined {
  const artifact = getArtifactPayload(resultData)
  const artifactContent = artifact?.content
  const contentObject = pickPlainObject(artifactContent)

  return firstString(
    controlInput.content,
    controlInput.html,
    resultData?.content,
    resultData?.html,
    typeof artifactContent === 'string' ? artifactContent : undefined,
    contentObject?.preview,
    contentObject?.text,
    contentObject?.value
  )
}

function extractArtifactHtmlStats(
  content: string,
  resultData: Record<string, any> | null
): {
  lineCount?: number
  size?: number
  contentTruncated?: boolean
} {
  const artifact = getArtifactPayload(resultData)
  const contentObject = pickPlainObject(artifact?.content)
  const lineCount =
    typeof artifact?.lineCount === 'number'
      ? artifact.lineCount
      : typeof artifact?.numLines === 'number'
        ? artifact.numLines
        : typeof contentObject?.lineCount === 'number'
          ? contentObject.lineCount
          : undefined
  const size =
    typeof artifact?.contentChars === 'number'
      ? artifact.contentChars
      : typeof artifact?.size === 'number'
        ? artifact.size
        : typeof contentObject?.approxChars === 'number'
          ? contentObject.approxChars
          : undefined
  const contentTruncated =
    contentObject?.truncated === true ||
    (typeof size === 'number' && size > content.length)

  return {
    lineCount,
    size,
    contentTruncated
  }
}

function buildArtifactRendererMetadata(options: {
  title: string
  controlId: string
  artifactName?: string
  language?: string
}): Record<string, any> {
  return {
    rendererTitle: options.title,
    artifactTool: true,
    artifactControlId: options.controlId,
    ...(options.artifactName ? { artifactName: options.artifactName } : {}),
    ...(options.language ? { language: options.language } : {})
  }
}

function sidecarPolicyForRendererFamily(
  rendererFamily: ToolRendererFamily,
  fallback: ToolRawSidecarPolicy
): ToolRawSidecarPolicy {
  if (rendererFamily === 'read_file' || rendererFamily === 'edit_file') return 'always'
  return fallback
}

function buildArtifactControlPresentation(options: {
  operationKind: ToolOperationKind
  rendererFamily: ToolRendererFamily
  rawSidecarPolicy: ToolRawSidecarPolicy
  toolArgs: Record<string, any>
  toolResult: unknown
}): CompactToolNormalization | null {
  const { operationKind, rawSidecarPolicy, toolArgs, toolResult } = options
  if (operationKind !== 'artifact_use' && operationKind !== 'fabric_use') return null

  const controlId = extractControlTarget(toolArgs, toolResult)
  if (!controlId) return null

  const displayToolName = formatBatshitToolTargetDisplayName(controlId)
  const normalizedControlId = controlId.toLowerCase()
  const controlInput = extractControlInputPayload(toolArgs, toolResult)
  const rawResultData = pickPlainObject(unwrapNativeAutomationData(toolResult))
  const resultData = extractArtifactControlResultData(rawResultData)
  const artifactName = extractArtifactDisplayName(controlInput, resultData)
  const virtualPath = 'artifact.html'
  const isArtifactControl =
    normalizedControlId.startsWith('sys.artifact.') ||
    normalizedControlId.startsWith('use.artifact.') ||
    normalizedControlId.startsWith('artifact.')

  const genericMetadata = displayToolName
    ? isArtifactControl
      ? buildArtifactRendererMetadata({
          title: displayToolName,
          controlId,
          artifactName
        })
      : {
          rendererTitle: displayToolName,
          fabricControlId: controlId
        }
    : undefined

  if (normalizedControlId === 'sys.artifact.create') {
    const content = extractArtifactHtmlContent(controlInput, resultData)
    if (content) {
      const stats = extractArtifactHtmlStats(content, resultData)
      const summarized = summarizeWriteResult(
        {
          filePath: virtualPath,
          path: virtualPath,
          content
        },
        {
          success: resultData?.success !== false,
          filePath: virtualPath,
          path: virtualPath,
          content,
          lineCount: stats.lineCount,
          size: stats.size,
          language: 'html'
        }
      )
      return {
        operationKind,
        rendererFamily: 'write_file',
        displayToolName: displayToolName ?? 'Artifact Create',
        toolArgs: {
          filePath: virtualPath,
          path: virtualPath
        },
        toolResult: summarized.result,
        flags: summarized.flags,
        rawSidecarPolicy: sidecarPolicyForRendererFamily('write_file', rawSidecarPolicy),
        metadata: buildArtifactRendererMetadata({
          title: displayToolName ?? 'Artifact Create',
          controlId,
          artifactName,
          language: 'html'
        })
      }
    }
  }

  if (normalizedControlId === 'sys.artifact.get') {
    const artifact = getArtifactPayload(resultData)
    const content = extractArtifactHtmlContent(controlInput, resultData)
    if (content) {
      const stats = extractArtifactHtmlStats(content, resultData)
      const summarized = summarizeReadResult(
        {
          filePath: virtualPath,
          path: virtualPath
        },
        {
          success: resultData?.success !== false,
          filePath: virtualPath,
          path: virtualPath,
          content,
          lineCount: stats.lineCount,
          size: stats.size,
          language: 'html'
        },
        {}
      )
      if (stats.contentTruncated) {
        summarized.result.contentTruncated = true
        summarized.flags.compacted = true
        summarized.flags.truncated = true
      }
      return {
        operationKind,
        rendererFamily: 'read_file',
        displayToolName: displayToolName ?? 'Artifact Read',
        toolArgs: {
          filePath: virtualPath,
          path: virtualPath,
          ...(typeof controlInput.artifactId === 'string' ? { artifactId: controlInput.artifactId } : {})
        },
        toolResult: summarized.result,
        flags: summarized.flags,
        rawSidecarPolicy: sidecarPolicyForRendererFamily('read_file', rawSidecarPolicy),
        metadata: buildArtifactRendererMetadata({
          title: displayToolName ?? 'Artifact Read',
          controlId,
          artifactName,
          language: 'html'
        })
      }
    }
  }

  if (normalizedControlId === 'sys.artifact.apply_patch') {
    const patch = firstString(controlInput.patch, resultData?.patch)
    if (patch) {
      const summarized = summarizeEditResult(
        {
          filePath: virtualPath,
          path: virtualPath,
          command: patch
        },
        {
          success: resultData?.success !== false,
          filePath: virtualPath,
          path: virtualPath,
          diff: patch,
          language: 'html'
        }
      )
      return {
        operationKind,
        rendererFamily: 'edit_file',
        displayToolName: displayToolName ?? 'Artifact Edit',
        toolArgs: {
          filePath: virtualPath,
          path: virtualPath,
          command: patch
        },
        toolResult: summarized.result,
        flags: summarized.flags,
        rawSidecarPolicy: sidecarPolicyForRendererFamily('edit_file', rawSidecarPolicy),
        metadata: buildArtifactRendererMetadata({
          title: displayToolName ?? 'Artifact Edit',
          controlId,
          artifactName,
          language: 'html'
        })
      }
    }
  }

  if (normalizedControlId === 'sys.artifact.update') {
    const patch = firstString(controlInput.patch, resultData?.patch, resultData?.diff)
    if (patch) {
      const summarized = summarizeEditResult(
        {
          filePath: virtualPath,
          path: virtualPath,
          command: patch
        },
        {
          success: resultData?.success !== false,
          filePath: virtualPath,
          path: virtualPath,
          diff: patch,
          language: 'html'
        }
      )
      return {
        operationKind,
        rendererFamily: 'edit_file',
        displayToolName: displayToolName ?? 'Artifact Edit',
        toolArgs: {
          filePath: virtualPath,
          path: virtualPath,
          command: patch
        },
        toolResult: summarized.result,
        flags: summarized.flags,
        rawSidecarPolicy: sidecarPolicyForRendererFamily('edit_file', rawSidecarPolicy),
        metadata: buildArtifactRendererMetadata({
          title: displayToolName ?? 'Artifact Edit',
          controlId,
          artifactName,
          language: 'html'
        })
      }
    }

    const content = extractArtifactHtmlContent(controlInput, resultData)
    if (content) {
      const stats = extractArtifactHtmlStats(content, resultData)
      const summarized = summarizeWriteResult(
        {
          filePath: virtualPath,
          path: virtualPath,
          content
        },
        {
          success: resultData?.success !== false,
          filePath: virtualPath,
          path: virtualPath,
          content,
          lineCount: stats.lineCount,
          size: stats.size,
          language: 'html'
        }
      )
      return {
        operationKind,
        rendererFamily: 'write_file',
        displayToolName: displayToolName ?? 'Artifact Edit',
        toolArgs: {
          filePath: virtualPath,
          path: virtualPath
        },
        toolResult: summarized.result,
        flags: summarized.flags,
        rawSidecarPolicy: sidecarPolicyForRendererFamily('write_file', rawSidecarPolicy),
        metadata: buildArtifactRendererMetadata({
          title: displayToolName ?? 'Artifact Edit',
          controlId,
          artifactName,
          language: 'html'
        })
      }
    }

    const updateInfo = pickPlainObject(resultData?.artifactUpdate)
    if (updateInfo) {
      const artifact = getArtifactPayload(resultData)
      const updatedFields = Array.isArray(updateInfo.updatedFields)
        ? updateInfo.updatedFields.filter((entry: unknown) => typeof entry === 'string')
        : []
      return {
        operationKind,
        rendererFamily: options.rendererFamily,
        displayToolName: displayToolName ?? 'Artifact Edit',
        toolArgs: {
          ...(typeof controlInput.artifactId === 'string' ? { artifactId: controlInput.artifactId } : {}),
          ...(updatedFields.length ? { updatedFields } : {})
        },
        toolResult: {
          success: resultData?.success !== false,
          artifact: {
            ...(typeof artifact?.id === 'string' ? { id: artifact.id } : {}),
            ...(typeof artifact?.name === 'string' ? { name: artifact.name } : {}),
            ...(typeof artifact?.slug === 'string' ? { slug: artifact.slug } : {}),
            ...(typeof artifact?.mode === 'string' ? { mode: artifact.mode } : {}),
            ...(typeof artifact?.zone === 'string' ? { zone: artifact.zone } : {}),
            ...(typeof artifact?.version === 'number' ? { version: artifact.version } : {})
          },
          update: summarizeValue(updateInfo)
        },
        flags: {
          compacted: true,
          truncated: false,
          binaryLikeOmitted: false
        },
        rawSidecarPolicy,
        metadata: buildArtifactRendererMetadata({
          title: displayToolName ?? 'Artifact Edit',
          controlId,
          artifactName
        })
      }
    }
  }

  if (genericMetadata || displayToolName) {
    return {
      operationKind,
      rendererFamily: options.rendererFamily,
      displayToolName: displayToolName ?? controlId,
      toolArgs: compactToolArgs(operationKind, toolArgs, toolResult),
      toolResult: summarizeValue(unwrapNativeAutomationData(toolResult)),
      flags: {
        compacted: true,
        truncated: false,
        binaryLikeOmitted: false
      },
      rawSidecarPolicy,
      metadata: genericMetadata
    }
  }

  return null
}

function extractToolActionName(toolArgs: Record<string, any>, toolResult: unknown): string {
  const candidate = unwrapSingleItemArray(parseMaybeJson(toolResult))
  const envelope = isPlainObject(candidate) ? candidate : null
  const nestedToolArgs = extractNestedToolArgs(toolArgs)
  const nestedInputArgs = extractNestedToolArgs(isPlainObject(envelope?.input) ? envelope.input : null)
  const topLevelAction = normalizeName(typeof toolArgs?.action === 'string' ? toolArgs.action : undefined)
  const nestedAction = normalizeName(typeof nestedToolArgs?.action === 'string' ? nestedToolArgs.action : undefined)
  const envelopeAction = normalizeName(typeof envelope?.action === 'string' ? envelope.action : undefined)
  const dataAction = normalizeName(typeof envelope?.data?.action === 'string' ? envelope.data.action : undefined)
  const inputAction = normalizeName(typeof nestedInputArgs?.action === 'string' ? nestedInputArgs.action : undefined)
  const contentAction = normalizeName(
    typeof envelope?.content?.[0]?.text?.action === 'string' ? envelope.content[0].text.action : undefined
  )

  if (topLevelAction === 'native_skill' || envelopeAction === 'native_skill') {
    return nestedAction || dataAction || inputAction || contentAction || 'native_skill'
  }

  return topLevelAction || nestedAction || envelopeAction || dataAction || inputAction || contentAction
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return stripAnsi(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncateText(value: string, maxChars: number, maxLines: number): TextPreview {
  const normalized = normalizeText(value)
  if (!normalized) return { text: '', truncated: false }

  const lines = normalized.split('\n')
  const limitedLines = lines.slice(0, maxLines)
  let text = limitedLines.join('\n')
  let truncated = limitedLines.length < lines.length

  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }

  return {
    text: text.trimEnd(),
    truncated
  }
}

function extractPrimaryText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null

  const parsed = parseMaybeJson(value)
  if (typeof parsed === 'string') return parsed
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed)

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null
    const joinedText = parsed
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (isPlainObject(entry) && typeof entry.text === 'string') return entry.text
        if (isPlainObject(entry) && typeof entry.content === 'string') return entry.content
        return extractPrimaryText(entry, depth + 1)
      })
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join('\n')
    return joinedText || null
  }

  if (!isPlainObject(parsed)) return null

  const keys = [
    'skillMarkdown',
    'content',
    'text',
    'stdout',
    'stderr',
    'output',
    'result',
    'data',
    'value',
    'fileContent',
    'newContent',
    'diff',
    'changes',
    'patch'
  ]

  for (const key of keys) {
    if (parsed[key] !== undefined) {
      const nested = extractPrimaryText(parsed[key], depth + 1)
      if (nested !== null && nested.trim().length > 0) return nested
    }
  }

  return null
}

function extractDirectText(value: unknown): string | null {
  if (typeof value === 'string') return value
  return extractPrimaryText(value)
}

function extractPath(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

function tokenizeShellLike(value: string): string[] {
  const tokens: string[] = []
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  let match: RegExpExecArray | null = null
  while ((match = matcher.exec(value))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens.filter((token) => token.length > 0)
}

function extractSearchQueryFromCommand(command: string | undefined): string | null {
  if (typeof command !== 'string' || command.trim().length === 0) return null

  const tokens = tokenizeShellLike(command)
  if (tokens.length === 0) return null

  const commandName = tokens[0]?.toLowerCase()
  if (commandName !== 'rg' && commandName !== 'grep') return null

  const optionsWithValues = new Set([
    '-A',
    '-B',
    '-C',
    '-e',
    '-f',
    '-g',
    '-m',
    '--context',
    '--encoding',
    '--engine',
    '--file',
    '--glob',
    '--iglob',
    '--max-count',
    '--max-depth',
    '--path-separator',
    '--pre',
    '--pre-glob',
    '--regexp',
    '--replace',
    '--sort',
    '--sortr',
    '--type',
    '--type-add',
    '--type-not'
  ])

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (optionsWithValues.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }

  return null
}

type ParsedSearchMatch = {
  path: string
  matchCount: number
  matches: Array<{ lineNumber: number; text: string }>
}

type ListEntryType = 'directory' | 'file' | 'unknown'
type SimplifiedListEntry = { path: string; name: string; type: ListEntryType }

function isFilesListingCommand(command: string | undefined): boolean {
  if (typeof command !== 'string' || command.trim().length === 0) return false

  const tokens = tokenizeShellLike(command)
  if (tokens.length === 0) return false

  const commandName = tokens[0]?.toLowerCase()
  if (commandName === 'ls' || commandName === 'find' || commandName === 'tree') return true

  return commandName === 'rg' && tokens.includes('--files')
}

function isFilesOnlySearchCommand(command: string | undefined): boolean {
  if (typeof command !== 'string' || command.trim().length === 0) return false

  const tokens = tokenizeShellLike(command)
  if (tokens.length === 0) return false

  const commandName = tokens[0]?.toLowerCase()
  if (commandName !== 'rg' && commandName !== 'grep') return false

  return tokens.some((token) => {
    if (token === '--files-with-matches') return true
    if (!token.startsWith('-') || token.startsWith('--')) return false
    return token.slice(1).includes('l')
  })
}

function parseSearchOutput(value: string): ParsedSearchMatch[] {
  if (!value.trim()) return []

  const files = new Map<string, ParsedSearchMatch>()
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const colonMatch = line.match(/^(.*?):(\d+):(.*)$/)
    const match = colonMatch
    if (!match?.[1] || !match?.[2]) continue

    const path = match[1].trim()
    const lineNumber = Number(match[2])
    if (!path || !Number.isFinite(lineNumber)) continue

    const entry =
      files.get(path) ??
      {
        path,
        matchCount: 0,
        matches: []
      }
    entry.matchCount += 1
    if (entry.matches.length < SEARCH_MATCH_LIMIT) {
      entry.matches.push({
        lineNumber,
        text: truncateText(normalizeText(match[3] ?? ''), 240, 4).text
      })
    }
    files.set(path, entry)
  }

  return Array.from(files.values())
}

function parseFilesOnlySearchOutput(value: string): ParsedSearchMatch[] {
  if (!value.trim()) return []

  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({
      path,
      matchCount: 1,
      matches: []
    }))
}

function inferListDefaultType(command: string | undefined): ListEntryType {
  if (typeof command !== 'string' || command.trim().length === 0) return 'unknown'

  const tokens = tokenizeShellLike(command)
  if (tokens.length === 0) return 'unknown'

  const commandName = tokens[0]?.toLowerCase()
  if (commandName === 'rg' && tokens.includes('--files')) return 'file'

  return 'unknown'
}

function approximateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : safeStringify(value)
  return Math.ceil(text.length / 4)
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === 'object' && current !== null) {
          if (seen.has(current)) return '[Circular]'
          seen.add(current)
        }
        return current
      },
      2
    ) ?? ''
  } catch {
    return String(value ?? '')
  }
}

function looksLikeDataUrl(value: string): boolean {
  return /^data:[^;]+;base64,/i.test(value.trim())
}

function looksLikeBase64Blob(value: string): boolean {
  const collapsed = value.replace(/\s+/g, '')
  if (collapsed.length < BINARY_LIKE_MIN_CHARS) return false
  if (collapsed.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/=]+$/.test(collapsed)) return false
  const paddingMatches = collapsed.match(/=+$/)
  if (paddingMatches && paddingMatches[0].length > 2) return false

  const uniqueChars = new Set(collapsed.slice(0, 128).split(''))
  return uniqueChars.size > 24
}

function containsManyControlChars(value: string): boolean {
  if (value.length < BINARY_LIKE_MIN_CHARS) return false
  let controlCount = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const isControl = code < 9 || (code > 13 && code < 32)
    if (isControl) controlCount += 1
  }
  return controlCount / value.length > 0.08
}

export function isBinaryLikeText(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return looksLikeDataUrl(value) || looksLikeBase64Blob(value) || containsManyControlChars(value)
}

function summarizeValue(value: unknown, depth = 0): unknown {
  const parsed = parseMaybeJson(value)

  if (parsed === null || parsed === undefined) return parsed
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return parsed

  if (typeof parsed === 'string') {
    if (isBinaryLikeText(parsed)) {
      return {
        omitted: true,
        reason: 'binary_like',
        approxChars: parsed.length
      }
    }

    const preview = truncateText(parsed, GENERIC_MAX_STRING_CHARS, 80)
    return preview.truncated
      ? {
          preview: preview.text,
          truncated: true,
          approxChars: parsed.length
        }
      : preview.text
  }

  if (depth >= GENERIC_MAX_DEPTH) {
    return {
      summary: Array.isArray(parsed) ? `Array(${parsed.length})` : 'Object',
      truncated: true
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.slice(0, GENERIC_MAX_ARRAY_ITEMS).map((entry) => summarizeValue(entry, depth + 1))
  }

  if (!isPlainObject(parsed)) return String(parsed)

  const summary: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(parsed).slice(0, GENERIC_MAX_KEYS)) {
    summary[key] = summarizeValue(entry, depth + 1)
  }
  if (Object.keys(parsed).length > GENERIC_MAX_KEYS) {
    summary.__truncatedKeys = Object.keys(parsed).length - GENERIC_MAX_KEYS
  }

  return summary
}

function extractFetchZipPayload(toolResult: any): Record<string, any> | null {
  const normalized = unwrapNativeAutomationData(toolResult)
  const normalizedRecord = pickPlainObject(normalized)
  const resultRecord = pickPlainObject(normalizedRecord?.result)
  const dataRecord = pickPlainObject(normalizedRecord?.data)
  return resultRecord ?? dataRecord ?? normalizedRecord
}

function summarizeFetchZipResult(toolArgs: Record<string, any>, toolResult: any): { result: any; flags: CompactToolFlags } {
  const payload = extractFetchZipPayload(toolResult)
  if (!payload) {
    const summarized = summarizeValue(unwrapNativeAutomationData(toolResult))
    return {
      result: summarized,
      flags: {
        compacted: safeStringify(summarized).length < safeStringify(toolResult).length,
        truncated: false,
        binaryLikeOmitted: false
      }
    }
  }

  const content = typeof payload.content === 'string' ? payload.content : undefined
  const contentPreview = content
    ? truncateText(content, FETCH_ZIP_CONTENT_PREVIEW_CHARS, FETCH_ZIP_CONTENT_PREVIEW_LINES)
    : null
  const metadata = pickPlainObject(payload.metadata)

  return {
    result: {
      found: payload.found === true,
      zipId:
        typeof payload.zipId === 'string'
          ? payload.zipId
          : typeof toolArgs.zipId === 'string'
            ? toolArgs.zipId
            : undefined,
      type: typeof payload.type === 'string' ? payload.type : undefined,
      tokens: typeof payload.tokens === 'number' ? payload.tokens : payload.tokens ?? undefined,
      description: typeof payload.description === 'string' ? payload.description : payload.description ?? undefined,
      createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : payload.createdAt ?? undefined,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      contentLength:
        typeof payload.contentLength === 'number'
          ? payload.contentLength
          : content
            ? content.length
            : undefined,
      contentTruncated: payload.contentTruncated === true || contentPreview?.truncated === true,
      ...(contentPreview
        ? {
            content: contentPreview.text
          }
        : {}),
      ...(metadata
        ? {
            metadata: summarizeValue(metadata)
          }
        : {})
    },
    flags: {
      compacted: true,
      truncated: contentPreview?.truncated === true,
      binaryLikeOmitted: false
    }
  }
}

function simplifyFileEntry(entry: any, defaultType: ListEntryType = 'unknown'): SimplifiedListEntry | null {
  if (!entry) return null
  if (typeof entry === 'string') {
    return {
      path: entry,
      name: entry.split('/').pop() || entry,
      type: entry.endsWith('/') ? 'directory' : defaultType
    }
  }

  if (!isPlainObject(entry)) return null

  const path =
    extractPath(entry.path, entry.filePath, entry.absolutePath, entry.name) ?? 'Unknown file'
  const name = typeof entry.name === 'string' && entry.name.trim().length > 0
    ? entry.name
    : path.split('/').pop() || path

  return {
    path,
    name,
    type:
      entry.type === 'directory' || entry.isDirectory === true || String(name).endsWith('/')
        ? 'directory'
        : entry.type === 'file' || entry.isFile === true
          ? 'file'
          : defaultType
  }
}

function parseLsListingOutput(
  output: string
): Array<{ path: string; name: string; type: 'directory' | 'file' }> {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('total '))
    .map((line) => {
      const match = line.match(
        /^(?<perm>[bcdlps-][rwxStTs-]{9})\s+\d+\s+\S+\s+\S+\s+\d+\s+\w+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+(?<name>.+)$/
      )
      const rawName = match?.groups?.name?.trim()
      if (!rawName) return null

      const name = rawName.split(' -> ')[0]?.trim()
      if (!name || name === '.' || name === '..') return null

      return {
        path: name,
        name,
        type: match?.groups?.perm?.startsWith('d') ? 'directory' : 'file'
      }
    })
    .filter((entry): entry is { path: string; name: string; type: 'directory' | 'file' } =>
      Boolean(entry)
    )
}

function summarizeListResult(
  toolArgs: Record<string, any>,
  toolResult: any
): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const mappedToolInput = extractNativeMappedToolInput(toolResult)
  const commandCandidate =
    typeof mappedToolInput?.innerCommand === 'string'
      ? mappedToolInput.innerCommand
      : typeof mappedToolInput?.command === 'string'
        ? mappedToolInput.command
        : typeof toolArgs?.innerCommand === 'string'
          ? toolArgs.innerCommand
          : typeof toolArgs?.command === 'string'
            ? toolArgs.command
            : typeof (normalizedToolResult as any)?.innerCommand === 'string'
              ? (normalizedToolResult as any).innerCommand
              : typeof (normalizedToolResult as any)?.command === 'string'
                ? (normalizedToolResult as any).command
                : undefined
  const defaultListEntryType = inferListDefaultType(commandCandidate)
  const filesCandidate = Array.isArray((normalizedToolResult as any)?.files)
    ? (normalizedToolResult as any).files
    : Array.isArray((normalizedToolResult as any)?.items)
      ? (normalizedToolResult as any).items
      : Array.isArray(normalizedToolResult)
        ? normalizedToolResult
        : null

  if (filesCandidate) {
    const files = filesCandidate
      .map((entry: any) => simplifyFileEntry(entry, defaultListEntryType))
      .filter((entry: SimplifiedListEntry | null): entry is SimplifiedListEntry => Boolean(entry))
      .slice(0, LIST_ITEM_LIMIT)
    const totalDirectories = files.filter((entry: SimplifiedListEntry) => entry.type === 'directory').length
    const totalFiles = files.filter((entry: SimplifiedListEntry) => entry.type === 'file').length
    const totalUnknownItems = files.filter((entry: SimplifiedListEntry) => entry.type === 'unknown').length
    return {
      result: {
        files,
        totalFiles: (normalizedToolResult as any)?.totalFiles ?? totalFiles,
        totalDirectories: (normalizedToolResult as any)?.totalDirectories ?? totalDirectories,
        totalUnknownItems: (normalizedToolResult as any)?.totalUnknownItems ?? totalUnknownItems,
        totalItems: (normalizedToolResult as any)?.totalItems ?? filesCandidate.length
      },
      flags: {
        compacted: filesCandidate.length > files.length,
        truncated: filesCandidate.length > files.length,
        binaryLikeOmitted: false
      }
    }
  }

  const previewSource =
    extractDirectText((normalizedToolResult as any)?.stdout) ??
    extractDirectText((normalizedToolResult as any)?.output) ??
    extractPrimaryText(normalizedToolResult)

  if (isFilesListingCommand(commandCandidate)) {
    const parsedLsFiles = parseLsListingOutput(previewSource ?? '')
    if (parsedLsFiles.length > 0) {
      const files = parsedLsFiles.slice(0, LIST_ITEM_LIMIT)
      const totalItems = parsedLsFiles.length
      const totalDirectories = files.filter((entry: { type: 'directory' | 'file' }) => entry.type === 'directory').length
      const totalFiles = files.filter((entry: { type: 'directory' | 'file' }) => entry.type === 'file').length

      return {
        result: {
          files,
          totalFiles,
          totalDirectories,
          totalUnknownItems: 0,
          totalItems
        },
        flags: {
          compacted: totalItems > files.length,
          truncated: totalItems > files.length,
          binaryLikeOmitted: false
        }
      }
    }

    const listLines = (previewSource ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    const files = listLines
      .map((entry) => simplifyFileEntry(entry, defaultListEntryType))
      .filter((entry): entry is SimplifiedListEntry => Boolean(entry))
      .slice(0, LIST_ITEM_LIMIT)
    const totalItems = listLines.length
    const totalDirectories = files.filter((entry) => entry.type === 'directory').length
    const totalFiles = files.filter((entry) => entry.type === 'file').length
    const totalUnknownItems = files.filter((entry) => entry.type === 'unknown').length

    if (files.length > 0) {
      return {
        result: {
          files,
          totalFiles,
          totalDirectories,
          totalUnknownItems,
          totalItems
        },
        flags: {
          compacted: totalItems > files.length,
          truncated: totalItems > files.length,
          binaryLikeOmitted: false
        }
      }
    }
  }

  const preview = truncateText(previewSource ?? '', BASH_STDOUT_PREVIEW_CHARS, BASH_STDOUT_PREVIEW_LINES)
  return {
    result: {
      output: preview.text,
      stdout: preview.text,
      truncated: preview.truncated
    },
    flags: {
      compacted: preview.truncated,
      truncated: preview.truncated,
      binaryLikeOmitted: false
    }
  }
}

function summarizeSearchResult(
  toolArgs: Record<string, any>,
  toolResult: any
): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const mappedToolInput = extractNativeMappedToolInput(toolResult)
  const query =
    typeof (normalizedToolResult as any)?.query === 'string'
      ? (normalizedToolResult as any).query
      : typeof toolArgs?.query === 'string'
        ? toolArgs.query
        : typeof toolArgs?.pattern === 'string'
          ? toolArgs.pattern
          : extractSearchQueryFromCommand(
              typeof mappedToolInput?.innerCommand === 'string'
                ? mappedToolInput.innerCommand
                : typeof mappedToolInput?.command === 'string'
                  ? mappedToolInput.command
                  : typeof toolArgs?.innerCommand === 'string'
                ? toolArgs.innerCommand
                : typeof toolArgs?.command === 'string'
                  ? toolArgs.command
                  : undefined
            ) ?? undefined
  const structuredResults = Array.isArray((normalizedToolResult as any)?.results)
    ? (normalizedToolResult as any).results
    : null
  if (structuredResults) {
    const files = structuredResults.slice(0, SEARCH_FILE_LIMIT).map((entry: any) => {
      const matches = Array.isArray(entry?.matches) ? entry.matches.slice(0, SEARCH_MATCH_LIMIT) : []
      return {
        path: extractPath(entry?.path, entry?.filePath, entry?.absolutePath) ?? 'Unknown file',
        matchCount: entry?.matchCount ?? entry?.matches?.length ?? matches.length,
        matches: matches.map((match: any) => ({
          lineNumber: match?.lineNumber ?? match?.line ?? '?',
          text: truncateText(normalizeText(match?.text ?? match?.line ?? match?.content ?? ''), 240, 4).text
        }))
      }
    })

    return {
      result: {
        results: files,
        ...(query ? { query } : {}),
        totalMatches:
          (normalizedToolResult as any)?.totalMatches ??
          files.reduce((sum: number, entry: Record<string, any>) => sum + (entry.matchCount || 0), 0),
        totalMatchingFiles: (normalizedToolResult as any)?.totalMatchingFiles ?? structuredResults.length
      },
      flags: {
        compacted: structuredResults.length > files.length,
        truncated: structuredResults.length > files.length,
        binaryLikeOmitted: false
      }
    }
  }

  const previewSource =
    extractDirectText((normalizedToolResult as any)?.stdout) ??
    extractDirectText((normalizedToolResult as any)?.output) ??
    extractPrimaryText(normalizedToolResult)
  const parsedFiles = parseSearchOutput(previewSource ?? '')
  if (parsedFiles.length > 0) {
    const files = parsedFiles.slice(0, SEARCH_FILE_LIMIT)
    const truncated =
      parsedFiles.length > files.length ||
      files.some((entry) => entry.matches.length < entry.matchCount)

    return {
      result: {
        results: files,
        ...(query ? { query } : {}),
        totalMatches: parsedFiles.reduce((sum, entry) => sum + entry.matchCount, 0),
        totalMatchingFiles: parsedFiles.length
      },
      flags: {
        compacted: truncated,
        truncated,
        binaryLikeOmitted: false
      }
    }
  }

  const commandCandidate =
    typeof mappedToolInput?.innerCommand === 'string'
      ? mappedToolInput.innerCommand
      : typeof mappedToolInput?.command === 'string'
        ? mappedToolInput.command
        : typeof toolArgs?.innerCommand === 'string'
      ? toolArgs.innerCommand
      : typeof toolArgs?.command === 'string'
        ? toolArgs.command
        : typeof (normalizedToolResult as any)?.innerCommand === 'string'
          ? (normalizedToolResult as any).innerCommand
          : typeof (normalizedToolResult as any)?.command === 'string'
            ? (normalizedToolResult as any).command
            : undefined
  if (isFilesOnlySearchCommand(commandCandidate)) {
    const filesOnlyResults = parseFilesOnlySearchOutput(previewSource ?? '')
    if (filesOnlyResults.length > 0) {
      const files = filesOnlyResults.slice(0, SEARCH_FILE_LIMIT)
      const truncated = filesOnlyResults.length > files.length

      return {
        result: {
          results: files,
          ...(query ? { query } : {}),
          totalMatches: filesOnlyResults.length,
          totalMatchingFiles: filesOnlyResults.length
        },
        flags: {
          compacted: truncated,
          truncated,
          binaryLikeOmitted: false
        }
      }
    }
  }

  const preview = truncateText(previewSource ?? '', BASH_STDOUT_PREVIEW_CHARS, BASH_STDOUT_PREVIEW_LINES)
  return {
    result: {
      ...(query ? { query } : {}),
      output: preview.text,
      stdout: preview.text,
      truncated: preview.truncated
    },
    flags: {
      compacted: preview.truncated,
      truncated: preview.truncated,
      binaryLikeOmitted: false
    }
  }
}

function summarizeWebSearchResult(toolArgs: Record<string, any>, toolResult: any): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const queries = Array.isArray((normalizedToolResult as any)?.queries)
    ? (normalizedToolResult as any).queries
        .filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(0, WEB_SEARCH_RESULT_LIMIT)
    : []
  const resultsUnavailable = (normalizedToolResult as any)?.resultsUnavailable === true
  const resultsCandidate = Array.isArray((normalizedToolResult as any)?.results)
    ? (normalizedToolResult as any).results
    : Array.isArray((normalizedToolResult as any)?.data?.results)
      ? (normalizedToolResult as any).data.results
      : Array.isArray(normalizedToolResult)
        ? normalizedToolResult
        : []
  const explicitTotalMatches =
    typeof (normalizedToolResult as any)?.totalMatches === 'number'
      ? (normalizedToolResult as any).totalMatches
      : typeof (normalizedToolResult as any)?.total === 'number'
        ? (normalizedToolResult as any).total
        : typeof (normalizedToolResult as any)?.count === 'number'
          ? (normalizedToolResult as any).count
          : undefined

  const results = resultsCandidate.slice(0, WEB_SEARCH_RESULT_LIMIT).map((entry: any) => ({
    title: normalizeText(entry?.title ?? entry?.name ?? entry?.headline ?? 'Untitled result'),
    url: extractPath(entry?.url, entry?.link, entry?.href),
    snippet: truncateText(normalizeText(entry?.snippet ?? entry?.description ?? entry?.content ?? ''), WEB_SEARCH_SNIPPET_CHARS, 6).text,
    source: typeof entry?.source === 'string' ? entry.source : typeof entry?.provider === 'string' ? entry.provider : undefined
  }))

  return {
    result: {
      query:
        typeof (normalizedToolResult as any)?.query === 'string'
          ? (normalizedToolResult as any).query
          : toolArgs.query,
      provider:
        typeof (normalizedToolResult as any)?.provider === 'string'
          ? (normalizedToolResult as any).provider
          : typeof (normalizedToolResult as any)?.searchProvider === 'string'
            ? (normalizedToolResult as any).searchProvider
            : undefined,
      ...(queries.length > 0 ? { queries } : {}),
      ...(!resultsUnavailable
        ? {
            totalMatches: explicitTotalMatches ?? resultsCandidate.length
          }
        : explicitTotalMatches !== undefined
          ? { totalMatches: explicitTotalMatches }
          : {}),
      ...(resultsUnavailable ? { resultsUnavailable: true } : {}),
      results
    },
    flags: {
      compacted: resultsCandidate.length > results.length,
      truncated: resultsCandidate.length > results.length,
      binaryLikeOmitted: false
    }
  }
}

function summarizeBashResult(toolArgs: Record<string, any>, toolResult: any): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const mappedToolInput = extractNativeMappedToolInput(toolResult)
  const stdoutSource = normalizeText(
    (normalizedToolResult as any)?.stdout ?? (normalizedToolResult as any)?.output ?? ''
  )
  const stderrSource = normalizeText(
    (normalizedToolResult as any)?.stderr ?? (normalizedToolResult as any)?.error ?? ''
  )
  const stdoutBinary = isBinaryLikeText(stdoutSource)
  const stderrBinary = isBinaryLikeText(stderrSource)

  const stdoutPreview = stdoutBinary
    ? { text: '[Binary or base64-like stdout omitted from main chat payload.]', truncated: true }
    : truncateText(stdoutSource, BASH_STDOUT_PREVIEW_CHARS, BASH_STDOUT_PREVIEW_LINES)
  const stderrPreview = stderrBinary
    ? { text: '[Binary or base64-like stderr omitted from main chat payload.]', truncated: true }
    : truncateText(stderrSource, BASH_STDERR_PREVIEW_CHARS, BASH_STDERR_PREVIEW_LINES)

  const result = {
    command:
      typeof mappedToolInput?.command === 'string'
        ? mappedToolInput.command
        : typeof (normalizedToolResult as any)?.command === 'string'
        ? (normalizedToolResult as any).command
        : typeof toolArgs?.command === 'string'
          ? toolArgs.command
          : undefined,
    innerCommand:
      typeof mappedToolInput?.innerCommand === 'string'
        ? mappedToolInput.innerCommand
        : typeof toolArgs?.innerCommand === 'string'
        ? toolArgs.innerCommand
        : typeof (normalizedToolResult as any)?.innerCommand === 'string'
          ? (normalizedToolResult as any).innerCommand
          : undefined,
    stdout: stdoutPreview.text,
    stderr: stderrPreview.text,
    exitCode: (normalizedToolResult as any)?.exitCode ?? (normalizedToolResult as any)?.code,
    interrupted: (normalizedToolResult as any)?.interrupted === true,
    isImage: (normalizedToolResult as any)?.isImage === true,
    stdoutTruncated: stdoutPreview.truncated,
    stderrTruncated: stderrPreview.truncated
  }

  return {
    result,
    flags: {
      compacted: stdoutPreview.truncated || stderrPreview.truncated || stdoutBinary || stderrBinary,
      truncated: stdoutPreview.truncated || stderrPreview.truncated,
      binaryLikeOmitted: stdoutBinary || stderrBinary
    }
  }
}

function summarizeReadResult(
  toolArgs: Record<string, any>,
  toolResult: any,
  options: { path?: string | null; skillName?: string | null; skillId?: string | null }
): { result: any; flags: CompactToolFlags } {
  const content =
    extractDirectText(toolResult?.skillMarkdown) ??
    extractDirectText(toolResult?.content) ??
    extractDirectText(toolResult?.fileContent) ??
    extractDirectText(toolResult?.output) ??
    extractDirectText(toolResult?.result) ??
    extractDirectText(toolResult?.data) ??
    extractPrimaryText(toolResult)

  const binaryLike = isBinaryLikeText(content)
  const preview = binaryLike
    ? { text: '[Binary or base64-like content omitted from main chat payload.]', truncated: true }
    : truncateText(content ?? '', READ_PREVIEW_CHARS, READ_PREVIEW_LINES)

  const path =
    options.path ??
    extractPath(toolResult?.filePath, toolResult?.absolutePath, toolArgs?.filePath, toolArgs?.path)

  const normalizedContent = content ?? ''
  const lineCount =
    toolResult?.lineCount ??
    toolResult?.numLines ??
    toolResult?.totalLines ??
    (normalizedContent ? normalizedContent.split('\n').length : 0)
  const size =
    toolResult?.size ??
    toolResult?.bytes ??
    (normalizedContent ? normalizedContent.length : 0)

  return {
    result: {
      ...(path ? { filePath: path, path } : {}),
      ...(options.skillId ? { skillId: options.skillId } : {}),
      ...(options.skillName ? { skillName: options.skillName } : {}),
      ...(typeof toolResult?.path === 'string' ? { referencePath: toolResult.path } : {}),
      content: preview.text,
      lineCount,
      size,
      language: toolResult?.language,
      contentTruncated: preview.truncated,
      contentOmitted: binaryLike,
      omittedReason: binaryLike ? 'binary_like' : undefined,
      contentChars: normalizedContent.length
    },
    flags: {
      compacted: preview.truncated || binaryLike,
      truncated: preview.truncated,
      binaryLikeOmitted: binaryLike
    }
  }
}

function summarizeWriteResult(toolArgs: Record<string, any>, toolResult: any): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult) as Record<string, any>
  const content =
    extractWriteContentFromSources({
      directContentCandidates: [
        normalizedToolResult?.content,
        normalizedToolResult?.fileContent,
        normalizedToolResult?.data,
        normalizedToolResult?.newContent,
        normalizedToolResult?.mappedToolInput?.content,
        toolArgs?.content,
        toolArgs?.data,
        toolArgs?.newContent
      ],
      commandCandidates: [
        toolArgs?.innerCommand,
        toolArgs?.command,
        normalizedToolResult?.command,
        normalizedToolResult?.mappedToolInput?.innerCommand,
        normalizedToolResult?.mappedToolInput?.command
      ]
    }) ||
    extractPrimaryText(normalizedToolResult) ||
    extractPrimaryText(toolResult)

  const binaryLike = isBinaryLikeText(content)
  const preview = binaryLike
    ? { text: '[Binary or base64-like content omitted from main chat payload.]', truncated: true }
    : truncateText(content ?? '', WRITE_PREVIEW_CHARS, WRITE_PREVIEW_LINES)

  const path = extractPath(
    normalizedToolResult?.filePath,
    normalizedToolResult?.absolutePath,
    normalizedToolResult?.mappedToolInput?.filePath,
    normalizedToolResult?.mappedToolInput?.path,
    toolArgs?.filePath,
    toolArgs?.path
  )
  const normalizedContent = content ?? ''
  const lineCount =
    typeof normalizedToolResult?.lineCount === 'number'
      ? normalizedToolResult.lineCount
      : typeof normalizedToolResult?.numLines === 'number'
        ? normalizedToolResult.numLines
        : countTextLines(normalizedContent)
  const size =
    typeof normalizedToolResult?.size === 'number'
      ? normalizedToolResult.size
      : typeof normalizedToolResult?.bytes === 'number'
        ? normalizedToolResult.bytes
        : normalizedContent.length

  return {
    result: {
      ...(path ? { filePath: path, path } : {}),
      content: preview.text,
      lineCount,
      size,
      language: normalizedToolResult?.language ?? toolResult?.language,
      contentTruncated: preview.truncated,
      contentOmitted: binaryLike,
      omittedReason: binaryLike ? 'binary_like' : undefined,
      contentChars: normalizedContent.length
    },
    flags: {
      compacted: preview.truncated || binaryLike,
      truncated: preview.truncated,
      binaryLikeOmitted: binaryLike
    }
  }
}

function summarizeEditResult(toolArgs: Record<string, any>, toolResult: any): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult) as Record<string, any>
  const filePath = extractPath(
    normalizedToolResult?.filePath,
    normalizedToolResult?.mappedToolInput?.filePath,
    normalizedToolResult?.mappedToolInput?.path,
    normalizedToolResult?.absolutePath,
    toolResult?.filePath,
    toolArgs?.filePath,
    toolArgs?.path
  )

  const explicitDiff =
    typeof normalizedToolResult?.diff === 'string'
      ? normalizedToolResult.diff
      : typeof normalizedToolResult?.changes === 'string'
        ? normalizedToolResult.changes
        : typeof normalizedToolResult?.patch === 'string'
          ? normalizedToolResult.patch
          : typeof normalizedToolResult?.content === 'string'
            ? normalizedToolResult.content
            : undefined

  const managedPatch =
    explicitDiff && explicitDiff.trim().length > 0
      ? explicitDiff
      : extractManagedPatchFromSources([
          typeof normalizedToolResult?.input?.command === 'string'
            ? normalizedToolResult.input.command
            : undefined,
          typeof normalizedToolResult?.command === 'string' ? normalizedToolResult.command : undefined,
          typeof normalizedToolResult?.mappedToolInput?.command === 'string'
            ? normalizedToolResult.mappedToolInput.command
            : undefined,
          typeof toolArgs?.command === 'string' ? toolArgs.command : undefined,
          typeof toolArgs?.innerCommand === 'string' ? toolArgs.innerCommand : undefined,
          typeof toolArgs?.input === 'string' ? toolArgs.input : undefined,
          typeof toolArgs?.input?.command === 'string' ? toolArgs.input.command : undefined
        ])

  const diffSource =
    explicitDiff && explicitDiff.trim().length > 0
      ? explicitDiff
      : buildCompactEditPreview({
          filePath: filePath ?? undefined,
          command: managedPatch,
          before:
            typeof normalizedToolResult?.before === 'string' ? normalizedToolResult.before : undefined,
          after:
            typeof normalizedToolResult?.after === 'string' ? normalizedToolResult.after : undefined,
          oldText:
            typeof normalizedToolResult?.oldString === 'string'
              ? normalizedToolResult.oldString
              : typeof normalizedToolResult?.oldContent === 'string'
                ? normalizedToolResult.oldContent
                : undefined,
          newText:
            typeof normalizedToolResult?.newString === 'string'
              ? normalizedToolResult.newString
              : typeof normalizedToolResult?.newContent === 'string'
                ? normalizedToolResult.newContent
                : undefined
        }) ?? ''

  const binaryLike = isBinaryLikeText(diffSource)
  const preview = binaryLike
    ? { text: '[Binary or base64-like diff omitted from main chat payload.]', truncated: true }
    : truncateText(diffSource ?? '', EDIT_PREVIEW_CHARS, EDIT_PREVIEW_LINES)

  return {
    result: {
      ...(filePath ? { filePath, path: filePath } : {}),
      diff: preview.text,
      diffTruncated: preview.truncated,
      diffOmitted: binaryLike,
      omittedReason: binaryLike ? 'binary_like' : undefined,
      language: toolResult?.language,
      changeCount:
        typeof toolResult?.changeCount === 'number'
          ? toolResult.changeCount
          : undefined
    },
    flags: {
      compacted: preview.truncated || binaryLike,
      truncated: preview.truncated,
      binaryLikeOmitted: binaryLike
    }
  }
}

function summarizeDynamicFindResult(toolArgs: Record<string, any>, toolResult: any): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const resultsCandidate = Array.isArray((normalizedToolResult as any)?.results)
    ? (normalizedToolResult as any).results
    : Array.isArray(normalizedToolResult)
      ? normalizedToolResult
      : []
  const results = resultsCandidate.slice(0, WEB_SEARCH_RESULT_LIMIT).map((entry: any) => ({
    toolName: entry?.toolName ?? entry?.name ?? entry?.tool ?? 'tool',
    description: truncateText(normalizeText(entry?.description ?? entry?.summary ?? ''), 240, 4).text,
    gatewayName: typeof entry?.gatewayName === 'string' ? entry.gatewayName : undefined,
    mcpServerName:
      typeof entry?.mcpServerName === 'string'
        ? entry.mcpServerName
        : typeof entry?.server === 'string'
          ? entry.server
          : undefined
  }))

  return {
    result: {
      query:
        typeof (normalizedToolResult as any)?.query === 'string'
          ? (normalizedToolResult as any).query
          : toolArgs.query,
      totalMatches:
        (normalizedToolResult as any)?.totalMatches ??
        (normalizedToolResult as any)?.count ??
        (normalizedToolResult as any)?.total ??
        resultsCandidate.length,
      results
    },
    flags: {
      compacted: resultsCandidate.length > results.length,
      truncated: resultsCandidate.length > results.length,
      binaryLikeOmitted: false
    }
  }
}

function summarizeToolFindResult(
  toolArgs: Record<string, any>,
  toolResult: any
): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const resultsCandidate = Array.isArray((normalizedToolResult as any)?.results)
    ? (normalizedToolResult as any).results
    : Array.isArray(normalizedToolResult)
      ? normalizedToolResult
      : []

  const results = resultsCandidate.slice(0, WEB_SEARCH_RESULT_LIMIT).map((entry: any) => ({
    toolId: entry?.toolId ?? entry?.id ?? entry?.ref ?? 'tool',
    ref: typeof entry?.ref === 'string' ? entry.ref : undefined,
    family: typeof entry?.family === 'string' ? entry.family : undefined,
    title: entry?.title ?? entry?.toolId ?? entry?.id ?? entry?.ref ?? 'Tool',
    description: truncateText(normalizeText(entry?.description ?? ''), 240, 4).text,
    hint: typeof entry?.hint === 'string' ? truncateText(entry.hint, 240, 4).text : undefined,
    riskLevel: typeof entry?.riskLevel === 'string' ? entry.riskLevel : undefined,
    source: typeof entry?.source === 'string' ? entry.source : undefined,
    executable: typeof entry?.executable === 'string' ? entry.executable : undefined,
    lastValidationStatus:
      typeof entry?.lastValidationStatus === 'string' ? entry.lastValidationStatus : undefined
  }))

  return {
    result: {
      query:
        typeof (normalizedToolResult as any)?.query === 'string'
          ? (normalizedToolResult as any).query
          : toolArgs.query,
      totalMatches:
        (normalizedToolResult as any)?.totalMatches ??
        (normalizedToolResult as any)?.count ??
        (normalizedToolResult as any)?.total ??
        resultsCandidate.length,
      results
    },
    flags: {
      compacted: resultsCandidate.length > results.length,
      truncated: resultsCandidate.length > results.length,
      binaryLikeOmitted: false
    }
  }
}

function summarizeCliToolResult(
  toolArgs: Record<string, any>,
  toolResult: any
): { result: any; flags: CompactToolFlags } {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const stdoutPreview = truncateText(
    normalizeText((normalizedToolResult as any)?.stdout ?? ''),
    BASH_STDOUT_PREVIEW_CHARS,
    BASH_STDOUT_PREVIEW_LINES
  )
  const stderrPreview = truncateText(
    normalizeText((normalizedToolResult as any)?.stderr ?? ''),
    BASH_STDERR_PREVIEW_CHARS,
    BASH_STDERR_PREVIEW_LINES
  )

  return {
    result: {
      toolId:
        typeof (normalizedToolResult as any)?.toolId === 'string'
          ? (normalizedToolResult as any).toolId
          : typeof toolArgs.toolId === 'string'
            ? toolArgs.toolId
            : undefined,
      title:
        typeof (normalizedToolResult as any)?.title === 'string'
          ? (normalizedToolResult as any).title
          : undefined,
      executable:
        typeof (normalizedToolResult as any)?.executable === 'string'
          ? (normalizedToolResult as any).executable
          : undefined,
      args: Array.isArray((normalizedToolResult as any)?.args)
        ? (normalizedToolResult as any).args.slice(0, 16)
        : undefined,
      cwd:
        typeof (normalizedToolResult as any)?.cwd === 'string'
          ? (normalizedToolResult as any).cwd
          : undefined,
      exitCode:
        typeof (normalizedToolResult as any)?.exitCode === 'number'
          ? (normalizedToolResult as any).exitCode
          : undefined,
      outputMode:
        typeof (normalizedToolResult as any)?.outputMode === 'string'
          ? (normalizedToolResult as any).outputMode
          : undefined,
      parseMode:
        typeof (normalizedToolResult as any)?.parseMode === 'string'
          ? (normalizedToolResult as any).parseMode
          : undefined,
      durationMs:
        typeof (normalizedToolResult as any)?.durationMs === 'number'
          ? (normalizedToolResult as any).durationMs
          : undefined,
      stdout: stdoutPreview.text,
      stdoutTruncated: stdoutPreview.truncated,
      stderr: stderrPreview.text,
      stderrTruncated: stderrPreview.truncated,
      parsedOutput:
        (normalizedToolResult as any)?.parsedOutput !== undefined
          ? summarizeValue((normalizedToolResult as any).parsedOutput)
          : undefined,
      error:
        typeof (normalizedToolResult as any)?.error === 'string'
          ? (normalizedToolResult as any).error
          : undefined,
      requiresApproval: (normalizedToolResult as any)?.requiresApproval === true
    },
    flags: {
      compacted:
        stdoutPreview.truncated ||
        stderrPreview.truncated ||
        (normalizedToolResult as any)?.parsedOutput !== undefined,
      truncated: stdoutPreview.truncated || stderrPreview.truncated,
      binaryLikeOmitted: false
    }
  }
}

function summarizeSubagentResult(toolResult: any): { result: any; flags: CompactToolFlags } {
  const base = summarizeValue(toolResult)
  return {
    result: base,
    flags: {
      compacted: true,
      truncated: safeStringify(base).length < safeStringify(toolResult).length,
      binaryLikeOmitted: false
    }
  }
}

export function resolveToolOperationKind(input: CompactToolInput): ToolOperationKind {
  const toolName = normalizeInternalMode4HelperName(input.toolName)
  const originalToolName = normalizeInternalMode4HelperName(input.originalToolName)
  const mappedToolName = normalizeInternalMode4HelperName(extractNativeMappedToolName(input.toolResult))
  const names = [toolName, originalToolName, mappedToolName].filter(Boolean)
  const toolArgs = input.toolArgs ?? {}
  const toolResult = input.toolResult
  const action = extractToolActionName(toolArgs, toolResult)
  const nativeAutomationEnvelope = getNativeAutomationEnvelope(toolResult)
  const isNativeAutomationPack = names.some(isNativeAutomationPackName) || Boolean(nativeAutomationEnvelope)
  const unwrappedResult = pickPlainObject(unwrapNativeAutomationData(toolResult))
  const explicitOperationKind =
    normalizeExplicitOperationKind(input.metadata?.operationKind) ||
    normalizeExplicitOperationKind(input.metadata?.operation_kind) ||
    normalizeExplicitOperationKind(unwrappedResult?.operationKind) ||
    normalizeExplicitOperationKind(unwrappedResult?.operation_kind) ||
    normalizeExplicitOperationKind((toolResult as any)?.operationKind) ||
    normalizeExplicitOperationKind((toolResult as any)?.operation_kind)
  const brokerOperationKind = resolveBrokerOperationKind(toolArgs, toolResult)

  if (explicitOperationKind) return explicitOperationKind
  if (brokerOperationKind && (names.includes('batshit_tool_use') || names.includes('native_batshit_tool_use'))) {
    return brokerOperationKind
  }
  if (input.isSubagent || input.toolProvider === 'subagent') return 'subagent'
  if (names.some((name) => name.includes('subagent_') || name === 'call_subagent')) return 'subagent'
  if (isNativeAutomationPack) {
    const mappedKind = resolveOperationKindFromNames(mappedToolName ? [mappedToolName] : [])
    if (mappedKind && mappedKind !== 'bash') return mappedKind

    switch (action) {
      case 'bash_execute':
        return 'bash'
      case 'invoke':
      case 'read':
        return 'skill_read'
      case 'batshit_tool_search':
        return 'tool_find'
      case 'batshit_tool_use':
        return brokerOperationKind ?? 'unknown_tool'
      case 'dynamic_mcp_find':
        return 'dynamic_find'
      case 'dynamic_mcp_use':
        return 'dynamic_use'
      case 'cli_tool_find':
        return 'tool_find'
      case 'cli_tool_use':
        return 'cli_tool'
      case 'agent_browser_find':
        return 'agent_browser_find'
      case 'agent_browser_use':
        return 'agent_browser_use'
      case 'artifact_find':
        return 'artifact_find'
      case 'artifact_use':
        return 'artifact_use'
      case 'runtime_addon_list':
      case 'runtime_addon_status':
        return 'fabric_find'
      case 'runtime_addon_prepare':
      case 'runtime_addon_start':
      case 'runtime_addon_stop':
        return 'fabric_use'
      case 'web_search':
        return 'web_search'
      case 'fetch_zip':
        return 'fetch_zip'
      default:
        break
    }
  }
  const namedKind = resolveOperationKindFromNames(names)
  if (namedKind) return namedKind
  if (names.includes('native_skill') || names.includes('native_skill_reference')) {
    if (action === 'read' || action === 'invoke') return 'skill_read'
    return 'unknown_tool'
  }

  return 'unknown_tool'
}

export function resolveToolRendererFamily(operationKind: ToolOperationKind): ToolRendererFamily {
  switch (operationKind) {
    case 'read_file':
      return 'read_file'
    case 'skill_read':
      return 'skill_read'
    case 'write_file':
      return 'write_file'
    case 'edit_file':
      return 'edit_file'
    case 'web_search':
      return 'web_search'
    case 'search_files':
    case 'bash':
      return 'bash'
    case 'list_files':
      return 'list_files'
    case 'dynamic_find':
      return 'dynamic_find'
    case 'artifact_find':
    case 'fetch_zip':
    case 'artifact_use':
    case 'fabric_find':
    case 'fabric_use':
    case 'agent_browser_find':
    case 'agent_browser_use':
      return 'generic_tool'
    case 'tool_find':
      return 'tool_find'
    case 'cli_tool':
      return 'cli_tool'
    case 'subagent':
      return 'subagent'
    case 'dynamic_use':
    case 'unknown_tool':
    default:
      return 'generic_tool'
  }
}

export function resolveRawSidecarPolicy(operationKind: ToolOperationKind): ToolRawSidecarPolicy {
  switch (operationKind) {
    case 'read_file':
    case 'skill_read':
    case 'edit_file':
    case 'subagent':
      return 'always'
    case 'write_file':
    case 'web_search':
    case 'search_files':
    case 'list_files':
    case 'bash':
    case 'fetch_zip':
    case 'cli_tool':
    case 'artifact_use':
    case 'fabric_find':
    case 'fabric_use':
    case 'agent_browser_use':
    case 'dynamic_use':
    case 'unknown_tool':
      return 'limited'
    case 'artifact_find':
    case 'agent_browser_find':
    case 'dynamic_find':
    case 'tool_find':
    default:
      return 'never'
  }
}

function compactToolArgs(operationKind: ToolOperationKind, toolArgs: Record<string, any>, toolResult: any): Record<string, any> {
  const normalizedToolResult = unwrapNativeAutomationData(toolResult)
  const mappedToolInput = extractNativeMappedToolInput(toolResult)
  const nestedToolArgs = extractNestedToolArgs(toolArgs)
  const nativeInputs = collectNativeInputRecords(toolArgs, toolResult)
  switch (operationKind) {
    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      const filePath = extractPath(
        toolArgs.filePath,
        toolArgs.path,
        mappedToolInput?.filePath,
        mappedToolInput?.path,
        (normalizedToolResult as any)?.filePath,
        (normalizedToolResult as any)?.absolutePath,
        toolResult?.filePath,
        toolResult?.absolutePath
      )
      const compact: Record<string, any> = filePath ? { filePath, path: filePath } : {}
      if (typeof mappedToolInput?.command === 'string') compact.command = mappedToolInput.command
      else if (typeof toolArgs.command === 'string') compact.command = toolArgs.command
      if (typeof mappedToolInput?.innerCommand === 'string') compact.innerCommand = mappedToolInput.innerCommand
      else if (typeof toolArgs.innerCommand === 'string') compact.innerCommand = toolArgs.innerCommand
      if (typeof mappedToolInput?.projectPath === 'string') compact.projectPath = mappedToolInput.projectPath
      else if (typeof toolArgs.projectPath === 'string') compact.projectPath = toolArgs.projectPath
      if (typeof mappedToolInput?.cwd === 'string') compact.cwd = mappedToolInput.cwd
      else if (typeof toolArgs.cwd === 'string') compact.cwd = toolArgs.cwd
      if (typeof mappedToolInput?.workingDir === 'string') compact.workingDir = mappedToolInput.workingDir
      else if (typeof toolArgs.workingDir === 'string') compact.workingDir = toolArgs.workingDir
      return compact
    }
    case 'skill_read': {
      const skillAction = extractToolActionName(toolArgs, toolResult) === 'invoke' ? 'invoke' : 'read'
      return {
        ...(typeof toolArgs.skillId === 'string'
          ? { skillId: toolArgs.skillId }
          : typeof nestedToolArgs.skillId === 'string'
            ? { skillId: nestedToolArgs.skillId }
            : {}),
        ...(typeof toolArgs.path === 'string'
          ? { path: toolArgs.path }
          : typeof nestedToolArgs.path === 'string'
            ? { path: nestedToolArgs.path }
          : skillAction === 'invoke'
            ? { path: 'SKILL.md' }
            : {}),
        action: skillAction
      }
    }
    case 'web_search':
      return {
        ...(typeof toolArgs.query === 'string'
          ? { query: toolArgs.query }
          : typeof nativeInputs.directInput?.query === 'string'
            ? { query: nativeInputs.directInput.query }
          : typeof nativeInputs.nestedInput?.query === 'string'
            ? { query: nativeInputs.nestedInput.query }
          : typeof (normalizedToolResult as any)?.query === 'string'
            ? { query: (normalizedToolResult as any).query }
            : {}),
        ...(typeof toolArgs.maxResults === 'number'
          ? { maxResults: toolArgs.maxResults }
          : typeof nativeInputs.directInput?.maxResults === 'number'
            ? { maxResults: nativeInputs.directInput.maxResults }
            : {}),
        ...(typeof toolArgs.region === 'string'
          ? { region: toolArgs.region }
          : typeof nativeInputs.directInput?.region === 'string'
            ? { region: nativeInputs.directInput.region }
            : {})
      }
    case 'fetch_zip': {
      const payload = extractFetchZipPayload(toolResult)
      const zipId = firstString(
        toolArgs.zipId,
        nestedToolArgs.zipId,
        nativeInputs.directInput?.zipId,
        nativeInputs.nestedInput?.zipId,
        payload?.zipId
      )
      const includeContent =
        typeof toolArgs.includeContent === 'boolean'
          ? toolArgs.includeContent
          : typeof nestedToolArgs.includeContent === 'boolean'
            ? nestedToolArgs.includeContent
            : typeof nativeInputs.directInput?.includeContent === 'boolean'
              ? nativeInputs.directInput.includeContent
              : typeof nativeInputs.nestedInput?.includeContent === 'boolean'
                ? nativeInputs.nestedInput.includeContent
                : undefined
      const maxChars =
        typeof toolArgs.maxChars === 'number'
          ? toolArgs.maxChars
          : typeof nestedToolArgs.maxChars === 'number'
            ? nestedToolArgs.maxChars
            : typeof nativeInputs.directInput?.maxChars === 'number'
              ? nativeInputs.directInput.maxChars
              : typeof nativeInputs.nestedInput?.maxChars === 'number'
                ? nativeInputs.nestedInput.maxChars
                : undefined

      return {
        ...(zipId ? { zipId } : {}),
        ...(typeof includeContent === 'boolean' ? { includeContent } : {}),
        ...(typeof maxChars === 'number' ? { maxChars } : {})
      }
    }
    case 'list_files':
    case 'search_files':
    case 'bash':
      return {
        ...(typeof mappedToolInput?.command === 'string'
          ? { command: mappedToolInput.command }
          : typeof toolArgs.command === 'string'
          ? { command: toolArgs.command }
          : typeof (normalizedToolResult as any)?.command === 'string'
            ? { command: (normalizedToolResult as any).command }
            : {}),
        ...(typeof mappedToolInput?.innerCommand === 'string'
          ? { innerCommand: mappedToolInput.innerCommand }
          : typeof toolArgs.innerCommand === 'string'
            ? { innerCommand: toolArgs.innerCommand }
            : {}),
        ...(typeof mappedToolInput?.path === 'string'
          ? { path: mappedToolInput.path }
          : typeof toolArgs.path === 'string'
            ? { path: toolArgs.path }
            : {}),
        ...(typeof mappedToolInput?.dirPath === 'string'
          ? { dirPath: mappedToolInput.dirPath }
          : typeof toolArgs.dirPath === 'string'
            ? { dirPath: toolArgs.dirPath }
            : {}),
        ...(typeof mappedToolInput?.projectPath === 'string'
          ? { projectPath: mappedToolInput.projectPath }
          : typeof toolArgs.projectPath === 'string'
            ? { projectPath: toolArgs.projectPath }
            : {}),
        ...(typeof mappedToolInput?.cwd === 'string'
          ? { cwd: mappedToolInput.cwd }
          : typeof toolArgs.cwd === 'string'
            ? { cwd: toolArgs.cwd }
            : {}),
        ...(typeof mappedToolInput?.workingDir === 'string'
          ? { workingDir: mappedToolInput.workingDir }
          : typeof toolArgs.workingDir === 'string'
            ? { workingDir: toolArgs.workingDir }
            : {}),
        ...(typeof mappedToolInput?.query === 'string'
          ? { query: mappedToolInput.query }
          : typeof toolArgs.query === 'string'
            ? { query: toolArgs.query }
            : {}),
        ...(typeof mappedToolInput?.pattern === 'string'
          ? { pattern: mappedToolInput.pattern }
          : typeof toolArgs.pattern === 'string'
            ? { pattern: toolArgs.pattern }
            : {})
      }
    case 'dynamic_find': {
      const query = firstString(toolArgs.query, nestedToolArgs.query, nativeInputs.directInput?.query)
      const limit =
        typeof toolArgs.limit === 'number'
          ? toolArgs.limit
          : typeof nestedToolArgs.limit === 'number'
            ? nestedToolArgs.limit
            : typeof nativeInputs.directInput?.limit === 'number'
              ? nativeInputs.directInput.limit
              : undefined

      return {
        ...(query ? { query } : {}),
        ...(typeof limit === 'number' ? { limit } : {})
      }
    }
    case 'tool_find': {
      const query = firstString(
        toolArgs.query,
        nestedToolArgs.query,
        nativeInputs.directInput?.query,
        nativeInputs.nestedInput?.query,
        nativeInputs.resultData?.query
      )
      const family =
        firstString(
          toolArgs.family,
          nestedToolArgs.family,
          nativeInputs.directInput?.family,
          nativeInputs.nestedInput?.family
        ) ??
        (Array.isArray((normalizedToolResult as any)?.families) &&
        typeof (normalizedToolResult as any).families[0] === 'string'
          ? (normalizedToolResult as any).families[0]
          : undefined)
      const families = Array.isArray(toolArgs.families)
        ? toolArgs.families
        : Array.isArray(nestedToolArgs.families)
          ? nestedToolArgs.families
          : Array.isArray(nativeInputs.directInput?.families)
            ? nativeInputs.directInput.families
            : Array.isArray(nativeInputs.nestedInput?.families)
              ? nativeInputs.nestedInput.families
              : Array.isArray((normalizedToolResult as any)?.families)
                ? (normalizedToolResult as any).families
                : undefined
      const limit =
        typeof toolArgs.limit === 'number'
          ? toolArgs.limit
          : typeof nestedToolArgs.limit === 'number'
            ? nestedToolArgs.limit
            : typeof nativeInputs.directInput?.limit === 'number'
              ? nativeInputs.directInput.limit
              : typeof nativeInputs.nestedInput?.limit === 'number'
                ? nativeInputs.nestedInput.limit
                : typeof nativeInputs.resultData?.limit === 'number'
                  ? nativeInputs.resultData.limit
                  : undefined

      return {
        ...(query ? { query } : {}),
        ...(family ? { family } : {}),
        ...(families ? { families } : {}),
        ...(typeof limit === 'number' ? { limit } : {})
      }
    }
    case 'cli_tool': {
      const toolId = firstString(
        toolArgs.toolId,
        toolArgs.tool_id,
        nestedToolArgs.toolId,
        nestedToolArgs.tool_id,
        nativeInputs.directInput?.toolId,
        nativeInputs.directInput?.tool_id,
        nativeInputs.nestedInput?.toolId,
        nativeInputs.nestedInput?.tool_id,
        extractTargetFromTypedRef(toolArgs.ref),
        extractTargetFromTypedRef(nestedToolArgs.ref),
        (normalizedToolResult as any)?.target,
        (normalizedToolResult as any)?.toolId
      )
      const allowRisky =
        typeof toolArgs.allowRisky === 'boolean'
          ? toolArgs.allowRisky
          : typeof nativeInputs.directInput?.allowRisky === 'boolean'
            ? nativeInputs.directInput.allowRisky
            : undefined

      return {
        ...(toolId ? { toolId } : {}),
        ...(typeof allowRisky === 'boolean' ? { allowRisky } : {})
      }
    }
    case 'artifact_use':
    case 'fabric_use':
      return {
        ...(typeof toolArgs.ref === 'string'
          ? { ref: toolArgs.ref }
          : typeof nestedToolArgs.ref === 'string'
            ? { ref: nestedToolArgs.ref }
          : typeof nativeInputs.directInput?.ref === 'string'
            ? { ref: nativeInputs.directInput.ref }
            : typeof nativeInputs.nestedInput?.ref === 'string'
              ? { ref: nativeInputs.nestedInput.ref }
              : typeof (normalizedToolResult as any)?.ref === 'string'
                ? { ref: (normalizedToolResult as any).ref }
                : {}),
        ...(resolveToolActivitySettingsName({ toolArgs, toolResult }, operationKind)
          ? { target: resolveToolActivitySettingsName({ toolArgs, toolResult }, operationKind) }
          : {}),
        ...(nativeInputs.directInput?.input && isPlainObject(nativeInputs.directInput.input)
          ? { input: nativeInputs.directInput.input }
          : nativeInputs.nestedInput && Object.keys(nativeInputs.nestedInput).length > 0
            ? { input: nativeInputs.nestedInput }
            : {})
      }
    case 'dynamic_use':
      return {
        ...(resolveToolActivitySettingsName({ toolArgs, toolResult }, operationKind)
          ? { toolName: resolveToolActivitySettingsName({ toolArgs, toolResult }, operationKind) }
          : {}),
        ...(nativeInputs.directInput?.params && isPlainObject(nativeInputs.directInput.params)
          ? { params: nativeInputs.directInput.params }
          : nativeInputs.params
            ? { params: nativeInputs.params }
            : {})
      }
    case 'agent_browser_find':
      return {
        ...(typeof toolArgs.query === 'string'
          ? { query: toolArgs.query }
          : typeof nativeInputs.directInput?.query === 'string'
            ? { query: nativeInputs.directInput.query }
            : {}),
        ...(typeof toolArgs.limit === 'number'
          ? { limit: toolArgs.limit }
          : typeof nativeInputs.directInput?.limit === 'number'
            ? { limit: nativeInputs.directInput.limit }
            : {})
      }
    case 'agent_browser_use':
      return {
        ...(resolveToolActivitySettingsName({ toolArgs, toolResult }, operationKind)
          ? { toolName: resolveToolActivitySettingsName({ toolArgs, toolResult }, operationKind) }
          : {}),
        ...(nativeInputs.directInput?.params && isPlainObject(nativeInputs.directInput.params)
          ? { params: nativeInputs.directInput.params }
          : nativeInputs.params
            ? { params: nativeInputs.params }
            : {})
      }
    case 'subagent':
      return summarizeValue(toolArgs) as Record<string, any>
    case 'unknown_tool':
    default:
      return summarizeValue(toolArgs) as Record<string, any>
  }
}

export function normalizeCompactTool(input: CompactToolInput): CompactToolNormalization {
  const operationKind = resolveToolOperationKind(input)
  const rendererFamily = resolveToolRendererFamily(operationKind)
  const rawSidecarPolicy = resolveRawSidecarPolicy(operationKind)
  const toolArgs = input.toolArgs && isPlainObject(input.toolArgs) ? { ...input.toolArgs } : {}
  const toolResult = input.toolResult
  const artifactControlPresentation = buildArtifactControlPresentation({
    operationKind,
    rendererFamily,
    rawSidecarPolicy,
    toolArgs,
    toolResult
  })
  if (artifactControlPresentation) return artifactControlPresentation

  const compactArgs = compactToolArgs(operationKind, toolArgs, toolResult)

  let compactResult: any
  let flags: CompactToolFlags = {
    compacted: false,
    truncated: false,
    binaryLikeOmitted: false
  }

  switch (operationKind) {
    case 'read_file': {
      const summarized = summarizeReadResult(toolArgs, toolResult, {})
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'skill_read': {
      const skillAction = extractToolActionName(toolArgs, toolResult) === 'invoke' ? 'invoke' : 'read'
      const nestedToolArgs = extractNestedToolArgs(toolArgs)
      const normalizedSkillResult = unwrapNativeAutomationData(toolResult)
      const nestedInputArgs = extractNestedToolArgs(
        isPlainObject((normalizedSkillResult as any)?.input)
          ? (normalizedSkillResult as any).input
          : isPlainObject(toolResult?.input)
            ? toolResult.input
            : null
      )
      const summarized = summarizeReadResult(toolArgs, toolResult, {
        path:
          extractPath(
            (normalizedSkillResult as any)?.path,
            toolResult?.path,
            toolArgs?.path,
            nestedToolArgs?.path,
            nestedInputArgs?.path
          ) ??
          (skillAction === 'invoke' ? 'SKILL.md' : null),
        skillId:
          typeof (normalizedSkillResult as any)?.skillId === 'string'
            ? (normalizedSkillResult as any).skillId
            : typeof (normalizedSkillResult as any)?.skill?.id === 'string'
              ? (normalizedSkillResult as any).skill.id
              : typeof toolResult?.skillId === 'string'
                ? toolResult.skillId
                : typeof toolResult?.skill?.id === 'string'
                  ? toolResult.skill.id
              : typeof toolArgs?.skillId === 'string'
                ? toolArgs.skillId
                : typeof nestedToolArgs?.skillId === 'string'
                  ? nestedToolArgs.skillId
                  : typeof nestedInputArgs?.skillId === 'string'
                    ? nestedInputArgs.skillId
                : null,
        skillName:
          typeof (normalizedSkillResult as any)?.skillName === 'string'
            ? (normalizedSkillResult as any).skillName
            : typeof (normalizedSkillResult as any)?.skill?.name === 'string'
              ? (normalizedSkillResult as any).skill.name
              : typeof toolResult?.skillName === 'string'
                ? toolResult.skillName
                : typeof toolResult?.skill?.name === 'string'
                  ? toolResult.skill.name
              : typeof toolArgs?.skillName === 'string'
                ? toolArgs.skillName
                : typeof nestedToolArgs?.skillName === 'string'
                  ? nestedToolArgs.skillName
                : null
      })
      compactResult = {
        ...summarized.result,
        action: skillAction
      }
      flags = summarized.flags
      break
    }
    case 'write_file': {
      const summarized = summarizeWriteResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'edit_file': {
      const summarized = summarizeEditResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'web_search': {
      const summarized = summarizeWebSearchResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'list_files': {
      const summarized = summarizeListResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'search_files': {
      const summarized = summarizeSearchResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'bash': {
      const summarized = summarizeBashResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'fetch_zip': {
      const summarized = summarizeFetchZipResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'dynamic_find': {
      const summarized = summarizeDynamicFindResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'tool_find': {
      const summarized = summarizeToolFindResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'cli_tool': {
      const summarized = summarizeCliToolResult(toolArgs, toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'subagent': {
      const summarized = summarizeSubagentResult(toolResult)
      compactResult = summarized.result
      flags = summarized.flags
      break
    }
    case 'dynamic_use':
    case 'artifact_use':
    case 'fabric_use':
    case 'agent_browser_use':
    case 'unknown_tool':
    default: {
      const normalizedGenericResult = unwrapNativeAutomationData(toolResult)
      compactResult = summarizeValue(normalizedGenericResult)
      flags = {
        compacted: safeStringify(compactResult).length < safeStringify(toolResult).length,
        truncated: safeStringify(compactResult).length < safeStringify(toolResult).length,
        binaryLikeOmitted: false
      }
      break
    }
  }

  return {
    operationKind,
    rendererFamily,
    displayToolName:
      operationKind === 'artifact_use' || operationKind === 'fabric_use'
        ? formatBatshitToolTargetDisplayName(extractControlTarget(toolArgs, toolResult))
          ?? undefined
        : undefined,
    toolArgs: compactArgs,
    toolResult: compactResult,
    flags,
    rawSidecarPolicy,
    rawReason:
      operationKind === 'dynamic_find'
        ? 'dynamic-find-main-payload-is-already-compact'
        : operationKind === 'tool_find'
          ? 'tool-find-main-payload-is-already-compact'
        : undefined
  }
}

export function shouldRetainRawSidecar(options: {
  policy: ToolRawSidecarPolicy
  compacted: boolean
  truncated: boolean
  binaryLikeOmitted: boolean
  rawTokens: number
  compactTokens: number
}): boolean {
  const { policy, compacted, truncated, binaryLikeOmitted, rawTokens, compactTokens } = options

  if (policy === 'never') return false
  if (policy === 'always') return true

  if (binaryLikeOmitted || truncated) return true
  if (rawTokens >= 2_000 && rawTokens > compactTokens + 500) return true
  return compacted
}

export function shouldForceCompressToolPayload(options: {
  rawTokens: number
  compactTokens: number
}): boolean {
  return options.rawTokens >= TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS || options.compactTokens >= TOOL_ACTIVITY_FORCE_COMPRESS_TOKENS
}
