import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'
import * as savedModelsStore from '$lib/stores/savedModels.svelte'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import ModelSelector from './ModelSelector.svelte'

/**
 * BL-977 companion: the chat bar's model picker asked `GET /api/models?include=connections` from a
 * mount `$effect` that also read and wrote the states its own fetch flips
 * (`connectionOptionsLoading`, `connectionOptions`). A GOOD answer set the options and stopped it;
 * a FAILED one (any 500) left `connectionOptions` null and the flip of `connectionOptionsLoading`
 * back to false ran the effect again at once, forever (measured: about 250 requests a second).
 *
 * Now the mount effect runs the load once per mount and a failed load does not retry by itself.
 * Two things ask again: the explicit reload (`modelConnectionsUpdated`), and the USER opening the
 * menu while the last load failed (one retry per open, so the menu recovers when the answer is
 * good again without a reload).
 *
 * Renders the REAL component. The loop is in the client, so no route handler is involved: `fetch`
 * is a stub that answers after a macrotask, the way a network does (an answer made only of
 * microtasks would starve the test's own timers and hang instead of failing).
 */

const CONNECTIONS_URL = '/api/models?include=connections'
const ERROR_TEXT = 'Failed to load model connections (500)'
const LOADING_TEXT = 'Loading connection status…'
const PROBE_MODEL_NAME = 'Probe Model'
/** A saved chat preset on OpenRouter: the picker locks it when the connection list says so. */
const PROBE_MODEL = {
  id: 'probe-model',
  modelId: 'probe/model',
  modelName: PROBE_MODEL_NAME,
  provider: 'openai',
  purpose: 'chat',
  connection: { type: 'openrouter' }
}
/** A good answer that says the model's connection is locked: loading it shows in the menu item. */
const LOCKED_CONNECTIONS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    transport: 'openrouter',
    status: 'locked',
    lockedReason: 'Missing API key (probe)'
  }
]

let connectionsAnswer: 'fail' | 'ok' = 'fail'
let connectionCalls = 0
let savedModels: unknown[] = []
let unroutedUrls: string[] = []
const originalFetch = global.fetch

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function answer(payload: unknown, status = 200) {
  return new Promise<Response>((resolve) => {
    setTimeout(
      () =>
        resolve(
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json' }
          })
        ),
      2
    )
  })
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      if (url === CONNECTIONS_URL) {
        connectionCalls += 1
        return connectionsAnswer === 'fail'
          ? answer({ success: false, error: 'x' }, 500)
          : answer({ data: { connections: LOCKED_CONNECTIONS } })
      }
      // The saved models the picker loads on mount. Any other URL is loud (a 404 the first test
      // asserts never happened), so a new request cannot slip in unseen.
      if (url === '/api/user/saved-models') return answer({ models: savedModels })
      unroutedUrls.push(url)
      return answer({ error: `not routed in this test: ${url}` }, 404)
    })
  )
}

beforeEach(() => {
  connectionsAnswer = 'fail'
  connectionCalls = 0
  savedModels = []
  unroutedUrls = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  installFetch()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
  savedModelsStore.setSavedModels([])
})

function trigger() {
  return screen.getByTestId('model-selector')
}

async function openMenu() {
  await fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
}

async function closeMenu() {
  // The popper stays `visibility: hidden` in jsdom (no layout): found hidden.
  const menu = await screen.findByRole('menu', { hidden: true })
  await fireEvent.keyDown(menu, { key: 'Escape' })
  await waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'), { timeout: 5_000 })
}

function probeModelItem() {
  return screen.getByText(PROBE_MODEL_NAME).closest('[role="menuitem"]') as HTMLElement
}

describe('ModelSelector asks for the connection status once per mount (BL-977 companion)', () => {
  it('a failed answer is not retried by itself: the mount asks once and nothing more', async () => {
    render(ModelSelector, { props: {} })
    await pause(600)

    // Old code: the failed answer re-ran the mount effect, hundreds of requests in this window.
    expect(connectionCalls).toBe(1)
    await pause(600)
    expect(connectionCalls).toBe(1)
    expect(unroutedUrls).toEqual([])
  }, 30_000)

  it('opening the menu after a failed answer asks once more, shows the error text if it fails again, and stops there', async () => {
    render(ModelSelector, { props: {} })
    await pause(600)
    expect(connectionCalls).toBe(1)

    await openMenu()
    // The user-driven retry: one request for this open (old loop: hundreds).
    await waitFor(() => expect(connectionCalls).toBe(2), { timeout: 5_000 })
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy()

    await pause(600)
    expect(connectionCalls).toBe(2)
  }, 30_000)

  it('opening the menu after a failed answer recovers: the good answer clears the error, loads the options, and a second open asks nothing', async () => {
    savedModels = [PROBE_MODEL]
    render(ModelSelector, { props: {} })
    await pause(600)
    expect(connectionCalls).toBe(1)

    // The answer is good again (a Local AI record repaired, the server back): no event, no reload.
    connectionsAnswer = 'ok'
    await openMenu()
    await waitFor(() => expect(connectionCalls).toBe(2), { timeout: 5_000 })
    await waitFor(() => expect(screen.queryByText(ERROR_TEXT)).toBeNull(), { timeout: 5_000 })
    await waitFor(() => expect(screen.queryByText(LOADING_TEXT)).toBeNull(), { timeout: 5_000 })
    // The options loaded: the saved model's OpenRouter connection is locked in them.
    await waitFor(() => expect(probeModelItem().getAttribute('aria-disabled')).toBe('true'), { timeout: 5_000 })

    // A second open in a good state makes no call.
    await closeMenu()
    await openMenu()
    await screen.findByText(PROBE_MODEL_NAME)
    await pause(600)
    expect(connectionCalls).toBe(2)
    expect(unroutedUrls).toEqual([])
  }, 30_000)

  it('the explicit reload (modelConnectionsUpdated) asks again once and a good answer clears the error text', async () => {
    render(ModelSelector, { props: {} })
    await pause(600)
    expect(connectionCalls).toBe(1)
    await openMenu()
    await waitFor(() => expect(connectionCalls).toBe(2), { timeout: 5_000 })
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy()

    connectionsAnswer = 'ok'
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, { detail: { source: 'local-ai' } }))

    await waitFor(() => expect(screen.queryByText(ERROR_TEXT)).toBeNull(), { timeout: 5_000 })
    await pause(600)
    // One more, from the event: not a loop, and not zero.
    expect(connectionCalls).toBe(3)
  }, 30_000)

  it('the explicit reload while the answer fails again shows the error text again and stops after that one request', async () => {
    render(ModelSelector, { props: {} })
    await pause(600)
    expect(connectionCalls).toBe(1)

    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, { detail: { source: 'local-ai' } }))
    await pause(600)

    // Old code: the event cleared `connectionOptions` and the effect looped on the next failure too.
    expect(connectionCalls).toBe(2)
    await openMenu()
    // The open retries once (the last load failed): 3, and the error text is there.
    await waitFor(() => expect(connectionCalls).toBe(3), { timeout: 5_000 })
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy()
    await pause(600)
    expect(connectionCalls).toBe(3)
  }, 30_000)
})
