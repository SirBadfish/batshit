import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CONTROLS_SCHEMA_VERSION,
  getDesktopControlsNativeBridge
} from './desktopControlsNativeBridge'

afterEach(() => {
  delete (window as typeof window & { zero?: unknown }).zero
})

describe('Desktop Controls native bridge', () => {
  it('accepts only the expected role and schema', () => {
    const bridge = {
      schemaVersion: DESKTOP_CONTROLS_SCHEMA_VERSION,
      role: 'controls' as const,
      invoke: vi.fn(),
      onState: vi.fn()
    }
    ;(window as typeof window & { zero?: unknown }).zero = {
      desktopControls: bridge
    }

    expect(getDesktopControlsNativeBridge('controls')).toBe(bridge)
    expect(getDesktopControlsNativeBridge('main')).toBeNull()
  })

  it('rejects missing or malformed preload surfaces', () => {
    expect(getDesktopControlsNativeBridge('controls')).toBeNull()
    ;(window as typeof window & { zero?: unknown }).zero = {
      desktopControls: {
        schemaVersion: 'desktop-controls/other',
        role: 'controls',
        invoke: vi.fn(),
        onState: vi.fn()
      }
    }
    expect(getDesktopControlsNativeBridge('controls')).toBeNull()
  })
})
