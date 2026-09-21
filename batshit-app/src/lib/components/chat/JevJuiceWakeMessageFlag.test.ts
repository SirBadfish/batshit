import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import { UNTRUSTED_TEXT_BADGE_TEXT, UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT } from '$lib/utils/jevJuice'

/**
 * SA-120 P7 (Josh's review, 2026-09-17) — the flag on the wake-up message itself, at the top
 * of a woken chat: where the flagged text is actually read, and where "Show the message" lands.
 */

const briefs = new Map<string, unknown>()
const requestDmBrief = vi.fn()

vi.mock('$lib/stores/dmBriefs.svelte', () => ({
  getDmBrief: (dmId: string | null | undefined) => (dmId ? (briefs.get(dmId) ?? null) : null),
  getJevJuiceDmScreen: (dmId: string | null | undefined) =>
    (dmId ? ((briefs.get(dmId) as { screen?: unknown } | undefined)?.screen ?? null) : null),
  requestDmBrief: (dmId: string | null | undefined) => requestDmBrief(dmId)
}))

const JevJuiceWakeMessageFlag = (await import('./JevJuiceWakeMessageFlag.svelte')).default

const FLAG = {
  status: 'flagged' as const,
  severity: 'caution' as const,
  findings: [
    { id: 'override' as const, probability: 0.86 },
    { id: 'against_user' as const, probability: 0.81 }
  ],
  harm: 0.9,
  clipped: false,
  source: 'agent_dm' as const
}

beforeEach(() => {
  briefs.clear()
  requestDmBrief.mockClear()
})

describe('JevJuiceWakeMessageFlag', () => {
  it('draws the flag block under the wake-up message with the categories and its own closing line', async () => {
    briefs.set('dm_1', { from: { kind: 'agent', name: 'Cooper' }, subject: '', snippet: '', screen: FLAG })
    render(JevJuiceWakeMessageFlag, { props: { dmId: 'dm_1' } })
    const block = await screen.findByTestId('jev-juice-wake-message-flag')
    expect(block.textContent).toContain(UNTRUSTED_TEXT_BADGE_TEXT)
    expect(block.textContent).toContain('Categories:')
    expect(block.textContent).toContain('Potential takeover attempt (86% confidence)')
    expect(block.textContent).toContain('Potentially unwanted request (81% confidence)')
    expect(block.textContent).toContain('Potential harm: minor')
    expect(block.textContent).toContain(UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT)
    expect(requestDmBrief).toHaveBeenCalledWith('dm_1')
  })

  it('says the screen could not run, instead of implying the message was checked', async () => {
    briefs.set('dm_1', { from: { kind: 'agent', name: 'Cooper' }, subject: '', snippet: '', screen: { status: 'skipped', reason: 'no_key', source: 'agent_dm' } })
    render(JevJuiceWakeMessageFlag, { props: { dmId: 'dm_1' } })
    const note = await screen.findByTestId('jev-juice-wake-message-skipped')
    expect(note.textContent).toContain('Jev Juice: Incoming text screen skipped')
    expect(screen.queryByTestId('jev-juice-wake-message-flag')).toBeNull()
  })

  it('draws nothing for a DM with no flag or no brief', async () => {
    briefs.set('dm_quiet', { from: { kind: 'agent', name: 'Cooper' }, subject: '', snippet: '', screen: null })
    render(JevJuiceWakeMessageFlag, { props: { dmId: 'dm_quiet' } })
    render(JevJuiceWakeMessageFlag, { props: { dmId: 'dm_unknown' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId('jev-juice-wake-message-flag')).toBeNull()
    expect(screen.queryByTestId('jev-juice-wake-message-skipped')).toBeNull()
  })
})
