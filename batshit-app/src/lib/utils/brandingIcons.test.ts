import { describe, expect, it } from 'vitest'

import { needsDarkModeInvert } from './brandingIcons'

describe('branding icon dark-mode inversion', () => {
  it('treats bundled mono brand icons as light-on-dark regardless of source paint', () => {
    expect(needsDarkModeInvert('/ai-branding-generated/agui-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/ai-branding-generated/adobe-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/ai-branding/codex-mono.svg')).toBe(true)
    expect(needsDarkModeInvert('/brand-icons/mcp-mono.svg')).toBe(true)
  })

  it('leaves bundled color brand icons unchanged', () => {
    expect(needsDarkModeInvert('/ai-branding/adobe-color.svg')).toBe(false)
    expect(needsDarkModeInvert('/ai-branding/ai302-color.svg')).toBe(false)
  })
})
