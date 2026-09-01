export const INTERRUPTED_REASONING_RECOVERY_SCHEMA_VERSION = 1 as const

export interface InterruptedReasoningRecovery {
  schemaVersion: typeof INTERRUPTED_REASONING_RECOVERY_SCHEMA_VERSION
  trigger: 'user-interrupt'
  agentId: string
  renderedBlock: string
  reasoningCharacterCount: number
  planCharacterCount: number
}

export interface ReasoningRecoveryMessage {
  role?: string | null
  content?: string | null
  status?: string | null
  agent_id?: string | null
  agentId?: string | null
  toolResults?: unknown
  intermediateSteps?: unknown
  metadata?: Record<string, any> | null
}

const RECOVERY_REASONING_HEADER = '==== RECOVERY REASONING FROM INTERRUPTED RESPONSE ===='
const RECOVERY_PLAN_HEADER = '==== RECOVERY PLAN FROM INTERRUPTED RESPONSE ===='
const RECOVERY_INSTRUCTION =
  'The previous response was interrupted before it finished. Continue from this unfinished work, verify it against the current request, and do not treat it as a final conclusion.'

function normalizeAgentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function resolveMessageAgentId(
  message: ReasoningRecoveryMessage | null | undefined
): string | null {
  return normalizeAgentId(message?.agent_id ?? message?.agentId)
}

function normalizeCapturedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function isSuccessfulAssistantCompletion(
  message: ReasoningRecoveryMessage | null | undefined
): boolean {
  if (!message || message.role !== 'assistant') return false
  if (message.status === 'in_progress' || message.status === 'error') return false

  const metadata = message.metadata
  if (metadata?.interrupted === true || metadata?.response_failed === true) {
    return false
  }

  return (
    Boolean(message.content?.trim()) ||
    hasArrayEntries(message.toolResults) ||
    hasArrayEntries(message.intermediateSteps)
  )
}

export function buildInterruptedReasoningRecovery(args: {
  agentId: string
  reasoningSummary?: string | null
  planSummary?: string | null
}): InterruptedReasoningRecovery | null {
  const agentId = normalizeAgentId(args.agentId)
  if (!agentId) return null

  const reasoningSummary = normalizeCapturedText(args.reasoningSummary)
  const planSummary = normalizeCapturedText(args.planSummary)
  if (!reasoningSummary && !planSummary) return null

  const sections = [RECOVERY_INSTRUCTION]
  if (reasoningSummary) {
    sections.push(`${RECOVERY_REASONING_HEADER}\n${reasoningSummary}`)
  }
  if (planSummary) {
    sections.push(`${RECOVERY_PLAN_HEADER}\n${planSummary}`)
  }

  return {
    schemaVersion: INTERRUPTED_REASONING_RECOVERY_SCHEMA_VERSION,
    trigger: 'user-interrupt',
    agentId,
    renderedBlock: sections.join('\n\n'),
    reasoningCharacterCount: reasoningSummary.length,
    planCharacterCount: planSummary.length
  }
}

export function readInterruptedReasoningRecovery(
  message: ReasoningRecoveryMessage | null | undefined
): InterruptedReasoningRecovery | null {
  const raw = message?.metadata?.interruptedReasoningRecovery
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.schemaVersion !== INTERRUPTED_REASONING_RECOVERY_SCHEMA_VERSION) return null
  if (raw.trigger !== 'user-interrupt') return null
  if (message?.metadata?.interrupted !== true) return null

  const agentId = normalizeAgentId(raw.agentId)
  const messageAgentId = resolveMessageAgentId(message)
  const renderedBlock = typeof raw.renderedBlock === 'string' ? raw.renderedBlock : ''
  if (!agentId || !messageAgentId || agentId !== messageAgentId || !renderedBlock.trim()) {
    return null
  }

  const reasoningCharacterCount = Number(raw.reasoningCharacterCount)
  const planCharacterCount = Number(raw.planCharacterCount)
  if (
    !Number.isSafeInteger(reasoningCharacterCount) ||
    reasoningCharacterCount < 0 ||
    !Number.isSafeInteger(planCharacterCount) ||
    planCharacterCount < 0
  ) {
    return null
  }

  return {
    schemaVersion: INTERRUPTED_REASONING_RECOVERY_SCHEMA_VERSION,
    trigger: 'user-interrupt',
    agentId,
    renderedBlock,
    reasoningCharacterCount,
    planCharacterCount
  }
}

/**
 * Marks interrupted reasoning records that are still waiting for the exact
 * same agent to complete a later successful turn. Failed/interrupted retries
 * do not clear earlier records, and unattributed/other-agent messages never
 * clear them. The stored renderedBlock is replayed verbatim while active.
 */
export function calculateInterruptedReasoningRecoveryActiveByIndex(
  messages: ReasoningRecoveryMessage[]
): boolean[] {
  const result = new Array(messages.length).fill(false)
  const successfulCompletionSeenByAgent = new Set<string>()

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const recovery = readInterruptedReasoningRecovery(message)
    if (recovery) {
      result[index] = !successfulCompletionSeenByAgent.has(recovery.agentId)
      continue
    }

    if (!isSuccessfulAssistantCompletion(message)) continue
    const agentId = resolveMessageAgentId(message)
    if (agentId) {
      successfulCompletionSeenByAgent.add(agentId)
    }
  }

  return result
}

export function getActiveInterruptedReasoningRecoveryBlock(args: {
  message: ReasoningRecoveryMessage | null | undefined
  currentAgentId: string | null | undefined
  active: boolean
}): string {
  if (!args.active) return ''
  const currentAgentId = normalizeAgentId(args.currentAgentId)
  if (!currentAgentId) return ''

  const recovery = readInterruptedReasoningRecovery(args.message)
  if (!recovery || recovery.agentId !== currentAgentId) return ''
  return recovery.renderedBlock
}
