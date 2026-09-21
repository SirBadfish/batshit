/**
 * A tab's side of the live hub (2026-09-18): how this tab hears live updates without holding a
 * connection of its own.
 *
 * `subscribeLive` is the only thing the rest of the app calls (`SSEService` for a chat,
 * `userChannel.ts` for the user channel, `sendRoutedClient.ts` for a send's turn). Every tab of
 * the browser talks to ONE SharedWorker
 * (`liveHub.worker.ts`), which holds the browser's one stream to Batshit, so the number of tabs
 * and chats no longer eats the browser's six connections per server.
 *
 * Where a browser has no SharedWorker (or the worker fails to start), the same `HubCore` runs
 * inside this tab over a `MessageChannel`: this tab then holds one connection of its own, which
 * is still fewer than before. That is said once in the console, because a browser that cannot
 * share has fewer tabs to spare.
 *
 * A tab sends its WHOLE subscription list on every change and every `LIVE_HUB_HEARTBEAT_MS`, so
 * a hub that dropped it (frozen, suspended by a phone, silent past the limit) takes it back on
 * the next message. It says `bye` on `pagehide` and re-sends at once when it is shown again.
 */

import { version } from '$app/environment'
import { HubCore, type HubPortLike } from './hubCore'
import { createBrowserHubOptions } from './browserHub'
import type {
  HubClientMessage,
  HubServerMessage,
  HubSubscriptionRequest,
  HubSubscriptionStatus
} from './protocol'

export const LIVE_HUB_HEARTBEAT_MS = 15_000

/** What a tab can listen to. */
export type LiveTarget =
  | { scope: 'user' }
  | { scope: 'session'; sessionId: string }
  | { scope: 'turn'; turnId: string }

export type LiveSubscriptionState = 'pending' | HubSubscriptionStatus

export type LiveSubscriptionHandlers = {
  /** One event's JSON text, exactly as the server wrote it. */
  onEvent: (data: string) => void
  onStatus?: (status: HubSubscriptionStatus, code?: string) => void
}

export type LiveSubscription = {
  readonly id: string
  state(): LiveSubscriptionState
  unsubscribe(): void
}

/** How a tab reaches its hub: the SharedWorker's port, or a channel to a hub in this tab. */
export type HubClientPort = {
  postMessage(message: HubClientMessage): void
  onMessage(handler: (message: HubServerMessage) => void): void
}

type Entry = {
  request: HubSubscriptionRequest
  handlers: LiveSubscriptionHandlers
  state: LiveSubscriptionState
}

export function createLiveHubClient(options: {
  clientId: string
  port: HubClientPort
  makeId: () => string
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  heartbeatMs?: number
}) {
  const entries = new Map<string, Entry>()
  let port = options.port
  let heartbeat: unknown = null

  function sendState() {
    port.postMessage({
      type: 'state',
      clientId: options.clientId,
      subscriptions: [...entries.values()].map((entry) => entry.request)
    })
  }

  function handle(message: HubServerMessage) {
    const entry = message && typeof message.id === 'string' ? entries.get(message.id) : undefined
    if (!entry) return
    try {
      if (message.type === 'event') {
        entry.handlers.onEvent(message.data)
      } else if (message.type === 'status') {
        entry.state = message.status
        entry.handlers.onStatus?.(message.status, message.code)
      }
    } catch (error) {
      console.error('[LiveHub] A live-update handler threw:', error)
    }
  }

  function attach(next: HubClientPort) {
    port = next
    port.onMessage(handle)
  }

  function updateHeartbeat() {
    if (entries.size > 0 && heartbeat === null) {
      heartbeat = options.setInterval(sendState, options.heartbeatMs ?? LIVE_HUB_HEARTBEAT_MS)
    } else if (entries.size === 0 && heartbeat !== null) {
      options.clearInterval(heartbeat)
      heartbeat = null
    }
  }

  attach(options.port)

  return {
    subscribe(target: LiveTarget, handlers: LiveSubscriptionHandlers): LiveSubscription {
      const id = options.makeId()
      const request: HubSubscriptionRequest =
        target.scope === 'user'
          ? { id, scope: 'user' }
          : target.scope === 'turn'
            ? { id, scope: 'turn', turnId: target.turnId }
            : { id, scope: 'session', sessionId: target.sessionId }
      const entry: Entry = { request, handlers, state: 'pending' }
      entries.set(id, entry)
      sendState()
      updateHeartbeat()
      return {
        id,
        state: () => entry.state,
        unsubscribe: () => {
          if (entries.get(id) !== entry) return
          entries.delete(id)
          sendState()
          updateHeartbeat()
        }
      }
    },

    /** Re-send the whole list now: the tab is visible again, back from the cache, or resumed. */
    resend() {
      if (entries.size > 0) sendState()
    },

    /** The page is going away: the hub drops this tab at once instead of after its silence. */
    bye() {
      port.postMessage({ type: 'bye', clientId: options.clientId })
    },

    /** Move to another hub (the SharedWorker failed to start) and re-send everything to it. */
    replacePort(next: HubClientPort) {
      attach(next)
      if (entries.size > 0) sendState()
    },

    inspect() {
      return { subscriptions: entries.size, heartbeat: heartbeat !== null }
    }
  }
}

export type LiveHubClient = ReturnType<typeof createLiveHubClient>

function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function wrapMessagePort(port: MessagePort): HubClientPort {
  let handler: ((message: HubServerMessage) => void) | null = null
  // Setting `onmessage` also starts the port.
  port.onmessage = (event: MessageEvent<HubServerMessage>) => handler?.(event.data)
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (next) => {
      handler = next
    }
  }
}

/** A hub inside this tab, for a browser that cannot share one. */
function createTabHubPort(): HubClientPort {
  const core = new HubCore(createBrowserHubOptions())
  const channel = new MessageChannel()
  const tab: HubPortLike = { postMessage: (message) => channel.port1.postMessage(message) }
  channel.port1.onmessage = (event: MessageEvent<HubClientMessage>) => core.receive(tab, event.data)
  return wrapMessagePort(channel.port2)
}

function openSharedHubPort(onFailure: () => void): HubClientPort | null {
  if (typeof SharedWorker !== 'function') {
    console.warn(
      '[LiveHub] This browser has no SharedWorker, so this tab keeps its own live connection instead of sharing one with your other Batshit tabs.'
    )
    return null
  }
  try {
    // The build version in the name gives a new build its own worker; an older tab keeps its own.
    const worker = new SharedWorker(new URL('./liveHub.worker.ts', import.meta.url), {
      type: 'module',
      name: `batshit-live-hub-${version}`
    })
    let failed = false
    worker.addEventListener('error', (event) => {
      if (failed) return
      failed = true
      console.warn('[LiveHub] The shared live connection did not start; this tab keeps its own.', event)
      onFailure()
    })
    return wrapMessagePort(worker.port)
  } catch (error) {
    console.warn('[LiveHub] The shared live connection could not start; this tab keeps its own.', error)
    return null
  }
}

let browserClient: LiveHubClient | null = null

function getBrowserClient(): LiveHubClient {
  if (browserClient) return browserClient
  let client: LiveHubClient | null = null
  const shared = openSharedHubPort(() => client?.replacePort(createTabHubPort()))
  client = createLiveHubClient({
    clientId: randomId(),
    port: shared ?? createTabHubPort(),
    makeId: randomId,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
  })
  const created = client
  window.addEventListener('pagehide', () => created.bye())
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) created.resend()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') created.resend()
  })
  // Chrome's Page Lifecycle: a frozen tab sends no heartbeat, so say we are back at once.
  document.addEventListener('resume', () => created.resend())
  browserClient = created
  return created
}

/** Listen to the user channel, one chat, or one send's turn over the browser's shared live connection. */
export function subscribeLive(target: LiveTarget, handlers: LiveSubscriptionHandlers): LiveSubscription {
  return getBrowserClient().subscribe(target, handlers)
}
