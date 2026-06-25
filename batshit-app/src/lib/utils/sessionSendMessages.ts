import type { ChatSession } from '$lib/stores/session.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import {
  applyContextCompactionToMessages,
  getCompactedMessageIds,
  getContextCompactionState
} from '$lib/utils/contextCompaction'
import {
  applyManualTrimToMessages,
  isMessageProtectedFromManualTrim,
  type ManualTrimProtections
} from '$lib/utils/tokenPanel'

export type BuildSessionMessagesForSendOptions = {
  sessionId: string
  messages: Message[]
  sessions: ChatSession[]
  trimmedMessageIdsBySession?: Record<string, string[]>
  manualTrimProtections?: ManualTrimProtections
  userId?: string
}

export function buildSessionMessagesForSend({
  sessionId,
  messages,
  sessions,
  trimmedMessageIdsBySession = {},
  manualTrimProtections = {},
  userId
}: BuildSessionMessagesForSendOptions): Message[] {
  const session = sessions.find((item) => item.id === sessionId) ?? null
  const compactionEvents = getContextCompactionState(session?.metadata ?? null).events
  const compactedMessages = applyContextCompactionToMessages(messages, compactionEvents)
  const compactedMessageIds = new Set(getCompactedMessageIds(compactionEvents))
  const trimmedMessageIds = trimmedMessageIdsBySession[sessionId] ?? []

  const effectiveTrimmedIds = trimmedMessageIds.filter((messageId) => {
    if (compactedMessageIds.has(messageId)) return false
    const message = messages.find((entry) => entry.id === messageId)
    return message ? !isMessageProtectedFromManualTrim(message, manualTrimProtections) : false
  })

  return applyManualTrimToMessages(compactedMessages, effectiveTrimmedIds, {
    protections: manualTrimProtections,
    sessionId,
    userId
  })
}
