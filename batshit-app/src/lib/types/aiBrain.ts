/**
 * Batshit AI Brain Types
 * Purpose: Type definitions for the AI Brain service
 * Critical: supports structured multimodal inputs without raw image bytes in text context.
 */

/**
 * Request structure for the AI Brain think endpoint
 */
export interface ThinkRequest {
  /** Pre-compiled messages from frontend (already optimized) */
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    /** Optional name for multi-agent scenarios */
    name?: string
    /** Tool calls from assistant (for tool calling pattern) */
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: {
        name: string
        arguments: string
      }
    }>
    /** Tool call ID (for tool result messages) */
    tool_call_id?: string
  }>

  /** Model selection (e.g., 'claude-sonnet-4-5', 'gpt-5', 'gemini-2.5') */
  model: string

  /** Available tools from n8n */
  availableTools?: Array<{
    name: string
    description: string
    schema: Record<string, any>
  }>

  /** Image inputs - URLs or data URLs are safe when kept out of prompt text. */
  images?: Array<{
    url: string
    /** Optional alt text for accessibility */
    alt?: string
  }>

  /** Session context */
  sessionId: string
  messageId: string
  userId: string

  /** Optional parameters */
  temperature?: number
  maxTokens?: number
  stream?: boolean

  /** Agent-specific settings */
  agentSettings?: {
    systemPrompt?: string
    bufferSize?: number
    threshold?: number
  }
}

/**
 * Response structure from AI Brain
 */
export interface ThoughtResponse {
  /** Main response content */
  content: string

  /** Tool calls to be executed by n8n */
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, any>
  }>

  /** Intermediate steps for Cool Tools rendering */
  intermediateSteps?: Array<{
    toolName: string
    toolInput: Record<string, any>
    toolOutput: any
    timestamp: number
  }>

  /** Model that was actually used (after routing/fallback) */
  modelUsed: string

  /** Token usage statistics */
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    /** Structured image-input token estimate; raw data URLs must not appear in text context. */
    imageTokens?: number
    /** Provider-reported prompt-cache read tokens, when the provider reported them. */
    cachedInputTokens?: number
    /** Provider-reported prompt-cache creation tokens, when reported. */
    cacheCreationInputTokens?: number
  }

  /** Cost tracking from provider */
  cost?: {
    promptCost: number
    completionCost: number
    totalCost: number
    currency: string
  }

  /** Response metadata */
  metadata?: {
    provider: string
    latency: number
    cached?: boolean
    fallbackUsed?: boolean
    mode?: string
  }
}

/**
 * AI Provider chat completion request format
 * OpenAI-compatible with extensions
 */
export interface AIProviderRequest {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'function'
    content: string | Array<{
      type: 'text' | 'image_url'
      text?: string
      image_url?: {
        /** Structured image reference. Do not paste raw image bytes into text content. */
        url: string
        detail?: 'low' | 'high' | 'auto'
      }
    }>
    name?: string
    function_call?: {
      name: string
      arguments: string
    }
  }>

  /** Tool/function definitions */
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, any>
    }
  }>

  /** Optional parameters */
  temperature?: number
  max_tokens?: number
  stream?: boolean
  user?: string

  /** Provider specific */
  api_base?: string
  api_key?: string
  custom_llm_provider?: string
}

/**
 * AI Provider response format with cost tracking
 */
export interface AIProviderResponse {
  id: string
  object: string
  created: number
  model: string

  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: string
  }>

  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }

  /** Provider extensions */
  _hidden_params?: {
    response_cost?: number
    custom_llm_provider?: string
    model_id?: string
  }
}

/**
 * Error response format
 */
export interface AIBrainError {
  error: string
  code?: string
  details?: any
  fallbackAvailable?: boolean
}

/**
 * Streaming chunk format for real-time responses
 */
export interface StreamChunk {
  type: 'content' | 'tool_call' | 'complete' | 'error'
  /** Incremental content chunk (for type: 'content') */
  content?: string
  /** Accumulated content so far (for type: 'content') */
  accumulatedContent?: string
  /** Tool call info (for type: 'tool_call') */
  toolCall?: {
    id: string
    name: string
  }
  /** Final tool calls array (for type: 'complete') */
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, any>
  }>
  /** Completion metadata (for type: 'complete') */
  finishReason?: string
  usage?: any
  metadata?: {
    model?: string
    latency?: number
  }
  /** Error message (for type: 'error') */
  error?: string
}
