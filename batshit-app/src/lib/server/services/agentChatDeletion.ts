/**
 * Delete a Primary Agent's own chats with the agent (2026-09-19, Josh's call).
 *
 * "Delete everything about that agent" includes the chats it had with the user, when the
 * user says so: the delete dialog carries an "Also delete its chats" checkbox (on by default)
 * and the route passes `chats=1`. Group chats are never the agent's: a group belongs to every
 * agent in it, so a group chat stays and `deleteAgent` only takes the agent off the roster.
 *
 * Which chats count: every non-group session whose `agent_id` is the agent, archived ones
 * included. An Infinite Session is auto-locked when it is created (`sessions/[id]/fixed`),
 * and it belongs to exactly ONE agent (a send from any other agent is refused), so a deleted
 * agent's Infinite Session can never be used again: it is unlocked and deleted here. A
 * REGULAR chat the user locked is the user's own "keep this" and is kept; the result names
 * how many were kept so the dialog's promise stays honest.
 *
 * Every delete goes through `deleteSessionStoppingItsTurn`, the one door (never
 * `redis.deleteSession`): it stops a running reply first, sweeps every session-scoped key,
 * and tells every tab (`session_deleted`). A refusal from the door (a reply still stopping)
 * propagates as-is, so the route answers 409 and the agent is NOT deleted: the user retries.
 */
import { redis } from '$lib/server/redis'
import { deleteSessionStoppingItsTurn } from '$lib/server/services/sessionDeleteTurnStop'
import { isFixedSession } from '$lib/utils/fixedSession'

export interface AgentChatCandidate {
  id: string
  locked: boolean
  fixed: boolean
  archived: boolean
}

export interface AgentChatSelection {
  /** Chats the delete will remove: unlocked regular chats and every Infinite Session. */
  deletable: AgentChatCandidate[]
  /** Regular chats the user locked: kept, and counted so the dialog can say so. */
  keptLocked: AgentChatCandidate[]
}

/** Pure selection over loaded session rows; the route and the dialog count share it. */
export function selectAgentChats(
  sessions: ReadonlyArray<Record<string, any>>,
  agentId: string
): AgentChatSelection {
  const deletable: AgentChatCandidate[] = []
  const keptLocked: AgentChatCandidate[] = []
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string') continue
    if (session.agent_id !== agentId) continue
    const metadata = (session.metadata ?? {}) as Record<string, any>
    if (metadata.group_chat) continue
    const candidate: AgentChatCandidate = {
      id: session.id,
      locked: session.locked === true,
      fixed: isFixedSession(session),
      archived: session.archived === true
    }
    if (candidate.locked && !candidate.fixed) keptLocked.push(candidate)
    else deletable.push(candidate)
  }
  return { deletable, keptLocked }
}

export async function selectAgentChatsForUser(
  userId: string,
  agentId: string
): Promise<AgentChatSelection> {
  const sessions = await redis.getSessions(userId, true)
  return selectAgentChats(sessions as unknown as Record<string, any>[], agentId)
}

export interface AgentChatDeletionResult {
  deleted: string[]
  keptLocked: string[]
}

/**
 * Delete the agent's chats, oldest listing order, stopping at the first refusal (which is
 * rethrown untouched). Chats already deleted before a refusal stay deleted: each one was a
 * whole, honest delete, and the route reports the agent as NOT deleted so the user retries.
 */
export async function deleteAgentChats(
  userId: string,
  agentId: string,
  deps: {
    select?: typeof selectAgentChatsForUser
    unlock?: (sessionId: string) => Promise<void>
    deleteOne?: (sessionId: string) => Promise<unknown>
  } = {}
): Promise<AgentChatDeletionResult> {
  const select = deps.select ?? selectAgentChatsForUser
  const unlock =
    deps.unlock ?? (async (sessionId: string) => redis.updateSession(sessionId, { locked: false }))
  const deleteOne = deps.deleteOne ?? deleteSessionStoppingItsTurn
  const selection = await select(userId, agentId)
  const deleted: string[] = []
  for (const chat of selection.deletable) {
    // An Infinite Session's lock is Batshit's own (set when the chat became Infinite), not
    // the user's "keep this": lift it, because the chat cannot outlive its one agent.
    if (chat.locked && chat.fixed) await unlock(chat.id)
    await deleteOne(chat.id)
    deleted.push(chat.id)
  }
  return { deleted, keptLocked: selection.keptLocked.map((chat) => chat.id) }
}
