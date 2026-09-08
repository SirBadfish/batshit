/**
 * SA-113 F-SEC-1 / F-SEC-1b — "did a person start this turn?", read from one place.
 *
 * A woken turn is a turn Batshit started with nobody typing: a DM sent with `deliver:
 * 'wake'`, or a wake-up webhook. The wake primitive stamps `metadata.wake` on the user
 * message it writes, and that stamp is the ONLY durable difference between a woken turn and
 * a typed one — the session record cannot answer it, because "One at a time" wakes into a
 * chat the user may have started.
 *
 * One caller, one question: `useControl` asks **is the latest user turn a wake?** — the
 * security gate that refuses risky Fabric controls (F-SEC-1). A human reply makes the answer
 * `false` from that reply onward, which is exactly what the refusal tells the agent to wait
 * for. (Clearing a "needs you" stamp after that reply is NOT read from the message window:
 * `clearNeedsUserForHumanReply` in `dmStore.ts` keys on the DM's own `delivery.sessionId`,
 * which every wake stamps — F-P5b-1.)
 *
 * A leaf module on purpose: `dmTools.ts` imports `agentWakeups.ts`, so nothing here may
 * import either. It reads Redis and nothing else.
 *
 * The window is the recent fifty, matching `resolveSessionChainDepth`. F-P2-1 is the reason
 * it is the recent fifty and not the first fifty: reading the head of a long chat answers
 * about an old message instead of the turn actually running.
 */

import { redis } from '$lib/server/redis'
import { findWakeRunForAgent, listWakeRuns } from '$lib/server/services/wakeRunRegistry'

const WOKEN_TURN_MESSAGE_WINDOW = 50

export type WokenTurnState = { woken: false } | { woken: true; dmId: string | null }

/** What the CALLER claims about itself. Every field here is caller-supplied — see below. */
export interface WokenTurnActor {
  userId?: string | null
  agentId?: string | null
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readWakeBlock(message: unknown): Record<string, any> | null {
  const wake = (message as Record<string, any>)?.metadata?.wake
  if (!wake || typeof wake !== 'object' || Array.isArray(wake)) return null
  return wake as Record<string, any>
}

/**
 * Is the acting turn a wake?
 *
 * **Fails closed.** An unreadable session answers `woken: true`, because the only caller is
 * a security gate and the cost of being wrong is one retry the user is present for.
 *
 * ## Why `sessionId` alone is not enough
 *
 * `sessionId` reaches the gate from the request BODY on the `/api/controls/use` lane, and
 * the MCP gateway fills it from the model's own tool arguments. An empty id used to answer
 * `woken: false` outright, so a woken agent closed the gate on itself simply by leaving the
 * field out — the refusal was the caller's to opt into. Naming a different, calm chat did
 * the same thing.
 *
 * So the session read is now the SECOND source, and the wake registry — server-owned, in
 * process, unforgeable from a request body — is the first:
 *
 *   - the acting agent has a woken turn in flight        → woken, whatever the body says;
 *   - no id, but this user has ANY woken turn in flight  → woken, because the call cannot
 *     prove it belongs to the other chat.
 *
 * The second rule costs a false refusal only for a session-less risky call made WHILE a
 * wake-up runs (the artifact runtime and service actors); every in-process lane passes a
 * real `sessionId`, so it does not fire for them. A refusal there is one retry once the
 * wake-up ends; the alternative is a gate that any caller can switch off.
 */
export async function resolveWokenTurnState(
  sessionId: unknown,
  actor?: WokenTurnActor
): Promise<WokenTurnState> {
  const id = trimmed(sessionId)

  // An agent with a woken turn in flight is woken, whatever chat the body names. Honouring
  // a different, calm session id here would leave the bypass open in its quieter form:
  // point at any other chat of the same user and read back "a human typed this". The cost
  // is a false refusal if the user types to that same agent elsewhere while its wake-up
  // runs — a visible refusal that says to retry, not a silent grant.
  const claimedAgentId = trimmed(actor?.agentId)
  if (claimedAgentId && findWakeRunForAgent(claimedAgentId)) {
    return { woken: true, dmId: null }
  }

  if (!id) {
    const claimedUserId = trimmed(actor?.userId)
    const userHasWokenTurn = listWakeRuns().some(
      (run) => !claimedUserId || run.userId === claimedUserId
    )
    return userHasWokenTurn ? { woken: true, dmId: null } : { woken: false }
  }

  try {
    const messages = await redis.getRecentMessages(id, WOKEN_TURN_MESSAGE_WINDOW)
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as Record<string, any>
      if (message?.role !== 'user') continue
      const wake = readWakeBlock(message)
      if (!wake) return { woken: false }
      return { woken: true, dmId: trimmed(wake.dmId) || null }
    }
  } catch (error) {
    console.warn(
      '[Agent DMs] Could not tell a woken turn from a typed one; treating it as woken:',
      error
    )
    return { woken: true, dmId: null }
  }
  return { woken: false }
}
