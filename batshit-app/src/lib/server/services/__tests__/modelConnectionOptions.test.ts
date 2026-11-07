import { describe, expect, it } from 'vitest'
import { buildConnectionOptions } from '../modelConnectionOptions'
import { HOSTED_CATALOG_DIRECT_PROVIDER_IDS } from '$lib/data/hostedCatalogConnections'
import { isManualEntryDirectProvider } from '$lib/utils/modelCatalogConnectionMode'
import { isModelAllowedForConnection } from '$lib/utils/modelConnections'
import { resolveCatalogIds } from '$lib/utils/modelIdResolver'

const access = {
  apiKeys: {}, availability: {}, gateway: { apiKey: null, baseURL: null, availability: { hasKey: false, source: null } }
} as Parameters<typeof buildConnectionOptions>[0]

// Representative namespaces observed in the public registry, 2026-10-18. Each hosted
// source must remain covered; these are catalog identities, never account entitlement.
const SOURCE_DEVELOPERS: Record<typeof HOSTED_CATALOG_DIRECT_PROVIDER_IDS[number], string[]> = {
  openai: ['openai'], anthropic: ['anthropic'], google: ['google'], mistral: ['mistral'],
  groq: ['groq', 'openai', 'meta-llama'], xai: ['xai'], deepseek: ['deepseek'],
  deepinfra: ['xiaomimimo', 'zai-org'], moonshot: ['moonshot'], kimi_code: ['moonshotai'],
  minimax: ['minimax'], minimax_token_plan: ['minimax'], mimo: ['xiaomi'], mimo_token_plan: ['xiaomi'],
  qwencloud: ['qwen', 'alibaba', 'moonshotai', 'zai'], qwen_token_plan: ['qwen', 'deepseek', 'zai'],
  alibaba: ['qwen', 'alibaba', 'moonshotai', 'zai'], stepfun: ['stepai'],
  zai: ['zai'], zai_coding: ['zai'], togetherai: ['meta-llama', 'zai-org'],
  fireworks: ['fireworks', 'deepseek-ai'], baseten: ['zai-org', 'openai'], cerebras: ['cerebras'],
  fal: ['google', 'minimax'], luma: ['luma'], replicate: ['anthropic', 'google'],
  elevenlabs: ['elevenlabs'], deepgram: ['deepgram'], assemblyai: ['assemblyai'], cohere: ['cohere']
}

describe('whole fixed provider selector catalog wiring', () => {
  it('accounts for every fixed hosted and manual entry without duplicate identities', () => {
    const options = buildConnectionOptions(access)
    expect(new Set(options.map(option => option.id)).size).toBe(options.length)
    const direct = options.filter(option => option.id.startsWith('direct:'))
    expect(direct.filter(option => isManualEntryDirectProvider(option.service)).map(option => option.service)).toEqual([])
    expect(direct.filter(option => !isManualEntryDirectProvider(option.service)).map(option => option.service).sort()).toEqual([...HOSTED_CATALOG_DIRECT_PROVIDER_IDS].sort())
    // SA-139 R5: the removed Claude Code CLI connection (`claude-cli`) is no longer one of them.
    expect(options.filter(option => !option.id.startsWith('direct:')).map(option => option.id).sort()).toEqual(['openrouter', 'vercel-gateway'])
    // SA-139 R1: the removed Codex CLI is no selectable connection under any id or service.
    expect(options.some(option => option.id === 'codex-cli' || option.service === 'openai-codex')).toBe(false)
    expect(Object.keys(SOURCE_DEVELOPERS).sort()).toEqual([...HOSTED_CATALOG_DIRECT_PROVIDER_IDS].sort())
  })

  it.each(HOSTED_CATALOG_DIRECT_PROVIDER_IDS)('keeps %s exact maker variants selectable and resolvable through its real connection option', service => {
    const connection = buildConnectionOptions(access).find(option => option.id === `direct:${service}`)!
    expect(connection).toBeTruthy()
    // Readiness is separate from discovery: no configured key is needed to inspect a catalog.
    expect(connection.status).toBe('locked')
    for (const developerId of SOURCE_DEVELOPERS[service]) {
      const variant = { developerId, modelId: 'Exact-Model', effectiveId: 'Exact-Model', source: 'direct' as const }
      const model = { id: `${developerId}/model`, provider: developerId, name: 'model', displayName: 'Model',
        purpose: service === 'replicate' ? 'image' as const : 'chat' as const,
        connectionId: 'vercel-gateway', availableConnections: [connection.id], idVariants: { [connection.id]: variant } }
      expect(isModelAllowedForConnection(model, connection), `${service}:${developerId}`).toBe(true)
      if (service === 'replicate') expect(isModelAllowedForConnection({ ...model, purpose: 'chat' }, connection)).toBe(false)
      expect(resolveCatalogIds({ connection, developerId, modelId: 'model', idVariants: model.idVariants })).toEqual({
        developerId, modelId: 'Exact-Model', effectiveModelId: 'Exact-Model', source: 'direct'
      })
    }
  })
})
