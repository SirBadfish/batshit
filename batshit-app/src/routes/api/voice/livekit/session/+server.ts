import { json, type RequestHandler } from '@sveltejs/kit'
import {
  createLiveKitVoiceSession,
  getLiveKitVoiceSetupHint
} from '$lib/server/services/liveKitVoiceRuntime'
import type { LiveKitVoiceSessionError, LiveKitVoiceSessionRequest } from '$lib/types/voiceLiveKit'
import { LIVEKIT_VOICE_RUNTIME_ID } from '$lib/types/voiceLiveKit'

function buildErrorBody(error: string, setupHint?: string): LiveKitVoiceSessionError {
  return {
    error,
    setupHint,
    runtime: LIVEKIT_VOICE_RUNTIME_ID,
    fallback: false
  }
}

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: LiveKitVoiceSessionRequest = {}
  const rawBody = await request.text()
  try {
    const parsed = rawBody.trim() ? JSON.parse(rawBody) : {}
    if (!isObjectPayload(parsed)) {
      return json(buildErrorBody('Invalid LiveKit voice session payload'), { status: 400 })
    }
    payload = parsed as LiveKitVoiceSessionRequest
  } catch {
    return json(buildErrorBody('Invalid JSON payload'), { status: 400 })
  }

  try {
    const session = await createLiveKitVoiceSession(locals.user.id, payload)
    return json(session, {
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create LiveKit voice session.'
    const setupHint = getLiveKitVoiceSetupHint(error)
    const body = buildErrorBody(message, setupHint)
    console.warn('[voice/livekit/session] Failed to create LiveKit voice session:', message)
    return json(body, { status: setupHint ? 412 : 500 })
  }
}
