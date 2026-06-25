/**
 * Zip Service for Permanent Zip Storage
 * Part of Story 2.2: Finalize Zip Creation from Redis
 */

import { redis } from './redis'
import { redisStreamService } from './redisStreamService'
import { logger } from '$lib/utils/logger'

export interface ZipData {
  id: string
  content: string
  type: 'terminal' | 'diff' | 'error' | 'cool_tool' | 'tool_raw' | 'image' | 'file'
  tokens: number
  description?: string
  createdAt: number
  source: 'stream-to-zip' | 'manual' | 'streaming'
  metadata?: {
    sessionId: string
    messageId: string
    originalChunkCount?: number
    language?: string
    path?: string
  }
  [key: string]: any // Add index signature for RedisJSON compatibility
}

export interface ZipReference {
  zipId?: string
  placeholder?: string
  reference: string
  position?: {
    start: number
    end: number
  }
}

export interface ZipCreationOptions {
  zipId?: string
}

/**
 * Calculate approximate token count for content
 * Rule of thumb: ~4 characters per token
 */
function calculateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function resolveStoredTokenCount(content: string, metadata?: any): number {
  const promptTokens = metadata?.promptTokens ?? metadata?.aiTokens
  if (typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens > 0) {
    return Math.ceil(promptTokens)
  }
  return calculateTokens(content)
}

function normalizeLineCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.trunc(value))
}

function formatLineCount(value: number): string {
  return `${value} ${value === 1 ? 'line' : 'lines'}`
}

function normalizePreviewText(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .replace(/[{}]/g, (char) => (char === '{' ? '(' : ')'))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function redactSensitivePreview(value: string): string {
  return value
    .replace(
      /([?&][^=&\s]*(?:token|secret|password|api[_-]?key|auth|credential)[^=&\s]*=)[^&\s]+/gi,
      '$1[redacted]'
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1=[redacted]'
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
}

function shortenMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 12) return value.slice(0, maxChars)
  const keepStart = Math.ceil((maxChars - 5) * 0.6)
  const keepEnd = Math.floor((maxChars - 5) * 0.4)
  return `${value.slice(0, keepStart)} ... ${value.slice(value.length - keepEnd)}`
    .replace(/\[redacte?\s+\.\.\.\s+/gi, '[redacted] ... ')
    .replace(/\[redacted?\s*$/gi, '[redacted]')
}

function normalizeDescriptionPart(value: unknown, maxChars = 96): string {
  const normalized = redactSensitivePreview(normalizePreviewText(value))
  if (!normalized) return ''
  return shortenMiddle(normalized, maxChars)
}

function normalizePathPreview(value: unknown, metadata?: any): string {
  const normalized = normalizePreviewText(value)
  if (!normalized) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    return normalizeDescriptionPart(normalized, 96)
  }

  const roots = [
    metadata?.projectPath,
    metadata?.project_path,
    metadata?.cwd,
    metadata?.workingDir,
    metadata?.working_dir,
    process.cwd(),
    process.cwd().endsWith('/batshit-app') ? process.cwd().slice(0, -'/batshit-app'.length) : null
  ]
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => root.replace(/\/+$/, ''))

  for (const root of roots) {
    if (normalized === root) return '.'
    if (normalized.startsWith(`${root}/`)) {
      return normalizeDescriptionPart(normalized.slice(root.length + 1), 96)
    }
  }

  return normalizeDescriptionPart(normalized, 96)
}

function buildStructuredZipDescription(
  metadata: any,
  fallbackLabel: string,
  fallbackSize: string
): string | null {
  const label = normalizeDescriptionPart(
    metadata?.zipDescriptionLabel ||
      metadata?.zip_description_label ||
      metadata?.operationKind ||
      metadata?.toolName ||
      metadata?.displayToolName ||
      fallbackLabel,
    44
  )
  const target = normalizePathPreview(
    metadata?.zipDescriptionTarget ?? metadata?.zip_description_target,
    metadata
  )
  const status = normalizeDescriptionPart(
    metadata?.zipDescriptionStatus ?? metadata?.zip_description_status,
    40
  )
  const size = normalizeDescriptionPart(
    metadata?.zipDescriptionSize ?? metadata?.zip_description_size ?? fallbackSize,
    28
  )

  const detailParts = [status, size].filter((part, index, parts) => {
    if (!part) return false
    return parts.indexOf(part) === index
  })

  if (!label && !target && detailParts.length === 0) return null
  const head = target ? `${label || fallbackLabel}: ${target}` : (label || fallbackLabel)
  return detailParts.length > 0 ? `${head} - ${detailParts.join(' - ')}` : head
}

/**
 * Generate a unique zip ID
 * Updated to match the format used in other parts of the system
 */
function generateZipId(type?: string): string {
  // Use a format similar to what's expected: type_timestamp_random
  const typePrefix = type || 'zip'
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 7)
  return `${typePrefix}_${timestamp}_${random}`
}

export function reserveZipId(type?: string): string {
  return generateZipId(type)
}

function resolveZipId(type: string | undefined, options?: ZipCreationOptions): string {
  const explicitZipId = options?.zipId?.trim()
  if (!explicitZipId) {
    return generateZipId(type)
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*_\d{10,17}_[a-z0-9]{5,12}$/.test(explicitZipId)) {
    throw new Error(`[ZipService] Invalid preallocated zipId: ${explicitZipId}`)
  }

  return explicitZipId
}

/**
 * Generate meaningful description for zip reference
 */
export function generateZipDescription(content: string, type: string, metadata?: any): string {
  const lines = content.split('\n')
  const lineCount =
    normalizeLineCount(metadata?.contentLineCount) ??
    normalizeLineCount(metadata?.resultLineCount) ??
    normalizeLineCount(metadata?.lineCount) ??
    lines.length
  const formattedLineCount = formatLineCount(lineCount)
  
  switch(type) {
    case 'terminal':
      return normalizeDescriptionPart(`Terminal output - ${formattedLineCount}`, 120)
    
    case 'diff': {
      const path = metadata?.path || extractDiffPath(content)
      return normalizeDescriptionPart(
        `Diff for ${normalizePathPreview(path || 'file', metadata)} - ${formattedLineCount}`,
        120
      )
    }
    
    case 'error':
      return normalizeDescriptionPart(`Error output - ${formattedLineCount}`, 120)
    
    case 'cool_tool': {
      const toolName =
        metadata?.operationKind ||
        metadata?.toolName ||
        metadata?.displayToolName ||
        'Tool execution'
      const structured = buildStructuredZipDescription(metadata, toolName, formattedLineCount)
      return structured || normalizeDescriptionPart(`${toolName} - ${formattedLineCount}`, 120)
    }

    case 'tool_raw':
      return normalizeDescriptionPart(
        metadata?.description || `Raw tool payload - ${formattedLineCount}`,
        120
      )

    case 'image': {
      const label =
        metadata?.description ||
        metadata?.alt ||
        metadata?.name ||
        'Image'
      return normalizeDescriptionPart(label, 120)
    }
    
    default:
      return normalizeDescriptionPart(`${type} content - ${formattedLineCount}`, 120)
  }
}

/**
 * Extract file path from diff content
 */
function extractDiffPath(content: string): string | null {
  // Look for diff header patterns
  const patterns = [
    /^diff --git a\/(.+) b\//m,
    /^--- a\/(.+)$/m,
    /^\+\+\+ b\/(.+)$/m
  ]
  
  for (const pattern of patterns) {
    const match = content.match(pattern)
    if (match) return match[1]
  }
  
  return null
}

/**
 * Create a permanent zip from temporary Redis storage
 */
export async function createPermanentZip(
  sessionId: string,
  messageId: string,
  type: string,
  index: number,
  metadata?: any,
  options?: ZipCreationOptions
): Promise<{ zipId: string; reference: string } | null> {
  // Retrieve content from temporary storage
  const content = await redisStreamService.completeZipBlock(
    sessionId,
    messageId,
    type,
    index
  )
  
  if (!content) {
    console.error(`[ZipService] No content found for ${type}:${index}`)
    return null
  }
  
  // Generate zip ID and description
  const zipId = resolveZipId(type, options)
  const description = generateZipDescription(content, type, metadata)
  
  // Create zip data object
  const bufferSizeMeta = (metadata as any)?.bufferSize
  const thresholdMeta = (metadata as any)?.threshold

  const zipData: ZipData = {
    id: zipId,
    content,
    type: type as ZipData['type'],
    tokens: resolveStoredTokenCount(content, metadata),
    description,
    createdAt: Date.now(),
    source: 'stream-to-zip',
    metadata: {
      sessionId,
      messageId,
      originalChunkCount: content.split('\n').length,
      ...metadata
    }
  }

  if (bufferSizeMeta !== undefined) {
    (zipData as any).bufferSize = bufferSizeMeta
  }
  if (thresholdMeta !== undefined) {
    (zipData as any).threshold = thresholdMeta
  }
  
  // Store in Redis using json.set and keep the per-session cleanup/list index current.
  await redis.execute(async (client) => {
    await client.json.set(`zip:${zipId}`, '$', zipData)
    if (sessionId) {
      await client.sAdd(`session:${sessionId}:zips`, zipId)
    }
  })
  
  logger.debug(`[ZipService] Created zip ${zipId} for ${type} content (${content.length} chars)`)
  
  // Return the zip reference format
  return {
    zipId,
    reference: `{{batshit-zip:${zipId}:::${description}}}`
  }
}

/**
 * Finalize zip creation from Redis temporary storage
 */
export async function finalizeZipFromRedis(
  sessionId: string,
  messageId: string,
  type: string,
  index: number,
  metadata?: any,
  options?: ZipCreationOptions
): Promise<string | null> {
  const result = await createPermanentZip(sessionId, messageId, type, index, metadata, options)
  return result ? result.reference : null
}

/**
 * Create a zip directly from content (for testing or manual creation)
 */
export async function createZipFromContent(
  content: string,
  type: string,
  sessionId: string,
  messageId: string,
  metadata?: any,
  options?: ZipCreationOptions
): Promise<{ zipId: string; reference: string }> {
  const zipId = resolveZipId(type, options)
  const description = generateZipDescription(content, type, metadata)
  
  const bufferSizeMeta = metadata?.bufferSize
  const thresholdMeta = metadata?.threshold

  const zipData: ZipData = {
    id: zipId,
    content,
    type: type as ZipData['type'],
    tokens: resolveStoredTokenCount(content, metadata),
    description,
    createdAt: Date.now(),
    source: 'manual',
    metadata: {
      sessionId,
      messageId,
      ...metadata
    }
  }

  if (bufferSizeMeta !== undefined) {
    (zipData as any).bufferSize = bufferSizeMeta
  }
  if (thresholdMeta !== undefined) {
    (zipData as any).threshold = thresholdMeta
  }
  
  await redis.execute(async (client) => {
    await client.json.set(`zip:${zipId}`, '$', zipData)
    if (sessionId) {
      // Keep per-session zip index so deleteSession can clean up
      await client.sAdd(`session:${sessionId}:zips`, zipId)
    }
  })
  
  return {
    zipId,
    reference: `{{batshit-zip:${zipId}:::${description}}}`
  }
}

/**
 * Batch finalize all active zip blocks for a message
 */
export async function finalizeAllZipBlocks(
  sessionId: string,
  messageId: string
): Promise<ZipReference[]> {
  const activeBlocks = await redisStreamService.getActiveZipBlocks(sessionId, messageId)
  const references: ZipReference[] = []
  
  for (const block of activeBlocks) {
    const result = await createPermanentZip(
      sessionId,
      messageId,
      block.type,
      block.index,
      {
        language: block.language,
        path: block.path
      }
    )
    
    if (result) {
      references.push({
        zipId: result.zipId,
        placeholder: `{{ZIP_PLACEHOLDER_${block.type}_${block.index}}}`,
        reference: result.reference
      })
    }
  }
  
  // Clean up all temporary storage for this message
  await redisStreamService.cleanupSessionTempStorage(sessionId, messageId)
  
  return references
}
