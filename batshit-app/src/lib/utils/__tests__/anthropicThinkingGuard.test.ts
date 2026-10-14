import { describe, expect, it } from 'vitest'

import { buildRuntimeModelSettings } from '../modelSettingsMapper'
import {
  AnthropicThinkingRefusedError,
  refuseAnthropicThinkingTheModelRejects
} from '../anthropicThinkingGuard'

/**
 * The AI SDK set of 2026-09-29 (`@ai-sdk/anthropic` 4.0.67) rewrites a thinking setting these
 * Claude models refuse, with only an SDK warning nobody reads: Opus 5.5, Fable 5, and Fable 5.1
 * lose `disabled` and a budget (sent as nothing, or as `adaptive`), and Sonnet 5.5 gets
 * `between_tools` for `disabled` and `adaptive` for a budget (measured through the real
 * packages: `_local/session-d-2026-09-29/aisdk/wire-*.json`). Before the move the same settings
 * reached Anthropic, which answers 400. Batshit neither sends a value the model refuses nor lets
 * it be swapped without a word: the send stops with a sentence that says what to change.
 */
describe('refuseAnthropicThinkingTheModelRejects', () => {
  const refuses = (modelId: string, thinking: Record<string, unknown>, extra: Record<string, unknown> = {}) => () =>
    refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId, providerOptions: { anthropic: { thinking } }, ...extra })

  it('refuses Disabled and Enabled with a budget on the models that always think', () => {
    for (const modelId of ['claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1']) {
      expect(refuses(modelId, { type: 'disabled' })).toThrow(AnthropicThinkingRefusedError)
      expect(refuses(modelId, { type: 'enabled', budgetTokens: 2048 })).toThrow(AnthropicThinkingRefusedError)
      expect(refuses(modelId, { budgetTokens: 2048 })).toThrow(AnthropicThinkingRefusedError)
    }
  })

  it('refuses Disabled and Enabled on Claude Sonnet 5.5, and lets between_tools through', () => {
    expect(refuses('claude-sonnet-5-5', { type: 'disabled' })).toThrow(AnthropicThinkingRefusedError)
    expect(refuses('claude-sonnet-5-5', { type: 'enabled', budgetTokens: 1024 })).toThrow(AnthropicThinkingRefusedError)
    expect(refuses('claude-sonnet-5-5', { type: 'between_tools' })).not.toThrow()
  })

  it('says what to change, with a status and a code the send answers with', () => {
    let caught: unknown = null
    try {
      refuses('claude-opus-5-5', { type: 'disabled' })()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AnthropicThinkingRefusedError)
    const error = caught as AnthropicThinkingRefusedError
    expect(error.status).toBe(400)
    expect(error.code).toBe('model_setting_unsupported')
    expect(error.message).toContain('Claude Opus 5.5')
    expect(error.message).toContain('Settings → Models')
    expect(error.message).toContain('Thinking mode')
  })

  it('lets blank, adaptive, and every other model through as before', () => {
    expect(refuses('claude-opus-5-5', {})).not.toThrow()
    expect(refuses('claude-opus-5-5', { type: 'adaptive' })).not.toThrow()
    expect(() => refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId: 'claude-opus-5-5', providerOptions: {} })).not.toThrow()
    for (const modelId of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-5']) {
      expect(refuses(modelId, { type: 'disabled' })).not.toThrow()
      expect(refuses(modelId, { type: 'enabled', budgetTokens: 2048 })).not.toThrow()
    }
  })

  it('knows the models by the gateway and OpenRouter spellings too', () => {
    expect(refuses('anthropic/claude-opus-5.5', { type: 'disabled' })).toThrow(AnthropicThinkingRefusedError)
    expect(refuses('anthropic/claude-sonnet-5.5', { type: 'disabled' })).toThrow(AnthropicThinkingRefusedError)
    expect(refuses('claude-fable-5-1-20260901', { type: 'disabled' })).toThrow(AnthropicThinkingRefusedError)
    expect(() =>
      refuseAnthropicThinkingTheModelRejects({ provider: 'gateway', modelId: null, vercelId: 'anthropic/claude-fable-5', providerOptions: { anthropic: { thinking: { type: 'disabled' } } } })
    ).toThrow(AnthropicThinkingRefusedError)
  })
})

describe('only where the setting is sent (review, 2026-09-29)', () => {
  const opusOff = { anthropic: { thinking: { type: 'disabled' } } }
  it('leaves OpenRouter alone: it reads only providerOptions.openrouter, so the setting never leaves', () => {
    expect(() =>
      refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId: 'claude-opus-5.5', connection: { type: 'openrouter' }, providerOptions: opusOff })
    ).not.toThrow()
    expect(() =>
      buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-opus-5.5', connection: { type: 'openrouter' }, settings: { thinkingMode: 'disabled' } } as any)
    ).not.toThrow()
  })

  it('leaves a direct connection to another service alone', () => {
    expect(() =>
      refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId: 'claude-opus-5-5', connection: { type: 'direct', service: 'custom_proxy' }, providerOptions: opusOff })
    ).not.toThrow()
  })

  it('refuses on direct Anthropic, on the Vercel AI Gateway, and with no connection named', () => {
    for (const connection of [{ type: 'direct', service: 'anthropic' }, { type: 'vercel-gateway' }, null, undefined]) {
      expect(() =>
        refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId: 'claude-opus-5-5', connection, providerOptions: opusOff })
      ).toThrow(AnthropicThinkingRefusedError)
    }
  })
})

describe('the sentence names what was saved (review, 2026-09-29)', () => {
  const message = (thinking: Record<string, unknown>) => {
    try {
      refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId: 'claude-opus-5-5', providerOptions: { anthropic: { thinking } } })
    } catch (error) {
      return (error as Error).message
    }
    return ''
  }
  it('a budget alone is a Thinking budget, not Enabled; Enabled is spelled as the panel spells it', () => {
    expect(message({ budgetTokens: 2048 })).toContain("this model preset's Thinking budget cannot be sent")
    expect(message({ budgetTokens: 2048 })).not.toContain('Enabled')
    expect(message({ type: 'enabled' })).toContain('Thinking mode Enabled')
    expect(message({ type: 'enabled', budgetTokens: 2048 })).toContain('Thinking mode Enabled with a Thinking budget')
    expect(message({ type: 'disabled' })).toContain('Thinking mode Disabled')
  })

  it('knows Fable 5 by any spelling that is not Fable 5.1', () => {
    expect(() =>
      refuseAnthropicThinkingTheModelRejects({ provider: 'anthropic', modelId: 'claude-fable-5-latest', providerOptions: { anthropic: { thinking: { type: 'disabled' } } } })
    ).toThrow(AnthropicThinkingRefusedError)
  })
})

describe('buildRuntimeModelSettings refuses a thinking setting the model rejects', () => {
  it('stops at the preset, before any request is built', () => {
    expect(() =>
      buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-opus-5-5', settings: { thinkingMode: 'disabled' } } as any)
    ).toThrow(AnthropicThinkingRefusedError)
    expect(() =>
      buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-fable-5-1', settings: { thinkingMode: 'enabled', thinkingBudget: 2048 } } as any)
    ).toThrow(AnthropicThinkingRefusedError)
  })

  it('a blank setting and an older model build as before', () => {
    expect(buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-opus-5-5', settings: {} } as any).providerOptions).toEqual({})
    expect(
      buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { thinkingMode: 'enabled', thinkingBudget: 2048 } } as any)
        .providerOptions
    ).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } })
  })
})
