import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BATSHIT_SETTINGS_PANEL_OPEN_CLASS,
  BATSHIT_TOAST_SCOPE_APP_CLASS,
  BATSHIT_TOAST_SCOPE_SETTINGS_CLASS,
  mergeToastScopeClass,
  scopeToastOptions
} from './toast-scope'

const stylesheet = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8')

function extractCssRule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{[^}]+\\}`))
  if (!match) throw new Error(`Missing CSS rule: ${selector}`)
  return match[0]
}

afterEach(() => {
  document.documentElement.classList.remove(BATSHIT_SETTINGS_PANEL_OPEN_CLASS)
  document.body.removeAttribute('style')
  document.head.querySelector('[data-toast-scope-test]')?.remove()
  document.body.replaceChildren()
})

describe('toast scope contracts', () => {
  it('preserves an explicit scope and adds the requested default only once', () => {
    expect(mergeToastScopeClass('custom', 'settings')).toBe(
      `custom ${BATSHIT_TOAST_SCOPE_SETTINGS_CLASS}`
    )
    expect(mergeToastScopeClass(BATSHIT_TOAST_SCOPE_APP_CLASS, 'settings')).toBe(
      BATSHIT_TOAST_SCOPE_APP_CLASS
    )
    expect(scopeToastOptions({ class: 'custom', duration: 50 }, 'app')).toEqual({
      class: `custom ${BATSHIT_TOAST_SCOPE_APP_CLASS}`,
      duration: 50
    })
  })

  it('restores pointer interaction to the Sonner portal while the modal Settings sheet is open', () => {
    const selector = ':root.batshit-settings-panel-open [data-sonner-toaster]'
    const style = document.createElement('style')
    style.dataset.toastScopeTest = 'true'
    style.textContent = extractCssRule(selector)
    document.head.append(style)

    document.body.style.pointerEvents = 'none'
    const toaster = document.createElement('ol')
    toaster.setAttribute('data-sonner-toaster', '')
    document.body.append(toaster)

    expect(getComputedStyle(toaster).pointerEvents).toBe('none')
    document.documentElement.classList.add(BATSHIT_SETTINGS_PANEL_OPEN_CLASS)
    expect(getComputedStyle(toaster).pointerEvents).toBe('auto')
  })

  it('hides app-scoped toasts without hiding Settings-scoped feedback', () => {
    const selector = ':root.batshit-settings-panel-open .batshit-toast-scope-app'
    const style = document.createElement('style')
    style.dataset.toastScopeTest = 'true'
    style.textContent = extractCssRule(selector)
    document.head.append(style)
    document.documentElement.classList.add(BATSHIT_SETTINGS_PANEL_OPEN_CLASS)

    const appToast = document.createElement('li')
    appToast.className = BATSHIT_TOAST_SCOPE_APP_CLASS
    const settingsToast = document.createElement('li')
    settingsToast.className = BATSHIT_TOAST_SCOPE_SETTINGS_CLASS
    document.body.append(appToast, settingsToast)

    expect(getComputedStyle(appToast).display).toBe('none')
    expect(getComputedStyle(settingsToast).display).not.toBe('none')
  })
})
