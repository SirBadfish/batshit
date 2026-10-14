import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import AdminWebSearchCard from './AdminWebSearchCard.svelte'

/**
 * BL-939 (BL-945 b): the help text of the default provider picker said that Exa and Perplexity
 * appear only after their API keys are saved. Since BL-909 a saved choice whose key is not
 * ready stays in the list, marked "(Missing API key)" (the Agent picker's words), so the sentence
 * has to say both: a new pick needs a key, and a saved choice without one stays and says so.
 */

function ensureBrowserStubs() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
}

describe('Admin Web Search help text (BL-939)', () => {
  it('says that a saved choice without a key stays in the list, marked Missing API key', async () => {
    ensureBrowserStubs()
    render(AdminWebSearchCard, {
      props: {
        defaultProvider: 'exa',
        defaultProviderLabel: 'Exa (Missing API key)',
        exaType: 'auto',
        perplexityMaxTokensPerPage: 1024,
        providerOptions: [
          { value: 'duckduckgo-html', label: 'DuckDuckGo (built-in, no key)' },
          { value: 'exa', label: 'Exa (Missing API key)' }
        ],
        providerAvailability: { exa: false, perplexity: false },
        loadingProviders: false,
        providerError: null,
        disabled: false,
        onProviderChange: () => {},
        onExaTypeChange: () => {},
        onPerplexityMaxTokensPerPageChange: () => {}
      }
    })

    const trigger = screen.getByRole('button', { name: 'About Global Default Web Search Provider' })
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.queryByText(/DuckDuckGo is always available/)).not.toBeNull())
    const help = screen.getByText(/DuckDuckGo is always available/).textContent ?? ''

    expect(help).toContain('Missing API key')
    // The old claim, that a provider appears only after its key is saved, is gone.
    expect(help).not.toMatch(/appear here after/i)
  }, 30_000)
})
