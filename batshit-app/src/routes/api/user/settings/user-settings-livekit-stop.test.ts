import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-1301 — LiveKit's "Stop with Batshit" reaches this Batshit's running LiveKit launch records
 * only after the settings save is confirmed, and only when that choice changed. A failed save
 * syncs nothing; a sync that fails or is incomplete never fails the save (the LiveKit row shows
 * what the records did not take).
 */

const mockGetUserSettings = vi.fn()
const mockUpdateUserSettings = vi.fn()
const mockSyncLiveKitStopPreference = vi.fn()

vi.mock('$lib/server/redis', () => ({
  RedisService: class {
    getUserSettings = (...args: any[]) => mockGetUserSettings(...args)
    updateUserSettings = (...args: any[]) => mockUpdateUserSettings(...args)
  }
}))

vi.mock('$lib/services/databaseRedis.server', () => ({
  invalidateUserSettingsCache: vi.fn()
}))

vi.mock('$lib/server/services/liveKitSidecarRuntime', () => ({
  syncLiveKitStopPreference: (...args: any[]) => mockSyncLiveKitStopPreference(...args)
}))

import { POST } from './+server'

const USER = 'user-livekit-stop'

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER, email: 'j@example.com' } }
  } as any)
}

const voice = (stopOnShutdown: boolean | undefined) => ({
  schemaVersion: 2,
  voiceRuntimes: { livekit: { startup: { autoStartOnLaunch: false, ...(stopOnShutdown === undefined ? {} : { stopOnShutdown }) } } }
})

describe('BL-1301 LiveKit Stop with Batshit reaches its launch records after a confirmed save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserSettings.mockResolvedValue({ displayName: 'Josh', voice_settings: voice(undefined) })
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, unknown>) => ({ ...updates }))
    mockSyncLiveKitStopPreference.mockResolvedValue({ complete: true, problems: [] })
  })

  it('syncs this user once, after the save is stored, when the choice changed', async () => {
    const response = await post({ voice_settings: voice(false) })

    expect(response.status).toBe(200)
    expect(mockSyncLiveKitStopPreference).toHaveBeenCalledTimes(1)
    expect(mockSyncLiveKitStopPreference).toHaveBeenCalledWith(USER)
    expect(mockUpdateUserSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncLiveKitStopPreference.mock.invocationCallOrder[0]
    )
  })

  it('does not sync when the LiveKit choice did not change (absent means stop)', async () => {
    await post({ voice_settings: voice(true) })
    expect(mockSyncLiveKitStopPreference).not.toHaveBeenCalled()
  })

  it('syncs nothing when the save fails', async () => {
    mockUpdateUserSettings.mockRejectedValueOnce(new Error('redis down'))

    const response = await post({ voice_settings: voice(false) })

    expect(response.status).toBe(500)
    expect(mockSyncLiveKitStopPreference).not.toHaveBeenCalled()
  })

  it('keeps the save when the sync fails or does not reach every record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSyncLiveKitStopPreference.mockRejectedValueOnce(new Error('lock timed out'))
    expect((await post({ voice_settings: voice(false) })).status).toBe(200)

    mockSyncLiveKitStopPreference.mockResolvedValueOnce({ complete: false, problems: ['livekit-server: unreadable'] })
    expect((await post({ voice_settings: voice(false) })).status).toBe(200)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
