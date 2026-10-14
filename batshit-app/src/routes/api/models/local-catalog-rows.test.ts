/**
 * BL-104: KoboldCpp answers EVERY request with its one loaded model, whatever
 * `model` the request names (measured 2026-09-22: any value got Qwen3.5-9B).
 * `/v1/models` names that model, so `/api/models` marks its row. The preset
 * editor reads the mark to tell a preset saved for another model which model
 * really answers it.
 *
 * The same rows carry SA-124 P4's context reading, which also applies to any
 * model id, so both readings are pinned here through the real route builder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import type { LocalAiServerSummary } from '$lib/types/localAi'
import { _buildLocalCatalogModels } from './+server'

function program(id: string): LocalAiServerSummary {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === id)
  if (!definition) throw new Error(`no local program ${id}`)
  return {
    ...definition,
    baseUrl: definition.defaultBaseUrl,
    openaiPath: definition.openaiPath,
    enabled: true,
    imageTransport: definition.defaultImageTransport,
    imageBaseUrl: definition.defaultImageBaseUrl,
    source: 'stored'
  }
}

const KOBOLD = 'http://localhost:5001'
const LLAMA = 'koboldcpp/Llama-3.2-3B-Instruct-Q4_K_M'

describe('BL-104 /api/models marks the model KoboldCpp serves to every request', () => {
  let routes: Record<string, unknown>

  beforeEach(() => {
    routes = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        return url in routes
          ? new Response(JSON.stringify(routes[url]), { status: 200 })
          : new Response('not found', { status: 404 })
      })
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  function serving(options: { version: unknown; models: string[]; context?: number }) {
    routes[`${KOBOLD}/api/extra/version`] = options.version
    routes[`${KOBOLD}/v1/models`] = {
      object: 'list',
      data: options.models.map((id) => ({ id, object: 'model', owned_by: 'koboldcpp' }))
    }
    if (options.context !== undefined) {
      routes[`${KOBOLD}/api/extra/true_max_context_length`] = { value: options.context }
    }
  }

  it('marks the one served model and gives it the size KoboldCpp runs', async () => {
    serving({ version: { llm: true, router: false }, models: [LLAMA], context: 32768 })

    const rows = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: `koboldcpp/${LLAMA}`,
      name: LLAMA,
      connectionId: 'direct:koboldcpp',
      servesEveryRequest: true,
      localContext: { source: 'loaded', loadedContextWindow: 32768 }
    })
  })

  it('still marks the served model when KoboldCpp does not report its size', async () => {
    // The two side doors fail on their own; a missing size must not hide the model.
    serving({ version: { llm: true, router: false }, models: [LLAMA] })

    const [row] = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(row.servesEveryRequest).toBe(true)
    expect(row.localContext).toBeNull()
  })

  it('marks nothing in router mode, where the request picks the model', async () => {
    serving({
      version: { llm: true, router: true },
      models: [LLAMA, 'koboldcpp/Qwen3.5-9B-Q4_K_M'],
      context: 32768
    })

    const rows = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(rows).toHaveLength(2)
    expect(rows.some((row) => row.servesEveryRequest)).toBe(false)
  })

  it('marks nothing when it lists more than one model, since it cannot say which answers', async () => {
    serving({
      version: { llm: true, router: false },
      models: [LLAMA, 'koboldcpp/Qwen3.5-9B-Q4_K_M'],
      context: 32768
    })

    const rows = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(rows).toHaveLength(2)
    expect(rows.some((row) => row.servesEveryRequest)).toBe(false)
  })

  it('marks nothing in router mode even when it lists one model', async () => {
    serving({ version: { llm: true, router: true }, models: [LLAMA], context: 32768 })

    const [row] = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(row.servesEveryRequest).toBeUndefined()
    expect(row.localContext).toBeNull()
  })

  it('marks nothing when no text model is loaded', async () => {
    // With no model loaded KoboldCpp keeps its placeholder name (SA-124 P8).
    serving({ version: { llm: false, router: false }, models: ['koboldcpp/inactive'], context: 32768 })

    const rows = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(rows.some((row) => row.servesEveryRequest)).toBe(false)
  })

  it('trusts the version door over the list when it says no text model is loaded', async () => {
    serving({ version: { llm: false, router: false }, models: [LLAMA], context: 32768 })

    const [row] = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(row.servesEveryRequest).toBeUndefined()
  })

  it('never takes the placeholder for a served model', async () => {
    serving({ version: { llm: true, router: false }, models: ['koboldcpp/inactive'] })

    const rows = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(rows.some((row) => row.servesEveryRequest)).toBe(false)
  })

  it('marks nothing when KoboldCpp does not answer its version door', async () => {
    serving({ version: undefined, models: [LLAMA], context: 32768 })
    delete routes[`${KOBOLD}/api/extra/version`]

    const rows = await _buildLocalCatalogModels([program('koboldcpp')])

    expect(rows.some((row) => row.servesEveryRequest)).toBe(false)
  })

  it('does not mark another program that serves a single model', async () => {
    // llama.cpp also runs one model per process, but Batshit has not measured
    // whether it ignores the request's model, so it gets no mark.
    routes['http://localhost:8080/v1/models'] = { data: [{ id: 'Qwen3-8B-Q4_K_M.gguf' }] }

    const rows = await _buildLocalCatalogModels([program('llama-cpp')])

    expect(rows).toHaveLength(1)
    expect(rows[0].servesEveryRequest).toBeUndefined()
  })
})

describe('BL-1246 /api/models preserves reported Ollama capabilities', () => {
  const OLLAMA = 'http://localhost:11434'
  const MODEL = 'qwen3.5:9b-q4_K_M'
  let nativePayload: unknown
  let nativeStatus: number
  let nativeRejects: boolean
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    nativePayload = { models: [{ name: MODEL, model: MODEL, capabilities: ['vision', 'tools', 'thinking'] }] }
    nativeStatus = 200
    nativeRejects = false
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === `${OLLAMA}/v1/models`) return Response.json({ data: [{ id: MODEL }, { id: 'another:latest' }] })
      if (url === `${OLLAMA}/api/tags`) {
        if (nativeRejects) throw new Error('unreachable')
        return Response.json(nativePayload, { status: nativeStatus })
      }
      if (url === `${OLLAMA}/api/ps`) return Response.json({ models: [] })
      throw new Error(`Unexpected model request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('uses one native bulk read and keeps exact OpenAI discovery IDs and Tools off by default', async () => {
    const rows = await _buildLocalCatalogModels([program('ollama')])
    expect(rows.map(row => row.name)).toEqual([MODEL, 'another:latest'])
    expect(rows[0]).toMatchObject({
      id: `ollama/${MODEL}`, connectionId: 'direct:ollama',
      features: { streaming: true, vision: true, reasoning: true }
    })
    expect(rows[0].features?.tools).toBeUndefined()
    expect(rows[1].features).toEqual({ streaming: true })
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      `${OLLAMA}/api/ps`, `${OLLAMA}/api/tags`, `${OLLAMA}/v1/models`
    ])
  })

  it.each([undefined, null, [], ['completion'], 'thinking', ['thinking', 1]])('keeps absent/malformed capabilities unknown: %j', capabilities => {
    nativePayload = { models: [{ name: MODEL, capabilities }] }
    return _buildLocalCatalogModels([program('ollama')]).then(rows => {
      expect(rows[0].features).toEqual({ streaming: true })
    })
  })

  it('does not guess a tag, case, namespace or model name', async () => {
    nativePayload = { models: [
      { name: 'qwen3.5', capabilities: ['thinking'] },
      { name: MODEL.toUpperCase(), capabilities: ['thinking'] },
      { name: `library/${MODEL}`, capabilities: ['vision'] }
    ] }
    const rows = await _buildLocalCatalogModels([program('ollama')])
    expect(rows[0].features).toEqual({ streaming: true })
  })

  it.each([404, 500])('retains discovered models with unknown metadata when tags returns %s', async status => {
    nativeStatus = status
    const rows = await _buildLocalCatalogModels([program('ollama')])
    expect(rows).toHaveLength(2)
    expect(rows[0].features).toEqual({ streaming: true })
  })

  it('retains discovery when the native metadata request fails', async () => {
    nativeRejects = true
    const rows = await _buildLocalCatalogModels([program('ollama')])
    expect(rows).toHaveLength(2)
    expect(rows[0].features).toEqual({ streaming: true })
  })

  it('does not read native metadata when discovery lists no models', async () => {
    fetchMock.mockImplementation(async () => Response.json({ data: [] }))
    const rows = await _buildLocalCatalogModels([program('ollama')])
    expect(rows).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
