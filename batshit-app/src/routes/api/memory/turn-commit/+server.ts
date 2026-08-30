/**
 * SA-104 P5 — the native n8n lane's accepted-send memory commit.
 *
 * P4 placed `commitMemoryTurnState` at send-routed's clip-consumption boundaries, but
 * native n8n Primary sends never pass through send-routed (the browser consumes the
 * webhook directly), so the flagship n8n lane never ticked linger windows, never
 * consumed pending recalls, and never advanced the last-interaction stamp — a P4 gap
 * found and fixed in P5 (packet doc §1.9). `messageApi.sendMessage` calls this route
 * at the moment the webhook POST is accepted. The failure direction stays safe: a
 * client crash after webhook-accept under-ticks one turn; double-ticks are impossible
 * because only one commit runs per accepted send.
 *
 * The same call opens an Infinite Session's episode lazily (P5 §1.10) — one open episode
 * while the session is being lived in; regular sessions are untouched.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { commitMemoryTurnState } from '$lib/server/services/memory/memoryRecall'
import { ensureFixedSessionOpenEpisode } from '$lib/server/services/memory/memoryEpisodes'

type TurnCommitRequest = {
  sessionId?: string
  agentId?: string
  currentUserMessage?: string
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: TurnCommitRequest
  try {
    body = (await request.json()) as TurnCommitRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const currentUserMessage =
    typeof body.currentUserMessage === 'string' ? body.currentUserMessage : ''

  if (!sessionId || !agentId) {
    return json({ error: 'sessionId and agentId are required' }, { status: 400 })
  }
  if (!currentUserMessage.trim()) {
    return json({ error: 'currentUserMessage is required for a turn commit' }, { status: 400 })
  }

  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response
  const session = sessionCheck.value

  // Group recall is inert in v1 (P4 recorded limitation) — group turns commit nothing.
  if ((session.metadata as Record<string, any> | undefined)?.group_chat) {
    return json({ committed: false, reason: 'group_session' })
  }

  try {
    // Episode upkeep runs BEFORE the commit (2026-08-28) so 'episode' linger holds
    // bind to the episode this send belongs to; regular sessions return null untouched.
    await ensureFixedSessionOpenEpisode({ session, sessionId, agentId })
    const result = await commitMemoryTurnState({
      userId: user.value.id,
      agentId,
      sessionId,
      currentUserMessage
    })
    return json(result)
  } catch (error) {
    console.error('[Memory Turn Commit] Failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Memory turn commit failed' },
      { status: 500 }
    )
  }
}
