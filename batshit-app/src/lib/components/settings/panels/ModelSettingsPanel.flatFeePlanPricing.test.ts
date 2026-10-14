/**
 * BL-296 / BL-658: a saved model preset whose connection is a flat-fee plan
 * (Kimi Code, Z.ai Coding Plan, the MiniMax/MiMo/Qwen token plans) bills a
 * monthly fee, not the gateway's per-token list price. The preset editor's
 * "View Details" price line must read "Token plan" for one of these
 * connections instead of a per-token number or "Unknown".
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

/** A merged Kimi K3 row available through the gateway and through Kimi Code's flat-fee plan. */
const MERGED_KIMI_K3: CatalogModel = {
  id: 'moonshotai/kimi-k3',
  canonicalId: 'moonshotai/kimi-k3',
  provider: 'moonshotai',
  upstreamProvider: 'vercel',
  name: 'kimi-k3',
  displayName: 'Kimi K3',
  tags: [],
  features: { streaming: true, tools: true, vision: false, maxTokens: 262_144, longContext: true },
  purpose: 'chat',
  contextWindow: 262_144,
  maxOutputTokens: 65_536,
  pricing: { input: 0.6, output: 2.5 },
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:kimi_code'],
  idVariants: {
    'vercel-gateway': { developerId: 'moonshotai', modelId: 'kimi-k3', effectiveId: 'moonshotai/kimi-k3', source: 'vercel' },
    'direct:kimi_code': { developerId: 'moonshotai', modelId: 'k3', effectiveId: 'moonshotai/k3', source: 'direct' }
  }
}

const CONNECTIONS: CatalogConnectionOption[] = [
  { id: 'vercel-gateway', label: 'Vercel AI Gateway', transport: 'vercel-gateway', service: 'vercel', providers: null, status: 'ready' },
  { id: 'direct:kimi_code', label: 'Kimi Code Membership', transport: 'direct', service: 'kimi_code', providers: ['moonshotai'], status: 'ready' }
]

/** A saved preset that runs on the Kimi Code flat-fee plan. */
const PRESET: SavedModel = {
  id: 'zbmodels_kimi_k3_kimi_code',
  modelName: 'Kimi K3 (Kimi Code)',
  modelId: 'k3',
  provider: 'moonshotai',
  catalogModelId: 'moonshotai/kimi-k3',
  effectiveModelId: 'moonshotai/k3',
  contextWindow: 262_144,
  pricing: { input: 0.6, output: 2.5 },
  settings: { maxTokens: 16_384 },
  purpose: 'chat',
  connection: { id: 'direct:kimi_code', type: 'direct', service: 'kimi_code', useDeveloperPrefix: false },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z'
} as SavedModel

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.startsWith('/api/user/saved-models/enrich')) {
      return new Response(JSON.stringify({ error: 'metadata service down' }), { status: 500 })
    }
    if (url.startsWith('/api/user/saved-models') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ success: true, model: { ...body, id: body.id || PRESET.id } }), { status: 200 })
    }
    if (url.startsWith('/api/user/saved-models')) {
      return new Response(JSON.stringify({ models: [PRESET], meta: { purged: [] } }), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      return new Response(JSON.stringify({ success: true, data: { models: [MERGED_KIMI_K3], connections: CONNECTIONS } }), { status: 200 })
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

describe('BL-296 the preset editor shows "Token plan" for a flat-fee plan connection', () => {
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

  it('shows "Token plan" instead of the gateway price for a Kimi Code preset', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    const { container } = render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })

    const details = await waitFor(
      () => {
        const trigger = screen.getByText('View Details')
        expect(trigger).toBeTruthy()
        return trigger
      },
      { timeout: 10_000 }
    )
    await fireEvent.click(details)

    await waitFor(() => expect(container.textContent).toContain('Token plan'), { timeout: 10_000 })
    expect(container.textContent).not.toContain('Input $0.6/M')
    expect(container.textContent).not.toContain('Output $2.5/M')
  }, 30_000)
})
