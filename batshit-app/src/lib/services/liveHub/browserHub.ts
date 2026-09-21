/**
 * The browser bindings for `HubCore`: the real `EventSource` and `fetch`. Shared by the
 * SharedWorker (`liveHub.worker.ts`) and the in-tab hub a browser without SharedWorker uses
 * (`liveHubClient.ts`), so both run the same hub against the same two URLs.
 */

import type { HubCoreOptions } from './hubCore'

/** The browser's one live stream (`/api/sse` GET, `scope=hub`). */
export const LIVE_HUB_STREAM_URL = '/api/sse?scope=hub'
/** Where the hub adds and removes subscriptions (`/api/sse` PATCH). */
export const LIVE_HUB_CHANGE_URL = '/api/sse'

export function createBrowserHubOptions(): HubCoreOptions {
  return {
    openStream: (handlers) => {
      const source = new EventSource(LIVE_HUB_STREAM_URL)
      source.onmessage = (event) => handlers.onMessage(event.data)
      source.onerror = () => handlers.onError()
      return { readyState: () => source.readyState, close: () => source.close() }
    },
    patch: async (change) => {
      const response = await fetch(LIVE_HUB_CHANGE_URL, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
        credentials: 'same-origin',
        cache: 'no-store'
      })
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { status: response.status, body }
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    warn: (...args) => console.warn(...args)
  }
}
