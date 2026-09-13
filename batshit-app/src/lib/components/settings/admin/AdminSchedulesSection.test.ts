import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminSchedulesSection from './AdminSchedulesSection.svelte'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))
vi.mock('svelte-sonner', () => ({ toast }))

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

/**
 * PR #106 review F-16 (DL-118-02) — the card says when a run was not written down.
 *
 * Run now can succeed at the thing the user asked for (the fire) and fail at the
 * bookkeeping behind it, and `lastOutcome` — the row's own "last run" line — is exactly
 * what a failure there does not write. Before this the failure went to the server console
 * and nowhere else, so the row would quietly show the previous run as the latest one.
 */
describe('AdminSchedulesSection — Run now reports a failed record (F-16)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    toast.success.mockClear()
    toast.warning.mockClear()
    toast.error.mockClear()
  })

  const SCHEDULE = {
    id: 'sch_1',
    agentId: 'agent-cooper',
    agentName: 'Cooper',
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: 'America/Chicago',
    message: 'Say good morning.',
    kind: 'info',
    deliver: 'wake',
    enabled: true,
    nextRunAt: '2026-09-09T14:00:00.000Z',
    lastRunAt: null,
    lastOutcome: null,
    lastDmId: null,
    runCount: 0,
    missedRun: null,
    createdBy: 'user',
    createdAt: '2026-09-07T09:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z'
  }

  function mockFetchWithRunNow(runNowPayload: Record<string, unknown>) {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/run-now')) {
        return { ok: true, json: async () => runNowPayload }
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          schedules: [SCHEDULE],
          agents: [{ id: 'agent-cooper', name: 'Cooper' }]
        })
      }
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    return fetchMock
  }

  async function pressRunNow() {
    render(AdminSchedulesSection, { props: { disabled: false } })
    const button = await screen.findByRole('button', { name: /run now/i })
    await fireEvent.click(button)
  }

  it('toasts the warning when the run fired but could not be recorded', async () => {
    mockFetchWithRunNow({
      success: true,
      outcome: 'woke: session-1',
      recorded: false,
      warning: 'The run fired but Batshit could not record it: Redis went away mid-write'
    })

    await pressRunNow()

    // The run DID happen, so it is still a success toast...
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    // ...and the thing the user cannot otherwise find out is said out loud.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'The run fired but Batshit could not record it: Redis went away mid-write'
      )
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says nothing extra on an ordinary run', async () => {
    mockFetchWithRunNow({ success: true, outcome: 'woke: session-1', recorded: true })

    await pressRunNow()

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
