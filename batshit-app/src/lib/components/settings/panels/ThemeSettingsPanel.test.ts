import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThemeSettingsPanel from './ThemeSettingsPanel.svelte'
import { confirmUserSettings, getUserSettings, resetUserSettings } from '$lib/stores/userSettings.svelte'

// The Themes panel (Josh, 2026-10-29): opening it saves nothing; one click saves the look and
// repaints <html data-look>; a refused save puts the saved look back and says so.
describe('ThemeSettingsPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    document.documentElement.dataset.look = 'cave'
    confirmUserSettings({ appearance_settings: { look: 'cave' } })
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetUserSettings()
    delete document.documentElement.dataset.look
  })

  it('shows the saved look and saves nothing when it opens', async () => {
    render(ThemeSettingsPanel)
    expect(screen.getByRole('radio', { name: 'Cave' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Minimal' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'OG' })).toHaveAttribute('aria-checked', 'false')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('saves a new look with one click and keeps it painted on the root', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, settings: { appearance_settings: { look: 'minimal' } } }), { status: 200 }))
    render(ThemeSettingsPanel)
    await fireEvent.click(screen.getByRole('radio', { name: 'Minimal' }))
    expect(document.documentElement.dataset.look).toBe('minimal')
    await waitFor(() => expect(getUserSettings()?.appearance_settings).toEqual({ look: 'minimal' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/user/settings')
    expect(JSON.parse(init.body)).toEqual({ appearance_settings: { look: 'minimal' } })
    expect(document.documentElement.dataset.look).toBe('minimal')
  })

  it('puts the saved look back and shows the reason when the save is refused', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'appearance_settings.look must be one of cave, minimal, og.' }), { status: 400 }))
    render(ThemeSettingsPanel)
    await fireEvent.click(screen.getByRole('radio', { name: 'OG' }))
    await screen.findByText('appearance_settings.look must be one of cave, minimal, og.')
    expect(document.documentElement.dataset.look).toBe('cave')
    expect(getUserSettings()?.appearance_settings).toEqual({ look: 'cave' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
