import type { ChatRunTransport, SessionRunState } from '$lib/stores/chatRunRegistry.svelte'

export const N8N_PRIMARY_EXCLUSIVE_MESSAGE =
  'n8n Primary Agent chats need to run by themselves right now. Stop or finish the active chat first, then send this n8n message.'

export const N8N_PRIMARY_BLOCKS_OTHER_SENDS_MESSAGE =
  'An n8n Primary Agent chat is running right now. Stop or finish it before starting another chat.'

export type N8nPrimaryExclusivityDecision =
  | {
      allowed: true
    }
  | {
      allowed: false
      reason: 'same-session-active' | 'other-run-active' | 'n8n-run-active'
      title: string
      description: string
    }

type ActiveRun = Pick<SessionRunState, 'sessionId' | 'transport'>

export function evaluateN8nPrimaryExclusivity(params: {
  activeRuns: ActiveRun[]
  currentSessionId?: string | null
  transport: ChatRunTransport
}): N8nPrimaryExclusivityDecision {
  const currentSessionId =
    typeof params.currentSessionId === 'string' && params.currentSessionId.trim()
      ? params.currentSessionId.trim()
      : null
  const activeRuns = Array.isArray(params.activeRuns) ? params.activeRuns : []

  if (params.transport === 'n8n') {
    const currentRunActive = activeRuns.some((state) => state.sessionId === currentSessionId)
    if (currentRunActive) {
      return {
        allowed: false,
        reason: 'same-session-active',
        title: 'Response already in progress',
        description:
          'This n8n chat already has an active response. Stop or finish it before sending another message.'
      }
    }

    const otherRunActive = activeRuns.some((state) => state.sessionId !== currentSessionId)
    if (otherRunActive) {
      return {
        allowed: false,
        reason: 'other-run-active',
        title: 'n8n waits for active chats',
        description: N8N_PRIMARY_EXCLUSIVE_MESSAGE
      }
    }

    return { allowed: true }
  }

  const activeN8nRun = activeRuns.find((state) => state.transport === 'n8n')
  if (activeN8nRun) {
    return {
      allowed: false,
      reason: 'n8n-run-active',
      title: 'An n8n agent is already running',
      description: N8N_PRIMARY_BLOCKS_OTHER_SENDS_MESSAGE
    }
  }

  return { allowed: true }
}
