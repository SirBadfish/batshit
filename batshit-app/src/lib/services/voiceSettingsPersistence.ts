import type { UserSettings } from '$lib/stores/userSettings.svelte'
import { getUserSettingsReadState } from '$lib/stores/userSettings.svelte'
import type { VoiceSettingsPatch } from '$lib/utils/voiceSettingsSave'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function requireConfirmedVoiceSettings() {
  if (getUserSettingsReadState() !== 'confirmed') {
    throw new Error('Voice settings have not loaded. Press Retry before changing lip sync.')
  }
}

/** Missing or malformed success envelopes are failures; explicit null is an empty install. */
export function readVoiceSettingsReadAnswer(payload: any): UserSettings | null {
  if (!payload || payload.success === false || !Object.hasOwn(payload, 'settings')) {
    throw new Error('Voice settings response did not include a valid settings record.')
  }
  const settings = payload.settings
  if (settings === null) return null
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
    (settings.voice_settings != null &&
      (typeof settings.voice_settings !== 'object' || Array.isArray(settings.voice_settings)))) {
    throw new Error('Voice settings response did not include a valid settings record.')
  }
  return settings
}

/** Require the canonical full answer; a missing record never counts as a saved choice. */
export function readConfirmedVoiceSaveAnswer(payload: any): UserSettings {
  const settings = payload?.settings
  if (payload?.success === false || !settings || typeof settings !== 'object' || Array.isArray(settings) ||
    !settings.voice_settings || typeof settings.voice_settings !== 'object' || Array.isArray(settings.voice_settings)) {
    throw new Error(payload?.error || 'Voice settings save did not return a valid settings record.')
  }
  return settings
}

export async function persistVoiceSettingsPatchRequest(
  fetcher: Fetcher,
  patch: VoiceSettingsPatch
): Promise<UserSettings> {
  requireConfirmedVoiceSettings()
  const response = await fetcher('/api/user/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_settings_patch: patch })
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || `Failed to save lip sync settings (${response.status}).`)
  return readConfirmedVoiceSaveAnswer(payload)
}
