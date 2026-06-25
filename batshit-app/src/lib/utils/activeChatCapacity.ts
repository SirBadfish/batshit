import type { SessionRunState } from '$lib/stores/chatRunRegistry.svelte'

export const MAX_PARALLEL_ACTIVE_CHAT_RUNS = 3

export const ACTIVE_CHAT_CAPACITY_MESSAGE =
  'Three chats are already running. Stop or finish one before starting another chat.'

type ActiveRun = Pick<SessionRunState, 'sessionId'>

export type ActiveChatCapacityDecision =
  | {
      allowed: true
    }
  | {
      allowed: false
      reason: 'active-chat-capacity'
      title: string
      description: string
      activeRunCount: number
      maxActiveRuns: number
    }

export function evaluateActiveChatCapacity(params: {
  activeRuns: ActiveRun[]
  currentSessionId?: string | null
  maxActiveRuns?: number
}): ActiveChatCapacityDecision {
  const maxActiveRuns =
    typeof params.maxActiveRuns === 'number' && Number.isFinite(params.maxActiveRuns)
      ? Math.max(1, Math.floor(params.maxActiveRuns))
      : MAX_PARALLEL_ACTIVE_CHAT_RUNS
  const currentSessionId =
    typeof params.currentSessionId === 'string' && params.currentSessionId.trim()
      ? params.currentSessionId.trim()
      : null
  const activeRuns = Array.isArray(params.activeRuns) ? params.activeRuns : []
  const currentSessionAlreadyActive = Boolean(
    currentSessionId && activeRuns.some((state) => state.sessionId === currentSessionId)
  )

  if (!currentSessionAlreadyActive && activeRuns.length >= maxActiveRuns) {
    return {
      allowed: false,
      reason: 'active-chat-capacity',
      title: 'Three chats are already running',
      description: ACTIVE_CHAT_CAPACITY_MESSAGE,
      activeRunCount: activeRuns.length,
      maxActiveRuns
    }
  }

  return { allowed: true }
}
