import { json, type RequestHandler } from '@sveltejs/kit'
import { rotateWakeHookToken, WakeHookError } from '$lib/server/services/dm/wakeHookStore'

/**
 * SA-113 P3 (DL-113-09) — issue a new token for an existing hook.
 *
 * The old token stops working immediately: a rotate is a revoke that keeps the URL, so an
 * n8n workflow only has to change its credential, not its request.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const hookId = typeof params.id === 'string' ? params.id : ''
  if (!hookId) {
    return json({ success: false, error: 'A webhook id is required.' }, { status: 400 })
  }

  try {
    const result = await rotateWakeHookToken({ userId: locals.user.id, hookId })
    return json({ success: true, token: result.token, hook: result.record })
  } catch (error) {
    if (!(error instanceof WakeHookError)) {
      console.error('[Wake-up webhooks] Could not rotate a hook token:', error)
    }
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Could not rotate the token.'
      },
      { status: error instanceof WakeHookError ? error.status : 500 }
    )
  }
}
