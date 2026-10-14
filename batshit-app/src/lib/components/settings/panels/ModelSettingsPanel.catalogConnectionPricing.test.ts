/**
 * BL-132: a merged catalog row carries the gateway's price, but an open-model
 * host sells the same model at its own price (DeepInfra's GLM 5.3). That
 * connection carries its price on its variant, and the preset editor must use
 * it. This drives the real Overwrite Selected Preset button through the panel's
 * own catalog fallback (the enrich route is down) and reads the preset the panel
 * then saves.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))

import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver

const MERGED_GLM_53: CatalogModel = {
  id: 'zai/glm-5.3',
  canonicalId: 'zai/glm-5.3',
  provider: 'zai',
  upstreamProvider: 'vercel',
  name: 'glm-5.3',
  displayName: 'GLM 5.3',
  tags: [],
  features: { streaming: true, tools: true, vision: false, maxTokens: 262_144, longContext: true },
  purpose: 'chat',
  contextWindow: 262_144,
  maxOutputTokens: 65_536,
  pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 },
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:deepinfra'],
  idVariants: {
    'vercel-gateway': { developerId: 'zai', modelId: 'glm-5.3', effectiveId: 'zai/glm-5.3', source: 'vercel' },
    'direct:deepinfra': {
      developerId: 'zai-org',
      modelId: 'GLM-5.3',
      effectiveId: 'zai-org/GLM-5.3',
      source: 'direct',
      limits: { contextWindow: 131_072, maxOutputTokens: null },
      pricing: { input: 0.45, output: 1.9 }
    }
  }
}

const CONNECTIONS: CatalogConnectionOption[] = [
  { id: 'vercel-gateway', label: 'Vercel AI Gateway', transport: 'vercel-gateway', service: 'vercel', providers: null, status: 'ready' },
  { id: 'direct:deepinfra', label: 'DeepInfra (Direct)', transport: 'direct', service: 'deepinfra', providers: ['deepinfra'], status: 'ready' }
]

/** A DeepInfra preset that once copied the gateway row's price. */
const PRESET: SavedModel = {
  id: 'zbmodels_glm_53_deepinfra',
  modelName: 'GLM 5.3 (DeepInfra)',
  modelId: 'GLM-5.3',
  provider: 'zai-org',
  catalogModelId: 'zai/glm-5.3',
  effectiveModelId: 'zai-org/GLM-5.3',
  contextWindow: 262_144,
  pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 },
  settings: { maxTokens: 16_384 },
  purpose: 'chat',
  connection: { id: 'direct:deepinfra', type: 'direct', service: 'deepinfra', useDeveloperPrefix: false },
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z'
} as SavedModel

let savedBodies: any[] = []

function mockFetch(catalogModels: CatalogModel[] = [MERGED_GLM_53]) {
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
      return new Response(JSON.stringify({ success: true, data: { models: catalogModels, connections: CONNECTIONS } }), { status: 200 })
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

describe('BL-132 the preset editor uses a connection\'s own price', () => {
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

  it('sorts real developer labels while selecting and saving the canonical Z.ai identities', async () => {
    const contrastingDeveloper: CatalogModel = {
      ...MERGED_GLM_53,
      id: 'openai/contrast', canonicalId: 'openai/contrast', provider: 'openai',
      name: 'contrast', displayName: 'Contrast Model',
      idVariants: {
        'vercel-gateway': { developerId: 'openai', modelId: 'contrast', effectiveId: 'openai/contrast', source: 'vercel' },
        'direct:deepinfra': { developerId: 'openai', modelId: 'contrast', effectiveId: 'openai/contrast', source: 'direct' }
      }
    }
    // Deliberately reverse display order; a one-developer fixture cannot prove sorting.
    globalThis.fetch = mockFetch([MERGED_GLM_53, contrastingDeveloper]) as unknown as typeof fetch
    const { container } = render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })
    const triggerFor = (label: string) => {
      const node = Array.from(container.querySelectorAll('label')).find(node => node.textContent?.trim() === label)
      expect(node).toBeTruthy()
      const trigger = node!.parentElement!.querySelector('[data-slot="select-trigger"]') as HTMLElement
      expect(trigger).toBeTruthy()
      return trigger
    }
    const developer = await waitFor(() => {
      const trigger = triggerFor('Developer')
      expect(within(trigger).getByText('Z.ai', { exact: true })).toBeTruthy()
      return trigger
    }, { timeout: 10_000 })
    expect(within(developer).getByAltText('Z.ai').getAttribute('src')).toBe('/ai-branding-generated/zai-mono.svg')

    developer.focus()
    await fireEvent.keyDown(developer, { key: 'ArrowDown' })
    await screen.findByRole('option', { name: /Z\.ai/ })
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent?.trim())).toEqual(['OpenAI', 'Z.ai'])
    expect(options.map(option => option.getAttribute('data-value'))).toEqual(['openai', 'zai'])
    expect(options[1].hasAttribute('data-selected')).toBe(true)
    await fireEvent.pointerUp(options[0], { button: 0, pointerType: 'mouse' })
    await waitFor(() => expect(within(developer).getByText('OpenAI', { exact: true })).toBeTruthy())

    developer.focus()
    await fireEvent.keyDown(developer, { key: 'ArrowDown' })
    const zai = await screen.findByRole('option', { name: /Z\.ai/ })
    expect(zai.getAttribute('data-value')).toBe('zai')
    await fireEvent.pointerUp(zai, { button: 0, pointerType: 'mouse' })
    await waitFor(() => expect(within(developer).getByText('Z.ai', { exact: true })).toBeTruthy())

    const model = triggerFor('Model')
    model.focus()
    await fireEvent.keyDown(model, { key: 'ArrowDown' })
    const glm = await screen.findByRole('option', { name: /GLM 5\.3/ })
    expect(glm.getAttribute('data-value')).toBe('zai/glm-5.3')
    await fireEvent.pointerUp(glm, { button: 0, pointerType: 'mouse' })
    const overwrite = await waitFor(() => {
      const button = screen.getByRole('button', { name: /Overwrite Selected Preset/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      return button
    }, { timeout: 10_000 })
    await fireEvent.click(overwrite)
    await waitFor(() => expect(savedBodies.at(-1)).toMatchObject({
      provider: 'zai-org', modelId: 'GLM-5.3', catalogModelId: 'zai/glm-5.3', effectiveModelId: 'zai-org/GLM-5.3'
    }), { timeout: 10_000 })
  }, 30_000)

  it('saves DeepInfra\'s price and window for a DeepInfra preset, not the gateway row\'s', async () => {
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
    expect(saved.effectiveModelId).toBe('zai-org/GLM-5.3')
    expect(saved.pricing).toEqual({ input: 0.45, output: 1.9 })
    expect(saved.pricing).not.toHaveProperty('cachedInput')
    expect(saved.contextWindow).toBe(131_072)
    expect(saved.enrichment?.pricing).toEqual({ input: 0.45, output: 1.9 })
  }, 30_000)

  it('shows DeepInfra\'s price in the catalog details for a DeepInfra preset', async () => {
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

    await waitFor(() => expect(container.textContent).toContain('Input $0.45/M'), { timeout: 10_000 })
    expect(container.textContent).toContain('Output $1.9/M')
    expect(container.textContent).not.toContain('Input $0.6/M')
    expect(container.textContent).not.toContain('Cached $0.11/M')
  }, 30_000)
})
