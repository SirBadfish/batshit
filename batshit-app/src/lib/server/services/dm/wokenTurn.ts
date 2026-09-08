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

const WOKEN_TURN_MESSAGE_WINDOW = 50

export type WokenTurnState = { woken: false } | { woken: true; dmId: string | null }

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readWakeBlock(message: unknown): Record<string, any> | null {
  const wake = (message as Record<string, any>)?.metadata?.wake
  if (!wake || typeof wake !== 'object' || Array.isArray(wake)) return null
  return wake as Record<string, any>
}

/**
 * Is the acting session's LATEST user message a wake?
 *
 * **Fails closed.** An unreadable session answers `woken: true`, because the only caller is
 * a security gate and the cost of being wrong is one retry the user is present for.
 *
 * A missing or empty session id is NOT a failure: it means there is no chat to have started
 * this call (the artifact runtime, service actors), so it answers `woken: false`.
 */
export async function resolveWokenTurnState(sessionId: unknown): Promise<WokenTurnState> {
  const id = trimmed(sessionId)
  if (!id) return { woken: false }
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
