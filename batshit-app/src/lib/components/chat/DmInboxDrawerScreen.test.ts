import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import { UNTRUSTED_TEXT_DRAWER_TOLD_TEXT, untrustedTextBadgeText, untrustedTextFlagDetail } from '$lib/utils/jevJuice'

/**
 * SA-120 P7 — the advisory Judge Juice badge on a row of the Agent DM drawer.
 *
 * The drawer is the one place the user sees the raw incoming text, so it is where the flag
 * matters most. It reads the screen the `/api/dms` row carries, and only ever draws what may
 * be drawn: a flag, or the note that the screen could not run. A DM that raised no flag and a
 * DM that was never screened both show NOTHING, because a missing flag is not "safe"
 * (DL-120-12).
 */

vi.mock('$lib/services/userChannel', () => ({ onUserChannelEvent: () => () => {} }))

const DmInboxDrawer = (await import('./DmInboxDrawer.svelte')).default

const SCREEN = {
  version: 1,
  source: 'agent_dm',
  status: 'flagged',
  at: '2026-09-17T09:30:00.000Z',
  findings: [{ id: 'override', probability: 0.98 }],
  severity: 'serious',
  harm: 2,
  // The call's own row: it is what names the judge (a row with no provider was TypeSafe).
  record: {
    feature: 'untrusted_text',
    model: 'jev-1.13.0',
    latencyMs: 190,
    usage: null,
    deadlineHit: false,
    status: 'ok',
    questionCount: 4,
    at: '2026-09-17T09:30:00.000Z'
  }
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'info',
    priority: 'normal',
    status: 'new',
    from: { kind: 'agent', agentId: 'agent_sender' },
    to: 'agent_reader',
    subject: `subject ${id}`,
    createdAt: '2026-09-17T09:00:00.000Z',
    expiresAt: '2026-09-24T09:00:00.000Z',
    completedAt: null,
    delivery: { requested: 'wait', actual: 'wait' },
    senderSessionId: null,
    claimedSessionId: null,
    relatedDmId: null,
    resultDmId: null,
    callbackStatus: null,
    hasResult: false,
    runningSessionId: null,
    ...overrides
  }
}

function installFetch(dms: unknown[]) {
  // @ts-expect-error test override
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      dms,
      agents: [
        { id: 'agent_reader', name: 'Cooper', dms_enabled: true, state: 'idle', running_session_id: null },
        { id: 'agent_sender', name: 'Faye', dms_enabled: true, state: 'idle', running_session_id: null }
      ]
    })
  }))
}

describe('DmInboxDrawer: the Judge Juice badge', () => {
  it('badges a flagged row, and only that row', async () => {
    installFetch([
      row('dm_flagged', { screen: SCREEN }),
      row('dm_noflag', { screen: { ...SCREEN, status: 'no_flag', findings: [] } }),
      row('dm_unscreened')
    ])
    render(DmInboxDrawer, { props: { open: true } })

    await waitFor(() => expect(screen.getByText('subject dm_unscreened')).toBeTruthy())
    const badges = screen.getAllByTestId('jev-juice-dm-flag')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toContain(untrustedTextBadgeText('Jev'))
    expect(badges[0].className).toContain('is-serious')
    expect(badges[0].getAttribute('title')).toBe(
      untrustedTextFlagDetail(
        {
          status: 'flagged',
          severity: 'serious',
          findings: [{ id: 'override', probability: 0.98 }],
          harm: 2,
          clipped: false,
          source: 'agent_dm',
          judge: 'Jev'
        },
        UNTRUSTED_TEXT_DRAWER_TOLD_TEXT
      )
    )
    // The words Josh set: the category, the confidence with its word, the harm, the promise.
    expect(badges[0].getAttribute('title')).toContain('Category: Potential takeover attempt (98% confidence)')
    expect(badges[0].getAttribute('title')).toContain('Potential harm: serious')
    expect(badges[0].getAttribute('title')).toContain(UNTRUSTED_TEXT_DRAWER_TOLD_TEXT)
    expect(badges[0].textContent).toContain('Flagged by Jev')
    expect(badges[0].textContent).not.toContain('Judge Juice')
    expect(screen.queryByTestId('jev-juice-dm-screen-skipped')).toBeNull()
  })

  it('SA-120 P10b: the badge names the judge that flagged it, from the screen\'s own row', async () => {
    installFetch([
      row('dm_cloudflare', {
        screen: {
          ...SCREEN,
          record: { ...SCREEN.record, model: 'clef-flash', provider: { id: 'cf_1', kind: 'cloudflare', label: 'CF' } }
        }
      })
    ])
    render(DmInboxDrawer, { props: { open: true } })

    const badge = await screen.findByTestId('jev-juice-dm-flag')
    expect(badge.textContent).toContain('Flagged by Clef Flash')
    expect(badge.textContent).not.toContain('Jev')
    expect(badge.getAttribute('title')).toContain("This is Clef Flash's best guess, and Clef Flash can be wrong.")
  })

  it('warns rather than alarms for a caution flag', async () => {
    installFetch([row('dm_caution', { screen: { ...SCREEN, severity: 'caution', harm: 1 } })])
    render(DmInboxDrawer, { props: { open: true } })

    const badge = await screen.findByTestId('jev-juice-dm-flag')
    expect(badge.className).toContain('is-warning')
    expect(badge.className).not.toContain('is-serious')
  })

  it('says the screen could not run instead of leaving the row looking checked', async () => {
    installFetch([row('dm_skipped', { screen: { ...SCREEN, status: 'skipped', reason: 'deadline', findings: [] } })])
    render(DmInboxDrawer, { props: { open: true } })

    const note = await screen.findByTestId('jev-juice-dm-screen-skipped')
    expect(note.textContent).toContain('Judge Juice: Incoming text screen skipped')
    expect(note.getAttribute('title')).toContain('This text was not screened.')
    expect(screen.queryByTestId('jev-juice-dm-flag')).toBeNull()
  })
})

/**
 * BL-401 — a schedule keeps one unread note, and a fire that finds it counts itself on it. The
 * row says so, so the user sees why one row stands for many fires.
 */
describe('DmInboxDrawer: a schedule note that fired more than once', () => {
  it('says how many times it fired, and only on that row', async () => {
    installFetch([
      row('dm_fired', {
        from: { kind: 'schedule', scheduleId: 'sch_q', name: 'Queue check' },
        fireCount: 5,
        firstFiredAt: '2026-09-17T09:00:00.000Z',
        lastFiredAt: '2026-09-17T13:00:00.000Z'
      }),
      row('dm_once')
    ])
    render(DmInboxDrawer, { props: { open: true } })

    await waitFor(() => expect(screen.getByText('subject dm_once')).toBeTruthy())
    const counts = screen.getAllByTestId('dm-drawer-fire-count')
    expect(counts).toHaveLength(1)
    expect(counts[0].textContent).toMatch(/fired 5 times, last /)
  })
})
