/**
 * BL-68 on the instance side of the catalog: an exact-connection lookup for a
 * preset whose row merged into another, and no `maxTokens: 0` for an unknown
 * window when an instance falls back to the gateway's own model list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

vi.mock('$lib/server/services/upstashKv', () => ({ upstashKvGet: vi.fn(async () => null) }))

const { fetchVercelModelCatalog, findVercelCatalogEntryById } = await import('./vercelModelCatalog')

useRedisTestServer()

const MERGED_HAIKU = {
  id: 'anthropic/claude-haiku-4.5',
  canonicalId: 'anthropic/claude-haiku-4.5',
  provider: 'anthropic',
  name: 'claude-haiku-4.5',
  displayName: 'Claude Haiku 4.5',
  tags: [],
  features: { streaming: true, tools: true, vision: true, maxTokens: 200_000 },
  source: 'vercel',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:anthropic'],
  idVariants: {
    'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-haiku-4.5', effectiveId: 'anthropic/claude-haiku-4.5', source: 'vercel' },
    'direct:anthropic': { developerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001', effectiveId: 'claude-haiku-4-5-20251001', source: 'direct' }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('BL-68 findVercelCatalogEntryById through a connection\'s variant', () => {
  beforeEach(async () => {
    await redis.set('vercel:model_catalog:v1', { models: [MERGED_HAIKU], fetchedAt: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network is not used here')
    }))
  })

  it('finds the merged row for the old id on the exact connection only', async () => {
    expect((await findVercelCatalogEntryById('claude-haiku-4-5-20251001', 'direct:anthropic'))?.id).toBe(
      'anthropic/claude-haiku-4.5'
    )
    expect(await findVercelCatalogEntryById('claude-haiku-4-5-20251001', 'openrouter')).toBeNull()
    expect(await findVercelCatalogEntryById('claude-haiku-4-5-20251001')).toBeNull()
  })

  it('still finds a row by its own id without a connection', async () => {
    expect((await findVercelCatalogEntryById('anthropic/claude-haiku-4.5'))?.id).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('BL-68 the gateway fallback publishes no window it does not know', () => {
  it('leaves maxTokens and the long-context claim out for an unknown window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'acme/mystery-model', name: 'Mystery Model' },
                { id: 'acme/long-model', name: 'Long Model', context_window: 200_000 }
              ]
            }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )

    const catalog = await fetchVercelModelCatalog(true)
    const mystery = catalog.models.find((model) => model.id === 'acme/mystery-model')
    const long = catalog.models.find((model) => model.id === 'acme/long-model')

    expect(mystery?.features).not.toHaveProperty('maxTokens')
    expect(mystery?.features).not.toHaveProperty('longContext')
    expect(long?.features).toMatchObject({ maxTokens: 200_000, longContext: true })
  })
})

describe('BL-131 the gateway fallback keeps a free price and never invents one', () => {
  it('keeps $0, drops a negative or blank price, and converts per-token prices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'acme/model-free', name: 'Free', pricing: { input: '0', output: '0' } },
                { id: 'acme/unmarked', name: 'Unmarked', pricing: { input: '0', output: '0' } },
                { id: 'spacexai/grok-stt', name: 'Grok STT', type: 'transcription', pricing: { input: '0', transcription_duration_cost_per_second: '0.000028' } },
                { id: 'acme/router', name: 'Router', pricing: { input: '-1', output: '-1' } },
                { id: 'acme/blank', name: 'Blank', pricing: { input: '', output: '' } },
                { id: 'acme/paid', name: 'Paid', pricing: { input: '0.000003', output: '0.000015' } },
                { id: 'acme/varies', name: 'Varies', pricing: { input: '0', output: '0', varies_by_provider: true } },
                { id: 'acme/tiny', name: 'Tiny', pricing: { input: '0.0000000001' } }
              ]
            }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )

    const catalog = await fetchVercelModelCatalog(true)
    const byId = (id: string) => catalog.models.find((model) => model.id === id)

    expect(byId('acme/model-free')?.pricing).toEqual({ input: 0, output: 0 })
    // Review finding 1: the gateway marks its free models with -free, and prices
    // grok-stt per second of audio, so neither 0 is a free price.
    expect(byId('acme/unmarked')?.pricing).toBeUndefined()
    expect(byId('spacexai/grok-stt')?.pricing).toBeUndefined()
    expect(byId('acme/router')?.pricing).toBeUndefined()
    expect(byId('acme/blank')?.pricing).toBeUndefined()
    expect(byId('acme/paid')?.pricing).toEqual({ input: 3, output: 15 })
    expect(byId('acme/varies')?.pricing).toBeUndefined()
    expect(byId('acme/tiny')?.pricing).toEqual({ input: 0.0001 })
  })
})

describe('BL-295 the gateway fallback drops a placeholder token price beside a per-second one', () => {
  it('lists no token price for whisper-1 and keeps a token-priced transcription model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'openai/whisper-1', name: 'Whisper', type: 'transcription', pricing: { input: '0.0000000001', transcription_duration_cost_per_second: '0.0001' } },
                { id: 'openai/gpt-4o-transcribe', name: 'GPT-4o Transcribe', type: 'transcription', pricing: { input: '0.0000025', output: '0.00001' } }
              ]
            }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )

    const catalog = await fetchVercelModelCatalog(true)
    const byId = (id: string) => catalog.models.find((model) => model.id === id)
    expect(byId('openai/whisper-1')?.pricing).toBeUndefined()
    expect(byId('openai/gpt-4o-transcribe')?.pricing).toEqual({ input: 2.5, output: 10 })
  })
})

describe('A window of 0 is unknown on the instance side too (new find in the 2026-09-25 bug batch)', () => {
  it('drops a 0 window from the gateway fallback and from a registry that still publishes one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'mistral/mistral-embed', name: 'Mistral Embed', context_window: 0, max_tokens: 0 }] }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )
    const fromGateway = await fetchVercelModelCatalog(true)
    expect(fromGateway.models.find((model) => model.id === 'mistral/mistral-embed')?.contextWindow).toBeUndefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('registry')) {
          return new Response(
            JSON.stringify({
              fetchedAt: new Date().toISOString(),
              models: [{ ...MERGED_HAIKU, id: 'mistral/mistral-embed', canonicalId: 'mistral/mistral-embed', contextWindow: 0, maxOutputTokens: 0 }]
            }),
            { status: 200 }
          )
        }
        return new Response('not used', { status: 503 })
      })
    )
    const fromRegistry = await fetchVercelModelCatalog(true)
    const row = fromRegistry.models.find((model) => model.id === 'mistral/mistral-embed')
    expect(row).toBeTruthy()
    expect(row?.contextWindow).toBeUndefined()
    expect(row?.maxOutputTokens).toBeUndefined()
  })
})
