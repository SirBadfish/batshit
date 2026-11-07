import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
  getCoreSystemPrompt,
  saveCoreSystemPrompt
} from '$lib/server/services/systemPromptRegistry'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import {
  BUILT_IN_ONLY_WRITE_REFUSAL,
  builtInOnlyPrompt,
  builtInOnlySummary,
  formatBuiltInText,
  formatStoredBuiltInText,
  withBuiltInFlag
} from '$lib/server/services/systemPromptBuiltIns'

export const GET: RequestHandler = async ({ params, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  // A section built entirely in code: its text, read-only (Josh, 2026-10-23).
  const builtInOnly = builtInOnlyPrompt(params.id)
  if (builtInOnly) {
    const text = formatBuiltInText(builtInOnly.parts)
    return json({ prompt: { ...builtInOnlySummary(builtInOnly), value: text, defaultValue: text } })
  }

  try {
    const prompt = withBuiltInFlag(await getCoreSystemPrompt(params.id))
    const builtInText = formatStoredBuiltInText(params.id, prompt.value)
    return json({ prompt: builtInText === null ? prompt : { ...prompt, builtInText } })
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

  if (builtInOnlyPrompt(params.id)) return json({ error: BUILT_IN_ONLY_WRITE_REFUSAL }, { status: 400 })

  try {
    const body = await request.json()
    const value = body?.value
    if (typeof value !== 'string') {
      return json({ error: 'Prompt value must be a string' }, { status: 400 })
    }

    return json({ prompt: withBuiltInFlag(await saveCoreSystemPrompt(params.id, value)) })
  } catch (error) {
    console.error('[Admin System Prompts] Save failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to save system prompt' },
      { status: 500 }
    )
  }
}
