import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SavedModel } from '$lib/types/savedModels'
import { buildPickedPresetModelFields } from './modelPresetPick'

/**
 * BL-515: a chat-bar preset pick clears the values the new preset does not set. The picker sent
 * `undefined` for them; JSON dropped those keys, the merge-style agent PUT kept the old values,
 * and preset B inherited preset A's temperature. It now sends `null`, which the PUT stores as
 * absent. A real 0 is kept.
 */

function preset(overrides: Partial<SavedModel> = {}): SavedModel {
  return {
    id: 'preset-b',
    modelName: 'Claude B',
    modelId: 'claude-sonnet-5',
    provider: 'anthropic',
    effectiveModelId: 'claude-sonnet-5',
    pricing: {},
    settings: {},
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides
  } as SavedModel
}

/** What the agent PUT receives: the body after JSON. */
function sentBody(model: SavedModel) {
  return JSON.parse(JSON.stringify(buildPickedPresetModelFields(model)))
}

describe('buildPickedPresetModelFields', () => {
  it('sends null for every value a preset with no settings does not set, so the PUT clears them', () => {
    const body = sentBody(preset({ settings: {} }))
    for (const field of [
      'primary_model_temperature',
      'primary_model_max_tokens',
      'primary_model_top_p',
      'primary_model_top_k',
      'primary_model_frequency_penalty',
      'primary_model_presence_penalty',
      'primary_model_seed',
      'primary_model_stop_sequences',
      'primary_model_reasoning_effort'
    ]) {
      expect(body).toHaveProperty(field, null)
    }
    expect(body).toMatchObject({
      primary_model_preset_id: 'preset-b',
      primary_model_name: 'claude-sonnet-5',
      primary_model_provider: 'anthropic'
    })
  })

  it('keeps a preset temperature of 0 (zero is real) and the values the preset sets', () => {
    const body = sentBody(
      preset({
        settings: { temperature: 0, maxTokens: 8000, topK: 40, seed: 3, stopSequences: ['END'], reasoningEffort: 'low' }
      })
    )
    expect(body).toMatchObject({
      primary_model_temperature: 0,
      primary_model_max_tokens: 8000,
      primary_model_top_k: 40,
      primary_model_seed: 3,
      primary_model_stop_sequences: ['END'],
      primary_model_reasoning_effort: 'low'
    })
  })

  it('clears a sampling value this model does not take (an OpenAI reasoning model)', () => {
    const body = sentBody(
      preset({ provider: 'openai', modelId: 'gpt-5.5', effectiveModelId: 'gpt-5.5', settings: { temperature: 0.7, maxTokens: 4000 } })
    )
    expect(body.primary_model_temperature).toBeNull()
    expect(body.primary_model_max_tokens).toBe(4000)
  })

  it('BL-514: the chat-bar picker sends only the preset\'s model keys, never the current block (pinned from the line start)', () => {
    const selector = readFileSync('src/lib/components/models/ModelSelector.svelte', 'utf8')
    expect(selector).toContain('\n\t\t\t\t\tprovider_specific_settings: presetModelSettings(selectedModel.settings),\n')
    expect(selector).not.toContain('currentAgent.provider_specific_settings')
  })

  it('the chat-bar picker saves these fields (pinned from the line start)', () => {
    const selector = readFileSync('src/lib/components/models/ModelSelector.svelte', 'utf8')
    expect(selector).toContain('\n\t\t\t\t\t...buildPickedPresetModelFields(selectedModel),\n')
    expect(selector).not.toContain('suppressTemperature ? undefined')
  })
})
