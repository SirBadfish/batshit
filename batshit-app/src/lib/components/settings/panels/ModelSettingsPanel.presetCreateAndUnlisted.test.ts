/**
 * BL-516 and BL-517 in the Models panel.
 *
 * BL-516: "Use to Create New Preset" sends a new preset with no id; the server refuses a create
 * whose id is already saved (409). The panel must show that sentence, and it must never turn the
 * create into an update of the preset that is already there.
 * BL-517: the list load keeps presets whose model the AI Gateway no longer lists and names them
 * in `meta.unlisted`; the panel warns about them with the existing inline alert (it used to say
 * it had removed them).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  message: vi.fn()
}))

vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))
vi.mock('$lib/components/ui/sonner/settings-toast', () => ({ toast: toastMock }))

import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver

const SONNET_5: CatalogModel = {
  id: 'anthropic/claude-sonnet-5',
  canonicalId: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  upstreamProvider: 'vercel',
  name: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  tags: [],
  features: { streaming: true, tools: true, vision: true },
  purpose: 'chat',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  pricing: { input: 3, output: 15 },
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway'],
  idVariants: {
    'vercel-gateway': {
      developerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      effectiveId: 'anthropic/claude-sonnet-5',
      source: 'vercel'
    }
  }
}

const CONNECTIONS: CatalogConnectionOption[] = [
  { id: 'vercel-gateway', label: 'Vercel AI Gateway', transport: 'vercel-gateway', service: 'vercel', providers: null, status: 'ready' }
]

/** The user's first preset from this catalog model, with a custom temperature. */
const FIRST_PRESET: SavedModel = {
  id: 'claude_sonnet_5_anthropic_claude_sonnet_5_vercel_gateway_vercel',
  modelName: 'Claude Sonnet 5',
  modelId: 'claude-sonnet-5',
  provider: 'anthropic',
  catalogModelId: 'anthropic/claude-sonnet-5',
  effectiveModelId: 'anthropic/claude-sonnet-5',
  isVercelImport: true,
  vercelSourceId: 'anthropic/claude-sonnet-5',
  contextWindow: 200_000,
  pricing: { input: 3, output: 15 },
  settings: { temperature: 0.2 },
  purpose: 'chat',
  connection: { type: 'vercel-gateway', service: 'vercel' },
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z'
} as SavedModel

const EXISTS_SENTENCE = 'A model preset with that name already exists: "Claude Sonnet 5". Choose a different display name.'

let postedBodies: any[] = []

function mockFetch(listAnswer: { models: SavedModel[]; meta: Record<string, unknown> }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.startsWith('/api/user/saved-models/enrich')) {
      return new Response(JSON.stringify({ error: 'metadata service down' }), { status: 500 })
    }
    if (url.startsWith('/api/user/saved-models') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      postedBodies.push(body)
      // The server's BL-516 answer to a create whose id is already saved.
      if (!body.id) {
        return new Response(JSON.stringify({ error: EXISTS_SENTENCE, code: 'model_preset_exists' }), { status: 409 })
      }
      return new Response(JSON.stringify({ success: true, model: body }), { status: 200 })
    }
    if (url.startsWith('/api/user/saved-models')) {
      return new Response(JSON.stringify(listAnswer), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      return new Response(JSON.stringify({ success: true, data: { models: [SONNET_5], connections: CONNECTIONS } }), { status: 200 })
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

describe('Models panel: BL-516 create refusal and BL-517 unlisted presets', () => {
  beforeEach(() => {
    postedBodies = []
    Object.values(toastMock).forEach((fn) => fn.mockReset())
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

  it('shows the server\'s "already exists" sentence for a second create, and never saves over the first preset', async () => {
    globalThis.fetch = mockFetch({ models: [FIRST_PRESET], meta: { unlisted: [] } }) as unknown as typeof fetch
    render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })

    const create = await waitFor(
      () => {
        const button = screen.getByRole('button', { name: /Use to Create New Preset/i }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        return button
      },
      { timeout: 10_000 }
    )
    await fireEvent.click(create)

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(EXISTS_SENTENCE), { timeout: 10_000 })
    expect(postedBodies.length).toBeGreaterThan(0)
    // Every write the click made was a create (no id); none named the first preset.
    expect(postedBodies.every((body) => !body.id)).toBe(true)
    expect(toastMock.success).not.toHaveBeenCalledWith('Model preset created')
  }, 30_000)

  it('warns about presets whose model the AI Gateway no longer lists, naming them', async () => {
    const unlisted = { ...FIRST_PRESET, unavailableReason: 'Vercel AI Gateway no longer lists this model' }
    globalThis.fetch = mockFetch({
      models: [unlisted],
      meta: { unlisted: [{ id: FIRST_PRESET.id, modelName: 'Claude Sonnet 5' }] }
    }) as unknown as typeof fetch
    render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })

    await waitFor(
      () =>
        expect(
          screen.getByText(
            '1 preset uses a model Vercel AI Gateway no longer lists. Agents that use it cannot send until you pick another model for them.',
            { exact: false }
          )
        ).toBeTruthy(),
      { timeout: 10_000 }
    )
    expect(screen.queryByText(/Removed \d+ deprecated model/)).toBeNull()
  }, 30_000)
})
