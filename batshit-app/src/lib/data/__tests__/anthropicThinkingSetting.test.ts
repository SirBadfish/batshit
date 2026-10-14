import { describe, expect, it } from 'vitest'
import { filterParameters } from '$lib/utils/parameterFilter'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import {
  AnthropicThinkingRefusedError,
  isModelSettingRefusal
} from '$lib/utils/anthropicThinkingGuard'
import { describeUnlistedSelectValue, toInputValue } from '$lib/utils/parameterValueAdapter'
import type { ParameterValue } from '../parameter-schemas'

/**
 * BL-866: Claude Sonnet 5.5 (`claude-sonnet-5-5`) refuses `thinking: disabled` and
 * `thinking: enabled` (Anthropic answers 400 to both) and takes `between_tools` as its lowest
 * setting. `between_tools` takes no other field: no budget, no display.
 *
 * These pin the parts of that rule that are Batshit's own: what the Models panel offers per
 * model, what the mapper hands the provider for each saved value, and that a value the model
 * refuses is refused out loud instead of being swapped for another one.
 */

const SONNET_5_5_IDS = [
  { modelId: 'claude-sonnet-5-5' },
  // The AI Gateway and OpenRouter spell the version with a dot and a developer prefix.
  { modelId: 'claude-sonnet-5.5' },
  { modelId: 'anthropic/claude-sonnet-5.5' },
  { modelId: 'claude-sonnet-5-5-20260928' },
  { modelId: 'claude-sonnet-5.5-20260928' },
  { modelId: 'gateway-preset', vercelId: 'anthropic/claude-sonnet-5.5' }
]

/**
 * The Claude models that always think (Opus 5.5, Fable 5, Fable 5.1). The panel offers Disabled,
 * Enabled and a budget for them as for any Claude model; a send that carries Disabled or Enabled
 * is refused by the Thinking guard (`anthropicThinkingGuard.ts`) before a request is built.
 */
const ALWAYS_THINKING_IDS = ['claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1']

/** Every other Claude model Batshit offers a Thinking mode for: each sends what is saved. */
const OTHER_CLAUDE_IDS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  // Sonnet 5 is not Sonnet 5.5.
  'claude-sonnet-5',
  'claude-sonnet-5-20260601',
  // A longer name that only starts with the same characters is another model: the Thinking guard's
  // own rule (`^claude-sonnet-5-5(?:-|$)`) does not match it either.
  'claude-sonnet-5-50',
  'claude-sonnet-5-5x',
  'claude-sonnet-5.50',
  'anthropic/claude-sonnet-4.5'
]

function thinkingParameters(model: { modelId: string; vercelId?: string }) {
  const definitions = filterParameters({ provider: 'anthropic', ...model })
  return {
    mode: definitions.find((definition) => definition.name === 'thinkingMode'),
    budget: definitions.find((definition) => definition.name === 'thinkingBudget')
  }
}

function anthropicOptions(
  modelId: string,
  settings: Record<string, ParameterValue>,
  extra: { connection?: any; vercelId?: string | null } = {}
) {
  return buildRuntimeModelSettings({ provider: 'anthropic', modelId, settings, ...extra }).providerOptions
    .anthropic
}

describe('BL-866 Thinking mode choices per model', () => {
  it.each(SONNET_5_5_IDS)('offers Sonnet 5.5 only Between tools, and no budget ($modelId)', (model) => {
    const { mode, budget } = thinkingParameters(model)
    expect(mode?.inputType).toBe('select')
    expect(mode?.options?.map((option) => option.value)).toEqual(['between_tools'])
    expect(mode?.providerOptionKey).toBe('anthropic.thinking.type')
    // It takes no budget: the field is not offered, so it can never be sent.
    expect(budget).toBeUndefined()
  })

  it.each([...OTHER_CLAUDE_IDS, ...ALWAYS_THINKING_IDS])('leaves %s with Disabled, Enabled and a budget', (modelId) => {
    const { mode, budget } = thinkingParameters({ modelId })
    expect(mode?.options).toEqual([
      { label: 'Disabled', value: 'disabled' },
      { label: 'Enabled', value: 'enabled' }
    ])
    expect(budget?.providerOptionKey).toBe('anthropic.thinking.budgetTokens')
  })

  it('offers no Anthropic Thinking mode to another developer\'s model', () => {
    const definitions = filterParameters({ provider: 'openai', modelId: 'gpt-5.5' })
    expect(definitions.some((definition) => definition.name === 'thinkingMode')).toBe(false)
  })
})

describe('BL-866 what the mapper hands the provider on Sonnet 5.5', () => {
  it.each(SONNET_5_5_IDS.map((model) => model.modelId))('blank sends no thinking field at all (%s)', (modelId) => {
    expect(anthropicOptions(modelId, {})).toBeUndefined()
  })

  it('sends between_tools alone: no budget', () => {
    expect(anthropicOptions('claude-sonnet-5-5', { thinkingMode: 'between_tools' })).toEqual({
      thinking: { type: 'between_tools' }
    })
  })

  it('never sends a saved budget beside between_tools, even a zero', () => {
    for (const budget of [2048, 0]) {
      const options = anthropicOptions('claude-sonnet-5-5', {
        thinkingMode: 'between_tools',
        thinkingBudget: budget
      })
      expect(options).toEqual({ thinking: { type: 'between_tools' } })
      expect(JSON.stringify(options)).not.toContain('budget')
    }
  })

  it('sends a saved budget alone as nothing', () => {
    expect(anthropicOptions('claude-sonnet-5-5', { thinkingBudget: 2048 })).toBeUndefined()
  })

  it('sends a saved Disabled as between_tools: the value the model takes for "no thinking up front"', () => {
    expect(anthropicOptions('claude-sonnet-5-5', { thinkingMode: 'disabled' })).toEqual({
      thinking: { type: 'between_tools' }
    })
    expect(
      anthropicOptions('claude-sonnet-5-5', { thinkingMode: 'disabled', thinkingBudget: 2048 })
    ).toEqual({ thinking: { type: 'between_tools' } })
  })

  it('maps the same on the AI Gateway spelling of the id', () => {
    const connection = { type: 'vercel-gateway' as const, service: 'vercel-gateway' }
    for (const modelId of ['anthropic/claude-sonnet-5.5', 'claude-sonnet-5.5']) {
      expect(anthropicOptions(modelId, { thinkingMode: 'disabled' }, { connection })).toEqual({
        thinking: { type: 'between_tools' }
      })
    }
  })

  it('refuses a saved Enabled out loud: never sent, never swapped for another value', () => {
    const settings = { thinkingMode: 'enabled', thinkingBudget: 2048 }
    let refusal: unknown
    try {
      anthropicOptions('claude-sonnet-5-5', settings)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(AnthropicThinkingRefusedError)
    const error = refusal as AnthropicThinkingRefusedError
    expect(error.status).toBe(400)
    expect(error.code).toBe('model_setting_unsupported')
    expect(error.message).toContain('Thinking mode "enabled"')
    expect(error.message).toContain('claude-sonnet-5-5')
    expect(error.message).toContain('Between tools')
  })

  it('does not put the refusal on a Custom Parameter that names the same key', () => {
    // A user-authored `anthropic.thinking.type` is the user's own wire value, not a Batshit
    // parameter: this mapping leaves it alone. The Thinking guard still refuses `disabled` and
    // `enabled` there (its own test), and lets `adaptive` through (the case tested here).
    expect(
      anthropicOptions('claude-sonnet-5-5', { 'anthropic.thinking.type': 'adaptive' })
    ).toEqual({ thinking: { type: 'adaptive' } })
  })
})

describe('BL-866 every other Claude model is mapped exactly as before', () => {
  it.each(OTHER_CLAUDE_IDS)('%s: Disabled, Enabled plus budget, blank, and a zero budget', (modelId) => {
    expect(anthropicOptions(modelId, {})).toBeUndefined()
    expect(anthropicOptions(modelId, { thinkingMode: 'disabled' })).toEqual({
      thinking: { type: 'disabled' }
    })
    expect(anthropicOptions(modelId, { thinkingMode: 'enabled', thinkingBudget: 2048 })).toEqual({
      thinking: { type: 'enabled', budgetTokens: 2048 }
    })
    // Zero is a real value: it is sent, not dropped as blank.
    expect(anthropicOptions(modelId, { thinkingMode: 'enabled', thinkingBudget: 0 })).toEqual({
      thinking: { type: 'enabled', budgetTokens: 0 }
    })
  })
})

function refusalOf(modelId: string, settings: Record<string, ParameterValue>): AnthropicThinkingRefusedError {
  let caught: unknown
  try {
    anthropicOptions(modelId, settings)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AnthropicThinkingRefusedError)
  return caught as AnthropicThinkingRefusedError
}

describe('BL-866 the Sonnet 5.5 mapping and the Thinking guard run in one order, with one error class', () => {
  it('a saved Disabled on Sonnet 5.5 ends as between_tools and the guard does not refuse it', () => {
    // The mapper turns Disabled into between_tools BEFORE the guard at the end of
    // buildRuntimeModelSettings looks: the guard refuses `disabled` for this model, so a
    // refusal here would mean the order is the other way round.
    for (const modelId of ['claude-sonnet-5-5', 'claude-sonnet-5-5-20260901', 'anthropic/claude-sonnet-5.5']) {
      expect(anthropicOptions(modelId, { thinkingMode: 'disabled' })).toEqual({
        thinking: { type: 'between_tools' }
      })
    }
  })

  it('a saved Enabled on Sonnet 5.5 is refused one time, with the mapper\'s one sentence', () => {
    const error = refusalOf('claude-sonnet-5-5', { thinkingMode: 'enabled', thinkingBudget: 2048 })
    // The mapper's sentence (it names what the model offers) and not the guard's, which says the
    // model "cannot turn thinking off": the mapper refused first and the guard never ran.
    expect(error.message).toContain('Thinking mode "enabled"')
    expect(error.message).toContain('Between tools')
    expect(error.message).not.toContain('cannot turn thinking off')
    expect(error.message.match(/Open Settings/g)).toHaveLength(1)
  })

  it.each(ALWAYS_THINKING_IDS)('%s: blank sends nothing; a saved Disabled or Enabled is refused by the guard', (modelId) => {
    expect(anthropicOptions(modelId, {})).toBeUndefined()
    for (const settings of [{ thinkingMode: 'disabled' }, { thinkingMode: 'enabled', thinkingBudget: 2048 }]) {
      const error = refusalOf(modelId, settings)
      expect(error.message).toContain('always thinks')
    }
  })

  it('a saved Enabled on Sonnet 5.5 is refused only where the setting would be sent', () => {
    const enabled = { thinkingMode: 'enabled', thinkingBudget: 2048 }
    // Direct Anthropic, the AI Gateway, and a preset with no connection send `providerOptions.anthropic`.
    for (const connection of [undefined, { type: 'direct', service: 'anthropic' }, { type: 'vercel-gateway', service: 'vercel-gateway' }]) {
      expect(() => anthropicOptions('anthropic/claude-sonnet-5.5', enabled, { connection })).toThrow(
        AnthropicThinkingRefusedError
      )
    }
    // OpenRouter and a direct connection to another service never send it, so nothing there can
    // fail: the Thinking guard skips them (its own test pins that), and so does this refusal.
    for (const connection of [{ type: 'openrouter', service: 'openrouter' }, { type: 'direct', service: 'custom-host' }]) {
      expect(() => anthropicOptions('anthropic/claude-sonnet-5.5', enabled, { connection })).not.toThrow()
    }
  })

  it('both refusals are one class with one status and code, and a Subagent run reads both', () => {
    const fromMapper = refusalOf('claude-sonnet-5-5', { thinkingMode: 'enabled' })
    const fromGuard = refusalOf('claude-opus-5-5', { thinkingMode: 'disabled' })
    expect(fromMapper.constructor).toBe(fromGuard.constructor)
    for (const error of [fromMapper, fromGuard]) {
      expect(error.status).toBe(400)
      expect(error.code).toBe('model_setting_unsupported')
      expect(isModelSettingRefusal(error)).toBe(true)
    }
  })
})

describe('BL-866 the picker shows the value that will be sent', () => {
  it('shows a saved Disabled as Between tools on Sonnet 5.5', () => {
    const { mode } = thinkingParameters({ modelId: 'claude-sonnet-5-5' })
    expect(toInputValue(mode!, 'disabled')).toBe('between_tools')
    expect(toInputValue(mode!, 'between_tools')).toBe('between_tools')
    // The alias is for the saved value only; a blank stays blank.
    expect(toInputValue(mode!, undefined)).toBe('')
  })

  it('leaves a saved Disabled as Disabled on every other Claude model', () => {
    const { mode } = thinkingParameters({ modelId: 'claude-sonnet-4-5' })
    expect(toInputValue(mode!, 'disabled')).toBe('disabled')
  })

  it('names the value a model does not offer, and stays quiet for one it does', () => {
    const { mode } = thinkingParameters({ modelId: 'claude-sonnet-5-5' })
    expect(describeUnlistedSelectValue(mode!, 'enabled')).toContain('Thinking mode "enabled"')
    expect(describeUnlistedSelectValue(mode!, 'between_tools')).toBeNull()
    // A saved Disabled is shown (and sent) as Between tools, so it is not unlisted.
    expect(describeUnlistedSelectValue(mode!, 'disabled')).toBeNull()
    expect(describeUnlistedSelectValue(mode!, '')).toBeNull()

    const other = thinkingParameters({ modelId: 'claude-sonnet-4-5' }).mode!
    // Only a definition that asks for the check gets one.
    expect(describeUnlistedSelectValue(other, 'adaptive')).toBeNull()
  })
})
