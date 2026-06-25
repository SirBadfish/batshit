/**
 * Token counting utilities for batshit
 * 
 * This is a simple approximation - for production you'd want to use
 * the actual tokenizer for your model (tiktoken for OpenAI models)
 */

export const STRUCTURED_IMAGE_TOKEN_ESTIMATE = 765

/**
 * Approximate token count for a string
 * Rules of thumb:
 * - 1 token ~= 4 chars in English
 * - 1 token ~= ¾ words
 * - 100 tokens ~= 75 words
 */
export function approximateTokenCount(text: string): number {
  if (!text) return 0
  
  // Remove extra whitespace
  const cleanText = text.replace(/\s+/g, ' ').trim()
  
  // Simple approximation: 1 token per 4 characters
  // This is reasonable for English text
  const charCount = cleanText.length
  const tokenEstimate = Math.ceil(charCount / 4)
  
  // Add overhead for special characters and formatting
  const specialCharCount = (text.match(/[^a-zA-Z0-9\s]/g) || []).length
  const overhead = Math.ceil(specialCharCount * 0.1)
  
  return tokenEstimate + overhead
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}

function readPositiveTokenEstimate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.ceil(value)
  }
  if (typeof value !== 'string') return null

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : null
}

function hasImageDataUrl(value: unknown): boolean {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)
}

function resolveStructuredImageTokens(part: Record<string, any>): number {
  return (
    readPositiveTokenEstimate(part.tokens) ??
    readPositiveTokenEstimate(part.batshit_tokens) ??
    readPositiveTokenEstimate(part.imageTokens) ??
    STRUCTURED_IMAGE_TOKEN_ESTIMATE
  )
}

function isStructuredImagePart(part: Record<string, any>): boolean {
  const type = typeof part.type === 'string' ? part.type.toLowerCase() : ''
  if (type === 'image' || type === 'image_url' || type === 'input_image') return true
  if (hasImageDataUrl(part.image)) return true
  if (hasImageDataUrl(part.url)) return true
  if (hasImageDataUrl(part.data)) return true
  if (hasImageDataUrl(part.content) && String(part.contentType ?? '').toLowerCase() === 'image') {
    return true
  }

  const imageUrl = asRecord(part.image_url ?? part.imageUrl)
  return Boolean(imageUrl && hasImageDataUrl(imageUrl.url))
}

function stringifyUnknownContent(content: unknown): string {
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * Count model-facing message content without charging structured image bytes as text.
 * Data URLs still count normally when they are plain text; only multimodal image parts
 * get image-token treatment.
 */
export function countMessageContentTokens(content: unknown): number {
  if (typeof content === 'string') return approximateTokenCount(content)
  if (content === null || content === undefined) return 0

  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + countMessageContentTokens(part), 0)
  }

  const record = asRecord(content)
  if (!record) return approximateTokenCount(String(content))

  const type = typeof record.type === 'string' ? record.type.toLowerCase() : ''
  if (type === 'text' || type === 'input_text') {
    return approximateTokenCount(
      typeof record.text === 'string'
        ? record.text
        : typeof record.content === 'string'
          ? record.content
          : ''
    )
  }

  if (isStructuredImagePart(record)) {
    return resolveStructuredImageTokens(record)
  }

  if (type === 'file' || type === 'input_file') {
    const tokens = readPositiveTokenEstimate(record.tokens)
    if (tokens !== null) return tokens
  }

  return approximateTokenCount(stringifyUnknownContent(content))
}

export function stringifyTokenCountableMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''

  if (Array.isArray(content)) {
    return content
      .map((part) => stringifyTokenCountableMessageContent(part))
      .filter((part) => part.trim().length > 0)
      .join('\n')
  }

  const record = asRecord(content)
  if (!record) return String(content)

  const type = typeof record.type === 'string' ? record.type.toLowerCase() : ''
  if (type === 'text' || type === 'input_text') {
    return typeof record.text === 'string'
      ? record.text
      : typeof record.content === 'string'
        ? record.content
        : ''
  }

  if (isStructuredImagePart(record)) {
    const tokens = resolveStructuredImageTokens(record)
    const filename =
      typeof record.filename === 'string' && record.filename.trim()
        ? ` ${record.filename.trim()}`
        : ''
    return `[Structured image input${filename}; estimated ${tokens} tokens]`
  }

  if (type === 'file' || type === 'input_file') {
    const tokens = readPositiveTokenEstimate(record.tokens)
    const filename =
      typeof record.filename === 'string' && record.filename.trim()
        ? ` ${record.filename.trim()}`
        : ''
    return tokens === null
      ? `[Structured file input${filename}]`
      : `[Structured file input${filename}; estimated ${tokens} tokens]`
  }

  return stringifyUnknownContent(content)
}

/**
 * Count tokens in a message including metadata overhead
 */
export function countMessageTokens(message: {
  role: string
  content: unknown
  metadata?: any
}): number {
  let tokens = 0
  
  // Role tokens (usually 1-2)
  tokens += 2
  
  // Content tokens
  tokens += countMessageContentTokens(message.content)
  
  // Metadata overhead (if present)
  if (message.metadata) {
    tokens += approximateTokenCount(JSON.stringify(message.metadata))
  }
  
  // Message formatting overhead (timestamps, etc.)
  tokens += 10
  
  return tokens
}

/**
 * Count total tokens for an array of messages
 */
export function countTotalTokens(messages: Array<{
  role: string
  content: unknown
  metadata?: any
}>): number {
  return messages.reduce((total, msg) => total + countMessageTokens(msg), 0)
}

/**
 * Model pricing information (per million tokens)
 */
export const MODEL_PRICING = {
  'gpt-4': { input: 30, output: 60 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'custom': { input: 15, output: 15 } // Default for custom models
}

/**
 * Calculate cost for tokens
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: keyof typeof MODEL_PRICING = 'gpt-4'
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.custom
  
  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  
  return inputCost + outputCost
}

/**
 * Get warning level based on token usage percentage
 */
export function getTokenWarningLevel(percentage: number): 'safe' | 'warning' | 'danger' {
  if (percentage >= 90) return 'danger'
  if (percentage >= 80) return 'warning'
  return 'safe'
}
