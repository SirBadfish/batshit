/**
 * Packet 5 finding 1: a custom provider whose saved key is missing or cannot be
 * read reads "Not Configured" with what to do, never "Ready".
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CustomProvidersSettingsPanel from './CustomProvidersSettingsPanel.svelte'

const originalFetch = globalThis.fetch
const REASON =
  'The saved API key of this custom provider is missing or cannot be read. ' +
  'Enter its API key again under Settings → API Keys → Custom OpenAI-Compatible.'

const provider = (id: string, label: string, apiKeyUsable: boolean) => ({
  id,
  label,
  baseUrl: `https://${id}.invalid/v1`,
  maskedKey: apiKeyUsable ? '****...1234' : '****',
  apiKeyUsable,
  createdAt: '',
  updatedAt: ''
})

describe('Custom Providers panel and the saved key', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('shows Not Configured and the reason for a provider without a usable key; Ready otherwise', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          providers: [provider('custom_ok', 'Working Host', true), provider('custom_restored', 'Restored Host', false)]
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch

    const { container } = render(CustomProvidersSettingsPanel, { props: { embedded: true } })
    await waitFor(() => expect(container.textContent).toContain('Restored Host'))

    const cards = Array.from(container.querySelectorAll('.batshit-settings-card'))
    const working = cards.find((card) => card.textContent?.includes('Working Host'))
    const restored = cards.find((card) => card.textContent?.includes('Restored Host'))
    expect(working?.textContent).toContain('Ready')
    expect(working?.textContent).not.toContain(REASON)
    expect(restored?.textContent).toContain('Not Configured')
    expect(restored?.textContent).not.toContain('Ready')
    expect(restored?.textContent).toContain(REASON)

    // Editing it asks for the key instead of offering to keep a key it does not have.
    const edit = Array.from(restored!.querySelectorAll('button')).find((button) => button.textContent?.includes('Edit'))
    await fireEvent.click(edit!)
    const keyInput = await waitFor(() => {
      const input = container.querySelector<HTMLInputElement>('#custom-provider-api-key')
      expect(input).toBeTruthy()
      return input!
    })
    expect(keyInput.placeholder).toBe('Enter its API key')
  })
})
