import { json, type RequestHandler } from '@sveltejs/kit'
import { listVoices } from '$lib/server/services/voiceService'
import type { VoiceProviderId } from '$lib/types/voice'

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const providerParam = url.searchParams.get('provider')
  if (!providerParam) {
    return json({ error: 'Missing provider parameter' }, { status: 400 })
  }

  try {
    const voices = await listVoices({
      userId: locals.user.id,
      provider: providerParam as VoiceProviderId,
      model: url.searchParams.get('model')
    })
    return json({ voices })
  } catch (error) {
    console.error('[voice/voices] Failed to list voices:', error)
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to list voices'
    return json({ error: message }, { status: 500 })
  }
}
