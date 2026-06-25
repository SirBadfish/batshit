import { json, type RequestHandler } from '@sveltejs/kit'
import {
  createDeepgramRealtimeSttEphemeralToken,
  getRealtimeSttSessionSetupHint,
  RealtimeSttSessionSetupError
} from '$lib/server/services/voiceRealtimeSttRuntime'
import type { VoiceRealtimeSttSessionError } from '$lib/types/voiceRealtimeStt'

function buildErrorBody(error: string, setupHint?: string): VoiceRealtimeSttSessionError {
  return {
    error,
    setupHint,
    runtime: 'realtime-stt',
    fallback: false
  }
}

function parseTtlSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let ttlSeconds: number | null = null
  const rawBody = await request.text()
  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json(buildErrorBody('Invalid Deepgram token payload'), { status: 400 })
      }
      ttlSeconds = parseTtlSeconds((parsed as Record<string, unknown>).ttlSeconds)
    } catch {
      return json(buildErrorBody('Invalid JSON payload'), { status: 400 })
    }
  }

  try {
    const token = await createDeepgramRealtimeSttEphemeralToken(locals.user.id, {
      ttlSeconds
    })
    return json(token, {
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to mint Deepgram realtime STT token.'
    const setupHint = getRealtimeSttSessionSetupHint(error)
    const status = error instanceof RealtimeSttSessionSetupError ? error.status : 500
    console.warn('[voice/realtime-stt/deepgram-token] Failed to mint token:', message)
    return json(buildErrorBody(message, setupHint), { status })
  }
}
