/**
 * BL-68: a merged catalog row carries the gateway's window (Sonnet 4.5: 1,000,000
 * tokens), but Anthropic's direct API runs that model at 200,000 unless a beta
 * header Batshit does not send asks for more. A connection that joined the row
 * through the reviewed identity rule carries its own limits on its variant, and
 * the preset editor must use them. This drives the real Overwrite Selected
 * Preset button through the panel's own catalog fallback (the enrich route is
 * down) and reads the preset the panel then saves.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))

import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver

const MERGED_SONNET_45: CatalogModel = {
  id: 'anthropic/claude-sonnet-4.5',
  canonicalId: 'anthropic/claude-sonnet-4.5',
  provider: 'anthropic',
  upstreamProvider: 'vercel',
  name: 'claude-sonnet-4.5',
  displayName: 'Claude Sonnet 4.5',
  tags: [],
  features: { streaming: true, tools: true, vision: true, maxTokens: 1_000_000, longContext: true },
  purpose: 'chat',
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  pricing: { input: 3, output: 15, cachedInput: 0.3 },
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:anthropic'],
  idVariants: {
    'vercel-gateway': {
      developerId: 'anthropic',
      modelId: 'claude-sonnet-4.5',
      effectiveId: 'anthropic/claude-sonnet-4.5',
      source: 'vercel'
    },
    'direct:anthropic': {
      developerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      effectiveId: 'claude-sonnet-4-5-20250929',
      source: 'direct',
      limits: { contextWindow: null, maxOutputTokens: null }
    }
  }
}

const CONNECTIONS: CatalogConnectionOption[] = [
  { id: 'vercel-gateway', label: 'Vercel AI Gateway', transport: 'vercel-gateway', service: 'vercel', providers: null, status: 'ready' },
  { id: 'direct:anthropic', label: 'Anthropic (Direct)', transport: 'direct', service: 'anthropic', providers: ['anthropic'], status: 'ready' }
]

/** A direct preset that once copied the gateway's window. */
const PRESET: SavedModel = {
  id: 'zb_sonnet_45_direct',
  modelName: 'Claude Sonnet 4.5 (Direct)',
  modelId: 'claude-sonnet-4-5-20250929',
  provider: 'anthropic',
  catalogModelId: 'anthropic/claude-sonnet-4.5',
  effectiveModelId: 'claude-sonnet-4-5-20250929',
  contextWindow: 1_000_000,
  pricing: { input: 3, output: 15, cachedInput: 0.3 },
  settings: { maxTokens: 64_000 },
  purpose: 'chat',
  connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic', useDeveloperPrefix: false },
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z'
} as SavedModel

let savedBodies: any[] = []

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.startsWith('/api/user/saved-models/enrich')) {
      return new Response(JSON.stringify({ error: 'metadata service down' }), { status: 500 })
    }
    if (url.startsWith('/api/user/saved-models') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      savedBodies.push(body)
      return new Response(JSON.stringify({ success: true, model: { ...body, id: body.id || PRESET.id } }), { status: 200 })
    }
    if (url.startsWith('/api/user/saved-models')) {
      return new Response(JSON.stringify({ models: [PRESET], meta: { purged: [] } }), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      return new Response(JSON.stringify({ success: true, data: { models: [MERGED_SONNET_45], connections: CONNECTIONS } }), { status: 200 })
    }
    if (url.startsWith('/api/compatibility-matrix')) {
      return new Response(JSON.stringify({ data: { version: 1, fetchedAt: null, entries: [] } }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
}

function ensureAnimateStub() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
}

describe('BL-68 the preset editor uses a connection\'s own limits', () => {
  beforeEach(() => {
    savedBodies = []
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

  it('saves no window for a direct preset instead of the gateway row\'s 1,000,000', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })

    const overwrite = await waitFor(
      () => {
        const button = screen.getByRole('button', { name: /Overwrite Selected Preset/i }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        return button
      },
      { timeout: 10_000 }
    )
    await fireEvent.click(overwrite)

    const saved = await waitFor(
      () => {
        const body = savedBodies.at(-1)
        expect(body).toBeTruthy()
        return body
      },
      { timeout: 10_000 }
    )
    expect(saved.effectiveModelId).toBe('claude-sonnet-4-5-20250929')
    expect(saved.contextWindow).toBeUndefined()
    // No limit is known for this connection, so the output cap is Batshit's safe estimate.
    expect(saved.enrichment?.maxOutputTokensEstimated).toBe(true)
    expect(saved.enrichment?.contextWindow).toBeUndefined()
    // The list price is the same on every connection and still applies.
    expect(saved.pricing).toMatchObject({ input: 3, output: 15, cachedInput: 0.3 })
  }, 30_000)
})
