import { json, type RequestHandler } from '@sveltejs/kit'

import {
  getLiveKitSidecarRuntimeSummary,
  installLiveKitSidecarRuntime,
  startLiveKitSidecarRuntime
} from '$lib/server/services/liveKitSidecarRuntime'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const runtime = await getLiveKitSidecarRuntimeSummary(locals.user.id)
    return json({ runtime })
  } catch (error) {
    console.error('[voice/runtime/livekit] Failed to inspect runtime:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to inspect LiveKit runtime.'
      },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json().catch(() => null)
    const body =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}
    const operation = typeof body.operation === 'string' ? body.operation.trim() : 'start'
    const forceRestart = body.forceRestart === true

    if (operation === 'install') {
      const result = await installLiveKitSidecarRuntime(locals.user.id)
      return json(result)
    }

    if (operation && operation !== 'start') {
      return json({ error: `Unsupported LiveKit runtime operation "${operation}".` }, { status: 400 })
    }

    const runtime = await startLiveKitSidecarRuntime(locals.user.id, { forceRestart })
    return json({ runtime })
  } catch (error) {
    console.error('[voice/runtime/livekit] Failed to start runtime:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to start LiveKit runtime.'
      },
      { status: 500 }
    )
  }
}
