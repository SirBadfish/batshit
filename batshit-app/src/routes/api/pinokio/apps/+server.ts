import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { searchPinokioApps } from '$lib/server/services/pinokioService'

/**
 * SA-072 P2: the apps installed in Pinokio on this computer, for the Artifact Power Source
 * picker's "Pinokio app" choice. Read-only (`pterm search`, local apps only); nothing starts.
 * When Pinokio is absent or closed the answer says so in the same words as Settings → Admin.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const result = await searchPinokioApps({ query: url.searchParams.get('q') ?? undefined })
    if (!result.ok) {
      return json({ available: result.kind !== 'unavailable', apps: [], message: result.message, reason: result.reason ?? null })
    }
    return json({
      available: true,
      apps: result.value.apps.map((app) => ({ appId: app.appId, title: app.title, state: app.state })),
      message: null
    })
  } catch (error) {
    console.error('[pinokio] App list failed:', error)
    return json({ error: 'Batshit could not list the Pinokio apps.' }, { status: 500 })
  }
}
