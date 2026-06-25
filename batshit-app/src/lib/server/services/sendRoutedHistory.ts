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

  const history = messages.slice() as T[]
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
