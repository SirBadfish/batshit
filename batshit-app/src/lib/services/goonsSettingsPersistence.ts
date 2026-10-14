import type { GoonsSettings } from '$lib/types/goons'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type UserSettingsPayload = Record<string, any> & {
  goons_settings?: GoonsSettings
}

async function parseSettingsResponse(response: Response): Promise<any> {
  const text = await response.text().catch(() => '')
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

function getSettingsSaveError(payload: any, response: Response) {
  const message =
    typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : `Failed to save Goon settings (${response.status})`
  return new Error(message)
}

function getConfirmedSettings(payload: any): UserSettingsPayload | null {
  if (!payload || !Object.hasOwn(payload, 'settings')) {
    throw new Error('Settings response did not include user settings')
  }
  const settings = payload.settings
  if (settings === null) return null
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Settings response did not include a valid user settings record')
  }
  return settings
}

export async function refreshUserSettingsRequest(fetcher: Fetcher): Promise<UserSettingsPayload> {
  const response = await fetcher('/api/user/settings', { cache: 'no-store' })
  const payload = await parseSettingsResponse(response)
  if (!response.ok || payload?.success === false) throw getSettingsSaveError(payload, response)
  // A successful explicit null is a new install. An omitted/malformed envelope is a failure.
  return getConfirmedSettings(payload) ?? {}
}

/** Patch only the writer's owned keys; return the whole authoritative server answer. */
export async function persistGoonsSettingsPatchRequest(
  fetcher: Fetcher,
  patch: Partial<GoonsSettings>
): Promise<UserSettingsPayload> {
  const response = await fetcher('/api/user/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goons_settings_patch: patch })
  })
  const payload = await parseSettingsResponse(response)
  if (!response.ok || payload?.success === false) throw getSettingsSaveError(payload, response)
  const settings = getConfirmedSettings(payload)
  if (!settings?.goons_settings || typeof settings.goons_settings !== 'object' || Array.isArray(settings.goons_settings)) {
    throw new Error('Settings save response did not include Goon settings')
  }
  return settings
}
