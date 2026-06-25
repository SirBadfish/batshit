import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { resolveRuntimeContext } from '$lib/server/services/runtimeContext'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  return json({
    success: true,
    ...resolveRuntimeContext()
  })
}
