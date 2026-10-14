import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from './+server'

/**
 * BL-976 — voice settings have two narrow owners: the Voice panel can save its voice
 * block, while the Dock Lip Sync Lab owns only goonLipSync. The route must merge those
 * writes against the current stored record and keep unreadable BYO fallback data server-side.
 */

useRedisTestServer()

const USER = 'user-voice-settings-route'
const SETTINGS_KEY = `user:${USER}:settings`

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

async function seedVoiceSettings(voiceSettings: unknown) {
  await seedSettings({ displayName: 'Josh', voice_settings: voiceSettings })
}

async function seedSettings(settings: Record<string, unknown>) {
  await redis.json.set(SETTINGS_KEY, '$', settings)
}

async function storedVoiceSettings() {
  return (await redis.json.get(SETTINGS_KEY) as any)?.voice_settings
}

const unreadableByoFallback = [
  { id: 'lost-provider', name: 'Retained unreadable provider', endpoint: 'https://voice.invalid' }
]
const legacyByoFallback = {
  id: 'legacy-lost-provider',
  name: 'Retained legacy unreadable provider',
  endpoint: 'https://legacy-voice.invalid'
}

describe('BL-976 voice settings ownership', () => {
  it('applies a partial Lip Sync Lab patch to current raw settings and redacts BYO only from the response', async () => {
    const original = {
      schemaVersion: 2,
      voiceRuntimes: { browser: 'browser-audio' },
      goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 73 },
      voiceMode: { inputMode: 'text' },
      serverExtension: { keep: ['unrecognized', 'raw', 'fields'] },
      byoProviders: unreadableByoFallback
    }
    await seedVoiceSettings(original)

    const response = await post({
      voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 65 } }
    })

    expect(response.status).toBe(200)
    const stored = await storedVoiceSettings()
    expect(stored).toEqual({
      ...original,
      goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 65 }
    })
    const payload = await response.json()
    expect(payload.settings.voice_settings).not.toHaveProperty('byoProviders')
  })

  it('keeps a stored voice block byte-for-byte when an unrelated settings save omits it', async () => {
    const original = {
      schemaVersion: 2,
      goonLipSync: { mode: 'viseme', analyzerId: 'rhubarb-wasm', visemeBlendMs: 80 },
      voiceRuntimes: { browser: 'browser-audio' },
      serverExtension: { keep: true },
      byoProviders: unreadableByoFallback
    }
    await seedVoiceSettings(original)

    const response = await post({ admin_settings: { lipSyncLabEnabled: true } })

    expect(response.status).toBe(200)
    expect(await storedVoiceSettings()).toEqual(original)
  })

  it('preserves current Lip Sync Lab and server-owned BYO fallback when a full voice save omits them', async () => {
    const originalLipSync = { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 71 }
    await seedVoiceSettings({
      schemaVersion: 2,
      goonLipSync: originalLipSync,
      byoProviders: unreadableByoFallback,
      byo: legacyByoFallback,
      serverExtension: { keep: true }
    })

    const response = await post({
      voice_settings: {
        schemaVersion: 2,
        voiceMode: { inputMode: 'text' },
        byoProviders: [{ id: 'attacker-injected', name: 'client must not install this' }]
      }
    })

    expect(response.status).toBe(200)
    const stored = await storedVoiceSettings()
    expect(stored.goonLipSync).toEqual(originalLipSync)
    expect(stored.byoProviders).toEqual(unreadableByoFallback)
    expect(stored.byoProviders).not.toContainEqual(expect.objectContaining({ id: 'attacker-injected' }))
    expect(stored.byo).toEqual(legacyByoFallback)
    expect(stored.voiceMode).toMatchObject({ inputMode: 'text' })
    expect(stored.serverExtension).toEqual({ keep: true })
    expect((await response.json()).settings.voice_settings).not.toHaveProperty('byoProviders')
  })

  it('applies an explicit Lip Sync Lab patch after the Voice panel block in the same request', async () => {
    const existingByo = unreadableByoFallback
    await seedVoiceSettings({
      schemaVersion: 2,
      goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 64 },
      byoProviders: existingByo,
      byo: legacyByoFallback,
      serverExtension: { keep: true }
    })

    const response = await post({
      voice_settings: {
        schemaVersion: 2,
        goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 71 },
        voiceMode: { inputMode: 'text' },
        byoProviders: [],
        byo: { id: 'client-injected', name: 'must not install' }
      },
      voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' } }
    })

    expect(response.status).toBe(200)
    const stored = await storedVoiceSettings()
    expect(stored.goonLipSync).toEqual({ mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 71 })
    expect(stored.voiceMode).toMatchObject({ inputMode: 'text' })
    expect(stored.byoProviders).toEqual(existingByo)
    expect(stored.byo).toEqual(legacyByoFallback)
    expect(stored.serverExtension).toEqual({ keep: true })
  })

  it('accepts an independent viseme blend patch without requiring mode or analyzer', async () => {
    const originalLipSync = { mode: 'viseme', analyzerId: 'rhubarb-wasm', visemeBlendMs: 40 }
    await seedVoiceSettings({ schemaVersion: 2, goonLipSync: originalLipSync })

    const response = await post({
      voice_settings_patch: { goonLipSync: { visemeBlendMs: 65 } }
    })

    expect(response.status).toBe(200)
    expect((await storedVoiceSettings()).goonLipSync).toEqual({ ...originalLipSync, visemeBlendMs: 65 })
  })

  it('treats a present empty patch as a no-op on the current voice record', async () => {
    const original = {
      schemaVersion: 2,
      goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 55 },
      serverExtension: { keep: true },
      byoProviders: unreadableByoFallback
    }
    await seedVoiceSettings(original)

    const response = await post({ voice_settings_patch: {} })

    expect(response.status).toBe(200)
    expect(await storedVoiceSettings()).toEqual(original)
  })

  it('rejects malformed patches, unknown lip-sync leaves, and client BYO ownership without writing', async () => {
    const original = {
      schemaVersion: 2,
      goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 70 },
      byoProviders: unreadableByoFallback,
      serverExtension: { keep: true }
    }
    const invalidBodies = [
      { voice_settings_patch: null },
      { voice_settings_patch: { goonLipSync: null } },
      { voice_settings_patch: { goonLipSync: { unknownLeaf: 'value' } } },
      { voice_settings_patch: { goonLipSync: { mode: 'unsupported', analyzerId: 'rhubarb-wasm' } } },
      { voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'unsupported' } } },
      { voice_settings_patch: { goonLipSync: { mode: 'viseme' } } },
      { voice_settings_patch: { goonLipSync: { analyzerId: 'audio2face-3d' } } },
      { voice_settings_patch: { goonLipSync: { visemeBlendMs: -1 } } },
      { voice_settings_patch: { goonLipSync: { visemeBlendMs: 81 } } },
      { voice_settings_patch: { goonLipSync: { visemeBlendMs: null } } },
      { voice_settings_patch: { goonLipSync: { byoProviders: [] } } },
      { voice_settings_patch: { goonLipSync: { byo: legacyByoFallback } } },
      { voice_settings_patch: { byoProviders: [] } },
      { voice_settings_patch: { byo: legacyByoFallback } }
    ]

    for (const body of invalidBodies) {
      await seedVoiceSettings(original)
      const response = await post(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(await storedVoiceSettings(), JSON.stringify(body)).toEqual(original)
    }
  })

  it.each([
    ['null voice block', { displayName: 'Josh', voice_settings: null, admin_settings: { keep: true } }],
    ['omitted voice block', { displayName: 'Josh', ui_settings: { keep: true } }]
  ])('allows a lip-sync patch to initialize an empty install with %s', async (_label, original) => {
    await seedSettings(original as Record<string, unknown>)
    const response = await post({
      voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' } }
    })

    expect(response.status).toBe(200)
    const saved = await redis.json.get(SETTINGS_KEY) as any
    expect(saved.voice_settings.goonLipSync).toEqual({
      mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 35
    })
    expect(saved.displayName).toBe('Josh')
    if ('admin_settings' in original) expect(saved.admin_settings).toEqual({ keep: true })
    if ('ui_settings' in original) expect(saved.ui_settings).toEqual({ keep: true })
  })

  it('refuses non-empty malformed saved voice blocks and non-null malformed lip-sync containers', async () => {
    for (const malformed of ['broken voice settings', []]) {
      await seedVoiceSettings(malformed)
      const response = await post({
        voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'rhubarb-wasm' } }
      })
      expect(response.status, `stored voice settings: ${JSON.stringify(malformed)}`).toBe(409)
      expect(await storedVoiceSettings()).toEqual(malformed)
    }

    const malformedLipSync = { schemaVersion: 2, goonLipSync: 'not an object', serverExtension: { keep: true } }
    await seedVoiceSettings(malformedLipSync)
    const response = await post({
      voice_settings_patch: { goonLipSync: { visemeBlendMs: 60 } }
    })
    expect(response.status).toBe(409)
    expect(await storedVoiceSettings()).toEqual(malformedLipSync)
  })

  it('applies a canonical nested patch over representative flat legacy lip-sync fields', async () => {
    const legacy = {
      goonLipSyncMode: 'amplitude',
      goonLipSyncAnalyzerId: 'rhubarb-wasm',
      goonLipSyncVisemeBlendMs: 40,
      voiceRuntime: 'legacy-runtime',
      ttsProvider: 'browser',
      serverExtension: { keep: true },
      byoProviders: unreadableByoFallback,
      byo: legacyByoFallback
    }
    await seedVoiceSettings(legacy)

    const response = await post({
      voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 70 } }
    })

    expect(response.status).toBe(200)
    const stored = await storedVoiceSettings()
    expect(stored.goonLipSync).toEqual({ mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 70 })
    expect(stored.serverExtension).toEqual(legacy.serverExtension)
    expect(stored.byoProviders).toEqual(unreadableByoFallback)
    expect(stored.byo).toEqual(legacyByoFallback)
  })

  it('retains the flat legacy blend when only the lip-sync mode and analyzer are patched', async () => {
    await seedVoiceSettings({
      goonLipSyncMode: 'amplitude',
      goonLipSyncAnalyzerId: 'rhubarb-wasm',
      goonLipSyncVisemeBlendMs: 60,
      voiceRuntime: 'legacy-runtime'
    })

    const response = await post({
      voice_settings_patch: { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' } }
    })

    expect(response.status).toBe(200)
    expect((await storedVoiceSettings()).goonLipSync).toEqual({
      mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 60
    })
  })

  it('retains the flat legacy mode and analyzer when only the blend is patched', async () => {
    await seedVoiceSettings({
      goonLipSyncMode: 'viseme',
      goonLipSyncAnalyzerId: 'audio2face-3d',
      goonLipSyncVisemeBlendMs: 40,
      ttsProvider: 'browser'
    })

    const response = await post({
      voice_settings_patch: { goonLipSync: { visemeBlendMs: 65 } }
    })

    expect(response.status).toBe(200)
    expect((await storedVoiceSettings()).goonLipSync).toEqual({
      mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 65
    })
  })

  it('retains flat legacy lip-sync semantics during an explicit unrelated full Voice save', async () => {
    await seedVoiceSettings({
      goonLipSyncMode: 'viseme',
      goonLipSyncAnalyzerId: 'audio2face-3d',
      goonLipSyncVisemeBlendMs: 52,
      serverExtension: { keep: true }
    })

    const response = await post({
      voice_settings: { schemaVersion: 2, voiceMode: { inputMode: 'text' } }
    })

    expect(response.status).toBe(200)
    const stored = await storedVoiceSettings()
    expect(stored.goonLipSync).toEqual({
      mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 52
    })
    expect(stored.serverExtension).toEqual({ keep: true })
  })
})
