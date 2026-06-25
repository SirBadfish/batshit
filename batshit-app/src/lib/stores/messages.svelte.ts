// Messages store using Svelte 5 runes
import { zippingService } from '$lib/services/zipping'

export interface Message {
  id: string
  session_id: string
  user_id: string
  agent_id?: string
  role: 'user' | 'assistant' | 'system'
  content: string  // Now contains embedded zips!
  timestamp: string
  created_at: string
  metadata?: Record<string, any>
  model?: string
  provider?: string
  status?: 'complete' | 'in_progress' | 'error'
  structured?: Record<string, any>
  responseType?: string
  fileAttachments?: Array<{name: string, mimeType: string, size: number}>
  toolResults?: Array<{
    id?: string
    type: 'tool' | 'tool_error'
    toolName: string
    toolArgs?: any
    result?: any
    error?: string
    timestamp?: string
  }>
  intermediateSteps?: Array<{
    type: 'tool' | 'tool_error'
    toolName?: string
    toolArgs?: any
    toolResult?: any
    error?: string
    timestamp?: string
  }>
  toolPlaceholders?: string[]
  zipMetadata?: Array<{
    zipId: string
    zipType: string
    startIndex: number
    endIndex: number
    tokens: number
    threshold: number
    bufferSize: number
  }>
  toolPreface?: string
}

let messages = $state<Message[]>([])
let activeSessionId = $state<string | null>(null)
let messagesBySession = $state<Record<string, Message[]>>({})
let loading = $state(false)
let error = $state<string | null>(null)
const FINALIZED_MESSAGE_REFRESH_GRACE_MS = 8_000
const refreshProtectedMessageIdsBySession = new Map<string, Map<string, number>>()

type SetMessagesForSessionOptions = {
  preserveLocalInProgress?: boolean
}

function dedupeMessages(newMessages: Message[]) {
  const deduped: Message[] = []
  const indexById = new Map<string, number>()

  for (const message of newMessages) {
    if (!message?.id) {
      deduped.push(message)
      continue
    }

    if (indexById.has(message.id)) {
      const existingIndex = indexById.get(message.id)!
      deduped[existingIndex] = {
        ...deduped[existingIndex],
        ...message
      }
      continue
    }

    indexById.set(message.id, deduped.length)
    deduped.push(message)
  }

  return deduped
}

function inferSessionIdFromMessages(newMessages: Message[]) {
  for (const message of newMessages) {
    if (typeof message?.session_id === 'string' && message.session_id.trim()) {
      return message.session_id.trim()
    }
  }
  return activeSessionId
}

function setSessionMessages(sessionId: string, nextMessages: Message[]) {
  messagesBySession = {
    ...messagesBySession,
    [sessionId]: nextMessages
  }

  if (activeSessionId === sessionId) {
    messages = nextMessages
  }
}

function getMessageTime(message: Message) {
  const raw = message.created_at || message.timestamp || ''
  const value = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(value) ? value : 0
}

function cleanupRefreshProtections(sessionId: string, incomingIds = new Set<string>()) {
  const protectedIds = refreshProtectedMessageIdsBySession.get(sessionId)
  if (!protectedIds) return

  const now = Date.now()
  for (const [messageId, expiresAt] of protectedIds.entries()) {
    if (incomingIds.has(messageId) || expiresAt <= now) {
      protectedIds.delete(messageId)
    }
  }

  if (protectedIds.size === 0) {
    refreshProtectedMessageIdsBySession.delete(sessionId)
  }
}

function protectFinalizedLocalMessage(sessionId: string, messageId: string) {
  const protectedIds = refreshProtectedMessageIdsBySession.get(sessionId) ?? new Map<string, number>()
  protectedIds.set(messageId, Date.now() + FINALIZED_MESSAGE_REFRESH_GRACE_MS)
  refreshProtectedMessageIdsBySession.set(sessionId, protectedIds)
}

function isRefreshProtected(sessionId: string, messageId: string) {
  cleanupRefreshProtections(sessionId)
  const expiresAt = refreshProtectedMessageIdsBySession.get(sessionId)?.get(messageId)
  return typeof expiresAt === 'number' && expiresAt > Date.now()
}

function mergePreservedLocalMessages(
  sessionId: string,
  incomingMessages: Message[],
  options: SetMessagesForSessionOptions
) {
  const incomingIds = new Set(incomingMessages.map((message) => message.id).filter(Boolean))
  cleanupRefreshProtections(sessionId, incomingIds)

  const preservedMessages = getMessages(sessionId).filter(
    (message) =>
      !incomingIds.has(message.id) &&
      (
        (options.preserveLocalInProgress && message.status === 'in_progress') ||
        isRefreshProtected(sessionId, message.id)
      )
  )

  if (preservedMessages.length === 0) {
    return incomingMessages
  }

  return dedupeMessages([...incomingMessages, ...preservedMessages]).sort((a, b) => {
    const timeDelta = getMessageTime(a) - getMessageTime(b)
    if (timeDelta !== 0) return timeDelta
    return a.id.localeCompare(b.id)
  })
}

function locateSessionForMessage(id: string): string | null {
  if (activeSessionId && messages.some((message) => message.id === id)) {
    return activeSessionId
  }

  for (const [sessionId, sessionMessages] of Object.entries(messagesBySession)) {
    if (sessionMessages.some((message) => message.id === id)) {
      return sessionId
    }
  }

  return null
}

export function setActiveSession(sessionId: string | null) {
  activeSessionId = sessionId
  messages = sessionId ? messagesBySession[sessionId] ?? [] : []
}

export function getActiveSessionId() {
  return activeSessionId
}

export function getMessages(sessionId?: string | null) {
  if (sessionId) {
    return messagesBySession[sessionId] ?? (activeSessionId === sessionId ? messages : [])
  }
  return messages
}

export function getMessagesBySessionSnapshot() {
  return messagesBySession
}

export function getMessage(id: string, sessionId?: string | null) {
  if (sessionId) {
    return getMessages(sessionId).find((message) => message.id === id) ?? null
  }

  return messages.find((message) => message.id === id) ??
    Object.values(messagesBySession)
      .flat()
      .find((message) => message.id === id) ??
    null
}

export function isLoading() {
  return loading
}

export function getError() {
  return error
}

export function setMessages(newMessages: Message[]) {
  if (!Array.isArray(newMessages)) {
    if (activeSessionId) {
      setSessionMessages(activeSessionId, [])
    } else {
      messages = []
    }
    return
  }

  const deduped = dedupeMessages(newMessages)
  const sessionId = inferSessionIdFromMessages(deduped)

  if (sessionId) {
    setSessionMessages(sessionId, deduped)
  } else {
    messages = deduped
  }
}

export function setMessagesForSession(
  sessionId: string,
  newMessages: Message[],
  options: SetMessagesForSessionOptions = {}
) {
  const deduped = dedupeMessages(Array.isArray(newMessages) ? newMessages : [])
  setSessionMessages(
    sessionId,
    options.preserveLocalInProgress || refreshProtectedMessageIdsBySession.has(sessionId)
      ? mergePreservedLocalMessages(sessionId, deduped, options)
      : deduped
  )
}

export function addMessage(message: Partial<Message> & { content: string; role: string; session_id: string; user_id?: string }) {
  const now = new Date().toISOString()
  const incomingId = message.id ?? crypto.randomUUID()
  const targetSessionId = message.session_id
  const sessionMessages = targetSessionId ? getMessages(targetSessionId) : messages

  const existingIndex = sessionMessages.findIndex((m) => m.id === incomingId)

  const baseTimestamps = {
    timestamp: message.timestamp ?? now,
    created_at: message.created_at ?? now
  }

  const newMessage: Message = {
    id: incomingId,
    user_id: message.user_id || '',
    ...baseTimestamps,
    ...message
  } as Message

  if (existingIndex !== -1) {
    const existing = sessionMessages[existingIndex]
    const merged: Message = {
      ...existing,
      ...newMessage,
      // Preserve earliest creation timestamp while keeping latest update timestamp
      created_at: existing.created_at ?? newMessage.created_at,
      timestamp: newMessage.timestamp ?? existing.timestamp
    }

    const nextMessages = [
      ...sessionMessages.slice(0, existingIndex),
      merged,
      ...sessionMessages.slice(existingIndex + 1)
    ]
    if (targetSessionId) {
      setSessionMessages(targetSessionId, nextMessages)
    } else {
      messages = nextMessages
    }
    return
  }

  const nextMessages = [...sessionMessages, newMessage]
  if (targetSessionId) {
    setSessionMessages(targetSessionId, nextMessages)
  } else {
    messages = nextMessages
  }

  // Increment message counts for temporary pins
  zippingService.incrementMessageCount(targetSessionId)
}

export function updateMessage(id: string, updates: Partial<Message>, sessionId?: string | null) {
  const targetSessionId =
    sessionId ??
    (typeof updates.session_id === 'string' && updates.session_id.trim() ? updates.session_id.trim() : null) ??
    locateSessionForMessage(id)

  if (targetSessionId) {
    const existing = getMessages(targetSessionId).find((message) => message.id === id)
    const nextMessages = getMessages(targetSessionId).map(m =>
      m.id === id ? { ...m, ...updates } : m
    )
    setSessionMessages(targetSessionId, nextMessages)
    if (
      existing?.role === 'assistant' &&
      existing.status === 'in_progress' &&
      (updates.status === 'complete' || updates.status === 'error')
    ) {
      protectFinalizedLocalMessage(targetSessionId, id)
    }
  } else {
    messages = messages.map(m =>
      m.id === id ? { ...m, ...updates } : m
    )
  }

  // Note: Redis cache invalidation happens at the formatted message level,
  // not here in the message store
}

export function deleteMessage(id: string, sessionId?: string | null) {
  const targetSessionId = sessionId ?? locateSessionForMessage(id)

  if (targetSessionId) {
    setSessionMessages(
      targetSessionId,
      getMessages(targetSessionId).filter(m => m.id !== id)
    )
  } else {
    messages = messages.filter(m => m.id !== id)
  }

  // Note: Redis cache invalidation happens at the formatted message level,
  // not here in the message store
}

export function clearMessages(sessionId?: string | null) {
  const targetSessionId = sessionId ?? activeSessionId

  if (targetSessionId) {
    refreshProtectedMessageIdsBySession.delete(targetSessionId)
    const nextBySession = { ...messagesBySession }
    delete nextBySession[targetSessionId]
    messagesBySession = nextBySession
    if (activeSessionId === targetSessionId) {
      messages = []
    }
  } else {
    messages = []
    messagesBySession = {}
    refreshProtectedMessageIdsBySession.clear()
  }

  // Note: Redis cache clearing happens at the session level,
  // not here in the message store
}

export function setLoading(isLoading: boolean) {
  loading = isLoading
}

export function setError(errorMsg: string | null) {
  error = errorMsg
}

// Functions to get derived values
export function getMessageCount(sessionId?: string | null) {
  return getMessages(sessionId).length
}

export function getLastMessage(sessionId?: string | null) {
  return getMessages(sessionId).at(-1) || null
}
