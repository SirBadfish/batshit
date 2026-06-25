import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { listCoreSystemPrompts } from '$lib/server/services/systemPromptRegistry'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    return json({ prompts: await listCoreSystemPrompts() })
  } catch (error) {
    console.error('[Admin System Prompts] List failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load system prompts' },
      { status: 500 }
    )
  }
}
