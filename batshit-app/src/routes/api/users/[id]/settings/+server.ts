import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { resolveDefaultNativeExecutionBackend } from '$lib/server/services/nativeExecutionDefaults'

// GET /api/users/[id]/settings
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only allow users to get their own settings
  if (params.id !== locals.user.id) {
    return json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // `settings` is null when no row exists yet (fresh install) — a real empty state.
    // Redis failures throw and return 500 below so callers fail loudly instead of
    // compiling with fabricated defaults (G-0031/G-0152a).
    const settings = await redis.getUserSettings(params.id)
    return json({
      settings,
      // Server-computed runtime facts the browser-side prompt compiler needs but must
      // never guess (G-0027): the effective default sandbox backend for this install.
      runtime_defaults: {
        native_execution_backend: resolveDefaultNativeExecutionBackend()
      }
    })
  } catch (error) {
    console.error('Error getting user settings:', error)
    return json({ error: 'USER_SETTINGS_UNAVAILABLE: failed to load user settings' }, { status: 500 })
  }
}

// PUT /api/users/[id]/settings
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (params.id !== locals.user.id) {
    return json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const settings = await request.json()
    await redis.updateUserSettings(params.id, settings)
    return json({ success: true })
  } catch (error) {
    console.error('Error updating user settings:', error)
    return json({ error: 'Failed to update settings' }, { status: 500 })
  }
}