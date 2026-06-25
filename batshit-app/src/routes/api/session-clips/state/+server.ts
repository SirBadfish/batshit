import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  attachSessionClip,
  decrementSessionClipDurations,
  detachSessionClip,
  listActiveClipIds,
  normalizeSessionClipState,
  temporarilyUnclipSessionClip,
  tickTemporaryClipReattach,
  updateSessionClipDuration
} from '$lib/server/services/sessionClipState'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

// This file now only handles POST requests for clip state actions
// GET and DELETE are handled by [sessionId]/+server.ts

// POST /api/session-clips/state - Update session's clip state
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const user = requireUser(locals)
    if (!user.ok) return user.response

    const { sessionId, clipId, action, messageId, unclipAfter } = await request.json()
    
    if (!sessionId || !action) {
      return json({ error: 'Session ID and action required' }, { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const stateKey = `session:${sessionId}:clip_state`
    const existingData = await redis.get(stateKey)
    let state = normalizeSessionClipState(sessionId, existingData)

    switch (action) {
      case 'attach':
        if (!clipId) {
          return json({ error: 'Clip ID required for attach action' }, { status: 400 })
        }
        state = attachSessionClip(state, {
          clipId,
          messageId,
          unclipAfter
        })
        break

      case 'detach':
        if (!clipId) {
          return json({ error: 'Clip ID required for detach action' }, { status: 400 })
        }
        state = detachSessionClip(state, clipId)
        break

      case 'update_duration':
        if (!clipId) {
          return json({ error: 'Clip ID required for update_duration action' }, { status: 400 })
        }
        state = updateSessionClipDuration(state, clipId, unclipAfter ?? null)
        break

      case 'decrement_durations':
        state = tickTemporaryClipReattach(decrementSessionClipDurations(state))
        break

      case 'temporary_unclip':
        if (!clipId) {
          return json({ error: 'Clip ID required for temporary_unclip action' }, { status: 400 })
        }
        state = temporarilyUnclipSessionClip(state, clipId, unclipAfter ?? null)
        break
    }

    // Save updated state
    await redis.set(stateKey, state)

    // Keep the active clip set aligned with the normalized session state.
    const activeKey = `session:${sessionId}:active_clips`
    const activeClipIds = listActiveClipIds(state)
    await redis.del(activeKey)
    for (const activeClipId of activeClipIds) {
      await redis.sAdd(activeKey, activeClipId)
    }

    return json(state)
  } catch (error) {
    console.error('Error updating session clip state:', error)
    return json({ error: 'Failed to update clip state' }, { status: 500 })
  }
}
