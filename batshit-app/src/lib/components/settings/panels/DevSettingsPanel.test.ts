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

  it('shows "Use paused plans on this copy" off by default and asks the server to switch it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      if (url === '/api/admin/paused-plans' && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({ usePausedPlans: true }) })
      }
      if (url === '/api/admin/paused-plans') {
        return Promise.resolve({ ok: true, json: async () => ({ usePausedPlans: false }) })
      }
      if (url.endsWith('/api/clips')) return Promise.resolve({ ok: true, json: async () => [] })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    // @ts-expect-error test override
    global.fetch = fetchMock

    render(DevSettingsPanel, { props: { data: { user: { id: 'user_1' }, userSettings: null } } })

    const toggle = await screen.findByRole('switch', { name: 'Use paused plans on this copy' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
    toggle.click()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    const put = calls.find((call) => call.init?.method === 'PUT')
    expect(put?.url).toBe('/api/admin/paused-plans')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ usePausedPlans: true })
  })
})
