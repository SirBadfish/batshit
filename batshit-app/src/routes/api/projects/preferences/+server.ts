import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { RedisService } from '$lib/server/redis'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const redis = new RedisService()
    const preferences = await redis.getProjectPreferences(locals.user.id)
    return json({ preferences })
  } catch (error) {
    console.error('[ProjectPreferences] Failed to load preferences:', error)
    return json({ error: 'Failed to load preferences' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const { defaultWorkspacePath } = await request.json()
    if (defaultWorkspacePath && typeof defaultWorkspacePath === 'string') {
      const trimmed = defaultWorkspacePath.trim()
      if (trimmed.length && !trimmed.startsWith('/')) {
        return json(
          { error: 'Default workspace path must be an absolute path.' },
          { status: 400 }
        )
      }
    }

    const redis = new RedisService()
    const preferences = await redis.saveProjectPreferences(locals.user.id, {
      default_workspace_path:
        typeof defaultWorkspacePath === 'string' ? defaultWorkspacePath : null
    })
    try {
      await syncAgentCodexProfiles(locals.user.id)
    } catch (error) {
      console.warn('[ProjectPreferences] Failed to sync Codex profiles after preference save:', error)
    }

    return json({ preferences })
  } catch (error) {
    console.error('[ProjectPreferences] Failed to save preferences:', error)
    return json({ error: 'Failed to save preferences' }, { status: 500 })
  }
}
