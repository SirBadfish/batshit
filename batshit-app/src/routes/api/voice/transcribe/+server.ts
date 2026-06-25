import { json, type RequestHandler } from '@sveltejs/kit'
import { classifyVoiceApiError } from '$lib/server/services/voiceApiErrors'
import { transcribeAudio } from '$lib/server/services/voiceService'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const form = await request.formData().catch(() => null)
  if (!form) {
    return json({ error: 'Invalid form data' }, { status: 400 })
  }

  const audioFile = form.get('audio')
  if (!(audioFile instanceof File)) {
    return json({ error: 'Audio file is required' }, { status: 400 })
  }

  const provider = form.get('provider')?.toString()
  const model = form.get('model')?.toString()
  const language = form.get('language')?.toString()

  const audioBuffer = new Uint8Array(await audioFile.arrayBuffer())

  try {
    const result = await transcribeAudio({
      audio: audioBuffer,
      provider: provider as any,
      model: model ?? undefined,
      language: language ?? undefined,
      contentType: audioFile.type || undefined,
      userId: locals.user.id
    })

    return json(result)
  } catch (error: unknown) {
    const details = classifyVoiceApiError(error, 'stt')
    if (details.logLevel === 'error') {
      console.error('[voice/transcribe] Failed to transcribe:', error)
    } else {
      console.warn(`[voice/transcribe] ${details.error}`)
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
