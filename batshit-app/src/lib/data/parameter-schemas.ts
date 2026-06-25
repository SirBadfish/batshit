import type { ModelCapabilities, ModelPurpose } from '$lib/types/savedModels'

export type ParameterInputType =
  | 'number'
  | 'integer'
  | 'text'
  | 'textarea'
  | 'select'
  | 'boolean'
  | 'json'
  | 'string-array'

export type ParameterValue = number | string | boolean | string[] | Record<string, unknown> | null

export interface ParameterDefinition {
  name: string
  label: string
  description?: string
  inputType: ParameterInputType
  n8nSupported?: boolean
  placeholder?: string
  helperText?: string
  min?: number
  max?: number
  step?: number
  options?: Array<{ label: string; value: string }>
  defaultValue?: ParameterValue
  advanced?: boolean
  section?: 'core' | 'provider' | 'vision' | 'reasoning' | 'visual' | 'audio' | 'utility'
  roles?: ModelPurpose[]
  excludeRoles?: ModelPurpose[]
  order?: number
  requiresCapability?: keyof ModelCapabilities
  onlyProviders?: string[]
  excludeProviders?: string[]
  onlyModels?: string[]
  excludeModels?: string[]
  providerOptionKey?: string
  standardKey?:
    | 'temperature'
    | 'topP'
    | 'topK'
    | 'presencePenalty'
    | 'frequencyPenalty'
    | 'seed'
    | 'stopSequences'
    | 'maxTokens'
  arrayDelimiter?: 'comma' | 'newline'
  jsonSchema?: {
    name?: string
    description?: string
  }
}

interface ParameterSchema {
  provider: string
  base: ParameterDefinition[]
  modelOverrides?: Record<string, ParameterDefinition[]>
}

const CHAT_ONLY: ModelPurpose[] = ['chat']

const markChatOnly = (definitions: ParameterDefinition[]) =>
  definitions.map((definition) => ({
    ...definition,
    roles: definition.roles ?? CHAT_ONLY
  }))

const markRoles = (definitions: ParameterDefinition[], roles: ModelPurpose[]) =>
  definitions.map((definition) => ({
    ...definition,
    roles: definition.roles ?? roles
  }))

const COMMON_PARAMETERS: ParameterDefinition[] = markChatOnly([
  {
    name: 'temperature',
    label: 'Temperature',
    description: 'Lower values make replies more deterministic, higher values add creativity.',
    inputType: 'number',
    min: 0,
    max: 2,
    step: 0.01,
    defaultValue: 0.7,
    standardKey: 'temperature',
    section: 'core',
    order: 10
  },
  {
    name: 'maxTokens',
    label: 'Max output tokens',
    description: 'Hard limit for generated tokens (model specific).',
    inputType: 'integer',
    min: 1,
    standardKey: 'maxTokens',
    section: 'core',
    order: 20
  },
  {
    name: 'topP',
    label: 'Top P',
    description: 'Nucleus sampling. Higher values consider more tokens per step.',
    inputType: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    standardKey: 'topP',
    section: 'core',
    order: 30
  },
  {
    name: 'topK',
    label: 'Top K',
    description: 'Limit candidate tokens per step. Usually leave blank.',
    inputType: 'integer',
    min: 1,
    standardKey: 'topK',
    section: 'core',
    order: 40,
    advanced: true
  },
  {
    name: 'presencePenalty',
    label: 'Presence penalty',
    description: 'Penalize repeating the same ideas. Range -1 to 1.',
    inputType: 'number',
    min: -1,
    max: 1,
    step: 0.01,
    standardKey: 'presencePenalty',
    section: 'core',
    order: 50,
    advanced: true
  },
  {
    name: 'frequencyPenalty',
    label: 'Frequency penalty',
    description: 'Penalize reusing identical tokens. Range -1 to 1.',
    inputType: 'number',
    min: -1,
    max: 1,
    step: 0.01,
    standardKey: 'frequencyPenalty',
    section: 'core',
    order: 60,
    advanced: true
  },
  {
    name: 'stopSequences',
    label: 'Stop sequences',
    description: 'Comma or newline separated list of strings that end the output.',
    inputType: 'string-array',
    arrayDelimiter: 'newline',
    standardKey: 'stopSequences',
    section: 'core',
    order: 70,
    advanced: true
  },
  {
    name: 'seed',
    label: 'Seed',
    description: 'Repeatable randomness when supported by the provider.',
    inputType: 'integer',
    min: 0,
    standardKey: 'seed',
    section: 'core',
    order: 80,
    advanced: true
  },
  {
    name: 'responseFormat',
    label: 'Response format',
    description: 'Force JSON outputs when building structured tools.',
    inputType: 'select',
    options: [
      { label: 'Text', value: 'text' },
      { label: 'JSON object', value: 'json' }
    ],
    section: 'core',
    order: 90,
    advanced: true
  }
])

const VISUAL_PARAMETERS: ParameterDefinition[] = markRoles(
  [
    {
      name: 'n',
      label: 'Images per prompt',
      description: 'How many images to generate per request. Providers cap this (we clamp to the max).',
      inputType: 'integer',
      min: 1,
      max: 10,
      defaultValue: 1,
      section: 'visual',
      order: 10
    },
    {
      name: 'size',
      label: 'Image size',
      description: 'Pixel size for models that use fixed sizes (DALL-E and GPT-Image).',
      inputType: 'select',
      options: [
        { label: '256 × 256', value: '256x256' },
        { label: '512 × 512', value: '512x512' },
        { label: '1024 × 1024', value: '1024x1024' },
        { label: '1024 × 1792', value: '1024x1792' },
        { label: '1792 × 1024', value: '1792x1024' },
        { label: '2048 × 2048', value: '2048x2048' }
      ],
      section: 'visual',
      order: 20,
      onlyModels: ['dall-e-*', 'gpt-image-*']
    },
    {
      name: 'aspectRatio',
      label: 'Aspect ratio',
      description: 'Aspect ratio for models that accept ratios like 16:9.',
      inputType: 'select',
      options: [
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
        { label: '3:2', value: '3:2' },
        { label: '2:3', value: '2:3' },
        { label: '21:9', value: '21:9' },
        { label: '9:21', value: '9:21' },
        { label: '5:4', value: '5:4' },
        { label: '4:5', value: '4:5' }
      ],
      section: 'visual',
      order: 30,
      excludeModels: ['dall-e-*', 'gpt-image-*']
    }
  ],
  ['visual']
)

const AUDIO_PARAMETERS: ParameterDefinition[] = markRoles(
  [
    {
      name: 'voice',
      label: 'Voice',
      description: 'Voice name or ID (provider-specific). OpenAI examples: alloy, echo, fable, onyx, nova, shimmer.',
      inputType: 'text',
      placeholder: 'alloy',
      section: 'audio',
      order: 10
    },
    {
      name: 'language',
      label: 'Language',
      description: 'Language code to use for speech generation when supported (e.g. en, es).',
      inputType: 'text',
      placeholder: 'en',
      section: 'audio',
      order: 20
    },
    {
      name: 'instructions',
      label: 'Voice instructions',
      description: 'Extra guidance for TTS style (supported by OpenAI TTS models).',
      inputType: 'textarea',
      section: 'audio',
      order: 30,
      advanced: true
    }
  ],
  ['audio']
)

const UTILITY_PARAMETERS: ParameterDefinition[] = markRoles(
  [
    {
      name: 'dimensions',
      label: 'Embedding dimensions',
      description: 'Override embedding vector size when the provider supports it.',
      inputType: 'integer',
      min: 1,
      section: 'utility',
      order: 10
    },
    {
      name: 'encodingFormat',
      label: 'Encoding format',
      description: 'Return embeddings as float or base64 when supported.',
      inputType: 'select',
      options: [
        { label: 'Default', value: '' },
        { label: 'Float', value: 'float' },
        { label: 'Base64', value: 'base64' }
      ],
      section: 'utility',
      order: 20,
      advanced: true
    },
    {
      name: 'topN',
      label: 'Top N',
      description: 'Number of items to return for rerankers or classifiers.',
      inputType: 'integer',
      min: 1,
      section: 'utility',
      order: 30
    },
    {
      name: 'scoreThreshold',
      label: 'Score threshold',
      description: 'Minimum score to keep results (provider-specific).',
      inputType: 'number',
      min: 0,
      step: 0.01,
      section: 'utility',
      order: 40,
      advanced: true
    }
  ],
  ['utility']
)

const ROLE_PARAMETERS: ParameterDefinition[] = [
  ...VISUAL_PARAMETERS,
  ...AUDIO_PARAMETERS,
  ...UTILITY_PARAMETERS
]

const OPENAI_BASE: ParameterDefinition[] = markChatOnly([
  {
    name: 'parallelToolCalls',
    label: 'Parallel tool calls',
    description: 'Allow the model to call multiple tools in the same turn.',
    inputType: 'boolean',
    providerOptionKey: 'openai.parallelToolCalls',
    section: 'provider',
    order: 110,
    defaultValue: false
  },
  {
    name: 'maxToolCalls',
    label: 'Max built-in tool calls',
    description: 'Limit total built-in tool calls in a single response.',
    inputType: 'integer',
    min: 1,
    providerOptionKey: 'openai.maxToolCalls',
    section: 'provider',
    order: 115,
    advanced: true
  },
  {
    name: 'store',
    label: 'Store response',
    description: 'Allow OpenAI to store the response for future retrieval.',
    inputType: 'boolean',
    providerOptionKey: 'openai.store',
    section: 'provider',
    order: 118,
    advanced: true,
    defaultValue: false
  },
  {
    name: 'user',
    label: 'User tag',
    description: 'Sent to OpenAI for abuse monitoring (a unique stable identifier).',
    inputType: 'text',
    providerOptionKey: 'openai.user',
    section: 'provider',
    order: 120,
    advanced: true
  },
  {
    name: 'safetyIdentifier',
    label: 'Safety identifier',
    description: 'Stable identifier used for OpenAI safety policy enforcement.',
    inputType: 'text',
    providerOptionKey: 'openai.safetyIdentifier',
    section: 'provider',
    order: 125,
    advanced: true
  },
  {
    name: 'logitBias',
    label: 'Logit bias',
    description: 'JSON map of token IDs to bias adjustments (-100 to 100).',
    inputType: 'json',
    providerOptionKey: 'openai.logitBias',
    helperText: 'Example: {"198": -5, "50256": 20}',
    section: 'provider',
    order: 130,
    advanced: true
  },
  {
    name: 'logprobs',
    label: 'Return log probs',
    description: 'Return log probabilities for generated tokens.',
    inputType: 'text',
    providerOptionKey: 'openai.logprobs',
    helperText: 'Enter true/false or a max count (integer).',
    section: 'provider',
    order: 140,
    advanced: true
  },
  {
    name: 'metadata',
    label: 'Metadata',
    description: 'Additional key-value metadata for OpenAI responses.',
    inputType: 'json',
    providerOptionKey: 'openai.metadata',
    helperText: 'Example: {"team":"support","case":"123"}',
    section: 'provider',
    order: 145,
    advanced: true
  },
  {
    name: 'serviceTier',
    label: 'Service tier',
    description: 'OpenAI Responses API tier for select models.',
    inputType: 'select',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Default', value: 'default' },
      { label: 'Flex', value: 'flex' },
      { label: 'Priority', value: 'priority' }
    ],
    providerOptionKey: 'openai.serviceTier',
    section: 'provider',
    order: 150,
    advanced: true
  },
  {
    name: 'promptCacheKey',
    label: 'Prompt cache key',
    description: 'Manual key for OpenAI prompt caching.',
    inputType: 'text',
    providerOptionKey: 'openai.promptCacheKey',
    section: 'provider',
    order: 155,
    advanced: true
  },
  {
    name: 'promptCacheRetention',
    label: 'Prompt cache retention',
    description: 'Retention policy for OpenAI prompt cache.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'In memory', value: 'in_memory' },
      { label: '24 hours', value: '24h' }
    ],
    providerOptionKey: 'openai.promptCacheRetention',
    section: 'provider',
    order: 160,
    advanced: true
  },
  {
    name: 'systemMessageMode',
    label: 'System message mode',
    description: 'Controls how system messages are sent for reasoning models.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'System', value: 'system' },
      { label: 'Developer', value: 'developer' },
      { label: 'Remove', value: 'remove' }
    ],
    providerOptionKey: 'openai.systemMessageMode',
    section: 'provider',
    order: 165,
    advanced: true
  },
  {
    name: 'strictJsonSchema',
    label: 'Strict JSON schema',
    description: 'Require strict JSON schema validation for structured outputs.',
    inputType: 'boolean',
    providerOptionKey: 'openai.strictJsonSchema',
    section: 'provider',
    order: 170,
    advanced: true,
    defaultValue: false
  },
  {
    name: 'textVerbosity',
    label: 'Text verbosity',
    description: 'Controls how verbose the model response should be.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' }
    ],
    providerOptionKey: 'openai.textVerbosity',
    section: 'provider',
    order: 175,
    advanced: true
  },
  {
    name: 'include',
    label: 'Include extras',
    description: 'Additional payload sections to include in the response.',
    inputType: 'string-array',
    arrayDelimiter: 'newline',
    providerOptionKey: 'openai.include',
    helperText: 'Example: file_search_call.results',
    section: 'provider',
    order: 180,
    advanced: true
  },
  {
    name: 'truncation',
    label: 'Truncation',
    description: 'How to handle inputs that exceed the context window.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Auto', value: 'auto' },
      { label: 'Disabled', value: 'disabled' }
    ],
    providerOptionKey: 'openai.truncation',
    section: 'provider',
    order: 185,
    advanced: true
  },
  {
    name: 'conversation',
    label: 'OpenAI conversation ID',
    description: 'Continue a specific OpenAI conversation (advanced).',
    inputType: 'text',
    providerOptionKey: 'openai.conversation',
    section: 'provider',
    order: 190,
    advanced: true
  },
  {
    name: 'previousResponseId',
    label: 'Previous response ID',
    description: 'Continue from a prior OpenAI response (advanced).',
    inputType: 'text',
    providerOptionKey: 'openai.previousResponseId',
    section: 'provider',
    order: 195,
    advanced: true
  },
  {
    name: 'instructions',
    label: 'OpenAI instructions',
    description: 'Override instructions when continuing a conversation.',
    inputType: 'textarea',
    providerOptionKey: 'openai.instructions',
    section: 'provider',
    order: 200,
    advanced: true
  },
  {
    name: 'reasoningEffort',
    label: 'Reasoning effort',
    description: 'Controls how much reasoning the model performs (reasoning models like gpt-5 and o-series).',
    inputType: 'select',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Minimal', value: 'minimal' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
      { label: 'Extra high', value: 'xhigh' }
    ],
    providerOptionKey: 'openai.reasoningEffort',
    section: 'reasoning',
    order: 10,
    onlyModels: ['gpt-5*', 'o1*', 'o3*', 'o4*']
  },
  {
    name: 'reasoningSummary',
    label: 'Reasoning summary',
    description: 'Enable a model-provided reasoning summary in a separate stream channel.',
    inputType: 'select',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Detailed', value: 'detailed' }
    ],
    providerOptionKey: 'openai.reasoningSummary',
    section: 'reasoning',
    order: 15,
    onlyModels: ['gpt-5*', 'o1*', 'o3*', 'o4*']
  },
  {
    name: 'maxCompletionTokens',
    label: 'Max completion tokens (reasoning)',
    description: 'Overrides OpenAI reasoning token budget.',
    inputType: 'integer',
    min: 1,
    providerOptionKey: 'openai.maxCompletionTokens',
    section: 'reasoning',
    order: 20,
    advanced: true,
    onlyModels: ['gpt-5*', 'o1*', 'o3*', 'o4*']
  },
  {
    name: 'forceReasoning',
    label: 'Force reasoning mode',
    description: 'Treat the model as a reasoning model even if it is not recognized.',
    inputType: 'boolean',
    providerOptionKey: 'openai.forceReasoning',
    section: 'reasoning',
    order: 25,
    advanced: true
  },
  {
    name: 'imageDetail',
    label: 'Vision detail',
    description: 'Controls image detail for multimodal prompts.',
    inputType: 'select',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' }
    ],
    providerOptionKey: 'openai.imageDetail',
    requiresCapability: 'vision',
    section: 'vision',
    order: 10
  },
  {
    name: 'openaiWebSearchTool',
    label: 'Web search tool',
    description: 'Enable OpenAI Responses web search tool.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' }
    ],
    section: 'provider',
    order: 210,
    advanced: true,
    defaultValue: 'false'
  },
  {
    name: 'openaiWebSearchContextSize',
    label: 'Web search context size',
    description: 'Adjust the depth of web search context.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' }
    ],
    section: 'provider',
    order: 215,
    advanced: true
  },
  {
    name: 'openaiWebSearchExternalAccess',
    label: 'Web search external access',
    description: 'Allow the model to access external web sources.',
    inputType: 'boolean',
    section: 'provider',
    order: 220,
    advanced: true,
    defaultValue: false
  },
  {
    name: 'openaiWebSearchUserLocation',
    label: 'Web search user location',
    description: 'JSON location for search results (e.g. {\"type\":\"approximate\",\"city\":\"San Francisco\"}).',
    inputType: 'json',
    section: 'provider',
    order: 225,
    advanced: true
  },
  {
    name: 'openaiFileSearchTool',
    label: 'File search tool',
    description: 'Enable OpenAI file search tool (vector stores required).',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' }
    ],
    section: 'provider',
    order: 230,
    advanced: true,
    defaultValue: 'false'
  },
  {
    name: 'openaiFileSearchVectorStoreIds',
    label: 'File search vector store IDs',
    description: 'Vector store IDs to search against.',
    inputType: 'string-array',
    arrayDelimiter: 'newline',
    section: 'provider',
    order: 235,
    advanced: true
  },
  {
    name: 'openaiFileSearchMaxResults',
    label: 'File search max results',
    description: 'Maximum number of file search results.',
    inputType: 'integer',
    min: 1,
    section: 'provider',
    order: 240,
    advanced: true
  },
  {
    name: 'openaiFileSearchFilters',
    label: 'File search filters',
    description: 'JSON filters for file search.',
    inputType: 'json',
    section: 'provider',
    order: 245,
    advanced: true
  },
  {
    name: 'openaiFileSearchRanking',
    label: 'File search ranking',
    description: 'JSON ranking config (ranker/scoreThreshold).',
    inputType: 'json',
    section: 'provider',
    order: 250,
    advanced: true
  },
  {
    name: 'openaiCodeInterpreterTool',
    label: 'Code interpreter tool',
    description: 'Enable OpenAI code interpreter tool.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' }
    ],
    section: 'provider',
    order: 255,
    advanced: true,
    defaultValue: 'false'
  },
  {
    name: 'openaiCodeInterpreterContainer',
    label: 'Code interpreter container',
    description: 'JSON container ID or {\"fileIds\":[\"file-123\"]}.',
    inputType: 'json',
    section: 'provider',
    order: 260,
    advanced: true
  },
  {
    name: 'openaiImageGenerationTool',
    label: 'Image generation tool',
    description: 'Enable OpenAI image generation tool.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' }
    ],
    section: 'provider',
    order: 265,
    advanced: true,
    defaultValue: 'false'
  }
])

const ANTHROPIC_PARAMETERS: ParameterDefinition[] = markChatOnly([
  {
    name: 'sendReasoning',
    label: 'Send reasoning stream',
    description: 'Forward Claude thinking tokens to the client.',
    inputType: 'boolean',
    providerOptionKey: 'anthropic.sendReasoning',
    section: 'reasoning',
    order: 10
  },
  {
    name: 'thinkingMode',
    label: 'Thinking mode',
    description: 'Enable Claude 3.7 Thinking for longer chains of thought.',
    inputType: 'select',
    options: [
      { label: 'Disabled', value: 'disabled' },
      { label: 'Enabled', value: 'enabled' }
    ],
    providerOptionKey: 'anthropic.thinking.type',
    section: 'reasoning',
    order: 20,
    advanced: true
  },
  {
    name: 'thinkingBudget',
    label: 'Thinking budget tokens',
    description: 'Maximum tokens used when thinking is enabled.',
    inputType: 'integer',
    min: 1,
    providerOptionKey: 'anthropic.thinking.budgetTokens',
    section: 'reasoning',
    order: 30,
    advanced: true
  },
  {
    name: 'disableParallelToolUse',
    label: 'Disable parallel tool use',
    description: 'Force Claude to use one tool at a time.',
    inputType: 'boolean',
    providerOptionKey: 'anthropic.disableParallelToolUse',
    section: 'provider',
    order: 40,
    advanced: true
  },
  {
    name: 'cacheControl',
    label: 'Prompt cache TTL',
    description: 'Enable Anthropic prompt caching for repeated prefixes.',
    inputType: 'select',
    options: [
      { label: 'Off', value: '' },
      { label: '5 minutes', value: '5m' },
      { label: '1 hour', value: '1h' }
    ],
    providerOptionKey: 'anthropic.cacheControl.ttl',
    section: 'provider',
    order: 50,
    helperText: 'Anthropic handles cache slots automatically when enabled.'
  }
])

const GOOGLE_PARAMETERS: ParameterDefinition[] = markChatOnly([
  {
    name: 'safetyThreshold',
    label: 'Safety threshold',
    description: 'Override Gemini’s safety profile when needed.',
    inputType: 'select',
    options: [
      { label: 'Default', value: '' },
      { label: 'Block none', value: 'block_none' },
      { label: 'Block low and above', value: 'block_low_and_above' },
      { label: 'Block medium and above', value: 'block_medium_and_above' },
      { label: 'Block high only', value: 'block_only_high' }
    ],
    providerOptionKey: 'google.safetyThreshold',
    section: 'provider',
    order: 10,
    advanced: true
  },
  {
    name: 'includeThoughts',
    label: 'Include thoughts',
    description: 'Enable Gemini thinking tokens (reasoning stream).',
    inputType: 'boolean',
    providerOptionKey: 'google.thinkingConfig.includeThoughts',
    section: 'reasoning',
    order: 20,
    advanced: true,
    defaultValue: false
  },
  {
    name: 'thinkingBudget',
    label: 'Thinking budget tokens',
    description: 'Maximum tokens allowed for Gemini thinking.',
    inputType: 'integer',
    min: 1,
    providerOptionKey: 'google.thinkingConfig.thinkingBudget',
    section: 'reasoning',
    order: 30,
    advanced: true
  }
])

const GROQ_PARAMETERS: ParameterDefinition[] = markChatOnly([
  {
    name: 'sseThreshold',
    label: 'SSE chunk threshold',
    description: 'Control Groq streaming chunk sizes.',
    inputType: 'integer',
    providerOptionKey: 'groq.sseThreshold',
    section: 'provider',
    order: 10,
    advanced: true
  }
])

const MISTRAL_PARAMETERS: ParameterDefinition[] = markChatOnly([
  {
    name: 'safePrompt',
    label: 'Safe prompt',
    description: 'Let Mistral optimize prompts for safer responses.',
    inputType: 'boolean',
    providerOptionKey: 'mistral.safe_mode',
    section: 'provider',
    order: 10,
    advanced: true
  }
])

export const PARAMETER_SCHEMAS: ParameterSchema[] = [
  {
    provider: 'openai',
    base: [...COMMON_PARAMETERS, ...OPENAI_BASE, ...ROLE_PARAMETERS]
  },
  {
    provider: 'anthropic',
    base: [...COMMON_PARAMETERS, ...ANTHROPIC_PARAMETERS, ...ROLE_PARAMETERS]
  },
  {
    provider: 'google',
    base: [...COMMON_PARAMETERS, ...GOOGLE_PARAMETERS, ...ROLE_PARAMETERS]
  },
  {
    provider: 'mistral',
    base: [...COMMON_PARAMETERS, ...MISTRAL_PARAMETERS, ...ROLE_PARAMETERS]
  },
  {
    provider: 'groq',
    base: [...COMMON_PARAMETERS, ...GROQ_PARAMETERS, ...ROLE_PARAMETERS]
  },
  {
    provider: 'default',
    base: [...COMMON_PARAMETERS, ...ROLE_PARAMETERS]
  }
]

export function getParameterSchema(provider?: string): ParameterSchema {
  const normalized = provider?.toLowerCase() ?? 'default'
  return (
    PARAMETER_SCHEMAS.find((schema) => schema.provider === normalized) ??
    PARAMETER_SCHEMAS.find((schema) => schema.provider === 'default')!
  )
}

export type ParameterRegistry = ReturnType<typeof getParameterSchema>
