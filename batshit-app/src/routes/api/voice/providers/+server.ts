import { json, type RequestHandler } from '@sveltejs/kit'
import { buildVoiceProviderSummary } from '$lib/server/services/voiceService'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const providers = await buildVoiceProviderSummary(locals.user.id)
    return json({ providers })
  } catch (error) {
    console.error('[voice/providers] Failed to load providers:', error)
    return json({ error: 'Failed to load voice providers' }, { status: 500 })
  }
}
