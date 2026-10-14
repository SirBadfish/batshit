import { describe, expect, it } from 'vitest'

import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import {
  buildConnectionScopedCatalogModels,
  findConnectionScopedCatalogPreset,
  resolveConnectionScopedCatalogModel
} from './catalogConnectionScope'

const baseConnection = (
  overrides: Partial<CatalogConnectionOption> = {}
): CatalogConnectionOption => ({
  id: 'direct:google',
  label: 'Google (Direct)',
  transport: 'direct',
  status: 'ready',
  providers: ['google'],
  ...overrides
})

const baseModel = (overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'google/gemini-2.5-pro',
  canonicalId: 'google/gemini-2.5-pro',
  provider: 'google',
  name: 'gemini-2.5-pro',
  displayName: 'Gemini 2.5 Pro',
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  ...overrides
})

describe('catalogConnectionScope', () => {
  it('selects only the exact account before matching a paid same-slug row or another account (BL-1067)', () => {
    const row = (connectionId: string) => baseModel({
      id: `${connectionId}/gpt-6-astra`, canonicalId: `${connectionId}/gpt-6-astra`,
      provider: 'openai', name: 'gpt-6-astra', connectionId, availableConnections: [connectionId],
      idVariants: { [connectionId]: { developerId: 'openai', modelId: 'gpt-6-astra', effectiveId: 'gpt-6-astra', source: 'direct' } }
    })
    const rows = [row('direct:openai'), row('chatgpt-plan:account-a'), row('chatgpt-plan:account-b')]
    const connection = baseConnection({ id: 'chatgpt-plan:account-b', service: 'chatgpt-plan', providers: ['openai'] })
    const preset = { targetId: rows[0].id, provider: 'openai', modelId: 'gpt-6-astra' }
    expect(findConnectionScopedCatalogPreset(rows, connection, preset)).toBe(rows[2])
    expect(findConnectionScopedCatalogPreset(rows, { ...connection, id: 'direct:openai' }, preset)).toBe(rows[0])
    expect(findConnectionScopedCatalogPreset(rows.slice(0, 2), connection, preset)).toBeUndefined()
    expect(findConnectionScopedCatalogPreset(rows, null, preset)).toBeUndefined()
    expect(findConnectionScopedCatalogPreset(rows, connection, { ...preset, modelId: 'GPT-6-Astra' })).toBeUndefined()
  })
  it('resolves the selected connection variant instead of the shared base row identity', () => {
    const scoped = resolveConnectionScopedCatalogModel(
      baseModel({
        idVariants: {
          'direct:google': {
            developerId: 'google',
            modelId: 'gemini-2.5-pro-preview-05-06',
            effectiveId: 'gemini-2.5-pro-preview-05-06',
            source: 'direct'
          }
        },
        availableConnections: ['vercel-gateway', 'direct:google']
      }),
      baseConnection()
    )

    expect(scoped.developerId).toBe('google')
    expect(scoped.canonicalDeveloperId).toBe('google')
    expect(scoped.modelId).toBe('gemini-2.5-pro-preview-05-06')
    expect(scoped.effectiveModelId).toBe('gemini-2.5-pro-preview-05-06')
  })

  it('dedupes connection-scoped duplicates so leaked clone rows cannot reappear in dropdowns', () => {
    const directGoogleVariant = {
      'direct:google': {
        developerId: 'google',
        modelId: 'gemini-2.5-pro',
        effectiveId: 'gemini-2.5-pro',
        source: 'direct' as const
      }
    }

    const rows = buildConnectionScopedCatalogModels(
      [
        baseModel({
          id: 'google/gemini-2.5-pro',
          idVariants: directGoogleVariant,
          availableConnections: ['vercel-gateway', 'direct:google']
        }),
        baseModel({
          id: 'google-vertex/gemini-2.5-pro',
          canonicalId: 'google-vertex/gemini-2.5-pro',
          provider: 'google-vertex',
          source: 'n8n-only',
          transport: 'local',
          connectionId: 'google-vertex',
          availableConnections: ['google-vertex'],
          idVariants: directGoogleVariant
        })
      ],
      baseConnection()
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.catalogId).toBe('google/gemini-2.5-pro')
    expect(rows[0]?.developerId).toBe('google')
    expect(rows[0]?.effectiveModelId).toBe('gemini-2.5-pro')
  })

  it('keeps an exact provider namespace while exposing one canonical Z.ai developer', () => {
    const scoped = resolveConnectionScopedCatalogModel(
      baseModel({
        id: 'zai/glm-5.3',
        canonicalId: 'zai/glm-5.3',
        provider: 'zai',
        name: 'glm-5.3',
        displayName: 'GLM-5.3',
        idVariants: {
          'direct:deepinfra': {
            developerId: 'zai-org',
            modelId: 'GLM-5.3',
            effectiveId: 'zai-org/GLM-5.3',
            source: 'direct'
          }
        }
      }),
      baseConnection({ id: 'direct:deepinfra', label: 'DeepInfra (Direct)', providers: ['deepinfra'] })
    )

    expect(scoped.canonicalDeveloperId).toBe('zai')
    expect(scoped.developerId).toBe('zai-org')
    expect(scoped.effectiveModelId).toBe('zai-org/GLM-5.3')
  })
})
