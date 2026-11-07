import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('@ai-sdk/openai')
import { MIMO_TOKEN_PLAN_MODELS, MIMO_TOKEN_PLAN_TEXT_MODEL_IDS } from './mimoTokenPlan'
import { _getManualDirectModelsForTest, _mapDirectProviderEntriesForTest } from '../services/modelCatalogSync'
import { ProviderManager } from '../services/providers'
import { PausedPlanError } from '../services/pausedPlans'

afterEach(() => vi.unstubAllGlobals())

describe('MiMo Token Plan current docs-backed models', () => {
  it('offers V2.6 text models first without changing speech identities or importing PAYG prices', () => {
    expect(MIMO_TOKEN_PLAN_TEXT_MODEL_IDS).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash'])
    expect(MIMO_TOKEN_PLAN_MODELS.filter(model => model.modelType === 'audio').map(model => model.id)).toEqual([
      'mimo-v2.5-asr', 'mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone'
    ])
    const catalog = _mapDirectProviderEntriesForTest('mimo_token_plan', _getManualDirectModelsForTest('mimo_token_plan'))
    expect(catalog.filter(model => model.purpose === 'chat').map(model => model.id)).toEqual(MIMO_TOKEN_PLAN_TEXT_MODEL_IDS)
    for (const model of catalog.filter(model => model.purpose === 'chat')) {
      expect(model).toMatchObject({ provider: 'xiaomi', purpose: 'chat', contextWindow: 1_000_000 })
      expect(model.features).toMatchObject({ reasoning: true, vision: true })
      expect(model.pricing).toBeUndefined()
    }
  })

  it('preserves an old saved ID verbatim and refuses the paused plan without a silent model or PAYG fallback', () => {
    const fetch = vi.fn(() => { throw new Error('No provider requests permitted') })
    vi.stubGlobal('fetch', fetch)
    const apiKeys = { mimo_token_plan: 'test-se-mimo-plan-0123456789012345' }
    const paused = new ProviderManager({ apiKeys })
    expect(() => paused.getModel('mimo-v2.5-pro', { transport: 'direct', service: 'mimo_token_plan', allowAutoFallback: true,
      fallbackModel: { modelName: 'mimo-v2.6-pro', transport: 'direct', service: 'mimo' } })).toThrow(PausedPlanError)
    // Building a real SDK model performs no inference. The existing Dev exception
    // does not rewrite a saved identity; an upstream refusal would name that ID.
    const dev = new ProviderManager({ apiKeys, pausedPlansAllowed: true })
    expect(dev.getModel('mimo-v2.5-pro', { transport: 'direct', service: 'mimo_token_plan' }).modelId).toBe('mimo-v2.5-pro')
    expect(dev.getProviderInfo('mimo_token_plan')?.models).toEqual(MIMO_TOKEN_PLAN_TEXT_MODEL_IDS)
    expect(fetch).not.toHaveBeenCalled()
  })
})
