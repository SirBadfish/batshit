import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'

/**
 * SA-120 P7 (Josh's review, 2026-09-17) — the origin line on an Approve card.
 *
 * A chat a DM, a wake-up webhook, or a schedule started is driven by text the user did not
 * write, and this card is where they decide whether to let it act. So every approval card
 * of such a turn says at the top who started it, flagged or not. The Jev flag itself is a
 * SEPARATE notice card (`JevJuiceFlagNotice`), never a line here: a flag on the approval
 * card made Approve feel like approving the flag.
 *
 * The pin that matters more than the wording (DL-120-12): the line is information. It
 * cannot approve, deny, delay, or pre-select anything. Both buttons stay rendered, stay
 * enabled, and still call `onApprovalAction` exactly as they do with no wake at all.
 */

const briefs = new Map<string, unknown>()
const requestDmBrief = vi.fn()

vi.mock('$lib/stores/dmBriefs.svelte', () => ({
  getDmBrief: (dmId: string | null | undefined) => (dmId ? (briefs.get(dmId) ?? null) : null),
  getJevJuiceDmScreen: (dmId: string | null | undefined) =>
    (dmId ? ((briefs.get(dmId) as { screen?: unknown } | undefined)?.screen ?? null) : null),
  requestDmBrief: (dmId: string | null | undefined) => requestDmBrief(dmId)
}))

const MessageApprovalPanel = (await import('./MessageApprovalPanel.svelte')).default

const FLAG = {
  status: 'flagged' as const,
  severity: 'serious' as const,
  findings: [{ id: 'override' as const, probability: 0.98 }],
  harm: 2,
  clipped: false,
  source: 'agent_dm' as const
}

const APPROVAL = {
  approvalId: 'appr_1',
  toolName: 'bash',
  status: 'pending',
  input: { command: 'rm -rf /tmp/thing' },
  control: null
}

function mount(props: Record<string, unknown> = {}) {
  const onApprovalAction = vi.fn()
  render(MessageApprovalPanel, {
    props: {
      approvals: [APPROVAL],
      approvalSubmitting: false,
      approvalError: null,
      describeApproval: () => 'Run a shell command',
      formatApprovalInput: (input: unknown) => JSON.stringify(input),
      getApprovalRemainingSeconds: () => null,
      onApprovalAction,
      ...props
    }
  })
  return { onApprovalAction }
}

beforeEach(() => {
  briefs.clear()
  requestDmBrief.mockClear()
})

describe('MessageApprovalPanel: the origin line of a woken turn', () => {
  it('asks for the brief of the DM that woke this turn', async () => {
    mount({ wakeDmId: 'dm_woke_me' })
    await waitFor(() => expect(requestDmBrief).toHaveBeenCalledWith('dm_woke_me'))
  })

  it('says who started the turn, from the DM record and not from any flag', async () => {
    briefs.set('dm_woke_me', { from: { kind: 'webhook', name: 'Nightly build' }, subject: 'x', snippet: 'y', screen: null })
    mount({ wakeDmId: 'dm_woke_me' })
    const line = await screen.findByTestId('approval-wake-origin')
    expect(line.textContent).toBe('This turn was started by a wake-up message from webhook "Nightly build", not by you.')
  })

  it('names an agent and a schedule the same way', async () => {
    briefs.set('dm_agent', { from: { kind: 'agent', name: 'Cooper' }, subject: '', snippet: '', screen: FLAG })
    mount({ wakeDmId: 'dm_agent' })
    expect((await screen.findByTestId('approval-wake-origin')).textContent).toContain('from agent "Cooper"')

    briefs.set('dm_clock', { from: { kind: 'schedule', name: 'Morning check' }, subject: '', snippet: '', screen: null })
    mount({ wakeDmId: 'dm_clock' })
    await waitFor(() =>
      expect(screen.getAllByTestId('approval-wake-origin').map((node) => node.textContent)).toContain(
        'This turn was started by a wake-up message from the schedule "Morning check", not by you.'
      )
    )
  })

  it('never draws the flag on this card, even for a flagged wake-up message', async () => {
    briefs.set('dm_woke_me', { from: { kind: 'webhook', name: 'Nightly build' }, subject: 'x', snippet: 'y', screen: FLAG })
    mount({ wakeDmId: 'dm_woke_me' })
    await screen.findByTestId('approval-wake-origin')
    expect(screen.queryByText(/Flagged by Jev/)).toBeNull()
    expect(screen.queryByText(/confidence/)).toBeNull()
    expect(screen.queryByText(/Jev Juice/)).toBeNull()
  })

  it('leaves BOTH buttons enabled and acting exactly as they do without a wake', async () => {
    briefs.set('dm_woke_me', { from: { kind: 'webhook', name: 'Nightly build' }, subject: 'x', snippet: 'y', screen: FLAG })
    const { onApprovalAction } = mount({ wakeDmId: 'dm_woke_me' })
    await screen.findByTestId('approval-wake-origin')

    const approve = screen.getByRole('button', { name: 'Approve' })
    const deny = screen.getByRole('button', { name: 'Deny' })
    expect(approve).not.toBeDisabled()
    expect(deny).not.toBeDisabled()

    await fireEvent.click(approve)
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', true)
    await fireEvent.click(deny)
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', false)
    expect(onApprovalAction).toHaveBeenCalledTimes(2)
  })

  it('draws no origin line for a typed turn, or while the brief has not landed', async () => {
    mount({})
    mount({ wakeDmId: 'dm_unknown' })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2))
    expect(screen.queryByTestId('approval-wake-origin')).toBeNull()
    expect(requestDmBrief).toHaveBeenCalledWith('dm_unknown')
  })
})
