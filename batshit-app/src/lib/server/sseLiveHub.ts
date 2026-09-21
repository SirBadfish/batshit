/**
 * The server half of the live hub (2026-09-18): one HTTP stream per BROWSER carries every live
 * subscription its tabs have.
 *
 * Why: a browser opens at most six HTTP/1.1 connections to one server, shared by all its tabs,
 * and each Batshit chat tab used to hold two `EventSource` streams forever. Three tabs held all
 * six and every other request of every tab waited (measured, `_local/mtab-proof/`). Now the
 * browser's SharedWorker opens `GET /api/sse?scope=hub` once and adds or removes subscriptions
 * with `PATCH /api/sse`; this registry owns those hubs.
 *
 * The one rule that keeps `/api/sse` itself unchanged: **every subscription is its own
 * listener.** `createListener` makes an object shaped like the route's stream controller whose
 * `enqueue` wraps each frame with the subscription id and writes it into the hub's shared stream.
 * The route files it in `connections` (a chat) or `userConnections` (the user channel) exactly as
 * it filed a tab's own stream, so an event for a chat nobody hears is still dropped, a new
 * listener still gets the live turn's replay, and a chat is still torn down when its last
 * listener goes. The wire format lives in `$lib/services/liveHub/protocol.ts`, shared with the
 * browser.
 */

import { randomUUID } from 'crypto'
import {
  HUB_MAX_CHANGES_PER_REQUEST,
  HUB_MAX_SUBSCRIPTIONS_PER_HUB,
  HUB_SUBSCRIPTION_ID_PATTERN,
  HUB_TURN_ID_PATTERN,
  formatHubFrameData,
  type HubSubscriptionChange,
  type HubSubscriptionChangeResult,
  type HubSubscriptionRequest
} from '$lib/services/liveHub/protocol'

/** Shaped like `/api/sse`'s stream controller, so the route treats a subscription like a stream. */
export type HubListener = {
  _id: string
  _closed: boolean
  _heartbeat?: ReturnType<typeof setInterval>
  _visualCleanup?: () => void | Promise<void>
  enqueue(chunk: string): void
  close(): void
}

/** The route's own attach and detach code, handed in so this file owns only the hub. */
export type LiveHubAttachments = {
  ownsSession(
    sessionId: string,
    userId: string
  ): Promise<{ ok: true } | { ok: false; status: number; code: string }>
  attachSession(sessionId: string, listener: HubListener, userId: string): Promise<void>
  detachSession(sessionId: string, listener: HubListener): Promise<void>
  attachUser(userId: string, listener: HubListener): void
  detachUser(userId: string, listener: HubListener): void
  /**
   * A send's turn (2026-09-18): the tab that sent hears the turn's final answer here instead of
   * holding one of the browser's connections for the whole reply (`respondAsyncSend.ts`).
   */
  ownsTurn(turnId: string, userId: string): { ok: true } | { ok: false; status: number; code: string }
  attachTurn(turnId: string, listener: HubListener, userId: string): void
  detachTurn(turnId: string, listener: HubListener): void
}

/** Where a hub's frames go: the `ReadableStream` controller of `GET /api/sse?scope=hub`. */
export type LiveHubSink = { write(text: string): void; close(): void }

export type LiveHubHandle = { readonly id: string; readonly userId: string }

type HubSubscription = { request: HubSubscriptionRequest; listener: HubListener }

type HubState = {
  id: string
  userId: string
  sink: LiveHubSink
  closed: boolean
  heartbeat: ReturnType<typeof setInterval> | null
  subscriptions: Map<string, HubSubscription>
  /** Changes and the final teardown run one at a time, in order. */
  queue: Promise<unknown>
}

type ChangeAnswer =
  | { status: 200; body: HubSubscriptionChangeResult }
  | { status: 404; body: { error: string; code: 'hub_not_found' } }

const MAX_SESSION_ID_LENGTH = 256
const MAX_HUB_ID_LENGTH = 64

/**
 * Wrap one `enqueue` chunk (one or more SSE frames) for a subscription. Comments are dropped:
 * the hub stream has its own heartbeat. The event text is kept exactly; a multi-line frame is
 * written one `data:` line per line so the stream stays valid SSE.
 */
export function wrapSseChunkForSubscription(chunk: string, subscriptionId: string): string {
  let out = ''
  for (const frame of chunk.split('\n\n')) {
    if (!frame) continue
    const dataLines: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      else if (line.startsWith('data:')) dataLines.push(line.slice(5))
    }
    if (dataLines.length === 0) continue
    const wrapped = formatHubFrameData(subscriptionId, dataLines.join('\n'))
    out += `${wrapped
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n')}\n\n`
  }
  return out
}

function parseRequest(value: unknown): HubSubscriptionRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || !HUB_SUBSCRIPTION_ID_PATTERN.test(request.id)) return null
  if (request.scope === 'user') return { id: request.id, scope: 'user' }
  if (request.scope === 'turn') {
    return typeof request.turnId === 'string' && HUB_TURN_ID_PATTERN.test(request.turnId)
      ? { id: request.id, scope: 'turn', turnId: request.turnId }
      : null
  }
  if (
    request.scope === 'session' &&
    typeof request.sessionId === 'string' &&
    request.sessionId.trim().length > 0 &&
    request.sessionId.length <= MAX_SESSION_ID_LENGTH
  ) {
    return { id: request.id, scope: 'session', sessionId: request.sessionId }
  }
  return null
}

/** Validate a `PATCH /api/sse` body. */
export function parseHubSubscriptionChange(
  body: unknown
): { ok: true; value: HubSubscriptionChange } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON object.' }
  const raw = body as Record<string, unknown>
  if (typeof raw.hubId !== 'string' || !raw.hubId || raw.hubId.length > MAX_HUB_ID_LENGTH) {
    return { ok: false, error: 'hubId is required.' }
  }
  const addRaw = raw.add ?? []
  const removeRaw = raw.remove ?? []
  if (!Array.isArray(addRaw) || !Array.isArray(removeRaw)) {
    return { ok: false, error: 'add and remove must be lists.' }
  }
  if (addRaw.length > HUB_MAX_CHANGES_PER_REQUEST || removeRaw.length > HUB_MAX_CHANGES_PER_REQUEST) {
    return { ok: false, error: `At most ${HUB_MAX_CHANGES_PER_REQUEST} additions and removals per change.` }
  }
  const add: HubSubscriptionRequest[] = []
  for (const entry of addRaw) {
    const request = parseRequest(entry)
    if (!request) return { ok: false, error: 'Every addition needs a valid id and scope.' }
    add.push(request)
  }
  const remove: string[] = []
  for (const id of removeRaw) {
    if (typeof id !== 'string' || !HUB_SUBSCRIPTION_ID_PATTERN.test(id)) {
      return { ok: false, error: 'Every removal must be a subscription id.' }
    }
    remove.push(id)
  }
  return { ok: true, value: { hubId: raw.hubId, add, remove } }
}

export function createLiveHubRegistry(
  attachments: LiveHubAttachments,
  options: { heartbeatMs?: number } = {}
) {
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const hubs = new Map<string, HubState>()

  function write(hub: HubState, text: string): boolean {
    if (hub.closed) return false
    try {
      hub.sink.write(text)
      return true
    } catch {
      // The browser went away; the stream's `cancel` closes the hub and detaches everything.
      hub.closed = true
      if (hub.heartbeat) clearInterval(hub.heartbeat)
      hub.heartbeat = null
      return false
    }
  }

  function createListener(hub: HubState, subscriptionId: string): HubListener {
    const listener: HubListener = {
      _id: `hub-${hub.id.slice(0, 8)}-${subscriptionId}`,
      _closed: false,
      enqueue(chunk: string) {
        if (listener._closed || typeof chunk !== 'string') return
        const wrapped = wrapSseChunkForSubscription(chunk, subscriptionId)
        if (wrapped) write(hub, wrapped)
      },
      close() {
        listener._closed = true
      }
    }
    return listener
  }

  async function detach(hub: HubState, subscription: HubSubscription) {
    try {
      if (subscription.request.scope === 'session') {
        await attachments.detachSession(subscription.request.sessionId, subscription.listener)
      } else if (subscription.request.scope === 'turn') {
        attachments.detachTurn(subscription.request.turnId, subscription.listener)
      } else {
        attachments.detachUser(hub.userId, subscription.listener)
      }
    } catch (error) {
      console.error('[SSE] Failed to detach a live hub subscription', {
        hubId: hub.id,
        subscriptionId: subscription.request.id,
        error
      })
    } finally {
      subscription.listener._closed = true
    }
  }

  async function apply(hub: HubState, change: HubSubscriptionChange): Promise<ChangeAnswer> {
    const result: HubSubscriptionChangeResult = { added: [], removed: [], refused: [] }

    for (const id of change.remove ?? []) {
      const subscription = hub.subscriptions.get(id)
      if (subscription) {
        hub.subscriptions.delete(id)
        await detach(hub, subscription)
      }
      result.removed.push(id)
    }

    for (const request of change.add ?? []) {
      if (hub.closed) {
        result.refused.push({ id: request.id, status: 410, code: 'hub_closed' })
        continue
      }
      if (hub.subscriptions.has(request.id)) {
        result.added.push(request.id)
        continue
      }
      if (hub.subscriptions.size >= HUB_MAX_SUBSCRIPTIONS_PER_HUB) {
        result.refused.push({ id: request.id, status: 429, code: 'hub_full' })
        continue
      }
      if (request.scope === 'session') {
        const owned = await attachments.ownsSession(request.sessionId, hub.userId)
        if (!owned.ok) {
          result.refused.push({ id: request.id, status: owned.status, code: owned.code })
          continue
        }
      } else if (request.scope === 'turn') {
        const owned = attachments.ownsTurn(request.turnId, hub.userId)
        if (!owned.ok) {
          result.refused.push({ id: request.id, status: owned.status, code: owned.code })
          continue
        }
      }
      const subscription = { request, listener: createListener(hub, request.id) }
      hub.subscriptions.set(request.id, subscription)
      try {
        if (request.scope === 'session') {
          await attachments.attachSession(request.sessionId, subscription.listener, hub.userId)
        } else if (request.scope === 'turn') {
          attachments.attachTurn(request.turnId, subscription.listener, hub.userId)
        } else {
          attachments.attachUser(hub.userId, subscription.listener)
        }
        result.added.push(request.id)
      } catch (error) {
        console.error('[SSE] Failed to attach a live hub subscription', {
          hubId: hub.id,
          subscriptionId: request.id,
          error
        })
        hub.subscriptions.delete(request.id)
        await detach(hub, subscription)
        result.refused.push({ id: request.id, status: 500, code: 'attach_failed' })
      }
    }

    return { status: 200, body: result }
  }

  function enqueue<T>(hub: HubState, task: () => Promise<T>): Promise<T> {
    const run = hub.queue.then(task, task)
    hub.queue = run.catch(() => undefined)
    return run
  }

  return {
    /** Register a new hub stream and write its `hub_connected` frame. */
    open(userId: string, sink: LiveHubSink): LiveHubHandle {
      const hub: HubState = {
        id: randomUUID(),
        userId,
        sink,
        closed: false,
        heartbeat: null,
        subscriptions: new Map(),
        queue: Promise.resolve()
      }
      hubs.set(hub.id, hub)
      write(hub, `data: ${JSON.stringify({ type: 'hub_connected', hubId: hub.id })}\n\n`)
      if (heartbeatMs > 0) {
        hub.heartbeat = setInterval(() => {
          if (!write(hub, ':heartbeat\n\n') && hub.heartbeat) clearInterval(hub.heartbeat)
        }, heartbeatMs)
      }
      return { id: hub.id, userId }
    },

    /** Add and remove subscriptions on one of this user's hubs. */
    change(userId: string, change: HubSubscriptionChange): Promise<ChangeAnswer> {
      const hub = hubs.get(change.hubId)
      if (!hub || hub.userId !== userId || hub.closed) {
        return Promise.resolve({
          status: 404,
          body: { error: 'Live connection not found', code: 'hub_not_found' }
        })
      }
      return enqueue(hub, () => apply(hub, change))
    },

    /** The hub's stream is gone: detach every subscription, after any change in progress. */
    close(hubId: string): Promise<void> {
      const hub = hubs.get(hubId)
      if (!hub) return Promise.resolve()
      hubs.delete(hubId)
      hub.closed = true
      if (hub.heartbeat) clearInterval(hub.heartbeat)
      hub.heartbeat = null
      return enqueue(hub, async () => {
        const subscriptions = [...hub.subscriptions.values()]
        hub.subscriptions.clear()
        for (const subscription of subscriptions) await detach(hub, subscription)
      })
    },

    /**
     * Runtime shutdown: end every hub stream. The route closes the listeners themselves (they sit
     * in its `connections` and `userConnections`) and clears its own maps.
     */
    closeAllStreams() {
      for (const hub of hubs.values()) {
        hub.closed = true
        if (hub.heartbeat) clearInterval(hub.heartbeat)
        hub.heartbeat = null
        try {
          hub.sink.close()
        } catch {
          // The browser may already have closed the stream.
        }
      }
      hubs.clear()
    },

    inspect() {
      let subscriptions = 0
      for (const hub of hubs.values()) subscriptions += hub.subscriptions.size
      return { hubs: hubs.size, subscriptions }
    }
  }
}

export type LiveHubRegistry = ReturnType<typeof createLiveHubRegistry>
