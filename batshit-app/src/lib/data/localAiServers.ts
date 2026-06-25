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
      modelList: true
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
      modelList: true
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
      richMetadata: true
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
      modelList: true
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
      modelList: true
    }
  }
]

export const LOCAL_AI_SERVER_IDS = new Set<LocalAiServerId>(
  LOCAL_AI_SERVER_DEFINITIONS.map((server) => server.id)
)
