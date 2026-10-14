import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
import { getModelPresetDrafts, waitForModelPresetSaves } from '../models/modelPresetAutosave'
import type { CatalogModel } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver
const MODEL = 'qwen3.5:9b-q4_K_M'
const reportedRow: CatalogModel = {
  id: `ollama/${MODEL}`, canonicalId: `ollama/${MODEL}`, provider: 'ollama',
  name: MODEL, displayName: MODEL, source: 'local', transport: 'local', purpose: 'chat',
  connectionId: 'direct:ollama', availableConnections: ['direct:ollama'],
  features: { streaming: true, vision: true, reasoning: true }
}
function preset(overrides: Partial<SavedModel> = {}): SavedModel {
  return {
    id: 'ollama-capabilities', modelName: 'My Ollama preset', modelId: MODEL, provider: 'ollama',
    effectiveModelId: MODEL, purpose: 'chat', contextWindow: 8192, pricing: {},
    settings: { maxTokens: 128, temperature: 0, topK: 40 }, capabilities: { streaming: true },
    connection: { id: 'direct:ollama', type: 'direct', service: 'ollama', useDeveloperPrefix: false },
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', ...overrides
  } as SavedModel
}
let record: SavedModel
let catalogRow: CatalogModel
let posts: SavedModel[]
let catalogReads: string[]
let holdCatalog: boolean
let releaseCatalog: (() => void) | undefined
let holdSaves: boolean
let saveReleases: (() => void)[]
let additionalRecords: SavedModel[]

function renderPanel() {
  return render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })
}
async function readyEditor() {
  await waitFor(() => expect((screen.getByPlaceholderText('Claude 3 Sonnet') as HTMLInputElement).value).toBe(record.modelName))
}
function parameterRow(container: HTMLElement, labelText: string): HTMLElement {
  const label = Array.from(container.querySelectorAll('.batshit-settings-form-label')).find(node => node.textContent?.trim() === labelText)
  expect(label).toBeTruthy()
  return label!.closest('.batshit-settings-form-row') as HTMLElement
}
async function thinkingRow(container: HTMLElement) {
  await fireEvent.click(await screen.findByRole('button', { name: 'Expand Reasoning' }))
  return waitFor(() => parameterRow(container, 'Thinking'))
}
function triggerText(row: HTMLElement) {
  return row.querySelector('[data-slot="select-trigger"]')!.textContent!.trim()
}
async function chooseThinking(row: HTMLElement, value: 'true' | 'false') {
  await fireEvent.keyDown(row.querySelector('[data-slot="select-trigger"]')!, { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: value, exact: true }), { pointerType: 'mouse' })
}
const pause = () => new Promise(resolve => setTimeout(resolve, 750))

describe('BL-1246 Ollama capability reads preserve the saved preset and editor draft', () => {
  beforeEach(() => {
    record = preset(); catalogRow = reportedRow; posts = []; catalogReads = []; holdCatalog = false; releaseCatalog = undefined
    holdSaves = false; saveReleases = []; additionalRecords = []
    getModelPresetDrafts().clear()
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
    if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', {
      configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null })
    })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/user/saved-models') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as SavedModel
        posts.push(body)
        return new Promise<Response>(resolve => {
          let released = false
          const release = () => {
            if (released) return
            released = true
            record = { ...body, createdAt: record.createdAt, updatedAt: '2026-10-10T00:00:01Z' }
            resolve(new Response(JSON.stringify({ success: true, model: record })))
          }
          saveReleases.push(release)
          if (!holdSaves) release()
        })
      }
      if (url.startsWith('/api/user/saved-models')) return new Response(JSON.stringify({ models: [record, ...additionalRecords], meta: {} }))
      if (url.startsWith('/api/models')) {
        catalogReads.push(url)
        if (holdCatalog) await new Promise<void>(resolve => { releaseCatalog = resolve })
        return new Response(JSON.stringify({ success: true, data: { models: [catalogRow], connections: [{
          id: 'direct:ollama', label: 'Ollama (Local)', transport: 'direct', service: 'ollama', providers: ['ollama'], status: 'ready'
        }] } }))
      }
      if (url.startsWith('/api/compatibility-matrix')) return new Response(JSON.stringify({ data: { version: 1, entries: [] } }))
      return new Response('{}')
    }) as typeof fetch
  })
  afterEach(async () => {
    releaseCatalog?.()
    holdSaves = false
    cleanup()
    saveReleases.forEach(release => release())
    await waitForModelPresetSaves()
    getModelPresetDrafts().clear()
    globalThis.fetch = originalFetch
    globalThis.ResizeObserver = originalResizeObserver
    vi.restoreAllMocks()
  })

  it('shows reported support with blank Thinking, tools off, and no writes on opening or refresh', async () => {
    const before = structuredClone(record)
    const { container } = renderPanel(); await readyEditor()
    const row = await thinkingRow(container)
    expect(triggerText(row)).toBe('Default (off)')
    const toolsRow = Array.from(container.querySelectorAll('.batshit-settings-toggle-row')).find(node => node.textContent?.includes('Supported Tools'))!
    expect(within(toolsRow as HTMLElement).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(container.textContent).toContain('Vision')
    dispatchModelConnectionsUpdated('local-ai')
    await waitFor(() => expect(catalogReads).toHaveLength(2))
    await pause()
    expect(catalogReads).toEqual(['/api/models', '/api/models'])
    expect(posts).toEqual([])
    expect(record).toEqual(before)
    expect(triggerText(row)).toBe('Default (off)')
  })

  it('retains a saved false during delayed hydration and a new Thinking choice wins on intentional save', async () => {
    record = preset({ settings: { maxTokens: 128, temperature: 0, topK: 40, ollamaThink: false } })
    holdCatalog = true
    const before = structuredClone(record)
    const { container } = renderPanel(); await readyEditor()
    await waitFor(() => expect(releaseCatalog).toBeTypeOf('function'))
    releaseCatalog!(); holdCatalog = false
    const row = await thinkingRow(container)
    expect(triggerText(row)).toBe('false')
    await pause()
    expect(posts).toEqual([])
    expect(record).toEqual(before)
    await chooseThinking(row, 'true')
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].settings).toEqual({ maxTokens: 128, temperature: 0, topK: 40, ollamaThink: true })
    expect(posts[0].capabilities).toEqual({ streaming: true, vision: true, reasoning: true })
    expect(posts[0].contextWindow).toBe(8192)
    expect(posts[0].capabilities?.tools).toBeUndefined()
  })

  it('retains intentionally saved support on a later metadata outage and unrelated save in the same visit', async () => {
    const { container } = renderPanel(); await readyEditor()
    const row = await thinkingRow(container)
    await chooseThinking(row, 'true')
    await waitFor(() => expect(record.settings?.ollamaThink).toBe(true))
    await pause()
    expect(posts).toHaveLength(1)
    catalogRow = { ...reportedRow, features: { streaming: true } }
    dispatchModelConnectionsUpdated('local-ai')
    await waitFor(() => expect(catalogReads).toHaveLength(2))
    await pause()
    expect(triggerText(row)).toBe('true')
    expect(posts).toHaveLength(1)
    await fireEvent.input(screen.getByPlaceholderText('Claude 3 Sonnet'), { target: { value: 'After metadata outage' } })
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].capabilities).toEqual({ streaming: true, vision: true, reasoning: true })
    expect(posts[1].settings).toEqual({ maxTokens: 128, temperature: 0, topK: 40, ollamaThink: true })
  })

  it('keeps later Thinking and numeric drafts when the earlier support save answers', async () => {
    holdSaves = true
    const { container } = renderPanel(); await readyEditor()
    const row = await thinkingRow(container)
    await chooseThinking(row, 'true')
    await waitFor(() => expect(posts).toHaveLength(1))
    await chooseThinking(row, 'false')
    const context = screen.getByPlaceholderText('200,000') as HTMLInputElement
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '200000.' } })
    catalogRow = { ...reportedRow, features: { streaming: true } }
    dispatchModelConnectionsUpdated('local-ai')
    saveReleases[0](); holdSaves = false
    await pause()
    expect(context.value).toBe('200000.')
    expect(triggerText(row)).toBe('false')
    expect(posts).toHaveLength(1)
    await fireEvent.input(context, { target: { value: '16384' } })
    await fireEvent.blur(context)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].capabilities).toEqual({ streaming: true, vision: true, reasoning: true })
    expect(posts[1].settings?.ollamaThink).toBe(false)
    expect(posts[1].contextWindow).toBe(16384)
  })

  it('retains support and later numeric intent across selection away/back during a save', async () => {
    holdSaves = true
    additionalRecords = [preset({ id: 'second-preset', modelName: 'Second preset' })]
    const { container } = renderPanel(); await readyEditor()
    const row = await thinkingRow(container)
    await chooseThinking(row, 'true')
    await waitFor(() => expect(posts).toHaveLength(1))
    const context = screen.getByPlaceholderText('200,000') as HTMLInputElement
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '20' } })
    await fireEvent.click(screen.getByRole('button', { name: /Second preset/ }))
    await fireEvent.click(screen.getByRole('button', { name: /My Ollama preset/ }))
    catalogRow = { ...reportedRow, features: { streaming: true } }
    dispatchModelConnectionsUpdated('local-ai')
    saveReleases[0](); holdSaves = false
    await pause()
    const restoredContext = screen.getByPlaceholderText('200,000') as HTMLInputElement
    expect(restoredContext.value).toBe('20')
    expect(posts).toHaveLength(1)
    await fireEvent.input(restoredContext, { target: { value: '16384' } })
    await fireEvent.blur(restoredContext)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].id).toBe('ollama-capabilities')
    expect(posts[1].capabilities).toEqual({ streaming: true, vision: true, reasoning: true })
    expect(posts[1].settings?.ollamaThink).toBe(true)
    expect(posts[1].contextWindow).toBe(16384)
  })

  it('carries confirmed support into a successor queued during an outage and flushed after close', async () => {
    holdSaves = true
    const mounted = renderPanel(); await readyEditor()
    const row = await thinkingRow(mounted.container)
    await chooseThinking(row, 'true')
    await waitFor(() => expect(posts).toHaveLength(1))
    catalogRow = { ...reportedRow, features: { streaming: true } }
    dispatchModelConnectionsUpdated('local-ai')
    await waitFor(() => expect(catalogReads).toHaveLength(2))
    await fireEvent.input(screen.getByPlaceholderText('Claude 3 Sonnet'), { target: { value: 'Queued during outage' } })
    await pause()
    mounted.unmount()
    saveReleases[0](); holdSaves = false
    await waitForModelPresetSaves()
    expect(posts).toHaveLength(2)
    expect(posts[1].modelName).toBe('Queued during outage')
    expect(posts[1].capabilities).toEqual({ streaming: true, vision: true, reasoning: true })
    expect(posts[1].settings?.ollamaThink).toBe(true)
    renderPanel(); await readyEditor()
    await pause()
    expect(posts).toHaveLength(2)
  })

  it('does not save inferred support when an edit is reverted before admission', async () => {
    const before = structuredClone(record)
    renderPanel(); await readyEditor()
    const name = screen.getByPlaceholderText('Claude 3 Sonnet')
    await fireEvent.input(name, { target: { value: 'Temporary edit' } })
    await fireEvent.input(name, { target: { value: before.modelName } })
    await pause()
    expect(posts).toEqual([])
    expect(record).toEqual(before)
  })

  it('keeps explicit restrictions and hidden saved Thinking on an unrelated intentional edit', async () => {
    record = preset({ capabilities: { vision: false, reasoning: false, tools: false }, settings: { maxTokens: 128, temperature: 0, ollamaThink: true } })
    renderPanel(); await readyEditor()
    await pause()
    expect(screen.queryByRole('button', { name: 'Expand Reasoning' })).toBeNull()
    expect(posts).toEqual([])
    await fireEvent.input(screen.getByPlaceholderText('Claude 3 Sonnet'), { target: { value: 'Renamed preset' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].capabilities).toEqual({ vision: false, reasoning: false, tools: false })
    expect(posts[0].settings).toEqual({ maxTokens: 128, temperature: 0, ollamaThink: true })
  })

  it('refreshes missing support while leaving an incomplete numeric draft and parameters untouched', async () => {
    catalogRow = { ...reportedRow, features: { streaming: true } }
    const before = structuredClone(record)
    const { container } = renderPanel(); await readyEditor()
    expect(screen.queryByRole('button', { name: 'Expand Reasoning' })).toBeNull()
    const context = screen.getByPlaceholderText('200,000') as HTMLInputElement
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '20' } })
    catalogRow = reportedRow
    dispatchModelConnectionsUpdated('local-ai')
    await thinkingRow(container)
    await pause()
    expect(context.value).toBe('20')
    expect((screen.getByPlaceholderText('4,000') as HTMLInputElement).value).toBe('128')
    expect(posts).toEqual([])
    expect(record).toEqual(before)
    // Revert before leaving the field, so cleanup cannot admit a draft save.
    await fireEvent.input(context, { target: { value: '8,192' } })
    await fireEvent.blur(context)
  })
})
