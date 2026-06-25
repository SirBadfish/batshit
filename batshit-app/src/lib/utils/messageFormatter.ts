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
  const embeddedZipRegex = /\{\{batshit-zip:([^:]+?)(?::::([^}]+?))?\}\}/g
  let lastIndex = 0
  let zipMatch

  while ((zipMatch = embeddedZipRegex.exec(text)) !== null) {
    if (zipMatch.index > lastIndex) {
      const textBefore = text.substring(lastIndex, zipMatch.index).trim()
      if (textBefore) {
        segments.push({
          type: 'text' as const,
          content: textBefore
        })
      }
    }

    const zipId = zipMatch[1]
    const trustedZipRef = isValidZipId ? isValidZipId(zipId) : isConcreteZipId(zipId)
    if (!trustedZipRef) {
      const raw = zipMatch[0]
      if (raw) {
        segments.push({
          type: 'text' as const,
          content: neutralizeAllZipReferenceSyntax(raw)
        })
      }
      lastIndex = zipMatch.index + zipMatch[0].length
      continue
    }
    const description = zipMatch[2] || ''
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

    lastIndex = zipMatch.index + zipMatch[0].length
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
  validZipIds?: Set<string> | string[]
): MessageSegment[] {
  // Handle undefined or null content
  if (!content) {
    return []
  }

  const normalizedZipIds =
    validZipIds instanceof Set
      ? new Set(Array.from(validZipIds).map((id) => normalizeId(id)))
      : Array.isArray(validZipIds)
        ? new Set(validZipIds.map((id) => normalizeId(id)).filter(Boolean))
        : undefined
  const isValidZipId = normalizedZipIds
    ? (zipId: string) => normalizedZipIds.has(normalizeId(zipId))
    : undefined

  content = stripZipControlBlocks(content)
  if (originalContent) {
    originalContent = stripZipControlBlocks(originalContent)
  }

  // Quick sanitation: some n8n tool pipelines after zipping can append a
  // duplicated raw tool payload (toolCallId/toolResult JSON) after the cool_tool zip.
  // If we detect that signature, strip it before parsing so it doesn't render twice
  // when messages are reloaded from Redis.
  if (role === 'assistant' && content.includes('toolCallId') && content.includes('{{batshit-zip:')) {
    content = content.replace(/,\s*"toolCallId"[\s\S]*?(?=(\{\{batshit-zip:|$))/g, '')
  }
  
  const segments = []
  
  // Preprocess to fix malformed img tags where src is on the next line
  // Pattern: <img alt="..." ...>\nURL
  content = content.replace(/<img([^>]*?)>\s*\n\s*(https?:\/\/[^\s<]+|data:[^<\s]+)/gi, (match, attrs, url) => {
    // Add the src attribute to the img tag
    return `<img${attrs} src="${url}">`
  })
  
  // For AI responses, handle all content types in the order they appear
  if (role === 'assistant') {
    // NEW: Check ORIGINAL content for embedded zips if provided
    const zipPositions: Array<{start: number, end: number, id: string, type: string, description: string}> = []
    
    if (originalContent) {
      // Check original content for zips using new universal syntax
      const embeddedZipRegex = /\{\{batshit-zip:([^:]+?)(?::::([^}]+?))?\}\}/g
      let zipMatch
      
      while ((zipMatch = embeddedZipRegex.exec(originalContent)) !== null) {
        if (isValidZipId && !isValidZipId(zipMatch[1])) {
          continue
        }
        zipPositions.push({
          start: zipMatch.index,
          end: zipMatch.index + zipMatch[0].length,
          id: zipMatch[1],
          type: 'batshit-zip',
          description: zipMatch[2] || ''
        })
      }
    }
    
    // Cool tools are now handled by Cheerio in the XML parsing section below
    // No regex needed - Cheerio parses them perfectly with single quotes
    
    // Continue with regular XML parsing
    
    // Parse XML blocks using Cheerio instead of regex
    // First, try to parse as XML if it contains any XML tags
    // Note: 'img' is standard HTML, others are our custom XML tags
    const hasXmlTags = /<(terminal|diff|error|image|img|file|cool_tool)[\s>]/i.test(content)
    
    if (hasXmlTags) {
      // Wrap content in root element for proper parsing
      const wrappedContent = `<root>${content}</root>`
      const $ = cheerio.load(wrappedContent, {
        xml: {
          xmlMode: false,
          recognizeSelfClosing: true
        }
      })
      
      // Replace XML elements with placeholders and collect them
      const xmlSegments: Array<{
        type: string,
        content: string,
        attrs?: any,
        toolData?: any,
        parseError?: string,
        isPending?: boolean,
        toolId?: string,
        toolName?: string
      }> = []
      const placeholders: string[] = []
      
      // Terminal blocks
      $('terminal').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___TERMINAL_${xmlSegments.length}___`
        // Use html() so escaped code-like output can round-trip through XML wrappers.
        const rawContent = $elem.html() || ''
        const textContent = decodeStructuredTextContent(rawContent)
        
        // Capture all attributes including data-zip-id
        const attrs: any = {}
        if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
        if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
        
        xmlSegments.push({
          type: 'terminal',
          content: textContent,
          attrs
        })
        placeholders.push(placeholder)
        $elem.replaceWith(placeholder)
      })
      
      // Diff blocks
      $('diff').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___DIFF_${xmlSegments.length}___`
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
        
        xmlSegments.push({
          type: 'diff',
          content: textContent,
          attrs
        })
        placeholders.push(placeholder)
        $elem.replaceWith(placeholder)
      })
      
      // Error blocks
      $('error').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___ERROR_${xmlSegments.length}___`
        
        // Capture all attributes including data-zip-id
        const attrs: any = { title: $elem.attr('title') || 'Error' }
        if ($elem.attr('data-zip-id')) attrs['data-zip-id'] = $elem.attr('data-zip-id')
        if ($elem.attr('data-zip-type')) attrs['data-zip-type'] = $elem.attr('data-zip-type')
        
        xmlSegments.push({
          type: 'error',
          content: $elem.text(),
          attrs
        })
        placeholders.push(placeholder)
        $elem.replaceWith(placeholder)
      })
      
      // Image blocks - handle custom <image> tags
      $('image').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___IMAGE_${xmlSegments.length}___`

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

          xmlSegments.push({
            type: 'image',
            content: resolvedSrc,
            attrs
          })
          placeholders.push(placeholder)
          $elem.replaceWith(placeholder)
        }
      })
      
      // Image blocks - handle standard HTML <img> tags
      $('img').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___IMAGE_${xmlSegments.length}___`
        
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
          
          xmlSegments.push({
            type: 'image',
            content: srcAttr, // Store the source as content
            attrs
          })
          placeholders.push(placeholder)
          $elem.replaceWith(placeholder)
        }
      })
      
      // File blocks
      $('file').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___FILE_${xmlSegments.length}___`
        
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
        
        xmlSegments.push({
          type: 'file',
          content: textContent,
          attrs
        })
        placeholders.push(placeholder)
        $elem.replaceWith(placeholder)
      })
      
      // Cool tool blocks - JSON payload lives inside the element (script or text)
      $('cool_tool').each((_, elem) => {
        const $elem = $(elem)
        const placeholder = `___COOL_TOOL_${xmlSegments.length}___`

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
          xmlSegments.push({
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
          })
        } else {
          if (zipId) {
            // Defer hydration to MessageContent (client) to keep server parse stateless
          }
          xmlSegments.push({
            type: 'cool_tool',
            content: '',
            toolData,
            attrs: {
              'data-zip-id': zipId,
              'data-zip-type': $elem.attr('data-zip-type')
            }
          })
        }

        placeholders.push(placeholder)
        $elem.replaceWith(placeholder)
      })
      
      // REMOVED: tool_result blocks are no longer supported
      // All tool results now use cool_tool format
      
      // Get the modified content with placeholders
      let modifiedContent = $('root').html() || content
      
      // Process the content with placeholders (preserve document order)
      const orderedPlaceholders = placeholders
        .map((placeholder, index) => ({
          placeholder,
          index,
          position: modifiedContent.indexOf(placeholder)
        }))
        .filter((entry) => entry.position >= 0)
        .sort((a, b) => a.position - b.position)

      let lastIndex = 0
      for (const entry of orderedPlaceholders) {
        const placeholder = entry.placeholder
        const placeholderIndex = entry.position
        
        if (placeholderIndex > lastIndex) {
          // Add text before placeholder
          const textBefore = modifiedContent.substring(lastIndex, placeholderIndex).trim()
          if (textBefore) {
            segments.push({
              type: 'text' as const,
              content: textBefore
            })
          }
        }
        
        // Add the XML element
        const xmlSegment = xmlSegments[entry.index]
        switch (xmlSegment.type) {
          case 'terminal':
            segments.push({
              type: 'terminal' as const,
              content: xmlSegment.content,
              // Include zip metadata if this came from a zip
              zipId: xmlSegment.attrs['data-zip-id'],
              isZip: !!xmlSegment.attrs['data-zip-id'],
              zipType: xmlSegment.attrs['data-zip-type']
            })
            break
            
          case 'diff':
            segments.push({
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
            })
            break
            
          case 'error':
            segments.push({
              type: 'error' as const,
              content: xmlSegment.content,
              errorTitle: xmlSegment.attrs.title,
              // Include zip metadata if this came from a zip
              zipId: xmlSegment.attrs['data-zip-id'],
              isZip: !!xmlSegment.attrs['data-zip-id'],
              zipType: xmlSegment.attrs['data-zip-type']
            })
            break
            
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
            segments.push(imageSegment)
            break
            
          case 'file':
            segments.push({
              type: 'file' as const,
              content: xmlSegment.content,
              url: xmlSegment.content, // The content is the file URL or base64
              filename: xmlSegment.attrs.path,
              fileType: xmlSegment.attrs.type,
              // Include zip metadata if this came from a zip
              zipId: xmlSegment.attrs['data-zip-id'],
              isZip: !!xmlSegment.attrs['data-zip-id'],
              zipType: xmlSegment.attrs['data-zip-type']
            })
            break
            
          case 'cool_tool':
            // Cool tool segments - handle both pending and complete states
            if (xmlSegment.isPending) {
              // Pending Cool Tool - waiting for execution
              segments.push({
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
              })
            } else {
              // Complete Cool Tool with results
              segments.push({
                type: 'cool_tool' as const,
                content: '', // Content will be rendered by CoolToolRenderer
                intermediateStep: xmlSegment.toolData, // The parsed tool data
                toolName: xmlSegment.toolData?.toolName || xmlSegment.toolData?.action?.tool || 'unknown',
                toolStatus: xmlSegment.toolData?.error ? 'error' : 'success',
                // Include zip metadata if present
                zipId: xmlSegment.attrs['data-zip-id'],
                isZip: !!xmlSegment.attrs['data-zip-id'],
                zipType: 'cool_tool'
              })
            }
            break
            
          // REMOVED: tool_result case no longer supported
          // All tool results now use cool_tool format which is handled above
        }
        
        lastIndex = placeholderIndex + placeholder.length
      }
      
      // Add any remaining text
      if (lastIndex < modifiedContent.length) {
        const remainingText = modifiedContent.substring(lastIndex).trim()
        if (remainingText) {
          segments.push({
            type: 'text' as const,
            content: remainingText
          })
        }
      }
      
      // If we found XML elements, return them
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
    const embeddedZipRegex = /\{\{batshit-zip:([^:]+?)(?::::([^}]+?))?\}\}/g
    const embeddedClipRegex = /\{\{batshit-clip:([^:]+?)(?::::([^}]+?))?\}\}/g
    let lastIndex = 0
    let zipMatch
    
    while ((zipMatch = embeddedZipRegex.exec(content)) !== null) {
      // Add text before zip
      if (zipMatch.index > lastIndex) {
        const textBefore = content.substring(lastIndex, zipMatch.index).trim()
        if (textBefore) {
          segments.push({
            type: 'text' as const,
            content: textBefore
          })
        }
      }
      
      // Parse new zip format: {{batshit-zip:id}} or {{batshit-zip:id:::content}}
      const zipId = zipMatch[1]
      const description = zipMatch[2] || ''

      const trustedZipRef = isValidZipId ? isValidZipId(zipId) : isConcreteZipId(zipId)
      if (!trustedZipRef) {
        const raw = zipMatch[0]
        if (raw) {
          segments.push({
            type: 'text' as const,
            content: neutralizeAllZipReferenceSyntax(raw)
          })
        }
        lastIndex = zipMatch.index + zipMatch[0].length
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
      
      lastIndex = zipMatch.index + zipMatch[0].length
    }
    
    // Now parse clips - use originalContent if provided (has raw clip syntax), otherwise use content
    const clipSource = originalContent || content
    const trustedClipIds = new Set(
      (messageClips || [])
        .map((clip) => normalizeId(clip?.clipId))
        .filter(Boolean)
    )
    let clipMatch
    while ((clipMatch = embeddedClipRegex.exec(clipSource)) !== null) {
      // Parse new clip format: {{batshit-clip:id}} or {{batshit-clip:id:::description}}
      const clipId = clipMatch[1]
      if (!isTrustedClipReferenceId(clipId, trustedClipIds)) {
        continue
      }
      const description = clipMatch[2] || ''
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
        const clipIndex = content.indexOf(clipMatch[0])
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
