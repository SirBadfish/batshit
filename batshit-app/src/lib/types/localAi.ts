export type LocalAiServerId =
  | 'ollama'
  | 'dmr'
  | 'lmstudio'
  | 'llama-cpp'
  | 'vllm'
  // SA-102 P5 (DL-102-07): added last, each proven against a real running server.
  | 'sglang'
  | 'omlx'

export type LocalAiImageTransport = 'auto' | 'url'

export type LocalAiServerDefinition = {
  id: LocalAiServerId
  label: string
  description: string
  defaultBaseUrl: string
  openaiPath: string
  enabledByDefault: boolean
  defaultImageTransport: LocalAiImageTransport
  defaultImageBaseUrl: string
  supports: {
    management: boolean
    modelList: boolean
    richMetadata?: boolean
    /**
     * Known reporting capability on the chat endpoint. Versions and startup
     * flags can change individual responses: SGLang needs --enable-cache-report
     * and vLLM needs --enable-prompt-tokens-details. This is never permission to
     * trust the SDK's default zero or discard a count a program actually sent.
     * SA-102 (DL-102-13) uses step.usage.raw to distinguish a reported zero from
     * an absent count. Missing telemetry says nothing about whether cache ran.
     */
    promptCacheReporting: 'reports' | 'never-reports'
  }
}

export type LocalAiServerRecord = {
  id: LocalAiServerId
  baseUrl: string
  openaiPath: string
  enabled: boolean
  imageTransport?: LocalAiImageTransport
  imageBaseUrl?: string
  createdAt: string
  updatedAt: string
}

export type LocalAiServerSummary = LocalAiServerDefinition & {
  baseUrl: string
  openaiPath: string
  enabled: boolean
  imageTransport: LocalAiImageTransport
  imageBaseUrl: string
  createdAt?: string
  updatedAt?: string
  source: 'default' | 'stored'
}

export type LocalAiServerUpdate = {
  id: LocalAiServerId
  baseUrl: string
  openaiPath?: string
  enabled?: boolean
  imageTransport?: LocalAiImageTransport
  imageBaseUrl?: string
}
