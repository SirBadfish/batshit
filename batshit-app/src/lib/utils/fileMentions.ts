import type { FlatFileEntry } from '$lib/stores/projects.svelte'

export type MentionStatus = 'valid' | 'missing' | 'excluded' | 'binary' | 'image'

export interface MentionMatch {
  id: string
  raw: string
  path: string
  start: number
  end: number
  status: MentionStatus
  file?: FlatFileEntry
}

export interface MentionSegment {
  type: 'text' | 'mention'
  value: string
  mention?: MentionMatch
}

export type FileReferenceType = 'text' | 'binary' | 'image' | 'directory'

export interface FileReferencePayload {
  path: string
  status: MentionStatus
  size?: number
  mtime?: string
  type?: FileReferenceType
  lineCount?: number
  lineCountApprox?: boolean
  encoding?: string
}

export interface ProjectQuickViewTarget {
  path: string
  lineNumber?: number
  columnNumber?: number
}

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'tiff',
  'ico'
])

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'xml',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'svelte',
  'css',
  'scss',
  'sass',
  'html',
  'htm',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'toml',
  'ini',
  'env',
  'sql',
  'prisma',
  'graphql'
])

const PROJECT_QUICK_VIEW_HREF_PREFIX = '#batshit-project-file='
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//
const QUICK_VIEW_FILE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  'pdf',
  'zip',
  'gz',
  'tar'
])

const AVERAGE_LINE_LENGTH = 80
const fileMapCache = new WeakMap<FlatFileEntry[], Map<string, FlatFileEntry>>()

function normalizePath(value: string) {
  return value.replace(/\\/g, '/')
}

function getFileMap(files: FlatFileEntry[]) {
  const cached = fileMapCache.get(files)
  if (cached) return cached

  const fileMap = new Map(files.map((file) => [normalizePath(file.path), file]))
  fileMapCache.set(files, fileMap)
  return fileMap
}

function isImageFile(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXTENSIONS.has(ext)
}

function isLikelyTextFile(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (!ext) return true
  return TEXT_EXTENSIONS.has(ext)
}

function globToRegExp(pattern: string) {
  const normalized = normalizePath(pattern)
  const escaped = normalized.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
  const withGlob = escaped
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '.')
  return new RegExp(`^${withGlob}$`)
}

function matchesPattern(path: string, pattern: string) {
  if (!pattern) return false
  const normalizedPath = normalizePath(path)
  const normalizedPattern = normalizePath(pattern.trim())
  if (!normalizedPattern) return false
  if (!normalizedPattern.includes('/')) {
    const base = normalizedPath.split('/').pop() || normalizedPath
    const baseRegex = globToRegExp(normalizedPattern)
    if (baseRegex.test(base)) return true
  }

  const effectivePattern = normalizedPattern.includes('/') ? normalizedPattern : `**/${normalizedPattern}`
  const regex = globToRegExp(effectivePattern)
  return regex.test(normalizedPath)
}

export function isPathExcluded(path: string, patterns: string[] = []) {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pattern) => matchesPattern(path, pattern))
}

export function extractFileMentions(text: string) {
  const matches: Array<{ raw: string; path: string; start: number; end: number }> = []
  if (!text) return matches
  const regex = /(^|\s)@([A-Za-z0-9_./-]+)/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1] || ''
    const rawPath = match[2] || ''
    if (!rawPath) continue
    const start = match.index + prefix.length
    const end = start + rawPath.length + 1
    matches.push({
      raw: `@${rawPath}`,
      path: rawPath,
      start,
      end
    })
  }
  return matches
}

export function buildFileMentionQuickViewHref(path: string) {
  return `${PROJECT_QUICK_VIEW_HREF_PREFIX}${encodeURIComponent(normalizePath(path))}`
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripHrefFragmentAndQuery(value: string) {
  const queryIndex = value.indexOf('?')
  const hashIndex = value.indexOf('#')
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0)
  if (indexes.length === 0) return value
  return value.slice(0, Math.min(...indexes))
}

function hasQuickViewFileExtension(path: string) {
  const basename = normalizePath(path).split('/').filter(Boolean).pop() || ''
  if (!basename || basename.endsWith('.')) return false
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex < 0) return false
  const extension = basename.slice(dotIndex + 1).toLowerCase()
  return QUICK_VIEW_FILE_EXTENSIONS.has(extension)
}

function isAbsoluteLocalPath(path: string) {
  if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) return true
  return /^\/(?:Users|Volumes|private|tmp|var|opt|workspace|home)\//.test(path)
}

function isRelativeProjectFilePath(path: string) {
  if (path.startsWith('./') || path.startsWith('../')) return hasQuickViewFileExtension(path)
  if (path.includes('/')) return hasQuickViewFileExtension(path)
  return hasQuickViewFileExtension(path)
}

function isProjectQuickViewPath(path: string) {
  const normalized = normalizePath(path).trim()
  if (!normalized || normalized.startsWith('#') || normalized.startsWith('//')) return false
  if (WINDOWS_ABSOLUTE_PATH_RE.test(normalized)) return true
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized)) return false
  if (isAbsoluteLocalPath(normalized)) return true
  return isRelativeProjectFilePath(normalized)
}

function parseTrailingLineTarget(path: string): ProjectQuickViewTarget | null {
  const normalized = normalizePath(path).trim()
  if (!normalized) return null

  const match = normalized.match(/^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/)
  if (!match) return { path: normalized }

  const pathWithoutLine = match[1] || ''
  if (!pathWithoutLine || /^[A-Za-z]$/.test(pathWithoutLine)) {
    return { path: normalized }
  }

  const lineNumber = Number.parseInt(match[2] || '', 10)
  const columnNumber = match[3] ? Number.parseInt(match[3], 10) : undefined
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
    return { path: normalized }
  }

  return {
    path: pathWithoutLine,
    lineNumber,
    ...(columnNumber && Number.isFinite(columnNumber) && columnNumber > 0
      ? { columnNumber }
      : {})
  }
}

export function parseProjectQuickViewHrefTarget(
  href: string | null | undefined
): ProjectQuickViewTarget | null {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (!raw) return null

  if (raw.startsWith(PROJECT_QUICK_VIEW_HREF_PREFIX)) {
    const encodedPath = raw.slice(PROJECT_QUICK_VIEW_HREF_PREFIX.length)
    const decodedPath = normalizePath(safeDecodeURIComponent(encodedPath)).trim()
    const target = parseTrailingLineTarget(decodedPath)
    return target?.path ? target : null
  }

  let candidate = raw
  if (/^file:/i.test(candidate)) {
    try {
      const fileUrl = new URL(candidate)
      candidate = fileUrl.pathname
    } catch {
      candidate = candidate.replace(/^file:\/+/i, '/')
    }
  }

  const normalized = normalizePath(
    safeDecodeURIComponent(stripHrefFragmentAndQuery(candidate))
  ).trim()
  const target = parseTrailingLineTarget(normalized)
  return target && isProjectQuickViewPath(target.path) ? target : null
}

export function parseProjectQuickViewHref(href: string | null | undefined) {
  return parseProjectQuickViewHrefTarget(href)?.path ?? null
}

export function buildFileMentionDisplayLabel(path: string) {
  const normalized = normalizePath(path).trim()
  const fallback = normalized || 'file'
  const name = fallback.split('/').filter(Boolean).pop() || fallback
  return name
}

function escapeMarkdownLabel(value: string) {
  return value.replace(/([\\[\]])/g, '\\$1')
}

function escapeMarkdownTitle(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function decoratePlainFileMentionSegment(segment: string) {
  return segment.replace(/(^|\s)@([A-Za-z0-9_./-]+)/g, (_match, prefix, rawPath) => {
    const path = normalizePath(String(rawPath ?? ''))
    if (!path) return _match
    const label = escapeMarkdownLabel(buildFileMentionDisplayLabel(path))
    const href = buildFileMentionQuickViewHref(path)
    const title = escapeMarkdownTitle(path)
    return `${prefix}[${label}](${href} "${title}")`
  })
}

function decorateInlineCodeSafeSegment(segment: string) {
  return segment
    .split(/(`[^`\n]*`)/g)
    .map((part) => {
      if (!part.startsWith('`') || !part.endsWith('`')) {
        return decoratePlainFileMentionSegment(part)
      }
      const inner = part.slice(1, -1)
      // Legacy sent mentions were wrapped in backticks before rendering. Keep normal
      // code spans intact, but upgrade a pure backticked @file into the sent-file pill.
      if (/^@[A-Za-z0-9_./-]+$/.test(inner)) {
        return decoratePlainFileMentionSegment(inner)
      }
      return part
    })
    .join('')
}

export function decorateFileMentionsForMarkdown(text: string) {
  if (!text || !text.includes('@')) return text
  return text
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) =>
      part.startsWith('```') || part.startsWith('~~~')
        ? part
        : decorateInlineCodeSafeSegment(part)
    )
    .join('')
}

export function getActiveMention(text: string, caretIndex: number) {
  const before = text.slice(0, caretIndex)
  const atIndex = before.lastIndexOf('@')
  if (atIndex < 0) return null
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null
  const query = before.slice(atIndex + 1)
  if (/\s/.test(query)) return null
  if (!/^[A-Za-z0-9_./-]*$/.test(query)) return null
  return { start: atIndex, query }
}

export function scoreFileMatch(query: string, entry: FlatFileEntry) {
  if (!query) return 1
  const lowerQuery = query.toLowerCase()
  const name = entry.name.toLowerCase()
  const path = entry.path.toLowerCase()
  let score = 0
  if (name === lowerQuery) score += 200
  if (name.startsWith(lowerQuery)) score += 120
  if (path.startsWith(lowerQuery)) score += 80
  const nameIndex = name.indexOf(lowerQuery)
  if (nameIndex >= 0) score += 60 - Math.min(nameIndex, 40)
  const pathIndex = path.indexOf(lowerQuery)
  if (pathIndex >= 0) score += 40 - Math.min(pathIndex, 40)
  return score
}

export function filterMentionOptions(query: string, files: FlatFileEntry[]) {
  const entries = files
  const normalized = query.trim().toLowerCase()
  return entries
    .map((entry) => ({
      entry,
      score: normalized ? scoreFileMatch(normalized, entry) : 1
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length)
    .map(({ entry }) => entry)
}

export function validateMentions(
  text: string,
  files: FlatFileEntry[],
  exclusionPatterns: string[] = []
): MentionMatch[] {
  const mentions = extractFileMentions(text)
  if (mentions.length === 0) return []

  const fileMap = getFileMap(files)
  return mentions.map((mention, index) => {
    const normalizedPath = normalizePath(mention.path)
    const file = fileMap.get(normalizedPath)
    let status: MentionStatus = 'valid'
    if (isPathExcluded(normalizedPath, exclusionPatterns)) {
      status = 'excluded'
    } else if (!file) {
      status = 'missing'
    } else if (isImageFile(normalizedPath)) {
      status = 'image'
    } else if (!isLikelyTextFile(normalizedPath)) {
      status = 'binary'
    }

    return {
      id: `${mention.start}-${mention.end}-${index}`,
      raw: mention.raw,
      path: mention.path,
      start: mention.start,
      end: mention.end,
      status,
      file
    }
  })
}

export function buildMentionSegments(text: string, mentions: MentionMatch[]): MentionSegment[] {
  if (!mentions.length) {
    return [{ type: 'text', value: text }]
  }
  const segments: MentionSegment[] = []
  let cursor = 0
  for (const mention of mentions) {
    if (mention.start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, mention.start) })
    }
    segments.push({ type: 'mention', value: mention.raw, mention })
    cursor = mention.end
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }
  return segments
}

function formatFileSize(bytes?: number) {
  if (bytes === undefined || bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function mapMentionsToFileReferences(mentions: MentionMatch[]): FileReferencePayload[] {
  const unique = new Map<string, FileReferencePayload>()
  for (const mention of mentions) {
    const isDirectory = mention.file?.type === 'directory'
    const type: FileReferenceType | undefined = isDirectory
      ? 'directory'
      : mention.status === 'image'
        ? 'image'
        : mention.status === 'binary'
          ? 'binary'
          : mention.status === 'valid'
            ? 'text'
            : undefined

    let lineCount: number | undefined
    let lineCountApprox = false
    let encoding: string | undefined

    if (type === 'text') {
      encoding = 'utf8'
      if (typeof mention.file?.size === 'number') {
        const size = Math.max(mention.file.size, 0)
        lineCount = size === 0 ? 0 : Math.max(1, Math.round(size / AVERAGE_LINE_LENGTH))
        lineCountApprox = true
      }
    }

    unique.set(normalizePath(mention.path), {
      path: mention.path,
      status: mention.status,
      size: mention.file?.size,
      mtime: mention.file?.mtime,
      type,
      lineCount,
      lineCountApprox,
      encoding
    })
  }
  return Array.from(unique.values())
}

export function buildFileReferenceBlock(references: FileReferencePayload[]): string {
  if (!references.length) return ''
  const lines = references.map((ref) => {
    const details: string[] = []
    if (ref.status && ref.status !== 'valid') {
      details.push(`status: ${ref.status}`)
    }
    if (ref.type) {
      details.push(`type: ${ref.type}`)
    }
    if (typeof ref.size === 'number') {
      const formattedSize = formatFileSize(ref.size)
      if (formattedSize) {
        details.push(`size: ${formattedSize}`)
      }
    }
    if (typeof ref.lineCount === 'number') {
      const prefix = ref.lineCountApprox ? '~' : ''
      details.push(`lines: ${prefix}${ref.lineCount}`)
    }
    if (ref.encoding) {
      details.push(`encoding: ${ref.encoding}`)
    }
    const detailText = details.length ? ` (${details.join(', ')})` : ''
    return `- \`${ref.path}\`${detailText}`
  })
  return `\n\nFile references (@):\n${lines.join('\n')}`
}
