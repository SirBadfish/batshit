import { describeCommandPreview, describeOutputCut, failedCommandExitCode, toolOutputCut, type ToolOutputCut } from './toolActivityContract'

export const FULL_FIDELITY_AI_EXPANSION_LANES = new Set([
  'read_file',
  'skill_read',
  'write_file',
  'edit_file'
])

export type CoolToolZipDataLike = {
  id?: string
  content?: unknown
  metadata?: Record<string, any>
  [key: string]: any
}

export function parseCoolToolPayload(value: unknown): Record<string, any> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null
  } catch {
    return null
  }
}

function getCoolToolOperationKind(payload: Record<string, any> | null): string | null {
  const rendererCandidates = [
    payload?.rendererFamily,
    payload?.metadata?.rendererFamily
  ]

  for (const candidate of rendererCandidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim().toLowerCase()
    if (!normalized) continue
    if (normalized.includes('read_file')) return 'read_file'
    if (normalized.includes('skill_read')) return 'skill_read'
    if (normalized.includes('write_file')) return 'write_file'
    if (normalized.includes('edit_file')) return 'edit_file'
  }

  const candidates = [
    payload?.operationKind,
    payload?.metadata?.operationKind,
    payload?.rendererFamily,
    payload?.metadata?.rendererFamily,
    payload?.toolName,
    payload?.originalToolName,
    payload?.displayToolName
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim().toLowerCase()
    if (!normalized) continue
    if (normalized.includes('read_file')) return 'read_file'
    if (normalized.includes('skill_read') || normalized.includes('native_skill')) return 'skill_read'
    if (normalized.includes('write_file') || normalized.includes('overwrite_file')) return 'write_file'
    if (normalized.includes('edit_file')) return 'edit_file'
    if (normalized.includes('list_files')) return 'list_files'
    if (normalized.includes('search_files')) return 'search_files'
    if (normalized.includes('web_search')) return 'web_search'
    if (normalized.includes('bash') || normalized.includes('execute_command')) return 'bash'
    if (normalized.replace(/[^a-z0-9]+/g, '_').includes('fetch_zip')) return 'fetch_zip'
    return normalized
  }

  return null
}

function getCoolToolResult(payload: Record<string, any> | null): unknown {
  return payload?.toolResult ?? payload?.observation ?? payload?.result ?? payload?.output ?? null
}

function getCoolToolArgs(payload: Record<string, any> | null): Record<string, any> {
  const args = payload?.toolArgs ?? payload?.toolInput ?? payload?.input ?? {}
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, any> : {}
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') return value
  }
  return null
}

function firstScalarString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? '')
  }
}

export type CoolToolAiContentPart = { source: 'agent_words' | 'tool_result'; text: string }
export type CoolToolAiContent = { text: string; parts: CoolToolAiContentPart[] }

function sourcePart(source: CoolToolAiContentPart['source'], text: string): CoolToolAiContentPart[] {
  return text ? [{ source, text }] : []
}

function sourceText(parts: CoolToolAiContentPart[]): string {
  return parts.map((part) => part.text).join('')
}

function joinSourceSections(sections: CoolToolAiContentPart[][], separator = '\n'): CoolToolAiContentPart[] {
  return sections.flatMap((section, index) => index === 0 ? section : [
    ...sourcePart('agent_words', separator),
    ...section
  ])
}

function fenceForAiParts(content: string, language = 'text', contentSource: CoolToolAiContentPart['source'] = 'tool_result'): CoolToolAiContentPart[] {
  const ticks = content.match(/`+/g) ?? []
  const longest = ticks.reduce((max, entry) => Math.max(max, entry.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [
    ...sourcePart('agent_words', `${fence}${language || 'text'}\n`),
    ...sourcePart(contentSource, content.trimEnd()),
    ...sourcePart('agent_words', `\n${fence}`)
  ]
}

function formatAiToolHeader(toolName: string, lines: string[]): string {
  return [`Tool result: ${toolName}`, ...lines.filter(Boolean)].join('\n')
}

function buildFullFidelityToolAiContent(
  toolName: string,
  payload: Record<string, any>,
  contentLabel: string,
  content: string,
  language: string,
  contentSource: CoolToolAiContentPart['source']
): CoolToolAiContentPart[] {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const path = firstScalarString(
    result?.filePath,
    result?.path,
    result?.absolutePath,
    args.filePath,
    args.path
  )
  const skill = firstScalarString(result?.skillName, result?.skillId, args.skillId)
  // A shell command read as a file stores an exit code only when it failed (F-P6-5).
  const exitCode = failedCommandExitCode(result)
  const lineCount = firstScalarString(result?.lineCount, result?.numLines, result?.totalLines)
  const size = firstScalarString(result?.size, result?.bytes, result?.contentChars, result?.diffChars)
  const header = formatAiToolHeader(toolName, [
    path ? `Path: ${path}` : '',
    skill ? `Skill: ${skill}` : '',
    exitCode !== undefined ? `Exit code: ${exitCode}` : '',
    lineCount ? `Lines: ${lineCount}` : '',
    size ? `Chars/bytes: ${size}` : ''
  ])

  return [
    ...sourcePart('agent_words', `${header}\n${contentLabel}:\n`),
    ...fenceForAiParts(content, language, contentSource)
  ]
}

/**
 * A failed shell command's own account of its failure (F-P6-5): what it printed, then the step's
 * error. Like a bash result, an exit code plus output explain a failure, so the generic step
 * error is added only when there is no exit code (a command that never ran, or a lane that
 * reports failures as text).
 */
function buildShellFailureBlocks(payload: Record<string, any>): CoolToolAiContentPart[][] {
  const result = asObject(getCoolToolResult(payload))
  const exitCode = failedCommandExitCode(result)
  const output = firstString(result?.commandOutput)
  const error = firstScalarString(payload.error)
  const blocks: CoolToolAiContentPart[][] = []
  if (output !== null && output.trim()) blocks.push([
    ...sourcePart('agent_words', 'Output:\n'),
    ...fenceForAiParts(output, 'text')
  ])
  if (error && exitCode === undefined && !(output !== null && sameTextIgnoringWhitespace(error, output))) {
    blocks.push([
      ...sourcePart('agent_words', 'Error:\n'),
      ...fenceForAiParts(error, 'text')
    ])
  }
  return blocks
}

/** A write or edit that failed: it wrote nothing, so there is no "Written content" or "Diff". */
function isFailedFileChange(payload: Record<string, any>): boolean {
  const result = asObject(getCoolToolResult(payload))
  return (
    failedCommandExitCode(result) !== undefined ||
    typeof result?.commandOutput === 'string' ||
    Boolean(firstScalarString(payload.error))
  )
}

function buildFailedFileChangeAiContent(toolName: string, payload: Record<string, any>): CoolToolAiContentPart[] {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const path = firstScalarString(result?.filePath, result?.path, result?.absolutePath, args.filePath, args.path)
  const exitCode = failedCommandExitCode(result)
  const header = formatAiToolHeader(toolName, [
    path ? `Path: ${path}` : '',
    exitCode !== undefined ? `Exit code: ${exitCode}` : ''
  ])
  return joinSourceSections([
    sourcePart('agent_words', header),
    ...buildShellFailureBlocks(payload)
  ])
}

function buildListToolAiContent(toolName: string, payload: Record<string, any>): CoolToolAiContentPart[] {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const path = firstScalarString(result?.path, result?.dirPath, args.path, args.dirPath)
  const files = Array.isArray(result?.files) ? result.files : []
  const total = firstScalarString(result?.totalItems, result?.totalFiles) ?? String(files.length)
  const exitCode = failedCommandExitCode(result)
  // BL-8: a listing its lane cut holds only its first entries.
  const cut = toolOutputCut(result)
  const renderedFiles = files
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (!entry || typeof entry !== 'object') return ''
      return firstScalarString((entry as any).path, (entry as any).name, (entry as any).filePath) ?? ''
    })
    .filter(Boolean)
  // A listing keeps at most 200 entries; the count is the whole listing's (BL-166 review).
  const listed = Number(total) > renderedFiles.length && renderedFiles.length > 0
    ? ` (the first ${renderedFiles.length} are listed)`
    : ''
  const header = formatAiToolHeader(toolName, [
    path ? `Path: ${path}` : '',
    exitCode !== undefined ? `Exit code: ${exitCode}` : '',
    cut ? `Items: first ${total}${listed}` : `Items: ${total}${listed}`,
    cut ? describeOutputCut(cut) : ''
  ])
  const fileLines = renderedFiles.length
    ? renderedFiles.flatMap((file, index) => [
        ...(index ? sourcePart('agent_words', '\n') : []),
        ...sourcePart('agent_words', '- '),
        ...sourcePart('tool_result', file)
      ])
    : sourcePart('agent_words', '(none)')
  return joinSourceSections([
    [...sourcePart('agent_words', `${header}\nFiles:\n`), ...fileLines],
    ...buildShellFailureBlocks(payload)
  ])
}

function buildBashToolAiContent(toolName: string, payload: Record<string, any>): CoolToolAiContentPart[] {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const command = firstScalarString(result?.command, args.command, args.innerCommand)
  const exitCode = firstScalarString(result?.exitCode)
  const errorCode = firstScalarString(result?.errorCode)
  const stdout = firstString(result?.stdout, result?.output)
  const stderr = firstString(result?.stderr)
  // A command that never started has no exit code and carries its reason in the payload's
  // `error`. Older zips stored an invented `exitCode: 0` beside that reason (F-P5-1), so an
  // error next to exit code 0 means the same thing. A command that exited non-zero is
  // explained by its exit code and stderr, not by the generic step error.
  const error = firstScalarString(payload.error)
  const commandNeverRan = exitCode === null || exitCode === '0'
  const cut = toolOutputCut(result)
  // The stored preview keeps at most 220 lines of stdout; shown as the whole output, those read as
  // all the command printed (found in BL-166's proof).
  const preview = describeCommandPreview(result)
  const blocks: CoolToolAiContentPart[][] = [
    sourcePart('agent_words', formatAiToolHeader(toolName, [
      command ? `Command: ${command}` : '',
      typeof result?.shell === 'string' ? `Shell: ${result.shell}` : '',
      exitCode ? `Exit code: ${exitCode}` : '',
      errorCode ? `Error code: ${errorCode}` : '',
      cut ? describeOutputCut(cut) : '',
      preview ? `Output shown: the ${preview}.` : ''
    ]))
  ]
  if (stdout !== null) blocks.push([
    ...sourcePart('agent_words', 'Stdout:\n'),
    ...fenceForAiParts(stdout, 'text')
  ])
  if (stderr !== null && stderr.trim()) blocks.push([
    ...sourcePart('agent_words', 'Stderr:\n'),
    ...fenceForAiParts(stderr, 'text')
  ])
  if (error && commandNeverRan && !(stderr !== null && sameTextIgnoringWhitespace(error, stderr))) {
    blocks.push([
      ...sourcePart('agent_words', 'Error:\n'),
      ...fenceForAiParts(error, 'text')
    ])
  }
  return joinSourceSections(blocks)
}

function sameTextIgnoringWhitespace(left: string, right: string): boolean {
  return left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim()
}

function buildFetchZipToolAiContent(toolName: string, payload: Record<string, any>): CoolToolAiContentPart[] {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const zipId = firstScalarString(result?.zipId, args.zipId)
  const found = typeof result?.found === 'boolean' ? String(result.found) : null
  const type = firstScalarString(result?.type)
  const description = firstScalarString(result?.description)
  const contentLength = firstScalarString(result?.contentLength)
  const content = firstString(result?.content)
  const header = formatAiToolHeader(toolName, [
    zipId ? `Zip ID: ${zipId}` : '',
    found !== null ? `Found: ${found}` : '',
    type ? `Type: ${type}` : '',
    description ? `Description: ${description}` : '',
    contentLength ? `Content chars: ${contentLength}` : ''
  ])

  if (content !== null) {
    return [
      ...sourcePart('agent_words', `${header}\nContent:\n`),
      ...fenceForAiParts(content, 'text')
    ]
  }

  return [
    ...sourcePart('agent_words', `${header}\nResult:\n`),
    ...fenceForAiParts(compactJson(result), 'json')
  ]
}

function buildGenericToolAiContent(toolName: string, payload: Record<string, any>): CoolToolAiContentPart[] {
  const args = getCoolToolArgs(payload)
  const result = getCoolToolResult(payload)
  const blocks: CoolToolAiContentPart[][] = [sourcePart('agent_words', formatAiToolHeader(toolName, []))]
  if (Object.keys(args).length) {
    blocks.push([
      ...sourcePart('agent_words', 'Arguments:\n'),
      ...fenceForAiParts(compactJson(args), 'json', 'agent_words')
    ])
  }
  if (typeof result === 'string') {
    blocks.push([
      ...sourcePart('agent_words', 'Result:\n'),
      ...fenceForAiParts(result, 'text')
    ])
  } else {
    blocks.push([
      ...sourcePart('agent_words', 'Result:\n'),
      ...fenceForAiParts(compactJson(result), 'json')
    ])
  }
  return joinSourceSections(blocks)
}

/**
 * A search its lane cut (BL-8): the generic transcript, with the cut said in words, as a listing
 * says it (`Matches: first N` and the cut sentence), in place of the raw `outputCut` field. A search
 * nothing cut keeps the generic transcript byte for byte.
 */
function buildCutSearchToolAiContent(toolName: string, payload: Record<string, any>, cut: ToolOutputCut): CoolToolAiContentPart[] {
  const args = getCoolToolArgs(payload)
  const result: Record<string, any> = { ...asObject(getCoolToolResult(payload)) }
  delete result.outputCut
  const matches = firstScalarString(result.totalMatches)
  const blocks: CoolToolAiContentPart[][] = [sourcePart('agent_words', formatAiToolHeader(toolName, [matches ? `Matches: first ${matches}` : '', describeOutputCut(cut)]))]
  if (Object.keys(args).length) {
    blocks.push([
      ...sourcePart('agent_words', 'Arguments:\n'),
      ...fenceForAiParts(compactJson(args), 'json', 'agent_words')
    ])
  }
  blocks.push([
    ...sourcePart('agent_words', 'Result:\n'),
    ...fenceForAiParts(compactJson(result), 'json')
  ])
  return joinSourceSections(blocks)
}

export function buildCoolToolAiContentWithSources(
  _zipId: string,
  zipData: CoolToolZipDataLike,
  payload: Record<string, any> | null
): CoolToolAiContent {
  let parts: CoolToolAiContentPart[]
  if (!payload) {
    parts = sourcePart('agent_words', String(zipData.content ?? ''))
    return { text: sourceText(parts), parts }
  }

  const operationKind = getCoolToolOperationKind(payload)
  const toolName =
    firstScalarString(payload.toolName, payload.displayToolName, payload.originalToolName, operationKind) || 'tool'
  const result = asObject(getCoolToolResult(payload))
  const language = firstScalarString(result?.language, payload.metadata?.language) || 'text'

  // A managed helper cut is unstructured model-visible text. Typed lane formatters must
  // not reinterpret it as missing stdout, a failed fetch, or an empty list on reload.
  if (result?.modelTextOnly === true && typeof result.content === 'string') {
    parts = [
      ...sourcePart('agent_words', `${formatAiToolHeader(toolName, [])}\nResult:\n`),
      ...fenceForAiParts(result.content, 'text')
    ]
    return { text: sourceText(parts), parts }
  }

  switch (operationKind) {
    case 'read_file':
    case 'skill_read': {
      const content = firstString(
        result?.content,
        result?.skillMarkdown,
        result?.fileContent,
        result?.output,
        result?.result,
        result?.data
      )
      if (content !== null) {
        const transcript = buildFullFidelityToolAiContent(toolName, payload, 'Content', content, language, 'tool_result')
        const error = firstScalarString(payload.error)
        // A read's content is what it printed; one that printed nothing and has no exit code
        // (a command Codex declined) explains its failure only through the error.
        if (error && !content.trim() && failedCommandExitCode(result) === undefined) {
          parts = [
            ...transcript,
            ...sourcePart('agent_words', '\nError:\n'),
            ...fenceForAiParts(error, 'text')
          ]
          return { text: sourceText(parts), parts }
        }
        // Find 1: a partial skill read keeps its sizes and next call on later turns too.
        const readMore = typeof result?.readMore === 'string' ? result.readMore.trim() : ''
        parts = readMore
          ? [...transcript, ...sourcePart('agent_words', `\n${readMore}`)]
          : transcript
        return { text: sourceText(parts), parts }
      }
      break
    }
    case 'write_file': {
      if (isFailedFileChange(payload)) {
        parts = buildFailedFileChangeAiContent(toolName, payload)
        return { text: sourceText(parts), parts }
      }
      const content = firstString(result?.content, result?.fileContent, result?.newContent, result?.output)
      if (content !== null) {
        parts = buildFullFidelityToolAiContent(toolName, payload, 'Written content', content, language, 'agent_words')
        return { text: sourceText(parts), parts }
      }
      break
    }
    case 'edit_file': {
      if (isFailedFileChange(payload)) {
        parts = buildFailedFileChangeAiContent(toolName, payload)
        return { text: sourceText(parts), parts }
      }
      const diff = firstString(result?.diff, result?.patch, result?.changes, result?.output)
      if (diff !== null) {
        parts = buildFullFidelityToolAiContent(toolName, payload, 'Diff', diff, 'diff', 'agent_words')
        return { text: sourceText(parts), parts }
      }
      break
    }
    case 'list_files': {
      parts = buildListToolAiContent(toolName, payload)
      return { text: sourceText(parts), parts }
    }
    case 'search_files': {
      const cut = toolOutputCut(result)
      if (cut) {
        parts = buildCutSearchToolAiContent(toolName, payload, cut)
        return { text: sourceText(parts), parts }
      }
      break
    }
    case 'bash': {
      parts = buildBashToolAiContent(toolName, payload)
      return { text: sourceText(parts), parts }
    }
    case 'fetch_zip': {
      parts = buildFetchZipToolAiContent(toolName, payload)
      return { text: sourceText(parts), parts }
    }
    default:
      break
  }

  parts = buildGenericToolAiContent(toolName, payload)
  return { text: sourceText(parts), parts }
}

/** Text-only compatibility surface; the structured builder is the canonical formatter. */
export function buildCoolToolAiContent(
  zipId: string,
  zipData: CoolToolZipDataLike,
  payload: Record<string, any> | null
): string {
  return buildCoolToolAiContentWithSources(zipId, zipData, payload).text
}

export function estimateCoolToolAiTokens(
  zipId: string,
  zipData: CoolToolZipDataLike,
  payload: Record<string, any> | null
): number {
  const content = buildCoolToolAiContent(zipId, zipData, payload)
  return Math.ceil(content.length / 4)
}

// Legacy malformed payloads bypass the structured Cool Tool formatter during AI
// compilation. Size the exact fallback text that the model receives.
export function buildMalformedCoolToolAiContent(zipId: string, content: string): string {
  if (content.includes('<cool_tool')) return content
  const scriptContent = content.replace(/<\/script/gi, '<\\/script')
  return `<cool_tool data-zip-id='${zipId}' data-zip-type='cool_tool'><script type="application/json" class="cool-tool-payload">${scriptContent}</script></cool_tool>`
}

export function estimateMalformedCoolToolAiTokens(zipId: string, content: string): number {
  return Math.ceil(buildMalformedCoolToolAiContent(zipId, content).length / 4)
}

export function shouldPreferRawSidecarForAiExpansion(payload: Record<string, any> | null): boolean {
  if (!payload) return false
  // The saved view already contains the managed text. A typed expansion of its MCP wrapper
  // would discard it; retained sidecars still follow ordinary storage/retrieval policy.
  if (payload.toolResult?.modelTextOnly === true) return false
  const operationKind = payload.operationKind ?? payload.metadata?.operationKind
  const rendererFamily = payload.rendererFamily ?? payload.metadata?.rendererFamily
  const isFullFidelityLane =
    FULL_FIDELITY_AI_EXPANSION_LANES.has(operationKind) ||
    FULL_FIDELITY_AI_EXPANSION_LANES.has(rendererFamily)

  if (!isFullFidelityLane) return false

  const toolResult = payload.toolResult && typeof payload.toolResult === 'object'
    ? payload.toolResult as Record<string, any>
    : null

  const binaryLikeOmitted =
    payload.storage?.binaryLikeOmitted === true ||
    payload.metadata?.binaryLikeOmitted === true ||
    toolResult?.contentOmitted === true ||
    toolResult?.omittedReason === 'binary_like'

  if (binaryLikeOmitted) return false

  const directContent = firstString(
    toolResult?.content,
    toolResult?.skillMarkdown,
    toolResult?.fileContent,
    toolResult?.newContent,
    toolResult?.diff,
    toolResult?.patch,
    toolResult?.output,
    toolResult?.result,
    toolResult?.data
  )
  const hasRawSidecar =
    typeof payload.rawSidecar?.zipId === 'string' ||
    typeof payload.metadata?.rawSidecarZipId === 'string'
  if (hasRawSidecar && directContent !== null && directContent.trim().length === 0) return true

  return (
    payload.storage?.truncated === true ||
    payload.metadata?.truncated === true ||
    toolResult?.contentTruncated === true ||
    toolResult?.diffTruncated === true
  )
}
