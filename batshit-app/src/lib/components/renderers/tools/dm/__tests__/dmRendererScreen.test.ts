import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import {
  UNTRUSTED_TEXT_ADVISORY_TEXT,
  UNTRUSTED_TEXT_BADGE_TEXT,
  UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT,
  untrustedTextCategoryLines,
  untrustedTextHarmText
} from '$lib/utils/jevJuice'

/**
 * SA-120 P7 — the Jev Juice flag on an Agent DM tool card.
 *
 * The card looks the flag up BY DM ID rather than reading it off the tool result: the result
 * is what the agent sees, and only the agent that READS a flagged DM is told. So the store is
 * the seam, and these tests drive it directly.
 *
 * The contract that matters most: a DM with no flag, and a DM that was never screened, both
 * come back `null` and draw NOTHING. A card must never carry a "clean" mark (DL-120-12).
 */

const screens = new Map<string, unknown>()
const requestJevJuiceDmScreen = vi.fn()

vi.mock('$lib/stores/dmBriefs.svelte', () => ({
  getDmBrief: (dmId: string | null | undefined) =>
    (dmId && screens.has(dmId) ? { from: { kind: 'agent', name: 'x' }, subject: '', snippet: '', screen: screens.get(dmId) } : null),
  getJevJuiceDmScreen: (dmId: string | null | undefined) => (dmId ? (screens.get(dmId) ?? null) : null),
  requestDmBrief: (dmId: string | null | undefined) => requestJevJuiceDmScreen(dmId)
}))

const DmRenderer = (await import('../DmRenderer.svelte')).default

const FLAG = {
  status: 'flagged' as const,
  severity: 'serious' as const,
  findings: [
    { id: 'override' as const, probability: 0.98 },
    { id: 'against_user' as const, probability: 0.71 }
  ],
  harm: 2,
  clipped: false,
  source: 'agent_dm' as const
}

/** The live `sys.dm.send` shape: the agent's input and the control's answer sit under `toolResult`. */
const liveWaitSend = {
  toolName: 'sys.dm.send',
  displayToolName: 'Agent DM Send',
  rendererFamily: 'dm',
  toolArgs: { ref: 'fabric:sys.dm.send', target: 'sys.dm.send' },
  toolResult: {
    success: true,
    controlId: 'sys.dm.send',
    riskLevel: 'safe',
    status: 'published',
    result: {
      dm_id: 'dm_1788837376535_ib1be0',
      delivered_as: 'wait',
      expires_at: '2026-09-15T03:16:16.535Z',
      recipient_state: 'idle'
    },
    ref: 'fabric:sys.dm.send',
    family: 'fabric',
    target: 'sys.dm.send',
    input: {
      ref: 'fabric:sys.dm.send',
      to: 'demo_openai_api_primary',
      kind: 'info',
      subject: 'P7 flag check',
      body: 'Just checking the badge renders.',
      deliver: 'wait'
    }
  },
  metadata: { rendererTitle: 'Agent DM Send', fabricControlId: 'sys.dm.send', dmTool: true },
  success: true
}

function withResult(patch: Record<string, unknown>, inputPatch: Record<string, unknown> = {}) {
  return {
    ...liveWaitSend,
    toolResult: {
      ...liveWaitSend.toolResult,
      result: { ...liveWaitSend.toolResult.result, ...patch },
      input: { ...liveWaitSend.toolResult.input, ...inputPatch }
    }
  }
}

/** The card opens collapsed; its body only exists once the header is opened. */
async function expandCard() {
  await fireEvent.click(await screen.findByRole('button', { expanded: false }))
}

beforeEach(() => {
  screens.clear()
  requestJevJuiceDmScreen.mockClear()
})

describe('DmRenderer: the Jev Juice flag', () => {
  it('asks for the screen of the DM the card names', async () => {
    render(DmRenderer, { props: { tool: liveWaitSend } })
    await waitFor(() => expect(requestJevJuiceDmScreen).toHaveBeenCalledWith('dm_1788837376535_ib1be0'))
  })

  it('says so in the subtitle and lists every finding with what it is based on', async () => {
    screens.set('dm_1788837376535_ib1be0', FLAG)
    render(DmRenderer, { props: { tool: liveWaitSend } })
    await expandCard()

    const block = await screen.findByTestId('jev-juice-dm-card-flag')
    expect(block.textContent).toContain(UNTRUSTED_TEXT_BADGE_TEXT)
    for (const line of untrustedTextCategoryLines(FLAG)) expect(block.textContent).toContain(line)
    expect(block.textContent).toContain('Potential takeover attempt (98% confidence)')
    expect(block.textContent).toContain('Potentially unwanted request (71% confidence)')
    expect(block.textContent).toContain(untrustedTextHarmText(FLAG))
    expect(block.textContent).toContain(UNTRUSTED_TEXT_ADVISORY_TEXT)
    expect(block.textContent).toContain(UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT)
    expect(block.textContent).not.toContain('Jev Juice')
    expect(block.className).toContain('is-serious')

    // The card opens collapsed, so the subtitle carries the flag on its own.
    expect(screen.getByText(/to demo_openai_api_primary · info · waiting in inbox · flagged by Jev$/)).toBeTruthy()
  })

  it('draws nothing at all when there is no flag to draw', async () => {
    render(DmRenderer, { props: { tool: liveWaitSend } })
    await waitFor(() => expect(screen.getByText(/to demo_openai_api_primary/)).toBeTruthy())
    await expandCard()
    expect(screen.queryByTestId('jev-juice-dm-card-flag')).toBeNull()
    expect(screen.queryByTestId('jev-juice-dm-card-skipped')).toBeNull()
    expect(screen.queryByText(/Jev Juice/)).toBeNull()
  })

  it('says plainly when the screen could not run, instead of implying it was clean', async () => {
    screens.set('dm_1788837376535_ib1be0', { status: 'skipped', reason: 'deadline', source: 'agent_dm' })
    render(DmRenderer, { props: { tool: liveWaitSend } })
    await expandCard()

    const note = await screen.findByTestId('jev-juice-dm-card-skipped')
    expect(note.textContent).toContain('Jev Juice: Incoming text screen skipped')
    expect(note.getAttribute('title')).toContain('This text was not screened.')
    expect(screen.queryByTestId('jev-juice-dm-card-flag')).toBeNull()
  })

  it('reads a caution flag as caution, not as serious', async () => {
    screens.set('dm_1788837376535_ib1be0', { ...FLAG, severity: 'caution' })
    render(DmRenderer, { props: { tool: liveWaitSend } })
    await expandCard()
    const block = await screen.findByTestId('jev-juice-dm-card-flag')
    expect(block.className).not.toContain('is-serious')
    expect(block.textContent).toContain('Potential harm: minor')
  })

  it('takes the DM id from the agent\'s own input when the result does not carry one', async () => {
    render(DmRenderer, {
      props: {
        tool: {
          ...liveWaitSend,
          toolArgs: { ref: 'fabric:sys.dm.read', target: 'sys.dm.read' },
          displayToolName: 'Agent DM Read',
          toolResult: {
            success: true,
            controlId: 'sys.dm.read',
            ref: 'fabric:sys.dm.read',
            target: 'sys.dm.read',
            result: { subject: 'P7 flag check' },
            input: { ref: 'fabric:sys.dm.read', dm_id: 'dm_read_target' }
          },
          metadata: { fabricControlId: 'sys.dm.read', dmTool: true }
        }
      }
    })
    await waitFor(() => expect(requestJevJuiceDmScreen).toHaveBeenCalledWith('dm_read_target'))
  })

  it('finds the DM id on the managed CLI lane, where the input sits under toolArgs (captured from a live Codex read)', async () => {
    // Shape captured from the SA-120 P7 live proof (`zip:cool_tool_…_mqb79`, managed Codex):
    // the helper's step keeps the agent's input under `toolArgs.input`, its result envelope has
    // NO `input`, and a read answers with the record under `result.dm`. Before P7 this card had
    // no DM id at all on that lane, so it had an empty subtitle and could never find its flag.
    const liveCodexRead = {
      toolName: 'sys.dm.read',
      displayToolName: 'Agent DM Read',
      rendererFamily: 'dm',
      toolArgs: { ref: 'fabric:sys.dm.read', target: 'sys.dm.read', input: { dm_id: 'dm_1789639612438_26bd44' } },
      toolInput: null,
      toolResult: {
        auth: 'agent',
        userId: 'josh',
        actingAgentId: 'jev_p7_codex',
        success: true,
        controlId: 'sys.dm.read',
        dryRun: false,
        riskLevel: 'safe',
        status: 'published',
        result: {
          dm: { id: 'dm_1789639612438_26bd44', kind: 'info', subject: 'Quick one', status: 'done' },
          jev_juice_screen: { flagged: true, severity: 'serious' }
        },
        ref: 'fabric:sys.dm.read',
        family: 'fabric',
        target: 'sys.dm.read'
      },
      metadata: { rendererTitle: 'Agent DM Read', fabricControlId: 'sys.dm.read', dmTool: true, rendererFamily: 'dm' },
      success: true
    }
    screens.set('dm_1789639612438_26bd44', FLAG)
    render(DmRenderer, { props: { tool: liveCodexRead } })
    await waitFor(() => expect(requestJevJuiceDmScreen).toHaveBeenCalledWith('dm_1789639612438_26bd44'))
    expect(screen.getByText(/dm_1789639612438_26bd44 · flagged by Jev$/)).toBeTruthy()

    // The same card with only the record in the result (no input anywhere) still finds its DM.
    requestJevJuiceDmScreen.mockClear()
    render(DmRenderer, { props: { tool: { ...liveCodexRead, toolArgs: { ref: 'fabric:sys.dm.read', target: 'sys.dm.read' } } } })
    await waitFor(() => expect(requestJevJuiceDmScreen).toHaveBeenCalledWith('dm_1789639612438_26bd44'))
  })

  it('lets a broadcast\'s first delivery stand for the one text they all share', async () => {
    screens.set('dm_first_of_many', FLAG)
    render(DmRenderer, {
      props: {
        tool: withResult(
          {
            dm_id: undefined,
            broadcast: true,
            delivered: [{ dm_id: 'dm_first_of_many' }, { dm_id: 'dm_second' }],
            skipped: []
          },
          { to: 'all' }
        )
      }
    })

    await waitFor(() => expect(requestJevJuiceDmScreen).toHaveBeenCalledWith('dm_first_of_many'))
    await expandCard()
    expect(await screen.findByTestId('jev-juice-dm-card-flag')).toBeTruthy()
    expect(screen.getByText(/broadcast · 2 delivered · flagged by Jev$/)).toBeTruthy()
  })
})
