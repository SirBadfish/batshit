import { json, type RequestHandler } from '@sveltejs/kit'
import {
  revokeWakeHook,
  updateWakeHook,
  WakeHookError
} from '$lib/server/services/dm/wakeHookStore'

/** SA-113 P3 (DL-113-09) — enable/disable/rename one hook, or revoke it for good. */

function errorStatus(error: unknown): number {
  return error instanceof WakeHookError ? error.status : 500
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const hookId = typeof params.id === 'string' ? params.id : ''
  if (!hookId) {
    return json({ success: false, error: 'A webhook id is required.' }, { status: 400 })
  }

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }
    const hook = await updateWakeHook({
      userId: locals.user.id,
      hookId,
      name: body.name,
      deliverDefault: body.deliverDefault,
      enabled: body.enabled,
      expiresAt: body.expiresAt
    })
    return json({ success: true, hook })
  } catch (error) {
    if (!(error instanceof WakeHookError)) {
      console.error('[Wake-up webhooks] Could not update a hook:', error)
    }
    return json(
      { success: false, error: errorMessage(error, 'Could not update the wake-up webhook.') },
      { status: errorStatus(error) }
    )
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const hookId = typeof params.id === 'string' ? params.id : ''
  if (!hookId) {
    return json({ success: false, error: 'A webhook id is required.' }, { status: 400 })
  }

  try {
    await revokeWakeHook({ userId: locals.user.id, hookId })
    return json({ success: true })
  } catch (error) {
    if (!(error instanceof WakeHookError)) {
      console.error('[Wake-up webhooks] Could not revoke a hook:', error)
    }
    return json(
      { success: false, error: errorMessage(error, 'Could not revoke the wake-up webhook.') },
      { status: errorStatus(error) }
    )
  }
}
