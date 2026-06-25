import { json, type RequestHandler } from '@sveltejs/kit'

import {
  deleteVoiceEngineModel,
  downloadVoiceEngineModel,
  useVoiceEngineModel
} from '$lib/server/services/voiceEngineModels'

function normalizeAction(value: unknown): 'download' | 'use' | 'delete' {
  if (value === 'download' || value === 'use' || value === 'delete') {
    return value
  }
  throw new Error('action must be download, use, or delete.')
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('modelId is required.')
  }
  return value.trim()
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.engineId) {
    return json({ error: 'engineId is required' }, { status: 400 })
  }

  try {
    const data = await request.json()
    const action = normalizeAction(data?.action)
    const modelId = normalizeModelId(data?.modelId)
    const result =
      action === 'download'
        ? await downloadVoiceEngineModel(locals.user.id, params.engineId, modelId)
        : action === 'use'
          ? await useVoiceEngineModel(locals.user.id, params.engineId, modelId)
          : await deleteVoiceEngineModel(locals.user.id, params.engineId, modelId)

    return json({ success: true, action, ...result })
  } catch (error) {
    console.error('[voice/byo/engines/:engineId/models] Failed to manage BYO engine model:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to manage BYO engine model'
      },
      { status: 400 }
    )
  }
}
