import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { detectPinokio } from '$lib/server/services/pinokioService'

/**
 * SA-072 P1: the one read-only Pinokio line in Settings → Admin → Runtimes. Detection only:
 * no setting, nothing started, and the same words `sys.pinokio.status` gives an agent.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const pinokio = await detectPinokio({ fresh: url.searchParams.get('fresh') === '1' })
    return json({ pinokio })
  } catch (error) {
    console.error('[pinokio] Status check failed:', error)
    return json({ error: 'Batshit could not check for Pinokio.' }, { status: 500 })
  }
}
