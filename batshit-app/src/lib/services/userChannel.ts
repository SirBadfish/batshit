/**
 * SA-113 P1 (DL-113-06) — the browser's one connection to the user-wide live channel.
 *
 * Every other Batshit live update is session-scoped: you open a chat, you get that chat's
 * stream. That leaves a real hole. Recon 2.4 found that the sidebar learns about a new
 * session only from its own actions — there is no push, no poll, no focus refresh — so a
 * chat that Batshit starts on its own (a wake-up) would simply not appear until the next
 * page load, and the run spinner and the three-active-chats cap would not count it.
 *
 * This module holds one user-channel subscription per browser tab and applies what it hears
 * to the stores the sidebar already reads, so no component needs new wiring. Consumers
 * that want to react to a specific event (the chat page refetching messages when a woken
 * turn completes) subscribe through `onUserChannelEvent`.
 *
 * The subscription rides the browser's ONE shared live connection (the live hub,
 * 2026-09-18, `$lib/services/liveHub/`): each tab used to open its own `EventSource` here,
 * which with the chat stream beside it held two of the browser's six connections per server,
 * so three tabs froze every request. The hub reconnects by itself, so this module no longer
 * keeps its own retry timer.
 *
 * `SA-111b`'s "your background worker finished" event lands on this same channel.
 */

import * as sessionStore from '$lib/stores/session.svelte'
import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
import { applyDmInboxChanged } from '$lib/stores/dmInbox.svelte'
import { subscribeLive, type LiveSubscription } from '$lib/services/liveHub/liveHubClient'
import { logger } from '$lib/utils/logger'

export type UserChannelEvent =
  | { type: 'connected'; scope: 'user' }
  | { type: 'session_created'; session: Record<string, any> }
  | { type: 'session_updated'; sessionId: string; patch: Record<string, any> }
  /**
   * A chat was deleted, from any tab or route (2026-09-18). Every tab drops it from the
   * sidebar here; the chat page also forgets its messages and live connection, and leaves it
   * when it was on screen. Before this event a chat deleted in one tab stayed in every other
   * tab until that tab reloaded.
   */
  | { type: 'session_deleted'; sessionId: string }
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
  /**
   * SA-120 P5 — Batshit itself changed zip state in a session (Jev Juice smart zip opened a
   * zipped result for a message, or zipped a finished one after a reply; `source: 'inferred'`).
   * The server wrote Redis; every tab showing that session re-reads zip state so the badge and
   * the ordinary countdown are right. Handled by the chat page, not by `applyToStores`.
   */
  | { type: 'zip_state_changed'; sessionId: string; source: 'inferred'; opened: string[]; rezipped: string[] }
  /**
   * SA-120 P6 — the Jev Juice after-reply check stored something about a finished reply (a
   * flag, a style note, or a note that a lane could not run). It happens once the session
   * stream has already emitted `end`, so the user channel carries it, and every tab showing
   * that session re-reads the chat's after-reply records to draw the chip. Handled by the chat
   * page, not by `applyToStores`.
   */
  | { type: 'jev_juice_post_turn'; sessionId: string; messageId: string }
  /**
   * The SERVER changed a chat's stored messages in a way no stream event can show a tab:
   * an approval resume that streams into a message every tab has already marked finished,
   * an approval card the server settled, or a message deleted in another tab. The tab
   * showing that chat re-reads it. Handled by the chat page, not by `applyToStores`.
   *
   * It exists because until 2026-09-18 the chat page re-fetched the open chat about ten
   * times a second, so none of these ever had to be said out loud.
   */
  | { type: 'session_messages_changed'; sessionId: string; reason: string }
  | (Record<string, any> & { type: string })

type Listener = (event: UserChannelEvent) => void

let subscription: LiveSubscription | null = null
let connectedUserId: string | null = null
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
    case 'session_deleted': {
      const { sessionId } = event as any
      if (typeof sessionId === 'string' && sessionId) {
        sessionStore.deleteSession(sessionId)
        // Its spinner, and its place in the three-active-chats count, go with it.
        chatRunRegistry.resetRunState(sessionId)
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

function handleMessage(text: string) {
  let parsed: UserChannelEvent | null = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (!parsed || typeof parsed.type !== 'string') return
  applyToStores(parsed)
  emit(parsed)
}

function open(userId: string) {
  if (typeof window === 'undefined') return
  if (subscription) return
  connectedUserId = userId
  subscription = subscribeLive(
    { scope: 'user' },
    {
      onEvent: handleMessage,
      onStatus: (status, code) => {
        if (status === 'open') logger.debug('[UserChannel] Connected.')
        else if (status === 'down') logger.debug('[UserChannel] Live connection dropped; reconnecting.')
        else logger.warn('[UserChannel] The server refused the user channel:', code)
      }
    }
  )
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
  const current = subscription
  subscription = null
  current?.unsubscribe()
  connectedUserId = null
  holders = 0
}

export function isUserChannelConnected(): boolean {
  return subscription?.state() === 'open'
}
