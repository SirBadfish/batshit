import { describe, expect, it } from 'vitest'
import { getParameterSchema } from '../parameter-schemas'
import { fromInputValue, toInputValue } from '$lib/utils/parameterValueAdapter'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'

/**
 * SA-102 follow-up (Josh's call 2026-09-02, Faye's steer): five provider flags
 * were `inputType: 'boolean'` with `defaultValue: false`. A toggle cannot show
 * "not set", so the Model Settings seeding effect wrote that `false` into every
 * preset the moment it was opened, and it was then sent.
 *
 * `parallel_tool_calls: false` was the one that mattered: OpenAI's own default
 * is TRUE, so Batshit had been silently disabling parallel tool calls on every
 * OpenAI preset ever opened. Confirmed in a live Execution Viewer body before
 * the fix, and confirmed absent after it.
 */
const TRI_STATE_NAMES = [
  'parallelToolCalls',
  'store',
  'strictJsonSchema',
  'openaiWebSearchExternalAccess',
  'includeThoughts'
]

function findDefinition(name: string) {
  for (const provider of ['openai', 'google', 'anthropic', 'default']) {
    const found = getParameterSchema(provider).base.find((d) => d.name === name)
    if (found) return found
  }
  return undefined
}

describe('SA-102 three-state provider flags', () => {
  it('no longer seeds a value the user never chose', () => {
    for (const name of TRI_STATE_NAMES) {
      const definition = findDefinition(name)
      expect(definition, name).toBeDefined()
      expect(definition?.defaultValue, `${name} must have no defaultValue`).toBeUndefined()
      expect(definition?.booleanTriState, `${name} must be tri-state`).toBe(true)
      expect(definition?.options?.[0]?.value, `${name} first option is "not set"`).toBe('')
    }
  })

  it('parses the two real values back into booleans, not strings', () => {
    for (const name of TRI_STATE_NAMES) {
      const definition = findDefinition(name)!
      expect(fromInputValue(definition, 'true')).toBe(true)
      expect(fromInputValue(definition, 'false')).toBe(false)
      expect(fromInputValue(definition, '')).toBeUndefined()
      expect(fromInputValue(definition, '   ')).toBeUndefined()
    }
  })

  it('still renders a value stored as a real boolean by an older preset', () => {
    const definition = findDefinition('parallelToolCalls')!
    expect(toInputValue(definition, false)).toBe('false')
    expect(toInputValue(definition, true)).toBe('true')
    expect(toInputValue(definition, undefined)).toBe('')
  })

  it('omits the flag from the request when it is not set', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-4.1',
      settings: { temperature: 0.7 }
    })
    expect(runtime.providerOptions.openai?.parallelToolCalls).toBeUndefined()
    expect(runtime.providerOptions.openai?.store).toBeUndefined()
  })

  it('sends a real boolean when the user does choose one', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-4.1',
      settings: { parallelToolCalls: false, store: true }
    })
    expect(runtime.providerOptions.openai?.parallelToolCalls).toBe(false)
    expect(runtime.providerOptions.openai?.store).toBe(true)
  })

  it('keeps a non-boolean select parsing as a string', () => {
    const webSearch = getParameterSchema('openai').base.find(
      (d) => d.name === 'openaiWebSearchContextSize'
    )!
    expect(webSearch.booleanTriState).toBeUndefined()
    expect(fromInputValue(webSearch, 'high')).toBe('high')
  })
})
