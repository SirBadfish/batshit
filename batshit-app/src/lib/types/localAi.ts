export type LocalAiServerId = 'ollama' | 'dmr' | 'lmstudio' | 'llama-cpp' | 'vllm'

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
