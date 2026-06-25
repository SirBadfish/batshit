import { RedisService } from '$lib/server/redis'
import { env } from '$env/dynamic/private'
import type { LayoutServerLoad } from './$types'

function isInternalDevPanelEnabled() {
  const enabled = env.BATSHIT_ENABLE_INTERNAL_DEV_PANEL === '1'
  const secret = env.BATSHIT_INTERNAL_DEV_PANEL_SECRET?.trim() ?? ''
  return enabled && secret.length >= 32
}

export const load: LayoutServerLoad = async ({ locals }) => {
  const user = locals.user
  let userSettings = null
  
  if (user) {
    const redis = new RedisService()
    
    try {
      userSettings = await redis.getUserSettings(user.id)
    } catch (error) {
      console.error('Error loading user settings:', error)
    }
  }

  return {
    user,
    userSettings,
    internalDevPanelEnabled: isInternalDevPanelEnabled()
  }
}
