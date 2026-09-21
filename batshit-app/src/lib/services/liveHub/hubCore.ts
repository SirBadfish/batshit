/**
 * The live hub (2026-09-18): ONE live connection for the whole browser, however many Batshit
 * tabs and chats are open.
 *
 * Each tab used to hold its own `EventSource` streams (the user channel and the chat on screen,
 * plus any chat still finishing), and a browser opens at most six HTTP/1.1 connections to one
 * server, shared by all its tabs: three tabs held all six and every other request of every tab
 * waited (measured, `_local/mtab-proof/`). This hub holds one stream to `/api/sse?scope=hub`
 * and carries every tab's subscriptions over it. It runs in a SharedWorker (`liveHub.worker.ts`)
 * or, where a browser has none, inside the tab (`liveHubClient.ts`); this file has no DOM or
 * worker globals, so a test drives it directly.
 *
 * The rules, each pinned by `hubCore.test.ts`:
 * - One stream while any subscription is wanted; none when nothing is.
 * - Each event goes to the one tab that owns its subscription id, as the exact text the server
 *   wrote. Events for a subscription the server has added but not yet answered for still go
 *   through: the server writes a new listener's replay BEFORE it answers the change.
 * - The server hears one change at a time (`PATCH /api/sse`); anything asked meanwhile is folded
 *   into the next one. A change answered for a hub that has since been replaced is ignored.
 * - When the stream drops, every open subscription is told `down`; the next `hub_connected`
 *   re-adds all of them (the server replays each chat's live turn to its new listener, and the
 *   page's `SseEventDeduper` drops what it already had).
 * - A subscription the server refuses is told `refused` and never asked for again.
 * - A tab re-sends its whole list on every change and on a heartbeat; a tab that says `bye`, or
 *   is silent past `HUB_CLIENT_SILENCE_LIMIT_MS`, loses its subscriptions until it speaks again.
 */

import {
  HUB_MAX_CHANGES_PER_REQUEST,
  HUB_SUBSCRIPTION_ID_PATTERN,
  HUB_TURN_ID_PATTERN,
  parseHubFrameData,
  type HubClientMessage,
  type HubServerMessage,
  type HubSubscriptionChange,
  type HubSubscriptionRefusal,
  type HubSubscriptionRequest,
  type HubSubscriptionStatus
} from './protocol'

/** The hub's view of its `EventSource`: its state, and a way to close it. */
export type HubStream = {
  readyState(): number
  close(): void
}

/** What the hub hears from its stream: each frame's `data`, and each `error` event. */
export type HubStreamHandlers = {
  onMessage(data: string): void
  onError(): void
}

/** Where the hub writes to one tab (a `MessagePort`). */
export type HubPortLike = { postMessage(message: HubServerMessage): void }

export type HubCoreOptions = {
  /** `new EventSource('/api/sse?scope=hub')`, wired to the handlers. */
  openStream: (handlers: HubStreamHandlers) => HubStream
  /** `PATCH /api/sse` with the change; resolves with the HTTP status and parsed body. */
  patch: (change: HubSubscriptionChange) => Promise<{ status: number; body: unknown }>
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
  warn?: (...args: unknown[]) => void
}

/** A tab silent this long is treated as gone (heartbeats are 15 s; a hidden tab's timers can
 * be held to once a minute). */
export const HUB_CLIENT_SILENCE_LIMIT_MS = 5 * 60_000
export const HUB_RETRY_BASE_MS = 1_000
export const HUB_RETRY_MAX_MS = 30_000

const EVENT_SOURCE_CLOSED = 2
const MAX_SESSION_ID_LENGTH = 256

type Subscription = {
  request: HubSubscriptionRequest
  clientId: string
  state: 'pending' | 'open' | 'refused'
}

type Client = {
  port: HubPortLike
  lastSeen: number
  ids: Set<string>
}

function isValidRequest(value: unknown): value is HubSubscriptionRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || !HUB_SUBSCRIPTION_ID_PATTERN.test(request.id)) return false
  if (request.scope === 'user') return true
  if (request.scope === 'turn') return typeof request.turnId === 'string' && HUB_TURN_ID_PATTERN.test(request.turnId)
  return (
    request.scope === 'session' &&
    typeof request.sessionId === 'string' &&
    request.sessionId.trim().length > 0 &&
    request.sessionId.length <= MAX_SESSION_ID_LENGTH
  )
}

function copyRequest(request: HubSubscriptionRequest): HubSubscriptionRequest {
  if (request.scope === 'user') return { id: request.id, scope: 'user' }
  if (request.scope === 'turn') return { id: request.id, scope: 'turn', turnId: request.turnId }
  return { id: request.id, scope: 'session', sessionId: request.sessionId }
}

function retryDelay(attempt: number) {
  return Math.min(HUB_RETRY_BASE_MS * 2 ** attempt, HUB_RETRY_MAX_MS)
}

export class HubCore {
  private readonly clients = new Map<string, Client>()
  private readonly subscriptions = new Map<string, Subscription>()
  /** What the server holds for the CURRENT hub id. */
  private readonly serverIds = new Set<string>()
  private stream: HubStream | null = null
  private hubId: string | null = null
  private reopenTimer: unknown = null
  private reopenAttempts = 0
  private syncing = false
  private syncRetryTimer: unknown = null
  private syncRetryAttempts = 0

  constructor(private readonly options: HubCoreOptions) {}

  /** A message from a tab, with the port it came on (a tab's port can change on reconnect). */
  receive(port: HubPortLike, message: HubClientMessage) {
    if (!message || typeof message !== 'object' || typeof message.clientId !== 'string') return
    if (message.type === 'bye') {
      if (this.dropClient(message.clientId)) this.reconcile()
      return
    }
    if (message.type !== 'state' || !Array.isArray(message.subscriptions)) return

    let client = this.clients.get(message.clientId)
    if (!client) {
      client = { port, lastSeen: 0, ids: new Set() }
      this.clients.set(message.clientId, client)
    }
    client.port = port
    client.lastSeen = this.options.now()

    const wanted = new Map<string, HubSubscriptionRequest>()
    for (const request of message.subscriptions) {
      if (!isValidRequest(request)) {
        this.options.warn?.('[LiveHub] Ignoring a malformed subscription from a tab.', request)
        continue
      }
      wanted.set(request.id, copyRequest(request))
    }

    let changed = false
    for (const id of [...client.ids]) {
      if (wanted.has(id)) continue
      client.ids.delete(id)
      this.subscriptions.delete(id)
      changed = true
    }
    for (const [id, request] of wanted) {
      if (this.subscriptions.has(id)) continue
      this.subscriptions.set(id, { request, clientId: message.clientId, state: 'pending' })
      client.ids.add(id)
      changed = true
    }
    if (changed) this.reconcile()
  }

  /** Forget every tab that has been silent past the limit. The worker calls this on a timer. */
  sweep() {
    const cutoff = this.options.now() - HUB_CLIENT_SILENCE_LIMIT_MS
    let changed = false
    for (const [clientId, client] of [...this.clients]) {
      if (client.lastSeen > cutoff) continue
      changed = this.dropClient(clientId) || changed
    }
    if (changed) this.reconcile()
  }

  /** For tests and diagnostics. */
  inspect() {
    return {
      streamOpen: this.stream !== null,
      hubId: this.hubId,
      clients: this.clients.size,
      subscriptions: this.subscriptions.size,
      serverSubscriptions: this.serverIds.size
    }
  }

  private dropClient(clientId: string): boolean {
    const client = this.clients.get(clientId)
    if (!client) return false
    this.clients.delete(clientId)
    for (const id of client.ids) this.subscriptions.delete(id)
    return client.ids.size > 0
  }

  private reconcile() {
    if (this.subscriptions.size === 0) {
      // The server detaches every listener of a hub when its stream closes, so nothing is sent.
      this.closeStream()
      return
    }
    this.ensureStream()
    this.queueSync()
  }

  private ensureStream() {
    if (this.stream || this.reopenTimer !== null) return
    // Every stream this hub lets go of is closed first, and a closed EventSource fires nothing.
    const stream: HubStream = this.options.openStream({
      onMessage: (data) => this.handleFrame(data),
      onError: () => this.handleStreamError(stream)
    })
    this.stream = stream
  }

  private handleFrame(data: unknown) {
    if (typeof data !== 'string') return
    const frame = parseHubFrameData(data)
    if (frame) {
      const subscription = this.subscriptions.get(frame.subscriptionId)
      if (!subscription || subscription.state === 'refused') return
      this.clients
        .get(subscription.clientId)
        ?.port.postMessage({ type: 'event', id: frame.subscriptionId, data: frame.eventJson })
      return
    }
    let control: unknown = null
    try {
      control = JSON.parse(data)
    } catch {
      return
    }
    const event = control as { type?: unknown; hubId?: unknown }
    if (event?.type === 'hub_connected' && typeof event.hubId === 'string' && event.hubId) {
      this.hubId = event.hubId
      this.reopenAttempts = 0
      this.syncRetryAttempts = 0
      this.clearSyncRetry()
      this.queueSync()
    }
  }

  private handleStreamError(stream: HubStream) {
    this.loseHub()
    if (stream.readyState() === EVENT_SOURCE_CLOSED) {
      // The browser gave up on this stream (an HTTP error, a signed-out user): open a new one.
      this.stream = null
      this.scheduleReopen()
    }
    // Otherwise the browser is already reconnecting; the new stream says `hub_connected`.
  }

  /** The hub id is gone: tell every open subscription, and wait for the next one. */
  private loseHub() {
    this.hubId = null
    this.serverIds.clear()
    this.clearSyncRetry()
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.state !== 'open') continue
      subscription.state = 'pending'
      this.notify(id, subscription, 'down')
    }
  }

  private restartStream() {
    const stream = this.stream
    this.loseHub()
    this.stream = null
    stream?.close()
    this.scheduleReopen()
  }

  private scheduleReopen() {
    if (this.reopenTimer !== null) return
    const delay = retryDelay(this.reopenAttempts)
    this.reopenAttempts += 1
    this.reopenTimer = this.options.setTimeout(() => {
      this.reopenTimer = null
      if (this.subscriptions.size > 0) this.ensureStream()
    }, delay)
  }

  private closeStream() {
    const stream = this.stream
    this.stream = null
    this.hubId = null
    this.serverIds.clear()
    this.reopenAttempts = 0
    this.syncRetryAttempts = 0
    this.clearSyncRetry()
    if (this.reopenTimer !== null) {
      this.options.clearTimeout(this.reopenTimer)
      this.reopenTimer = null
    }
    stream?.close()
  }

  private clearSyncRetry() {
    if (this.syncRetryTimer === null) return
    this.options.clearTimeout(this.syncRetryTimer)
    this.syncRetryTimer = null
  }

  /** Batch every change made in this turn of the event loop into one request. */
  private queueSync() {
    void Promise.resolve().then(() => this.sync())
  }

  private async sync() {
    const hubId = this.hubId
    if (!hubId || this.syncing || this.syncRetryTimer !== null) return

    const remove = [...this.serverIds].filter((id) => !this.subscriptions.has(id))
    const add: HubSubscriptionRequest[] = []
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.state === 'pending' && !this.serverIds.has(id)) add.push(subscription.request)
    }
    if (remove.length === 0 && add.length === 0) return

    const change: HubSubscriptionChange = {
      hubId,
      add: add.slice(0, HUB_MAX_CHANGES_PER_REQUEST),
      remove: remove.slice(0, HUB_MAX_CHANGES_PER_REQUEST)
    }
    this.syncing = true
    let retry = false
    try {
      const response = await this.options.patch(change)
      if (this.hubId !== hubId) return
      if (response.status === 200) {
        this.applyAnswer(change, response.body)
        this.syncRetryAttempts = 0
      } else if (response.status === 401 || response.status === 403 || response.status === 404) {
        // The server no longer knows this hub (it restarted, or the stream closed under us) or
        // this user: a new stream gets a new hub, or the sign-in page takes over.
        this.options.warn?.('[LiveHub] The server refused a subscription change; reconnecting.', response.status)
        this.restartStream()
      } else {
        retry = true
      }
    } catch (error) {
      this.options.warn?.('[LiveHub] A subscription change failed; retrying.', error)
      retry = this.hubId === hubId
    } finally {
      this.syncing = false
      if (retry) this.scheduleSyncRetry()
      else if (this.hubId) this.queueSync()
    }
  }

  private applyAnswer(change: HubSubscriptionChange, body: unknown) {
    const answer = (body && typeof body === 'object' ? body : {}) as {
      added?: unknown
      removed?: unknown
      refused?: unknown
    }
    const added = new Set(Array.isArray(answer.added) ? answer.added.filter((id) => typeof id === 'string') : [])
    const removed = Array.isArray(answer.removed) ? answer.removed.filter((id) => typeof id === 'string') : []
    const refused = new Map<string, HubSubscriptionRefusal>()
    if (Array.isArray(answer.refused)) {
      for (const refusal of answer.refused as HubSubscriptionRefusal[]) {
        if (refusal && typeof refusal.id === 'string') refused.set(refusal.id, refusal)
      }
    }

    for (const id of removed) this.serverIds.delete(id)
    for (const request of change.add ?? []) {
      const subscription = this.subscriptions.get(request.id)
      if (added.has(request.id)) {
        this.serverIds.add(request.id)
        if (subscription && subscription.state !== 'open') {
          subscription.state = 'open'
          this.notify(request.id, subscription, 'open')
        }
        continue
      }
      // Refused, or not mentioned at all: either way never asked for again, so it cannot loop.
      if (!subscription || subscription.state === 'refused') continue
      subscription.state = 'refused'
      this.notify(request.id, subscription, 'refused', refused.get(request.id)?.code ?? 'unanswered')
    }
  }

  private scheduleSyncRetry() {
    if (this.syncRetryTimer !== null) return
    const delay = retryDelay(this.syncRetryAttempts)
    this.syncRetryAttempts += 1
    this.syncRetryTimer = this.options.setTimeout(() => {
      this.syncRetryTimer = null
      this.queueSync()
    }, delay)
  }

  private notify(id: string, subscription: Subscription, status: HubSubscriptionStatus, code?: string) {
    const port = this.clients.get(subscription.clientId)?.port
    if (!port) return
    port.postMessage(code ? { type: 'status', id, status, code } : { type: 'status', id, status })
  }
}
