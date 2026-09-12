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
  /**
   * SA-113 P1 (DL-113-06): who is driving this run. `client` is the browser's own send;
   * `server` is a turn Batshit started on its own (a wake-up), hydrated from the
   * user channel. The distinction matters because a server run has no local
   * `abortController` — Stop for it goes through `/api/messages/interrupt`.
   */
  owner?: 'client' | 'server'
  transport?: ChatRunTransport
  /**
   * SA-114 P3 (DL-114-09): can the reply running in this chat be steered, and if not, why?
   *
   * The SERVER decides (`resolveSteerability` at the moment it registers the run — a Codex
   * run's answer depends on the transport lane it actually got) and the client only reports
   * it. It arrives on the `start` event for a chat the user is watching, and on
   * `session_run_status` for a turn Batshit started on its own. `null` means "not told yet",
   * which is not the same as `false`: the send button treats an unknown answer as steerable
   * and lets the route's 409 be the backstop, because the alternative is labelling every
   * reply "Interrupt and send" for the moment before `start` lands.
   */
  steerable?: boolean | null
  steerReason?: string | null
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
    owner: 'client',
    steerable: null,
    steerReason: null,
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
    owner: 'client',
    transport: params.transport,
    activeMessageId: params.activeMessageId ?? null,
    activeStreamMessageIds,
    abortController: params.abortController ?? null
  })
}

/**
 * SA-113 P1 (DL-113-06) — hydrate a run the SERVER started.
 *
 * Recon 2.4: the run spinner and the three-active-chats cap both read this registry, and
 * both were filled only by the client's own send path, so a woken turn showed no spinner
 * and counted for nothing. The user channel's `session_run_status` events land here.
 *
 * A server run never carries an `abortController` — there is no local request to abort.
 * `isRunActive` still reports it as active through `status`, which is what the spinner
 * and the capacity check read.
 */
export function applyServerRunStatus(params: {
  sessionId: string
  status: 'running' | 'tooling' | 'complete' | 'failed' | 'stopped'
  /** SA-114 P3 (DL-114-09): send-routed publishes these once the run's transport is known. */
  steerable?: boolean | null
  steerReason?: string | null
  /**
   * F-P3-2: the ASSISTANT message the server-started reply is writing. A steer is aimed at
   * that id, and a tab that did not start the reply otherwise learns it only from the
   * `start` event — which the API lane sends with its first chunk, seconds later.
   */
  messageId?: string | null
}) {
  const normalized = normalizeSessionId(params.sessionId)
  if (!normalized) return

  const current = getRunState(normalized)

  // Never let a server status stomp a run the user started in the same chat.
  if (current.owner === 'client' && isRunActive(current)) return

  if (params.status === 'running' || params.status === 'tooling') {
    const serverMessageId =
      typeof params.messageId === 'string' && params.messageId.trim()
        ? params.messageId.trim()
        : (current.activeMessageId ?? null)
    setRunState(normalized, {
      ...createIdleRunState(normalized),
      owner: 'server',
      status: params.status === 'tooling' ? 'tooling' : 'streaming',
      activeMessageId: serverMessageId,
      activeStreamMessageIds: serverMessageId ? [serverMessageId] : [],
      // `requestAgentWakeup` publishes `running` before the transport is known, so its
      // event carries no verdict; send-routed publishes a second `running` once the run is
      // registered. An absent field must therefore keep whatever the last one said rather
      // than resetting to "not told yet".
      steerable: params.steerable ?? current.steerable ?? null,
      steerReason: params.steerReason ?? current.steerReason ?? null
    })
    return
  }

  if (current.owner !== 'server') return

  setRunState(normalized, {
    ...createIdleRunState(normalized),
    owner: 'server',
    status: 'idle',
    lastError: params.status === 'failed' ? 'The woken turn failed.' : null
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

export function clearRunRegistryForTest() {
  if (typeof process !== 'undefined' && process.env.VITEST !== 'true') return
  runStateBySession = {}
}
