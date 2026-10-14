import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  isInternalDevPanelEnabled: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  RedisService: class {
    getUserSettings(userId: string) {
      return mocks.getUserSettings(userId)
    }
  }
}))

vi.mock('$lib/server/internalDevPanel', () => ({
  isInternalDevPanelEnabled: () => mocks.isInternalDevPanelEnabled()
}))

import { load } from './+layout.server'

const USER = { id: 'layout-settings-user', email: 'layout-settings@example.com' }

describe('root layout user-settings read state', () => {
  beforeEach(() => {
    mocks.getUserSettings.mockReset()
    mocks.isInternalDevPanelEnabled.mockReset().mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks a saved settings object as a confirmed read', async () => {
    const saved = { id: 'settings-1', goons_settings: { kitchen: { scenes: { room: {} } } } }
    mocks.getUserSettings.mockResolvedValue(saved)

    const result = await load({ locals: { user: USER } } as any)

    expect(result).toEqual({
      user: USER,
      userSettings: saved,
      userSettingsReadSucceeded: true,
      userSettingsReadError: null,
      internalDevPanelEnabled: true
    })
    expect(mocks.getUserSettings).toHaveBeenCalledOnce()
    expect(mocks.getUserSettings).toHaveBeenCalledWith(USER.id)
  })

  it('distinguishes a successful explicit null (no saved record) from a failed read', async () => {
    mocks.getUserSettings.mockResolvedValue(null)

    const result = await load({ locals: { user: USER } } as any)

    expect(result.userSettings).toBeNull()
    expect(result.userSettingsReadSucceeded).toBe(true)
    expect(result.userSettingsReadError).toBeNull()
  })

  it.each([
    ['array', []],
    ['string', 'malformed settings'],
    ['undefined', undefined]
  ])('treats fulfilled %s Redis results as an unconfirmed read', async (_label, malformedValue) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.getUserSettings.mockResolvedValue(malformedValue)

    const result = await load({ locals: { user: USER } } as any)

    expect(result.userSettings).toBeNull()
    expect(result.userSettingsReadSucceeded).toBe(false)
    expect(result.userSettingsReadError).toBe('User settings could not load')
    expect(errorSpy).toHaveBeenCalledWith('Error loading user settings:', expect.any(Error))
  })

  it('returns an unconfirmed state and a stable visible error when Redis rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.getUserSettings.mockRejectedValue(new Error('private Redis detail'))

    const result = await load({ locals: { user: USER } } as any)

    expect(result.userSettings).toBeNull()
    expect(result.userSettingsReadSucceeded).toBe(false)
    expect(result.userSettingsReadError).toBe('User settings could not load')
    expect(mocks.getUserSettings).toHaveBeenCalledWith(USER.id)
    expect(errorSpy).toHaveBeenCalledWith('Error loading user settings:', expect.any(Error))
    expect(JSON.stringify(result)).not.toContain('private Redis detail')
  })

  it('does not claim a settings read for an unauthenticated layout request', async () => {
    const result = await load({ locals: {} } as any)

    expect(result).toEqual({
      user: undefined,
      userSettings: null,
      userSettingsReadSucceeded: false,
      userSettingsReadError: null,
      internalDevPanelEnabled: true
    })
    expect(mocks.getUserSettings).not.toHaveBeenCalled()
  })
})
