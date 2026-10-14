import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import AutoCompactSettingsCard from './AutoCompactSettingsCard.svelte'

/**
 * BL-487: when `GET /api/user/settings` fails, `AutoCompactSettingsCard` toasted an error but
 * kept `settings` on empty defaults and left the card editable. The next edit's autosave wrote
 * `global_auto_compact_settings` whole (the route replaces the block, it does not merge),
 * silently erasing the saved compact prompt and preset. Fix: a `settingsLoaded` flag. Until a
 * load succeeds, the autosave effect refuses with a visible error, and a Retry control reloads.
 *
 * Renders the REAL card; `fetch` answers its loads and records every save attempt.
 */

type Saved = { body: any }

function stubFetch(opts: { settingsOk: boolean; settings?: Record<string, unknown> }) {
  const saves: Saved[] = []
  let settingsOk = opts.settingsOk
  const settings = opts.settings ?? {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/user/settings' && method === 'GET') {
        if (!settingsOk) {
          return new Response(JSON.stringify({ error: 'Redis unavailable' }), { status: 500 })
        }
        return new Response(JSON.stringify({ settings }), { status: 200 })
      }
      if (url === '/api/user/settings' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        saves.push({ body })
        return new Response(JSON.stringify({ settings: { ...settings, ...body } }), { status: 200 })
      }
      if (url === '/api/user/saved-models') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 501 })
    })
  )
  return { saves, setSettingsOk: (value: boolean) => (settingsOk = value) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Auto Compact: a failed settings load refuses saves (BL-487)', () => {
  it('shows a load error and Retry, and never sends a save while unloaded', async () => {
    const { saves, setSettingsOk } = stubFetch({ settingsOk: false })
    render(AutoCompactSettingsCard, {
      props: { data: { user: { id: 'u1' }, userSettings: null } }
    })

    await waitFor(() =>
      expect(screen.queryByText('Loading Auto Compact settings...')).toBeNull()
    )
    await waitFor(() => expect(screen.getByText('Redis unavailable')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()

    // Change Automatic Behavior while the load is still failed.
    const behaviorTrigger = screen.getByRole('button', { name: 'Ask first' })
    await fireEvent.keyDown(behaviorTrigger, { key: 'ArrowDown' })
    const offOption = await screen.findByRole('option', { name: 'Off', exact: true })
    await fireEvent.pointerUp(offOption, { pointerType: 'mouse' })

    // Give the (now-refused) debounced save every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 700))

    expect(saves).toHaveLength(0)
    expect(
      screen.getByText(/failed to load, so this change cannot be saved yet/i)
    ).toBeTruthy()

    // Retry with a healthy load: the next edit now saves for real.
    setSettingsOk(true)
    await fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.queryByText('Redis unavailable')).toBeNull())

    // The earlier refusal must not survive a successful reload (BL-487 follow-up): without
    // clearing saveError on load success, this text is stuck forever because the effect's own
    // `signature === persistedSignature` guard fires first the next time it runs.
    await waitFor(() =>
      expect(
        screen.queryByText(/failed to load, so this change cannot be saved yet/i)
      ).toBeNull()
    )

    const behaviorTriggerAgain = screen.getByRole('button', { name: 'Ask first' })
    await fireEvent.keyDown(behaviorTriggerAgain, { key: 'ArrowDown' })
    const offOptionAgain = await screen.findByRole('option', { name: 'Off', exact: true })
    await fireEvent.pointerUp(offOptionAgain, { pointerType: 'mouse' })

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_auto_compact_settings.mode).toBe('off')
  })
})
