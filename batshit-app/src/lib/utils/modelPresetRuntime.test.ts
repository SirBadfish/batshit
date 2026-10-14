import { describe, expect, it } from 'vitest'
import type { SavedModel } from '$lib/types/savedModels'
import {
  mergePresetRuntimeSettings,
  resolveAgentModelFallbacks,
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
    effectiveModelId: 'gemini-3.5-flash',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides,
  }
}

describe('modelPresetRuntime utilities', () => {
  it('builds settings from the live preset plus only the agent\'s own keys (BL-515)', () => {
    const settings = mergePresetRuntimeSettings(
      {
        includeThoughts: false,
        // A copy of an older preset's value, taken when the agent picked it: no longer the preset's.
        maxTokens: 64000,
        customKnob: 7,
        nativeTools: {
          discoverableToolIds: ['read-file'],
        },
        codex_permission_mode: 'agent',
        claude_permission_mode: 'plan',
        batshit_tool_search: true,
        batshitNativeTools: { bashEnabled: false },
        bashEnabled: false,
        nativeWebSearchProvider: 'exa',
      },
      {
        includeThoughts: true,
        thinkingBudget: 2000,
      },
    )

    expect(settings).toEqual({
      includeThoughts: true,
      thinkingBudget: 2000,
      nativeTools: {
        discoverableToolIds: ['read-file'],
      },
      codex_permission_mode: 'agent',
      claude_permission_mode: 'plan',
      batshit_tool_search: true,
      batshitNativeTools: { bashEnabled: false },
      bashEnabled: false,
      nativeWebSearchProvider: 'exa',
    })
  })

  it('a preset value wins over the agent copy of the same key (unchanged precedence)', () => {
    expect(
      mergePresetRuntimeSettings(
        { codex_permission_mode: 'agent', temperature: 1.2 },
        { codex_permission_mode: 'chat', temperature: 0 },
      ),
    ).toEqual({ codex_permission_mode: 'chat', temperature: 0 })
  })

  it('a preset with no settings leaves only the agent\'s own keys, and nothing at all as null', () => {
    const preset = buildPreset({ settings: undefined })
    expect(
      resolveRuntimeModelSelection({
        preset,
        settings: { temperature: 1.2, reasoningEffort: 'high', nativeTools: { bashAccessMode: 'plan' } },
      }).settings,
    ).toEqual({ nativeTools: { bashAccessMode: 'plan' } })
    expect(resolveRuntimeModelSelection({ preset, settings: { temperature: 1.2 } }).settings).toBeNull()
  })

  it('a preset temperature of 0 is kept (zero is real)', () => {
    const selection = resolveRuntimeModelSelection({
      preset: buildPreset({ settings: { temperature: 0 } }),
      settings: { temperature: 1.2 },
    })
    expect(selection.settings).toEqual({ temperature: 0 })
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
    expect(selection.effectiveModelId).toBe('gemini-3.5-flash')
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

  it('the agent model fallbacks apply only when the agent names no preset (BL-515)', () => {
    const agent = {
      primary_model_temperature: 1.2,
      primary_model_max_tokens: 4000,
      primary_model_top_p: 0.9,
      primary_model_top_k: 40,
      primary_model_presence_penalty: 0.1,
      primary_model_frequency_penalty: 0.2,
      primary_model_seed: 7,
      primary_model_stop_sequences: ['END'],
    }
    expect(resolveAgentModelFallbacks({ preset: buildPreset(), agent })).toBeUndefined()
    expect(resolveAgentModelFallbacks({ preset: null, agent })).toEqual({
      temperature: 1.2,
      maxTokens: 4000,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 7,
      stopSequences: ['END'],
    })
    // A stored null (the picker's "blank") is absent, never a value; a stored 0 is real.
    expect(resolveAgentModelFallbacks({ preset: null, agent: { primary_model_temperature: null } })).toEqual({})
    expect(resolveAgentModelFallbacks({ preset: null, agent: { primary_model_temperature: 0 } })).toEqual({ temperature: 0 })
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
