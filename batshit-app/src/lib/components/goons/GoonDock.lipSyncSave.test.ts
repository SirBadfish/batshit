import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'
import {
  confirmUserSettings as confirmStoreUserSettings,
  failUserSettingsRead,
  getUserSettings,
  getUserSettingsReadState,
  resetUserSettings
} from '$lib/stores/userSettings.svelte'
import { requireConfirmedVoiceSettings } from '$lib/services/voiceSettingsPersistence'

// Execute the real Dock callback with only its store, persistence, and UI effects supplied
// by the test. This avoids mounting the renderer/3D runtime while preserving callback logic.
function callback(scope: Record<string, any>) {
  const source = readFileSync('src/lib/components/goons/GoonDock.svelte', 'utf8')
    .split('<script lang="ts">')[1]
    .split('</script>')[0]
  const file = ts.createSourceFile('GoonDock.ts', source, ts.ScriptTarget.Latest, true)
  const fn = file.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'saveLipSyncLabSettings'
  )
  if (!fn) throw new Error('Missing callback saveLipSyncLabSettings')
  const code = ts.transpileModule(fn.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const scopeProxy = new Proxy(scope, {
    has: () => true,
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key)
      if (Object.hasOwn(target, key)) return Reflect.get(target, key)
      return Reflect.get(globalThis as any, key)
    },
    set(target, key, value) { return Reflect.set(target, key, value) }
  })
  return new Function('scope', `with (scope) { ${code}; return saveLipSyncLabSettings }`)(scopeProxy) as (
    mode: 'amplitude' | 'viseme',
    analyzer?: 'rhubarb-wasm' | 'audio2face-3d'
  ) => Promise<void>
}

function context() {
  const fullSettings = {
    displayName: 'Authoritative',
    voice_settings: {
      schemaVersion: 2,
      goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 35 },
      voiceRuntimes: { browser: 'browser-audio' },
      voiceMode: { inputMode: 'text' },
      ttsEnginePrompts: { browser: { prompt: 'keep this sibling' } }
    }
  }
  const responseSettings = {
    displayName: 'Server answer',
    voice_settings: {
      ...fullSettings.voice_settings,
      goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 35 }
    }
  }
  const setUserSettings = vi.fn((settings: any) => confirmStoreUserSettings(settings))
  return {
    fullSettings,
    responseSettings,
    scope: {
      lipSyncMode: 'amplitude',
      premiumLipSyncAnalyzer: 'rhubarb-wasm',
      lipSyncLabMode: 'amplitude',
      lipSyncLabAnalyzer: 'rhubarb-wasm',
      lipSyncLabSaving: false,
      lipSyncLabError: null as string | null,
      getUserSettingsReadState,
      getUserSettings,
      requireConfirmedVoiceSettings,
      normalizeVoiceSettings,
      fetch: vi.fn(async () => new Response(JSON.stringify({ settings: responseSettings }), { status: 200 })),
      persistVoiceSettingsPatchRequest: vi.fn(async () => responseSettings),
      setUserSettings,
      confirmUserSettings: setUserSettings,
      toast: { error: vi.fn() }
    } as Record<string, any>
  }
}

afterEach(() => resetUserSettings())

describe('Goon Dock Lip Sync Lab save callback (BL-976)', () => {
  it.each(['unread', 'failed'] as const)('does not change the choice or write while settings are %s', async readState => {
    const { scope, fullSettings } = context()
    if (readState === 'unread') resetUserSettings()
    else failUserSettingsRead(new Error('initial read failed'))

    await callback(scope)('viseme', 'audio2face-3d')

    expect(scope.lipSyncLabMode).toBe('amplitude')
    expect(scope.lipSyncLabAnalyzer).toBe('rhubarb-wasm')
    expect(scope.lipSyncLabSaving).toBe(false)
    expect(scope.lipSyncLabError).toContain('Voice settings have not loaded')
    expect(scope.persistVoiceSettingsPatchRequest).not.toHaveBeenCalled()
    expect(scope.fetch).not.toHaveBeenCalled()
    expect(scope.confirmUserSettings).not.toHaveBeenCalled()
  })

  it('passes only the owned Lip Sync Lab leaves and confirms the full server settings answer', async () => {
    const { scope, fullSettings, responseSettings } = context()
    confirmStoreUserSettings(fullSettings)

    await callback(scope)('viseme', 'audio2face-3d')

    expect(scope.persistVoiceSettingsPatchRequest).toHaveBeenCalledOnce()
    expect(scope.persistVoiceSettingsPatchRequest).toHaveBeenCalledWith(
      scope.fetch,
      { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' } }
    )
    expect(scope.fetch).not.toHaveBeenCalled()
    expect(scope.setUserSettings).toHaveBeenCalledOnce()
    expect(scope.setUserSettings).toHaveBeenCalledWith(responseSettings)
    expect(getUserSettingsReadState()).toBe('confirmed')
    expect(getUserSettings()).toEqual(responseSettings)
    expect(scope.lipSyncLabMode).toBe('viseme')
    expect(scope.lipSyncLabAnalyzer).toBe('audio2face-3d')
    expect(scope.lipSyncLabSaving).toBe(false)
    expect(scope.lipSyncLabError).toBeNull()
  })

  it('restores the last confirmed choice and records one failed write', async () => {
    const { scope, fullSettings } = context()
    confirmStoreUserSettings(fullSettings)
    scope.persistVoiceSettingsPatchRequest.mockRejectedValue(new Error('settings write refused'))

    await callback(scope)('viseme', 'audio2face-3d')

    expect(scope.persistVoiceSettingsPatchRequest).toHaveBeenCalledOnce()
    expect(scope.lipSyncLabMode).toBe('amplitude')
    expect(scope.lipSyncLabAnalyzer).toBe('rhubarb-wasm')
    expect(scope.lipSyncLabError).toBe('settings write refused')
    expect(scope.toast.error).toHaveBeenCalledOnce()
    expect(scope.confirmUserSettings).not.toHaveBeenCalled()
    expect(scope.lipSyncLabSaving).toBe(false)
  })

  it('treats a malformed persistence answer as failure without accepting a partial store value', async () => {
    const { scope, fullSettings } = context()
    confirmStoreUserSettings(fullSettings)
    scope.persistVoiceSettingsPatchRequest.mockRejectedValue(new Error('Malformed user settings response'))

    await callback(scope)('viseme', 'audio2face-3d')

    expect(scope.persistVoiceSettingsPatchRequest).toHaveBeenCalledOnce()
    expect(scope.lipSyncLabMode).toBe('amplitude')
    expect(scope.lipSyncLabAnalyzer).toBe('rhubarb-wasm')
    expect(scope.lipSyncLabError).toBe('Malformed user settings response')
    expect(scope.confirmUserSettings).not.toHaveBeenCalled()
    expect(getUserSettings()).toEqual(fullSettings)
    expect(scope.toast.error).toHaveBeenCalledOnce()
    expect(scope.lipSyncLabSaving).toBe(false)
  })
})
