import { json, type RequestHandler } from '@sveltejs/kit'
import type { VoiceProviderId } from '$lib/types/voice'
import { VOICE_REALTIME_TTS_CONTENT_TYPE } from '$lib/types/voiceRealtime'
import { classifyVoiceApiError } from '$lib/server/services/voiceApiErrors'
import { streamSpeechRealtime } from '$lib/server/services/voiceService'

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`)
  }
  return value
}

function optionalStringAlias(
  payload: Record<string, unknown>,
  fieldNames: string[]
): string | undefined {
  for (const fieldName of fieldNames) {
    if (payload[fieldName] != null) return optionalString(payload[fieldName], fieldName)
  }
  return undefined
}

function optionalObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (value == null) return {}
  if (!isObjectPayload(value)) {
    throw new Error(`${fieldName} must be an object.`)
  }
  return value
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'Invalid JSON payload', fallback: false }, { status: 400 })
  }

  if (!isObjectPayload(payload)) {
    return json({ error: 'Invalid realtime speech payload', fallback: false }, { status: 400 })
  }

  let realtimeRequest: Parameters<typeof streamSpeechRealtime>[0]
  try {
    realtimeRequest = {
      text: optionalString(payload.text, 'text') ?? '',
      sourceText: optionalStringAlias(payload, ['sourceText', 'rawText']),
      provider: optionalString(payload.provider, 'provider') as VoiceProviderId | undefined,
      model: optionalString(payload.model, 'model'),
      voiceId: optionalStringAlias(payload, ['voiceId', 'voice_id']),
      profileId: optionalStringAlias(payload, ['profileId', 'voiceProfileId']),
      options: optionalObject(payload.options, 'options'),
      agentId: optionalStringAlias(payload, ['agentId', 'agent_id']),
      userId: locals.user.id
    }
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Invalid realtime speech payload',
        fallback: false
      },
      { status: 400 }
    )
  }

  try {
    const stream = await streamSpeechRealtime(realtimeRequest, request.signal)

    return new Response(stream, {
      headers: {
        'Content-Type': VOICE_REALTIME_TTS_CONTENT_TYPE,
        'Cache-Control': 'no-store',
        'x-voice-stream': 'direct-realtime'
      }
    })
  } catch (error: unknown) {
    const details = classifyVoiceApiError(error, 'tts')
    if (details.logLevel === 'error') {
      console.error('[voice/stream] Failed to start realtime TTS:', error)
    } else {
      console.warn(`[voice/stream] ${details.error}`)
    }

    return json(
      {
        error: details.error,
        setupHint: details.setupHint,
        mode: 'realtime-primary-only',
        fallback: false
      },
      { status: details.status }
    )
  }
}
