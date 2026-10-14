/**
 * BL-778: deleting a Primary Agent may take its own chats with it, and the confirm dialog's
 * checkbox is built from a live count (`GET /api/agents/{id}/chats`). A failed count must never
 * be read as "zero chats" or silently fall back to the plain no-checkbox dialog -- that dialog
 * still deletes the agent, but with `deleteChats` left false, so the agent's chats are kept and
 * nothing tells the user the checkbox was ever dropped. This function is the one place that
 * decides "did the count actually work", so the caller can refuse the delete instead of guessing.
 */

export interface AgentChatCounts {
  deletable: number
  infinite: number
  keptLocked: number
  /** BL-778 part 2: how many of `deletable` are archived, named in the dialog checkbox. */
  archived: number
}

export type AgentDeleteChatCountOutcome =
  | { status: 'ok'; counts: AgentChatCounts }
  | { status: 'failed' }

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * `response` is the fetch Response (or null, for a thrown fetch); `body` is its already-parsed
 * JSON (or null when parsing itself failed). Anything other than a genuinely well-shaped count
 * is `failed` -- an ok response with a malformed body is not "zero chats", it is a count that
 * did not work.
 */
export function resolveAgentDeleteChatCountOutcome(
  response: { ok: boolean } | null,
  body: unknown
): AgentDeleteChatCountOutcome {
  if (!response || !response.ok) return { status: 'failed' }
  if (!body || typeof body !== 'object') return { status: 'failed' }

  const candidate = body as Record<string, unknown>
  if (
    !isFiniteNonNegative(candidate.deletable) ||
    !isFiniteNonNegative(candidate.infinite) ||
    !isFiniteNonNegative(candidate.keptLocked) ||
    !isFiniteNonNegative(candidate.archived)
  ) {
    return { status: 'failed' }
  }

  return {
    status: 'ok',
    counts: {
      deletable: candidate.deletable,
      infinite: candidate.infinite,
      keptLocked: candidate.keptLocked,
      archived: candidate.archived
    }
  }
}
