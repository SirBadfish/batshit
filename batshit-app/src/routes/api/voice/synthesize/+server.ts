import { json, type RequestHandler } from '@sveltejs/kit'
import { classifyVoiceApiError } from '$lib/server/services/voiceApiErrors'
import { synthesizeSpeech } from '$lib/server/services/voiceService'
import { toOwnedBytes } from '$lib/utils/binary'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch (error) {
    return json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  try {
    const result = await synthesizeSpeech({
      text: payload?.text ?? '',
      sourceText: payload?.sourceText ?? payload?.rawText ?? undefined,
      provider: payload?.provider ?? undefined,
      model: payload?.model ?? undefined,
      voiceId: payload?.voiceId ?? payload?.voice_id ?? undefined,
      profileId: payload?.profileId ?? payload?.voiceProfileId ?? undefined,
      options: payload?.options ?? {},
      agentId: payload?.agentId ?? payload?.agent_id ?? undefined,
      userId: locals.user.id
    })

    return new Response(toOwnedBytes(result.audio), {
      headers: {
        'Content-Type': result.mediaType,
        'Cache-Control': 'no-store',
        'x-voice-provider': result.provider,
        'x-voice-model': result.model ?? '',
        'x-voice-id': result.voiceId ?? ''
      }
    })
  } catch (error: unknown) {
    const details = classifyVoiceApiError(error, 'tts')
    if (details.logLevel === 'error') {
      console.error('[voice/synthesize] Failed to synthesize:', error)
    } else {
      console.warn(`[voice/synthesize] ${details.error}`)
    }

    return json(
      {
        error: details.error,
        setupHint: details.setupHint,
        mode: 'primary-only',
        fallback: false
      },
      { status: details.status }
    )
  }
}
