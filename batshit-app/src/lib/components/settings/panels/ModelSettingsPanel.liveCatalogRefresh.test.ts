/**
 * BL-134: the Models tab loaded its catalog when it mounted and on its own
 * Refresh only, so an open tab kept stale connection states after a key save
 * and stale KoboldCpp notes after a model switch. It now refreshes on the
 * shared model-connection invalidation (`batshit:model-connections-updated`,
 * LS-007 / LS-011), which API Keys, Custom Providers, Local AI saves and (with
 * BL-134) the KoboldCpp / LM Studio / oMLX model cards send.
 *
 * This renders the real Models panel, switches what KoboldCpp serves behind it,
 * sends the event, and reads the editor's note.
 */

import { render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
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

let served: CatalogModel = SERVED_ROW
let catalogLoads = 0

function servedRow(model: string, context: number): CatalogModel {
  return {
    ...SERVED_ROW,
    id: `koboldcpp/${model}`,
    canonicalId: `koboldcpp/${model}`,
    name: model,
    displayName: model,
    localContext: { ...SERVED_ROW.localContext!, loadedContextWindow: context }
  }
}

function mockFetch(preset: SavedModel) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.startsWith('/api/user/saved-models') && method === 'GET') {
      return new Response(JSON.stringify({ models: [preset], meta: { purged: [] } }), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      catalogLoads += 1
      return new Response(
        JSON.stringify({ success: true, data: { models: [served], connections: [KOBOLD_CONNECTION] } }),
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

const QWEN = 'koboldcpp/Qwen3.5-9B-Q4_K_M'

describe('BL-134 an open Models tab refreshes its catalog on a model-connection change', () => {
  beforeEach(() => {
    served = SERVED_ROW
    catalogLoads = 0
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

  it('drops the stale KoboldCpp note after a switch, without a reload', async () => {
    globalThis.fetch = mockFetch(koboldPreset(QWEN, 32768)) as unknown as typeof fetch
    const { container } = renderPanel()

    await waitFor(
      () => expect(container.textContent).toContain('KoboldCpp is serving Llama-3.2-3B-Instruct-Q4_K_M'),
      { timeout: 10_000 }
    )
    const loadsBeforeSwitch = catalogLoads

    // KoboldCpp restarts on the preset's own model, and the model card says so.
    served = servedRow(QWEN, 32768)
    dispatchModelConnectionsUpdated('local-ai')

    await waitFor(
      () => {
        expect(catalogLoads).toBe(loadsBeforeSwitch + 1)
        expect(container.textContent).not.toContain('KoboldCpp is serving')
        expect(container.textContent).toContain(`KoboldCpp is running this model at ${n(32768)} tokens.`)
      },
      { timeout: 10_000 }
    )
  }, 30_000)

  it('keeps the newest catalog when an older load answers last', async () => {
    const base = mockFetch(koboldPreset(QWEN, 32768))
    let releaseSlow: (() => void) | null = null
    let delayNext = false
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/models') && delayNext) {
        delayNext = false
        // This load reads the catalog as it was (Llama served), then answers last.
        const stale = await base(input, init)
        await new Promise<void>((resolve) => (releaseSlow = resolve))
        return stale
      }
      return base(input, init)
    }) as unknown as typeof fetch
    const { container } = renderPanel()
    await waitFor(
      () => expect(container.textContent).toContain('KoboldCpp is serving Llama-3.2-3B-Instruct-Q4_K_M'),
      { timeout: 10_000 }
    )

    delayNext = true
    dispatchModelConnectionsUpdated('local-ai')
    await waitFor(() => expect(releaseSlow).not.toBeNull(), { timeout: 10_000 })
    served = servedRow(QWEN, 32768)
    dispatchModelConnectionsUpdated('local-ai')
    await waitFor(
      () => expect(container.textContent).toContain(`KoboldCpp is running this model at ${n(32768)} tokens.`),
      { timeout: 10_000 }
    )

    releaseSlow!()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container.textContent).not.toContain('KoboldCpp is serving')
  }, 30_000)

  it('keeps a Refresh that is still running when a connection change reloads the tab (BL-295)', async () => {
    // The server's catalog cache still says Llama; only a refresh (?refresh=1)
    // re-reads the registry, which now says Qwen, and it answers slowly.
    const base = mockFetch(koboldPreset(QWEN, 32768))
    const refreshes: Array<() => void> = []
    const catalogUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/models')) {
        catalogUrls.push(url)
        if (url.includes('refresh=1')) {
          await new Promise<void>((resolve) => refreshes.push(resolve))
          served = servedRow(QWEN, 32768)
        }
      }
      return base(input, init)
    }) as unknown as typeof fetch
    const { container } = renderPanel()
    await waitFor(
      () => expect(container.textContent).toContain('KoboldCpp is serving Llama-3.2-3B-Instruct-Q4_K_M'),
      { timeout: 10_000 }
    )

    const refreshButton = container.querySelector('svg.lucide-refresh-ccw')?.closest('button')
    expect(refreshButton).toBeTruthy()
    refreshButton!.click()
    await waitFor(() => expect(refreshes).toHaveLength(1), { timeout: 10_000 })

    // A key is saved in another panel while the Refresh is still running.
    dispatchModelConnectionsUpdated('api-keys')
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (const release of refreshes.splice(0)) release()
    await waitFor(
      () => {
        for (const release of refreshes.splice(0)) release()
        expect(container.textContent).toContain(`KoboldCpp is running this model at ${n(32768)} tokens.`)
      },
      { timeout: 10_000 }
    )
    expect(container.textContent).not.toContain('KoboldCpp is serving')
    // The reload asked for the refreshed catalog too, not the cache the Refresh replaces.
    expect(catalogUrls.at(-1)).toContain('refresh=1')
  }, 30_000)

  it('stops listening once the tab is closed', async () => {
    globalThis.fetch = mockFetch(koboldPreset(QWEN, 32768)) as unknown as typeof fetch
    const { unmount } = renderPanel()
    await waitFor(() => expect(catalogLoads).toBeGreaterThan(0), { timeout: 10_000 })
    unmount()
    const loadsAfterClose = catalogLoads

    dispatchModelConnectionsUpdated('api-keys')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(catalogLoads).toBe(loadsAfterClose)
  }, 30_000)
})
