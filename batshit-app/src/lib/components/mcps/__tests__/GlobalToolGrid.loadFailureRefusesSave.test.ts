import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import GlobalToolGrid from '../GlobalToolGrid.svelte'

/**
 * BL-487: when `GET /api/user/settings` fails, `loadZipSettings` (GlobalToolGrid.svelte)
 * showed an error but left the grid editable on EMPTY defaults. The next toggle wrote
 * `global_zip_settings` and `global_tool_grid_settings` whole (the route replaces each block,
 * it does not merge), silently erasing every saved per-tool zip override, Smart Zip, and CLI
 * discoverability setting. Fix: a `zipSettingsLoaded` flag. Until a load succeeds, every write
 * through `saveUserToolGridDefaults` refuses with a visible error, and a Retry control reloads.
 *
 * Renders the REAL grid; `fetch` answers the grid's loads and records every save attempt.
 */

type Saved = { url: string; body: any }

function stubFetch(opts: {
  settingsOk: boolean
  settings?: Record<string, unknown>
  gateways?: Array<Record<string, unknown>>
}) {
  const saves: Saved[] = []
  const gatewayPuts: Array<{ id: string; body: any }> = []
  let settingsOk = opts.settingsOk
  const settings = opts.settings ?? {}
  const gateways = opts.gateways ?? []
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
        saves.push({ url, body })
        return new Response(JSON.stringify({ settings: { ...settings, ...body } }), { status: 200 })
      }
      if (url === '/api/mcp/gateways') return new Response(JSON.stringify({ gateways }), { status: 200 })
      const gatewayPutMatch = url.match(/^\/api\/mcp\/gateways\/([^/]+)$/)
      if (gatewayPutMatch && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        gatewayPuts.push({ id: gatewayPutMatch[1], body })
        return new Response(JSON.stringify({ gateway: { ...body } }), { status: 200 })
      }
      if (url === '/api/cli-tools') return new Response(JSON.stringify({ tools: [] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 501 })
    })
  )
  return { saves, gatewayPuts, setSettingsOk: (value: boolean) => (settingsOk = value) }
}

// SA-129 DL-06 (BL-1484): the parked Zip Control Permissions select is gone; the AI Zip Layout
// select drives the strip's save instead.
function zipLayoutTrigger(): HTMLElement {
  const label = screen.getByText('AI Zip Layout', { selector: '.batshit-settings-form-label' }).closest('label')
  const trigger = label?.querySelector('.batshit-settings-select-compact')
  if (!trigger) throw new Error('AI Zip Layout select not found')
  return trigger as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Global Tool Grid: a failed settings load refuses saves (BL-487)', () => {
  it('shows a load error and Retry, and never sends a save while unloaded', async () => {
    const { saves, setSettingsOk } = stubFetch({ settingsOk: false })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })

    await waitFor(() =>
      expect(
        screen.getByText(/have not finished loading|Failed to load zip defaults/i)
      ).toBeTruthy()
    )
    const retryButton = screen.getByRole('button', { name: /Retry/ })
    expect(retryButton).toBeTruthy()

    // Change the AI Zip Layout while the load is still failed.
    await fireEvent.keyDown(zipLayoutTrigger(), { key: 'ArrowDown' })
    const inlineOption = await screen.findByRole('option', { name: 'Inline', exact: true })
    await fireEvent.pointerUp(inlineOption, { pointerType: 'mouse' })

    // Give the (now-refused) debounce/save path every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(saves).toHaveLength(0)
    expect(
      screen.getByText(/have not finished loading/i)
    ).toBeTruthy()

    // Retry with a healthy load: the next toggle now saves for real.
    setSettingsOk(true)
    await fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.queryByText(/have not finished loading/i)).toBeNull())

    await fireEvent.keyDown(zipLayoutTrigger(), { key: 'ArrowDown' })
    const inlineOptionAgain = await screen.findByRole('option', { name: 'Inline', exact: true })
    await fireEvent.pointerUp(inlineOptionAgain, { pointerType: 'mouse' })

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('inline')
  })
})

describe('Global Tool Grid: Reset to defaults refuses while unloaded (BL-487 follow-up)', () => {
  it('disables Reset to defaults, and the function itself refuses before touching any gateway', async () => {
    const { saves, gatewayPuts } = stubFetch({
      settingsOk: false,
      gateways: [{ id: 'gw1', name: 'Test Gateway', enabled: false, type: 'other' }]
    })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Reset to defaults/ })).toBeTruthy()
    )
    const resetButton = screen.getByRole('button', { name: /Reset to defaults/ })
    // The button matches its own existing disabled-until-ready convention (it already disables
    // on !userId / loading / globalResetBusy) rather than the toggles' attempt-then-refuse one.
    expect(resetButton).toBeDisabled()

    // A disabled button never fires its click handler for a real user — but reset ALSO writes
    // to the server directly (one PUT per gateway) before the guarded settings save at the end
    // ever runs, so the function itself must refuse too, not just the button's disabled state.
    // Bypass the attribute to exercise that inner guard directly.
    resetButton.removeAttribute('disabled')
    await fireEvent.click(resetButton)

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(gatewayPuts).toHaveLength(0)
    expect(saves).toHaveLength(0)
    expect(screen.getAllByText(/Reset cannot run yet/i).length).toBeGreaterThan(0)
  })
})
