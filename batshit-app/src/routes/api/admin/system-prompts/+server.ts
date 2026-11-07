import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { listCoreSystemPrompts } from '$lib/server/services/systemPromptRegistry'
import {
  BUILT_IN_ONLY_PROMPT_IDS,
  builtInOnlyPrompt,
  builtInOnlySummary,
  withBuiltInFlag
} from '$lib/server/services/systemPromptBuiltIns'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    // Josh (2026-10-23): every prompt an agent gets is readable here. A stored prompt says when part
    // of it is built in code; a section built entirely in code is listed read-only after them.
    const stored = (await listCoreSystemPrompts()).map(withBuiltInFlag)
    const builtInOnly = BUILT_IN_ONLY_PROMPT_IDS.flatMap((id) => {
      const prompt = builtInOnlyPrompt(id)
      return prompt ? [builtInOnlySummary(prompt)] : []
    })
    return json({ prompts: [...stored, ...builtInOnly] })
  } catch (error) {
    console.error('[Admin System Prompts] List failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load system prompts' },
      { status: 500 }
    )
  }
}
