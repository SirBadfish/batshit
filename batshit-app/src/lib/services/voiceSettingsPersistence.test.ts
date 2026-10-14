import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { GET, POST } from '../../routes/api/user/settings/+server'
import {
  confirmUserSettings,
  failUserSettingsRead,
  resetUserSettings
} from '$lib/stores/userSettings.svelte'
import { persistVoiceSettingsPatchRequest, readVoiceSettingsReadAnswer } from './voiceSettingsPersistence'

useRedisTestServer()
beforeEach(resetUserSettings)
afterEach(() => { resetUserSettings(); vi.restoreAllMocks() })

const USER = 'voice-persistence-probe'
const patch = { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' } } as const

describe('Voice lip sync persistence boundary (BL-976)', () => {
  it('accepts explicit empty reads but refuses malformed or declared-failed successful envelopes', () => {
    expect(readVoiceSettingsReadAnswer({ settings: null })).toBeNull()
    expect(readVoiceSettingsReadAnswer({ settings: {} })).toEqual({})
    for (const payload of [{}, { settings: [] }, { settings: { voice_settings: [] } },
      { userSettings: {} }, { success: false, settings: {} }]) {
      expect(() => readVoiceSettingsReadAnswer(payload)).toThrow(/valid settings record/)
    }
  })
  it.each(['unread', 'failed'] as const)('refuses before any request when the shared read is %s', async state => {
    if (state === 'failed') failUserSettingsRead(new Error('Read refused'))
    const fetcher = vi.fn()
    await expect(persistVoiceSettingsPatchRequest(fetcher, patch)).rejects.toThrow(/Voice settings have not loaded/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sends only the owned pair through the real route, retains stored siblings, and returns the full sanitized answer', async () => {
    const voice = {
      schemaVersion: 2,
      tts: { providerId: 'fish', modelId: 'saved-model' },
      goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 60 },
      byo: { id: 'retained', rawMarker: 'unreadable-fallback' },
      extension: { keep: true }
    }
    await redis.updateUserSettings(USER, { displayName: 'Probe', voice_settings: voice })
    const read = await GET({ locals: { user: { id: USER } } } as any)
    confirmUserSettings((await read.json()).settings)
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => POST({
      locals: { user: { id: USER } },
      request: new Request(`http://localhost${input}`, init)
    } as any))

    const saved = await persistVoiceSettingsPatchRequest(fetcher, patch)

    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/user/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_settings_patch: patch })
    })
    expect((await redis.json.get(`user:${USER}:settings`) as any).voice_settings).toEqual({
      ...voice, goonLipSync: { ...voice.goonLipSync, ...patch.goonLipSync }
    })
    expect(saved.displayName).toBe('Probe')
    expect(saved.voice_settings?.tts?.modelId).toBe('saved-model')
    expect(saved.voice_settings).not.toHaveProperty('byo')
    expect(saved.voice_settings).not.toHaveProperty('byoProviders')
  })

  it.each([
    { success: true },
    { settings: null },
    { settings: [] },
    { userSettings: { voice_settings: {} } },
    { settings: { displayName: 'Partial' } },
    { settings: { voice_settings: [] } }
  ])('rejects an incomplete successful save answer: %j', async body => {
    confirmUserSettings({})
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    await expect(persistVoiceSettingsPatchRequest(fetcher, patch)).rejects.toThrow(/valid settings record/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('preserves a server refusal instead of inventing a successful local record', async () => {
    confirmUserSettings({})
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Settings write refused' }), { status: 503 }))
    await expect(persistVoiceSettingsPatchRequest(fetcher, patch)).rejects.toThrow('Settings write refused')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
