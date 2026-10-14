import { RedisService } from '$lib/server/redis'
import { isInternalDevPanelEnabled } from '$lib/server/internalDevPanel'
import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = async ({ locals }) => {
  const user = locals.user
  let userSettings = null
  let userSettingsReadSucceeded = false
  let userSettingsReadError: string | null = null
  
  if (user) {
    const redis = new RedisService()
    
    try {
      const loadedSettings = await redis.getUserSettings(user.id)
      if (loadedSettings !== null && (!loadedSettings || typeof loadedSettings !== 'object' || Array.isArray(loadedSettings))) {
        throw new Error('User settings record has an invalid shape')
      }
      userSettings = loadedSettings
      userSettingsReadSucceeded = true
    } catch (error) {
      console.error('Error loading user settings:', error)
      userSettingsReadError = 'User settings could not load'
    }
  }

  return {
    user,
    userSettings,
    userSettingsReadSucceeded,
    userSettingsReadError,
    internalDevPanelEnabled: isInternalDevPanelEnabled()
  }
}
