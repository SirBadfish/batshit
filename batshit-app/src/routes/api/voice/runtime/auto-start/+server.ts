import { json, type RequestHandler } from '@sveltejs/kit'

import { ensureVoiceRuntimesAutoStarted } from '$lib/server/services/voiceRuntimeAutoStart'

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const report = await ensureVoiceRuntimesAutoStarted(locals.user.id)
    return json(report)
  } catch (error) {
    console.error('[voice/runtime/auto-start] Failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to auto-start local voice runtimes.'
      },
      { status: 500 }
    )
  }
}
