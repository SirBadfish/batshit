import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import GlobalToolGrid from '../GlobalToolGrid.svelte'

const deadCopies = vi.hoisted(() => ({ refreshAll: vi.fn(async () => {}) }))
vi.mock('$lib/stores/zipDeadCopies.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/zipDeadCopies.svelte')>()),
  refreshAllDeadCopies: deadCopies.refreshAll
}))

/**
 * SA-137 P4a (D11): the Global Tool Grid's Refreshed File Reads control (Live File Reads before
 * Round 2). The value rides inside
 * `global_zip_settings` (`live_file_reads`), which every save replaces whole (BL-487). "Default"
 * is stored as ABSENT (the factory value, off), Enabled as true, Disabled as false; Reset to
 * defaults clears it, as it does the other zip defaults; opening the grid saves nothing.
 *
 * Renders the REAL grid; `fetch` answers the grid's loads and records its saves.
 */

type Saved = { url: string; body: any }
type HostAnswer = { platform: string; containerized: boolean } | 'fails'

/** The host the sandbox-status response reports (a Mac outside any container unless a test says). */
const MAC: HostAnswer = { platform: 'darwin', containerized: false }

function stubFetch(settings: Record<string, unknown>, host: HostAnswer = MAC) {
  let persisted = settings
  const saves: Saved[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/user/settings' && method === 'GET') {
        return new Response(JSON.stringify({ settings: persisted }), { status: 200 })
      }
      if (url === '/api/user/settings' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        saves.push({ url, body })
        persisted = { ...persisted, ...body }
        return new Response(JSON.stringify({ success: true, settings: persisted }), { status: 200 })
      }
      // Host facts only: the grid never asks for the full status (which probes the sandboxes).
      if (url === '/api/native-tools/sandbox/status?hostOnly=1') {
        if (host === 'fails') return new Response(JSON.stringify({ error: 'down' }), { status: 500 })
        return new Response(JSON.stringify({ success: true, typedFileToolsHost: { ...host, linuxKernel: null } }), { status: 200 })
      }
      if (url === '/api/mcp/gateways') return new Response(JSON.stringify({ gateways: [] }), { status: 200 })
      if (url === '/api/cli-tools') return new Response(JSON.stringify({ tools: [] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 501 })
    })
  )
  return saves
}

async function renderLoaded(settings: Record<string, unknown>, host: HostAnswer = MAC) {
  const saves = stubFetch(settings, host)
  render(GlobalToolGrid, { props: { userId: 'lfr_user' } })
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/user/settings'))
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull())
  await screen.findByText('Refreshed File Reads', { selector: '.batshit-settings-form-label' })
  // The host read is a load of its own; wait until the switch has been told the answer.
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/native-tools/sandbox/status?hostOnly=1'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  return saves
}

const liveReadsTrigger = () => screen.getByTestId('global-live-file-reads-select')

async function choose(trigger: HTMLElement, optionName: string) {
  await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const option = await screen.findByRole('option', { name: optionName, exact: true })
  await fireEvent.pointerUp(option, { pointerType: 'mouse' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Global Tool Grid: Refreshed File Reads (SA-137 P4a, Round 2)', () => {
  it('hides only the top Smart Zip selector and retains its saved value on another zip edit', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended', jev_juice_smart_zip: true } })
    expect(screen.queryByTestId('global-jev-smart-zip-select')).toBeNull()
    expect(screen.queryByText('Judge Juice: Smart Zip')).toBeNull()
    await choose(liveReadsTrigger(), 'Enabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.jev_juice_smart_zip).toBe(true)
  })
  it('shows Default (On) with nothing saved, and opening the grid saves nothing', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    expect(liveReadsTrigger().textContent?.trim()).toBe('Default (On)')
    // Past the 450 ms zip-save debounce, so a save the load queued would have gone out.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves).toEqual([])
  })

  it('opening the grid with a saved value shows it and saves nothing (hydration does not autosave)', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended', live_file_reads: true } })
    expect(liveReadsTrigger().textContent?.trim()).toBe('Enabled')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves).toEqual([])
  })

  it('Enabled saves true inside global_zip_settings and carries the other keys through', async () => {
    const saves = await renderLoaded({
      global_zip_settings: { zip_ai_view_mode: 'appended', zip_tool_notes_enabled: false, zip_control_mode: 'agent' }
    })
    await choose(liveReadsTrigger(), 'Enabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings).toMatchObject({
      live_file_reads: true,
      zip_ai_view_mode: 'appended',
      zip_tool_notes_enabled: false,
      zip_control_mode: 'agent'
    })
    expect(liveReadsTrigger().textContent?.trim()).toBe('Enabled')
  })

  it('a saved change re-asks the badges\' live-read facts (review M1)', async () => {
    deadCopies.refreshAll.mockClear()
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    await choose(liveReadsTrigger(), 'Enabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
  })

  it('Disabled saves an explicit false', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    await choose(liveReadsTrigger(), 'Disabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.live_file_reads).toBe(false)
  })

  it('Default saves the value as absent', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended', live_file_reads: true } })
    await choose(liveReadsTrigger(), 'Default (On)')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings).not.toHaveProperty('live_file_reads')
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('appended')
  })

  it('a save of another zip control carries a stored value through unchanged', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended', live_file_reads: false } })
    const layout = screen.getByText('AI Zip Layout', { selector: '.batshit-settings-form-label' }).closest('label')
    await choose(layout?.querySelector('.batshit-settings-select-compact') as HTMLElement, 'Inline')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('inline')
    expect(saves[0].body.global_zip_settings.live_file_reads).toBe(false)
  })

  it('Reset to defaults writes a block without it (back to the factory value) and shows Default (On)', async () => {
    deadCopies.refreshAll.mockClear()
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'inline', live_file_reads: true } })
    expect(liveReadsTrigger().textContent?.trim()).toBe('Enabled')

    await fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }, { timeout: 5000 }))

    await waitFor(() => expect(saves).toHaveLength(1))
    const block = saves[0].body.global_zip_settings
    expect(block).not.toHaveProperty('live_file_reads')
    expect(block).toMatchObject({ zip_ai_view_mode: 'appended', zip_tool_notes_enabled: true })
    await waitFor(() => expect(liveReadsTrigger().textContent?.trim()).toBe('Default (On)'))
    // It cleared a saved value, so the badges' live-read facts are asked again (review G1).
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
  })
})

/**
 * Round 2 (R2-2): the global switch is unavailable only for the host (the app container, a platform
 * that is not a Mac or Linux). An inline global Zip view and a host that cannot be read are plain
 * notes that leave it usable. Unavailable never changes, clears or saves the stored value.
 */
describe('Global Tool Grid: when Refreshed File Reads cannot run (Round 2)', () => {
  const trigger = () => liveReadsTrigger() as HTMLButtonElement
  const notes = () => screen.queryAllByTestId('global-live-file-reads-note').map((note) => note.textContent?.trim())

  it('on a Mac with the appended Zip view the switch is usable and carries the short hint', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    expect(trigger().disabled).toBe(false)
    expect(screen.getByTestId('global-live-file-reads-hint').textContent?.trim()).toBe('Applies to Primary Agents with the appended Zip view.')
    expect(saves).toEqual([])
  })

  it('in the app container it is disabled with the reason, shows the stored value, and saves nothing', async () => {
    const saves = await renderLoaded(
      { global_zip_settings: { zip_ai_view_mode: 'appended', live_file_reads: true } },
      { platform: 'linux', containerized: true }
    )
    expect(trigger().disabled).toBe(true)
    expect(screen.getByTestId('global-live-file-reads-reason').textContent?.trim()).toBe('Refreshed File Reads is not available in the app container yet.')
    expect(trigger().textContent?.trim()).toBe('Enabled')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves).toEqual([])
  })

  it('on a platform that is not a Mac or Linux it is disabled with that reason', async () => {
    await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } }, { platform: 'win32', containerized: false })
    expect(trigger().disabled).toBe(true)
    expect(screen.getByTestId('global-live-file-reads-reason').textContent?.trim()).toBe('Refreshed File Reads needs a Mac or Linux host.')
  })

  it('a saved global Zip view of inline does NOT lock the switch: a note says agents using it refresh nothing, and the value stays', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'inline', live_file_reads: false } })
    expect(trigger().disabled).toBe(false)
    expect(notes()).toEqual(['The global Zip view is inline; agents that use it refresh nothing.'])
    expect(screen.queryByTestId('global-live-file-reads-reason')).toBeNull()
    expect(trigger().textContent?.trim()).toBe('Disabled')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves).toEqual([])
  })

  it('choosing Inline in the grid adds the note at once and keeps the switch usable; the layout save carries the stored value through', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended', live_file_reads: true } })
    expect(notes()).toEqual([])
    const layout = screen.getByText('AI Zip Layout', { selector: '.batshit-settings-form-label' }).closest('label')
    await choose(layout?.querySelector('.batshit-settings-select-compact') as HTMLElement, 'Inline')
    await waitFor(() => expect(notes()).toEqual(['The global Zip view is inline; agents that use it refresh nothing.']))
    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent?.trim()).toBe('Enabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings).toMatchObject({ zip_ai_view_mode: 'inline', live_file_reads: true })
    // Back to Appended: the note goes, the hint returns, still Enabled.
    await choose(layout?.querySelector('.batshit-settings-select-compact') as HTMLElement, 'Appended (Recommended)')
    await waitFor(() => expect(notes()).toEqual([]))
    expect(screen.getByTestId('global-live-file-reads-hint')).toBeTruthy()
    expect(trigger().textContent?.trim()).toBe('Enabled')
  })

  it('a host that cannot be read does not lock the switch; a plain note says so and the failure is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } }, 'fails')
    expect(trigger().disabled).toBe(false)
    expect(notes()).toEqual(['Could not check whether Refreshed File Reads can run here.'])
    expect(screen.getByTestId('global-live-file-reads-note').classList.contains('is-warning')).toBe(false)
    expect(warn.mock.calls.some(([message]) => String(message).includes('Could not read the host facts'))).toBe(true)
    expect(saves).toEqual([])
    warn.mockRestore()
  })

  it('reads the host once, host facts only (no sandbox probe), for one mounted grid (no listener, no polling)', async () => {
    await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const asked = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/native-tools/sandbox/status'))
    expect(asked).toEqual(['/api/native-tools/sandbox/status?hostOnly=1'])
  })
})

/**
 * Round 2 (S1): the badges' facts say "still current" only while the full availability rule holds,
 * so a Global save or reset that moves the Zip view (an input of that rule) asks every chat's facts
 * again, as a change of the Refreshed File Reads value already does. Absent reads as appended.
 */
describe('Global Tool Grid: a Zip view change re-asks the badges\' live-read facts (Round 2, S1)', () => {
  const layoutTrigger = () =>
    screen.getByText('AI Zip Layout', { selector: '.batshit-settings-form-label' }).closest('label')?.querySelector('.batshit-settings-select-compact') as HTMLElement

  it('a save that moves the Zip view re-asks once, after the save lands', async () => {
    deadCopies.refreshAll.mockClear()
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    await choose(layoutTrigger(), 'Inline')
    await waitFor(() => expect(saves).toHaveLength(1))
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('inline')
  })

  it('a save of another zip control (Tool Notes) does not re-ask', async () => {
    deadCopies.refreshAll.mockClear()
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    const notesSelect = screen.getByText('Tool Notes', { selector: '.batshit-settings-form-label' }).closest('label')?.querySelector('.batshit-settings-select-compact') as HTMLElement
    await choose(notesSelect, 'Disabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  })

  it('a first save with the Zip view absent (read as appended) does not re-ask for a view that did not move', async () => {
    deadCopies.refreshAll.mockClear()
    const saves = await renderLoaded({ global_zip_settings: {} })
    const notesSelect = screen.getByText('Tool Notes', { selector: '.batshit-settings-form-label' }).closest('label')?.querySelector('.batshit-settings-select-compact') as HTMLElement
    await choose(notesSelect, 'Disabled')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('appended')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  })

  it('Reset to defaults re-asks when it moves the Zip view from inline back to the default', async () => {
    deadCopies.refreshAll.mockClear()
    // No saved Refreshed File Reads value, so only the Zip view moves.
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'inline' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }, { timeout: 5000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('appended')
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
  })

  it('Reset to defaults does not re-ask when neither the Zip view nor the value moves', async () => {
    deadCopies.refreshAll.mockClear()
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }, { timeout: 5000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  })
})
