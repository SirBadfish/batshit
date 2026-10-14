import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { jsonResponse } from '$lib/test-utils/userSettingsRoute'
import { redis } from '$lib/server/redis'
import { MEMORY_CONFIG_KEY } from '$lib/server/services/memory/memoryKeys'
import { MEMORY_SCHEMA_VERSION } from '$lib/server/services/memory/memoryTypes'
import MemorySettingsPanel from './MemorySettingsPanel.svelte'

/**
 * BL-962 (the class of BL-939 and BL-487): the Memory panel's embedding source comes from
 * `GET /api/memory/config` (the instance-wide record `batshit:memory_config`, not the user
 * settings). When that read failed, the panel kept a DEFAULT draft (the built-in model) in a
 * fully editable Memory System card, and "Save Memory System" sent `PUT /api/memory/config` with
 * that draft, which replaces the whole embedding record: a saved preset or Local AI lane (its
 * base URL, model, prefixes, dimensions, key) was overwritten, and the built index no longer
 * matched the saved model. Now only a successful read that carried the embedding settings counts
 * as loaded (`configLoaded`, latched by the first one): until then the Memory System card is not
 * offered, the panel says so in a plain sentence with a Retry, and nothing is sent.
 *
 * Renders the REAL panel. `/api/memory/config` goes to the REAL route handlers on the default
 * lane's Redis fake, so every assertion reads what is STORED, not what the panel sent. The
 * agent list answers empty, so the browse half of the panel stays out of the way.
 */

useRedisTestServer()

const USER = 'ss962_memory_user'
const NOTICE = 'memory-config-load-error'
const CONFIG_ROUTE = '/api/memory/config'

/** A saved Local AI lane: every field differs from the built-in default, so an overwrite is visible. */
const SAVED_LOCAL_AI = {
  lane: 'local-ai',
  modelId: 'local-ai:nomic-embed-text',
  localAi: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'nomic-embed-text',
    dims: 768,
    apiKey: 'saved-secret-key',
    documentPrefix: 'search_document: ',
    queryPrefix: 'search_query: '
  }
}
/** A saved preset lane. */
const SAVED_PRESET = {
  lane: 'preset',
  modelId: 'preset:openai:text-embedding-3-small',
  preset: {
    presetId: 'preset_embed_saved',
    provider: 'openai',
    modelName: 'text-embedding-3-small',
    dims: 1536,
    documentPrefix: '',
    queryPrefix: ''
  }
}
const DEFAULT_EMBEDDING = { lane: 'builtin', modelId: 'builtin:embeddinggemma-300m' }

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

type ConfigRoute = typeof import('../../../../routes/api/memory/config/+server')
let route: ConfigRoute

beforeAll(async () => {
  route = await import('../../../../routes/api/memory/config/+server')
}, 60_000)

/** Every `PUT /api/memory/config` body the browser sent, in order. */
let puts: Array<{ body: Record<string, any> }> = []
let configReads = 0
/** While set, a config GET answers this status (a failed load). */
let failGetsWith: number | null = null
/** While set, a config GET answers 200 with this body instead of reading (a read without the embedding). */
let answerGetsWith: unknown | null = null
/** While set, a config GET waits for it (a slow load). */
let holdGets: Promise<void> | null = null

/**
 * A browser's view of the routes this panel loads: `/api/memory/config` goes to the REAL route
 * handlers; the agent list answers empty and the preset list answers with the saved preset.
 */
function installRoutes() {
  puts = []
  configReads = 0
  failGetsWith = null
  answerGetsWith = null
  holdGets = null
  const locals = { user: { id: USER } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      const method = (init.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0]

      if (path === CONFIG_ROUTE) {
        if (method === 'GET') {
          configReads += 1
          if (holdGets) await holdGets
          if (failGetsWith !== null) return jsonResponse({ error: 'Redis unavailable' }, failGetsWith)
          if (answerGetsWith !== null) return jsonResponse(answerGetsWith)
          return (await route.GET({ locals } as any)) as Response
        }
        if (method === 'PUT') {
          puts.push({ body: JSON.parse(String(init.body)) })
          const routed = new Request(`http://localhost${path}`, { method, body: String(init.body) })
          return (await route.PUT({ request: routed, locals } as any)) as Response
        }
      }
      if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [] })
      if (path === '/api/user/saved-models' && method === 'GET') {
        return jsonResponse({
          models: [
            {
              id: 'preset_embed_saved',
              modelId: 'text-embedding-3-small',
              modelName: 'text-embedding-3-small',
              provider: 'openai',
              purpose: 'utility'
            }
          ]
        })
      }
      return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
    })
  )
}

async function seedStored(embedding: Record<string, unknown>) {
  await redis.json.set(MEMORY_CONFIG_KEY, '$', { embedding, schema_version: MEMORY_SCHEMA_VERSION })
}

/** The stored record, read from the store and not from anything the panel holds. */
async function storedConfig() {
  return (await redis.json.get(MEMORY_CONFIG_KEY)) as Record<string, any> | null
}

const SAVED_LOCAL_AI_RECORD = () => ({ embedding: SAVED_LOCAL_AI, schema_version: MEMORY_SCHEMA_VERSION })
const SAVED_PRESET_RECORD = () => ({ embedding: SAVED_PRESET, schema_version: MEMORY_SCHEMA_VERSION })

function renderPanel() {
  return render(MemorySettingsPanel)
}

const loadingLine = () => screen.queryByText('Loading memory...')
const saveButton = () => screen.queryByText('Save Memory System')
const reindexButton = () => screen.queryByText('Re-Index Memories')
const baseUrlInput = () =>
  screen.queryByPlaceholderText('Base URL (e.g. http://127.0.0.1:11434/v1)') as HTMLInputElement | null

async function waitForReadAndLoadingLineGone() {
  await waitFor(() => expect(configReads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
  await waitFor(() => expect(loadingLine()).toBeNull(), { timeout: 10_000 })
}

/** The user tries to save the Memory System card: whatever the panel offers, press it. */
async function tryToPressSave() {
  const button = saveButton()
  if (button) await fireEvent.click(button)
  await pause(400)
}

describe('Memory Settings never turns a failed load into a save (BL-962)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('the load fails and the user presses Save: nothing is sent and the saved preset lane is still stored', async () => {
    await seedStored(SAVED_PRESET)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForReadAndLoadingLineGone()

    await tryToPressSave()

    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_PRESET_RECORD())
    // The panel says so in a plain sentence, with a Retry, and offers no field that looks saved.
    const notice = screen.getByTestId(NOTICE)
    expect(
      within(notice).getByText(
        /Memory System settings could not load, so the Memory System card is hidden\. Press Retry to load it\./
      )
    ).toBeTruthy()
    expect(within(notice).getByText(/Failed to load memory config \(HTTP 500\)/)).toBeTruthy()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(saveButton()).toBeNull()
    expect(reindexButton()).toBeNull()
    expect(screen.queryByText('Embedding Source')).toBeNull()
    // The rest of the panel is unchanged: the agent browse half still answers on its own.
    expect(screen.getByText('No agents yet. Create an agent first.')).toBeTruthy()
  }, 60_000)

  it('the load fails and the user presses Save on a saved Local AI lane: the lane, its URL and its key stay stored', async () => {
    await seedStored(SAVED_LOCAL_AI)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForReadAndLoadingLineGone()

    await tryToPressSave()

    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
    expect(baseUrlInput()).toBeNull()
  }, 60_000)

  it('the read answers 200 without the embedding settings: it does not count as loaded, and nothing is sent', async () => {
    await seedStored(SAVED_PRESET)
    installRoutes()
    answerGetsWith = { indexMeta: null }
    renderPanel()
    await waitForReadAndLoadingLineGone()

    await tryToPressSave()

    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_PRESET_RECORD())
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
    expect(saveButton()).toBeNull()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a slow load shows a loading line and nothing to save, and the card shows the saved lane once it landed', async () => {
    await seedStored(SAVED_LOCAL_AI)
    installRoutes()
    let release: () => void = () => {}
    holdGets = new Promise<void>((resolve) => {
      release = resolve
    })
    renderPanel()
    await waitFor(() => expect(configReads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    await tryToPressSave()
    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())
    // Not editable until the load landed: the card is not there, a plain line stands in.
    expect(loadingLine()).toBeTruthy()
    expect(saveButton()).toBeNull()

    holdGets = null
    release()
    await waitFor(() => expect(baseUrlInput()).not.toBeNull(), { timeout: 10_000 })
    expect(loadingLine()).toBeNull()
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(baseUrlInput()?.value).toBe('http://127.0.0.1:11434/v1')
    await pause(400)

    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())
  }, 60_000)

  it('the load fails and Retry works: the card shows the saved lane, one Save keeps every saved value, and the key stays', async () => {
    await seedStored(SAVED_LOCAL_AI)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForReadAndLoadingLineGone()
    const notice = await screen.findByTestId(NOTICE)

    // A Retry that fails again changes nothing: the notice stays, and nothing is sent.
    const readsBefore = configReads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(configReads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(300)
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
    expect(saveButton()).toBeNull()
    expect(puts).toEqual([])

    // A Retry that works clears the notice and shows what is saved.
    failGetsWith = null
    await fireEvent.click(within(screen.getByTestId(NOTICE)).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(baseUrlInput()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('Local AI runtime (legacy)')).toBeTruthy()
    expect(baseUrlInput()?.value).toBe('http://127.0.0.1:11434/v1')
    expect(
      (screen.getByPlaceholderText('Model name (e.g. nomic-embed-text)') as HTMLInputElement).value
    ).toBe('nomic-embed-text')
    expect((screen.getByPlaceholderText('Dimensions (e.g. 768)') as HTMLInputElement).value).toBe('768')
    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())

    // One Save sends the saved lane (the key rides as the server's mask); everything stays stored.
    await fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await pause(400)
    expect(puts.length).toBe(1)
    expect(puts[0].body.embedding.lane).toBe('local-ai')
    expect(puts[0].body.embedding.localAi.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())
  }, 60_000)

  it('the load fails and Retry works on a saved preset lane: the card shows the preset, not the built-in default', async () => {
    await seedStored(SAVED_PRESET)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForReadAndLoadingLineGone()
    const notice = await screen.findByTestId(NOTICE)

    failGetsWith = null
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(saveButton()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('Model preset (cloud or local)')).toBeTruthy()
    expect(screen.getByText('text-embedding-3-small — openai')).toBeTruthy()
    expect(screen.queryByText('Built-in (local, no API key)')).toBeNull()
    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_PRESET_RECORD())
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a later reload that fails keeps the card, and its Save still sends the saved lane', async () => {
    await seedStored(SAVED_LOCAL_AI)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(baseUrlInput()?.value).toBe('http://127.0.0.1:11434/v1'), { timeout: 10_000 })

    // The reload that follows a Save fails: the card was loaded once, it stays, and says so.
    failGetsWith = 500
    await fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await waitFor(() => expect(screen.queryByText(/Failed to load memory config/)).not.toBeNull(), { timeout: 5_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(saveButton()).not.toBeNull()
    expect(baseUrlInput()?.value).toBe('http://127.0.0.1:11434/v1')

    await fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 5_000 })
    await pause(400)
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal Save keeps the saved lane', async () => {
    await seedStored(SAVED_LOCAL_AI)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(baseUrlInput()?.value).toBe('http://127.0.0.1:11434/v1'), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    await pause(400)
    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())

    await fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await pause(400)
    expect(puts.length).toBe(1)
    expect(await storedConfig()).toEqual(SAVED_LOCAL_AI_RECORD())
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a new instance with no stored config opens on the built-in default, and Save stores it', async () => {
    installRoutes()
    renderPanel()
    await waitForReadAndLoadingLineGone()
    // The load answered (no record yet: the route answers the default): nothing is hidden.
    await waitFor(() => expect(saveButton()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('Built-in (local, no API key)')).toBeTruthy()
    expect(screen.getByText('embeddinggemma-300m')).toBeTruthy()
    await pause(400)
    expect(puts).toEqual([])
    expect(await storedConfig()).toBeNull()

    await fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await pause(400)
    expect(puts[0].body).toEqual({ embedding: DEFAULT_EMBEDDING })
    expect(await storedConfig()).toEqual({ embedding: DEFAULT_EMBEDDING, schema_version: MEMORY_SCHEMA_VERSION })
  }, 60_000)
})
