import { render, screen, waitFor } from '@testing-library/svelte'
import { vi, describe, it, afterEach, expect } from 'vitest'
import DevSettingsPanel from './DevSettingsPanel.svelte'

// Minimal smoke test to ensure panel renders and fetches system clips without hanging.

describe('DevSettingsPanel – smoke', () => {
  const systemClips = [
    {
      id: 'clip_artifacts',
      filename: 'Artifacts Builder Guide',
      description: 'How to build and wire artifacts',
      systemClip: true,
      displayUrl: 'https://example.com/artifacts-guide'
    }
  ]

  const createFetchMock = () =>
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/clips')) {
        return Promise.resolve({ ok: true, json: async () => systemClips })
      }
      // Fallback for any other endpoint used by the component
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders system clips list', async () => {
    const fetchMock = createFetchMock()
    // @ts-expect-error test override
    global.fetch = fetchMock

    render(DevSettingsPanel, {
      props: {
        data: { user: { id: 'user_1' }, userSettings: null }
      }
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/clips'))
    await screen.findByText('Artifacts Builder Guide')
  })
})
