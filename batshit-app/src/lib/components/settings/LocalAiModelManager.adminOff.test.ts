import { cleanup, render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalAiModelManager from './LocalAiModelManager.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.restoreAllMocks() })

describe('Kobold serving status without admin', () => {
  function mount(model: string | null, enabled = true) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, state: {
      programId: 'koboldcpp', label: 'KoboldCpp', manageable: false,
      reason: 'Cannot switch models without admin mode.',
      canLoad: false, canUnload: false, canDownload: false, restartsOnSwitch: true, models: [],
      running: { model, contextLength: model ? 16384 : null, chatTemplates: true, guidance: false }
    } })))
    globalThis.fetch = fetchMock as typeof fetch
    const view = render(TooltipProviderWrapper as any, { props: {
      component: LocalAiModelManager, props: { programId: 'koboldcpp', enabled }
    } })
    return { ...view, fetchMock }
  }

  it('shows the running model/context and optional switching notice with no restart or write', async () => {
    const { container, fetchMock } = mount('Qwen3.5-9B-Q4_K_M')
    await waitFor(() => expect(container.textContent).toContain('Running Qwen3.5-9B-Q4_K_M at 16,384 tokens.'))
    expect(container.textContent).toContain('The loaded model is available for chat.')
    expect(container.textContent).toContain('Admin mode is optional and only needed to switch models here.')
    expect(container.textContent).toContain('Cannot switch models without admin mode.')
    expect(container.querySelectorAll('button')).toHaveLength(1) // refresh only
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]).toEqual(['/api/settings/local-ai/models?program=koboldcpp'])
  })

  it('does not claim usable chat when no model is loaded', async () => {
    const { container } = mount(null)
    await waitFor(() => expect(container.textContent).toContain('No model loaded.'))
    expect(container.textContent).not.toContain('available for chat')
  })

  it('keeps disabled management visibly disabled', async () => {
    const { container } = mount('Qwen', false)
    await waitFor(() => expect(container.textContent).toContain('Turn this program on above'))
    expect(container.textContent).not.toContain('available for chat')
    expect(container.querySelector('button')?.disabled).toBe(true)
  })
})
