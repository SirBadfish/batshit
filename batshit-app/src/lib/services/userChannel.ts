/**
 * SA-113 P1 (DL-113-06) — the browser's one connection to the user-wide live channel.
 *
 * Every other Batshit live update is session-scoped: you open a chat, you get that chat's
 * stream. That leaves a real hole. Recon 2.4 found that the sidebar learns about a new
 * session only from its own actions — there is no push, no poll, no focus refresh — so a
 * chat that Batshit starts on its own (a wake-up) would simply not appear until the next
 * page load, and the run spinner and the three-active-chats cap would not count it.
 *
 * This module opens exactly one `EventSource` per browser tab and applies what it hears
 * to the stores the sidebar already reads, so no component needs new wiring. Consumers
 * that want to react to a specific event (the chat page refetching messages when a woken
 * turn completes) subscribe through `onUserChannelEvent`.
 *
 * `SA-111b`'s "your background worker finished" event lands on this same channel.
 */

import * as sessionStore from '$lib/stores/session.svelte'
import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
import { applyDmInboxChanged } from '$lib/stores/dmInbox.svelte'
import { logger } from '$lib/utils/logger'

export type UserChannelEvent =
  | { type: 'connected'; scope: 'user' }
  | { type: 'session_created'; session: Record<string, any> }
  | { type: 'session_updated'; sessionId: string; patch: Record<string, any> }
  | {
      type: 'session_run_status'
      sessionId: string
      status: 'running' | 'tooling' | 'complete' | 'failed' | 'stopped'
      owner?: 'server'
      origin?: Record<string, any>
      reason?: string
      /** SA-114 (DL-114-09): whether this server-started reply can be steered, and why not. */
      steerable?: boolean | null
      steerReason?: string | null
      /** F-P3-2: the assistant message the reply is writing — what a steer is aimed at. */
      messageId?: string | null
    }
  | {
      type: 'dm_inbox_changed'
      agentId: string
      openCount: number
      newCount: number
      /** F-SEC-1b: open items whose woken turn is stopped waiting on the user. */
      needsUserCount: number
    }
  /**
   * SA-115 (DL-115-07) — schedules that were due while Batshit was off.
   *
   * Nothing fired. This is the signal that opens the *Missed while Batshit was off*
   * dialog, which is the ONLY place a missed run can be started. Handled by that dialog
   * (P2) rather than by `applyToStores`, because it is a question for the user, not a
   * change to the sidebar's state.
   */
  | {
      type: 'schedule_missed'
      schedules: {
        scheduleId: string
        name: string
        agentId: string
        timeZone: string
        dueAt: string
        count: number
        nextRunAt: string
      }[]
    }
  | (Record<string, any> & { type: string })

type Listener = (event: UserChannelEvent) => void

const MAX_RECONNECT_ATTEMPTS = 8
const MAX_RECONNECT_DELAY_MS = 30_000

let source: EventSource | null = null
let connectedUserId: string | null = null
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let holders = 0

const listeners = new Set<Listener>()

type ServerRunStatus = 'running' | 'tooling' | 'complete' | 'failed' | 'stopped'
const SERVER_RUN_STATUSES: ServerRunStatus[] = [
  'running',
  'tooling',
  'complete',
  'failed',
  'stopped'
]

/** Subscribe to raw events. Returns an unsubscribe function. */
export function onUserChannelEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: UserChannelEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      logger.warn('[UserChannel] Listener threw:', error)
    }
  }
}

/**
 * Apply an event to the shared stores. Kept here rather than in the sidebar so the
 * behaviour is identical no matter which component happened to start the channel.
 */
function applyToStores(event: UserChannelEvent) {
  switch (event.type) {
    case 'session_created': {
      const session = (event as any).session
      if (session?.id) sessionStore.upsertSession(session)
      break
    }
    case 'session_updated': {
      const { sessionId, patch } = event as any
      if (sessionId && patch && typeof patch === 'object') {
        sessionStore.patchSessionFromServer(sessionId, patch)
      }
      break
    }
    case 'session_run_status': {
      const { sessionId, status, steerable, steerReason, messageId } = event as any
      if (typeof sessionId === 'string' && SERVER_RUN_STATUSES.includes(status)) {
        // SA-114 P3 (DL-114-09): a woken turn's steerability reaches a tab that was not
        // watching that chat only here — the `start` event rides the SESSION channel, and
        // nobody was listening on it when Batshit started the turn by itself.
        chatRunRegistry.applyServerRunStatus({
          sessionId,
          status,
          steerable: typeof steerable === 'boolean' ? steerable : null,
          steerReason: typeof steerReason === 'string' ? steerReason : null,
          messageId: typeof messageId === 'string' ? messageId : null
        })
      }
      break
    }
    // SA-113 P4: the header badge. The server publishes the counts, so the badge never
    // polls and never recounts an inbox in the browser.
    case 'dm_inbox_changed': {
      applyDmInboxChanged(event as any)
      break
    }
    default:
      break
  }
}

function scheduleReconnect(userId: string) {
  if (stopped) return
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.warn('[UserChannel] Giving up after repeated reconnect failures.')
    return
  }
  reconnectAttempts += 1
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    open(userId)
  }, delay)
}

function open(userId: string) {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
  if (source) return

  try {
    const next = new EventSource('/api/sse?scope=user')
    source = next
    connectedUserId = userId

    next.onopen = () => {
      reconnectAttempts = 0
      logger.debug('[UserChannel] Connected.')
    }

    next.onmessage = (message) => {
      let parsed: UserChannelEvent | null = null
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (!parsed || typeof parsed.type !== 'string') return
      applyToStores(parsed)
      emit(parsed)
    }

    next.onerror = () => {
      // EventSource reconnects on its own for transient drops, but a closed source is
      // terminal (a 401 after a logout, for example), so back off and retry deliberately.
      if (next.readyState === EventSource.CLOSED) {
        source = null
        scheduleReconnect(userId)
      }
    }
  } catch (error) {
    logger.warn('[UserChannel] Failed to open:', error)
    source = null
    scheduleReconnect(userId)
  }
}

/**
 * Start (or keep) the channel for this user. Safe to call from more than one component:
 * holders are counted, so the connection closes only when the last one lets go. Returns a
 * disposer for the caller's `onMount`.
 */
export function startUserChannel(userId?: string | null): () => void {
  const normalized = typeof userId === 'string' ? userId.trim() : ''
  if (!normalized) return () => {}

  if (connectedUserId && connectedUserId !== normalized) {
    holders = 0
    stopUserChannel()
  }

  stopped = false
  holders += 1
  open(normalized)

  let released = false
  return () => {
    if (released) return
    released = true
    holders = Math.max(0, holders - 1)
    if (holders === 0) stopUserChannel()
  }
}

export function stopUserChannel() {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (source) {
    try {
      source.close()
    } catch {
      // Already closed.
    }
  }
  source = null
  connectedUserId = null
  reconnectAttempts = 0
  holders = 0
}

export function isUserChannelConnected(): boolean {
  return Boolean(source && source.readyState === EventSource.OPEN)
}
