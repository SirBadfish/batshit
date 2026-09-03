import { describe, expect, it } from 'vitest'
import { LOCAL_AI_SERVER_DEFINITIONS, LOCAL_AI_SERVER_IDS } from './localAiServers'

describe('local AI server definitions smoke', () => {
  it('includes the full expected program set', () => {
    // SA-102 P5 (DL-102-07) added SGLang and oMLX, each proven against a real
    // running server of that kind before shipping.
    expect(Array.from(LOCAL_AI_SERVER_IDS).sort()).toEqual([
      'dmr',
      'llama-cpp',
      'lmstudio',
      'ollama',
      'omlx',
      'sglang',
      'vllm'
    ])
    expect(LOCAL_AI_SERVER_DEFINITIONS).toHaveLength(7)
  })

  it('has valid defaults required by Local AI settings/runtime routing', () => {
    for (const server of LOCAL_AI_SERVER_DEFINITIONS) {
      expect(server.defaultBaseUrl.startsWith('http://')).toBe(true)
      expect(server.openaiPath.startsWith('/')).toBe(true)
      expect(server.defaultImageTransport).toBe('auto')
      expect(server.defaultImageBaseUrl.startsWith('http://')).toBe(true)
      expect(server.supports.modelList).toBe(true)
    }
  })
})
