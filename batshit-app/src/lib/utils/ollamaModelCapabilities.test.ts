import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '$lib/types/modelCatalog'
import { acknowledgeOllamaPresetCapabilities, projectOllamaPresetCapabilities, readOllamaModelCapabilities } from './ollamaModelCapabilities'

const MODEL = 'library/qwen3.5:9b-q4_K_M'
const preset = {
  provider: 'library', modelId: 'qwen3.5:9b-q4_K_M', effectiveModelId: MODEL,
  connection: { id: 'direct:ollama', type: 'direct' as const, service: 'ollama' }
}
const row: CatalogModel = {
  id: `ollama/${MODEL}`, provider: 'ollama', name: MODEL, displayName: MODEL,
  source: 'local', connectionId: 'direct:ollama', features: { vision: true, reasoning: true, tools: true }
}

describe('Ollama optional reported capabilities', () => {
  it('maps exact native vision/thinking only, without enabling tools', () => {
    const result = readOllamaModelCapabilities({ models: [
      { name: MODEL, model: MODEL, capabilities: ['vision', 'tools', 'thinking'] }
    ] })
    expect(result.get(MODEL)).toEqual({ vision: true, reasoning: true })
    expect(result.size).toBe(1)
  })

  it.each([null, {}, { models: null }, { models: 'bad' }, { error: 'unsupported' }])('keeps invalid envelopes unknown: %j', payload => {
    expect(readOllamaModelCapabilities(payload).size).toBe(0)
  })

  it.each([undefined, null, [], ['completion'], { thinking: true }, ['thinking', null]])('keeps absent/unusable/nonmatching metadata unknown: %j', capabilities => {
    expect(readOllamaModelCapabilities({ models: [{ name: MODEL, capabilities }] }).size).toBe(0)
  })

  it('rejects contradictory identities and duplicate metadata rather than guessing', () => {
    const result = readOllamaModelCapabilities({ models: [
      { name: MODEL, model: 'another-model', capabilities: ['thinking'] },
      { name: 'duplicate', capabilities: ['vision'] },
      { name: 'duplicate', capabilities: ['thinking'] },
      { name: MODEL, model: MODEL, capabilities: ['vision'] }
    ] })
    expect(result.size).toBe(0)
  })

  it.each([{ name: MODEL, model: 123 }, { name: null, model: MODEL }, { name: MODEL, model: '' }])('does not trust a malformed identity: %j', identity => {
    expect(readOllamaModelCapabilities({ models: [{ ...identity, capabilities: ['vision', 'thinking'] }] }).size).toBe(0)
  })
})

describe('Ollama inferred-support save acknowledgement', () => {
  const sent = { ...preset, capabilities: { streaming: true, vision: true, reasoning: true } }

  it('copies only successfully sent and confirmed positives, without touching later choices or inputs', () => {
    const current = { ...preset, capabilities: { streaming: true, vision: false, tools: false } }
    const before = structuredClone(current)
    expect(acknowledgeOllamaPresetCapabilities(current, preset, sent, sent)).toEqual({
      streaming: true, vision: false, tools: false, reasoning: true
    })
    expect(current).toEqual(before)
    expect(acknowledgeOllamaPresetCapabilities(preset, preset, sent, { ...sent, capabilities: { vision: true } })).toEqual({ vision: true })
  })

  it('does not restore a prior explicit choice that a later edit replaced, or a different target', () => {
    expect(acknowledgeOllamaPresetCapabilities(preset, sent, sent, sent)).toBeNull()
    expect(acknowledgeOllamaPresetCapabilities({ ...preset, modelId: 'later-target', effectiveModelId: 'later-target' }, preset, sent, sent)).toBeNull()
    expect(acknowledgeOllamaPresetCapabilities(preset, preset, { ...sent, connection: { ...sent.connection, id: 'direct:lmstudio' } }, sent)).toBeNull()
  })
})

describe('Ollama preset read projection', () => {
  it('fills only missing vision/reasoning and leaves inputs/tool default untouched', () => {
    const capabilities = { streaming: true, tools: false, fast: false }
    const original = { ...preset, capabilities, settings: { temperature: 0, ollamaThink: false } }
    const before = structuredClone(original)
    expect(projectOllamaPresetCapabilities(original, [row])).toEqual({
      ...capabilities, vision: true, reasoning: true
    })
    expect(original).toEqual(before)
    expect(projectOllamaPresetCapabilities(preset, [row])).toEqual({ vision: true, reasoning: true })
  })

  it('keeps every explicit boolean, including restrictions', () => {
    const capabilities = { vision: false, reasoning: false, tools: true }
    expect(projectOllamaPresetCapabilities({ ...preset, capabilities }, [row])).toBe(capabilities)
  })

  it.each([
    { ...row, name: 'qwen3.5:9b-q4_K_M' },
    { ...row, connectionId: 'direct:lmstudio' },
    { ...row, source: 'vercel' },
    { ...row, features: {} },
    { ...row, features: { vision: false, reasoning: false } }
  ])('does not borrow a mismatched/unknown row: %j', other => {
    expect(projectOllamaPresetCapabilities(preset, [other])).toBeNull()
  })

  it('requires one exact row, a direct Ollama connection and a coherent draft identity', () => {
    expect(projectOllamaPresetCapabilities(preset, [row, row])).toBeNull()
    expect(projectOllamaPresetCapabilities({ ...preset, connection: { ...preset.connection, service: 'lmstudio' } }, [row])).toBeNull()
    expect(projectOllamaPresetCapabilities({ ...preset, connection: { ...preset.connection, id: undefined } }, [row])).toBeNull()
    expect(projectOllamaPresetCapabilities({ ...preset, modelId: 'changed-draft' }, [row])).toBeNull()
    expect(projectOllamaPresetCapabilities({ ...preset, effectiveModelId: null, modelId: MODEL }, [row])).toEqual({ vision: true, reasoning: true })
  })
})
