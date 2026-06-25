import { json, type RequestHandler } from '@sveltejs/kit'

import { createCliTool, listCliTools } from '$lib/server/services/cliToolRegistry'

export const GET: RequestHandler = async ({ locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const tools = await listCliTools(userId)
    return json({ tools })
  } catch (error) {
    console.error('[CLI Tools API] Failed to list tools:', error)
    return json({ error: 'Failed to list CLI tools' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const tool = await createCliTool(userId, body)
    return json({ tool }, { status: 201 })
  } catch (error) {
    console.error('[CLI Tools API] Failed to create tool:', error)
    const message = error instanceof Error ? error.message : 'Failed to create CLI tool'
    const status = message.includes('already exists') || message.includes('required') ? 400 : 500
    return json({ error: message }, { status })
  }
}
