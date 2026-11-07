import { describe, expect, it } from 'vitest'

import { getModelProviderIcons, getProviderBackground, getProviderIconEntry, needsDarkModeInvert } from './brandingIcons'

describe('branding icon dark-mode inversion', () => {
  it('treats bundled mono brand icons as light-on-dark regardless of source paint', () => {
    expect(needsDarkModeInvert('/ai-branding-generated/agui-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/ai-branding-generated/adobe-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/ai-branding/codex-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/brand-icons/mcp-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/ai-branding/mimo-color.svg')).toBe(true)
  })

  it('leaves bundled color brand icons unchanged', () => {
    expect(needsDarkModeInvert('/ai-branding/adobe-color.svg')).toBe(false)
    expect(needsDarkModeInvert('/ai-branding/ai302-color.svg')).toBe(false)
  })
})

describe('branding icon resolution', () => {
  it('treats malformed runtime provider and fallback values as unknown without coercing or changing them', () => {
    let conversions = 0
    const raw = Object.freeze({ provider: 'deepgram', [Symbol.toPrimitive]() { conversions += 1; return 'deepgram' } })
    for (const value of [42, true, ['deepgram'], raw]) {
      expect(Reflect.apply(getProviderIconEntry, undefined, [value])).toEqual(getProviderIconEntry('provider-without-a-logo'))
      expect(Reflect.apply(getProviderIconEntry, undefined, ['provider-without-a-logo', 'dark', value])).toEqual(getProviderIconEntry('provider-without-a-logo', 'dark'))
      expect(Reflect.apply(getProviderIconEntry, undefined, ['deepgram', 'dark', value])).toEqual(getProviderIconEntry('deepgram', 'dark'))
      expect(Reflect.apply(getProviderIconEntry, undefined, [value, 'dark', 'deepgram'])).toEqual(getProviderIconEntry('deepgram', 'dark'))
      expect(Reflect.apply(getModelProviderIcons, undefined, ['unknown-model', value, undefined, undefined, 'dark', value])).toMatchObject({
        modelIcon: '/batshit-icon-dark-ios.png', providerIcon: '/batshit-icon-dark-ios.png', needsBackground: false, backgroundColor: undefined
      })
      expect(Reflect.apply(getProviderBackground, undefined, [value])).toBeUndefined()
    }
    expect(conversions).toBe(0)
    expect(raw.provider).toBe('deepgram')
  })
  it('retains valid provider aliases, explicit fallbacks and both theme paths', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(getProviderIconEntry('Codex', theme)).toEqual(getProviderIconEntry('codex', theme))
      expect(getProviderIconEntry('Claude', theme)).toEqual(getProviderIconEntry('anthropic', theme))
      expect(getProviderIconEntry('provider-without-a-logo', theme, 'deepgram')).toEqual(getProviderIconEntry('deepgram', theme))
    }
  })
  it('uses the refreshed color assets for the requested providers', () => {
    expect(getProviderIconEntry('anthropic').icon).toBe('/ai-branding/claude-color.svg')
    expect(getProviderIconEntry('openrouter').icon).toBe('/ai-branding/openrouter-color.svg')
    expect(getProviderIconEntry('codex').icon).toBe('/ai-branding/codex-color.svg')
    expect(getProviderIconEntry('mimo').icon).toBe('/ai-branding/mimo-color.svg')
    expect(getProviderIconEntry('deepgram').icon).toBe('/ai-branding/deepgram-color.svg')
    expect(getProviderIconEntry('async').icon).toBe('/ai-branding/async-color.svg')
    expect(getProviderIconEntry('cartesia').icon).toBe('/ai-branding/cartesia-color.svg')
    expect(getProviderIconEntry('fish').icon).toBe('/ai-branding-generated/fishaudio-mono.svg')
    expect(getProviderIconEntry('minimax').icon).toBe('/ai-branding/minimax-color.svg')
    expect(getProviderIconEntry('alibaba').icon).toBe('/ai-branding/alibaba-color.svg')
    expect(getProviderIconEntry('stepfun').icon).toBe('/ai-branding/stepfun-color.svg')
    expect(getProviderIconEntry('livekit').icon).toBe('/ai-branding/livekit-color.svg')
    expect(getProviderIconEntry('inworld').icon).toBe('/ai-branding/inworld-mono.svg')
    expect(getProviderIconEntry('azure-speech').icon).toBe('/ai-branding/azure-color.svg')
  })

  it('uses Batshit for an unknown provider and never OpenRouter as a generic fallback', () => {
    expect(getProviderIconEntry('provider-without-a-logo').icon).toBe('/batshit-icon-dark-ios.png')
  })

  it('falls an unknown model back to its provider icon', () => {
    const icons = getModelProviderIcons('unknown-model', 'deepgram')
    expect(icons.providerIcon).toBe('/ai-branding/deepgram-color.svg')
    expect(icons.modelIcon).toBe('/ai-branding/deepgram-color.svg')
  })
})
