import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  SessionDeleteRefusedError,
  deleteSessionStoppingItsTurn
} from '$lib/server/services/sessionDeleteTurnStop'
import { resolveFixedSessionMetadataUpdate } from '$lib/utils/fixedSession'
import { resolveSessionOriginMetadataUpdate } from '$lib/utils/sessionOrigin'

// GET /api/sessions/[id] - Get a specific session
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    // Get user's sessions to verify ownership
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }
    
    return json(session)
  } catch (error) {
    console.error('Error getting session:', error)
    return json({ error: 'Failed to get session' }, { status: 500 })
  }
}

/**
 * BL-690: the fields a browser may change through the generic update, each written by path. The
 * browser sends `{ name }`, `{ locked }`, `{ archived, archived_at }`, `{ last_modified_at }`
 * (stamped now anyway), and the group selection's `{ metadata }`, of which only `group_chat` is
 * the browser's. The update used to write the whole record with the browser's copy of `metadata`,
 * so a tab that had not seen a later Compact event or a graduation mark erased it.
 */
const BROWSER_SESSION_FIELDS = new Set(['name', 'locked', 'archived', 'archived_at'])
const ACCEPTED_SESSION_KEYS = new Set([...BROWSER_SESSION_FIELDS, 'last_modified_at', 'metadata'])

// PUT /api/sessions/[id] - Update a session
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const updates = await request.json()
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return json({ error: 'The update must be an object.' }, { status: 400 })
    }
    const unknownKeys = Object.keys(updates).filter((key) => !ACCEPTED_SESSION_KEYS.has(key))
    if (unknownKeys.length > 0) {
      return json(
        {
          error: `A chat update cannot change: ${unknownKeys.join(', ')}.`,
          code: 'unknown_session_field'
        },
        { status: 400 }
      )
    }
    // BL-722: a present `metadata` must be an object before any metadata rule reads it (a null
    // answered 500, and an Infinite Session's check answered 409).
    if (
      'metadata' in updates &&
      (!updates.metadata || typeof updates.metadata !== 'object' || Array.isArray(updates.metadata))
    ) {
      return json(
        { error: 'A chat update\'s metadata must be an object.', code: 'invalid_session_metadata' },
        { status: 400 }
      )
    }
    
    // Get user's sessions to verify ownership
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }

    // SA-104 P5: Infinite Session state is one-way and owned by the dedicated fixed route. A
    // generic update that would add, change, or remove it, or add a group to an Infinite
    // Session, is refused. (Since BL-690 no stored block is written from the update's metadata
    // except `group_chat`, so a stale copy that omits the state no longer strips it.)
    const fixedResolution = resolveFixedSessionMetadataUpdate(session.metadata, updates.metadata)
    if (!fixedResolution.ok) {
      return json({ error: fixedResolution.error, code: 'FIXED_SESSION_IMMUTABLE' }, { status: 409 })
    }

    // SA-113 P1 (DL-113-08): what started a chat is a fact about its history. A generic update
    // that would add, change, or remove it is refused.
    const originResolution = resolveSessionOriginMetadataUpdate(
      session.metadata,
      updates.metadata
    )
    if (!originResolution.ok) {
      return json(
        { error: originResolution.error, code: 'SESSION_ORIGIN_IMMUTABLE' },
        { status: 409 }
      )
    }

    // BL-690: only the browser's fields, each by path. Of the metadata, only `group_chat`: set
    // when the update carries one, removed when it does not (the group selection sends its copy of
    // the chat's metadata with the group added or taken out). Every other stored block stays.
    const fields: Record<string, unknown> = {}
    for (const key of BROWSER_SESSION_FIELDS) {
      if (key in updates) fields[key] = updates[key]
    }
    const incomingGroup = updates.metadata !== undefined ? (updates.metadata as Record<string, any>).group_chat : undefined
    const groupChat =
      updates.metadata === undefined
        ? undefined
        : incomingGroup && typeof incomingGroup === 'object' && !Array.isArray(incomingGroup)
          ? incomingGroup
          : null
    const written = await redis.updateSessionFields(params.id!, fields, groupChat)
    if (!written) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }
    return json({ success: true })
  } catch (error) {
    console.error('Error updating session:', error)
    return json({ error: 'Failed to update session' }, { status: 500 })
  }
}

// DELETE /api/sessions/[id] - Delete a session
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    // Get user's sessions to verify ownership
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }

    if (session.locked) {
      return json({ error: 'Session is locked. Unlock it before deleting.' }, { status: 409 })
    }
    
    // Delete the session and all related data. A reply still running in it is stopped first,
    // and the chat is swept once that reply's request is done (`sessionDeleteTurnStop.ts`).
    await deleteSessionStoppingItsTurn(params.id!)
    return json({ success: true })
  } catch (error) {
    if (error instanceof SessionDeleteRefusedError) {
      return json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('Error deleting session:', error)
    return json({ error: 'Failed to delete session' }, { status: 500 })
  }
}
