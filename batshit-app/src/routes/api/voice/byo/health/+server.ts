import { json, type RequestHandler } from '@sveltejs/kit'
import { normalizeVoiceProviderId } from '$lib/utils/voiceSchema'
import { checkByoSpeechStatus } from '$lib/server/services/voiceService'

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const providerParam = url.searchParams.get('provider')
  const providerId = normalizeVoiceProviderId(providerParam)
  if (!providerId || !providerId.startsWith('byo:')) {
    return json({ error: 'A BYO provider id is required (for example: byo:parakeet).' }, { status: 400 })
  }

  try {
    const status = await checkByoSpeechStatus(locals.user.id, providerId)
    return json(status)
  } catch (error) {
    console.error('[voice/byo/health] Failed to check BYO endpoint:', error)
    return json({ error: 'Failed to check BYO Speech endpoint' }, { status: 500 })
  }
}
