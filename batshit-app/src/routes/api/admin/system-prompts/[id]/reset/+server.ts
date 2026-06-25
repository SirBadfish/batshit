import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { resetCoreSystemPrompt } from '$lib/server/services/systemPromptRegistry'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const POST: RequestHandler = async ({ params, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    return json({ prompt: await resetCoreSystemPrompt(params.id) })
  } catch (error) {
    console.error('[Admin System Prompts] Reset failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to reset system prompt' },
      { status: 500 }
    )
  }
}
