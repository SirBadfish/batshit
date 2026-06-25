import { json, type RequestHandler } from '@sveltejs/kit'

import { validateCliTool } from '$lib/server/services/cliToolRegistry'

export const POST: RequestHandler = async ({ locals, params }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'CLI tool id is required' }, { status: 400 })
  }

  try {
    const result = await validateCliTool(userId, params.id)
    return json(result)
  } catch (error) {
    console.error('[CLI Tools API] Failed to validate tool:', error)
    const message = error instanceof Error ? error.message : 'Failed to validate CLI tool'
    const status = message.includes('not found') ? 404 : 500
    return json({ error: message }, { status })
  }
}
