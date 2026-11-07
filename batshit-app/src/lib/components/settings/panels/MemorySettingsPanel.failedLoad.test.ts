import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { jsonResponse } from '$lib/test-utils/userSettingsRoute'
import { redis } from '$lib/server/redis'
import { MEMORY_CONFIG_KEY, MEMORY_INDEX_META_KEY } from '$lib/server/services/memory/memoryKeys'
import { MEMORY_SCHEMA_VERSION } from '$lib/server/services/memory/memoryTypes'
import { canonicalEmbeddingModelId } from '$lib/server/services/memory/memoryEmbedder'
import { toast } from 'svelte-sonner'
import MemorySystemCard from '../memory/MemorySystemCard.svelte'
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
const NEXT_EMBEDDING = { lane: 'builtin', modelId: 'builtin:all-minilm-l6-v2' }
const PRESETS_UNAVAILABLE = 'Model presets could not be read. The saved choice is kept.'
const INDEX_UNAVAILABLE = 'Current index status is unavailable. Reopen Memory Settings to check it.'
const MISMATCH = 'The saved configuration does not match the built index.'

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
let presetFailure: number | null = null
let presetAnswer: unknown | null = null

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
  presetFailure = null
  presetAnswer = null
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
        if (presetFailure !== null) return jsonResponse({ error: 'Preset list unavailable' }, presetFailure)
        if (presetAnswer !== null) return jsonResponse(presetAnswer)
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

  beforeEach(async () => {
    if (process.env.VITEST_USE_REAL_REDIS !== 'true') {
      // e177b5a85 made setMemoryConfig one Lua write, and the default lane's Redis fake has no EVAL
      // (the route answered 400 "client.eval is not a function"). This is a default-lane stand-in
      // for that Lua writer: it validates like it and stores the whole record (the script patches only
      // `$.embedding` and `$.schema_version` of an existing one; these cases seed no other field). It is
      // valid only for these non-preset cases (it skips preset reference admission), so a preset lane
      // refuses here instead of saving unchecked.
      const owner = await import('$lib/server/services/memory/memoryIndex')
      const { canonicalEmbeddingModelId } = await import('$lib/server/services/memory/memoryEmbedder')
      vi.spyOn(owner, 'setMemoryConfig').mockImplementation(async (embedding) => {
        if (embedding.lane === 'preset') throw new Error('default-lane setMemoryConfig stand-in: preset lanes need the real writer')
        const record = { embedding: structuredClone(embedding), schema_version: MEMORY_SCHEMA_VERSION }
        canonicalEmbeddingModelId(record.embedding)
        await redis.json.set(MEMORY_CONFIG_KEY, '$', record as never)
        return record as Awaited<ReturnType<typeof owner.setMemoryConfig>>
      })
    }
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it.each(['failed', 'malformed'] as const)('a %s preset list is unknown, never a missing saved preset or an empty successful list', async mode => {
    await seedStored(SAVED_PRESET)
    installRoutes()
    if (mode === 'failed') presetFailure = 500
    else presetAnswer = {}
    renderPanel()
    expect(await screen.findByText(PRESETS_UNAVAILABLE)).toBeVisible()
    expect(screen.getByText(/text-embedding-3-small.*preset status unavailable/)).toBeTruthy()
    expect(screen.queryByText(/preset missing/)).toBeNull()
    expect(screen.queryByText(/No model presets yet/)).toBeNull()
    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_PRESET_RECORD())
    expect(saveButton()).not.toBeDisabled()
    await fireEvent.click(reindexButton() as HTMLElement)
    expect(await screen.findByText('Re-Index All Memories?')).toBeVisible()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/memory/reindex'))).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_PRESET_RECORD())
  }, 60_000)

  it('a successful empty preset list can report a missing choice without clearing the stored selection', async () => {
    await seedStored(SAVED_PRESET)
    installRoutes()
    presetAnswer = { models: [] }
    renderPanel()
    expect(await screen.findByText(/text-embedding-3-small.*preset missing/)).toBeTruthy()
    expect(screen.queryByText(PRESETS_UNAVAILABLE)).toBeNull()
    expect(puts).toEqual([])
    expect(await storedConfig()).toEqual(SAVED_PRESET_RECORD())
  }, 60_000)

  it('an unavailable preset read keeps the last-good label and options without changing the draft', async () => {
    const changed = vi.fn()
    const presets = [{ id: SAVED_PRESET.preset.presetId, modelId: 'text-embedding-3-small', modelName: 'Saved embedding', provider: 'openai', purpose: 'utility' }]
    const draft = { ...SAVED_PRESET, localAi: SAVED_LOCAL_AI.localAi, api: { provider: 'openai', modelName: '', dims: 0 } }
    const view = render(MemorySystemCard, { props: { draft: draft as any, presets, presetsState: 'ready', indexStatusCurrent: true,
      indexMeta: null, builtinModels: [], apiProviders: [], onDraftChange: changed, onSave: vi.fn(), onReindex: vi.fn() } as any })
    expect(screen.getByText('Saved embedding — openai')).toBeTruthy()
    await view.rerender({ presetsState: 'unavailable' } as any)
    expect(screen.getByText(PRESETS_UNAVAILABLE)).toBeVisible()
    expect(screen.getByText('Saved embedding — openai')).toBeTruthy()
    expect(screen.queryByText(/preset missing/)).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it.each([false, true])('failed post-save config read makes an old mismatch=%s unknown without changing the index', async wasMismatch => {
    await seedStored(DEFAULT_EMBEDDING)
    const index = { embedding_model: canonicalEmbeddingModelId((wasMismatch ? NEXT_EMBEDDING : DEFAULT_EMBEDDING) as any), dims: wasMismatch ? 384 : 768,
      index_schema_version: 1, schema_version: MEMORY_SCHEMA_VERSION, last_rebuilt_at: '2026-10-01T00:00:00.000Z' }
    await redis.json.set(MEMORY_INDEX_META_KEY, '$', index)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(saveButton()).not.toBeNull())
    expect(Boolean(screen.queryByText(new RegExp(MISMATCH)))).toBe(wasMismatch)
    await fireEvent.keyDown(screen.getByRole('button', { name: 'embeddinggemma-300m', exact: true }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: /all-minilm-l6-v2/ }), { pointerType: 'mouse' })
    const info = vi.spyOn(toast, 'info').mockImplementation(() => '' as any)
    failGetsWith = 500
    await fireEvent.click(saveButton() as HTMLElement)
    expect(await screen.findByText(INDEX_UNAVAILABLE)).toBeVisible()
    expect(screen.queryByText(new RegExp(MISMATCH))).toBeNull()
    expect(screen.queryByText('Not built yet (it builds on app start).')).toBeNull()
    expect(info).not.toHaveBeenCalled()
    expect(puts).toHaveLength(1)
    expect(await storedConfig()).toEqual({ embedding: NEXT_EMBEDDING, schema_version: MEMORY_SCHEMA_VERSION })
    expect(await redis.json.get(MEMORY_INDEX_META_KEY)).toEqual(index)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/memory/reindex'))).toEqual([])
    expect(saveButton()).not.toBeDisabled()
  }, 60_000)

  it('only a successful current config readback presents a changed-model mismatch and its re-index notice', async () => {
    await seedStored(DEFAULT_EMBEDDING)
    const index = { embedding_model: canonicalEmbeddingModelId(DEFAULT_EMBEDDING as any), dims: 768, index_schema_version: 1,
      schema_version: MEMORY_SCHEMA_VERSION, last_rebuilt_at: '2026-10-01T00:00:00.000Z' }
    await redis.json.set(MEMORY_INDEX_META_KEY, '$', index)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(saveButton()).not.toBeNull())
    await fireEvent.keyDown(screen.getByRole('button', { name: 'embeddinggemma-300m', exact: true }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: /all-minilm-l6-v2/ }), { pointerType: 'mouse' })
    const info = vi.spyOn(toast, 'info').mockImplementation(() => '' as any)
    await fireEvent.click(saveButton() as HTMLElement)
    expect(await screen.findByText(new RegExp(MISMATCH))).toBeVisible()
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(INDEX_UNAVAILABLE)).toBeNull()
    expect(await redis.json.get(MEMORY_INDEX_META_KEY)).toEqual(index)
  }, 60_000)

  it('an incomplete post-save status envelope is unknown rather than proof of a missing or matching index', async () => {
    await seedStored(DEFAULT_EMBEDDING)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(saveButton()).not.toBeNull())
    answerGetsWith = { embedding: DEFAULT_EMBEDDING }
    await fireEvent.click(saveButton() as HTMLElement)
    expect(await screen.findByText(INDEX_UNAVAILABLE)).toBeVisible()
    expect(screen.queryByText('Not built yet (it builds on app start).')).toBeNull()
    expect(puts).toHaveLength(1)
    expect(await storedConfig()).toEqual({ embedding: DEFAULT_EMBEDDING, schema_version: MEMORY_SCHEMA_VERSION })
  }, 60_000)

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
