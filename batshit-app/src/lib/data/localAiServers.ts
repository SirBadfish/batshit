import type { LocalAiServerDefinition, LocalAiServerId } from '$lib/types/localAi'

export const LOCAL_AI_SERVER_DEFINITIONS: LocalAiServerDefinition[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local model manager with OpenAI-compatible chat endpoints.',
    defaultBaseUrl: 'http://localhost:11434',
    openaiPath: '/v1',
    enabledByDefault: true,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://localhost:5600',
    supports: {
      management: true,
      modelList: true,
      promptCacheReporting: 'never-reports'
    }
  },
  {
    id: 'dmr',
    label: 'Docker Model Runner',
    description: 'Docker Desktop local runtime (llama.cpp) with OpenAI-compatible API.',
    defaultBaseUrl: 'http://localhost:12434',
    openaiPath: '/engines/llama.cpp/v1',
    enabledByDefault: true,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://host.docker.internal:5600',
    supports: {
      management: true,
      modelList: true,
      promptCacheReporting: 'reports'
    }
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: 'LM Studio local server with OpenAI-compatible API and metadata.',
    defaultBaseUrl: 'http://localhost:1234',
    openaiPath: '/v1',
    enabledByDefault: false,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://localhost:5600',
    supports: {
      management: false,
      modelList: true,
      richMetadata: true,
      promptCacheReporting: 'never-reports'
    }
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp',
    description: 'llama-server OpenAI-compatible API endpoint.',
    defaultBaseUrl: 'http://localhost:8080',
    openaiPath: '/v1',
    enabledByDefault: false,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://localhost:5600',
    supports: {
      management: false,
      modelList: true,
      promptCacheReporting: 'reports'
    }
  },
  {
    id: 'vllm',
    label: 'vLLM',
    description: 'vLLM OpenAI-compatible server endpoint.',
    defaultBaseUrl: 'http://localhost:8000',
    openaiPath: '/v1',
    enabledByDefault: false,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://localhost:5600',
    supports: {
      management: false,
      modelList: true,
      // v0.28 reports counts with --enable-prompt-tokens-details. Older
      // versions or servers without that flag can omit them per response.
      promptCacheReporting: 'reports'
    }
  }
  ,
  {
    id: 'sglang',
    label: 'SGLang',
    description: 'SGLang OpenAI-compatible server. The GPU-server option, cross-platform.',
    defaultBaseUrl: 'http://localhost:30000',
    openaiPath: '/v1',
    enabledByDefault: false,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://localhost:5600',
    supports: {
      management: false,
      modelList: true,
      // --enable-cache-report exposes prompt_tokens_details.cached_tokens;
      // servers without that flag omit the count even when their cache works.
      promptCacheReporting: 'reports'
    }
  },
  {
    id: 'omlx',
    label: 'oMLX',
    description: 'Apple Silicon MLX server with a tiered memory and SSD prompt cache.',
    // Shares vLLM's default port. DL-102-10: Batshit warns and points at the
    // fix rather than blocking, because both accept any port.
    defaultBaseUrl: 'http://localhost:8000',
    openaiPath: '/v1',
    enabledByDefault: false,
    defaultImageTransport: 'auto',
    defaultImageBaseUrl: 'http://localhost:5600',
    supports: {
      management: false,
      modelList: true,
      // Measured live 2026-09-02: 8,192 of 9,274 tokens credited on a warm
      // 9k-token prompt, 134.6s -> 18.6s. Caches in 4,096-token blocks, so a
      // short conversation honestly reports zero until it grows past one block.
      promptCacheReporting: 'reports'
    }
  }
]

export const LOCAL_AI_SERVER_IDS = new Set<LocalAiServerId>(
  LOCAL_AI_SERVER_DEFINITIONS.map((server) => server.id)
)

/**
 * SA-102 P2/P3: the `providerOptions` segment a local runtime's settings travel
 * under on the `@ai-sdk/openai-compatible` transport.
 *
 * That provider reads both `providerOptions[name]` and
 * `providerOptions[camelCase(name)]`, but marks the raw hyphenated form
 * DEPRECATED (measured on 3.0.43: `Deprecated: "providerOptions key
 * 'llama-cpp'". Use 'llamaCpp' instead.`). `llama-cpp` is Batshit's only
 * hyphenated runtime id.
 *
 * Lives here, in the data module both the mapper and the parameter schemas can
 * import, so the two can never disagree about where a local sampler is routed.
 */
export function resolveLocalProviderOptionsSegment(runtimeId: string): string {
  return runtimeId.replace(/[-_]+([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

/**
 * Local program reporting capability, not evidence for an individual response.
 * `null` identifies non-local lanes, which the local usage guard never changes.
 */
export function resolveLocalPromptCacheReporting(
  providerId: string | null | undefined
): 'reports' | 'never-reports' | null {
  const normalized = providerId?.trim().toLowerCase()
  if (!normalized) return null
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === normalized)
  return definition?.supports.promptCacheReporting ?? null
}
