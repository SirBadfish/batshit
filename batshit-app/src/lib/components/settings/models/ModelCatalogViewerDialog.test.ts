/**
 * BL-241: two catalog rows can share a bare model id while being different rows
 * (Kimi K3 through Moonshot and through Qwen Cloud: `moonshot/kimi-k3` and
 * `system/kimi-k3`, both `kimi-k3`). The viewer keyed its rows by that id, so
 * opening it, searching, and clearing the search threw Svelte's
 * `each_key_duplicate`. Rows are keyed by the catalog id `/api/models` makes
 * unique (`canonicalId`).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ModelCatalogViewerDialog from './ModelCatalogViewerDialog.svelte'
import { formatDeveloperLabel } from './modelSettingsFormatters'
import type { CatalogModel } from '$lib/types/modelCatalog'

const originalResizeObserver = globalThis.ResizeObserver

function row(canonicalId: string, displayName: string, connectionId: string): CatalogModel {
  const [provider, name] = canonicalId.split('/')
  return {
    id: name,
    canonicalId,
    provider,
    name,
    displayName,
    purpose: 'chat',
    connectionId,
    availableConnections: [connectionId],
    pricing: { input: 3, output: 15 },
    contextWindow: 1_000_000,
    features: { streaming: true }
  }
}

const MOONSHOT = row('moonshot/kimi-k3', 'Kimi K3', 'direct:moonshot')
const QWEN_CLOUD = row('system/kimi-k3', 'kimi-k3 on Qwen Cloud', 'direct:qwencloud')

function props(rows: CatalogModel[], search = '', connection = 'all') {
  return {
    open: true,
    catalogLoading: false,
    catalogViewerSearch: search,
    catalogViewerConnection: connection,
    catalogViewerConnectionOptions: ['direct:moonshot', 'direct:qwencloud'],
    catalogViewerProviderOptions: ['moonshot', 'system'],
    catalogViewerRows: rows,
    catalogViewerFilteredCount: rows.length,
    connectionOptions: [],
    capabilities: [],
    formatDeveloperLabel: (value?: string | null) => value ?? '',
    getConnectionIconMeta: () => ({ icon: '', filter: '' }),
    getModelConnections: (model?: CatalogModel | null) => model?.availableConnections ?? [],
    formatConnectionLabel: (value?: string | null) => value ?? '',
    formatPrice: (value?: number | null) => (value === undefined || value === null ? null : String(value)),
    catalogFeaturesToCapabilities: () => null
  }
}

function ensureAnimateStub() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
}

describe('BL-241 the Model Catalog Viewer keys rows by their unique catalog id', () => {
  beforeEach(() => {
    ensureAnimateStub()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('shows two rows that share a bare id, through a search and a cleared search', async () => {
    const { rerender } = render(ModelCatalogViewerDialog, { props: props([MOONSHOT, QWEN_CLOUD]) })
    expect(await screen.findByText('Kimi K3')).toBeTruthy()
    expect(screen.getByText('kimi-k3 on Qwen Cloud')).toBeTruthy()

    // Search: only the Qwen Cloud row matches.
    await rerender(props([QWEN_CLOUD], 'qwen'))
    expect(screen.queryByText('Kimi K3')).toBeNull()
    expect(screen.getByText('kimi-k3 on Qwen Cloud')).toBeTruthy()

    // Clear the search: both rows come back, each once.
    await rerender(props([MOONSHOT, QWEN_CLOUD]))
    expect(screen.getAllByText('Kimi K3')).toHaveLength(1)
    expect(screen.getAllByText('kimi-k3 on Qwen Cloud')).toHaveLength(1)
  })
})

/** A merged GLM 5.3 row: the gateway's numbers, DeepInfra's own on its variant (BL-132). */
const GLM_53: CatalogModel = {
  ...row('zai/glm-5.3', 'GLM 5.3', 'vercel-gateway'),
  pricing: { input: 0.6, output: 2.2 },
  contextWindow: 262_144,
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

describe('Review finding 3: the viewer filtered to one connection shows that connection\'s numbers', () => {
  beforeEach(() => {
    ensureAnimateStub()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('renders the real Z.ai label, alt text and icon for a supplied active developer', async () => {
    render(ModelCatalogViewerDialog, { props: {
      ...props([GLM_53]),
      catalogViewerProviderOptions: ['openai', 'zai'],
      catalogViewerProvider: 'zai',
      formatDeveloperLabel
    } })

    const developerLabel = await screen.findByText('Developer', { exact: true })
    const trigger = developerLabel.parentElement!.querySelector('[data-slot="select-trigger"]') as HTMLElement
    expect(trigger).toBeTruthy()
    expect(within(trigger).getByText('Z.ai', { exact: true })).toBeTruthy()
    expect(within(trigger).getByAltText('Z.ai').getAttribute('src')).toBe('/ai-branding-generated/zai-mono.svg')

    trigger.focus()
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const option = await screen.findByRole('option', { name: /Z\.ai/ })
    expect(option.getAttribute('data-value')).toBe('zai')
    expect(option.hasAttribute('data-selected')).toBe(true)
    expect(within(option).getByText('Z.ai', { exact: true })).toBeTruthy()
    expect(within(option).getByAltText('Z.ai').getAttribute('src')).toBe('/ai-branding-generated/zai-mono.svg')
    await fireEvent.pointerUp(option, { button: 0, pointerType: 'mouse' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(within(trigger).getByText('Z.ai', { exact: true })).toBeTruthy()
  })

  it('shows DeepInfra\'s price and window under DeepInfra, and the row\'s under All Providers', async () => {
    const { rerender } = render(ModelCatalogViewerDialog, { props: props([GLM_53], '', 'direct:deepinfra') })
    expect(await screen.findByText('$0.45/M')).toBeTruthy()
    expect(screen.getByText('$1.9/M')).toBeTruthy()
    expect(screen.getByText(`${(131_072).toLocaleString()} tokens`)).toBeTruthy()

    await rerender(props([GLM_53], '', 'all'))
    expect(screen.getByText('$0.6/M')).toBeTruthy()
    expect(screen.getByText(`${(262_144).toLocaleString()} tokens`)).toBeTruthy()
  })
})

/** A merged Kimi K3 row available both through Moonshot direct and Kimi Code's flat-fee plan. */
const KIMI_K3_ON_PLAN: CatalogModel = {
  ...row('moonshotai/kimi-k3', 'Kimi K3', 'vercel-gateway'),
  pricing: { input: 0.6, output: 2.5 },
  availableConnections: ['vercel-gateway', 'direct:kimi_code'],
  idVariants: {
    'vercel-gateway': { developerId: 'moonshotai', modelId: 'kimi-k3', effectiveId: 'moonshotai/kimi-k3', source: 'vercel' },
    'direct:kimi_code': {
      developerId: 'moonshotai',
      modelId: 'k3',
      effectiveId: 'moonshotai/k3',
      source: 'direct'
    }
  }
}

describe('BL-658: a flat-fee plan connection shows "Token plan", not a price', () => {
  beforeEach(() => {
    ensureAnimateStub()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('shows "Token plan" under Kimi Code, and the row\'s per-token price under All Providers', async () => {
    const { rerender } = render(ModelCatalogViewerDialog, {
      props: props([KIMI_K3_ON_PLAN], '', 'direct:kimi_code')
    })
    expect(await screen.findAllByText('Token plan')).toHaveLength(2)
    expect(screen.queryByText('$0.6/M')).toBeNull()

    await rerender(props([KIMI_K3_ON_PLAN], '', 'all'))
    expect(screen.queryByText('Token plan')).toBeNull()
    expect(screen.getByText('$0.6/M')).toBeTruthy()
  })
})
