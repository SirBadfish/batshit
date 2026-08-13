import { describe, expect, it } from 'vitest'

import {
  beginDesktopGoonPresentationTransition,
  commitDesktopGoonPresentationTransition,
  createDesktopGoonPresentationState,
  normalizeDesktopGoonPresentationMode,
  resolveDesktopGoonCapability,
  resolveVisibleGoonPresentationMode,
  rollbackDesktopGoonPresentationTransition
} from '$lib/goons/desktopGoonPresentation'

describe('Desktop Goon visible presentation mode', () => {
  it('prioritizes Desktop Mode and otherwise follows the visible Dock presentation', () => {
    expect(
      resolveVisibleGoonPresentationMode({
        dockOpen: true,
        immersiveMode: true,
        desktopModeActive: true
      })
    ).toBe('desktop')
    expect(
      resolveVisibleGoonPresentationMode({
        dockOpen: true,
        immersiveMode: true,
        desktopModeActive: false
      })
    ).toBe('immersive')
    expect(
      resolveVisibleGoonPresentationMode({
        dockOpen: true,
        immersiveMode: false,
        desktopModeActive: false
      })
    ).toBe('dock')
    expect(
      resolveVisibleGoonPresentationMode({
        dockOpen: false,
        immersiveMode: false,
        desktopModeActive: false
      })
    ).toBeNull()
  })

  it('rejects unknown presentation metadata', () => {
    expect(normalizeDesktopGoonPresentationMode('desktop')).toBe('desktop')
    expect(normalizeDesktopGoonPresentationMode('unknown')).toBeNull()
    expect(normalizeDesktopGoonPresentationMode(null)).toBeNull()
  })
})

describe('Desktop Goon presentation state', () => {
  it('keeps one stable presentation until an ordered transition commits', () => {
    const starting = createDesktopGoonPresentationState('immersive')
    const pending = beginDesktopGoonPresentationTransition(starting, 'desktop', 'transition-1')

    expect(pending).toMatchObject({
      mode: 'immersive',
      transition: { from: 'immersive', to: 'desktop' }
    })
    expect(commitDesktopGoonPresentationTransition(pending, 'transition-1')).toEqual({
      mode: 'desktop',
      transition: null,
      lastError: null
    })
  })

  it('recovers every Desktop failure to the in-app Dock', () => {
    const entering = beginDesktopGoonPresentationTransition(
      createDesktopGoonPresentationState('immersive'),
      'desktop',
      'enter-desktop'
    )
    expect(rollbackDesktopGoonPresentationTransition(entering, 'enter-desktop', 'Port lost')).toEqual({
      mode: 'dock',
      transition: null,
      lastError: 'Port lost'
    })

    const exiting = beginDesktopGoonPresentationTransition(
      createDesktopGoonPresentationState('desktop'),
      'dock',
      'exit-desktop'
    )
    expect(rollbackDesktopGoonPresentationTransition(exiting, 'exit-desktop', 'Window crashed').mode)
      .toBe('dock')
  })

  it('rejects stale transition acknowledgements', () => {
    const pending = beginDesktopGoonPresentationTransition(
      createDesktopGoonPresentationState(),
      'desktop',
      'current'
    )
    expect(() => commitDesktopGoonPresentationTransition(pending, 'stale')).toThrow(/does not match/)
  })
})

describe('Desktop Goon capability', () => {
  it('supports managed Electron on macOS and Windows with platform-specific workspace truth', () => {
    expect(resolveDesktopGoonCapability({ surface: 'managed-electron', platform: 'darwin' }))
      .toEqual({ available: true, platform: 'darwin', supportsAllWorkspaces: true })
    expect(resolveDesktopGoonCapability({ surface: 'managed-electron', platform: 'win32' }))
      .toEqual({ available: true, platform: 'win32', supportsAllWorkspaces: false })
  })

  it.each(['browser', 'source-web', 'docker'] as const)(
    'fails clearly on the %s surface',
    (surface) => {
      expect(resolveDesktopGoonCapability({ surface, platform: 'darwin' })).toMatchObject({
        available: false,
        code: 'MANAGED_ELECTRON_REQUIRED'
      })
    }
  )
})
