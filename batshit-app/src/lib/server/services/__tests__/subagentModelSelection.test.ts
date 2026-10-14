import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-266: an API Subagent with its own model runs through the connection the user picked.
 *
 * It used to pass no connection at all, so the model was resolved by name, and with an AI
 * Gateway key configured every such model went through `ai-gateway.vercel.sh` (Gemini 3.5
 * Flash answered empty five times there, `_local/bug-batch-2026-09-25/context/live/raw/`).
 * A Subagent now resolves its model the way a primary does: through the saved preset it names.
 */

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  },
}))

import { resolveApiSubagentModel, SubagentModelSelectionError } from '../subagentModelSelection'

const GEMINI_PRESET = {
  id: 'preset-gemini-flash',
  provider: 'google',
  modelId: 'gemini-3.5-flash',
  connection: { id: 'direct:google', type: 'direct', service: 'google' },
  settings: { temperature: 0.4 },
}

function subagent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gemini-helper',
    displayName: 'Gemini Helper',
    primary_model_provider: 'google',
    primary_model_name: 'gemini-3.5-flash',
    primary_model_preset_id: 'preset-gemini-flash',
    primary_model_connection: { id: 'direct:google', type: 'direct', service: 'google' },
    provider_specific_settings: { temperature: 0.9, maxOutputTokens: 800 },
    ...overrides,
  } as any
}

beforeEach(() => {
  store.clear()
  store.set('model:preset-gemini-flash', GEMINI_PRESET)
})

describe('resolveApiSubagentModel', () => {
  it('runs a Subagent with its own model through the connection its preset names', async () => {
    const selection = await resolveApiSubagentModel({
      subagent: subagent(),
      parentModelId: 'claude-sonnet-5',
      parentConnection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
    })
    expect(selection).toMatchObject({
      modelId: 'gemini-3.5-flash',
      connection: { id: 'direct:google', type: 'direct', service: 'google' },
      provider: 'google',
      presetId: 'preset-gemini-flash',
      inherited: false,
    })
    // BL-515: the preset's settings, never a model value left on the Subagent's record.
    expect(selection.settings).toEqual({ temperature: 0.4 })
  })

  it('BL-515: a value cleared in the preset is not handed to the run, and the Subagent keeps its own tool keys', async () => {
    store.set('model:preset-gemini-flash', { ...GEMINI_PRESET, settings: {} })
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        provider_specific_settings: {
          temperature: 1.2,
          reasoningEffort: 'high',
          customKnob: 3,
          nativeTools: { bashAccessMode: 'plan' },
        },
      }),
    })
    expect(selection.settings).toEqual({ nativeTools: { bashAccessMode: 'plan' } })
  })

  it('BL-515: a preset temperature of 0 is kept (zero is real)', async () => {
    store.set('model:preset-gemini-flash', { ...GEMINI_PRESET, settings: { temperature: 0 } })
    const selection = await resolveApiSubagentModel({ subagent: subagent() })
    expect(selection.settings).toEqual({ temperature: 0 })
  })

  it('follows the preset when the user moves it to another connection', async () => {
    store.set('model:preset-gemini-flash', {
      ...GEMINI_PRESET,
      connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter' },
    })
    const selection = await resolveApiSubagentModel({ subagent: subagent() })
    expect(selection.connection).toEqual({ id: 'openrouter', type: 'openrouter', service: 'openrouter' })
  })

  it('refuses a Subagent whose own model was saved without a preset, instead of guessing a connection', async () => {
    const legacy = subagent({ primary_model_preset_id: undefined, primary_model_connection: undefined })
    await expect(resolveApiSubagentModel({ subagent: legacy })).rejects.toThrow(SubagentModelSelectionError)
    await expect(resolveApiSubagentModel({ subagent: legacy })).rejects.toMatchObject({
      code: 'subagent_model_connection_missing',
    })
    await expect(resolveApiSubagentModel({ subagent: legacy })).rejects.toThrow(/pick its model again/)
  })

  it('refuses a preset that no longer exists', async () => {
    store.delete('model:preset-gemini-flash')
    await expect(resolveApiSubagentModel({ subagent: subagent() })).rejects.toMatchObject({
      code: 'model_preset_missing',
    })
  })

  it('inherits the parent model AND its connection when the Subagent has no model of its own', async () => {
    const parentConnection = { id: 'direct:anthropic', type: 'direct', service: 'anthropic' } as const
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        primary_model_provider: undefined,
        primary_model_name: undefined,
        primary_model_preset_id: undefined,
        primary_model_connection: undefined,
      }),
      parentModelId: 'claude-sonnet-5',
      parentConnection,
    })
    expect(selection).toMatchObject({
      modelId: 'claude-sonnet-5',
      connection: parentConnection,
      inherited: true,
      presetId: null,
    })
    expect(selection.settings).toEqual({ temperature: 0.9, maxOutputTokens: 800 })
  })

  it('refuses a Subagent with no model and no parent model to inherit', async () => {
    await expect(
      resolveApiSubagentModel({
        subagent: subagent({ primary_model_name: undefined, primary_model_preset_id: undefined }),
      }),
    ).rejects.toThrow('API Subagent needs a model selection or a parent model to inherit.')
  })
})

describe('resolveApiSubagentModel: the run settings a model call sends (BL-800)', () => {
  it('builds the sampling values and provider options of the live preset through the primary\'s mapper', async () => {
    store.set('model:preset-gemini-flash', {
      ...GEMINI_PRESET,
      settings: { temperature: 0.4, maxTokens: 800, topP: 0, thinkingBudget: 2048 },
    })
    const selection = await resolveApiSubagentModel({ subagent: subagent() })
    // Zero is a real value and blank is absent: nothing else appears.
    expect(selection.runtimeSettings.standard).toEqual({ temperature: 0.4, maxTokens: 800, topP: 0 })
    expect(selection.runtimeSettings.providerOptions).toEqual({ google: { thinkingConfig: { thinkingBudget: 2048 } } })
  })

  it('sends nothing for a preset with every value blank, and reads none of the values left on the Subagent record', async () => {
    store.set('model:preset-gemini-flash', { ...GEMINI_PRESET, settings: {} })
    const selection = await resolveApiSubagentModel({
      subagent: subagent({ provider_specific_settings: { temperature: 1.2, maxTokens: 50, customKnob: 3 } }),
    })
    expect(selection.runtimeSettings).toEqual({ standard: {}, providerOptions: {} })
  })

  it('keeps a value the model rejects out: a GPT-5 class model takes no temperature', async () => {
    store.set('model:preset-gpt-54', {
      id: 'preset-gpt-54',
      provider: 'openai',
      modelId: 'gpt-5.4',
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
      settings: { temperature: 0.4, maxTokens: 700 },
    })
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        primary_model_provider: 'openai',
        primary_model_name: 'gpt-5.4',
        primary_model_preset_id: 'preset-gpt-54',
      }),
    })
    expect(selection.runtimeSettings.standard).toEqual({ maxTokens: 700 })
  })

  it('clamps a context-sized max output the way a primary send does (the preset\'s context window rides along)', async () => {
    store.set('model:preset-gemini-flash', {
      ...GEMINI_PRESET,
      contextWindow: 8_192,
      settings: { maxTokens: 8_192 },
    })
    const selection = await resolveApiSubagentModel({ subagent: subagent() })
    expect(selection.runtimeSettings.standard.maxTokens).toBeLessThan(8_192)
  })

  it('leaves the preset\'s Prompt cache TTL out (a delegated run\'s cache points stay at five minutes, BL-184) and keeps its other provider options', async () => {
    store.set('model:preset-claude', {
      id: 'preset-claude',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
      settings: { cacheControl: '1h', disableParallelToolUse: true },
    })
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        primary_model_provider: 'anthropic',
        primary_model_name: 'claude-sonnet-4-5',
        primary_model_preset_id: 'preset-claude',
      }),
    })
    expect(selection.runtimeSettings.providerOptions).toEqual({ anthropic: { disableParallelToolUse: true } })
  })

  it('removes every cacheControl and cache_control key of every provider group, a Custom Parameter of that name included', async () => {
    // A Custom Parameter names its provider group with a dot: these are user-written keys, the
    // snake_case form and a second group included, and all of them are request-level cache settings.
    store.set('model:preset-claude', {
      id: 'preset-claude',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
      settings: {
        'anthropic.cache_control': { type: 'ephemeral', ttl: '1h' },
        'anthropic.customKnob': 3,
        'openrouter.cache_control': { type: 'ephemeral', ttl: '1h' },
        'openrouter.cacheControl': { type: 'ephemeral', ttl: '1h' },
      },
    })
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        primary_model_provider: 'anthropic',
        primary_model_name: 'claude-sonnet-4-5',
        primary_model_preset_id: 'preset-claude',
      }),
    })
    // The group that held nothing else is gone; the other option in the first group stays.
    expect(selection.runtimeSettings.providerOptions).toEqual({ anthropic: { customKnob: 3 } })
  })

  it('a preset with only a Prompt cache TTL leaves no provider options at all', async () => {
    store.set('model:preset-claude', {
      id: 'preset-claude',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
      settings: { cacheControl: '5m' },
    })
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        primary_model_provider: 'anthropic',
        primary_model_name: 'claude-sonnet-4-5',
        primary_model_preset_id: 'preset-claude',
      }),
    })
    expect(selection.runtimeSettings).toEqual({ standard: {}, providerOptions: {} })
  })

  it('a run on the parent model has no preset values to send, whatever its own settings bag holds', async () => {
    const selection = await resolveApiSubagentModel({
      subagent: subagent({
        primary_model_provider: undefined,
        primary_model_name: undefined,
        primary_model_preset_id: undefined,
        primary_model_connection: undefined,
      }),
      parentModelId: 'claude-sonnet-5',
      parentConnection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
    })
    expect(selection.runtimeSettings).toEqual({ standard: {}, providerOptions: {} })
  })
})
