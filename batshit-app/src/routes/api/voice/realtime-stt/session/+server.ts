import { json, type RequestHandler } from '@sveltejs/kit'
import {
  createRealtimeSttSessionContract,
  getRealtimeSttSessionSetupHint,
  RealtimeSttSessionSetupError
} from '$lib/server/services/voiceRealtimeSttRuntime'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import type {
  VoiceRealtimeSttSessionError,
  VoiceRealtimeSttSessionRequest
} from '$lib/types/voiceRealtimeStt'

function buildErrorBody(error: string, setupHint?: string): VoiceRealtimeSttSessionError {
  return {
    error,
    setupHint,
    runtime: 'realtime-stt',
    fallback: false
  }
}

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export const POST: RequestHandler = async ({ request, locals }) => {
  let payload: VoiceRealtimeSttSessionRequest = {}
  const rawBody = await request.text()
  try {
    const parsed = rawBody.trim() ? JSON.parse(rawBody) : {}
    if (!isObjectPayload(parsed)) {
      return json(buildErrorBody('Invalid realtime STT session payload'), { status: 400 })
    }
    payload = parsed as VoiceRealtimeSttSessionRequest
  } catch {
    return json(buildErrorBody('Invalid JSON payload'), { status: 400 })
  }

  const trustedInternal = isTrustedInternalRequest(request)
  const internalUserId =
    trustedInternal && typeof (payload as Record<string, unknown>).userId === 'string'
      ? ((payload as Record<string, unknown>).userId as string).trim()
      : ''
  const userId = locals.user?.id || internalUserId

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const contract = await createRealtimeSttSessionContract(userId, payload)
    return json(contract, {
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create realtime STT session contract.'
    const setupHint = getRealtimeSttSessionSetupHint(error)
    const status = error instanceof RealtimeSttSessionSetupError ? error.status : 500
    console.warn('[voice/realtime-stt/session] Failed to create session contract:', message)
    return json(buildErrorBody(message, setupHint), { status })
  }
}
