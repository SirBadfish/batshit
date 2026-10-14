import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { jsonResponse } from '$lib/test-utils/userSettingsRoute'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { listLocalAiServers, saveLocalAiServers } from '$lib/server/services/localAiServers'
import LocalAISettingsPanel from './LocalAISettingsPanel.svelte'

/**
 * BL-962: when `GET /api/settings/local-ai` failed, the Local AI panel put the built-in defaults
 * in editable cards and ended its load. The next edit posted EVERY server (address, path, image
 * transport, image address, switch) built from those defaults, and the route writes a whole record
 * per server it is sent, so every saved address and switch was erased (BL-487's class, BL-939's
 * pattern). Now only a successful read counts as a loaded copy: until then the server cards are
 * not offered at all, the panel says so in a plain sentence with a Retry, and a Retry that works
 * shows the saved servers and saves as before. A failed Reload after a good load keeps the copy
 * it had (it never swaps it for the defaults), and a "successful" answer that carries no server
 * list is not a read of the saved servers.
 *
 * Renders the REAL panel. `/api/settings/local-ai` goes to the REAL route handlers, which read and
 * write through the REAL service on the default lane's Redis fake, so every assertion below reads
 * what is STORED, not what the panel sent. (The shared `userSettingsRoute.ts` helper serves
 * `/api/user/settings`; this panel's record has its own route, so the small stub is local.)
 */

useRedisTestServer()

const USER = 'll962_user'
const SAVE_DEBOUNCE_PAST = 1200

type RouteModule = typeof import('../../../../routes/api/settings/local-ai/+server')
let route: RouteModule

beforeAll(async () => {
  route = await import('../../../../routes/api/settings/local-ai/+server')
}, 60_000)

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let posts: Array<{ body: Record<string, any> }> = []
let reads = 0
/** While set, a GET answers this status (a failed load). */
let failGetsWith: number | null = null
/** While set, a GET answers 200 with a body that carries no server list (a malformed answer). */
let answerGetsWithoutServers = false
/** While set, a GET reaches the REAL route with no signed-in user (the route answers 401). */
let answerGetsSignedOut = false
/** While set, a GET answers this status with a body that is not JSON (a proxy's page). */
let failGetsWithPageOf: number | null = null
/** While set, a GET waits for it (a slow load). */
let holdGets: Promise<void> | null = null

function installRoute() {
  failGetsWith = null
  answerGetsWithoutServers = false
  answerGetsSignedOut = false
  failGetsWithPageOf = null
  holdGets = null
  posts = []
  reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      const method = (init.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0]
      if (path === '/api/settings/local-ai') {
        if (method === 'GET') {
          reads += 1
          if (holdGets) await holdGets
          if (failGetsWith !== null) return jsonResponse({ success: false, error: 'Redis unavailable' }, failGetsWith)
          if (failGetsWithPageOf !== null) return new Response('<html>Bad gateway</html>', { status: failGetsWithPageOf })
          if (answerGetsWithoutServers) return jsonResponse({ success: true })
          if (answerGetsSignedOut) return (await route.GET({ locals: {} } as any)) as Response
          return (await route.GET({ locals: { user: { id: USER } } } as any)) as Response
        }
        if (method === 'POST') {
          posts.push({ body: JSON.parse(String(init.body)) })
          const routed = new Request(`http://localhost${path}`, { method, body: String(init.body) })
          return (await route.POST({ request: routed, locals: { user: { id: USER } } } as any)) as Response
        }
      }
      return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
    })
  )
}

/** Saved servers: every one differs from its default, so an erasure is visible. */
const SAVED_URLS = {
  ollama: 'http://192.168.1.20:11434',
  lmstudio: 'http://192.168.1.21:1234',
  'llama-cpp': 'http://192.168.1.22:8080'
}

async function seedStored() {
  await saveLocalAiServers(USER, [
    { id: 'ollama', baseUrl: SAVED_URLS.ollama, openaiPath: '/v1', enabled: true, imageTransport: 'url', imageBaseUrl: 'http://192.168.1.20:5600' },
    { id: 'lmstudio', baseUrl: SAVED_URLS.lmstudio, openaiPath: '/v1', enabled: true, imageTransport: 'auto', imageBaseUrl: 'http://192.168.1.21:5600' },
    { id: 'llama-cpp', baseUrl: SAVED_URLS['llama-cpp'], openaiPath: '/v1', enabled: true, imageTransport: 'auto', imageBaseUrl: 'http://192.168.1.22:5600' }
  ])
}

/** What is stored, read from the store and not from anything the panel holds. */
async function storedServers() {
  const list = await listLocalAiServers(USER)
  return list.map((server) => ({
    id: server.id,
    baseUrl: server.baseUrl,
    openaiPath: server.openaiPath,
    enabled: server.enabled,
    imageTransport: server.imageTransport,
    imageBaseUrl: server.imageBaseUrl,
    source: server.source
  }))
}

const storedServer = async (id: string) => (await storedServers()).find((server) => server.id === id)

const cardHeaderOf = (label: string) => screen.queryByText(label)?.closest('button') ?? null
const cardOf = (label: string) => cardHeaderOf(label)?.closest('.batshit-settings-l1-card') as HTMLElement | null

/** The user tries to change a setting: open the llama.cpp card, flip its Enabled switch. */
async function tryToChangeAServer() {
  const header = cardHeaderOf('llama.cpp')
  if (header) {
    await fireEvent.click(header)
    const enabled = cardOf('llama.cpp')?.querySelector('[role="switch"]')
    if (enabled) await fireEvent.click(enabled)
  }
  await pause(SAVE_DEBOUNCE_PAST)
}

async function openCard(label: string) {
  await fireEvent.click(cardHeaderOf(label) as HTMLElement)
}

const enabledSwitchOf = (label: string) =>
  cardOf(label)?.querySelector('[role="switch"]') as HTMLElement | null

function baseUrlInputOf(label: string) {
  const row = within(cardOf(label) as HTMLElement).getByText('Base URL').closest('.batshit-settings-form-row')
  return (row as HTMLElement).querySelector('input') as HTMLInputElement
}

const renderPanel = () => render(LocalAISettingsPanel, { props: { data: { user: { id: USER }, userSettings: null } } })

describe('Local AI settings never turns a failed load into a save (BL-962)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    stopFailingRedisJsonGets()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('the load fails and the user tries an edit: no write leaves and the stored servers are unchanged', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    failGetsWith = 500
    renderPanel()
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    // The load has ended (failed): the loading line is gone.
    await waitFor(() => expect(screen.queryByText('Loading local AI settings...')).toBeNull(), { timeout: 10_000 })

    await tryToChangeAServer()

    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)
    // The panel says so in a plain sentence, with a Retry, and offers no card that looks saved.
    const notice = screen.getByTestId('local-ai-load-error')
    expect(within(notice).getByText(/Local AI servers could not load, so the server cards are hidden/)).toBeTruthy()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(cardHeaderOf('llama.cpp')).toBeNull()
    expect(cardHeaderOf('Ollama')).toBeNull()
  }, 60_000)

  // A guard: the parent code already hid the cards and held the autosave while the read travelled.
  it('regression guard, not a proof of a fix (green on the parent code too): a slow load: an edit before it landed writes nothing, and after it landed the cards show the saved servers', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    let release: () => void = () => {}
    holdGets = new Promise<void>((resolve) => {
      release = resolve
    })
    renderPanel()
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    await tryToChangeAServer()
    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)
    expect(screen.getByText('Loading local AI settings...')).toBeTruthy()
    expect(cardHeaderOf('llama.cpp')).toBeNull()

    holdGets = null
    release()
    await waitFor(() => expect(cardHeaderOf('llama.cpp')).not.toBeNull(), { timeout: 10_000 })
    await openCard('llama.cpp')
    expect(baseUrlInputOf('llama.cpp').value).toBe(SAVED_URLS['llama-cpp'])
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)
  }, 60_000)

  it('the load fails and Retry works: the cards show the saved servers, one edit saves, and every other saved value stays', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    failGetsWith = 500
    renderPanel()
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    const notice = await screen.findByTestId('local-ai-load-error')

    // A Retry that fails again changes nothing: the notice stays, and nothing is written.
    const readsBefore = reads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await screen.findByTestId('local-ai-load-error')
    await pause(300)
    expect(cardHeaderOf('llama.cpp')).toBeNull()
    expect(posts).toEqual([])

    // A Retry that works clears the notice and shows what is saved.
    failGetsWith = null
    await fireEvent.click(
      within(screen.getByTestId('local-ai-load-error')).getByRole('button', { name: /Retry/ })
    )
    await waitFor(() => expect(cardHeaderOf('llama.cpp')).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('local-ai-load-error')).toBeNull()
    expect(screen.queryByText(/Redis unavailable/)).toBeNull()
    await openCard('llama.cpp')
    expect(baseUrlInputOf('llama.cpp').value).toBe(SAVED_URLS['llama-cpp'])
    expect(enabledSwitchOf('llama.cpp')?.getAttribute('aria-checked')).toBe('true')
    await openCard('LM Studio')
    expect(baseUrlInputOf('LM Studio').value).toBe(SAVED_URLS.lmstudio)
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)

    // One edit saves that one change; every other saved server keeps its saved values, and the
    // body carries the saved addresses, never the defaults.
    await fireEvent.click(enabledSwitchOf('llama.cpp') as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    const sent = posts[0].body.servers as Array<Record<string, any>>
    expect(sent.find((server) => server.id === 'lmstudio')?.baseUrl).toBe(SAVED_URLS.lmstudio)
    expect(sent.find((server) => server.id === 'ollama')?.baseUrl).toBe(SAVED_URLS.ollama)
    expect(await storedServer('llama-cpp')).toMatchObject({ baseUrl: SAVED_URLS['llama-cpp'], enabled: false })
    expect(await storedServer('lmstudio')).toEqual(before.find((server) => server.id === 'lmstudio'))
    expect(await storedServer('ollama')).toEqual(before.find((server) => server.id === 'ollama'))
  }, 60_000)

  it('a Reload that fails after a good load keeps the servers it had (never the defaults), and the next edit sends them', async () => {
    await seedStored()
    installRoute()
    renderPanel()
    await waitFor(() => expect(cardHeaderOf('LM Studio')).not.toBeNull(), { timeout: 10_000 })
    await openCard('LM Studio')
    expect(baseUrlInputOf('LM Studio').value).toBe(SAVED_URLS.lmstudio)

    // The user presses Reload and the read fails.
    failGetsWith = 500
    const readsBefore = reads
    await fireEvent.click(within(cardOf('LM Studio') as HTMLElement).getByRole('button', { name: /Reload/ }))
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    expect((await screen.findAllByText(/Redis unavailable/)).length).toBeGreaterThan(0)
    // The copy it had stays: the card still shows the saved address, not the built-in default.
    await waitFor(() => expect(cardHeaderOf('LM Studio')).not.toBeNull(), { timeout: 10_000 })
    await openCard('LM Studio')
    expect(baseUrlInputOf('LM Studio').value).toBe(SAVED_URLS.lmstudio)
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    // The next edit still sends the loaded servers.
    await fireEvent.click(enabledSwitchOf('LM Studio') as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    const sent = posts[0].body.servers as Array<Record<string, any>>
    expect(sent.find((server) => server.id === 'ollama')?.baseUrl).toBe(SAVED_URLS.ollama)
    expect(sent.find((server) => server.id === 'llama-cpp')?.baseUrl).toBe(SAVED_URLS['llama-cpp'])
    expect((await storedServer('ollama'))?.baseUrl).toBe(SAVED_URLS.ollama)
    expect((await storedServer('llama-cpp'))?.baseUrl).toBe(SAVED_URLS['llama-cpp'])
    expect(await storedServer('lmstudio')).toMatchObject({ baseUrl: SAVED_URLS.lmstudio, enabled: false })
  }, 60_000)

  // BL-977: the read fails INSIDE the real route (its Redis read), not at the fetch stub. The list used
  // to catch it and answer 200 with the eight defaults, which the panel counted as a good read.
  it('the REAL route\'s Redis read fails (every record): the route answers an error, the notice shows with a Retry, an edit attempt writes nothing, and Retry shows the saved servers', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    const failing = failRedisJsonGets((key) => key.startsWith(`local_provider:${USER}:`))
    renderPanel()
    const notice = await screen.findByTestId('local-ai-load-error')
    expect(failing.failures).toBeGreaterThanOrEqual(1)
    expect(within(notice).getByText(/Local AI servers could not load, so the server cards are hidden/)).toBeTruthy()
    // The route's own sentence is the panel's plain sentence, so no Details line repeats it.
    expect(within(notice).queryByText(/Details:/)).toBeNull()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(cardHeaderOf('llama.cpp')).toBeNull()
    expect(cardHeaderOf('Ollama')).toBeNull()

    await tryToChangeAServer()
    expect(posts).toEqual([])
    failing.stop()
    expect(await storedServers()).toEqual(before)

    await fireEvent.click(within(screen.getByTestId('local-ai-load-error')).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(cardHeaderOf('LM Studio')).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('local-ai-load-error')).toBeNull()
    await openCard('LM Studio')
    expect(baseUrlInputOf('LM Studio').value).toBe(SAVED_URLS.lmstudio)
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)
  }, 60_000)

  it('the REAL route\'s Redis read fails for ONE record: the same notice, and the saved address of that server is not written over', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    const failing = failRedisJsonGets((key) => key === `local_provider:${USER}:lmstudio`)
    renderPanel()
    await screen.findByTestId('local-ai-load-error')
    expect(cardHeaderOf('LM Studio')).toBeNull()
    expect(cardHeaderOf('Ollama')).toBeNull()

    await tryToChangeAServer()
    expect(posts).toEqual([])
    failing.stop()
    expect(await storedServers()).toEqual(before)
    expect((await storedServer('lmstudio'))?.baseUrl).toBe(SAVED_URLS.lmstudio)
  }, 60_000)

  it('the notice carries the route\'s own message in Details (a failed read with an error text)', async () => {
    await seedStored()
    installRoute()
    failGetsWith = 500
    renderPanel()
    const notice = await screen.findByTestId('local-ai-load-error')
    expect(within(notice).getByText(/Details: Redis unavailable/)).toBeTruthy()
    expect(within(notice).getByText(/Local AI servers could not load, so the server cards are hidden/)).toBeTruthy()
  }, 60_000)

  it('the notice carries the message of the REAL route when nobody is signed in (401 Unauthorized)', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    answerGetsSignedOut = true
    renderPanel()
    const notice = await screen.findByTestId('local-ai-load-error')
    expect(within(notice).getByText(/Details: Unauthorized/)).toBeTruthy()
    await tryToChangeAServer()
    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): an answer that is not JSON falls back to the plain sentence, with no Details', async () => {
    await seedStored()
    installRoute()
    failGetsWithPageOf = 502
    renderPanel()
    const notice = await screen.findByTestId('local-ai-load-error')
    expect(within(notice).getByText(/Local AI servers could not load, so the server cards are hidden/)).toBeTruthy()
    expect(within(notice).queryByText(/Details:/)).toBeNull()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
  }, 60_000)

  it('an answer that carries no server list is not a read of the saved servers: the notice shows and nothing is written', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    answerGetsWithoutServers = true
    renderPanel()
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    await tryToChangeAServer()

    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)
    expect(screen.getByTestId('local-ai-load-error')).toBeTruthy()
    expect(cardHeaderOf('llama.cpp')).toBeNull()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal edit saves as before', async () => {
    await seedStored()
    const before = await storedServers()
    installRoute()
    renderPanel()
    await waitFor(() => expect(cardHeaderOf('llama.cpp')).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('local-ai-load-error')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedServers()).toEqual(before)

    await openCard('llama.cpp')
    expect(enabledSwitchOf('llama.cpp')?.getAttribute('aria-checked')).toBe('true')
    await fireEvent.click(enabledSwitchOf('llama.cpp') as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedServer('llama-cpp')).toMatchObject({ baseUrl: SAVED_URLS['llama-cpp'], enabled: false })
    expect(await storedServer('lmstudio')).toEqual(before.find((server) => server.id === 'lmstudio'))
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a user with no saved servers yet opens Local AI, and the first edit saves the defaults plus that edit', async () => {
    installRoute()
    renderPanel()
    await waitFor(() => expect(cardHeaderOf('llama.cpp')).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('local-ai-load-error')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await openCard('llama.cpp')
    expect(enabledSwitchOf('llama.cpp')?.getAttribute('aria-checked')).toBe('false')
    await fireEvent.click(enabledSwitchOf('llama.cpp') as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(await storedServer('llama-cpp')).toMatchObject({ baseUrl: 'http://localhost:8080', enabled: true, source: 'stored' })
    expect((await storedServer('ollama'))?.baseUrl).toBe('http://localhost:11434')
  }, 60_000)
})
