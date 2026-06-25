import { json, type RequestHandler } from '@sveltejs/kit'
import { deleteVoiceProfile } from '$lib/server/services/voiceService'

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'Missing profile id' }, { status: 400 })
  }

  try {
    await deleteVoiceProfile(locals.user.id, params.id)
    return json({ success: true })
  } catch (error) {
    console.error('[voice/profiles] Failed to delete profile:', error)
    return json({ error: 'Failed to delete voice profile' }, { status: 500 })
  }
}
