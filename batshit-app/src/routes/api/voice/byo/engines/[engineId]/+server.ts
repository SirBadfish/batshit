import { json, type RequestHandler } from '@sveltejs/kit'

import { deleteVoiceEngineRecord } from '$lib/server/services/voiceEngineRegistry'

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.engineId) {
    return json({ error: 'engineId is required' }, { status: 400 })
  }

  try {
    const payload = await request.json().catch(() => null)
    const result = await deleteVoiceEngineRecord(locals.user.id, params.engineId, {
      deleteLocalFiles: payload?.deleteLocalFiles === true
    })
    return json({ success: true, ...result })
  } catch (error) {
    console.error('[voice/byo/engines/:engineId] Failed to delete BYO engine:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to delete BYO engine'
      },
      { status: 400 }
    )
  }
}
