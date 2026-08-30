import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { buildFixedSessionMetadata, isFixedSession } from '$lib/utils/fixedSession'

/**
 * SA-104 P5 — the ONE Infinite Session transition path (DL-104-12).
 *
 * `redis.updateSession` replaces `metadata` wholesale, so the transition merges
 * against the freshest stored record here, server-side. The choice is one-way:
 * there is no DELETE/unset counterpart anywhere, and the generic session PUT
 * refuses to touch the stored block (`resolveFixedSessionMetadataUpdate`).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const sessionCheck = await requireOwnedSession(params.id, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response
  const session = sessionCheck.value

  if (isFixedSession(session)) {
    // Idempotent: a double-submit is not an error; the state already holds.
    return json({ success: true, alreadyFixed: true, session })
  }

  if (session.archived) {
    return json(
      { error: 'Unarchive this session before making it an Infinite Session.', code: 'FIXED_SESSION_ARCHIVED' },
      { status: 409 }
    )
  }

  if ((session.metadata as Record<string, any> | undefined)?.group_chat) {
    return json(
      {
        error: 'Infinite Sessions do not support group chat. Switch the chat target to a single agent first.',
        code: 'FIXED_SESSION_GROUP_UNSUPPORTED'
      },
      { status: 409 }
    )
  }

  // Pre-first-message only (the session-ID-edit precedent): one message is enough
  // to know the conversation began.
  const messages = await redis.getMessages(session.id, 1)
  if (Array.isArray(messages) && messages.length > 0) {
    return json(
      {
        error: 'Infinite Sessions can only be created before the first message is sent.',
        code: 'FIXED_SESSION_HAS_MESSAGES'
      },
      { status: 409 }
    )
  }

  const nextMetadata = {
    ...((session.metadata as Record<string, any> | undefined) ?? {}),
    fixedSession: buildFixedSessionMetadata()
  }

  // Auto-lock rides the existing 4-layer deletion guard (P0 §1.6). The user may
  // still deliberately unlock later — deletion must stay possible (DL-104-02).
  await redis.updateSession(session.id, { metadata: nextMetadata, locked: true })

  const updated = await redis.getSession(session.id)
  return json({ success: true, session: updated })
}
