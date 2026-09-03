import { describe, expect, it } from 'vitest'
import { LOCAL_AI_SERVER_DEFINITIONS, LOCAL_AI_SERVER_IDS } from './localAiServers'
import { isLocalProviderId } from '$lib/server/services/localImageTransportPolicy'

describe('local AI server definitions smoke', () => {
  it('includes the full expected program set', () => {
    // SA-102 P5 added SGLang and oMLX. oMLX was proven end to end against a
    // real server (0.6.4); SGLang's definition is built from its published API
    // and is NOT yet proven live (DL-102-07 open — needs the PC 4090 lane), so
    // do not let this comment drift into claiming it was.
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

  /**
   * SA-102 P6 regression: every consumer that asks "is this a local program?"
   * must DERIVE the answer from these definitions.
   *
   * Two copies had been hand-written as a five-id set and were never updated
   * when SA-102 grew the list to seven, so `sglang` and `omlx` classified as
   * CLOUD — no local image-URL rewriting through `imageBaseUrl`, the non-local
   * branch of `shouldEnableTools`, and a preset-picker availability chip that
   * could mis-label them. Neither was caught by a type error, because both were
   * plain string sets. This is the assertion that catches the next one.
   */
  it('the image-transport classifier recognises every defined program', () => {
    for (const server of LOCAL_AI_SERVER_DEFINITIONS) {
      expect(isLocalProviderId(server.id), `${server.id} is not classified as local`).toBe(true)
    }
    for (const cloud of ['openai', 'anthropic', 'google', 'openrouter', 'vercel-gateway']) {
      expect(isLocalProviderId(cloud), cloud).toBe(false)
    }
  })

  it('exposes the id set as a shared reference so classifiers cannot drift', () => {
    // `modelPresetAvailability.ts` keeps its copy module-private and exports no
    // classifier of its own, so it cannot be asserted directly here. What CAN be
    // pinned is the shape both consumers depend on: one exported set, derived
    // from the definitions, with an entry per program.
    expect(LOCAL_AI_SERVER_IDS.size).toBe(LOCAL_AI_SERVER_DEFINITIONS.length)
    for (const server of LOCAL_AI_SERVER_DEFINITIONS) {
      expect(LOCAL_AI_SERVER_IDS.has(server.id), server.id).toBe(true)
    }
  })
})
