/**
 * BL-68: a merged catalog row carries the gateway's window (Sonnet 4.5: 1,000,000
 * tokens), but Anthropic's direct API runs that model at 200,000 unless a beta
 * header Batshit does not send asks for more. A connection that joined the row
 * through the reviewed identity rule carries its own limits on its variant, and
 * the preset editor must use them. This drives the real Overwrite Selected
 * Preset button through the panel's own catalog fallback (the enrich route is
 * down) and reads the preset the panel then saves.
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
  { id: 'direct:google', label: 'Google (Direct)', transport: 'direct', service: 'google', providers: ['google'], status: 'ready' },
  { id: 'direct:anthropic', label: 'Anthropic (Direct)', transport: 'direct', service: 'anthropic', providers: ['anthropic'], status: 'ready' },
  { id: 'direct:openai', label: 'OpenAI (Direct)', transport: 'direct', service: 'openai', providers: ['openai'], status: 'ready' }
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
let catalogFixture = MERGED_SONNET_45
let presetFixture = PRESET

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
      return new Response(JSON.stringify({ models: [presetFixture], meta: { purged: [] } }), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      return new Response(JSON.stringify({ success: true, data: { models: [catalogFixture], connections: CONNECTIONS } }), { status: 200 })
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
    catalogFixture = structuredClone(MERGED_SONNET_45)
    presetFixture = structuredClone(PRESET)
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

  it('SA-132: shows exact direct-connection reasoning facts and failed-refresh date without borrowing gateway choices', async () => {
    const variant = catalogFixture.idVariants!['direct:anthropic']
    variant.reasoningEvidence = {
      lastGood: { version: 1, scope: 'public', support: 'supported', connection: 'direct:anthropic',
        effectiveModelId: variant.effectiveId, endpoint: 'messages',
        controls: [{ id: 'effort', kind: 'effort', values: ['low', 'high'], defaultValue: 'high' }],
        evidence: [{ url: 'https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking', checkedAt: '2026-10-14' }], lastVerified: '2026-10-14' },
      lastAttempt: { at: '2026-10-15', outcome: 'unavailable', reason: 'fixture source outage' }
    }
    catalogFixture.idVariants!['vercel-gateway'].reasoningEvidence = {
      ...variant.reasoningEvidence,
      lastGood: { ...variant.reasoningEvidence.lastGood!, connection: 'vercel-gateway',
        effectiveModelId: catalogFixture.idVariants!['vercel-gateway'].effectiveId,
        controls: [{ id: 'effort', kind: 'effort', values: ['max'], defaultValue: 'max' }] }
    }
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true, initialModelId: PRESET.id } } })
    const facts = await screen.findByTestId('model-reasoning-evidence')
    await waitFor(() => expect(facts.textContent).toContain('Effort: low, high.'))
    expect(facts.textContent).toContain('Default: high.')
    expect(facts.textContent).toContain('Last verified: 2026-10-14.')
    expect(facts.textContent).toContain('Latest check 2026-10-15: unavailable.')
    expect(facts.textContent).not.toContain('max')
    expect(within(facts).getByRole('link', { name: 'Source 1' }).getAttribute('href')).toContain('docs.anthropic.com')
    expect(savedBodies).toEqual([])
  }, 30_000)

  it.each(['gemini-2.5-pro', 'gemini-2.5-flash-lite'])('keeps %s blank budget unseeded and invalid integer draft visible without an autosave', async modelId => {
    presetFixture = { ...PRESET, id: 'sa132_budget_blank', modelName: 'Budget blank', provider: 'google', modelId, effectiveModelId: modelId,
      catalogModelId: undefined, connection: { type: 'direct', id: 'direct:google', service: 'google' }, settings: { maxTokens: 64000 } }
    catalogFixture = { ...MERGED_SONNET_45, id: `google/${modelId}`, canonicalId: `google/${modelId}`, provider: 'google', name: modelId,
      displayName: modelId, connectionId: 'direct:google', transport: 'direct', availableConnections: ['direct:google'],
      idVariants: { 'direct:google': { developerId: 'google', modelId, effectiveId: modelId, source: 'direct' } } }
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true, initialModelId: presetFixture.id } } })
    const name = await screen.findByDisplayValue('Budget blank')
    const reasoning = await screen.findByRole('button', { name: /^Reasoning/ })
    if (reasoning.getAttribute('aria-expanded') !== 'true') await fireEvent.click(reasoning)
    const label = await screen.findByText('Thinking budget', { exact: true })
    const input = label.closest('.batshit-settings-form-row')!.querySelector('input')!
    expect(input.value).toBe('')
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(savedBodies).toEqual([])
    await fireEvent.input(input, { target: { value: '1.5' } })
    await fireEvent.blur(input)
    expect(input.value).toBe('1.5')
    await screen.findByText(/Enter a whole requested token budget/)
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(savedBodies).toEqual([])
    await fireEvent.input(input, { target: { value: '' } })
    await fireEvent.input(name, { target: { value: 'Budget blank renamed' } })
    await waitFor(() => expect(savedBodies.at(-1)?.modelName).toBe('Budget blank renamed'), { timeout: 10_000 })
    expect(savedBodies.at(-1).settings).not.toHaveProperty('thinkingBudget')
  }, 30_000)

  it('SA-139 R1: an OpenAI API preset whose model id contains "codex" shows Model Parameters, not a CLI form', async () => {
    presetFixture = { ...PRESET, id: 'sa139_openai_codex_model', modelName: 'GPT-5 Codex (API)', provider: 'openai',
      modelId: 'gpt-5-codex', effectiveModelId: 'gpt-5-codex', catalogModelId: undefined,
      connection: { type: 'direct', id: 'direct:openai', service: 'openai' }, settings: { maxTokens: 64_000 } }
    catalogFixture = { ...MERGED_SONNET_45, id: 'openai/gpt-5-codex', canonicalId: 'openai/gpt-5-codex', provider: 'openai',
      name: 'gpt-5-codex', displayName: 'GPT-5 Codex', connectionId: 'direct:openai', transport: 'direct',
      availableConnections: ['direct:openai'],
      idVariants: { 'direct:openai': { developerId: 'openai', modelId: 'gpt-5-codex', effectiveId: 'gpt-5-codex', source: 'direct' } } }
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true, initialModelId: presetFixture.id } } })
    await screen.findByDisplayValue('GPT-5 Codex (API)')
    expect(await screen.findByText('Model Parameters', { exact: true })).toBeTruthy()
    expect(screen.queryByText(/Codex CLI/)).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 800))
    // Whatever the panel saves stays the same API preset: no CLI connection and no codex_* keys.
    for (const body of savedBodies) {
      expect(body).toMatchObject({ modelId: 'gpt-5-codex', provider: 'openai', connection: { id: 'direct:openai', service: 'openai' } })
      expect(Object.keys(body.settings ?? {}).filter(key => key.startsWith('codex_'))).toEqual([])
    }
  }, 30_000)

})
