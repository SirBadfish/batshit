import { describe, expect, it } from 'vitest'
import type { SavedModel } from '$lib/types/savedModels'
import {
  mergePresetRuntimeSettings,
  resolveRuntimeModelSelection,
} from './modelPresetRuntime'

function buildPreset(overrides: Partial<SavedModel> = {}): SavedModel {
  return {
    id: 'gemini-3-flash',
    provider: 'google',
    modelId: 'gemini-3.5-flash',
    modelName: 'Gemini 3.5 Flash',
    contextWindow: 1000000,
    pricing: {
      input: 0,
      output: 0,
    },
    connection: {
      type: 'direct',
      service: 'google',
    },
    capabilities: {
      reasoning: true,
      tools: true,
    },
    settings: {
      includeThoughts: true,
      thinkingBudget: 2000,
      temperature: 0.7,
    },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides,
  }
}

describe('modelPresetRuntime utilities', () => {
  it('lets live preset settings override stale copied agent settings', () => {
    const settings = mergePresetRuntimeSettings(
      {
        includeThoughts: false,
        maxTokens: 64000,
        nativeTools: {
          discoverableToolIds: ['read-file'],
        },
      },
      {
        includeThoughts: true,
        thinkingBudget: 2000,
      },
    )

    expect(settings).toEqual({
      includeThoughts: true,
      maxTokens: 64000,
      nativeTools: {
        discoverableToolIds: ['read-file'],
      },
      thinkingBudget: 2000,
    })
  })

  it('uses the selected live preset as the runtime model source of truth', () => {
    const selection = resolveRuntimeModelSelection({
      preset: buildPreset(),
      provider: 'openai',
      modelId: 'gpt-5.5',
      connection: {
        type: 'direct',
        service: 'openai',
      },
      capabilities: {
        reasoning: false,
      },
      settings: {
        includeThoughts: false,
      },
    })

    expect(selection.provider).toBe('google')
    expect(selection.modelId).toBe('gemini-3.5-flash')
    expect(selection.connection).toEqual({
      type: 'direct',
      service: 'google',
    })
    expect(selection.capabilities).toEqual({
      reasoning: true,
      tools: true,
    })
    expect(selection.contextWindow).toBe(1000000)
    expect(selection.settings).toMatchObject({
      includeThoughts: true,
      thinkingBudget: 2000,
    })
  })

  it('falls back to agent fields when no preset is selected', () => {
    const selection = resolveRuntimeModelSelection({
      provider: 'zai',
      modelId: 'glm-5.1',
      connection: {
        type: 'direct',
        service: 'zai',
      },
      settings: {
        temperature: 0.4,
      },
    })

    expect(selection).toMatchObject({
      preset: null,
      presetId: null,
      provider: 'zai',
      modelId: 'glm-5.1',
      connection: {
        type: 'direct',
        service: 'zai',
      },
      settings: {
        temperature: 0.4,
      },
    })
  })
})
