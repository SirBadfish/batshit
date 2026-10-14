/**
 * BL-866: Claude Sonnet 5.5 cannot turn thinking off (Anthropic answers 400 to `disabled` and to
 * `enabled`); Between tools is its lowest setting. The Models panel's Thinking mode select reads
 * a saved value through the schema's `savedValueAliases` and `onlyListedValues`:
 *
 *   - a saved `disabled` on Sonnet 5.5 shows as "Between tools (lowest)", the choice the send
 *     builds from it, so the field says what goes on the wire;
 *   - a saved `enabled` is not swapped: the select shows the raw saved word and an amber note
 *     beside the label carries the sentence a send would be refused with;
 *   - the alias is Sonnet 5.5's alone: Sonnet 4.5 still shows `disabled` as "Disabled";
 *   - opening the panel writes nothing.
 *
 * This renders the real Models panel against the HTTP answers it loads on mount and drives the
 * Reasoning section the way a user does, so it pins the wiring and not only the schema.
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

const SONNET_5_5 = 'claude-sonnet-5-5'
const SONNET_4_5 = 'claude-sonnet-4-5'

/** What `/api/models` lists for a direct Anthropic connection. */
function directAnthropicRow(modelId: string, displayName: string): CatalogModel {
  return {
    id: `anthropic/${modelId}`,
    canonicalId: `anthropic/${modelId}`,
    provider: 'anthropic',
    upstreamProvider: 'anthropic',
    name: modelId,
    displayName,
    tags: [],
    features: { streaming: true, tools: true, vision: true },
    purpose: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { input: 3, output: 15 },
    source: 'direct',
    transport: 'direct',
    connectionId: 'direct:anthropic',
    availableConnections: ['direct:anthropic'],
    idVariants: {
      'direct:anthropic': {
        developerId: 'anthropic',
        modelId,
        effectiveId: modelId,
        source: 'direct'
      }
    }
  }
}

const CATALOG: CatalogModel[] = [
  directAnthropicRow(SONNET_5_5, 'Claude Sonnet 5.5'),
  directAnthropicRow(SONNET_4_5, 'Claude Sonnet 4.5')
]

const CONNECTIONS: CatalogConnectionOption[] = [
  {
    id: 'direct:anthropic',
    label: 'Anthropic (Direct)',
    transport: 'direct',
    service: 'anthropic',
    providers: ['anthropic'],
    status: 'ready'
  }
]

/** A direct Anthropic preset that holds the given Thinking mode. */
function presetWithThinkingMode(modelId: string, thinkingMode: string): SavedModel {
  return {
    id: `zb_${modelId.replace(/[^a-z0-9]+/gi, '_')}_direct`,
    modelName: `Preset for ${modelId}`,
    modelId,
    provider: 'anthropic',
    catalogModelId: `anthropic/${modelId}`,
    effectiveModelId: modelId,
    contextWindow: 200_000,
    pricing: { input: 3, output: 15 },
    settings: { thinkingMode },
    purpose: 'chat',
    connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic', useDeveloperPrefix: false },
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z'
  } as SavedModel
}

let fetchMock: ReturnType<typeof mockFetch>

/**
 * `holdSaves`: a save the panel starts never answers. The overwrite in the model-change case
 * saves the preset, and any answer would reload the list (this mock's list still holds the
 * Sonnet 4.5 preset) and rebuild the form under it; held, the form stays as the user left it.
 */
function mockFetch(preset: SavedModel, options: { holdSaves?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (options.holdSaves && url.startsWith('/api/user/saved-models') && method !== 'GET') {
      return new Promise<Response>(() => {})
    }
    if (url.startsWith('/api/user/saved-models') && method === 'GET') {
      return new Response(JSON.stringify({ models: [preset], meta: { purged: [] } }), { status: 200 })
    }
    if (url.startsWith('/api/models')) {
      return new Response(
        JSON.stringify({ success: true, data: { models: CATALOG, connections: CONNECTIONS } }),
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

/** The Thinking mode row, or a failed expectation while the Reasoning section is closed. */
function findThinkingModeRow(container: HTMLElement): HTMLElement {
  const label = Array.from(container.querySelectorAll('.batshit-settings-form-label')).find(
    (node) => node.textContent?.trim() === 'Thinking mode'
  )
  expect(label).toBeTruthy()
  const row = label!.closest('.batshit-settings-form-row') as HTMLElement | null
  expect(row).toBeTruthy()
  return row!
}

/** Opens the Reasoning section as a user does and returns the Thinking mode row. */
async function openThinkingModeRow(container: HTMLElement): Promise<HTMLElement> {
  const expand = await screen.findByRole('button', { name: 'Expand Reasoning' }, { timeout: 10_000 })
  await fireEvent.click(expand)
  return waitFor(() => findThinkingModeRow(container), { timeout: 10_000 })
}

function selectTriggerText(row: HTMLElement): string {
  const trigger = row.querySelector('[data-slot="select-trigger"]')
  expect(trigger).toBeTruthy()
  return (trigger!.textContent ?? '').trim()
}

/** Everything the panel sent that was not a plain read. */
function writesMade(): unknown[][] {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() !== 'GET')
}

/** The page sits open for a moment: nothing in it may save on its own. */
async function expectNothingWritten() {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  expect(writesMade()).toEqual([])
}

describe('BL-866 the Models panel shows the Thinking mode a Sonnet 5.5 send will use', () => {
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

  it('shows a saved Disabled on Sonnet 5.5 as Between tools (lowest), and saves nothing', async () => {
    fetchMock = mockFetch(presetWithThinkingMode(SONNET_5_5, 'disabled'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { container } = renderPanel()

    const row = await openThinkingModeRow(container)
    expect(selectTriggerText(row)).toBe('Between tools (lowest)')
    // Disabled is replaced, not refused: no amber note beside the label.
    expect(within(row).queryByRole('button', { name: 'Thinking mode not available' })).toBeNull()
    await expectNothingWritten()
  }, 30_000)

  it('shows a saved Enabled on Sonnet 5.5 as saved, with the refusal sentence beside it, and saves nothing', async () => {
    fetchMock = mockFetch(presetWithThinkingMode(SONNET_5_5, 'enabled'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { container } = renderPanel()

    const row = await openThinkingModeRow(container)
    // Nothing is swapped behind the user's back: the raw saved word stays in the select.
    expect(selectTriggerText(row)).toBe('enabled')

    // The note lives in an amber info menu; open it as a user does.
    const info = within(row).getByRole('button', { name: 'Thinking mode not available' })
    await fireEvent.pointerDown(info, { button: 0, pointerType: 'mouse' })
    const note = await screen.findByText(
      'Thinking mode "enabled" is not available on claude-sonnet-5-5. Choose Between tools (lowest), or clear it.',
      { exact: true },
      { timeout: 10_000 }
    )
    expect(note).toBeTruthy()
    await expectNothingWritten()
  }, 30_000)

  it('keeps a saved Disabled as Disabled on Sonnet 4.5: the alias is Sonnet 5.5 only, and saves nothing', async () => {
    fetchMock = mockFetch(presetWithThinkingMode(SONNET_4_5, 'disabled'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { container } = renderPanel()

    const row = await openThinkingModeRow(container)
    expect(selectTriggerText(row)).toBe('Disabled')
    expect(within(row).queryByRole('button', { name: 'Thinking mode not available' })).toBeNull()
    await expectNothingWritten()
  }, 30_000)

  it('shows a saved Disabled as Between tools when the model is changed to Sonnet 5.5 in the editor', async () => {
    // The value was saved while the preset named Sonnet 4.5, where Disabled is a real choice. The
    // user then picks Sonnet 5.5 for the same preset; the form still holds the word `disabled`,
    // and the select must show what a Sonnet 5.5 send builds from it.
    fetchMock = mockFetch(presetWithThinkingMode(SONNET_4_5, 'disabled'), { holdSaves: true })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { container } = renderPanel()

    const before = await openThinkingModeRow(container)
    expect(selectTriggerText(before)).toBe('Disabled')

    const modelLabel = Array.from(container.querySelectorAll('label')).find(
      (node) => node.textContent?.trim() === 'Model'
    )
    expect(modelLabel).toBeTruthy()
    const modelTrigger = modelLabel!.parentElement!.querySelector('[data-slot="select-trigger"]') as HTMLElement
    // Bits UI opens a Select from the keyboard in jsdom (its mouse path needs a real pointer).
    modelTrigger.focus()
    await fireEvent.keyDown(modelTrigger, { key: 'ArrowDown' })
    const sonnet55 = await waitFor(
      () => {
        const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) =>
          (node.textContent ?? '').includes('Claude Sonnet 5.5')
        )
        expect(option).toBeTruthy()
        return option as HTMLElement
      },
      { timeout: 10_000 }
    )
    // A Bits UI item selects on pointerup.
    await fireEvent.pointerUp(sonnet55, { button: 0, pointerType: 'mouse' })

    const overwrite = await waitFor(
      () => {
        const button = screen.getByRole('button', { name: /Overwrite Selected Preset/i }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        return button
      },
      { timeout: 10_000 }
    )
    await fireEvent.click(overwrite)

    // The Model select now names Sonnet 5.5, and the Thinking mode select follows it.
    await waitFor(() => expect((modelTrigger.textContent ?? '').trim()).toBe('Claude Sonnet 5.5'), {
      timeout: 10_000
    })
    await waitFor(() => expect(selectTriggerText(findThinkingModeRow(container))).toBe('Between tools (lowest)'), {
      timeout: 10_000
    })
  }, 30_000)
})
