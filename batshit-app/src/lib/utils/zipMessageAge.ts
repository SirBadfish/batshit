export interface ZipAgeMessage {
  role?: string | null
  content?: string | null
  status?: string | null
  agent_id?: string | null
  agentId?: string | null
  toolResults?: unknown
  intermediateSteps?: unknown
  metadata?: Record<string, any> | null
}

function getMessageAgentId(message: ZipAgeMessage | null | undefined): string | null {
  const agentId =
    typeof message?.agent_id === 'string'
      ? message.agent_id
      : typeof message?.agentId === 'string'
        ? message.agentId
        : null

  const normalized = agentId?.trim()
  return normalized ? normalized : null
}

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

export function isCountableAgentMessage(message: ZipAgeMessage | null | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  if (message.status === 'in_progress') return false

  return (
    Boolean(message.content?.trim()) ||
    hasArrayEntries(message.toolResults) ||
    hasArrayEntries(message.intermediateSteps)
  )
}

export function calculateAgentMessagesFromEnd(
  messages: ZipAgeMessage[],
  messageIndex: number
): number {
  return calculateAgentMessagesFromEndByIndex(messages)[messageIndex] ?? 0
}

function isIncompleteRunMessage(message: ZipAgeMessage | null | undefined): boolean {
  const metadata = message?.metadata
  if (!metadata || typeof metadata !== 'object') return false
  return metadata.response_failed === true || metadata.interrupted === true
}

/**
 * Marks assistant messages whose run never completed (failed mid-task or
 * interrupted) and that have no successful completion by the same agent after
 * them. Tool results on these messages are "recovery hold": the agent is
 * likely resuming that work on the next send, so automatic zip compression
 * (auto-zip and buffer aging) must not hide them. The hold clears as soon as
 * the agent completes a normal turn — at that point the work is genuinely
 * done and standard zip rules apply again.
 *
 * Per-agent semantics match calculateAgentMessagesFromEndByIndex: completions
 * by other agents do not clear a hold, completions without an agent id
 * conservatively clear all holds.
 */
export function calculateRecoveryHoldByIndex(messages: ZipAgeMessage[]): boolean[] {
  const result = new Array(messages.length).fill(false)
  const completionSeenByAgent = new Map<string, boolean>()
  let completionSeenUnknownAgent = false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isCountableAgentMessage(message)) continue

    const agentId = getMessageAgentId(message)
    const completionSeen = agentId
      ? (completionSeenByAgent.get(agentId) ?? false) || completionSeenUnknownAgent
      : completionSeenUnknownAgent

    if (isIncompleteRunMessage(message)) {
      result[index] = !completionSeen
      continue
    }

    if (agentId) {
      completionSeenByAgent.set(agentId, true)
    } else {
      completionSeenUnknownAgent = true
    }
  }

  return result
}

export function calculateAgentMessagesFromEndByIndex(messages: ZipAgeMessage[]): number[] {
  const result = new Array(messages.length).fill(0)
  const byAgent = new Map<string, number>()
  let totalAgentMessages = 0
  let unknownAgentMessages = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const agentId = getMessageAgentId(message)

    result[index] = agentId
      ? (byAgent.get(agentId) ?? 0) + unknownAgentMessages
      : totalAgentMessages

    if (isCountableAgentMessage(message)) {
      totalAgentMessages += 1
      if (agentId) {
        byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + 1)
      } else {
        unknownAgentMessages += 1
      }
    }
  }

  return result
}
