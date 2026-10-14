/**
 * BL-494 P2: retained tool-output copies are a per-reply, in-process budget.
 * Both the API turn and managed CLI helper execute in this SvelteKit process. A restart or
 * completed request clears the counters; Redis stores only the raw zip and its deletion index.
 */

export const TOOL_MODEL_RETAINED_COPIES_PER_MESSAGE = 50
export const TOOL_MODEL_RETENTION_TURN_MAX_AGE_MS = 6 * 60 * 60 * 1000

export type ToolModelRetentionTurnKey = {
  sessionId: string
  agentId: string
  messageId: string
}

type TurnBudget = {
  sessionId: string
  used: number
  createdAt: number
}

const budgets = new Map<string, TurnBudget>()

function keyOf(identity: ToolModelRetentionTurnKey): string {
  const parts = [identity.sessionId, identity.agentId, identity.messageId]
  if (parts.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('A retained tool result requires a chat, agent, and reply identity.')
  }
  return JSON.stringify(parts.map((value) => value.trim()))
}

function evictExpired(now: number): void {
  for (const [key, budget] of budgets) {
    if (now - budget.createdAt >= TOOL_MODEL_RETENTION_TURN_MAX_AGE_MS) budgets.delete(key)
  }
}

/** Reserve synchronously, before the first Redis write. A failed write rolls back its slot. */
export function reserveToolModelRetainedCopy(identity: ToolModelRetentionTurnKey): {
  commit: () => void
  rollback: () => void
} | null {
  const key = keyOf(identity)
  const now = Date.now()
  evictExpired(now)
  const budget = budgets.get(key) ?? { sessionId: identity.sessionId.trim(), used: 0, createdAt: now }
  if (budget.used >= TOOL_MODEL_RETAINED_COPIES_PER_MESSAGE) return null
  budget.used += 1
  budgets.set(key, budget)

  let state: 'reserved' | 'committed' | 'rolledBack' = 'reserved'
  return {
    commit: () => {
      if (state === 'reserved') state = 'committed'
    },
    rollback: () => {
      if (state === 'rolledBack') return
      // A formatter can fail after a successful Redis write and then remove that copy.
      state = 'rolledBack'
      // A completed turn or hard expiry may already have removed this exact budget.
      if (budgets.get(key) !== budget) return
      budget.used -= 1
      if (budget.used === 0) budgets.delete(key)
    }
  }
}

/** Called only when the chat's last running request has released its turn registration. */
export function clearToolModelRetentionBudgetsForSession(sessionId: string): void {
  for (const [key, budget] of budgets) {
    if (budget.sessionId === sessionId) budgets.delete(key)
  }
}

export function __resetToolModelRetentionTurnBudgetsForTests(): void {
  budgets.clear()
}
