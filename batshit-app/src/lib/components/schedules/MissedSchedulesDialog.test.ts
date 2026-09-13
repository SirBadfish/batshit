import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MissedSchedulesDialog from './MissedSchedulesDialog.svelte'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))
vi.mock('svelte-sonner', () => ({ toast }))

// The dialog subscribes to the user channel on mount; the tests drive it through its own
// mount read instead, so the subscription only has to be a no-op that unsubscribes.
vi.mock('$lib/services/userChannel', () => ({
  onUserChannelEvent: () => () => {}
}))

/**
 * SA-118 F-P1-2 (from P1's DL-118-02) — the SECOND Run now caller says it too.
 *
 * P1 made `run-now` answer `recorded: false` plus a `warning` when the fire succeeded and
 * writing it down did not, and taught the Admin card's Run now to toast it. This dialog is
 * the other caller and it dropped the warning on the floor — and it is the worse place to
 * drop it: answering a missed run REMOVES the row from this list, so the "last run" that is
 * about to be wrong walks off the screen at the same moment.
 */
describe('MissedSchedulesDialog — Run now reports a failed record (F-P1-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    toast.success.mockClear()
    toast.warning.mockClear()
    toast.error.mockClear()
  })

  const MISSED = {
    id: 'sch_missed',
    agentId: 'agent-cooper',
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: 'America/Chicago',
    message: 'Say good morning.',
    kind: 'info',
    deliver: 'wake',
    enabled: true,
    nextRunAt: '2026-09-14T14:00:00.000Z',
    lastRunAt: null,
    lastOutcome: null,
    lastDmId: null,
    runCount: 0,
    missedRun: { dueAt: '2026-09-12T14:00:00.000Z', count: 1 },
    createdBy: 'user',
    createdAt: '2026-09-07T09:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z'
  }

  function mockFetch(runNowPayload: Record<string, unknown>) {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/run-now')) {
        return { ok: true, json: async () => runNowPayload }
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          schedules: [MISSED],
          agents: [{ id: 'agent-cooper', name: 'Cooper' }]
        })
      }
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    return fetchMock
  }

  async function pressRunNow() {
    render(MissedSchedulesDialog)
    await fireEvent.click(await screen.findByRole('button', { name: /run now/i }))
  }

  it('toasts the warning when the run fired but could not be recorded', async () => {
    mockFetch({
      success: true,
      outcome: 'woke: session-1',
      recorded: false,
      warning: 'The run fired but Batshit could not record it: Redis went away mid-write'
    })

    await pressRunNow()

    // The run DID happen, so the success line still stands...
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    // ...and the row is about to disappear, so this is the only chance to say the rest.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'The run fired but Batshit could not record it: Redis went away mid-write'
      )
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says nothing extra on an ordinary run', async () => {
    mockFetch({ success: true, outcome: 'woke: session-1', recorded: true })

    await pressRunNow()

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('says nothing extra on Skip, which records nothing to fail at', async () => {
    mockFetch({ success: true })

    render(MissedSchedulesDialog)
    await fireEvent.click(await screen.findByRole('button', { name: /^skip$/i }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /^skip$/i })).toBeNull())
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
