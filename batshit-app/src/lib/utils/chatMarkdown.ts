import type { ChatSessionRow } from '$lib/types/database'
import type { Message } from '$lib/stores/messages.svelte'
import { parseMessageContent, type MessageSegment } from '$lib/utils/messageFormatter'
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import { extractVisibleBatshitCueState } from '$lib/utils/batshitCue'
import {
  neutralizeAllClipReferenceSyntax,
  neutralizeAllZipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'

type ZipRecord = {
  id?: string
  type?: string
  content?: string
  name?: string
  description?: string
  metadata?: Record<string, any>
}

type ClipRecord = {
  id?: string
  filename?: string
  content?: string
  mimeType?: string
  displayUrl?: string | null
  externalUrl?: string | null
  localUrl?: string | null
  tunnelPath?: string | null
  localBase64?: string
  storageMode?: 'local'
}

type MarkdownResolvers = {
  resolveZip: (zipId: string) => Promise<ZipRecord | null>
  resolveClip: (clipId: string) => Promise<ClipRecord | null>
}

type TranscriptMessage = Pick<Message, 'id' | 'role' | 'content' | 'created_at' | 'timestamp' | 'agent_id' | 'metadata'>

type TranscriptOptions = {
  session?: Pick<ChatSessionRow, 'id' | 'name'>
  messages: TranscriptMessage[]
  agentsById?: Record<string, string>
  userLabel?: string
  assistantLabel?: string
  toolResultMode?: 'full' | 'summary'
}

const REFERENCE_REGEX = /\{\{(batshit-zip|batshit-clip):([^:}]+?)(?::::([^}]+))?\}\}/g
const LEGACY_CLIP_REGEX = /\{\{batshit-clip\|([^}]+)\}\}([\s\S]*?)\{\{\/batshit-clip\}\}/g
const STRUCTURED_TAG_REGEX = /<(terminal|diff|error|image|img|file|cool_tool)\b/i

function sanitizeInlineText(value: string | null | undefined, fallback: string) {
  const cleaned = String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || fallback
}

function wrapUrl(url: string) {
  return `<${url.trim()}>`
}

function longestBacktickRun(value: string) {
  const matches = value.match(/`+/g)
  if (!matches?.length) return 0
  return Math.max(...matches.map((entry) => entry.length))
}

function fenceBlock(content: string, language = '') {
  const safeContent = String(content ?? '').replace(/\r\n/g, '\n')
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(safeContent) + 1))
  const info = language.trim()
  return `${fence}${info ? info : ''}\n${safeContent}\n${fence}`
}

function normalizeMarkdownSpacing(value: string) {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function getBestClipUrl(clip: ClipRecord | null | undefined) {
  return clip?.displayUrl || clip?.externalUrl || clip?.localUrl || ''
}

function decodeBase64ToText(base64: string) {
  const payload = base64.startsWith('data:') ? base64.split(',')[1] || '' : base64

  try {
    if (typeof atob === 'function') {
      return decodeURIComponent(
        Array.prototype.map
          .call(atob(payload), (char: string) => '%' + char.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('')
      )
    }
  } catch {
    // Fall through to Buffer path.
  }

  try {
    const bufferCtor = (globalThis as any)?.Buffer
    if (bufferCtor) {
      return bufferCtor.from(payload, 'base64').toString('utf-8')
    }
  } catch {
    // Ignore and fall through.
  }

  return ''
}

function isImageMime(mimeType?: string | null) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/')
}

function isTextLikeMime(mimeType?: string | null) {
  return (
    typeof mimeType === 'string' &&
    (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.includes('markdown'))
  )
}

function coerceClipTextContent(clip: ClipRecord | null | undefined) {
  if (!clip) return ''
  if (typeof clip.content === 'string' && clip.content.length > 0) return clip.content
  if (typeof clip.localBase64 === 'string' && clip.localBase64.length > 0) {
    return decodeBase64ToText(clip.localBase64)
  }
  return ''
}

function formatLegacyClipMarkdown(metadataString: string, body: string) {
  const entries = metadataString
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const metadata = new Map<string, string>()

  for (const entry of entries) {
    const separatorIndex = entry.indexOf(':')
    if (separatorIndex <= 0) continue
    const key = entry.slice(0, separatorIndex).trim()
    const value = entry.slice(separatorIndex + 1).trim()
    metadata.set(key, value)
  }

  const filename = sanitizeInlineText(body, metadata.get('filename') || metadata.get('id') || 'attachment')
  const url = metadata.get('displayUrl') || metadata.get('externalUrl') || metadata.get('localUrl') || ''
  const lowerName = filename.toLowerCase()
  const looksLikeImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(lowerName)

  if (url) {
    return looksLikeImage
      ? `![${sanitizeInlineText(filename, 'Image')}](${wrapUrl(url)})`
      : `[${sanitizeInlineText(filename, 'Attachment')}](${wrapUrl(url)})`
  }

  return `**Attachment:** ${filename}`
}

function buildToolResultMarker(toolName: string, optionalKind?: string) {
  const label = sanitizeInlineText(toolName, 'Tool')
  const prefix = optionalKind ? `${optionalKind}: ` : ''
  return `> ${prefix}${label} (tool result omitted)`
}

function getSegmentToolName(segment: MessageSegment) {
  const attrs = segment.attrs ?? {}
  const rawToolName =
    segment.toolName ||
    attrs['data-tool-name'] ||
    attrs.toolName ||
    attrs.tool_name ||
    attrs.title

  return typeof rawToolName === 'string' ? sanitizeInlineText(rawToolName, 'Tool') : ''
}

function segmentToMarkdown(segment: MessageSegment, toolResultMode: 'full' | 'summary'): string {
  const segmentToolName = getSegmentToolName(segment)
  if (toolResultMode === 'summary' && segmentToolName) {
    return buildToolResultMarker(segmentToolName, segment.type === 'cool_tool' ? 'Tool call' : undefined)
  }

  switch (segment.type) {
    case 'text':
      return segment.content.trim()
    case 'code':
      return fenceBlock(segment.content, segment.language || 'text')
    case 'terminal':
      return fenceBlock(segment.content, 'text')
    case 'diff':
      return fenceBlock(segment.content, 'diff')
    case 'error': {
      const title = sanitizeInlineText(segment.errorTitle || segment.attrs?.title, 'Error')
      return `**${title}**\n\n${fenceBlock(segment.content, 'text')}`
    }
    case 'image': {
      const alt = sanitizeInlineText(segment.alt || segment.title || segment.content, 'Image')
      const src = segment.src || segment.content
      if (!src?.trim()) {
        return `**Image:** ${alt}`
      }
      return `![${alt}](${wrapUrl(src)})`
    }
    case 'file': {
      const label = sanitizeInlineText(segment.path || segment.filename || 'file', 'file')
      const url = segment.url || segment.content
      if (url?.trim()) {
        return `[${label}](${wrapUrl(url)})`
      }
      return `**File:** ${label}`
    }
    case 'cool_tool': {
      if (toolResultMode === 'summary') {
        return buildToolResultMarker(segmentToolName || segment.toolName || 'Tool', 'Tool call')
      }

      if (segment.isPending) {
        return `> Tool result pending${segment.toolName ? `: ${segment.toolName}` : ''}`
      }

      const toolName = sanitizeInlineText(segment.toolName || segment.toolData?.toolName, 'Tool Result')
      const rawPayload =
        segment.toolData?.toolResult ??
        segment.toolData?.observation ??
        segment.toolData?.result ??
        segment.toolData?.output ??
        segment.toolData

      if (typeof rawPayload === 'string' && rawPayload.trim()) {
        return `**${toolName}**\n\n${normalizeMarkdownSpacing(rawPayload)}`
      }

      try {
        return `**${toolName}**\n\n${fenceBlock(JSON.stringify(rawPayload ?? {}, null, 2), 'json')}`
      } catch {
        return `**${toolName}**`
      }
    }
    case 'batshit': {
      const description = sanitizeInlineText(segment.description, 'Compressed content')
      return `> ${description}`
    }
    default:
      return segment.content?.trim() || ''
  }
}

function convertStructuredContentToMarkdown(content: string, toolResultMode: 'full' | 'summary') {
  if (!STRUCTURED_TAG_REGEX.test(content)) {
    return normalizeMarkdownSpacing(content)
  }

  const segments = parseMessageContent(content, 'assistant', content)
  const rendered = segments
    .map((segment) => segmentToMarkdown(segment, toolResultMode))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('\n\n')

  return normalizeMarkdownSpacing(rendered || content)
}

async function replaceLegacyClipBlocks(content: string) {
  return content.replace(LEGACY_CLIP_REGEX, (_, metadata, body) =>
    formatLegacyClipMarkdown(String(metadata || ''), String(body || ''))
  )
}

async function replaceReferences(
  content: string,
  resolvers: MarkdownResolvers,
  toolResultMode: 'full' | 'summary'
) {
  const matches = Array.from(content.matchAll(new RegExp(REFERENCE_REGEX.source, 'g')))
  if (matches.length === 0) return content

  let output = ''
  let lastIndex = 0

  for (const match of matches) {
    const [fullMatch, rawType, refId, optionalContent] = match
    const startIndex = match.index ?? 0
    output += content.slice(lastIndex, startIndex)

    if (rawType === 'batshit-zip') {
      output += await renderZipReferenceMarkdown(refId, optionalContent, resolvers.resolveZip, toolResultMode)
    } else {
      output += await renderClipReferenceMarkdown(refId, optionalContent, resolvers.resolveClip)
    }

    lastIndex = startIndex + fullMatch.length
  }

  output += content.slice(lastIndex)
  return output
}

async function renderZipReferenceMarkdown(
  zipId: string,
  optionalContent: string | undefined,
  resolveZip: MarkdownResolvers['resolveZip'],
  toolResultMode: 'full' | 'summary'
) {
  const zip = await resolveZip(zipId)
  if (!zip) {
    return optionalContent?.trim() || neutralizeAllZipReferenceSyntax(`{{batshit-zip:${zipId}}}`)
  }

  const type = String(zip.type || '').trim().toLowerCase()
  const description = sanitizeInlineText(optionalContent || zip.description || zip.name, 'Compressed content')
  const content = String(zip.content ?? '')
  const metadata = zip.metadata && typeof zip.metadata === 'object' ? zip.metadata : {}
  const rawToolName =
    metadata.toolName ||
    metadata.tool_name ||
    metadata.originalToolName ||
    metadata.original_tool_name ||
    zip.name ||
    description
  const toolName = typeof rawToolName === 'string' ? sanitizeInlineText(rawToolName, 'Tool') : 'Tool'
  const isToolResultZip =
    type === 'cool_tool' ||
    typeof metadata.toolName === 'string' ||
    typeof metadata.tool_name === 'string' ||
    typeof metadata.toolCallId === 'string' ||
    typeof metadata.tool_call_id === 'string'

  if (toolResultMode === 'summary' && isToolResultZip) {
    return buildToolResultMarker(toolName, type === 'cool_tool' ? 'Tool call' : undefined)
  }

  switch (type) {
    case 'terminal':
      return fenceBlock(content, 'text')
    case 'diff':
      return fenceBlock(content, 'diff')
    case 'error':
      return `**${description}**\n\n${fenceBlock(content, 'text')}`
    case 'image': {
      const alt = sanitizeInlineText(optionalContent || zip.description || zip.name, 'Image')
      return content.trim() ? `![${alt}](${wrapUrl(content)})` : `**Image:** ${alt}`
    }
    case 'file': {
      const label = sanitizeInlineText(zip.name || optionalContent, 'file')
      return content.trim() ? `[${label}](${wrapUrl(content)})` : `**File:** ${label}`
    }
    case 'cool_tool': {
      try {
        const parsed = typeof zip.content === 'string' ? JSON.parse(zip.content) : zip.content
        const toolName = sanitizeInlineText(parsed?.toolName || parsed?.originalToolName, description)
        const toolValue =
          parsed?.toolResult ?? parsed?.observation ?? parsed?.result ?? parsed?.output ?? parsed

        if (typeof toolValue === 'string' && toolValue.trim()) {
          return `**${toolName}**\n\n${convertStructuredContentToMarkdown(toolValue, toolResultMode)}`
        }

        return `**${toolName}**\n\n${fenceBlock(JSON.stringify(toolValue ?? {}, null, 2), 'json')}`
      } catch {
        return `**${description}**\n\n${fenceBlock(content, 'json')}`
      }
    }
    default:
      return content.trim() ? convertStructuredContentToMarkdown(content, toolResultMode) : `> ${description}`
  }
}

async function renderClipReferenceMarkdown(
  clipId: string,
  optionalContent: string | undefined,
  resolveClip: MarkdownResolvers['resolveClip']
) {
  const clip = await resolveClip(clipId)
  if (!clip) {
    return optionalContent?.trim() || neutralizeAllClipReferenceSyntax(`{{batshit-clip:${clipId}}}`)
  }

  const filename = sanitizeInlineText(optionalContent || clip.filename, 'attachment')
  const url = getBestClipUrl(clip)
  const textContent = coerceClipTextContent(clip)

  if (isImageMime(clip.mimeType)) {
    return url ? `![${filename}](${wrapUrl(url)})` : `**Image:** ${filename}`
  }

  if (isTextLikeMime(clip.mimeType) && textContent.trim()) {
    const lowerName = filename.toLowerCase()
    const fenceLanguage =
      lowerName.endsWith('.md') || lowerName.endsWith('.markdown')
        ? 'markdown'
        : lowerName.endsWith('.json')
          ? 'json'
          : lowerName.endsWith('.ts')
            ? 'ts'
            : lowerName.endsWith('.js')
              ? 'js'
              : lowerName.endsWith('.html')
                ? 'html'
                : lowerName.endsWith('.css')
                  ? 'css'
                  : 'text'

    return `**Attached text: ${filename}**\n\n${fenceBlock(textContent, fenceLanguage)}`
  }

  if (url) {
    return `[${filename}](${wrapUrl(url)})`
  }

  return `**Attachment:** ${filename}`
}

function resolveTimestampLabel(message: TranscriptMessage) {
  const timestamp = message.created_at || message.timestamp
  if (!timestamp) return ''

  try {
    return new Date(timestamp).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return String(timestamp)
  }
}

function resolveSpeakerLabel(
  message: TranscriptMessage,
  agentsById: Record<string, string> | undefined,
  userLabel: string,
  assistantLabel: string
) {
  if (message.role === 'user') return userLabel
  if (message.role === 'system') return 'System'

  const agentName =
    (message.agent_id && agentsById?.[message.agent_id]) ||
    (typeof message.metadata?.agentName === 'string' ? message.metadata.agentName : '') ||
    ''

  return sanitizeInlineText(agentName, assistantLabel)
}

export async function renderMessageToMarkdown(
  message: TranscriptMessage,
  resolvers: MarkdownResolvers,
  options?: { toolResultMode?: 'full' | 'summary' }
) {
  const toolResultMode = options?.toolResultMode === 'summary' ? 'summary' : 'full'
  const rawContent = stripZipControlBlocks(message.content || '')
  const withLegacyClips = await replaceLegacyClipBlocks(rawContent)
  const withResolvedReferences = await replaceReferences(withLegacyClips, resolvers, toolResultMode)
  const controlState = extractVisibleBatshitCueState(withResolvedReferences)
  const rendered = convertStructuredContentToMarkdown(controlState.cleanedContent, toolResultMode)
  const noteBlock = controlState.notes.map((note) => `_${note.label}_`).join('\n\n')
  if (noteBlock && rendered) {
    return `${noteBlock}\n\n${rendered}`
  }
  return noteBlock || rendered || '[No content]'
}

export async function buildTranscriptMarkdown(options: TranscriptOptions, resolvers: MarkdownResolvers) {
  const title = sanitizeInlineText(options.session?.name || options.session?.id, 'Chat Transcript')
  const sessionId = options.session?.id?.trim() || ''
  const userLabel = sanitizeInlineText(options.userLabel, 'User')
  const assistantLabel = sanitizeInlineText(options.assistantLabel, 'Assistant')
  const toolResultMode = options.toolResultMode === 'summary' ? 'summary' : 'full'
  const sections: string[] = [`# ${title}`]

  if (sessionId && sessionId !== title) {
    sections.push(`Session ID: \`${sessionId}\``)
  }

  for (const message of options.messages) {
    const speaker = resolveSpeakerLabel(message, options.agentsById, userLabel, assistantLabel)
    const timestampLabel = resolveTimestampLabel(message)
    const body = await renderMessageToMarkdown(message, resolvers, { toolResultMode })
    const lines = [`## ${speaker}`]

    if (timestampLabel) {
      lines.push(`_${timestampLabel}_`)
    }

    lines.push(body)
    sections.push(lines.join('\n\n'))
  }

  return normalizeMarkdownSpacing(sections.join('\n\n---\n\n'))
}

export type { MarkdownResolvers, TranscriptMessage, TranscriptOptions, ZipRecord, ClipRecord }
