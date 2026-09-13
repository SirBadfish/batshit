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

/**
 * SA-118 P4 (DL-118-13) — the schedule you can edit.
 *
 * SA-115's acceptance criteria promised "create, pause, edit, run now, and delete"; the
 * shipped card had four of them, while `PATCH /api/schedules/{id}` had accepted every field
 * since the day it was written. These pin the two halves that can go wrong quietly: that
 * the form is filled from the row rather than from whatever was last typed, and that Save
 * sends the fields this form owns and nothing else.
 */
describe('AdminSchedulesSection — editing a schedule (DL-118-13)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    toast.success.mockClear()
    toast.warning.mockClear()
    toast.error.mockClear()
  })

  const WEEKLY = {
    id: 'sch_weekly',
    agentId: 'agent-cooper',
    agentName: 'Cooper',
    name: 'Friday wrap-up',
    cadence: { type: 'weekly', days: [1, 5], at: '17:30' },
    timeZone: 'Europe/Berlin',
    message: 'Summarise the week.',
    kind: 'assignment',
    deliver: 'wait',
    enabled: true,
    nextRunAt: '2026-09-18T15:30:00.000Z',
    lastRunAt: null,
    lastOutcome: null,
    lastDmId: null,
    runCount: 0,
    missedRun: null,
    createdBy: 'user',
    createdAt: '2026-09-07T09:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z'
  }

  /** `list` answers `GET /api/schedules`; `patch` answers the PATCH. */
  function mockFetch(options: { patch?: { ok: boolean; body: Record<string, unknown> } } = {}) {
    const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        const answer = options.patch ?? {
          ok: true,
          body: { success: true, schedule: { ...WEEKLY, name: 'Friday wrap-up (edited)' } }
        }
        return { ok: answer.ok, json: async () => answer.body }
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          schedules: [WEEKLY],
          agents: [
            { id: 'agent-cooper', name: 'Cooper' },
            { id: 'agent-faye', name: 'Faye' }
          ]
        })
      }
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    return fetchMock
  }

  async function openEditDialog() {
    render(AdminSchedulesSection, { props: { disabled: false } })
    await fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }))
    await screen.findByText('Edit Schedule')
  }

  function patchCalls(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.filter(([, init]) => (init as { method?: string })?.method === 'PATCH')
  }

  it('fills every field from the row, not from whatever was typed last', async () => {
    mockFetch()
    await openEditDialog()

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Friday wrap-up')
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(
      'Summarise the week.'
    )
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('17:30')
    // The selects print their chosen value in the trigger.
    expect(screen.getByText('Europe/Berlin')).toBeTruthy()
    expect(screen.getByText('On chosen weekdays')).toBeTruthy()
    expect(screen.getByText('An assignment')).toBeTruthy()
    expect(screen.getByText('Leave it in the inbox')).toBeTruthy()
    // Both stored days are pressed, and only those two.
    const pressed = screen
      .getAllByRole('button', { pressed: true })
      .map((node) => node.textContent?.trim())
    expect(pressed).toEqual(['Mon', 'Fri'])
  })

  it('shows the agent read-only, with the reason', async () => {
    mockFetch()
    await openEditDialog()

    // The name is there to read, but there is no agent picker to change it with.
    expect(screen.getAllByText('Cooper').length).toBeGreaterThan(0)
    expect(screen.queryByText('Choose an agent')).toBeNull()
    expect(screen.getByText('To move a schedule to another agent, create a new one.')).toBeTruthy()
  })

  it('sends exactly the fields the form owns, and never enabled or agentId', async () => {
    const fetchMock = mockFetch()
    await openEditDialog()

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Friday wrap-up v2' } })
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1))
    const [url, init] = patchCalls(fetchMock)[0] as [string, { body: string }]
    expect(String(url)).toBe('/api/schedules/sch_weekly')
    const body = JSON.parse(init.body)
    // The exact field set, asserted as a set: an extra key here is the bug.
    expect(Object.keys(body).sort()).toEqual([
      'cadence',
      'deliver',
      'kind',
      'message',
      'name',
      'timeZone'
    ])
    expect(body.name).toBe('Friday wrap-up v2')
    expect(body.cadence).toEqual({ type: 'weekly', days: [1, 5], at: '17:30' })
    expect(body.timeZone).toBe('Europe/Berlin')
  })

  it('says so and closes when the save lands', async () => {
    mockFetch()
    await openEditDialog()

    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Schedule updated'))
    await waitFor(() => expect(screen.queryByText('Edit Schedule')).toBeNull())
  })

  it('keeps the form open on a refusal and shows the route’s own words', async () => {
    mockFetch({
      patch: {
        ok: false,
        body: { success: false, error: 'That time zone is not one Batshit knows.' }
      }
    })
    await openEditDialog()

    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByText('That time zone is not one Batshit knows.')).toBeTruthy()
    // Still open, with the user's typing still in front of them.
    expect(screen.getByText('Edit Schedule')).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('makes no request at all when the user cancels', async () => {
    const fetchMock = mockFetch()
    await openEditDialog()

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'not saved' } })
    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    await waitFor(() => expect(screen.queryByText('Edit Schedule')).toBeNull())
    expect(patchCalls(fetchMock)).toHaveLength(0)
  })

  it('leaves the pause switch sending only enabled', async () => {
    // The switch owns `enabled` and the form does not. Both directions matter: the form
    // must not send `enabled`, and the switch must not start sending the form's fields.
    const fetchMock = mockFetch()
    render(AdminSchedulesSection, { props: { disabled: false } })

    await fireEvent.click(await screen.findByRole('switch'))

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1))
    const [, init] = patchCalls(fetchMock)[0] as [string, { body: string }]
    expect(JSON.parse(init.body)).toEqual({ enabled: false })
  })

  it('gives the half-typed New Schedule back after an edit', async () => {
    // One form means Edit borrows the create fields. F-P2-2's lesson is that a zone the
    // user chose deliberately must not be replaced behind their back, and the same is true
    // of everything else they had typed.
    mockFetch()
    render(AdminSchedulesSection, { props: { disabled: false } })

    await fireEvent.click(await screen.findByRole('button', { name: /new schedule/i }))
    await screen.findByText('New Schedule', { selector: 'h2, [data-slot="dialog-title"]' })
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'half typed' } })
    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    await fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Friday wrap-up')
    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    await fireEvent.click(await screen.findByRole('button', { name: /new schedule/i }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('half typed')
  })
})
