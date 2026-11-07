// Keeps this window's look current after a save made somewhere else (another window or tab):
// the settings route publishes `user_settings_changed {family: 'appearance'}` and the user
// channel calls this. A save made here updates the settings store directly (Themes panel).
import { applyAppLook, resolveAppLook } from './appLook'
import { getUserSettingsReadState, updateUserSettings } from '$lib/stores/userSettings.svelte'

let generation = 0

export async function refreshAppearanceFromServer(fetchImpl: typeof fetch = fetch) {
  // Two saves elsewhere send two events; only the read started last may paint.
  const mine = ++generation
  let settings: unknown
  try {
    const response = await fetchImpl('/api/user/settings', { cache: 'no-store' })
    if (!response.ok) throw new Error(`settings read answered ${response.status}`)
    settings = (await response.json())?.settings
  } catch (error) {
    // This window keeps the look it shows; the next page load paints the saved one.
    console.warn('[look] Could not read the look saved in another window:', error)
    return
  }
  if (mine !== generation) return
  const appearance = (settings as { appearance_settings?: unknown } | null)?.appearance_settings
  if (getUserSettingsReadState() === 'confirmed') updateUserSettings({ appearance_settings: appearance as never })
  applyAppLook(resolveAppLook(settings))
}
