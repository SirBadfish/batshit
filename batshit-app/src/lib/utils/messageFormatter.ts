// Message parsing utilities - simplified after embedded zip architecture
import * as cheerio from 'cheerio'
import { logger } from '$lib/utils/logger'
import { processIntermediateSteps } from './toolResultProcessor'
import { stripZipControlBlocks } from './zipControl'
import { normalizeId } from '$lib/utils/idNormalizer'
import {
  isConcreteZipId,
  isTrustedClipReferenceId,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax,
  stripTrustedClipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { decodeStructuredTextContent } from './htmlEntities'
import { scanMessageZipReferences, scanMessageClipReferences } from './markdownReferenceScan'
import { STRUCTURED_TAG_PRESENT, findStructuredElements, type StructuredElement } from './structuredTagScan'
import { projectRemovedTextRanges, type TextRange } from './hydratedTextRanges'

export type MessageSegment = {
  id?: string
  type: 'text' | 'code' | 'terminal' | 'batshit' | 'image' | 'file' | 'error' | 'diff' | 'cool_tool'
  content: string
  language?: string
  filename?: string
  source?: string
  tokens?: number
  name?: string
  path?: string
  description?: string
  // Image props
  src?: string
  fullResolutionSrc?: string
  alt?: string
  title?: string
  width?: number
  height?: number
  /** Assigned from a compiler-owned range, never from a tag's attributes. */
  hydratedContext?: boolean
  // File props
  url?: string
  size?: number
  fileType?: string
  // Error props
  errorTitle?: string
  stack?: string
  code?: string | number
  // Zip detection props
  zipId?: string
  zipType?: string
  isZip?: boolean
  // Tool result props
  toolName?: string
  toolStatus?: string
  toolData?: any
  parseError?: string
  intermediateStep?: any
  attrs?: any
  lineCount?: number
  isPending?: boolean
  toolId?: string
  // Content type for Batshit zips
  contentType?: string
}

function parseEmbeddedZipRefs(text: string, isValidZipId?: (zipId: string) => boolean) {
  const segments: MessageSegment[] = []
  let lastIndex = 0

  for (const zipMatch of scanMessageZipReferences(text)) {
    if (zipMatch.start > lastIndex) {
      const textBefore = text.substring(lastIndex, zipMatch.start).trim()
      if (textBefore) {
        segments.push({
          type: 'text' as const,
          content: textBefore
        })
      }
    }

    const zipId = zipMatch.id
    const trustedZipRef = isValidZipId ? isValidZipId(zipId) : isConcreteZipId(zipId)
    if (!trustedZipRef) {
      const raw = zipMatch.match
      if (raw) {
        segments.push({
          type: 'text' as const,
          content: neutralizeAllZipReferenceSyntax(raw)
        })
      }
      lastIndex = zipMatch.end
      continue
    }
    const description = zipMatch.description || ''
    const isCoolToolZip =
      zipId?.includes('cool_tool') || description.toLowerCase().includes('tool execution')
    const resolvedDescription =
      description || (isCoolToolZip ? 'Tool execution result' : 'Zipped content')
    const resolvedName = isCoolToolZip ? 'Tool Result' : 'Content'
    const tokens = 0

    if (isCoolToolZip) {
      segments.push({
        type: 'cool_tool' as const,
        content: '',
        source: 'AI',
        id: zipId,
        zipId,
        isZip: true,
        zipType: 'cool_tool',
        tokens,
        name: resolvedName,
        description: resolvedDescription,
        toolName: resolvedDescription.replace(/^Tool execution:? ?/, '') || resolvedName
      })
    } else {
      segments.push({
        type: 'batshit' as const,
        id: zipId,
        content: '',
        source: 'USER',
        tokens,
        name: resolvedName,
        path: '',
        description: resolvedDescription,
        contentType: 'unknown',
        zipType: 'unknown',
        isZip: true,
        zipId
      })
    }

    lastIndex = zipMatch.end
  }

  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex).trim()
    if (remainingText) {
      segments.push({
        type: 'text' as const,
        content: remainingText
      })
    }
  }

  return segments
}

function expandEmbeddedZipRefsInSegments(
  segments: MessageSegment[],
  isValidZipId?: (zipId: string) => boolean
) {
  if (!segments.some((seg) => seg.type === 'text' && seg.content.includes('{{batshit-zip:'))) {
    return segments
  }

  const expanded: MessageSegment[] = []
  for (const segment of segments) {
    if (segment.type !== 'text' || !segment.content.includes('{{batshit-zip:')) {
      expanded.push(segment)
      continue
    }
    expanded.push(...parseEmbeddedZipRefs(segment.content, isValidZipId))
  }

  return expanded
}

const CHEERIO_OPTIONS = {
  xml: {
    xmlMode: false,
    recognizeSelfClosing: true
  }
} as const

type XmlSegment = {
  type: string
  content: string
  attrs?: any
  toolData?: any
  parseError?: string
  isPending?: boolean
  toolId?: string
  toolName?: string
}

function readXmlElement($: cheerio.CheerioAPI, elem: any, name: string): XmlSegment | null {
  const $elem = $(elem)
  switch (name) {
    case 'terminal': { // Terminal blocks
      // Use html() so escaped code-like output can round-trip through XML wrappers.
      const rawContent = $elem.html() || ''
      const textContent = decodeStructuredTextContent(rawContent)
      
      // Capture all attributes including data-zip-id
      const attrs: any = {}
      if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
      if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
      
      return {
        type: 'terminal',
        content: textContent,
        attrs
      }
    }
    case 'diff': { // Diff blocks
      // Use html() so diff lines containing angle brackets survive parsing.
      const rawContent = $elem.html() || ''
      const textContent = decodeStructuredTextContent(rawContent)
      
      // Capture all attributes including tool metadata and zip data
      const attrs: any = { path: $elem.attr('path') || $elem.attr('file') }
      if ($elem.attr('data-tool-name')) attrs['data-tool-name'] = $elem.attr('data-tool-name')
      if ($elem.attr('data-filename')) attrs['data-filename'] = $elem.attr('data-filename')
      if ($elem.attr('data-line-count')) attrs['data-line-count'] = $elem.attr('data-line-count')
      if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
      if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
      
      return {
        type: 'diff',
        content: textContent,
        attrs
      }
    }
    case 'error': { // Error blocks
      // Capture all attributes including data-zip-id
      const attrs: any = { title: $elem.attr('title') || 'Error' }
      if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
      if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
      
      return {
        type: 'error',
        content: $elem.text(),
        attrs
      }
    }
    case 'image': { // Image blocks - handle custom <image> tags
      const srcAttr = $elem.attr('src')
      const altAttr = $elem.attr('alt')
      const textContent = ($elem.text() || '').trim()
      const resolvedSrc = srcAttr || textContent

      if (resolvedSrc) {
        const attrs: any = {
          alt: altAttr || 'Image',
          title: $elem.attr('title') || '',
          src: resolvedSrc,
          width: $elem.attr('width'),
          height: $elem.attr('height')
        }
        if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
        if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')

        return {
          type: 'image',
          content: resolvedSrc,
          attrs
        }
      }
      return null
    }
    case 'img': { // Image blocks - handle standard HTML <img> tags
      // Get src from attribute (standard HTML)
      const srcAttr = $elem.attr('src')
      const altAttr = $elem.attr('alt')
      
      logger.debug('[messageFormatter] Processing img tag:', {
        src: srcAttr?.substring(0, 100),
        alt: altAttr
      })
      
      // Only process if we have a src
      if (srcAttr) {
        // Capture all attributes
        const attrs: any = {
          alt: altAttr || 'Image',
          title: $elem.attr('title') || '',
          src: srcAttr,
          width: $elem.attr('width'),
          height: $elem.attr('height')
        }
        if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
        if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
        
        return {
          type: 'image',
          content: srcAttr, // Store the source as content
          attrs
        }
      }
      return null
    }
    case 'file': { // File blocks
      // Get file content - could be URL or base64
      const rawContent = $elem.html() || $elem.text() || ''
      const textContent = decodeStructuredTextContent(rawContent).trim()
      
      // Capture all attributes
      const attrs: any = {
        path: $elem.attr('path') || $elem.attr('filename') || 'file',
        type: $elem.attr('type') || 'application/octet-stream'
      }
      if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
      if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
      
      return {
        type: 'file',
        content: textContent,
        attrs
      }
    }
    case 'cool_tool': { // Cool tool blocks - JSON payload lives inside the element (script or text)
      // Check if this is a pending Cool Tool (waiting for execution)
      const isPending = $elem.attr('pending') === 'true'
      const toolId = $elem.attr('tool-id') || ''
      const toolName = $elem.attr('tool-name') || 'unknown'

      // Fail fast if legacy attribute payload sneaks back in
      if ($elem.attr('data')) {
        throw new Error('[messageFormatter] cool_tool payload must be inline JSON script, not data attribute')
      }

      // Pull JSON payload from child <script class="cool-tool-payload"> or from text
      const scriptNode = $elem.find('script.cool-tool-payload').first()
      const rawPayload = scriptNode.length
        ? scriptNode.text()
        : $elem.text()

      let toolData: any = {}
      let parseError: string | null = null
      let shouldWarn = false

      if (!isPending) {
        if (!rawPayload || rawPayload.trim().length === 0) {
          parseError = 'cool_tool payload missing inline JSON body'
          shouldWarn = true
        } else {
          try {
            // SA-012: payload is clean JSON; accept both raw JSON and pre-stringified JSON
            // but avoid double-parse if upstream already converted to object
            if (typeof rawPayload === 'string') {
              const trimmed = rawPayload.trim()
              const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[')
              const looksComplete = trimmed.endsWith('}') || trimmed.endsWith(']')

              if (!looksJson || !looksComplete) {
                parseError = 'cool_tool payload incomplete (streaming)'
                shouldWarn = false
              } else {
                toolData = JSON.parse(rawPayload)
              }
            } else {
              toolData = rawPayload as any
            }
          } catch (e) {
            parseError = (e as Error)?.message || String(e)
            shouldWarn = true
          }
        }
      }

      const zipId = $elem.attr('data-zip-id')
      const treatAsPending = isPending || parseError !== null

      if (parseError && shouldWarn) {
        console.warn('[messageFormatter] cool_tool payload not ready (rendering pending placeholder):', {
          toolName,
          toolId,
          zipId,
          error: parseError
        })
      }

      if (treatAsPending) {
        // Pending Cool Tool - show loading animation
        return {
          type: 'cool_tool',
          content: '',
          isPending: true,
          toolId,
          toolName,
          toolData: {},
          parseError: parseError || undefined,
          attrs: {
            'data-zip-id': zipId,
            'data-zip-type': $elem.attr('data-zip-type')
          }
        }
      } else {
        if (zipId) {
          // Defer hydration to MessageContent (client) to keep server parse stateless
        }
        return {
          type: 'cool_tool',
          content: '',
          toolData,
          attrs: {
            'data-zip-id': zipId,
            'data-zip-type': $elem.attr('data-zip-type')
          }
        }
      }
    }
  }
  return null
}

function toMessageSegment(xmlSegment: XmlSegment): MessageSegment | null {
  switch (xmlSegment.type) {
    case 'terminal':
      return {
        type: 'terminal' as const,
        content: xmlSegment.content,
        // Include zip metadata if this came from a zip
        zipId: xmlSegment.attrs['data-zip-id'],
        isZip: !!xmlSegment.attrs['data-zip-id'],
        zipType: xmlSegment.attrs['data-zip-type']
      }
      
    case 'diff':
      return {
        type: 'diff' as const,
        content: xmlSegment.content,
        language: 'diff',
        path: xmlSegment.attrs.path || xmlSegment.attrs['data-path'],
        // Include tool metadata
        toolName: xmlSegment.attrs['data-tool-name'],
        filename: xmlSegment.attrs['data-filename'],
        lineCount: xmlSegment.attrs['data-line-count'] ? parseInt(xmlSegment.attrs['data-line-count']) : undefined,
        // Include zip metadata if this came from a zip
        zipId: xmlSegment.attrs['data-zip-id'],
        isZip: !!xmlSegment.attrs['data-zip-id'],
        zipType: xmlSegment.attrs['data-zip-type']
      }
      
    case 'error':
      return {
        type: 'error' as const,
        content: xmlSegment.content,
        errorTitle: xmlSegment.attrs.title,
        // Include zip metadata if this came from a zip
        zipId: xmlSegment.attrs['data-zip-id'],
        isZip: !!xmlSegment.attrs['data-zip-id'],
        zipType: xmlSegment.attrs['data-zip-type']
      }
      
    case 'image':
      const imageSegment = {
        type: 'image' as const,
        content: xmlSegment.content,
        src: xmlSegment.attrs.src || xmlSegment.content, // Prefer src attribute, fallback to content
        alt: xmlSegment.attrs.alt,
        title: xmlSegment.attrs.title,
        width: xmlSegment.attrs.width ? parseInt(xmlSegment.attrs.width) : undefined,
        height: xmlSegment.attrs.height ? parseInt(xmlSegment.attrs.height) : undefined,
        // Include zip metadata if this came from a zip
        zipId: xmlSegment.attrs['data-zip-id'],
        isZip: !!xmlSegment.attrs['data-zip-id'],
        zipType: xmlSegment.attrs['data-zip-type']
      }
      logger.debug('[messageFormatter] Creating image segment:', {
        src: imageSegment.src?.substring(0, 100),
        alt: imageSegment.alt,
        width: imageSegment.width,
        height: imageSegment.height,
        hasSrc: !!imageSegment.src
      })
      return imageSegment
      
    case 'file':
      return {
        type: 'file' as const,
        content: xmlSegment.content,
        url: xmlSegment.content, // The content is the file URL or base64
        filename: xmlSegment.attrs.path,
        fileType: xmlSegment.attrs.type,
        // Include zip metadata if this came from a zip
        zipId: xmlSegment.attrs['data-zip-id'],
        isZip: !!xmlSegment.attrs['data-zip-id'],
        zipType: xmlSegment.attrs['data-zip-type']
      }
      
    case 'cool_tool':
      // Cool tool segments - handle both pending and complete states
      if (xmlSegment.isPending) {
        // Pending Cool Tool - waiting for execution
        return {
          type: 'cool_tool' as const,
          content: '', // Content will be rendered by CoolToolRenderer
          isPending: true,
          toolId: xmlSegment.toolId,
          toolName: xmlSegment.toolName || 'unknown',
          toolStatus: 'loading', // Pending tools are loading
          intermediateStep: null, // No data yet
          // Include zip metadata if present
          zipId: xmlSegment.attrs['data-zip-id'],
          isZip: !!xmlSegment.attrs['data-zip-id'],
          zipType: 'cool_tool'
        }
      } else {
        // Complete Cool Tool with results
        return {
          type: 'cool_tool' as const,
          content: '', // Content will be rendered by CoolToolRenderer
          intermediateStep: xmlSegment.toolData, // The parsed tool data
          toolName: xmlSegment.toolData?.toolName || xmlSegment.toolData?.action?.tool || 'unknown',
          toolStatus: xmlSegment.toolData?.error ? 'error' : 'success',
          // Include zip metadata if present
          zipId: xmlSegment.attrs['data-zip-id'],
          isZip: !!xmlSegment.attrs['data-zip-id'],
          zipType: 'cool_tool'
        }
      }
  }
  return null
}

/** The card for one structured tag of `content`, read by Cheerio from that tag's own text alone. */
function readStructuredElement(content: string, element: StructuredElement): MessageSegment | null {
  const source =
    element.srcFromNextLine !== undefined && element.openEnd !== undefined
      ? `${content.substring(element.start, element.openEnd - 1)} src="${element.srcFromNextLine}">`
      : content.substring(element.start, element.end)
  const $ = cheerio.load(`<root>${source}</root>`, CHEERIO_OPTIONS)
  const elem = $('root').find(element.name).first()
  if (elem.length === 0) return null
  const xmlSegment = readXmlElement($, elem.get(0), element.name)
  return xmlSegment ? toMessageSegment(xmlSegment) : null
}

/**
 * Parse message content into segments for rendering
 * NEW: Detects embedded zips in compiled content
 */
export function parseMessageContent(
  content: string, 
  role: string,
  originalContent?: string,
  messageClips?: Array<{
    clipId: string
    url?: string
    displayUrl?: string
    externalUrl?: string
    localUrl?: string
    fullResolutionUrl?: string
    filename?: string
    mimeType?: string
    contentType?: string
    tokens?: number
    fileSize?: number
    content?: string
  }>,
  validZipIds?: Set<string> | string[],
  hydratedRanges: readonly TextRange[] = []
): MessageSegment[] {
  // Handle undefined or null content
  if (!content) {
    return []
  }

  // `validZipIds` is the trusted set already normalized once by the caller (MessageContent).
  // It is read as given: normalizing it again cut a second `_digits` tail off an id whose
  // random part is all digits, and that tool card became "[zip reference omitted]" (BL-476).
  const trustedZipIds =
    validZipIds instanceof Set
      ? validZipIds
      : Array.isArray(validZipIds)
        ? new Set(validZipIds.filter(Boolean))
        : undefined
  const isValidZipId = trustedZipIds
    ? (zipId: string) => trustedZipIds.has(normalizeId(zipId))
    : undefined

  const unstripped = content
  content = stripZipControlBlocks(content)
  hydratedRanges = projectRemovedTextRanges(unstripped, content, hydratedRanges)
  if (originalContent) {
    originalContent = stripZipControlBlocks(originalContent)
  }

  // For AI responses, the structured tags outside code become their cards, in the order they
  // appear. Everything else is the reply's own text, sliced as written (BL-475).
  if (role === 'assistant' && STRUCTURED_TAG_PRESENT.test(content)) {
    const elements = findStructuredElements(content, isValidZipId)
    if (elements.length > 0) {
      const segments: MessageSegment[] = []
      const pushText = (from: number, to: number) => {
        const text = content.substring(from, to).trim()
        if (text) segments.push({ type: 'text' as const, content: text })
      }
      let lastIndex = 0
      for (const element of elements) {
        pushText(lastIndex, element.start)
        lastIndex = element.end
        // An opening tag still arriving at the end of a streaming reply is hidden until it is whole.
        if (element.partial) continue
        const segment = readStructuredElement(content, element)
        if (segment?.type === 'image') {
          segment.hydratedContext = hydratedRanges.some((range) => range.start <= element.start && range.end >= element.end)
        }
        if (segment) segments.push(segment)
        else pushText(element.start, element.end)
      }
      pushText(lastIndex, content.length)

      if (segments.length > 0) {
        return expandEmbeddedZipRefsInSegments(segments, isValidZipId)
      }
    }
  }
  
  // For user messages, we need to parse embedded Batshit zips and clips (NEW UNIVERSAL SYNTAX)
  if ((role === 'user' || role === 'assistant') && (content.includes('{{batshit-zip:') || content.includes('{{batshit-clip:'))) {
    const segments: Array<{
      type: 'text' | 'code' | 'terminal' | 'batshit' | 'image' | 'file' | 'error' | 'diff' | 'cool_tool'
      content: string
      [key: string]: any // Allow additional properties
    }> = []
    let lastIndex = 0
    
    for (const zipMatch of scanMessageZipReferences(content)) {
      // Add text before zip
      if (zipMatch.start > lastIndex) {
        const textBefore = content.substring(lastIndex, zipMatch.start).trim()
        if (textBefore) {
          segments.push({
            type: 'text' as const,
            content: textBefore
          })
        }
      }
      
      // Parse new zip format: {{batshit-zip:id}} or {{batshit-zip:id:::content}}
      const zipId = zipMatch.id
      const description = zipMatch.description || ''

      const trustedZipRef = isValidZipId ? isValidZipId(zipId) : isConcreteZipId(zipId)
      if (!trustedZipRef) {
        const raw = zipMatch.match
        if (raw) {
          segments.push({
            type: 'text' as const,
            content: neutralizeAllZipReferenceSyntax(raw)
          })
        }
        lastIndex = zipMatch.end
        continue
      }

      const isCoolToolZip = zipId?.includes('cool_tool') || description.toLowerCase().includes('tool execution')
      const resolvedDescription = description || (isCoolToolZip ? 'Tool execution result' : 'Zipped content')
      const resolvedName = isCoolToolZip ? 'Tool Result' : 'Content'
      const tokens = 0

      if (isCoolToolZip) {
        segments.push({
          type: 'cool_tool' as const,
          content: '',
          source: 'AI',
          id: zipId,
          zipId,
          isZip: true,
          zipType: 'cool_tool',
          tokens,
          name: resolvedName,
          description: resolvedDescription,
          toolName: resolvedDescription.replace(/^Tool execution:? ?/, '') || resolvedName
        })
      } else {
        segments.push({
          type: 'batshit' as const,
          id: zipId,
          content: '', // Required property
          source: 'USER',
          tokens,
          name: resolvedName,
          path: '',
          description: resolvedDescription,
          contentType: 'unknown',
          zipType: 'unknown',
          isZip: true,
          zipId
        })
      }
      
      lastIndex = zipMatch.end
    }
    
    // Now parse clips - use originalContent if provided (has raw clip syntax), otherwise use content
    const clipSource = originalContent || content
    const trustedClipIds = new Set(
      (messageClips || [])
        .map((clip) => normalizeId(clip?.clipId))
        .filter(Boolean)
    )
    for (const clipMatch of scanMessageClipReferences(clipSource)) {
      // Parse new clip format: {{batshit-clip:id}} or {{batshit-clip:id:::description}}
      const clipId = clipMatch.id
      if (!isTrustedClipReferenceId(clipId, trustedClipIds)) {
        continue
      }
      const description = clipMatch.description || ''
      const attrs: Record<string, string> = {
        id: clipId,
        description: description
      }
      
      // For clips, we'll need to fetch the actual clip data to get URLs
      // For now, create placeholder that will be resolved later
      const clipData = {
        id: clipId,
        description: description
      }
      
      // Add clip segment - type-aware; URL resolved from clip data if image
      if (clipData.id) {
        // Find position in segments array to insert
        const clipIndex = content.indexOf(clipMatch.match)
        let insertPos = segments.length
        
        // Find where to insert based on position
        for (let i = 0; i < segments.length; i++) {
          if ('index' in segments[i] && segments[i].index! > clipIndex) {
            insertPos = i
            break
          }
        }
        
        // Look up URL from messageClips if available
        let clipUrl = ''
        let clipContentType: string | undefined
        let clipTokens: number | undefined
        let clipFileSize: number | undefined
        let clipMime: string | undefined
        let clipTextContent: string | undefined
        let clipFullResolutionUrl: string | undefined
        let clipFilename = description || clipId
        if (messageClips) {
          const clipData = messageClips.find(c => c.clipId === clipId)
          if (clipData) {
            clipUrl = clipData.url || clipData.displayUrl || clipData.externalUrl || clipData.localUrl || ''
            clipFullResolutionUrl = clipData.fullResolutionUrl
            clipContentType = clipData.contentType || clipData.mimeType
            clipTokens = clipData.tokens
            clipFileSize = clipData.fileSize
            clipMime = clipData.mimeType
            clipTextContent = clipData.content
            clipFilename = clipData.filename || clipFilename
          }
        }

        const lowerFilename = clipFilename.toLowerCase()
        const typeIsImage =
          (clipContentType || '').startsWith('image/') ||
          (clipMime || '').startsWith('image/') ||
          /\.(png|jpe?g|gif|webp|svg)$/i.test(lowerFilename) ||
          Boolean(clipUrl && clipUrl.match(/\.(png|jpe?g|gif|webp|svg)$/i))
        const typeIsText =
          (clipContentType || '').startsWith('text/') ||
          (clipMime || '').startsWith('text/') ||
          clipContentType === 'text' ||
          (clipMime || '').includes('markdown') ||
          /\.(md|markdown|txt|sh|bash|zsh|js|jsx|ts|tsx|json|jsonl|yaml|yml|toml|css|scss|html|xml|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|sql|log|env)$/i.test(lowerFilename)

        if (typeIsImage && clipUrl) {
          segments.splice(insertPos, 0, {
            type: 'image',
            content: '',
            src: clipUrl,
            fullResolutionSrc: clipFullResolutionUrl || undefined,
            alt: description || 'Uploaded image',
            title: description,
            id: clipId,
            index: clipIndex
          })
        } else {
          segments.splice(insertPos, 0, {
            type: 'file',
            content: clipTextContent || description || 'File attachment',
            url: clipUrl || undefined,
            filename: clipFilename,
            id: clipId,
            index: clipIndex,
            fileType: clipMime || clipContentType,
            size: clipFileSize,
            tokens: clipTokens,
            contentType: typeIsText ? 'text' : 'file'
          })
        }
      }
    }
    
    // Remove index property before returning and filter out clip syntax from text
    let finalSegments = []
    let processedContent = content

    // Remove all clip syntax from content using new universal format
    processedContent = neutralizeUntrustedClipReferenceSyntax(processedContent, {
      trustedClipIds
    })
    processedContent = stripTrustedClipReferenceSyntax(processedContent, {
      trustedClipIds
    })

    // Preserve segment order from the zip pass
    segments.forEach(seg => {
      if (seg.type === 'image') {
        delete (seg as any).index
        finalSegments.push(seg)
      } else if (seg.type !== 'text' || seg.content.trim()) {
        finalSegments.push(seg)
      }
    })

    const zipSourceTail = content.substring(lastIndex)
    const processedTail = stripTrustedClipReferenceSyntax(
      neutralizeUntrustedClipReferenceSyntax(zipSourceTail, { trustedClipIds }),
      { trustedClipIds }
    )

    // Add any remaining text AFTER the zip segments to keep ordering intact
    if (processedTail.length > 0) {
      const remainingText = processedTail.trim()
      if (remainingText) {
        finalSegments.push({
          type: 'text' as const,
          content: remainingText
        })
      }
    }
    
    return finalSegments.length > 0 ? finalSegments : [{
      type: 'text' as const,
      content: stripTrustedClipReferenceSyntax(
        neutralizeUntrustedClipReferenceSyntax(content, { trustedClipIds }),
        { trustedClipIds }
      ).trim()
    }]
  }
  
  
  // Fallback - just return as text
  return [{
    type: 'text' as const,
    content: content
  }]
}

/**
 * Process intermediate steps from tool execution into content segments
 * This allows tool results to be rendered with appropriate formatting
 * without requiring the AI to wrap them in XML tags
 */
export function processIntermediateStepsToSegments(
  intermediateSteps: Array<{
    type: 'tool' | 'tool_error' | 'error'
    toolName: string
    toolArgs?: any
    toolResult?: any
    error?: string
  }> | undefined,
  agent?: any,
  globalSettings?: any
): MessageSegment[] {
  if (!intermediateSteps || intermediateSteps.length === 0) {
    return []
  }
  
  // Process the steps and return segments
  return processIntermediateSteps(intermediateSteps, agent, undefined, undefined, globalSettings)
}
