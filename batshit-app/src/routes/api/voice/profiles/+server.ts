import { json, type RequestHandler } from '@sveltejs/kit'
import { createVoiceProfile, listVoiceProfiles } from '$lib/server/services/voiceService'
import type { VoiceProfileRecord } from '$lib/types/voice'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const profiles = await listVoiceProfiles(locals.user.id)
    return json({ profiles })
  } catch (error) {
    console.error('[voice/profiles] Failed to load profiles:', error)
    return json({ error: 'Failed to load voice profiles' }, { status: 500 })
  }
}

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

  if (!payload?.name || !payload?.provider || !payload?.voiceId) {
    return json({ error: 'name, provider, and voiceId are required' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const profile: VoiceProfileRecord = {
    id: payload?.id ?? `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    user_id: locals.user.id,
    name: payload.name,
    provider: payload.provider,
    voiceId: payload.voiceId,
    model: payload.model ?? undefined,
    description: payload.description ?? undefined,
    isClone: Boolean(payload.isClone),
    settings: payload.settings ?? undefined,
    created_at: now,
    updated_at: now
  }

  try {
    const saved = await createVoiceProfile(profile)
    return json({ profile: saved })
  } catch (error) {
    console.error('[voice/profiles] Failed to create profile:', error)
    return json({ error: 'Failed to create voice profile' }, { status: 500 })
  }
}
