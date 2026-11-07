import { describe, expect, it } from 'vitest'
import { applyAppLook, DEFAULT_APP_LOOK, normalizeAppearanceSettings, resolveAppLook } from './appLook'

describe('the app look', () => {
  it('reads the saved look and gives everything else the default (Cave)', () => {
    expect(DEFAULT_APP_LOOK).toBe('cave')
    expect(resolveAppLook({ appearance_settings: { look: 'minimal' } })).toBe('minimal')
    expect(resolveAppLook({ appearance_settings: { look: 'og' } })).toBe('og')
    for (const settings of [null, undefined, {}, { appearance_settings: null }, { appearance_settings: { look: 'neon' } }, { appearance_settings: { look: 3 } }]) {
      expect(resolveAppLook(settings)).toBe('cave')
    }
  })

  it('stores only {look} with a named look and refuses anything else as a 400', () => {
    expect(normalizeAppearanceSettings({ look: 'og' })).toEqual({ look: 'og' })
    for (const bad of [null, 'cave', ['cave'], {}, { look: 'neon' }, { look: 'cave', accent: 'pink' }]) {
      expect(() => normalizeAppearanceSettings(bad)).toThrow(expect.objectContaining({ status: 400 }))
    }
  })

  it('paints the look on the root element', () => {
    const root = document.createElement('html')
    applyAppLook('minimal', root)
    expect(root.dataset.look).toBe('minimal')
    applyAppLook('og', root)
    expect(root.dataset.look).toBe('og')
  })
})
