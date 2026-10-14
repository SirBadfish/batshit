import { describe, expect, it, vi } from 'vitest'
import { persistGoonsSettingsPatchRequest, refreshUserSettingsRequest } from './goonsSettingsPersistence'

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

describe('persistGoonsSettingsPatchRequest (BL-975 D4/D6)', () => {
  it('posts only the owned section and returns the complete server-confirmed user settings', async () => {
    const patch = {
      kitchen: {
        scenes: { edited: { id: 'edited', name: 'Edited scene' } }
      }
    }
    const confirmed = {
      displayName: 'Josh',
      voice_settings: { voiceMode: { submitMode: 'manual' } },
      goons_settings: {
        dockOpen: false,
        desktop: { fullHeight: false, clickThrough: true },
        globalCloset: { items: { coat: { id: 'coat' } } },
        kitchen: {
          scenes: { edited: { id: 'edited', name: 'Edited scene' } },
          cues: { saved: { id: 'saved', name: 'Saved cue' } }
        }
      }
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, settings: confirmed }))

    await expect(persistGoonsSettingsPatchRequest(fetcher, patch as any)).resolves.toEqual(confirmed)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goons_settings_patch: patch })
    })
  })

  it('throws the server error on a non-OK patch response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'Settings store unavailable' }, { status: 503 })
    )

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).rejects.toThrow(
      'Settings store unavailable'
    )
  })

  it('throws when a successful patch response omits the canonical settings envelope', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true }))

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).rejects.toThrow(
      /settings.*response|user settings/i
    )
  })

  it('does not treat the legacy userSettings alias as the canonical save answer', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, userSettings: { goons_settings: { dockOpen: false } } })
    )

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).rejects.toThrow(
      /settings.*response|user settings/i
    )
  })

  it('requires the full server settings answer to include its merged goons_settings section', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, settings: { displayName: 'Josh' } })
    )

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).rejects.toThrow(
      /goon settings|settings.*response/i
    )
  })

  it('throws when the server reports success:false', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'Patch refused' }))

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).rejects.toThrow(
      'Patch refused'
    )
  })
})

describe('refreshUserSettingsRequest (BL-975 D2)', () => {
  it('returns the authoritative full server settings object', async () => {
    const serverSettings = {
      displayName: 'Current name',
      voice_settings: { goonLipSync: { mode: 'amplitude' } },
      goons_settings: { dockOpen: true }
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ settings: serverSettings }))

    await expect(refreshUserSettingsRequest(fetcher)).resolves.toEqual(serverSettings)
    expect(fetcher).toHaveBeenCalledWith('/api/user/settings', { cache: 'no-store' })
  })

  it('treats a successful explicit settings:null as a confirmed empty record', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ settings: null }))

    await expect(refreshUserSettingsRequest(fetcher)).resolves.toEqual({})
  })

  it('rejects a successful response missing the settings property', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true }))

    await expect(refreshUserSettingsRequest(fetcher)).rejects.toThrow(/settings.*response|user settings/i)
  })

  it('rejects a legacy userSettings alias instead of silently accepting an alternate shape', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ userSettings: { displayName: 'Old shape' } }))

    await expect(refreshUserSettingsRequest(fetcher)).rejects.toThrow(/settings.*response|user settings/i)
  })

  it('throws when the settings refresh fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'Settings read failed' }, { status: 500 })
    )

    await expect(refreshUserSettingsRequest(fetcher)).rejects.toThrow('Settings read failed')
  })
})
