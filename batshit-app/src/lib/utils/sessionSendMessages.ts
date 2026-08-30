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
import { applyFixedSessionGraduationToMessages } from '$lib/utils/fixedSessionGraduation'

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
  // SA-104 P6: Infinite-Session graduation applies here for every client lane (native
  // n8n included) — the same pre-compile site compaction uses. Regular sessions pass
  // through unchanged (DL-104-12); the server twin re-applies idempotently.
  const compactedMessages = applyFixedSessionGraduationToMessages(
    applyContextCompactionToMessages(messages, compactionEvents),
    session
  )
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
