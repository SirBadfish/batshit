import { json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { isInternalDevPanelEnabled } from '$lib/server/internalDevPanel'
import {
  readPausedPlansDevSwitch,
  writePausedPlansDevSwitch
} from '$lib/server/services/pausedPlans'
import type { RequestHandler } from './$types'

/**
 * The Dev panel's "Use paused plans on this copy" switch (plan section 3a).
 * It exists only where the internal Dev panel exists; elsewhere this route is
 * not found, so no request can switch the pause off on another copy.
 */
function guard(locals: App.Locals) {
  if (!isInternalDevPanelEnabled()) return apiError('Not found', 404)
  if (!locals.user) return apiError('Unauthorized', 401)
  return null
}

export const GET: RequestHandler = async ({ locals }) => {
  const refused = guard(locals)
  if (refused) return refused
  return json({ usePausedPlans: await readPausedPlansDevSwitch() })
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  const refused = guard(locals)
  if (refused) return refused
  const body = (await request.json().catch(() => null)) as { usePausedPlans?: unknown } | null
  if (typeof body?.usePausedPlans !== 'boolean') {
    return apiError('usePausedPlans must be true or false.', 400)
  }
  await writePausedPlansDevSwitch(body.usePausedPlans)
  return json({ usePausedPlans: await readPausedPlansDevSwitch() })
}
