/**
 * The live hub's wire format (2026-09-18): ONE live connection per browser.
 *
 * Chrome, Firefox, and Safari open at most six HTTP/1.1 connections to one server, and every
 * tab of the browser shares them. Each chat tab used to hold two forever (the user channel and
 * the chat on screen), so three tabs held all six and every other request of every tab waited
 * (measured: `_local/mtab-proof/`). Now a SharedWorker holds ONE `EventSource` to
 * `GET /api/sse?scope=hub`, each tab tells the worker what it wants to hear, and the worker adds
 * or removes those subscriptions on the server with `PATCH /api/sse`. Every event for every
 * subscription comes down the one stream wrapped with its subscription id, and the worker hands
 * it to the one tab that asked.
 *
 * This file is shared by the server (`$lib/server/sseLiveHub.ts`, `/api/sse`) and the browser
 * (`hubCore.ts`, the worker, the tab client), so the two sides cannot spell the frame
 * differently. It imports nothing.
 */

/**
 * A subscription id is made by the tab. Only these characters are allowed, so a wrapped frame
 * can carry the id without escaping and the worker can read it without parsing the event.
 */
export const HUB_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

/** At most this many changes in one `PATCH /api/sse`, and subscriptions on one hub. */
export const HUB_MAX_CHANGES_PER_REQUEST = 64
export const HUB_MAX_SUBSCRIPTIONS_PER_HUB = 256

/**
 * A send's turn id (`turn_<hex>`, made by the server's `turnOutcomeRegistry.ts`). Checked on
 * both sides, so a tab cannot ask the server about anything but a well-formed id.
 */
export const HUB_TURN_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

/**
 * What a tab can listen to: its user channel, one chat, or one of its own sends' turns. A
 * `turn` subscription (2026-09-18) carries a single `turn_over` event: the page's send is
 * answered once the server owns its turn (`Prefer: respond-async`), so it no longer holds one
 * of the browser's six connections for the whole reply, and it hears the turn's final answer here.
 */
export type HubSubscriptionRequest =
  | { id: string; scope: 'user' }
  | { id: string; scope: 'session'; sessionId: string }
  | { id: string; scope: 'turn'; turnId: string }

/**
 * The one event a `turn` subscription carries: the answer send-routed gave at the end of the
 * turn, exactly (`status`, `contentType`, and the `body` text), so the tab can rebuild the same
 * `Response` it used to read. A subscription added after the turn ended gets it at once.
 */
export type TurnOverEvent = {
  type: 'turn_over'
  turnId: string
  status: number
  contentType: string | null
  body: string
}

/** The body of `PATCH /api/sse`. Removals are applied before additions. */
export type HubSubscriptionChange = {
  hubId: string
  add?: HubSubscriptionRequest[]
  remove?: string[]
}

/** A subscription the server would not add, and why (`status` is the HTTP status it means). */
export type HubSubscriptionRefusal = { id: string; status: number; code: string }

/** The answer to `PATCH /api/sse` (status 200). */
export type HubSubscriptionChangeResult = {
  added: string[]
  removed: string[]
  refused: HubSubscriptionRefusal[]
}

/** The first frame on a hub stream, and the only one that is not wrapped. */
export type HubConnectedEvent = { type: 'hub_connected'; hubId: string }

const FRAME_PREFIX = '{"sub":"'
const FRAME_EVENT_KEY = '","event":'

/**
 * The `data:` text of one wrapped frame: `{"sub":"<id>","event":<the event's JSON>}`. The
 * event's JSON goes in as the exact text the listener was handed, never re-serialized.
 */
export function formatHubFrameData(subscriptionId: string, eventJson: string): string {
  return `${FRAME_PREFIX}${subscriptionId}${FRAME_EVENT_KEY}${eventJson}}`
}

/** The reverse of `formatHubFrameData`; `null` for any other text (the `hub_connected` frame). */
export function parseHubFrameData(
  data: string
): { subscriptionId: string; eventJson: string } | null {
  if (!data.startsWith(FRAME_PREFIX) || !data.endsWith('}')) return null
  const idEnd = data.indexOf(FRAME_EVENT_KEY, FRAME_PREFIX.length)
  if (idEnd < 0) return null
  const subscriptionId = data.slice(FRAME_PREFIX.length, idEnd)
  if (!HUB_SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) return null
  const eventJson = data.slice(idEnd + FRAME_EVENT_KEY.length, -1)
  return eventJson ? { subscriptionId, eventJson } : null
}

/**
 * Tab → hub. A tab re-sends its WHOLE list on every change and on a heartbeat, so a hub that
 * dropped a silent tab (frozen, crashed, suspended by the phone) takes it back on the next
 * message without a handshake.
 */
export type HubClientMessage =
  | { type: 'state'; clientId: string; subscriptions: HubSubscriptionRequest[] }
  | { type: 'bye'; clientId: string }

/** How a subscription stands, as the hub tells its tab. */
export type HubSubscriptionStatus =
  /** The server has added it; events flow. */
  | 'open'
  /** It was open and the live connection dropped; the hub is reconnecting and re-adds it. */
  | 'down'
  /** The server will not add it (a chat that is gone or not this user's). Not retried. */
  | 'refused'

/** Hub → tab. `data` is the event's JSON text exactly as the server wrote it. */
export type HubServerMessage =
  | { type: 'event'; id: string; data: string }
  | { type: 'status'; id: string; status: HubSubscriptionStatus; code?: string }
