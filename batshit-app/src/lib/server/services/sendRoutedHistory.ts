import { isSwallowedQuickActionTurn } from '$lib/utils/jevJuiceQuickActions'
import type { CurrentMessageFrom } from '$lib/utils/compiledChatTags'

type ChatHistoryMessage = Record<string, any>

function messageTextContent(content: unknown): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .join('')
  }

  return ''
}

function isTransientAssistantPlaceholder(
  message: ChatHistoryMessage | undefined,
  assistantMessageId?: string | null,
): boolean {
  if (!message || message.role !== 'assistant') return false

  const content = messageTextContent(message.content).trim()
  if (content.length > 0) return false

  const metadata =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : {}
  const id = typeof message.id === 'string' ? message.id.trim() : ''
  const requestedId =
    typeof assistantMessageId === 'string' ? assistantMessageId.trim() : ''

  return (
    metadata.client_waiting_placeholder === true ||
    message.status === 'in_progress' ||
    (Boolean(requestedId) && id === requestedId)
  )
}

function isCurrentUserTurn(
  message: ChatHistoryMessage | undefined,
  currentUserMessage?: unknown,
): boolean {
  if (!message || message.role !== 'user') return false

  const currentText = messageTextContent(currentUserMessage).trim()
  if (!currentText) return false

  return messageTextContent(message.content).trim() === currentText
}

type PrepareManagedHistoryOptions<TMessages> = {
  messages: TMessages
  currentUserMessage?: unknown
  assistantMessageId?: string | null
  preserveAllMessages?: boolean
}

export function prepareManagedHistoryMessages<T extends ChatHistoryMessage>(
  options: PrepareManagedHistoryOptions<T[]>,
): T[]
export function prepareManagedHistoryMessages(
  options: PrepareManagedHistoryOptions<unknown>,
): ChatHistoryMessage[]
export function prepareManagedHistoryMessages<T extends ChatHistoryMessage>({
  messages,
  currentUserMessage,
  assistantMessageId,
  preserveAllMessages = false,
}: PrepareManagedHistoryOptions<T[] | unknown>): T[] | ChatHistoryMessage[] {
  if (!Array.isArray(messages)) return []

  // SA-120 P9: a spoken turn that was ONLY a quick action never reached the agent (Batshit acted,
  // nothing was sent), so it is not part of the agent's history either. The user still sees it in
  // the chat with its chip. A mixed turn was sent and stays.
  const history = (messages as T[]).filter((message) => !isSwallowedQuickActionTurn(message))
  if (preserveAllMessages) return history

  while (
    history.length > 0 &&
    isTransientAssistantPlaceholder(
      history[history.length - 1],
      assistantMessageId,
    )
  ) {
    history.pop()
  }

  if (
    history.length > 0 &&
    isCurrentUserTurn(history[history.length - 1], currentUserMessage)
  ) {
    history.pop()
  }

  return history
}

/**
 * SA-128 (DP-1): who wrote the current message a send compiles. A woken turn (its DM, webhook,
 * or schedule text), a group follow-up (Batshit's prompt about another agent's reply), and the
 * artifact share follow-up are Batshit's words, so they compile as a `<note>`; every other send
 * is the user's own message. `metadata.wake` marks the wake primitive's own POST, the one send
 * that is not the user (send-routed reads it the same way for "needs you").
 */
export function resolveCurrentMessageFrom(options: {
  metadata?: Record<string, any> | null
  groupEventType?: 'user' | 'agent' | null
}): CurrentMessageFrom {
  if (options.groupEventType === 'agent') return 'batshit'
  const metadata = options.metadata ?? {}
  if (metadata.wake) return 'batshit'
  if (metadata.source === 'artifact_share_auto_followup') return 'batshit'
  return 'user'
}
