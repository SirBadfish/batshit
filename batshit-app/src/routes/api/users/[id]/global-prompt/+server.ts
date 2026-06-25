import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { invalidateUserSettingsCache } from '$lib/services/databaseRedis.server'
import { logger } from '$lib/utils/logger'

// GET /api/users/[id]/global-prompt
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only allow users to get their own global prompt
  if (params.id !== locals.user.id) {
    return json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // Get user settings which contains global_custom_system_prompt
    const settings = await redis.getUserSettings(params.id)
    const prompt = settings?.global_custom_system_prompt || ''
    return json({ prompt })
  } catch (error) {
    console.error('Error getting global prompt:', error)
    return json({ prompt: '' })
  }
}

// PUT /api/users/[id]/global-prompt
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (params.id !== locals.user.id) {
    return json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const { prompt } = await request.json()

    // Update user settings with the global custom prompt
    await redis.updateUserSettings(params.id, {
      global_custom_system_prompt: prompt
    })
    invalidateUserSettingsCache(params.id)

    logger.debug(`[Global Prompt] Updated for user ${params.id}: ${prompt.length} chars`)
    return json({ success: true })
  } catch (error) {
    console.error('Error updating global prompt:', error)
    return json({ error: 'Failed to update global prompt' }, { status: 500 })
  }
}
