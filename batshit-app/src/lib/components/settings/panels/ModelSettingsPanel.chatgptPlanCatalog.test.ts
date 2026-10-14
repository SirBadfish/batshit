/** BL-1066/1067: paid and two account rows share a slug; reopening stays on the saved account. */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))
import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import { chatgptPlanPublishedMetadata } from '$lib/data/chatgpt-plan-published-metadata'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
import type { CatalogModel, CatalogConnectionOption } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'

const originalFetch = globalThis.fetch, originalObserver = globalThis.ResizeObserver
const slug = 'gpt-6-astra', selected = 'chatgpt-plan:account-b'
const connections: CatalogConnectionOption[] = ['direct:openai', 'chatgpt-plan:account-a', selected].map(id => ({
  id, label: id, transport: 'direct', service: id.startsWith('chatgpt-plan:') ? 'chatgpt-plan' : 'openai', providers: ['openai'], status: 'ready'
}))
function row(connection: string): CatalogModel {
  const plan = connection.startsWith('chatgpt-plan:')
  return {
    id: `${connection}/${slug}`, canonicalId: `${connection}/${slug}`, provider: 'openai', name: slug,
    displayName: plan ? `Account Astra ${connection.slice(-1)}` : 'Paid Astra', tags: [], purpose: 'chat', source: 'direct',
    transport: 'direct', connectionId: connection, availableConnections: [connection],
    features: { streaming: true, tools: true, vision: true },
    ...(plan ? { publishedMetadata: chatgptPlanPublishedMetadata(slug) } : { contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: { input: 99, output: 99 } }),
    idVariants: { [connection]: { developerId: 'openai', modelId: slug, effectiveId: slug, source: 'direct', ...(plan ? { limits: { contextWindow: null, maxOutputTokens: null } } : {}) } }
  }
}
const preset: SavedModel = {
  id: 'plan-preset', modelName: 'My Astra', provider: 'openai', modelId: slug, effectiveModelId: slug,
  // Deliberately retain a historical wrong catalog id: the account owns the row.
  catalogModelId: `direct:openai/${slug}`, connection: { id: selected, type: 'direct', service: 'chatgpt-plan' },
  settings: {}, pricing: {}, createdAt: '2026-10-01', updatedAt: '2026-10-01'
}
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any
  if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }) })
})
afterEach(() => { globalThis.fetch = originalFetch; globalThis.ResizeObserver = originalObserver; vi.restoreAllMocks() })

it('reopens and refreshes the saved account without saving or copying published ceilings into the budget', async () => {
  const writes: any[] = []
  let rows = connections.map(connection => row(connection.id)), loads = 0
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input), method = init?.method || 'GET'
    if (url.startsWith('/api/user/saved-models/enrich')) return new Response('{}', { status: 500 })
    if (url.startsWith('/api/user/saved-models') && method === 'POST') {
      const body = JSON.parse(String(init?.body)); writes.push(body)
      return Response.json({ success: true, model: { ...body, id: preset.id } })
    }
    if (url.startsWith('/api/user/saved-models')) return Response.json({ models: [preset], meta: { purged: [] } })
    if (url.startsWith('/api/models')) { loads++; return Response.json({ success: true, data: { models: rows, connections } }) }
    return Response.json({ data: { version: 1, fetchedAt: null, entries: [] } })
  }) as typeof fetch
  const { container } = render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })
  await waitFor(() => expect(container.querySelector('.batshit-settings-catalog-details-title')?.textContent).toBe('Account Astra b'), { timeout: 10000 })
  expect(writes).toHaveLength(0)
  expect(container.querySelectorAll('.batshit-settings-pill.is-warning')).toHaveLength(0)
  await fireEvent.click(screen.getByText('View Details'))
  await waitFor(() => expect(container.textContent).toContain('Published model context: 1,050,000'))
  expect(screen.getByRole('link', { name: 'OpenAI model documentation' }).getAttribute('href')).toBe(chatgptPlanPublishedMetadata(slug)!.sourceUrl)
  expect(container.textContent).toContain('verified 2026-10-01')
  expect(container.textContent).not.toContain('Input $99/M')
  const contextInput = container.querySelector('input[placeholder="Unknown"]') as HTMLInputElement
  expect(contextInput.value).toBe('')
  const priorLoads = loads
  rows = [row('direct:openai'), row(selected)]
  dispatchModelConnectionsUpdated('api-keys')
  await waitFor(() => expect(loads).toBe(priorLoads + 1))
  expect(container.querySelector('.batshit-settings-catalog-details-title')?.textContent).toBe('Account Astra b')
  expect(writes).toHaveLength(0)
  expect(container.querySelectorAll('.batshit-settings-pill.is-warning')).toHaveLength(0)
  const overwrite = screen.getByRole('button', { name: /Overwrite Selected Preset/i })
  await waitFor(() => expect((overwrite as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(overwrite)
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ connection: { id: selected }, modelId: slug, pricing: {} })
  expect(writes[0].contextWindow).toBeUndefined()
  expect(writes[0].settings?.maxTokens).toBeUndefined()
  expect(writes[0].enrichment?.contextWindow).toBeUndefined()
}, 30000)

it('retains a genuine paid preset display-name modification', async () => {
  const paid = { ...preset, modelName: 'Custom paid name', connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, enrichment: { source: 'provider-manager', fetchedAt: '2026-10-01', modelName: 'Original name', provider: 'openai', modelId: slug, connectionId: 'direct:openai' } }
  const writes: unknown[] = []
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') writes.push(init.body)
    if (url.startsWith('/api/user/saved-models')) return Response.json({ models: [paid], meta: {} })
    if (url.startsWith('/api/models')) return Response.json({ success: true, data: { models: [row('direct:openai')], connections } })
    return Response.json({ data: { version: 1, fetchedAt: null, entries: [] } })
  }) as typeof fetch
  const { container } = render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })
  await waitFor(() => expect(container.querySelector('.batshit-settings-catalog-details-title')?.textContent).toBe('Paid Astra'))
  expect(Array.from(container.querySelectorAll('.batshit-settings-pill.is-warning')).map(node => node.parentElement?.textContent)).toEqual([expect.stringContaining('Display Name')])
  expect(writes).toHaveLength(0)
}, 30000)
