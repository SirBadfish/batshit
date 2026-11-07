/** SA-139 P1 (D12, V1): the Claude plan preset editor offers only effort, never autosaves on open, and saves no price or output budget. */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))
import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
import type { CatalogModel, CatalogConnectionOption } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'

const originalFetch = globalThis.fetch, originalObserver = globalThis.ResizeObserver
const plan = 'claude-plan:local'
const connections: CatalogConnectionOption[] = [
  { id: 'direct:anthropic', label: 'Anthropic', transport: 'direct', service: 'anthropic', providers: ['anthropic'], status: 'ready' },
  { id: plan, label: 'Claude Plan', transport: 'direct', service: 'claude-plan', providers: ['anthropic'], status: 'locked', lockedReason: 'Claude plan replies are not available in this Batshit build yet.' }
]
const rows: CatalogModel[] = [
  { id: 'anthropic/claude-opus-5-5', canonicalId: 'anthropic/claude-opus-5-5', provider: 'anthropic', name: 'claude-opus-5-5', displayName: 'Paid Opus 5.5',
    tags: [], purpose: 'chat', source: 'direct', transport: 'direct', connectionId: 'direct:anthropic', availableConnections: ['direct:anthropic'],
    features: { streaming: true, tools: true }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 5, output: 25 },
    idVariants: { 'direct:anthropic': { developerId: 'anthropic', modelId: 'claude-opus-5-5', effectiveId: 'claude-opus-5-5', source: 'direct' } } },
  { id: `${plan}/claude-opus-5-5`, canonicalId: `${plan}/claude-opus-5-5`, provider: 'anthropic', name: 'claude-opus-5-5', displayName: 'Opus 5.5 (Claude Plan)',
    tags: [], purpose: 'chat', source: 'claude-plan', transport: 'direct', connectionId: plan, availableConnections: [plan], features: { streaming: true, tools: true },
    idVariants: { [plan]: { developerId: 'anthropic', modelId: 'claude-opus-5-5', effectiveId: 'claude-opus-5-5', source: 'direct', limits: { contextWindow: 1_000_000, maxOutputTokens: null } } } }
]
const preset: SavedModel = {
  id: 'claude-plan-preset', modelName: 'My Claude plan Opus', provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5',
  connection: { id: plan, type: 'direct', service: 'claude-plan' }, purpose: 'chat', contextWindow: 1_000_000,
  settings: { anthropicEffort: 'high' }, pricing: {}, createdAt: '2026-10-26', updatedAt: '2026-10-26'
}
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any
  if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }) })
})
afterEach(() => { globalThis.fetch = originalFetch; globalThis.ResizeObserver = originalObserver; vi.restoreAllMocks() })

it('opens and refreshes a Claude plan preset without saving, offers only effort, and overwrites with no price or output budget', async () => {
  const writes: any[] = []
  let loads = 0
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
  await waitFor(() => expect(container.querySelector('.batshit-settings-catalog-details-title')?.textContent).toBe('Opus 5.5 (Claude Plan)'), { timeout: 10000 })
  expect(writes).toHaveLength(0)
  expect(container.querySelectorAll('.batshit-settings-pill.is-warning')).toHaveLength(0)
  // One reasoning parameter (effort) and no common sampling parameters.
  await fireEvent.click(screen.getByRole('button', { name: /^Reasoning\s*1$/ }))
  await waitFor(() => expect(container.textContent).toMatch(/Reasoning effort\s+High/))
  expect(container.textContent).not.toContain('Temperature')
  expect(container.textContent).not.toContain('Thinking mode')
  expect(container.textContent).toContain("Claude plan replies count against your Claude plan's usage limits")
  const maxOutput = container.querySelector('input[placeholder="Managed by Claude Code"]') as HTMLInputElement
  expect(maxOutput.disabled).toBe(true)
  expect(maxOutput.value).toBe('')

  // Committing another number field never builds an output-cap estimate or a badge for a plan preset.
  const contextInput = Array.from(container.querySelectorAll('input')).find(input => (input as HTMLInputElement).value === '1,000,000') as HTMLInputElement
  await fireEvent.focus(contextInput)
  await fireEvent.input(contextInput, { target: { value: '900000' } })
  await fireEvent.blur(contextInput)
  await waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 })
  expect(writes[0].contextWindow).toBe(900_000)
  expect(writes[0].settings).toEqual({ anthropicEffort: 'high' })
  expect(writes[0].enrichment).toBeUndefined()
  expect(container.querySelectorAll('.batshit-settings-pill.is-info')).toHaveLength(0)
  expect(maxOutput.value).toBe('')
  writes.length = 0

  const priorLoads = loads
  dispatchModelConnectionsUpdated('api-keys')
  await waitFor(() => expect(loads).toBe(priorLoads + 1))
  expect(writes).toHaveLength(0)
  expect(container.querySelectorAll('.batshit-settings-pill.is-warning')).toHaveLength(0)

  const overwrite = screen.getByRole('button', { name: /Overwrite Selected Preset/i })
  await waitFor(() => expect((overwrite as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(overwrite)
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ connection: { id: plan, service: 'claude-plan' }, modelId: 'claude-opus-5-5', pricing: {} })
  expect(writes[0].settings).toEqual({ anthropicEffort: 'high' })
  expect(writes[0].enrichment).toBeUndefined()
}, 30000)

it('overwrites a paid Anthropic preset onto the Claude plan without carrying its output cap, sampling or custom parameters', async () => {
  const { confirmDialog } = await import('$lib/stores/confirmDialog')
  const paid: SavedModel = { id: 'paid-opus', modelName: 'Paid Opus', provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5',
    connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' }, purpose: 'chat', contextWindow: 1_000_000, catalogModelId: 'anthropic/claude-opus-5-5',
    settings: { maxTokens: 4000, temperature: 0.5, customFlag: true }, pricing: { input: 5, output: 25 }, createdAt: '2026-10-26', updatedAt: '2026-10-26' }
  const writes: any[] = []
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input), method = init?.method || 'GET'
    if (url.startsWith('/api/user/saved-models/enrich')) return new Response('{}', { status: 500 })
    if (url.startsWith('/api/user/saved-models') && method === 'POST') {
      const body = JSON.parse(String(init?.body)); writes.push(body)
      return Response.json({ success: true, model: { ...body, id: paid.id } })
    }
    if (url.startsWith('/api/user/saved-models')) return Response.json({ models: [paid], meta: { purged: [] } })
    if (url.startsWith('/api/models')) return Response.json({ success: true, data: { models: rows, connections: connections.map(option => ({ ...option, status: 'ready' as const, lockedReason: undefined })) } })
    return Response.json({ data: { version: 1, fetchedAt: null, entries: [] } })
  }) as typeof fetch
  const { container } = render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })
  await waitFor(() => expect(container.querySelector('.batshit-settings-catalog-details-title')?.textContent).toBe('Paid Opus 5.5'), { timeout: 10000 })
  expect(container.textContent).toContain('Custom Parameters')
  // A half-typed Custom JSON draft on the paid preset must not block the plan preset's save once that field is hidden.
  await fireEvent.click(screen.getByRole('button', { name: 'Expand Custom Parameters' }))
  const customJson = await waitFor(() => { const field = container.querySelector('textarea[placeholder=\'{"parameter_key": "value"}\']') as HTMLTextAreaElement; expect(field).toBeTruthy(); return field })
  await fireEvent.input(customJson, { target: { value: '{"unfinished": ' } })
  await waitFor(() => expect(container.textContent).toContain('Custom JSON is not valid JSON.'))
  writes.length = 0
  const triggerFor = (label: string) => Array.from(container.querySelectorAll('label')).find(node => node.textContent?.trim() === label)!
    .parentElement!.querySelector('[data-slot="select-trigger"]') as HTMLElement
  const provider = triggerFor('Provider')
  provider.focus()
  await fireEvent.keyDown(provider, { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: /Claude Plan/ }), { button: 0, pointerType: 'mouse' })
  const model = await waitFor(() => { const trigger = triggerFor('Model'); expect(trigger).toBeTruthy(); return trigger })
  model.focus()
  await fireEvent.keyDown(model, { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: /Opus 5\.5 \(Claude Plan\)/ }), { button: 0, pointerType: 'mouse' })
  await waitFor(() => expect(container.querySelector('.batshit-settings-catalog-details-title')?.textContent).toBe('Opus 5.5 (Claude Plan)'), { timeout: 10000 })
  expect(writes).toHaveLength(0)
  const overwrite = screen.getByRole('button', { name: /Overwrite Selected Preset/i })
  await waitFor(() => expect((overwrite as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(overwrite)
  await waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10000 })
  expect(vi.mocked(confirmDialog).mock.calls.at(-1)?.[0]).toMatchObject({ description: expect.stringContaining('Claude Plan presets keep only reasoning effort (and Thinking on models that allow it)') })
  // Let any follow-up autosave land: none may carry the paid preset's cap, sampling or custom row.
  await new Promise(resolve => setTimeout(resolve, 1500))
  for (const body of writes) {
    expect(body).toMatchObject({ connection: { id: plan, service: 'claude-plan' }, pricing: {} })
    expect(body.settings ?? {}).toEqual({})
    expect(body.enrichment).toBeUndefined()
  }
  expect(container.textContent).not.toContain('Custom Parameters')
}, 30000)
