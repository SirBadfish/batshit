import { json, type RequestHandler } from '@sveltejs/kit'
import { cloneVoice } from '$lib/server/services/voiceService'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const form = await request.formData().catch(() => null)
  if (!form) {
    return json({ error: 'Invalid form data' }, { status: 400 })
  }

  const audioFile = form.get('audio')
  const provider = form.get('provider')?.toString()
  const name = form.get('name')?.toString()
  const description = form.get('description')?.toString() || undefined
  const referenceText = form.get('refText')?.toString() || undefined

  if (!(audioFile instanceof File)) {
    return json({ error: 'Audio file is required' }, { status: 400 })
  }
  if (!provider) {
    return json({ error: 'Provider is required' }, { status: 400 })
  }
  if (!name) {
    return json({ error: 'Name is required' }, { status: 400 })
  }

  const audioBuffer = new Uint8Array(await audioFile.arrayBuffer())

  try {
    const result = await cloneVoice({
      audio: audioBuffer,
      provider: provider as any,
      name,
      description,
      filename: audioFile.name || undefined,
      contentType: audioFile.type || undefined,
      referenceText,
      userId: locals.user.id
    })

    return json({ voiceId: result.voiceId, profile: result.profile })
  } catch (error: any) {
    console.error('[voice/clone] Failed to clone voice:', error)
    return json({ error: error?.message || 'Failed to clone voice' }, { status: 500 })
  }
}
