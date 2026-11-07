import { refreshToolOperationsSource, setToolOperationsOwner } from '$lib/stores/toolOperationalSettings.svelte'
import { refreshAppearanceFromServer } from '$lib/appearance/appLookSync.svelte'
import { refreshStoredSavedModels, setSavedModelsOwner } from '$lib/stores/savedModels.svelte'
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
import { getAgents, refreshAgentFieldsFromServer } from '$lib/stores/agents.svelte'
import { subagentStore, refreshSubagentIdentityFromServer, refreshSubagentModelSelectionFromServer, refreshSubagentInstructionsFromServer, refreshSubagentProviderSettingsFromServer } from '$lib/stores/subagents.svelte'
import { subscribeLive, type LiveSubscription } from '$lib/services/liveHub/liveHubClient'
import { logger } from '$lib/utils/logger'
import { dispatchSlashCommandsUpdated } from '$lib/utils/liveSettingsEvents'

export type UserChannelEvent =
  | { type: 'connected'; scope: 'user' }
  /**
   * BL-382: THIS TAB's own signal, never the server's (a server event of this type is dropped):
   * the server added the user channel again after the live connection came back (or after the
   * hub took back a silent tab). What it said meanwhile is gone (`session_run_status` of a woken
   * turn that ended, for one), so the chat page catches up the chats it still thinks are busy.
   */
  | { type: 'reconnected' }
  | { type: 'slash_commands_changed' }
  | { type: 'plugin_access_changed'; pluginId?: string }
  | { type: 'model_presets_changed' }
  | { type: 'user_settings_changed'; family: 'tool-operations' | 'appearance' }
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
   * The SERVER changed zip state in a session: Judge Juice smart zip opened or zipped a result
   * (SA-120 P5, `source: 'inferred'`), an agent's reply held, released, or moved a hold, or ran a
   * parked zip action (SA-129 P2, `agent`), or a temporary hold counted a message or ended
   * (`countdown`). The server wrote Redis; every tab showing that session re-reads zip state so
   * the badge and the countdown are right. Handled by the chat page, not by `applyToStores`.
   */
  | {
      type: 'zip_state_changed'
      sessionId: string
      source: 'inferred' | 'agent' | 'countdown'
      opened: string[]
      rezipped: string[]
    }
  /**
   * SA-120 P6 — the Judge Juice after-reply check stored something about a finished reply (a
   * flag, a style note, or a note that a lane could not run). It happens once the session
   * stream has already emitted `end`, so the user channel carries it, and every tab showing
   * that session re-reads the chat's after-reply records to draw the chip. Handled by the chat
   * page, not by `applyToStores`.
   */
  | { type: 'jev_juice_post_turn'; sessionId: string; messageId: string }
  /**
   * BL-474 step 2: the server decided where a reply's outside pictures came from (written before
   * that reply's `end`). The tab showing the chat re-reads its records. Handled by the chat page.
   */
  | { type: 'image_origin_changed'; sessionId: string; messageId: string }
  | { type: 'whiteboard_changed'; sessionId: string; agentId: string; version: number }
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
  /**
   * SA-122 A-1y (LS-067/LS-068): the agent saved its own Settings (App Actions), or sent a save whose
   * answer was lost. No tab made it, so no tab has it: the shared agent store reads that agent's
   * family of fields again here (`applyToStores`), and a mounted Agents or Memory panel reads it
   * again by its own rules. It carries no values: the record is the one source.
   */
  | { type: 'mcp_gateway_source_changed'; gatewayId: string }
  | { type: 'agent_settings_changed'; agentId: string; family: 'mcp-settings' | 'provider-settings' | 'memory' | 'identity' | 'retention' | 'app-actions-policy' | 'model-selection' | 'instructions' | 'auto-compact' | 'voice-selection' }
  | { type: 'subagent_settings_changed'; agentId: string; family: 'identity' | 'model-selection' | 'instructions' | 'provider-settings' }
  | { type: 'portable_skill_authority_changed'; tokenId: string; authorityGeneration: number }
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
    case 'model_presets_changed': void refreshStoredSavedModels(); break
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
    case 'plugin_access_changed':
    case 'slash_commands_changed': {
      dispatchSlashCommandsUpdated({ source: 'unknown' })
      break
    }
    case 'user_settings_changed': {
      if (event.family === 'tool-operations') void refreshToolOperationsSource()
      if (event.family === 'appearance') void refreshAppearanceFromServer()
      break
    }
    case 'subagent_settings_changed': {
      const { agentId, family } = event as any
      if (typeof agentId === 'string' && agentId && family === 'provider-settings') void refreshSubagentProviderSettingsFromServer(agentId)
      if (typeof agentId === 'string' && agentId && family === 'identity') void refreshSubagentIdentityFromServer(agentId)
      if (typeof agentId === 'string' && agentId && family === 'model-selection') { void refreshSubagentModelSelectionFromServer(agentId); void refreshStoredSavedModels() }
      if (typeof agentId === 'string' && agentId && family === 'instructions') void refreshSubagentInstructionsFromServer(agentId)
      break
    }
    case 'agent_settings_changed': {
      const { agentId, family } = event as any
      if (typeof agentId === 'string' && agentId && family === 'model-selection') void refreshStoredSavedModels()
      if (typeof agentId === 'string' && agentId && (family === 'mcp-settings' || family === 'provider-settings' || family === 'memory' || family === 'identity' || family === 'retention' || family === 'model-selection' || family === 'instructions' || family === 'auto-compact' || family === 'voice-selection')) {
        void refreshAgentFieldsFromServer(agentId, family)
      }
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
  if (parsed.type === 'reconnected') return
  applyToStores(parsed)
  emit(parsed)
}

function open(userId: string) {
  if (typeof window === 'undefined') return
  if (subscription) return
  connectedUserId = userId
  setSavedModelsOwner(userId)
  setToolOperationsOwner(userId)
  let opened = false
  subscription = subscribeLive(
    { scope: 'user' },
    {
      onEvent: handleMessage,
      onStatus: (status, code) => {
        if (status === 'open') {
          logger.debug('[UserChannel] Connected.')
          // BL-382: every `open` after the first means the server added the channel again.
          if (opened) {
            for (const agent of getAgents()) {
              void refreshAgentFieldsFromServer(agent.id, 'retention')
              void refreshAgentFieldsFromServer(agent.id, 'mcp-settings')
              void refreshAgentFieldsFromServer(agent.id, 'provider-settings')
              void refreshAgentFieldsFromServer(agent.id, 'model-selection')
              void refreshAgentFieldsFromServer(agent.id, 'instructions')
              void refreshAgentFieldsFromServer(agent.id, 'auto-compact')
              void refreshAgentFieldsFromServer(agent.id, 'voice-selection')
            }
            for (const subagent of subagentStore.subagents) {
              void refreshSubagentProviderSettingsFromServer(subagent.id)
              void refreshSubagentModelSelectionFromServer(subagent.id)
              void refreshSubagentInstructionsFromServer(subagent.id)
            }
            dispatchSlashCommandsUpdated({ source: 'unknown' })
            void refreshStoredSavedModels()
            void refreshToolOperationsSource()
            emit({ type: 'reconnected' })
          }
          opened = true
        } else if (status === 'down') logger.debug('[UserChannel] Live connection dropped; reconnecting.')
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
  setSavedModelsOwner(null)
  setToolOperationsOwner(null)
  holders = 0
}

export function isUserChannelConnected(): boolean {
  return subscription?.state() === 'open'
}
