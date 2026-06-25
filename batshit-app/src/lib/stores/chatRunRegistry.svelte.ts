import type { PrimaryAgentType } from '$lib/utils/primaryAgentType'

export type ChatRunStatus =
  | 'idle'
  | 'submitting'
  | 'streaming'
  | 'tooling'
  | 'stopping'
  | 'failed'
  | 'complete'

export type ChatRunTransport = PrimaryAgentType

export type SessionRunState = {
  sessionId: string
  status: ChatRunStatus
  transport?: ChatRunTransport
  activeMessageId?: string | null
  activeStreamMessageIds: string[]
  abortController?: AbortController | null
  activeToolMessageIds: string[]
  activeToolCallNamesByMessageId: Record<string, string>
  lastError?: string | null
  updatedAt: number
}

function createIdleRunState(sessionId: string): SessionRunState {
  return {
    sessionId,
    status: 'idle',
    activeMessageId: null,
    activeStreamMessageIds: [],
    abortController: null,
    activeToolMessageIds: [],
    activeToolCallNamesByMessageId: {},
    lastError: null,
    updatedAt: Date.now()
  }
}

let runStateBySession = $state<Record<string, SessionRunState>>({})

function normalizeSessionId(sessionId?: string | null) {
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
}

function deriveActiveMessageId(messageIds: string[]) {
  return messageIds.length === 1 ? messageIds[0] : null
}

function setRunState(sessionId: string, nextState: SessionRunState) {
  runStateBySession = {
    ...runStateBySession,
    [sessionId]: {
      ...nextState,
      updatedAt: Date.now()
    }
  }
}

export function getRunState(sessionId?: string | null): SessionRunState {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) return createIdleRunState('')
  return runStateBySession[normalized] ?? createIdleRunState(normalized)
}

export function getRunStates() {
  return runStateBySession
}

export function getActiveRunStates() {
  return Object.values(runStateBySession).filter(isRunActive)
}

export function updateRunState(sessionId: string, updates: Partial<SessionRunState>) {
  const current = getRunState(sessionId)
  setRunState(sessionId, {
    ...current,
    ...updates,
    sessionId,
    activeStreamMessageIds: updates.activeStreamMessageIds ?? current.activeStreamMessageIds,
    activeToolMessageIds: updates.activeToolMessageIds ?? current.activeToolMessageIds,
    activeToolCallNamesByMessageId:
      updates.activeToolCallNamesByMessageId ?? current.activeToolCallNamesByMessageId
  })
}

export function resetRunState(sessionId?: string | null) {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) return
  setRunState(normalized, createIdleRunState(normalized))
}

export function startRun(params: {
  sessionId: string
  transport: ChatRunTransport
  activeMessageId?: string | null
  abortController?: AbortController | null
}) {
  const activeStreamMessageIds = params.activeMessageId ? [params.activeMessageId] : []
  setRunState(params.sessionId, {
    ...createIdleRunState(params.sessionId),
    status: 'submitting',
    transport: params.transport,
    activeMessageId: params.activeMessageId ?? null,
    activeStreamMessageIds,
    abortController: params.abortController ?? null
  })
}

export function markStreaming(sessionId: string, messageId?: string | null) {
  const current = getRunState(sessionId)
  const activeStreamMessageIds =
    messageId && !current.activeStreamMessageIds.includes(messageId)
      ? [...current.activeStreamMessageIds, messageId]
      : current.activeStreamMessageIds
  setRunState(sessionId, {
    ...current,
    status: current.status === 'stopping' ? 'stopping' : 'streaming',
    activeStreamMessageIds,
    activeMessageId: deriveActiveMessageId(activeStreamMessageIds)
  })
}

export function removeActiveMessage(sessionId: string, messageId: string) {
  const current = getRunState(sessionId)
  const activeStreamMessageIds = current.activeStreamMessageIds.filter((id) => id !== messageId)
  const activeToolMessageIds = current.activeToolMessageIds.filter((id) => id !== messageId)
  const activeToolCallNamesByMessageId = { ...current.activeToolCallNamesByMessageId }
  delete activeToolCallNamesByMessageId[messageId]
  setRunState(sessionId, {
    ...current,
    status:
      activeStreamMessageIds.length === 0 && !current.abortController
        ? current.status === 'failed'
          ? 'failed'
          : 'complete'
        : current.status,
    activeStreamMessageIds,
    activeMessageId: deriveActiveMessageId(activeStreamMessageIds),
    activeToolMessageIds,
    activeToolCallNamesByMessageId
  })
}

export function setAbortController(sessionId: string, abortController: AbortController | null) {
  updateRunState(sessionId, { abortController })
}

export function releaseAbortController(
  sessionId: string,
  abortController?: AbortController | null
) {
  const current = getRunState(sessionId)
  if (abortController && current.abortController !== abortController) return
  const hasActiveWork =
    current.activeStreamMessageIds.length > 0 || current.activeToolMessageIds.length > 0
  setRunState(sessionId, {
    ...current,
    status: !hasActiveWork && current.status !== 'failed' ? 'complete' : current.status,
    abortController: null
  })
}

export function setToolProcessing(sessionId: string, messageId: string, toolName?: string | null) {
  const current = getRunState(sessionId)
  const activeToolMessageIds = current.activeToolMessageIds.includes(messageId)
    ? current.activeToolMessageIds
    : [...current.activeToolMessageIds, messageId]
  const activeToolCallNamesByMessageId =
    toolName && toolName.trim()
      ? {
          ...current.activeToolCallNamesByMessageId,
          [messageId]: toolName.trim()
        }
      : current.activeToolCallNamesByMessageId
  setRunState(sessionId, {
    ...current,
    status: current.status === 'stopping' ? 'stopping' : 'tooling',
    activeToolMessageIds,
    activeToolCallNamesByMessageId
  })
}

export function clearToolProcessing(sessionId: string, messageId: string) {
  const current = getRunState(sessionId)
  const activeToolMessageIds = current.activeToolMessageIds.filter((id) => id !== messageId)
  const activeToolCallNamesByMessageId = { ...current.activeToolCallNamesByMessageId }
  delete activeToolCallNamesByMessageId[messageId]
  setRunState(sessionId, {
    ...current,
    status:
      current.status === 'tooling' && activeToolMessageIds.length === 0
        ? current.activeStreamMessageIds.length > 0
          ? 'streaming'
          : 'idle'
        : current.status,
    activeToolMessageIds,
    activeToolCallNamesByMessageId
  })
}

export function clearAllToolProcessing(sessionId: string) {
  const current = getRunState(sessionId)
  setRunState(sessionId, {
    ...current,
    status: current.activeStreamMessageIds.length > 0 ? 'streaming' : 'idle',
    activeToolMessageIds: [],
    activeToolCallNamesByMessageId: {}
  })
}

export function markStopping(sessionId: string) {
  updateRunState(sessionId, { status: 'stopping' })
}

export function markFailed(sessionId: string, errorMessage?: string | null) {
  const current = getRunState(sessionId)
  setRunState(sessionId, {
    ...current,
    status: 'failed',
    abortController: null,
    activeStreamMessageIds: [],
    activeMessageId: null,
    activeToolMessageIds: [],
    activeToolCallNamesByMessageId: {},
    lastError: errorMessage ?? current.lastError ?? null
  })
}

export function markComplete(sessionId: string) {
  const current = getRunState(sessionId)
  setRunState(sessionId, {
    ...current,
    status: 'complete',
    abortController: null,
    activeStreamMessageIds: [],
    activeMessageId: null,
    activeToolMessageIds: [],
    activeToolCallNamesByMessageId: {}
  })
}

export function isRunActive(state: SessionRunState) {
  return (
    state.status === 'submitting' ||
    state.status === 'streaming' ||
    state.status === 'tooling' ||
    state.status === 'stopping' ||
    state.activeStreamMessageIds.length > 0 ||
    Boolean(state.abortController)
  )
}

export function isSessionBusy(sessionId?: string | null) {
  const normalized = normalizeSessionId(sessionId)
  return normalized ? isRunActive(getRunState(normalized)) : false
}

export function hasActiveN8nPrimaryRun(exceptSessionId?: string | null) {
  const except = normalizeSessionId(exceptSessionId)
  return Object.values(runStateBySession).find((state) => {
    if (except && state.sessionId === except) return false
    return state.transport === 'n8n' && isRunActive(state)
  }) ?? null
}

export function clearRunRegistryForTest() {
  if (typeof process !== 'undefined' && process.env.VITEST !== 'true') return
  runStateBySession = {}
}
