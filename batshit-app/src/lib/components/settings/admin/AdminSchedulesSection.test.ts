import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminSchedulesSection from './AdminSchedulesSection.svelte'

vi.mock('@internationalized/date', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@internationalized/date')
  return { ...actual, getLocalTimeZone: () => 'America/Chicago' }
})

/**
 * SA-115 F-P2-2 — the create form's time-zone default must be set ONCE.
 *
 * The P2 build read `newTimeZone` inside the same `$effect` that assigned it, and that
 * effect also called `load()`. Reading a tracked value you then assign re-runs the effect,
 * which produced two symptoms with one cause:
 *
 *   1. Every zone change re-fetched `/api/schedules` — a hidden request per selection.
 *   2. A user who deliberately chose `UTC` in the select had it flipped straight back to
 *      their local zone, because the re-run saw `'UTC'` and "defaulted" it again. On a Mac
 *      that made UTC unpickable.
 *
 * The fetch count is the honest measurement of the loop itself: if the effect no longer
 * tracks `newTimeZone`, it cannot re-run, so neither symptom can happen. The coding
 * standard behind it is "read the value you plan to assign inside `untrack`" — here the
 * default moved to `onMount` and `load()` got its own effect, the way
 * `AdminWakeHooksSection.svelte` already does it.
 */
describe('AdminSchedulesSection — the zone default is not a feedback effect (F-P2-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetch() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, schedules: [], agents: [{ id: 'agent-cooper', name: 'Cooper' }] })
    }))
    // @ts-expect-error test override
    global.fetch = fetchMock
    return fetchMock
  }

  it('loads the schedule list exactly once on mount', async () => {
    const fetchMock = mockFetch()

    render(AdminSchedulesSection, { props: { disabled: false } })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Give any re-run a chance to land before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const scheduleCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/schedules')
    expect(scheduleCalls).toHaveLength(1)
  })

  it('shows the browser zone as the create form default, not UTC', async () => {
    mockFetch()

    render(AdminSchedulesSection, { props: { disabled: false } })

    // The zone select only exists once the create dialog is open. `screen` rather than the
    // render result because the dialog renders in a portal on `document.body`.
    await fireEvent.click(await screen.findByRole('button', { name: /new schedule/i }))

    // The select's trigger prints the chosen zone verbatim (AMD-115-01: stored as chosen,
    // never canonicalised), so seeing it proves the one-time default ran.
    expect(await screen.findByText('America/Chicago')).toBeTruthy()
  })
})
