/// <reference lib="webworker" />

/**
 * The SharedWorker that holds the browser's ONE live connection to Batshit (2026-09-18).
 *
 * Every Batshit tab of this browser connects here (one `MessagePort` each) and sends the whole
 * list of what it wants to hear; `HubCore` keeps one `EventSource` for all of them and hands each
 * event to the tab that asked. The browser keeps this worker alive while any tab is connected.
 * See `hubCore.ts` for the rules and `protocol.ts` for the messages.
 */

import { HubCore, type HubPortLike } from './hubCore'
import { createBrowserHubOptions } from './browserHub'
import type { HubClientMessage } from './protocol'

const scope = self as unknown as SharedWorkerGlobalScope
const core = new HubCore(createBrowserHubOptions())

// A tab that crashed, or that the browser froze or discarded, never says goodbye.
setInterval(() => core.sweep(), 60_000)

scope.addEventListener('connect', (event) => {
  const port = (event as MessageEvent).ports[0]
  if (!port) return
  const tab: HubPortLike = { postMessage: (message) => port.postMessage(message) }
  port.addEventListener('message', (message: MessageEvent<HubClientMessage>) => {
    core.receive(tab, message.data)
  })
  port.start()
})
