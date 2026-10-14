import { beforeEach, describe, expect, it } from 'vitest'
import {
  confirmUserSettings,
  failUserSettingsRead,
  getUserSettings,
  getUserSettingsReadError,
  getUserSettingsReadState,
  resetUserSettings,
  setUserSettings,
  updateUserSettings
} from './userSettings.svelte'

describe('user settings read state (BL-975 D1–D2)', () => {
  beforeEach(() => resetUserSettings())

  it('starts unread with no value or error', () => {
    expect(getUserSettingsReadState()).toBe('unread')
    expect(getUserSettingsReadError()).toBeNull()
    expect(getUserSettings()).toBeNull()
  })

  it('keeps set/update as value-only operations; neither confirms a read', () => {
    setUserSettings({ displayName: 'A cached layout copy' } as any)
    expect(getUserSettings()).toEqual({ displayName: 'A cached layout copy' })
    expect(getUserSettingsReadState()).toBe('unread')
    expect(getUserSettingsReadError()).toBeNull()

    updateUserSettings({ goons_settings: { dockOpen: true } } as any)
    expect(getUserSettings()).toEqual({
      displayName: 'A cached layout copy',
      goons_settings: { dockOpen: true }
    })
    expect(getUserSettingsReadState()).toBe('unread')
  })

  it('confirms an authoritative settings object and clears an earlier read error', () => {
    failUserSettingsRead(new Error('temporary read failure'))
    expect(getUserSettingsReadState()).toBe('failed')

    const serverSettings = { displayName: 'Current', goons_settings: { dockOpen: false } }
    confirmUserSettings(serverSettings as any)

    expect(getUserSettingsReadState()).toBe('confirmed')
    expect(getUserSettingsReadError()).toBeNull()
    expect(getUserSettings()).toEqual(serverSettings)
  })

  it('treats a successful 200 with settings:null as a confirmed empty record', () => {
    confirmUserSettings(null)

    expect(getUserSettingsReadState()).toBe('confirmed')
    expect(getUserSettingsReadError()).toBeNull()
    expect(getUserSettings()).toEqual({})
  })

  it('marks a failed read before confirmation without manufacturing confirmation', () => {
    failUserSettingsRead(new Error('settings service unavailable'))

    expect(getUserSettingsReadState()).toBe('failed')
    expect(getUserSettingsReadError()).toBe('settings service unavailable')
    expect(getUserSettings()).toBeNull()
  })

  it('keeps the confirmed value and state when a later refresh fails, while showing the error', () => {
    const confirmed = { goons_settings: { kitchen: { scenes: { scene: { name: 'Saved' } } } } }
    confirmUserSettings(confirmed as any)

    failUserSettingsRead(new Error('refresh failed'))

    expect(getUserSettingsReadState()).toBe('confirmed')
    expect(getUserSettingsReadError()).toBe('refresh failed')
    expect(getUserSettings()).toEqual(confirmed)
  })

  it('allows a later successful refresh or save answer to clear a retained error', () => {
    const confirmed = { displayName: 'Saved name' }
    confirmUserSettings(confirmed as any)
    failUserSettingsRead(new Error('offline'))
    confirmUserSettings({ ...confirmed, displayName: 'Newest name' } as any)

    expect(getUserSettingsReadState()).toBe('confirmed')
    expect(getUserSettingsReadError()).toBeNull()
    expect(getUserSettings()).toEqual({ displayName: 'Newest name' })
  })

  it('reset returns the store to null/unread/no-error', () => {
    confirmUserSettings({ displayName: 'Saved' } as any)
    failUserSettingsRead(new Error('refresh failed'))

    resetUserSettings()

    expect(getUserSettings()).toBeNull()
    expect(getUserSettingsReadState()).toBe('unread')
    expect(getUserSettingsReadError()).toBeNull()
  })
})
