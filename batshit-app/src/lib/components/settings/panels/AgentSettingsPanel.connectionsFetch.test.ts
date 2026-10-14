import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import {
  installAgentRoutes,
  jsonResponse,
  loadAgentRoute,
  storedAgent
} from '$lib/test-utils/agentPutRoute'

/**
 * BL-977 companion: Agent Settings asked `GET /api/models?include=connections` from an `$effect`
 * that also read and wrote the states its own fetch flips (`modelConnectionOptionsLoading`,
 * `modelConnectionOptions`, `modelConnectionOptionsLoadedForAgentType`). A GOOD answer set the
 * options and stopped it; a FAILED one (any 500) left the options null and the flip of the loading
 * state back to false ran the effect again at once, forever (measured: about 250 requests a second).
 *
 * Now the effect depends only on the agent type (through a `$derived`, so a rewrite of the whole
 * form that keeps the type is not a trigger) and runs the load untracked: a failed load shows its
 * error text and does not retry by itself; a different Primary Agent type asks again once; the
 * explicit reloads (Local AI saved, the refresh of the model picker's data) stay as they were.
 *
 * Renders the REAL panel. The loop is in the client, so the connections URL is a stub that answers
 * after a macrotask, the way a network does (an answer made only of microtasks would starve the
 * test's own timers and hang instead of failing); `/api/agents/<id>` goes to the REAL route handler
 * on the default lane's Redis fake, as in `AgentSettingsPanel.codexClampOnOpen.test.ts`.
 */

vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles: vi.fn(async () => {}),
  deleteAgentCodexConfig: vi.fn(async () => {}),
  buildAgentProfileId: (id: string) => `batshit_agent_${id}`
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'ss977c_user'
const AGENT = 'ss977c_agent'
const NAME = 'Connections probe (Codex)'
const OTHER = 'ss977c_other'
const OTHER_NAME = 'Connections probe (API)'
const CONNECTIONS_URL = '/api/models?include=connections'
// The route's own error text: the panel shows what the answer says (`extractError`).
const ERROR_TEXT = 'Connections unreadable (probe)'

const CODEX_BASE = {
  permissionMode: 'chat',
  includeProjectInstructions: true,
  model: 'gpt-6-astra',
  streamingEffect: true,
  unifiedExec: true,
  search: true,
  sandbox: 'read-only',
  approval: 'never',
  configScope: 'managed',
  addDirs: [] as string[],
  enableFeatures: [] as string[],
  disableFeatures: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project',
  historyPersistence: 'none'
}

function ensureBrowserStubs() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.hasPointerCapture !== 'function') {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => {} })
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => {} })
  }
}

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let connectionCalls = 0
let connectionsAnswer: 'fail' | 'ok' = 'fail'
let agentReads = 0
let rendered: ReturnType<typeof render> | null = null
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
}, 60_000)

afterAll(() => {
  global.fetch = originalFetch
})

beforeEach(() => {
  ensureBrowserStubs()
  connectionCalls = 0
  connectionsAnswer = 'fail'
  agentReads = 0
  rendered = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A correct mount makes up to THREE requests: the default form's type (API) asks when the panel
 * mounts, `onMount`'s `refreshModelPickerData` asks with `force`, and the agent's own type (CLI)
 * asks when the agent's record lands. Which of them merge into one depends on timing, so the tests
 * never rely on the exact number of a mount: they wait until the loading has settled, bound it
 * here, and then assert what the count does from that point on. The old loop sent hundreds.
 */
const MOUNT_REQUESTS_AT_MOST = 3

/**
 * Waits until the connections URL has not been asked for during a whole 600 ms window, and gives
 * the count then. A loop never settles: the wait is capped, and the count it returns is huge.
 */
async function settledConnectionCalls() {
  let last = connectionCalls
  for (let round = 0; round < 10; round += 1) {
    await pause(600)
    if (connectionCalls === last) return last
    last = connectionCalls
  }
  return last
}

function connectionsAnswerAfterMacrotask() {
  return new Promise<Response>((resolve) => {
    setTimeout(
      () =>
        resolve(
          connectionsAnswer === 'fail'
            ? jsonResponse({ success: false, error: ERROR_TEXT }, 500)
            : jsonResponse({ data: { connections: [] } })
        ),
      2
    )
  })
}

/**
 * Creates the Codex agent (a managed CLI type) and an API agent (another managed type), installs
 * the routes, and renders the panel on the Codex agent past the autosave debounces.
 */
async function openPanel() {
  await redis.createAgent({
    id: OTHER,
    user_id: USER,
    displayName: OTHER_NAME,
    agentType: 'api'
  } as any)
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: NAME,
    agentType: 'cli',
    primary_model_provider: 'codex',
    primary_model_name: 'gpt-6-astra',
    primary_model_connection: { type: 'cli', service: 'codex' },
    codex_settings: CODEX_BASE
  } as any)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    extra: async (path, method, init) => {
      if (path === `/api/agents/${OTHER}`) {
        const request = new Request(`http://localhost${path}`, {
          method,
          body: method === 'PUT' ? String(init.body) : undefined
        })
        const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
        return (await handler({ params: { id: OTHER }, request, locals: { user: { id: USER } } } as any)) as Response
      }
      if (path === '/api/agents' && method === 'GET') {
        return jsonResponse({ agents: [await storedAgent(AGENT), await storedAgent(OTHER)] })
      }
      if (path === `/api/agents/${AGENT}/subagents` || path === `/api/agents/${OTHER}/subagents`) {
        return jsonResponse({ subagents: [] })
      }
      if (path === '/api/subagents' && method === 'GET') return jsonResponse({ subagents: [] })
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
      if (path === '/api/goons') return jsonResponse({ goons: [] })
      if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
      return undefined
    }
  })
  // The connections URL is answered here, ahead of the routes, so only the EXACT url is counted and
  // failed (a `/api/models` without the query, if any request asked for it, is not).
  const routed = global.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      if (url === CONNECTIONS_URL) {
        connectionCalls += 1
        return connectionsAnswerAfterMacrotask()
      }
      if (url === `/api/agents/${AGENT}` && (init?.method ?? 'GET').toUpperCase() === 'GET') agentReads += 1
      return routed(request as any, init)
    })
  )
  rendered = render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue(NAME, {}, { timeout: 15_000 })
  // Past the autosave debounces and until the loading has settled: what a mount asks is bounded
  // (old code: hundreds, and the wait gives up at its cap with that count).
  await settledConnectionCalls()
  expect(connectionCalls).toBeGreaterThanOrEqual(1)
  expect(connectionCalls).toBeLessThanOrEqual(MOUNT_REQUESTS_AT_MOST)
  return routes
}

function nameInput() {
  return document.getElementById('agent-display') as HTMLInputElement
}

async function switchTo(name: string) {
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents', hidden: true })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(name, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
}

describe('Agent Settings asks for the connection status only when the agent type asks for it (BL-977 companion)', () => {
  it('a failed answer shows its error text and does not ask again by itself', async () => {
    await openPanel()

    // The mount is bounded and settled (`openPanel`); the failed answer shows its error text, and
    // the count does not grow while nothing asks.
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy()

    const settled = connectionCalls
    await pause(600)
    expect(connectionCalls).toBe(settled)
  }, 90_000)

  it('another agent of another managed type asks once, and its failed answer stops there', async () => {
    await openPanel()
    const before = connectionCalls

    await switchTo(OTHER_NAME)
    await waitFor(() => expect(nameInput().value).toBe(OTHER_NAME), { timeout: 15_000 })
    const after = await settledConnectionCalls()

    // One more request for the new type (old code: hundreds more).
    expect(after).toBe(before + 1)
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy()
  }, 90_000)

  it('the shown agent read again (the whole form rewritten, the type unchanged) does not ask again: only the type is a trigger', async () => {
    await openPanel()
    const before = connectionCalls

    // The `initialAgentId` prop goes away and back: `hydrateAgent` reads the same agent again and,
    // at rest, puts it over the form (`basicForm = ...`, a new object with the same type). A failed
    // load must not be retried by that rewrite (an effect that read `basicForm.agentType` directly
    // ran again on every one).
    const readsBefore = agentReads
    await rendered!.rerender({ initialAgentId: null })
    await rendered!.rerender({ initialAgentId: AGENT })
    await waitFor(() => expect(agentReads).toBeGreaterThan(readsBefore), { timeout: 8_000 })

    expect(await settledConnectionCalls()).toBe(before)
  }, 90_000)

  it('the explicit reload of the model picker data still asks again, once', async () => {
    await openPanel()
    const before = connectionCalls

    // The Local AI saved event: `handleLocalAiSettingsUpdated` reloads with `force: true`.
    connectionsAnswer = 'ok'
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.localAiSettingsUpdated))

    expect(await settledConnectionCalls()).toBe(before + 1)
    await waitFor(() => expect(screen.queryByText(ERROR_TEXT)).toBeNull(), { timeout: 5_000 })
  }, 90_000)
})
