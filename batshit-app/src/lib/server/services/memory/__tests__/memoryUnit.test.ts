import { describe, expect, it } from 'vitest'
import {
  BUILTIN_EMBEDDING_MODELS,
  DEFAULT_MEMORY_EMBEDDING_CONFIG,
  canonicalEmbeddingModelId,
  createMemoryEmbedder,
  resolvePresetEmbeddingTarget,
  suggestEmbeddingPrefixes
} from '../memoryEmbedder'
import { escapeTagValue, sanitizeTextQuery } from '../memoryIndex'
import {
  memoryKey,
  memoryAgentPattern,
  memorySegmentKey,
  memoryIndexName,
  memorySegmentIndexName
} from '../memoryKeys'

describe('memory embedder registry', () => {
  it('defaults to the builtin embeddinggemma model', () => {
    expect(DEFAULT_MEMORY_EMBEDDING_CONFIG).toEqual({
      lane: 'builtin',
      modelId: 'builtin:embeddinggemma-300m'
    })
    expect(canonicalEmbeddingModelId(DEFAULT_MEMORY_EMBEDDING_CONFIG)).toBe(
      'builtin:embeddinggemma-300m@768'
    )
  })

  it('carries the documented per-model task prefixes (P0 hard finding)', () => {
    const gemma = BUILTIN_EMBEDDING_MODELS.find((spec) => spec.id === 'builtin:embeddinggemma-300m')
    expect(gemma).toBeDefined()
    expect(gemma?.documentTemplate('Maggie is an Irish Setter')).toBe(
      'title: none | text: Maggie is an Irish Setter'
    )
    expect(gemma?.queryTemplate('what dog does Josh have')).toBe(
      'task: search result | query: what dog does Josh have'
    )

    const minilm = BUILTIN_EMBEDDING_MODELS.find((spec) => spec.id === 'builtin:all-minilm-l6-v2')
    expect(minilm?.documentTemplate('plain')).toBe('plain')
    expect(minilm?.queryTemplate('plain')).toBe('plain')
  })

  it('rejects unknown builtin models loudly', () => {
    expect(() =>
      createMemoryEmbedder({ lane: 'builtin', modelId: 'builtin:not-a-model' })
    ).toThrow(/Unknown builtin memory embedding model/)
  })

  it('requires complete local-ai configuration', () => {
    expect(() =>
      createMemoryEmbedder({ lane: 'local-ai', modelId: 'local-ai:x' })
    ).toThrow(/requires localAi\.baseUrl/)
  })

  it('api lane (P5): constructs, requires complete config, and fails loudly without a key', async () => {
    // Incomplete config still refuses at construction.
    expect(() =>
      createMemoryEmbedder({ lane: 'api', modelId: 'api:openai:text-embedding-3-small' })
    ).toThrow(/requires api\.provider/)

    // Complete config constructs; the key resolves lazily at first embed.
    const embedder = createMemoryEmbedder({
      lane: 'api',
      modelId: 'api:openai:text-embedding-3-small',
      api: { provider: 'openai', modelName: 'text-embedding-3-small', dims: 1536 }
    })
    expect(embedder.modelId).toBe('api:openai:text-embedding-3-small@1536')
    expect(embedder.dims).toBe(1536)

    // An unsupported provider errors loudly at use, naming the v1 support list.
    const unsupported = createMemoryEmbedder({
      lane: 'api',
      modelId: 'api:google:text-embedding-004',
      api: { provider: 'google', modelName: 'text-embedding-004', dims: 768 }
    })
    await expect(unsupported.embedQuery('x')).rejects.toThrow(/supports provider\(s\) openai/)
  })

  it('builds canonical ids for every lane', () => {
    expect(
      canonicalEmbeddingModelId({
        lane: 'local-ai',
        modelId: 'local-ai:nomic-embed-text',
        localAi: { baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'nomic-embed-text', dims: 768 }
      })
    ).toBe('local-ai:nomic-embed-text@768')
    expect(
      canonicalEmbeddingModelId({
        lane: 'api',
        modelId: 'api:openai:text-embedding-3-small',
        api: { provider: 'openai', modelName: 'text-embedding-3-small', dims: 1536 }
      })
    ).toBe('api:openai:text-embedding-3-small@1536')
    expect(
      canonicalEmbeddingModelId({
        lane: 'preset',
        modelId: 'preset:openai:text-embedding-3-small',
        preset: {
          presetId: 'preset_1',
          provider: 'openai',
          modelName: 'text-embedding-3-small',
          dims: 1536
        }
      })
    ).toBe('preset:openai:text-embedding-3-small@1536')
    expect(() =>
      canonicalEmbeddingModelId({ lane: 'preset', modelId: 'preset:x' })
    ).toThrow(/requires preset\.presetId/)
  })
})

describe('preset embedding lane (2026-08-26)', () => {
  const SNAPSHOT = { provider: 'openai', modelName: 'text-embedding-3-small' }
  const OPENAI_PRESET = {
    id: 'preset_1',
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    connection: { type: 'direct' }
  }

  it('suggests known per-model prefixes and stays quiet for unknown models', () => {
    expect(suggestEmbeddingPrefixes('nomic-embed-text')).toEqual({
      documentPrefix: 'search_document: ',
      queryPrefix: 'search_query: '
    })
    expect(suggestEmbeddingPrefixes('text-embedding-3-small')).toBeNull()
  })

  it('routes cloud providers with saved keys, and names Settings → API Keys when the key is missing', () => {
    const target = resolvePresetEmbeddingTarget({
      presetId: 'preset_1',
      snapshot: SNAPSHOT,
      preset: OPENAI_PRESET,
      localAiServers: [],
      apiKeys: { openai: 'sk-test' }
    })
    expect(target).toEqual({
      kind: 'openai-compatible',
      apiKey: 'sk-test',
      modelId: 'text-embedding-3-small'
    })

    expect(() =>
      resolvePresetEmbeddingTarget({
        presetId: 'preset_1',
        snapshot: SNAPSHOT,
        preset: OPENAI_PRESET,
        localAiServers: [],
        apiKeys: {}
      })
    ).toThrow(/Settings → API Keys/)

    const google = resolvePresetEmbeddingTarget({
      presetId: 'preset_g',
      snapshot: { provider: 'google', modelName: 'text-embedding-004' },
      preset: { provider: 'google', modelId: 'text-embedding-004' },
      localAiServers: [],
      apiKeys: { google: 'g-key' }
    })
    expect(google.kind).toBe('google')
  })

  it('routes local-runtime presets through the configured Local AI base URL', () => {
    const target = resolvePresetEmbeddingTarget({
      presetId: 'preset_l',
      snapshot: { provider: 'ollama', modelName: 'nomic-embed-text' },
      preset: { provider: 'ollama', modelId: 'nomic-embed-text' },
      localAiServers: [{ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/', openaiPath: '/v1' }],
      apiKeys: {}
    })
    expect(target).toEqual({
      kind: 'openai-compatible',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'local-ai',
      modelId: 'nomic-embed-text'
    })

    expect(() =>
      resolvePresetEmbeddingTarget({
        presetId: 'preset_l',
        snapshot: { provider: 'ollama', modelName: 'nomic-embed-text' },
        preset: { provider: 'ollama', modelId: 'nomic-embed-text' },
        localAiServers: [],
        apiKeys: {}
      })
    ).toThrow(/no base URL configured in Settings → Local AI/)
  })

  it('fails loudly for deleted, repointed, gateway-routed, and unsupported presets', () => {
    expect(() =>
      resolvePresetEmbeddingTarget({
        presetId: 'gone',
        snapshot: SNAPSHOT,
        preset: null,
        localAiServers: [],
        apiKeys: {}
      })
    ).toThrow(/no longer exists/)

    expect(() =>
      resolvePresetEmbeddingTarget({
        presetId: 'preset_1',
        snapshot: SNAPSHOT,
        preset: { ...OPENAI_PRESET, modelId: 'text-embedding-3-large' },
        localAiServers: [],
        apiKeys: { openai: 'sk-test' }
      })
    ).toThrow(/changed since it was saved here/)

    expect(() =>
      resolvePresetEmbeddingTarget({
        presetId: 'preset_1',
        snapshot: SNAPSHOT,
        preset: { ...OPENAI_PRESET, connection: { type: 'openrouter' } },
        localAiServers: [],
        apiKeys: { openai: 'sk-test' }
      })
    ).toThrow(/no embeddings endpoint/)

    expect(() =>
      resolvePresetEmbeddingTarget({
        presetId: 'preset_a',
        snapshot: { provider: 'anthropic', modelName: 'claude-sonnet-4-6' },
        preset: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
        localAiServers: [],
        apiKeys: { anthropic: 'sk-ant' }
      })
    ).toThrow(/no embeddings path here yet/)
  })

  it('preset lane constructs an embedder with the snapshot identity', () => {
    const embedder = createMemoryEmbedder({
      lane: 'preset',
      modelId: 'preset:openai:text-embedding-3-small',
      preset: {
        presetId: 'preset_1',
        provider: 'openai',
        modelName: 'text-embedding-3-small',
        dims: 1536
      }
    })
    expect(embedder.modelId).toBe('preset:openai:text-embedding-3-small@1536')
    expect(embedder.dims).toBe(1536)
  })
})

describe('memory query building helpers', () => {
  it('escapes TAG specials so agent ids are safe in queries', () => {
    expect(escapeTagValue('agent_1755')).toBe('agent_1755')
    expect(escapeTagValue('agent-with-dash.and:colon')).toBe(
      'agent\\-with\\-dash\\.and\\:colon'
    )
  })

  it('neutralizes RediSearch syntax in free text', () => {
    expect(sanitizeTextQuery('what about (Maggie | the dog)? @lane:{ltm}')).toBe(
      'what about Maggie the dog lane ltm'
    )
    expect(sanitizeTextQuery('   ')).toBe('')
  })
})

describe('memory key namespace', () => {
  it('builds agent-scoped keys and patterns', () => {
    expect(memoryKey('agent_1', 'mem_2')).toBe('memory:agent_1:mem_2')
    expect(memoryAgentPattern('agent_1')).toBe('memory:agent_1:*')
    expect(memorySegmentKey('agent_1', 'memseg_2')).toBe('memseg:agent_1:memseg_2')
  })

  it('uses canonical index names outside the test lane and suffixed names inside it', () => {
    const previous = process.env.BATSHIT_MEMORY_INDEX_SUFFIX
    delete process.env.BATSHIT_MEMORY_INDEX_SUFFIX
    expect(memoryIndexName()).toBe('batshit_memory_idx')
    expect(memorySegmentIndexName()).toBe('batshit_memseg_idx')
    process.env.BATSHIT_MEMORY_INDEX_SUFFIX = 'run42'
    expect(memoryIndexName()).toBe('batshit_memory_idx_run42')
    expect(memorySegmentIndexName()).toBe('batshit_memseg_idx_run42')
    if (previous === undefined) delete process.env.BATSHIT_MEMORY_INDEX_SUFFIX
    else process.env.BATSHIT_MEMORY_INDEX_SUFFIX = previous
  })
})
