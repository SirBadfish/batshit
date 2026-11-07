import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { resetCoreSystemPrompt } from '$lib/server/services/systemPromptRegistry'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import { BUILT_IN_ONLY_WRITE_REFUSAL, builtInOnlyPrompt, withBuiltInFlag } from '$lib/server/services/systemPromptBuiltIns'

export const POST: RequestHandler = async ({ params, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response
  if (builtInOnlyPrompt(params.id)) return json({ error: BUILT_IN_ONLY_WRITE_REFUSAL }, { status: 400 })

  try {
    return json({ prompt: withBuiltInFlag(await resetCoreSystemPrompt(params.id)) })
  } catch (error) {
    console.error('[Admin System Prompts] Reset failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to reset system prompt' },
      { status: 500 }
    )
  }
}
