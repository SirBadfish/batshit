import { readWhiteboardRecord, type WhiteboardRecord } from '$lib/utils/whiteboard'

export type WhiteboardOwner = { userId: string; sessionId: string; agentId: string }
export type WhiteboardAnchor = { messageId: string; agentId: string }
type Reply = {
  id: string
  session_id: string
  agent_id?: string
  role: string
  metadata?: Record<string, unknown>
}

/** The authored reply owns the board. A picker or an unsent placeholder never does. */
export function resolveWhiteboardAnchor(messages: readonly Reply[], sessionId: string | null): WhiteboardAnchor | null {
  if (!sessionId) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reply = messages[index]
    if (reply.session_id !== sessionId || reply.role !== 'assistant' ||
      reply.metadata?.client_waiting_placeholder || reply.metadata?.contextCompactSummary ||
      reply.metadata?.fixedSessionGraduation) continue
    // An ownerless actual reply cannot borrow an older reply's (or the picker's) identity.
    return reply.agent_id ? { messageId: reply.id, agentId: reply.agent_id } : null
  }
  return null
}

export type WhiteboardPanelState = {
  owner: WhiteboardOwner | null
  anchorMessageId: string | null
  visible: boolean
  open: boolean
  board: WhiteboardRecord | null
  confirmed: boolean
  loading: boolean
  error: string | null
}

export const emptyWhiteboardPanelState = (): WhiteboardPanelState => ({
  owner: null, anchorMessageId: null, visible: false, open: false,
  board: null, confirmed: false, loading: false, error: null
})

type Invalidation = { type: string; sessionId?: unknown; agentId?: unknown; version?: unknown; family?: unknown }
type Target = { owner: WhiteboardOwner; anchorMessageId: string; visible: boolean } | null
type Dependencies = {
  read: (owner: WhiteboardOwner) => Promise<unknown>
  changed: (state: WhiteboardPanelState) => void
}

const ownerKey = (owner: WhiteboardOwner | null) => owner
  ? JSON.stringify([owner.userId, owner.sessionId, owner.agentId]) : null

/** One flight and one trailing read, including when the displayed owner changes mid-flight. */
export function createWhiteboardPanelController(deps: Dependencies) {
  let state = emptyWhiteboardPanelState()
  let generation = 0
  let inFlight = false
  let trailing = false
  let minimumVersion = 0
  let disposed = false
  const emit = () => deps.changed({ ...state })

  const refresh = () => {
    if (disposed || !state.owner || !state.visible) return
    if (inFlight) {
      trailing = true
      state = { ...state, loading: true }
      emit()
      return
    }
    const owner = { ...state.owner }
    const requestGeneration = generation
    inFlight = true
    state = { ...state, loading: true }
    emit()
    void (async () => {
      try {
        const payload = await deps.read(owner)
        if (disposed || generation !== requestGeneration) return
        if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'board')) {
          throw new Error('The saved whiteboard response was invalid.')
        }
        const board = readWhiteboardRecord((payload as { board: unknown }).board, owner)
        const version = board?.version ?? 0
        if (version < Math.max(minimumVersion, state.board?.version ?? 0)) {
          throw new Error('The saved whiteboard changed while loading. Refresh to see the latest notes.')
        }
        if (state.confirmed && version === state.board?.version &&
          (board?.content !== state.board.content || board?.updated_at !== state.board.updated_at)) {
          throw new Error('The saved whiteboard response did not match its version.')
        }
        state = { ...state, board, confirmed: true, error: null }
      } catch (error) {
        if (!disposed && generation === requestGeneration) {
          state = { ...state, error: error instanceof Error ? error.message : 'Could not load the saved whiteboard.' }
        }
      } finally {
        inFlight = false
        if (disposed) return
        if (generation === requestGeneration) state = { ...state, loading: false }
        const refreshAgain = trailing
        trailing = false
        emit()
        if (refreshAgain) refresh()
      }
    })()
  }

  return {
    setTarget(target: Target) {
      if (disposed) return
      const changedOwner = ownerKey(target?.owner ?? null) !== ownerKey(state.owner)
      if (changedOwner) {
        generation += 1
        minimumVersion = 0
        trailing = false
        state = { ...emptyWhiteboardPanelState(), owner: target?.owner ?? null,
          anchorMessageId: target?.anchorMessageId ?? null, visible: target?.visible ?? false }
        emit()
        refresh()
        return
      }
      const visible = target?.visible ?? false
      const becameVisible = visible && !state.visible
      const anchorMessageId = target?.anchorMessageId ?? null
      if (visible === state.visible && anchorMessageId === state.anchorMessageId) return
      state = { ...state, anchorMessageId, visible, open: visible && state.open }
      if (!visible) trailing = false
      emit()
      if (becameVisible) refresh()
    },
    setOpen(open: boolean) {
      if (disposed || !state.visible || state.open === open) return
      state = { ...state, open }
      emit()
    },
    handleEvent(event: Invalidation) {
      if (disposed || !state.owner) return
      if (event.type === 'reconnected' ||
        (event.type === 'agent_settings_changed' && event.family === 'retention' && event.agentId === state.owner.agentId)) {
        refresh()
      } else if (event.type === 'whiteboard_changed' &&
        event.sessionId === state.owner.sessionId && event.agentId === state.owner.agentId &&
        typeof event.version === 'number' && Number.isSafeInteger(event.version) && event.version >= 1) {
        if (event.version <= Math.max(minimumVersion, state.board?.version ?? 0)) return
        minimumVersion = event.version
        refresh()
      }
    },
    refresh,
    destroy() {
      disposed = true
      generation += 1
      trailing = false
    }
  }
}

export async function fetchWhiteboardPanel(owner: WhiteboardOwner): Promise<unknown> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(owner.sessionId)}/whiteboard?agentId=${encodeURIComponent(owner.agentId)}`, {
    cache: 'no-store'
  })
  if (!response.ok) throw new Error('Could not load the saved whiteboard.')
  return response.json()
}
