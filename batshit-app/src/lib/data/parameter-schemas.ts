import type { ModelCapabilities, ModelPurpose } from '$lib/types/savedModels'
import type { LocalAiServerId } from '$lib/types/localAi'
import {
  LOCAL_AI_SERVER_DEFINITIONS,
  resolveLocalProviderOptionsSegment
} from '$lib/data/localAiServers'

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
  /**
   * SA-102 follow-up: this is a THREE-state control — not set / on / off —
   * rendered with the same select the OpenAI tool toggles already use, and
   * parsed back into a real boolean by `fromInputValue`.
   *
   * A plain `inputType: 'boolean'` cannot express "not set": its toggle is
   * either on or off, which is why these five carried `defaultValue: false`
   * and why merely opening a model's settings wrote that `false` into the
   * preset and then sent it. `parallel_tool_calls: false` in particular
   * overrides OpenAI's own default of `true`.
   */
  booleanTriState?: true
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

/**
 * The three-state option set. `''` means "leave this out of the request", which
 * is the only honest default for a provider flag Batshit has no opinion about.
 */
const BOOLEAN_TRI_STATE_OPTIONS = [
  { label: 'Default', value: '' },
  { label: 'Enabled', value: 'true' },
  { label: 'Disabled', value: 'false' }
]

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
    // SA-102 P1 (DL-102-01): deliberately no defaultValue. Temperature used to
    // be the ONLY chat sampler carrying one, which is why it was the only field
    // that refused to stay blank — the UI re-seeded it from here on every pass.
    // Blank must mean "do not send" so the model's own default applies.
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
    description:
      "Allow the model to call multiple tools in the same turn. Leave on Default to use OpenAI's own setting, which is on.",
    inputType: 'select',
    booleanTriState: true,
    options: BOOLEAN_TRI_STATE_OPTIONS,
    providerOptionKey: 'openai.parallelToolCalls',
    section: 'provider',
    order: 110
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
    inputType: 'select',
    booleanTriState: true,
    options: BOOLEAN_TRI_STATE_OPTIONS,
    providerOptionKey: 'openai.store',
    section: 'provider',
    order: 118,
    advanced: true
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
    inputType: 'select',
    booleanTriState: true,
    options: BOOLEAN_TRI_STATE_OPTIONS,
    providerOptionKey: 'openai.strictJsonSchema',
    section: 'provider',
    order: 170,
    advanced: true
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
    inputType: 'select',
    booleanTriState: true,
    options: BOOLEAN_TRI_STATE_OPTIONS,
    section: 'provider',
    order: 220,
    advanced: true
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
    inputType: 'select',
    booleanTriState: true,
    options: BOOLEAN_TRI_STATE_OPTIONS,
    providerOptionKey: 'google.thinkingConfig.includeThoughts',
    section: 'reasoning',
    order: 20,
    advanced: true
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

// ---------------------------------------------------------------------------
// SA-102 P3 (DL-102-03): per-runtime parameter schemas for local AI programs.
//
// Before SA-102 all five local runtimes fell through to the `default` schema —
// an OpenAI-shaped list handed to engines that are not OpenAI. That is how Top K
// came to be offered in the UI and then dropped by the SDK before the request
// left, and why `min_p` and the repetition controls local model authors actually
// recommend had no field at all.
//
// DL-102-03: a runtime is offered ONLY what it accepts, and nothing it accepts
// is hidden. The table below is one library plus a per-runtime allow list, not
// seven hand-written copies, so adding a runtime is one row.
//
// Every "yes" was measured on 2026-09-02 against a live server unless the row
// says otherwise. Method: pin temperature at 2 so the model is visibly random,
// add ONE limiter at an extreme value, and see whether repeated sends collapse
// to a single answer. A control (`top_p: 0.01`) confirmed the method on each
// engine.
//
//   LM Studio 0.4.23, MLX engine, qwen/qwen3.8-27b
//     top_k 1        -> three identical      HONOURED
//     min_p 0.9      -> three identical      HONOURED
//     repeat_penalty 3 -> output mangled     HONOURED
//     repetition_penalty 3 -> unchanged      IGNORED (wrong spelling here)
//     typical_p 0.05 -> still varied         IGNORED
//     mirostat 2     -> still varied         IGNORED
//     ttl 3600       -> accepted             HONOURED (documented since 0.3.9)
//
//   llama.cpp engine, via Docker Model Runner, ai/smollm2
//     top_k 1          -> identical          HONOURED
//     min_p 0.95       -> identical          HONOURED
//     typical_p 0.001  -> identical          HONOURED (0.05 was too loose to show)
//     mirostat 2       -> identical          HONOURED
//     xtc_probability 1 -> identical, and different text  HONOURED
//     repeat_penalty 5 + repeat_last_n 256 -> mangled     HONOURED
//     dry_multiplier 5 -> unchanged on a prompt with no repeated n-grams,
//                         which is what DRY is defined to leave alone.
//                         Documented by llama.cpp; not disproved.
//
//   Ollama 0.33.2 /v1, llama3.2
//     top_k 1        -> still varied         IGNORED (silently, like every
//                                            unknown field on this endpoint)
//     top_p 0.01     -> identical            control passes
//   DL-102-15: Ollama therefore gets ONLY its documented /v1 set. The samplers
//   it can genuinely use live in a Modelfile, and the preset editor says so
//   with the exact commands.
// ---------------------------------------------------------------------------

/** One local sampler, defined once and shared by every runtime that accepts it. */
type LocalSamplerDefinition = Omit<ParameterDefinition, 'providerOptionKey' | 'roles'> & {
  /**
   * The key this value travels under inside `providerOptions[<runtime>]`.
   *
   * Usually the literal wire field name, because
   * `@ai-sdk/openai-compatible` spreads that object into the request body
   * verbatim. FOUR keys are the exception — `user`, `reasoningEffort`,
   * `textVerbosity` and `strictJsonSchema` are owned by that provider's own
   * options schema, and it assigns them AFTER the spread. Measured on 3.0.43:
   *
   *   providerOptions.lmstudio.reasoning_effort = 'none'  ->  body has NEITHER key
   *   providerOptions.lmstudio.reasoningEffort  = 'none'  ->  body has reasoning_effort: 'none'
   *
   * The snake_case form is not merely ignored, it is ERASED: the explicit
   * `reasoning_effort: compatibleOptions.reasoningEffort ?? …` assignment
   * overwrites the spread value with `undefined`. For those four, use the
   * provider's option name here, not the wire name.
   */
  wireName: string
}

/**
 * Keys `@ai-sdk/openai-compatible` owns in its own options schema. A local
 * sampler that needs one of these must route under the camelCase option name.
 */
export const OPENAI_COMPATIBLE_OWNED_OPTION_KEYS = [
  'user',
  'reasoningEffort',
  'textVerbosity',
  'strictJsonSchema'
] as const

const LOCAL_SAMPLER_LIBRARY = {
  topK: {
    name: 'topK',
    label: 'Top K',
    description: 'Only consider the K most likely next words. 1 makes the model fully predictable.',
    inputType: 'integer',
    min: 0,
    section: 'core',
    order: 40,
    advanced: true,
    wireName: 'top_k'
  },
  minP: {
    name: 'minP',
    label: 'Min P',
    description:
      'Drop any word less likely than this fraction of the best word. A common alternative to Top P for local models.',
    inputType: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    section: 'core',
    order: 45,
    advanced: true,
    wireName: 'min_p'
  },
  repeatPenalty: {
    name: 'repeatPenalty',
    label: 'Repeat penalty',
    description: 'Discourage reusing recent words. 1 is off. Above about 1.3 the text starts to break.',
    inputType: 'number',
    min: 0,
    max: 3,
    step: 0.01,
    section: 'core',
    order: 62,
    advanced: true,
    wireName: 'repeat_penalty'
  },
  repetitionPenalty: {
    name: 'repetitionPenalty',
    label: 'Repetition penalty',
    description: 'Discourage reusing recent words. 1 is off. Same idea as Repeat penalty, different spelling on this program.',
    inputType: 'number',
    min: 0,
    max: 3,
    step: 0.01,
    section: 'core',
    order: 62,
    advanced: true,
    wireName: 'repetition_penalty'
  },
  repeatLastN: {
    name: 'repeatLastN',
    label: 'Repeat window',
    description: 'How many recent words the repeat penalty looks back over.',
    inputType: 'integer',
    min: 0,
    section: 'core',
    order: 64,
    advanced: true,
    wireName: 'repeat_last_n'
  },
  repetitionContextSize: {
    name: 'repetitionContextSize',
    label: 'Repetition window',
    description: 'How many recent words the repetition penalty looks back over.',
    inputType: 'integer',
    min: 0,
    section: 'core',
    order: 64,
    advanced: true,
    wireName: 'repetition_context_size'
  },
  typicalP: {
    name: 'typicalP',
    label: 'Typical P',
    description: 'Prefer words that are averagely surprising rather than simply most likely. 1 is off.',
    inputType: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    section: 'core',
    order: 46,
    advanced: true,
    wireName: 'typical_p'
  },
  dryMultiplier: {
    name: 'dryMultiplier',
    label: 'DRY strength',
    description: 'Penalize repeating whole phrases, not just single words. 0 is off.',
    inputType: 'number',
    min: 0,
    step: 0.01,
    section: 'core',
    order: 66,
    advanced: true,
    wireName: 'dry_multiplier'
  },
  dryBase: {
    name: 'dryBase',
    label: 'DRY base',
    description: 'How sharply the DRY penalty grows with the length of a repeated phrase.',
    inputType: 'number',
    min: 0,
    step: 0.01,
    section: 'core',
    order: 67,
    advanced: true,
    wireName: 'dry_base'
  },
  dryAllowedLength: {
    name: 'dryAllowedLength',
    label: 'DRY allowed length',
    description: 'How long a repeated phrase may be before the DRY penalty starts.',
    inputType: 'integer',
    min: 0,
    section: 'core',
    order: 68,
    advanced: true,
    wireName: 'dry_allowed_length'
  },
  xtcProbability: {
    name: 'xtcProbability',
    label: 'XTC probability',
    description: 'How often to drop the single most obvious word, to make writing less predictable. 0 is off.',
    inputType: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    section: 'core',
    order: 70,
    advanced: true,
    wireName: 'xtc_probability'
  },
  xtcThreshold: {
    name: 'xtcThreshold',
    label: 'XTC threshold',
    description: 'Only drop words this likely or better when XTC fires.',
    inputType: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    section: 'core',
    order: 71,
    advanced: true,
    wireName: 'xtc_threshold'
  },
  mirostat: {
    name: 'mirostat',
    label: 'Mirostat',
    description: 'Steer toward a target level of surprise instead of using Top P or Top K. 0 is off, 1 and 2 are the two versions.',
    inputType: 'integer',
    min: 0,
    max: 2,
    section: 'core',
    order: 74,
    advanced: true,
    wireName: 'mirostat'
  },
  mirostatTau: {
    name: 'mirostatTau',
    label: 'Mirostat target',
    description: 'The level of surprise Mirostat aims for. Lower is more focused.',
    inputType: 'number',
    min: 0,
    step: 0.01,
    section: 'core',
    order: 75,
    advanced: true,
    wireName: 'mirostat_tau'
  },
  mirostatEta: {
    name: 'mirostatEta',
    label: 'Mirostat rate',
    description: 'How quickly Mirostat corrects itself.',
    inputType: 'number',
    min: 0,
    step: 0.01,
    section: 'core',
    order: 76,
    advanced: true,
    wireName: 'mirostat_eta'
  },
  localTtl: {
    name: 'localTtl',
    label: 'Auto unload after',
    description: 'Seconds of idleness before the program unloads this model and frees the memory. Leave blank to keep it loaded.',
    inputType: 'integer',
    min: 1,
    section: 'provider',
    order: 200,
    advanced: true,
    wireName: 'ttl'
  },
  localReasoningEffort: {
    name: 'localReasoningEffort',
    label: 'Thinking effort',
    description:
      'How much the model thinks before answering. "None" turns thinking off entirely.',
    inputType: 'select',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Minimal', value: 'minimal' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
      { label: 'Extra high', value: 'xhigh' }
    ],
    section: 'reasoning',
    order: 210,
    // Owned option key, NOT the wire name — see LocalSamplerDefinition.
    wireName: 'reasoningEffort'
  },
  ollamaReasoningEffort: {
    name: 'localReasoningEffort',
    label: 'Thinking effort',
    description:
      'How much the model thinks before answering. Only for models that can think; Ollama rejects the whole request otherwise.',
    inputType: 'select',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' }
    ],
    // Measured 2026-09-02: Ollama does not ignore this field on a model that
    // cannot think — it FAILS the send with
    //   "llama3.2:latest" does not support thinking
    // so the field is gated on the preset's Reasoning capability rather than
    // offered to every Ollama model. Only `none` is safe on any model.
    requiresCapability: 'reasoning',
    section: 'reasoning',
    order: 210,
    // Owned option key, NOT the wire name — see LocalSamplerDefinition.
    wireName: 'reasoningEffort'
  },
  chatTemplateKwargs: {
    name: 'chatTemplateKwargs',
    label: 'Chat template options',
    description:
      'Extra options passed to the model\'s chat template, as JSON. The usual one is {"enable_thinking": false}.',
    inputType: 'json',
    placeholder: '{"enable_thinking": false}',
    section: 'provider',
    order: 220,
    advanced: true,
    wireName: 'chat_template_kwargs'
  }
} as const satisfies Record<string, LocalSamplerDefinition>

type LocalSamplerKey = keyof typeof LOCAL_SAMPLER_LIBRARY

/**
 * Which samplers each program accepts. See the measurement block above; a key is
 * present only where the program demonstrably applies it.
 */
const LOCAL_RUNTIME_SAMPLERS: Record<LocalAiServerId, readonly LocalSamplerKey[]> = {
  // DL-102-15: Ollama's /v1 accepts the smallest set of any program and ignores
  // unknown fields without a word, so offering more would be a lie. Everything
  // else it can do lives in a Modelfile.
  ollama: ['ollamaReasoningEffort'],
  // Docker Model Runner is the llama.cpp engine behind /engines/llama.cpp/v1.
  dmr: [
    'topK',
    'minP',
    'typicalP',
    'repeatPenalty',
    'repeatLastN',
    'dryMultiplier',
    'dryBase',
    'dryAllowedLength',
    'xtcProbability',
    'xtcThreshold',
    'mirostat',
    'mirostatTau',
    'mirostatEta'
  ],
  lmstudio: ['topK', 'minP', 'repeatPenalty', 'localTtl', 'localReasoningEffort'],
  'llama-cpp': [
    'topK',
    'minP',
    'typicalP',
    'repeatPenalty',
    'repeatLastN',
    'dryMultiplier',
    'dryBase',
    'dryAllowedLength',
    'xtcProbability',
    'xtcThreshold',
    'mirostat',
    'mirostatTau',
    'mirostatEta'
  ],
  vllm: ['topK', 'minP', 'repetitionPenalty', 'chatTemplateKwargs'],
  // SGLang's own protocol.py lists temperature, top_p, top_k, min_p,
  // frequency/presence penalty, repetition_penalty, stop, stop_token_ids,
  // min_new_tokens, ignore_eos, structured output, separate_reasoning, and
  // chat_template_kwargs (read on `main`, 2026-09-02).
  sglang: ['topK', 'minP', 'repetitionPenalty', 'chatTemplateKwargs'],
  // oMLX's per-model settings API (`PUT /admin/api/models/{id}/settings`) is the
  // documentary cross-check for the request-level set, and request-level
  // top_k / min_p / repetition_penalty were observed to change greedy output on
  // Josh's server (2026-09-02).
  omlx: [
    'topK',
    'minP',
    'repetitionPenalty',
    'repetitionContextSize',
    'chatTemplateKwargs'
  ]
}

/**
 * The generic `topK` in COMMON_PARAMETERS carries `standardKey: 'topK'`, and BOTH
 * AI SDK providers drop that argument before the request leaves. Every local
 * schema therefore replaces it by name with a `providerOptionKey` version that
 * travels in the request body as `top_k`. Name-based dedup means a value a user
 * already saved under `topK` keeps working.
 */
function buildLocalRuntimeParameters(runtimeId: LocalAiServerId): ParameterDefinition[] {
  const segment = resolveLocalProviderOptionsSegment(runtimeId)
  return LOCAL_RUNTIME_SAMPLERS[runtimeId].map((key) => {
    const { wireName, ...definition } = LOCAL_SAMPLER_LIBRARY[key]
    return {
      ...definition,
      roles: CHAT_ONLY,
      providerOptionKey: `${segment}.${wireName}`
    } as ParameterDefinition
  })
}

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
  },
  // SA-102 P3: one schema per local program, generated from the runtime
  // definition list so a runtime added there cannot be forgotten here.
  ...LOCAL_AI_SERVER_DEFINITIONS.map((definition) => ({
    provider: definition.id,
    base: [
      ...COMMON_PARAMETERS,
      ...buildLocalRuntimeParameters(definition.id),
      ...ROLE_PARAMETERS
    ]
  }))
]

/**
 * SA-102 P2: every parameter name Batshit defines anywhere, across every
 * provider schema and every model override.
 *
 * The settings bag handed to `buildRuntimeModelSettings` is the AGENT's
 * `provider_specific_settings` merged with the PRESET's `settings`, so it
 * carries defined parameters that this model's filter deliberately excluded
 * alongside genuine user-authored Custom Parameters. Before SA-102 the strict
 * OpenAI provider validated `providerOptions.openai` against a closed schema
 * and silently dropped the excluded ones; `@ai-sdk/openai-compatible` passes
 * providerOptions through verbatim, so they would now reach a local engine.
 * A parameter Batshit knows about but did not offer for this model is a
 * decision, and must not be smuggled through the Custom Parameter lane.
 */
export const ALL_DEFINED_PARAMETER_NAMES: ReadonlySet<string> = new Set(
  PARAMETER_SCHEMAS.flatMap((schema) => [
    ...schema.base.map((definition) => definition.name),
    ...Object.values(schema.modelOverrides ?? {}).flatMap((definitions) =>
      definitions.map((definition) => definition.name)
    )
  ]).concat(
    VISUAL_PARAMETERS.map((definition) => definition.name),
    AUDIO_PARAMETERS.map((definition) => definition.name),
    UTILITY_PARAMETERS.map((definition) => definition.name)
  )
)

export function getParameterSchema(provider?: string): ParameterSchema {
  const normalized = provider?.toLowerCase() ?? 'default'
  return (
    PARAMETER_SCHEMAS.find((schema) => schema.provider === normalized) ??
    PARAMETER_SCHEMAS.find((schema) => schema.provider === 'default')!
  )
}

export type ParameterRegistry = ReturnType<typeof getParameterSchema>
