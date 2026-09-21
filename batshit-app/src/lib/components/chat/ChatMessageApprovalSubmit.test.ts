import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import * as messageStore from '$lib/stores/messages.svelte'
import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
import type { Message } from '$lib/stores/messages.svelte'

/**
 * An approval answer the server refuses must not leave the card saying "Approved".
 *
 * A click marks its entry at once, so the card stops offering the buttons while the answer is
 * on its way. Measured live on 2026-09-18 (`_local/approval-early-click-proof/before-fix.json`):
 * an Approve clicked the moment the card appeared was refused with
 * `session_turn_in_progress`, and the card then said "Approved" with no buttons while
 * nothing had been sent and the stored card was still pending — until a reload.
 *
 * These drive the REAL `ChatMessage` against the REAL message store, with `fetch` answering
 * the way the server really does. The rule itself lives in `toolApprovalSubmit.ts`.
 */

/**
 * The live hub, faked at its one seam: an accepted send (the 202) waits for its `turn_over`
 * here, so a test can play the turn's final answer after the acceptance.
 */
const hub = vi.hoisted(() => ({ subscriptions: [] as Array<{ target: any; handlers: any }> }))
vi.mock('$lib/services/liveHub/liveHubClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/services/liveHub/liveHubClient')>()
  return {
    ...actual,
    subscribeLive: vi.fn((target: any, handlers: any) => {
      hub.subscriptions.push({ target, handlers })
      return { id: `sub-${hub.subscriptions.length}`, state: () => 'pending', unsubscribe: () => {} }
    })
  }
})

const Harness = (await import('./ChatMessageApprovalHarness.test.svelte')).default

const SESSION = 'session-approval-submit'
const CARD = 'msg_assistant_card'

// The refusal the server really sent in the live run, byte for byte.
const TURN_IN_PROGRESS = {
  error: 'Another response is already in progress for this session.',
  code: 'session_turn_in_progress',
  details: 'A response is still running for this chat.'
}

type Entry = Record<string, any>

function bashApproval(approvalId: string, command: string, extra: Entry = {}): Entry {
  return {
    approvalId,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    toolName: 'native_bash_execute',
    input: { command },
    source: 'vercel',
    ...extra
  }
}

function seed(approvals: Entry[], source: string = 'vercel') {
  const now = Date.now()
  messageStore.setMessagesForSession(SESSION, [
    {
      id: 'msg_user',
      role: 'user',
      content: 'Run it.',
      session_id: SESSION,
      status: 'complete',
      created_at: new Date(now - 2000).toISOString()
    },
    {
      id: CARD,
      role: 'assistant',
      content: 'Checking with the shell now.',
      session_id: SESSION,
      status: 'complete',
      created_at: new Date(now - 1000).toISOString(),
      metadata: { toolApprovals: { mode: 'all', source, approvals } }
    }
  ] as unknown as Message[])
}

function storedApprovals(): Entry[] {
  return ((messageStore.getMessage(CARD, SESSION)?.metadata as any)?.toolApprovals?.approvals ?? []) as Entry[]
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The server owns the turn: `Prefer: respond-async` answered with a 202 naming it. */
function acceptedResponse(turnId: string) {
  return new Response(JSON.stringify({ accepted: true, turnId, sessionId: SESSION }), {
    status: 202,
    headers: { 'Content-Type': 'application/json', 'Preference-Applied': 'respond-async' }
  })
}

/** The turn's final answer, as the live hub delivers it to the tab that sent. */
function finishTurn(turnId: string, status: number, body: unknown) {
  const subscription = hub.subscriptions.find((entry) => entry.target?.turnId === turnId)
  if (!subscription) throw new Error(`no subscription for ${turnId}`)
  subscription.handlers.onEvent(
    JSON.stringify({ type: 'turn_over', turnId, status, contentType: 'application/json', body: JSON.stringify(body) })
  )
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  chatRunRegistry.clearRunRegistryForTest()
  vi.unstubAllGlobals()
  messageStore.setMessagesForSession(SESSION, [])
  hub.subscriptions.length = 0
})

function mount() {
  render(Harness, { props: { messageId: CARD, sessionId: SESSION } })
}

describe('ChatMessage: what an approval click leaves on the card', () => {
  it('keeps the resumed turn busy and preserves a newer card and zip allow-list on completion', async () => {
    seed([bashApproval('first', 'expr 1 + 1')])
    fetchMock.mockResolvedValue(acceptedResponse('resume-turn'))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(hub.subscriptions.some((entry) => entry.target?.turnId === 'resume-turn')).toBe(true))
    expect(chatRunRegistry.isSessionBusy(SESSION)).toBe(true)
    const current = messageStore.getMessage(CARD, SESSION)!
    // Refetch and turn_over can land in the same task, before Svelte updates props.
    messageStore.updateMessage(CARD, {
      content: 'First tool and resumed tool.',
      metadata: { ...current.metadata, zipIds: ['first-zip', 'resumed-zip'], toolApprovals: { mode: 'all', source: 'vercel', approvals: [bashApproval('second', 'expr 2 + 2')] } }
    })
    finishTurn('resume-turn', 200, { success: true })
    await waitFor(() => expect(chatRunRegistry.isSessionBusy(SESSION)).toBe(false))
    expect(messageStore.getMessage(CARD, SESSION)?.metadata?.zipIds).toEqual(['first-zip', 'resumed-zip'])
    expect(storedApprovals()).toEqual([expect.objectContaining({ approvalId: 'second', status: 'pending' })])
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })
  it('a refused old card cannot replace another active reply or its Stop controller', async () => {
    seed([bashApproval('old-card', 'expr 1 + 1')])
    const activeController = new AbortController()
    chatRunRegistry.startRun({ sessionId: SESSION, transport: 'api', activeMessageId: 'new-reply', abortController: activeController })
    fetchMock.mockResolvedValue(jsonResponse(409, TURN_IN_PROGRESS))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText(TURN_IN_PROGRESS.error, { selector: '.message-approval-error' })
    expect(chatRunRegistry.getRunState(SESSION).abortController).toBe(activeController)
    expect(chatRunRegistry.getRunState(SESSION).activeStreamMessageIds).toEqual(['new-reply'])
    expect(chatRunRegistry.isSessionBusy(SESSION)).toBe(true)
    expect(storedApprovals()[0]).toMatchObject({ status: 'pending', submitted: false })
  })

  it('a refused Approve puts the buttons back and says why', async () => {
    seed([bashApproval('aitxt-1', 'expr 8675309 + 1')])
    fetchMock.mockResolvedValue(jsonResponse(409, TURN_IN_PROGRESS))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText(TURN_IN_PROGRESS.error, { selector: '.message-approval-error' })).toBeTruthy()
    await waitFor(() => {
      const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
      expect(approve.disabled).toBe(false)
    })
    expect(screen.queryByText('Approved')).toBeNull()
    expect(storedApprovals()).toEqual([expect.objectContaining({ approvalId: 'aitxt-1', status: 'pending', submitted: false })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an accepted Approve keeps "Approved", marks the answer sent, and sends it once', async () => {
    seed([bashApproval('aitxt-1', 'expr 8675309 + 1')])
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(storedApprovals()[0]).toMatchObject({ status: 'approved', submitted: true }))
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/messages/send-routed')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.messageId).toBe(CARD)
    expect(body.content).toBe('')
    expect(body.metadata.toolApprovalResponse).toEqual([
      { type: 'tool-approval-response', approvalId: 'aitxt-1', approved: true, reason: 'User approved' }
    ])
  })

  it('a refused Deny puts the buttons back too', async () => {
    seed([bashApproval('aitxt-1', 'rm -rf /tmp/thing')])
    fetchMock.mockResolvedValue(jsonResponse(409, TURN_IN_PROGRESS))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    await screen.findByText(TURN_IN_PROGRESS.error, { selector: '.message-approval-error' })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('Denied')).toBeNull()
    expect(storedApprovals()[0]).toMatchObject({ status: 'pending', submitted: false })
  })

  it('an answer that never arrived (network error) puts the buttons back', async () => {
    seed([bashApproval('aitxt-1', 'expr 8675309 + 1')])
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await screen.findByText('Failed to fetch', { selector: '.message-approval-error' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy())
    expect(storedApprovals()[0]).toMatchObject({ status: 'pending', submitted: false })
  })

  it('with two cards, one refused answer returns BOTH decisions it carried', async () => {
    seed([bashApproval('aitxt-1', 'expr 1 + 1'), bashApproval('aitxt-2', 'expr 2 + 2')])
    fetchMock.mockResolvedValue(jsonResponse(409, TURN_IN_PROGRESS))
    mount()

    // The first click decides one entry and sends nothing: the answer goes when every card is decided.
    await fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0])
    expect(fetchMock).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    await screen.findByText(TURN_IN_PROGRESS.error, { selector: '.message-approval-error' })
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.metadata.toolApprovalResponse.map((part: Entry) => [part.approvalId, part.approved])).toEqual([
      ['aitxt-1', true],
      ['aitxt-2', false]
    ])
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2))
    expect(storedApprovals().map((entry) => [entry.approvalId, entry.status])).toEqual([
      ['aitxt-1', 'pending'],
      ['aitxt-2', 'pending']
    ])
  })

  it('a failed answer on the Claude lane puts the buttons back', async () => {
    seed([bashApproval('toolu_1', 'git push', { source: 'claude' })], 'claude')
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Failed to submit approval response' }))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await screen.findByText('Failed to submit approval response', { selector: '.message-approval-error' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tool-approvals/respond')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy())
    expect(storedApprovals()[0]).toMatchObject({ status: 'pending' })
  })

  it('an accepted answer on the Claude lane keeps "Approved"', async () => {
    seed([bashApproval('toolu_1', 'git push', { source: 'claude' })], 'claude')
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('Approved')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(storedApprovals()[0]).toMatchObject({ status: 'approved' })
  })

  /**
   * Bug sweep, 2026-09-18: "accepted" is the server's 202, not the run's success. The server
   * records the answer before the resumed run starts, so a run that fails or is stopped after
   * the approved command ran must NOT bring the buttons back: that is how a second Approve ran
   * the same command twice.
   */
  it('an accepted Approve whose run then fails keeps "Approved" and says why', async () => {
    seed([bashApproval('aitxt-1', 'echo once >> /tmp/once.txt')])
    fetchMock.mockResolvedValue(acceptedResponse('turn_approve_fails'))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    // Marked the moment the server accepted, before the run's end.
    await waitFor(() => expect(storedApprovals()[0]).toMatchObject({ status: 'approved', submitted: true }))
    finishTurn('turn_approve_fails', 502, { error: 'The model provider failed.' })

    expect(await screen.findByText('The model provider failed.', { selector: '.message-approval-error' })).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(storedApprovals()[0]).toMatchObject({ status: 'approved', submitted: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a click the server finds already answered keeps "Approved" and says so', async () => {
    seed([bashApproval('aitxt-1', 'echo once >> /tmp/once.txt')])
    fetchMock.mockResolvedValue(acceptedResponse('turn_answered'))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(hub.subscriptions).toHaveLength(1))
    finishTurn('turn_answered', 409, {
      error: 'This approval was already answered.',
      code: 'approval_already_answered'
    })

    await screen.findByText('This approval was already answered.', { selector: '.message-approval-error' })
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(storedApprovals()[0]).toMatchObject({ status: 'approved', submitted: true })
  })

  it('gives the buttons back when the server says it could not record the answer', async () => {
    seed([bashApproval('aitxt-1', 'echo once >> /tmp/once.txt')])
    fetchMock.mockResolvedValue(acceptedResponse('turn_not_recorded'))
    mount()

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(hub.subscriptions).toHaveLength(1))
    finishTurn('turn_not_recorded', 503, {
      error: 'Batshit could not record this approval, so it did not run it.',
      code: 'approval_record_failed'
    })

    await screen.findByText('Batshit could not record this approval, so it did not run it.', {
      selector: '.message-approval-error'
    })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false))
    expect(storedApprovals()[0]).toMatchObject({ status: 'pending', submitted: false })
  })
})
