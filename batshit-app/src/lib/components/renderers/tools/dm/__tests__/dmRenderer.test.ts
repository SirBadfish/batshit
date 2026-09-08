import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import DmRenderer from '../DmRenderer.svelte'

/**
 * SA-113 P4 (DL-113-10b) — the Agent DM tool card.
 *
 * Every payload here is the SHAPE A LIVE RUN PRODUCES, captured from a real
 * `sys.dm.send` on a live instance. That matters more than usual: a broker step is
 * compacted before it reaches a card, so `toolArgs` keeps only `{ref, target}`, the
 * agent's real input moves to `toolResult.input`, and the control's answer sits at
 * `toolResult.result`. The first version of this card read the top level, mounted
 * happily, and rendered an empty box — which is exactly what a card with no test does.
 */

/** Captured verbatim from a live `sys.dm.send` (deliver: wait). */
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
      to: 'megasmoke_openai_api_primary',
      kind: 'info',
      subject: 'P4 card check',
      body: 'Just checking the tool card renders.',
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

describe('DmRenderer', () => {
  it('reads the nested live shape rather than the top level', async () => {
    render(DmRenderer, { props: { tool: liveWaitSend } })

    await waitFor(() => {
      expect(screen.getByText(/Agent DM · Send/)).toBeTruthy()
    })
    // The subtitle is the whole point of a DM card: who it went to and what happened.
    expect(screen.getByText(/to megasmoke_openai_api_primary · info · waiting in inbox/)).toBeTruthy()
  })

  it('shows WHY a requested wake became a wait — the line a generic card buries', async () => {
    render(DmRenderer, {
      props: {
        tool: withResult(
          {
            delivered_as: 'wait',
            reason: 'Cooper is already working an assignment.'
          },
          { deliver: 'wake' }
        )
      }
    })

    await waitFor(() => {
      expect(
        screen.getByText(/waiting in inbox \(Cooper is already working an assignment\.\)/)
      ).toBeTruthy()
    })
  })

  it('says plainly when the wake actually started a chat', async () => {
    render(DmRenderer, {
      props: {
        tool: withResult(
          { delivered_as: 'wake', session_id: 'wake-20260908-031127-q4ydny' },
          { deliver: 'wake' }
        )
      }
    })

    await waitFor(() => {
      expect(screen.getByText(/woke a chat/)).toBeTruthy()
    })
  })

  it('labels each control in the family, not just send', async () => {
    render(DmRenderer, {
      props: {
        tool: {
          ...liveWaitSend,
          displayToolName: 'Agent DM Inbox',
          toolArgs: { ref: 'fabric:sys.dm.list', target: 'sys.dm.list' },
          toolResult: {
            success: true,
            controlId: 'sys.dm.list',
            ref: 'fabric:sys.dm.list',
            target: 'sys.dm.list',
            result: { open: [], total_open: 3 },
            input: {}
          },
          metadata: { fabricControlId: 'sys.dm.list', dmTool: true }
        }
      }
    })

    await waitFor(() => {
      expect(screen.getByText(/Agent DM · Inbox/)).toBeTruthy()
    })
    expect(screen.getByText(/3 open items/)).toBeTruthy()
  })

  it('surfaces a refusal instead of rendering an empty box', async () => {
    render(DmRenderer, {
      props: {
        tool: {
          ...liveWaitSend,
          toolResult: {
            success: false,
            controlId: 'sys.dm.send',
            ref: 'fabric:sys.dm.send',
            target: 'sys.dm.send',
            error: { code: 'DM_REFUSED', message: 'That agent does not have Agent DMs turned on.' },
            input: liveWaitSend.toolResult.input
          }
        }
      }
    })

    await waitFor(() => {
      expect(screen.getByText(/That agent does not have Agent DMs turned on\./)).toBeTruthy()
    })
  })
})
