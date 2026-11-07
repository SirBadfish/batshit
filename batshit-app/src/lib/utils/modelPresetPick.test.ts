import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SavedModel } from '$lib/types/savedModels'
import { buildPickedPresetModelFields, buildPickedPresetSelection, buildClearedPresetSelection } from './modelPresetPick'
import { resolveRuntimeModelSelection } from './modelPresetRuntime'

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
  it('clear names only present owned leaves, preserving raw absence/null and every native/legacy/Voice sibling', () => {
    const row = { primary_model_preset_id: 'old', primary_model_connection: { type: 'direct', service: 'openai' }, primary_model_provider: 'openai', primary_model_name: 'old',
      primary_model_temperature: 0, primary_model_seed: null, primary_model_capabilities: { vision: true }, model: 'legacy', voice_profile: null,
      provider_specific_settings: { temperature: 0, customFlag: false, codex_model: 'custom-native', nativeTools: { bashAccessMode: 'plan' } },
      codex_settings: { permissionMode: 'chat', model: 'explicit-native', serviceTier: 'fast' } }
    const before = structuredClone(row)
    expect(buildClearedPresetSelection('agent', row)).toEqual({ primary_model_preset_id: '', primary_model_connection: null, primary_model_provider: '', primary_model_name: '',
      primary_model_temperature: null, primary_model_capabilities: null, provider_specific_settings: { temperature: null, customFlag: null } })
    expect(buildClearedPresetSelection('subagent', row)).toEqual({ primary_model_preset_id: '', primary_model_connection: null, primary_model_provider: '', primary_model_name: '' })
    expect(row).toEqual(before)
    for (const empty of [{}, { primary_model_preset_id: null, provider_specific_settings: null, primary_model_temperature: null },
      { primary_model_preset_id: '', primary_model_connection: null, primary_model_name: '', provider_specific_settings: { codex_model: 'retained' } }]) {
      expect(buildClearedPresetSelection('agent', empty)).toEqual({})
      expect(buildClearedPresetSelection('subagent', empty)).toEqual({})
    }
    expect(() => buildClearedPresetSelection('agent', { primary_model_connection: [] })).toThrow('unreadable')
  })
  it('already-null or undefined model-owned keys are an unchanged clear no-op, while zero and false remain clearable', () => {
    const row = { primary_model_seed: null, provider_specific_settings: { temperature: null, customFlag: undefined,
      codex_model: 'native-kept', nativeTools: { bashAccessMode: 'plan' } } }
    const before = structuredClone(row)
    expect(buildClearedPresetSelection('agent', row)).toEqual({})
    expect(buildClearedPresetSelection('subagent', row)).toEqual({})
    expect(buildClearedPresetSelection('agent', { ...row, provider_specific_settings: { ...row.provider_specific_settings, zero: 0, off: false } }))
      .toEqual({ provider_specific_settings: { zero: null, off: null } })
    expect(row).toEqual(before)
  })
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
    // BL-926: a Claude model that takes sampling (Sonnet 4.6); Sonnet 5 and newer discard it.
    const body = sentBody(
      preset({
        modelId: 'claude-sonnet-4-6',
        effectiveModelId: 'claude-sonnet-4-6',
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

  for (const [parameter, field, value] of [
    ['temperature', 'primary_model_temperature', 0.7],
    ['topP', 'primary_model_top_p', 0.9],
    ['topK', 'primary_model_top_k', 50]
  ] as const) {
    it(`BL-926: clears ${parameter} for a Claude model whose SDK discards it, and keeps it for one that takes it`, () => {
      const discarded = sentBody(
        preset({ provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5', settings: { [parameter]: value, maxTokens: 4000 } })
      )
      expect(discarded[field]).toBeNull()
      expect(discarded.primary_model_max_tokens).toBe(4000)
      const taken = sentBody(
        preset({ provider: 'anthropic', modelId: 'claude-sonnet-4-6', effectiveModelId: 'claude-sonnet-4-6', settings: { [parameter]: value, maxTokens: 4000 } })
      )
      expect(taken[field]).toBe(value)
    })
  }

  it('BL-514: the chat-bar picker sends only the preset\'s model keys, never the current block (pinned from the line start)', () => {
    const selector = readFileSync('src/lib/components/models/ModelSelector.svelte', 'utf8')
    expect(selector).toContain('...buildPickedPresetSelection(selectedModel),')
    expect(selector).not.toContain('currentAgent.provider_specific_settings')
  })

  it('the chat-bar picker saves these fields (pinned from the line start)', () => {
    const selector = readFileSync('src/lib/components/models/ModelSelector.svelte', 'utf8')
    expect(selector).toContain('...buildPickedPresetSelection(selectedModel),')
    expect(selector).not.toContain('suppressTemperature ? undefined')
  })

  it('BL-1650: unknown selected-preset capabilities clear an older vision claim at the runtime owner', () => {
    const model = preset()
    const picked = buildPickedPresetSelection(model)
    const saved = { primary_model_capabilities: { vision: true }, ...JSON.parse(JSON.stringify(picked)) }
    expect(picked.primary_model_capabilities).toBeNull()
    expect(resolveRuntimeModelSelection({ preset: model, capabilities: saved.primary_model_capabilities }).capabilities).toBeNull()
    expect(readFileSync('src/lib/components/models/ModelSelector.svelte', 'utf8')).not.toContain('currentAgent.primary_model_capabilities')
    expect(readFileSync('src/lib/components/settings/panels/AgentSettingsPanel.svelte', 'utf8')).toContain('buildPickedPresetSelection(model)')
  })

  it('the shared payload preserves zero/false model parameters and carries no agent-owned runtime key', () => {
    const picked = buildPickedPresetSelection(preset({ provider: 'anthropic', modelId: 'claude-sonnet-4-6',
      settings: { temperature: 0, customFlag: false, nativeTools: { bashAccessMode: 'dangerous' }, codex_model: 'old' } as any }))
    expect(picked.primary_model_temperature).toBe(0)
    expect(picked.provider_specific_settings).toEqual({ temperature: 0, customFlag: false })
    expect(picked.primary_model_connection).toBeTruthy()
  })
})
