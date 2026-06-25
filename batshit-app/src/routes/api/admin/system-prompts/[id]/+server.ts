import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
  getCoreSystemPrompt,
  saveCoreSystemPrompt
} from '$lib/server/services/systemPromptRegistry'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ params, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    return json({ prompt: await getCoreSystemPrompt(params.id) })
  } catch (error) {
    console.error('[Admin System Prompts] Get failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load system prompt' },
      { status: 404 }
    )
  }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    const body = await request.json()
    const value = body?.value
    if (typeof value !== 'string') {
      return json({ error: 'Prompt value must be a string' }, { status: 400 })
    }

    return json({ prompt: await saveCoreSystemPrompt(params.id, value) })
  } catch (error) {
    console.error('[Admin System Prompts] Save failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to save system prompt' },
      { status: 500 }
    )
  }
}
