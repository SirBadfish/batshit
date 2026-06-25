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

function fenceForAi(content: string, language = 'text'): string {
  const ticks = content.match(/`+/g) ?? []
  const longest = ticks.reduce((max, entry) => Math.max(max, entry.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language || 'text'}\n${content.trimEnd()}\n${fence}`
}

function formatAiToolHeader(toolName: string, lines: string[]): string {
  return [`Tool result: ${toolName}`, ...lines.filter(Boolean)].join('\n')
}

function buildFullFidelityToolAiContent(
  toolName: string,
  payload: Record<string, any>,
  contentLabel: string,
  content: string,
  language: string
): string {
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
  const lineCount = firstScalarString(result?.lineCount, result?.numLines, result?.totalLines)
  const size = firstScalarString(result?.size, result?.bytes, result?.contentChars, result?.diffChars)
  const header = formatAiToolHeader(toolName, [
    path ? `Path: ${path}` : '',
    skill ? `Skill: ${skill}` : '',
    lineCount ? `Lines: ${lineCount}` : '',
    size ? `Chars/bytes: ${size}` : ''
  ])

  return `${header}\n${contentLabel}:\n${fenceForAi(content, language)}`
}

function buildListToolAiContent(toolName: string, payload: Record<string, any>): string {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const path = firstScalarString(result?.path, result?.dirPath, args.path, args.dirPath)
  const files = Array.isArray(result?.files) ? result.files : []
  const total = firstScalarString(result?.totalItems, result?.totalFiles) ?? String(files.length)
  const renderedFiles = files
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (!entry || typeof entry !== 'object') return ''
      return firstScalarString((entry as any).path, (entry as any).name, (entry as any).filePath) ?? ''
    })
    .filter(Boolean)
  const header = formatAiToolHeader(toolName, [
    path ? `Path: ${path}` : '',
    `Items: ${total}`
  ])
  return `${header}\nFiles:\n${renderedFiles.map((file) => `- ${file}`).join('\n') || '(none)'}`
}

function buildBashToolAiContent(toolName: string, payload: Record<string, any>): string {
  const result = asObject(getCoolToolResult(payload))
  const args = getCoolToolArgs(payload)
  const command = firstScalarString(result?.command, args.command, args.innerCommand)
  const exitCode = firstScalarString(result?.exitCode)
  const stdout = firstString(result?.stdout, result?.output)
  const stderr = firstString(result?.stderr)
  const blocks = [
    formatAiToolHeader(toolName, [
      command ? `Command: ${command}` : '',
      exitCode ? `Exit code: ${exitCode}` : ''
    ])
  ]
  if (stdout !== null) blocks.push(`Stdout:\n${fenceForAi(stdout, 'text')}`)
  if (stderr !== null && stderr.trim()) blocks.push(`Stderr:\n${fenceForAi(stderr, 'text')}`)
  return blocks.join('\n')
}

function buildFetchZipToolAiContent(toolName: string, payload: Record<string, any>): string {
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
    return `${header}\nContent:\n${fenceForAi(content, 'text')}`
  }

  return `${header}\nResult:\n${fenceForAi(compactJson(result), 'json')}`
}

function buildGenericToolAiContent(toolName: string, payload: Record<string, any>): string {
  const args = getCoolToolArgs(payload)
  const result = getCoolToolResult(payload)
  const blocks = [formatAiToolHeader(toolName, [])]
  if (Object.keys(args).length) {
    blocks.push(`Arguments:\n${fenceForAi(compactJson(args), 'json')}`)
  }
  if (typeof result === 'string') {
    blocks.push(`Result:\n${fenceForAi(result, 'text')}`)
  } else {
    blocks.push(`Result:\n${fenceForAi(compactJson(result), 'json')}`)
  }
  return blocks.join('\n')
}

export function buildCoolToolAiContent(
  _zipId: string,
  zipData: CoolToolZipDataLike,
  payload: Record<string, any> | null
): string {
  if (!payload) return String(zipData.content ?? '')

  const operationKind = getCoolToolOperationKind(payload)
  const toolName =
    firstScalarString(payload.toolName, payload.displayToolName, payload.originalToolName, operationKind) || 'tool'
  const result = asObject(getCoolToolResult(payload))
  const language = firstScalarString(result?.language, payload.metadata?.language) || 'text'

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
        return buildFullFidelityToolAiContent(toolName, payload, 'Content', content, language)
      }
      break
    }
    case 'write_file': {
      const content = firstString(result?.content, result?.fileContent, result?.newContent, result?.output)
      if (content !== null) {
        return buildFullFidelityToolAiContent(toolName, payload, 'Written content', content, language)
      }
      break
    }
    case 'edit_file': {
      const diff = firstString(result?.diff, result?.patch, result?.changes, result?.output)
      if (diff !== null) {
        return buildFullFidelityToolAiContent(toolName, payload, 'Diff', diff, 'diff')
      }
      break
    }
    case 'list_files':
      return buildListToolAiContent(toolName, payload)
    case 'bash':
      return buildBashToolAiContent(toolName, payload)
    case 'fetch_zip':
      return buildFetchZipToolAiContent(toolName, payload)
    default:
      break
  }

  return buildGenericToolAiContent(toolName, payload)
}

export function estimateCoolToolAiTokens(
  zipId: string,
  zipData: CoolToolZipDataLike,
  payload: Record<string, any> | null
): number {
  const content = buildCoolToolAiContent(zipId, zipData, payload)
  return Math.ceil(content.length / 4)
}

export function shouldPreferRawSidecarForAiExpansion(payload: Record<string, any> | null): boolean {
  if (!payload) return false
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
