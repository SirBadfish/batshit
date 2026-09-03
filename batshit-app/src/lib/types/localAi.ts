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
     * SA-102 P4 (DL-102-13): does this program put cached prompt tokens in
     * `usage`?
     *
     * This has to be a property of the PROGRAM, not a reading of the number,
     * because `@ai-sdk/openai-compatible` defaults an absent
     * `prompt_tokens_details.cached_tokens` to **0**. Without this flag Batshit
     * cannot tell "the cache missed" from "this program never says", and it was
     * showing a confident zero for both. Measured live 2026-09-02:
     *
     *   llama.cpp            yes  (0 -> 3019 through Docker Model Runner)
     *   Docker Model Runner  yes  (same engine, measured directly)
     *   oMLX                 yes  (8192 of 9274 on a warm 9k prompt)
     *   SGLang               yes  (UsageInfo.prompt_tokens_details in protocol.py)
     *   Ollama               no   (27s -> 0.05s with identical prompt_tokens)
     *   vLLM                 no   (open upstream bug vllm#44961)
     *   LM Studio            no   on /v1/chat/completions (51.6s -> 2.2s, no
     *                             prompt_tokens_details at all); yes on
     *                             /v1/responses, which Batshit does not use.
     *
     * A `no` here does NOT mean the cache is off. Every one of these programs
     * caches by default; only the counter is missing.
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
