import { describe, expect, it } from 'vitest'
import {
  captureDesktopShortcut,
  formatDesktopShortcut,
  type DesktopShortcutKeyEvent
} from './desktopShortcut'

function keyEvent(patch: Partial<DesktopShortcutKeyEvent>): DesktopShortcutKeyEvent {
  return {
    key: 'g',
    code: 'KeyG',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...patch
  }
}

describe('Desktop Controls shortcut recorder', () => {
  it('records the default Mac chord as a portable Electron accelerator', () => {
    expect(captureDesktopShortcut(keyEvent({ metaKey: true, shiftKey: true }), 'darwin')).toEqual({
      kind: 'recorded',
      accelerator: 'CommandOrControl+Shift+G'
    })
  })

  it('records Control separately from Command on Mac', () => {
    expect(captureDesktopShortcut(keyEvent({ ctrlKey: true, altKey: true }), 'darwin')).toEqual({
      kind: 'recorded',
      accelerator: 'Control+Alt+G'
    })
  })

  it('maps Windows Control to the portable CommandOrControl token', () => {
    expect(captureDesktopShortcut(keyEvent({ ctrlKey: true }), 'win32')).toEqual({
      kind: 'recorded',
      accelerator: 'CommandOrControl+G'
    })
  })

  it('rejects unmodified keys and cancels on Escape', () => {
    expect(captureDesktopShortcut(keyEvent({}), 'darwin')).toMatchObject({
      kind: 'invalid'
    })
    expect(captureDesktopShortcut(keyEvent({ key: 'Escape', code: 'Escape' }), 'darwin')).toEqual({
      kind: 'cancelled'
    })
  })

  it('uses Delete or Backspace without modifiers as the reset gesture', () => {
    expect(
      captureDesktopShortcut(keyEvent({ key: 'Backspace', code: 'Backspace' }), 'darwin')
    ).toEqual({ kind: 'reset' })
  })

  it('renders familiar Mac glyphs without exposing Electron syntax', () => {
    expect(formatDesktopShortcut('CommandOrControl+Shift+G', 'darwin')).toBe('⌘ ⇧ G')
    expect(formatDesktopShortcut('CommandOrControl+Alt+Up', 'darwin')).toBe('⌘ ⌥ ↑')
  })

  it('renders conventional labels outside macOS', () => {
    expect(formatDesktopShortcut('CommandOrControl+Shift+G', 'win32')).toBe('Ctrl + Shift + G')
  })
})
