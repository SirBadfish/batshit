import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import { UNTRUSTED_TEXT_BADGE_TEXT, UNTRUSTED_TEXT_DRAWER_TOLD_TEXT, untrustedTextFlagDetail } from '$lib/utils/jevJuice'

/**
 * SA-120 P7 — the advisory Jev Juice badge on a row of the Agent DM drawer.
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
  harm: 2
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

describe('DmInboxDrawer: the Jev Juice badge', () => {
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
    expect(badges[0].textContent).toContain(UNTRUSTED_TEXT_BADGE_TEXT)
    expect(badges[0].className).toContain('is-serious')
    expect(badges[0].getAttribute('title')).toBe(
      untrustedTextFlagDetail(
        {
          status: 'flagged',
          severity: 'serious',
          findings: [{ id: 'override', probability: 0.98 }],
          harm: 2,
          clipped: false,
          source: 'agent_dm'
        },
        UNTRUSTED_TEXT_DRAWER_TOLD_TEXT
      )
    )
    // The words Josh set: the category, the confidence with its word, the harm, the promise.
    expect(badges[0].getAttribute('title')).toContain('Category: Potential takeover attempt (98% confidence)')
    expect(badges[0].getAttribute('title')).toContain('Potential harm: serious')
    expect(badges[0].getAttribute('title')).toContain(UNTRUSTED_TEXT_DRAWER_TOLD_TEXT)
    expect(badges[0].textContent).toContain('Flagged by Jev')
    expect(badges[0].textContent).not.toContain('Jev Juice')
    expect(screen.queryByTestId('jev-juice-dm-screen-skipped')).toBeNull()
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
    expect(note.textContent).toContain('Jev Juice: Incoming text screen skipped')
    expect(note.getAttribute('title')).toContain('This text was not screened.')
    expect(screen.queryByTestId('jev-juice-dm-flag')).toBeNull()
  })
})
