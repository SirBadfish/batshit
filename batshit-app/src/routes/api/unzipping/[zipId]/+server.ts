import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import { closeSkillSessionFromZipAction, type SkillZipClosure } from '$lib/server/services/skillSessions'
import { publishUserEvent } from '$lib/server/ssePublisher'

// DELETE: Rezip an item (remove from unzipped set)
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const { zipId } = params
  const sessionId = url.searchParams.get('sessionId')
  // The user's doorway (SA-129 P2): a browser's "Zip now" is always the user's; an agent's zip
  // action is written by the server at its reply end.
  const source = 'user'
  const returnToAutomatic = url.searchParams.get('mode') === 'automatic'
  
  if (!zipId || !sessionId) {
    return new Response('Missing required parameters', { status: 400 })
  }

  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  try {
    let skillClosure: SkillZipClosure | null = null
    // One writer at a time per chat (SA-129 P2b, BL-352): a reply end's hold move or countdown
    // never writes back over this Release or "Zip now".
    const mode = await withZipStateLock(sessionId, async () => {
      skillClosure = await closeSkillSessionFromZipAction({ userId: user.value.id, sessionId, zipId,
        reason: returnToAutomatic ? 'release' : 'zip' })
      if (skillClosure) return 'skill_closed' as const
      // Remove from unzipped set
      const unzippedKey = `unzipped:${sessionId}`
      await redis.sRem(unzippedKey, zipId)

      // Delete item metadata
      const itemKey = `unzipped_item:${sessionId}:${zipId}`
      await redis.del(itemKey)

      const rezippedKey = `rezipped:${sessionId}`
      if (returnToAutomatic) {
        await redis.sRem(rezippedKey, zipId)
        await redis.del(`rezipped_item:${sessionId}:${zipId}`)
        return 'automatic' as const
      }

      // Track manual rezip to force compression
      await redis.sAdd(rezippedKey, zipId)
      await redis.set(`rezipped_item:${sessionId}:${zipId}`, {
        zipId,
        sessionId,
        source,
        rezippedAt: Date.now()
      })
      return 'rezipped' as const
    })

    if (skillClosure) await publishUserEvent(user.value.id, { type: 'zip_state_changed', sessionId, source: 'user',
      opened: [], rezipped: (skillClosure as SkillZipClosure).changedZipIds })
    return json({ success: true, mode, ...(skillClosure ? { skillClosure } : {}) })
  } catch (error) {
    console.error('Failed to rezip item:', error)
    return new Response('Failed to rezip item', { status: 500 })
  }
}
