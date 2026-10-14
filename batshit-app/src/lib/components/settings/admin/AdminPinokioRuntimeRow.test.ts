import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminPinokioRuntimeRow from './AdminPinokioRuntimeRow.svelte'

/**
 * SA-072 P1 (DL-01): Settings → Admin → Runtimes shows one read-only Pinokio line and nothing
 * else: a badge, the detection sentence, and a Refresh that asks again. No setting, no save.
 */

function installFetch(pinokio: Record<string, unknown>) {
  const urls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
    expect(init?.method ?? 'GET').toBe('GET')
    return { ok: true, status: 200, json: async () => ({ pinokio }) }
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
  return { urls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AdminPinokioRuntimeRow', () => {
  it('shows Detected and the version line when Pinokio runs', async () => {
    const { urls } = installFetch({
      available: true,
      reason: null,
      message: 'Pinokio 8.2.0 detected at /Users/fixture/pinokio.',
      version: '8.2.0',
      versionFloor: '8.2.0'
    })
    render(AdminPinokioRuntimeRow, { props: { open: true, onToggle: () => {} } })
    expect(await screen.findByText('Detected')).toBeTruthy()
    expect((await screen.findByTestId('pinokio-runtime-line')).textContent?.trim()).toBe(
      'Pinokio 8.2.0 detected at /Users/fixture/pinokio.'
    )
    expect(urls).toEqual(['/api/pinokio/status'])
  })

  it('says Not Detected when Pinokio is absent, and Refresh asks again for a fresh answer', async () => {
    const { urls } = installFetch({
      available: false,
      reason: 'not_installed',
      message: 'Pinokio not detected.',
      version: null,
      versionFloor: '8.2.0'
    })
    render(AdminPinokioRuntimeRow, { props: { open: true, onToggle: () => {} } })
    expect(await screen.findByText('Not Detected')).toBeTruthy()
    expect((await screen.findByTestId('pinokio-runtime-line')).textContent?.trim()).toBe('Pinokio not detected.')
    await fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(urls).toEqual(['/api/pinokio/status', '/api/pinokio/status?fresh=1']))
  })

  it('says Not Running when Pinokio is installed but closed', async () => {
    installFetch({
      available: false,
      reason: 'not_running',
      message: 'Pinokio is installed but not running. Open Pinokio, then try again.',
      version: '8.2.0',
      versionFloor: '8.2.0'
    })
    render(AdminPinokioRuntimeRow, { props: { open: false, onToggle: () => {} } })
    expect(await screen.findByText('Not Running')).toBeTruthy()
  })
})
