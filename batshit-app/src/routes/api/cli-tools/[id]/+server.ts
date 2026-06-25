import { json, type RequestHandler } from '@sveltejs/kit'

import {
  deleteCliTool,
  getCliTool,
  updateCliTool
} from '$lib/server/services/cliToolRegistry'

export const GET: RequestHandler = async ({ locals, params }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'CLI tool id is required' }, { status: 400 })
  }

  try {
    const tool = await getCliTool(userId, params.id)
    if (!tool) {
      return json({ error: 'CLI tool not found' }, { status: 404 })
    }
    return json({ tool })
  } catch (error) {
    console.error('[CLI Tools API] Failed to load tool:', error)
    return json({ error: 'Failed to load CLI tool' }, { status: 500 })
  }
}

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'CLI tool id is required' }, { status: 400 })
  }

  try {
    const updates = await request.json()
    delete updates.toolId
    delete updates.createdAt
    const tool = await updateCliTool(userId, params.id, updates)
    return json({ tool })
  } catch (error) {
    console.error('[CLI Tools API] Failed to update tool:', error)
    const message = error instanceof Error ? error.message : 'Failed to update CLI tool'
    const status =
      message.includes('not found') ? 404 : message.includes('required') || message.includes('Invalid') ? 400 : 500
    return json({ error: message }, { status })
  }
}

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'CLI tool id is required' }, { status: 400 })
  }

  try {
    await deleteCliTool(userId, params.id)
    return json({ success: true })
  } catch (error) {
    console.error('[CLI Tools API] Failed to delete tool:', error)
    const message = error instanceof Error ? error.message : 'Failed to delete CLI tool'
    const status = message.includes('not found') ? 404 : 500
    return json({ error: message }, { status })
  }
}
