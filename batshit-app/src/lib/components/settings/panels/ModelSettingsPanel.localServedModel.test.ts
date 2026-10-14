/**
 * BL-104: KoboldCpp answers EVERY request with its one loaded model, whatever
 * `model` the request names (measured 2026-09-22: any value got Qwen3.5-9B).
 * After a model switch, a preset saved for the old model still ran, on the new
 * one, and nothing in the preset editor said so. `/api/models` now marks the
 * model KoboldCpp serves (`servesEveryRequest`), and the editor names it.
 *
 * This renders the real Models panel against the two HTTP answers it loads on
 * mount, so it pins the wiring and not only the wording.
 */

import { render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver

const LLAMA = 'koboldcpp/Llama-3.2-3B-Instruct-Q4_K_M'
const n = (value: number) => value.toLocaleString()

/** What `/api/models` lists for KoboldCpp while it serves Llama 3.2 3B. */
const SERVED_ROW: CatalogModel = {
  id: `koboldcpp/${LLAMA}`,
  canonicalId: `koboldcpp/${LLAMA}`,
  provider: 'koboldcpp',
  name: LLAMA,
  displayName: LLAMA,
  description: `KoboldCpp local model (${LLAMA})`,
  tags: ['local', 'koboldcpp'],
  features: { streaming: true },
  source: 'local',
  transport: 'local',
  connectionId: 'direct:koboldcpp',
  availableConnections: ['direct:koboldcpp'],
  upstreamProvider: 'local',
  purpose: 'chat',
  servesEveryRequest: true,
  localContext: {
    source: 'loaded',
    loadedContextWindow: 32768,
    maxContextWindow: null,
    remainingTtlSeconds: null
  }
}

const KOBOLD_CONNECTION: CatalogConnectionOption = {
  id: 'direct:koboldcpp',
  label: 'KoboldCpp (Local)',
  transport: 'direct',
  service: 'koboldcpp',
  providers: ['koboldcpp'],
  status: 'ready'
}

/** The shape the save route stores for a KoboldCpp preset made from the catalog. */
function koboldPreset(modelId: string, contextWindow: number): SavedModel {
  const now = new Date().toISOString()
  return {
    id: `zb_kobold_${modelId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    modelName: `Preset for ${modelId}`,
    modelId,
    provider: 'koboldcpp',
    effectiveModelId: modelId,
    contextWindow,
    pricing: { input: 0, output: 0, cachedInput: 0 },
    settings: {},
    purpose: 'chat',
    connection: { id: 'direct:koboldcpp', type: 'direct', service: 'koboldcpp', useDeveloperPrefix: false },
    createdAt: now,
    updatedAt: now
  } as SavedModel
}

function mockFetch(preset: SavedModel) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.startsWith('/api/user/saved-models') && method === 'GET') {
      return new Response(JSON.stringify({ models: [preset], meta: { purged: [] } }), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      return new Response(
        JSON.stringify({ success: true, data: { models: [SERVED_ROW], connections: [KOBOLD_CONNECTION] } }),
        { status: 200 }
      )
    }
    if (url.startsWith('/api/compatibility-matrix')) {
      return new Response(JSON.stringify({ data: { version: 1, fetchedAt: null, entries: [] } }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
}

/** Bits UI collapsibles animate with the Web Animations API, which jsdom lacks. */
function ensureAnimateStub() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
}

/** The app layout gives the panel a tooltip provider; the test does the same. */
function renderPanel() {
  return render(TooltipProviderWrapper as any, {
    props: { component: ModelSettingsPanel, props: { active: true } }
  })
}

describe('BL-104 the preset editor names the model KoboldCpp really serves', () => {
  beforeEach(() => {
    ensureAnimateStub()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.ResizeObserver = originalResizeObserver
    vi.restoreAllMocks()
  })

  it('says which model answers a preset saved for another one, and at what size', async () => {
    globalThis.fetch = mockFetch(koboldPreset('koboldcpp/Qwen3.5-9B-Q4_K_M', 262144)) as unknown as typeof fetch
    const { container } = renderPanel()

    await waitFor(
      () => {
        expect(container.textContent).toContain(
          'KoboldCpp is serving Llama-3.2-3B-Instruct-Q4_K_M, not the model above. ' +
            'Replies from this preset come from Llama-3.2-3B-Instruct-Q4_K_M.'
        )
      },
      { timeout: 10_000 }
    )
    // The size note follows the model that really runs, as the send path does.
    expect(container.textContent).toContain(
      `KoboldCpp is running Llama-3.2-3B-Instruct-Q4_K_M at ${n(32768)} tokens, not the ${n(262144)} above. ` +
        `Batshit plans against ${n(32768)}.`
    )
  }, 30_000)

  it('says nothing about the model for a preset that names the served one', async () => {
    globalThis.fetch = mockFetch(koboldPreset(LLAMA, 32768)) as unknown as typeof fetch
    const { container } = renderPanel()

    await waitFor(
      () => {
        expect(container.textContent).toContain(`KoboldCpp is running this model at ${n(32768)} tokens.`)
      },
      { timeout: 10_000 }
    )
    expect(container.textContent).not.toContain('KoboldCpp is serving')
  }, 30_000)
})
