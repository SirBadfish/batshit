import { json, type RequestHandler } from '@sveltejs/kit'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { listEpisodes } from '$lib/server/services/memory/memoryEpisodes'

/**
 * SA-104 P5 — minimal episode state for the session menu (Infinite Sessions).
 * Read-only; heavy episode UI is deliberately out of v1 scope.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const sessionCheck = await requireOwnedSession(params.id, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  try {
    const episodes = await listEpisodes(sessionCheck.value.id)
    const open = episodes.find((episode) => episode.state === 'open') ?? null
    return json({
      episodes: episodes.map((episode) => ({
        id: episode.id,
        state: episode.state,
        opened_at: episode.opened_at,
        closed_at: episode.closed_at ?? null,
        boundary_signal: episode.boundary_signal ?? null,
        hold_until: episode.hold_until ?? null,
        has_whiteboard: Boolean(episode.whiteboard?.content)
      })),
      open: open
        ? {
            id: open.id,
            opened_at: open.opened_at,
            hold_until: open.hold_until ?? null,
            // SA-104 P6 (DL-104-16): the whiteboard is never hidden from the user.
            whiteboard: open.whiteboard?.content ?? null,
            whiteboard_updated_at: open.whiteboard?.updated_at ?? null
          }
        : null,
      closedCount: episodes.filter((episode) => episode.state !== 'open').length
    })
  } catch (error) {
    console.error('[Sessions] Failed to list episodes:', error)
    return json({ error: 'Failed to load episode state' }, { status: 500 })
  }
}
