import { describe, it, expect } from 'vitest'
import { autoSelectConnectionForModel, isModelAllowedForConnection, isDirectDeveloperCompatible } from './modelConnections'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'

const baseModel = (overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'anthropic/claude-sonnet-4-5-latest',
  name: 'claude-sonnet-4-5-latest',
  provider: 'anthropic',
  displayName: 'Claude Sonnet 4.5',
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  ...overrides
})

const baseConnection = (overrides: Partial<CatalogConnectionOption> = {}): CatalogConnectionOption => ({
  id: 'vercel-gateway',
  label: 'Vercel Gateway',
  transport: 'vercel-gateway',
  status: 'ready',
  ...overrides
})

describe('modelConnections utilities', () => {
  it.each(LOCAL_AI_SERVER_DEFINITIONS)(
    'allows a different model maker on the $id connection',
    ({ id }) => {
      expect(isDirectDeveloperCompatible('Qwen', {
        id: `direct:${id}`, transport: 'direct', service: id, providers: [id],
      })).toBe(true)
    },
  )

  describe('isModelAllowedForConnection', () => {
    it('allows matching gateway connections', () => {
      const model = baseModel()
      const connection = baseConnection()
      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('rejects openrouter models for direct connections without provider match', () => {
      const model = baseModel({ provider: 'openrouter-provider', transport: 'openrouter', source: 'openrouter' })
      const connection = baseConnection({
        id: 'direct:anthropic',
        label: 'Anthropic Direct',
        transport: 'direct',
        providers: ['anthropic']
      })
      expect(isModelAllowedForConnection(model, connection)).toBe(false)
    })

    it('allows connection when connectionId matches even if transport differs', () => {
      const model = baseModel({ connectionId: 'direct:anthropic', transport: 'vercel-gateway' })
      const connection = baseConnection({
        id: 'direct:anthropic',
        label: 'Anthropic Direct',
        transport: 'direct',
        providers: ['anthropic']
      })
      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('allows connection when listed in availableConnections even if canonical entry is shared', () => {
      const model = baseModel({
        connectionId: 'vercel-gateway',
        availableConnections: ['vercel-gateway', 'openrouter']
      })
      const connection = baseConnection({
        id: 'openrouter',
        label: 'OpenRouter',
        transport: 'openrouter'
      })
      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('allows provider match for direct connections only when the row names no connection at all', () => {
      const model = baseModel({ provider: 'anthropic', connectionId: undefined, transport: undefined })
      const connection = baseConnection({
        id: 'direct:anthropic',
        label: 'Anthropic Direct',
        transport: 'direct',
        providers: ['anthropic', 'openai']
      })
      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('rejects a same-developer row that names only other connections (BL-66)', () => {
      // The hosted registry's gateway row for Claude Haiku 4.5 advertises only Vercel AI Gateway and
      // OpenRouter. Under Anthropic (Direct) it has no exact identity, so applying it fails with
      // invalid_model_identity; it must not be offered there.
      const gatewayOnlyRow = baseModel({
        id: 'anthropic/claude-haiku-4.5',
        name: 'claude-haiku-4.5',
        connectionId: 'vercel-gateway',
        availableConnections: ['vercel-gateway', 'openrouter'],
        idVariants: {
          'vercel-gateway': {
            developerId: 'anthropic',
            modelId: 'claude-haiku-4.5',
            effectiveId: 'anthropic/claude-haiku-4.5',
            source: 'vercel'
          },
          openrouter: {
            developerId: 'anthropic',
            modelId: 'claude-haiku-4.5',
            effectiveId: 'anthropic/claude-haiku-4.5',
            source: 'openrouter'
          }
        }
      })
      const directRow = baseModel({
        id: 'claude-haiku-4-5-20251001',
        name: 'claude-haiku-4-5-20251001',
        source: 'direct',
        transport: 'direct',
        connectionId: 'direct:anthropic',
        availableConnections: ['direct:anthropic'],
        idVariants: {
          'direct:anthropic': {
            developerId: 'anthropic',
            modelId: 'claude-haiku-4-5-20251001',
            effectiveId: 'claude-haiku-4-5-20251001',
            source: 'direct'
          }
        }
      })
      const anthropicDirect = baseConnection({
        id: 'direct:anthropic',
        label: 'Anthropic (Direct)',
        transport: 'direct',
        service: 'anthropic',
        providers: ['anthropic']
      })

      expect(isModelAllowedForConnection(gatewayOnlyRow, anthropicDirect)).toBe(false)
      expect(isModelAllowedForConnection(directRow, anthropicDirect)).toBe(true)
      expect(isModelAllowedForConnection(gatewayOnlyRow, baseConnection())).toBe(true)
      expect(
        isModelAllowedForConnection(
          gatewayOnlyRow,
          baseConnection({ id: 'openrouter', label: 'OpenRouter', transport: 'openrouter' })
        )
      ).toBe(true)
    })

    it('rejects incompatible direct id variants even when connection metadata claims support', () => {
      const model = baseModel({
        provider: 'anthropic',
        availableConnections: ['direct:anthropic'],
        idVariants: {
          'direct:anthropic': {
            developerId: 'openai',
            modelId: 'gpt-5.2',
            effectiveId: 'gpt-5.2',
            source: 'direct'
          }
        }
      })
      const connection = baseConnection({
        id: 'direct:anthropic',
        label: 'Anthropic Direct',
        transport: 'direct',
        providers: ['anthropic']
      })

      expect(isModelAllowedForConnection(model, connection)).toBe(false)
    })

    it('allows multi-tenant direct variants with non-service developer ids', () => {
      const model = baseModel({
        provider: 'meta-llama',
        availableConnections: ['direct:deepinfra'],
        idVariants: {
          'direct:deepinfra': {
            developerId: 'meta-llama',
            modelId: 'llama-3.3-70b-instruct',
            effectiveId: 'meta-llama/llama-3.3-70b-instruct',
            source: 'direct'
          }
        }
      })
      const connection = baseConnection({
        id: 'direct:deepinfra',
        label: 'DeepInfra Direct',
        transport: 'direct',
        providers: ['deepinfra']
      })

      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('treats groq as a multi-developer direct provider', () => {
      const model = baseModel({
        provider: 'openai',
        availableConnections: ['direct:groq'],
        idVariants: {
          'direct:groq': {
            developerId: 'openai',
            modelId: 'gpt-oss-120b',
            effectiveId: 'openai/gpt-oss-120b',
            source: 'direct'
          }
        }
      })
      const connection = baseConnection({
        id: 'direct:groq',
        label: 'Groq Direct',
        transport: 'direct',
        providers: ['groq']
      })

      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('treats Qwen Cloud as a multi-developer direct provider', () => {
      const model = baseModel({
        provider: 'wan',
        availableConnections: ['direct:qwencloud'],
        idVariants: {
          'direct:qwencloud': {
            developerId: 'wan',
            modelId: 'wan2.2-t2v-plus',
            effectiveId: 'wan2.2-t2v-plus',
            source: 'direct'
          }
        }
      })
      const connection = baseConnection({
        id: 'direct:qwencloud',
        label: 'Qwen Cloud Direct',
        transport: 'direct',
        providers: ['qwencloud']
      })

      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })

    it('treats Qwen Token Plan as a multi-developer direct provider', () => {
      const model = baseModel({
        provider: 'deepseek',
        availableConnections: ['direct:qwen_token_plan'],
        idVariants: {
          'direct:qwen_token_plan': {
            developerId: 'deepseek',
            modelId: 'deepseek-v4-pro',
            effectiveId: 'deepseek-v4-pro',
            source: 'direct'
          }
        }
      })
      const connection = baseConnection({
        id: 'direct:qwen_token_plan',
        label: 'Qwen Token Plan Direct',
        transport: 'direct',
        providers: ['qwen_token_plan']
      })

      expect(isModelAllowedForConnection(model, connection)).toBe(true)
    })
  })

  describe('autoSelectConnectionForModel', () => {
    const gateway = baseConnection()
    const anthropicDirect = baseConnection({
      id: 'direct:anthropic',
      label: 'Anthropic Direct',
      transport: 'direct',
      providers: ['anthropic']
    })
    const openrouter = baseConnection({
      id: 'openrouter',
      label: 'OpenRouter',
      transport: 'openrouter'
    })

    it('prefers ready direct connections for matching provider', () => {
      const selected = autoSelectConnectionForModel(
        [gateway, anthropicDirect],
        baseModel({ connectionId: 'direct:anthropic' })
      )
      expect(selected?.id).toBe('direct:anthropic')
    })

    it('falls back to first ready option when preferred is locked', () => {
      const lockedDirect = { ...anthropicDirect, status: 'locked' as const }
      const selected = autoSelectConnectionForModel([lockedDirect, gateway], baseModel())
      expect(selected?.id).toBe('vercel-gateway')
    })

    it('selects openrouter transport for openrouter models', () => {
      const model = baseModel({
        transport: 'openrouter',
        provider: 'openrouter-provider',
        source: 'openrouter',
        connectionId: 'openrouter'
      })
      const selected = autoSelectConnectionForModel([gateway, openrouter], model)
      expect(selected?.id).toBe('openrouter')
    })

    it('prefers exact connectionId match when provided', () => {
      const model = baseModel({ connectionId: 'direct:anthropic' })
      const selected = autoSelectConnectionForModel([gateway, anthropicDirect], model)
      expect(selected?.id).toBe('direct:anthropic')
    })
  })
})
