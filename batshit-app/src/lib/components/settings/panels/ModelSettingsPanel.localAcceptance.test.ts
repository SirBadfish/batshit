import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelSettingsPanel from './ModelSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
import type { SavedModel } from '$lib/types/savedModels'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import { getModelPresetDrafts, waitForModelPresetSaves } from '../models/modelPresetAutosave'
import { getSavedModels } from '$lib/stores/savedModels.svelte'

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), message: vi.fn() }))
vi.mock('$lib/components/ui/sonner/settings-toast', () => ({ toast: toastMock }))

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver
const modelId = 'koboldcpp/Qwen3.5-9B-Q4_K_M'
const row: CatalogModel = {
  id: `koboldcpp/${modelId}`, canonicalId: `koboldcpp/${modelId}`,
  provider: 'koboldcpp', name: modelId, displayName: 'Qwen3.5 9B', tags: ['local'],
  features: { streaming: true }, source: 'local', transport: 'local',
  connectionId: 'direct:koboldcpp', availableConnections: ['direct:koboldcpp'],
  upstreamProvider: 'local', purpose: 'chat', servesEveryRequest: true,
  localContext: { source: 'loaded', loadedContextWindow: 16384, maxContextWindow: null, remainingTtlSeconds: null }
}
const connection: CatalogConnectionOption = {
  id: 'direct:koboldcpp', label: 'KoboldCpp (Local)', transport: 'direct', service: 'koboldcpp',
  providers: ['koboldcpp'], status: 'ready'
}
function preset(id = 'first', overrides: Partial<SavedModel> = {}): SavedModel {
  return {
    id, modelName: id === 'first' ? 'First preset' : 'Second preset', modelId, provider: 'koboldcpp',
    settings: { maxTokens: 8192 }, pricing: {}, purpose: 'chat',
    connection: { id: connection.id, type: 'direct', service: 'koboldcpp', useDeveloperPrefix: false },
    createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', ...overrides
  } as SavedModel
}
let records: SavedModel[]
let posts: { body: SavedModel; release: () => void }[]
let delayed: boolean
let enabled: boolean
let ollama: boolean
let failed: boolean

function renderPanel() {
  return render(TooltipProviderWrapper as any, { props: { component: ModelSettingsPanel, props: { active: true } } })
}
function field(placeholder: string) {
  return screen.getByPlaceholderText(placeholder) as HTMLInputElement
}
async function readyEditor() {
  await waitFor(() => expect(field('4,000').value).toBeTruthy(), { timeout: 10000 })
}
const pause = () => new Promise(resolve => setTimeout(resolve, 750))

async function chooseLocalModel() {
    const provider = await waitFor(() => {
      const trigger = screen.getByRole('button', { name: 'Choose provider' }) as HTMLButtonElement
      expect(trigger.disabled).toBe(false)
      return trigger
    }, { timeout: 10000 })
    await fireEvent.keyDown(provider, { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: /KoboldCpp \(Local\)/ }), { pointerType: 'mouse' })
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Choose developer' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: /KoboldCpp/ }), { pointerType: 'mouse' })
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Choose model' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: /Qwen3.5 9B/ }), { pointerType: 'mouse' })
}

describe('grouped Local AI preset acceptance', () => {
  beforeEach(() => {
    records = [preset()]; posts = []; delayed = false; enabled = true; ollama = false; failed = false
    Object.values(toastMock).forEach(mock => mock.mockClear())
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
    if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', {
      configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null })
    })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/user/saved-models') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        return await new Promise<Response>(resolve => {
          const release = () => {
            if (failed) { resolve(new Response(JSON.stringify({ error: 'Storage refused this save' }), { status: 500 })); return }
            const saved = { ...body, id: body.id || 'created', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:01Z' }
            records = [saved, ...records.filter(record => record.id !== saved.id)]
            resolve(new Response(JSON.stringify({ success: true, model: saved }), { status: 200 }))
          }
          posts.push({ body, release })
          if (!delayed) release()
        })
      }
      if (url.startsWith('/api/user/saved-models')) return new Response(JSON.stringify({ models: records, meta: {} }))
      if (url.startsWith('/api/models')) {
        const chosenConnection = ollama ? { ...connection, id: 'direct:ollama', service: 'ollama', providers: ['ollama'], label: 'Ollama (Local)' } : connection
        const chosenRow = ollama ? { ...row, id: 'ollama/qwen:9b', canonicalId: 'ollama/qwen:9b', provider: 'ollama', name: 'qwen:9b', connectionId: 'direct:ollama', availableConnections: ['direct:ollama'], servesEveryRequest: false } : row
        return new Response(JSON.stringify({ success: true, data: {
          models: enabled ? [chosenRow] : [], connections: [{ ...chosenConnection, status: enabled ? 'ready' : 'locked', lockedReason: enabled ? undefined : 'Enable this runtime in Settings → Local AI.' }]
        } }))
      }
      if (url.startsWith('/api/compatibility-matrix')) return new Response(JSON.stringify({ data: { version: 1, fetchedAt: null, entries: [] } }))
      return new Response('{}')
    }) as typeof fetch
  })
  afterEach(async () => {
    cleanup()
    delayed = false
    posts.forEach(post => post.release())
    await waitForModelPresetSaves()
    getModelPresetDrafts().clear()
    globalThis.fetch = originalFetch
    globalThis.ResizeObserver = originalResizeObserver
    vi.restoreAllMocks()
  })

  it('creates normally with output headroom, keeps published context unknown, and reopens the saved default', async () => {
    records = []
    const mounted = renderPanel()
    await chooseLocalModel()
    const create = await waitFor(() => {
      const button = screen.getByRole('button', { name: /Use to Create New Preset/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      return button
    }, { timeout: 10000 })
    await fireEvent.click(create)
    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 10000 })
    expect(posts[0].body.id).toBeFalsy()
    expect(posts[0].body.settings?.maxTokens).toBe(8192)
    expect(posts[0].body.contextWindow).toBeUndefined()
    await waitFor(() => expect(field('4,000').value).toBe('8,192'))
    expect(field('200,000').value).toBe('')
    mounted.unmount()
    renderPanel()
    await readyEditor()
    expect(field('4,000').value).toBe('8,192')
    await pause()
    expect(posts).toHaveLength(1) // hydration does not autosave
  }, 30000)

  it('holds blank and partial context drafts until blur without clamping output to the partial number', async () => {
    renderPanel(); await readyEditor()
    const context = field('200,000')
    await fireEvent.focus(context)
    for (const value of ['', '2', '20', '200']) await fireEvent.input(context, { target: { value } })
    await pause()
    expect(posts).toHaveLength(0)
    expect(context.value).toBe('200')
    expect(field('4,000').value).toBe('8,192')
    await fireEvent.input(context, { target: { value: '16384' } })
    await fireEvent.blur(context)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.contextWindow).toBe(16384)
    expect(posts[0].body.settings?.maxTokens).toBe(8192)
  }, 30000)

  it('keeps incomplete numeric formats visible, explains invalid commits, and accepts Enter after correction', async () => {
    const { container } = renderPanel(); await readyEditor()
    const context = field('200,000')
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '200000.' } })
    await pause()
    expect(context.value).toBe('200000.')
    expect(posts).toHaveLength(0)
    await fireEvent.blur(context)
    expect(context.value).toBe('200000.')
    expect(container.textContent).toContain('Context Window must be a positive whole number')
    await pause()
    expect(posts).toHaveLength(0)
    await fireEvent.input(context, { target: { value: '200000' } })
    await fireEvent.keyDown(context, { key: 'Enter' })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(context.value).toBe('200,000')
    expect(posts[0].body.contextWindow).toBe(200000)
    expect(posts[0].body.settings?.maxTokens).toBe(8192)
    expect(container.textContent).not.toContain('Context Window must be a positive whole number')
    const output = field('4,000')
    await fireEvent.focus(output)
    await fireEvent.input(output, { target: { value: '8,19' } })
    await fireEvent.keyDown(output, { key: 'Enter' })
    expect(output.value).toBe('8,19')
    expect(container.textContent).toContain('Max Output Tokens must be a positive whole number')
    await pause()
    expect(posts).toHaveLength(1)
  }, 30000)

  it('attaches a created id without replacing text typed while creation is pending', async () => {
    records = []; delayed = true
    renderPanel(); await chooseLocalModel()
    await fireEvent.click(screen.getByRole('button', { name: /Use to Create New Preset/i }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'My later name' } })
    const context = field('200,000')
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '200' } })
    posts[0].release()
    await pause()
    expect(context.value).toBe('200')
    expect(field('Claude 3 Sonnet').value).toBe('My later name')
    expect(posts).toHaveLength(1)
    await fireEvent.input(context, { target: { value: '16384' } })
    await fireEvent.blur(context)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body.id).toBe('created')
    expect(posts[1].body.modelName).toBe('My later name')
    expect(posts[1].body.settings?.maxTokens).toBe(8192)
  }, 30000)

  it('shows the bounded output that a completed save actually stores, without migrating on open', async () => {
    records = [preset('first', { settings: { maxTokens: 16384 } })]
    renderPanel(); await readyEditor()
    expect(field('4,000').value).toBe('16,384')
    await pause()
    expect(posts).toHaveLength(0)
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Renamed safely' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.settings?.maxTokens).toBe(8192)
    expect(field('4,000').value).toBe('8,192')
  }, 30000)

  it('keeps a later numeric draft when an earlier save answers', async () => {
    delayed = true
    const { container } = renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Renamed' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    const context = field('200,000')
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '200000.' } })
    await fireEvent.blur(context)
    expect(container.textContent).toContain('Context Window must be a positive whole number')
    posts[0].release()
    await pause()
    expect(context.value).toBe('200000.')
    expect(container.textContent).toContain('Context Window must be a positive whole number')
    expect(field('4,000').value).toBe('8,192')
    expect(posts).toHaveLength(1)
    await fireEvent.input(context, { target: { value: '16384' } })
    await fireEvent.blur(context)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body.contextWindow).toBe(16384)
    expect(posts[1].body.settings?.maxTokens).toBe(8192)
  }, 30000)

  it('keeps the selected preset and serializes newer writes behind an older outstanding answer', async () => {
    delayed = true; records.push(preset('second'))
    renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'First renamed' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.click(screen.getByRole('button', { name: /Second preset/ }))
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Second renamed' } })
    await pause()
    expect(posts).toHaveLength(1)
    posts[0].release()
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(field('Claude 3 Sonnet').value).toBe('Second renamed')
    expect(posts[1].body.id).toBe('second')
  }, 30000)

  it.each(['queued', 'admitted'])('preserves a %s edit across A → B → A', async phase => {
    delayed = true; records.push(preset('second'))
    renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'First retained' } })
    if (phase === 'admitted') await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.click(screen.getByRole('button', { name: /Second preset/ }))
    await fireEvent.click(screen.getByRole('button', { name: /First preset/ }))
    expect(field('Claude 3 Sonnet').value).toBe('First retained')
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'First latest' } })
    await pause()
    if (phase === 'admitted') posts[0].release()
    await waitFor(() => expect(posts).toHaveLength(phase === 'admitted' ? 2 : 1))
    expect(posts.at(-1)!.body.modelName).toBe('First latest')
    expect(field('Claude 3 Sonnet').value).toBe('First latest')
  }, 30000)

  it('flushes completed edits after close, publishes them, and reads fresh state before reopening', async () => {
    delayed = true
    const mounted = renderPanel(); await readyEditor()
    const context = field('200,000')
    await fireEvent.focus(context)
    await fireEvent.input(context, { target: { value: '16384' } })
    await fireEvent.blur(context)
    mounted.unmount()
    renderPanel()
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(screen.queryByPlaceholderText('4,000')).toBeNull()
    posts[0].release()
    await readyEditor()
    expect(field('200,000').value).toBe('16,384')
    expect(getSavedModels().find(model => model.id === 'first')?.contextWindow).toBe(16384)
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'After reopen' } })
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body.contextWindow).toBe(16384)
  }, 30000)

  it('finishes a queued successor behind an admitted save before a reopened editor can write', async () => {
    delayed = true
    const mounted = renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Admitted name' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.focus(field('200,000'))
    await fireEvent.input(field('200,000'), { target: { value: '16384' } })
    await fireEvent.blur(field('200,000'))
    await pause()
    mounted.unmount(); renderPanel()
    expect(posts).toHaveLength(1)
    posts[0].release()
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(screen.queryByPlaceholderText('4,000')).toBeNull()
    posts[1].release()
    await readyEditor()
    expect(field('200,000').value).toBe('16,384')
    expect(field('Claude 3 Sonnet').value).toBe('Admitted name')
  }, 30000)

  it('retains an unfinished numeric draft across close and reopen without saving the partial number', async () => {
    const mounted = renderPanel(); await readyEditor()
    await fireEvent.focus(field('200,000'))
    await fireEvent.input(field('200,000'), { target: { value: '200' } })
    mounted.unmount(); renderPanel(); await readyEditor()
    await pause()
    expect(field('200,000').value).toBe('200')
    expect(posts).toHaveLength(0)
    await fireEvent.input(field('200,000'), { target: { value: '16384' } })
    await fireEvent.blur(field('200,000'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.contextWindow).toBe(16384)
  }, 30000)

  it('keeps failed off-selection intent and makes the failure visible', async () => {
    delayed = true; records.push(preset('second'))
    const { container } = renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Failed name' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.click(screen.getByRole('button', { name: /Second preset/ }))
    failed = true; posts[0].release()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Could not save model preset "Failed name"')))
    await fireEvent.click(screen.getByRole('button', { name: /First preset/ }))
    expect(field('Claude 3 Sonnet').value).toBe('Failed name')
    expect(container.textContent).toContain('Storage refused this save')
    await pause()
    expect(posts).toHaveLength(1)
    failed = false
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body.modelName).toBe('Failed name')
    posts[1].release()
    await waitFor(() => expect(container.textContent).not.toContain('Storage refused this save'))
  }, 30000)

  it('returns to idle when reverting an edit before its debounce admits it', async () => {
    const { container } = renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Temporary' } })
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'First preset' } })
    await pause()
    expect(posts).toHaveLength(0)
    expect(container.textContent).not.toContain('Saving')
  }, 30000)

  it('retains a failed draft after close/reopen and retries only when requested', async () => {
    delayed = true
    const mounted = renderPanel(); await readyEditor()
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Closed failed draft' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    mounted.unmount(); const reopened = renderPanel()
    failed = true; posts[0].release(); await readyEditor()
    expect(field('Claude 3 Sonnet').value).toBe('Closed failed draft')
    expect(reopened.container.textContent).toContain('Storage refused this save')
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Closed failed draft'))
    await pause()
    expect(posts).toHaveLength(1)
    failed = false
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    posts[1].release()
  }, 30000)

  it('publishes a created preset after close and preserves its later draft on reopen', async () => {
    records = []; delayed = true
    const mounted = renderPanel(); await chooseLocalModel()
    await fireEvent.click(screen.getByRole('button', { name: /Use to Create New Preset/i }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Later created name' } })
    await fireEvent.focus(field('200,000'))
    await fireEvent.input(field('200,000'), { target: { value: '200' } })
    mounted.unmount(); renderPanel()
    posts[0].release(); await readyEditor()
    expect(getSavedModels().some(model => model.id === 'created')).toBe(true)
    expect(field('Claude 3 Sonnet').value).toBe('Later created name')
    expect(field('200,000').value).toBe('200')
    expect(posts).toHaveLength(1)
  }, 30000)

  it('finishes a completed create successor after close before the reopened editor reads it', async () => {
    records = []; delayed = true
    const mounted = renderPanel(); await chooseLocalModel()
    await fireEvent.click(screen.getByRole('button', { name: /Use to Create New Preset/i }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Completed create successor' } })
    mounted.unmount(); renderPanel()
    posts[0].release()
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(screen.queryByPlaceholderText('4,000')).toBeNull()
    expect(posts[1].body.id).toBe('created')
    expect(posts[1].body.modelName).toBe('Completed create successor')
    posts[1].release(); await readyEditor()
    expect(field('Claude 3 Sonnet').value).toBe('Completed create successor')
    expect(records.find(model => model.id === 'created')?.modelName).toBe('Completed create successor')
  }, 30000)

  it('restores a failed new-create draft after close and retries it explicitly', async () => {
    records = []; delayed = true
    const mounted = renderPanel(); await chooseLocalModel()
    await fireEvent.click(screen.getByRole('button', { name: /Use to Create New Preset/i }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await fireEvent.input(field('Claude 3 Sonnet'), { target: { value: 'Recover my create' } })
    mounted.unmount(); const reopened = renderPanel()
    failed = true; posts[0].release(); await readyEditor()
    expect(field('Claude 3 Sonnet').value).toBe('Recover my create')
    expect(reopened.container.textContent).toContain('Storage refused this save')
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Could not create model preset'))
    await pause()
    expect(posts).toHaveLength(1)
    failed = false
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body.modelName).toBe('Recover my create')
    expect(posts[1].body.id).toBeFalsy()
    posts[1].release()
    await waitFor(() => expect(getSavedModels().some(model => model.modelName === 'Recover my create')).toBe(true))
  }, 30000)

  it('commits a cleared context as unknown and retains an intentionally small output', async () => {
    records = [preset('first', { contextWindow: 16384, settings: { maxTokens: 100 } })]
    renderPanel(); await readyEditor()
    await fireEvent.focus(field('200,000'))
    await fireEvent.input(field('200,000'), { target: { value: '' } })
    await fireEvent.blur(field('200,000'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.contextWindow).toBeUndefined()
    expect(posts[0].body.settings?.maxTokens).toBe(100)
    const output = field('4,000')
    await fireEvent.focus(output)
    await fireEvent.input(output, { target: { value: '' } })
    await pause()
    expect(posts).toHaveLength(1)
    expect(output.value).toBe('')
    await fireEvent.input(output, { target: { value: '200' } })
    await fireEvent.blur(output)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body.settings?.maxTokens).toBe(200)
  }, 30000)

  it('shows the requested Ollama allocation separately from a smaller preset budget and updates the draft live', async () => {
    ollama = true
    records = [preset('first', {
      provider: 'ollama', modelId: 'qwen:9b', contextWindow: 4096,
      settings: { maxTokens: 100, ollamaNumCtx: 8192 },
      connection: { id: 'direct:ollama', type: 'direct', service: 'ollama' }
    })]
    const { container } = renderPanel(); await readyEditor()
    await waitFor(() => expect(container.textContent).toContain('Ollama will be asked to use 8,192 tokens for this request.'))
    expect(container.textContent).toContain('Batshit plans against the smaller preset limit of 4,096 tokens.')
    expect(container.textContent).not.toContain('Batshit plans against 16,384')
    expect(posts).toHaveLength(0) // opening this evidence does not change saved settings
    await fireEvent.focus(field('200,000'))
    await fireEvent.input(field('200,000'), { target: { value: '2048' } })
    await waitFor(() => expect(container.textContent).toContain('Batshit plans against the smaller preset limit of 2,048 tokens.'))
    expect(container.textContent).toContain('Ollama will be asked to use 8,192 tokens for this request.')
    expect(posts).toHaveLength(0) // an uncommitted context draft leaves the native request untouched
  }, 30000)

  it('explains disabled Ollama and refreshes discovery after the existing enablement event', async () => {
    ollama = true; enabled = false
    records = [preset('first', { provider: 'ollama', modelId: 'qwen:9b', connection: { id: 'direct:ollama', type: 'direct', service: 'ollama' } })]
    const { container } = renderPanel(); await readyEditor()
    await waitFor(() => expect(container.textContent).toContain('Ollama (Local) is disabled. Enable it in Settings → Local AI to discover its models.'))
    expect(container.textContent).toContain('No models available')
    enabled = true
    dispatchModelConnectionsUpdated('local-ai')
    await waitFor(() => expect(container.textContent).not.toContain('Ollama (Local) is disabled.'))
    expect(container.textContent).not.toContain('No models available')
    expect(posts).toHaveLength(0)
  }, 30000)
})
