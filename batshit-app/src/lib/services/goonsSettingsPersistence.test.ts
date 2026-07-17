import { describe, expect, it, vi } from 'vitest'
import {
  persistGoonsSettingsPatchRequest,
  persistGoonsSettingsRequest,
  refreshUserSettingsRequest
} from './goonsSettingsPersistence'
import type { GoonsSettings } from '$lib/types/goons'

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

describe('persistGoonsSettingsRequest', () => {
  it('posts goon settings and returns the server-confirmed settings', async () => {
    const requested: GoonsSettings = {
      kitchen: {
        scenes: {
          old: { id: 'old', name: 'Old scene' }
        }
      }
    }
    const persisted: GoonsSettings = {
      kitchen: {
        scenes: {
          saved: { id: 'saved', name: 'Saved scene' }
        }
      }
    }
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        settings: {
          goons_settings: persisted
        }
      })
    )

    await expect(persistGoonsSettingsRequest(fetcher, requested)).resolves.toEqual(persisted)
    expect(fetcher).toHaveBeenCalledWith('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goons_settings: requested })
    })
  })

  it('throws when the server returns a non-OK settings save response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'Payload too large' }, { status: 413 })
    )

    await expect(persistGoonsSettingsRequest(fetcher, {})).rejects.toThrow('Payload too large')
  })

  it('throws when the server reports success false with a 200 response', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'Nope' }))

    await expect(persistGoonsSettingsRequest(fetcher, {})).rejects.toThrow('Nope')
  })

  it('throws when a full save omits the confirmed goon settings payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, settings: {} }))

    await expect(persistGoonsSettingsRequest(fetcher, {})).rejects.toThrow(
      'Settings save response did not include Goon settings'
    )
  })

  it('posts goon settings patches and requires server-confirmed settings', async () => {
    const persisted: GoonsSettings = {
      dockOpen: false,
      kitchen: {
        scenes: {
          saved: { id: 'saved', name: 'Saved scene' }
        }
      }
    }
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        settings: {
          goons_settings: persisted
        }
      })
    )

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).resolves.toEqual(
      persisted
    )
    expect(fetcher).toHaveBeenCalledWith('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goons_settings_patch: { dockOpen: false } })
    })
  })

  it('throws when a patch save omits the confirmed goon settings payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, settings: {} }))

    await expect(persistGoonsSettingsPatchRequest(fetcher, { dockOpen: false })).rejects.toThrow(
      'Settings save response did not include Goon settings'
    )
  })
})

describe('refreshUserSettingsRequest', () => {
  it('loads the current server settings after a client reload', async () => {
    const serverSettings = {
      theme: 'dark',
      goons_settings: {
        kitchen: {
          scenes: {
            current: { id: 'current', name: 'Current scene' }
          }
        }
      }
    }
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        settings: serverSettings
      })
    )

    await expect(refreshUserSettingsRequest(fetcher)).resolves.toEqual(serverSettings)
    expect(fetcher).toHaveBeenCalledWith('/api/user/settings', { cache: 'no-store' })
  })

  it('throws when the settings refresh omits user settings', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true }))

    await expect(refreshUserSettingsRequest(fetcher)).rejects.toThrow(
      'Settings response did not include user settings'
    )
  })
})
