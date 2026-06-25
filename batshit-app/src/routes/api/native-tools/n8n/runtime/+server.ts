import { json, type RequestHandler } from '@sveltejs/kit'
import { getN8nRuntimeStatus } from '$lib/server/services/n8nRuntimeStatus'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return json(await getN8nRuntimeStatus({ userId: locals.user.id }))
  } catch (error) {
    console.error('[Native Tools] n8n/runtime GET failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to load n8n runtime status.'
      },
      { status: 500 }
    )
  }
}
