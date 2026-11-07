import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import { EMPTY_STOPPED_REPLY_NOTE, isEmptyStoppedReply } from '$lib/utils/stoppedReplyNote'

/**
 * BL-934: Stop pressed before the first word saved the reply as stopped with nothing in it, and the
 * chat showed the agent's name over an empty dark bubble, during the reply and after it (seen with
 * Stop during the SDK's retry wait, `_local/session-e-2026-09-29/live/ratestop.1-end.png`). The
 * bubble now says the user stopped it. Drives the REAL `ChatMessage` from the REAL store.
 */

const Harness = (await import('./ChatMessageApprovalHarness.test.svelte')).default

const SESSION = 'session-stopped-reply'
const REPLY = 'msg_stopped_reply'

function seed(reply: Partial<Message> & { metadata?: Record<string, unknown> }) {
  const now = Date.now()
  messageStore.setMessagesForSession(SESSION, [
    { id: 'msg_user', role: 'user', content: 'Hello there.', session_id: SESSION, status: 'complete', created_at: new Date(now - 2000).toISOString() },
    {
      id: REPLY,
      role: 'assistant',
      content: '',
      session_id: SESSION,
      status: 'complete',
      created_at: new Date(now - 1000).toISOString(),
      ...reply
    }
  ] as unknown as Message[])
}

afterEach(() => {
  messageStore.setMessagesForSession(SESSION, [])
})

describe('ChatMessage: a reply stopped before its first word (BL-934)', () => {
  it('says the user stopped it, instead of an empty bubble', () => {
    seed({ metadata: { interrupted: true, interruptionReason: 'user' } })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    expect(screen.getByTestId('empty-stopped-reply').textContent?.trim()).toBe(EMPTY_STOPPED_REPLY_NOTE)
    expect(screen.queryByTestId('message-failure-banner')).toBeNull()
  })

  it('a stopped reply with words shows its words and no note', () => {
    seed({ content: 'The first half of an answer.', metadata: { interrupted: true } })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    expect(screen.queryByTestId('empty-stopped-reply')).toBeNull()
    expect(document.body.textContent).toContain('The first half of an answer.')
  })

  it('a finished empty reply that was not stopped gets no note', () => {
    seed({ metadata: {} })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    expect(screen.queryByTestId('empty-stopped-reply')).toBeNull()
  })
})

describe('isEmptyStoppedReply', () => {
  const stopped = { role: 'assistant', status: 'complete', content: '', metadata: { interrupted: true } }

  it('is a stopped reply with nothing in it', () => {
    expect(isEmptyStoppedReply(stopped)).toBe(true)
    expect(isEmptyStoppedReply({ ...stopped, content: '  \n ' })).toBe(true)
  })

  it('is not a reply still running, a user message, or a reply that was not stopped', () => {
    expect(isEmptyStoppedReply({ ...stopped, status: 'in_progress' })).toBe(false)
    expect(isEmptyStoppedReply({ ...stopped, role: 'user' })).toBe(false)
    expect(isEmptyStoppedReply({ ...stopped, metadata: {} })).toBe(false)
  })

  it('is not a reply with words, a tool step, an approval card, or a failure of its own', () => {
    expect(isEmptyStoppedReply({ ...stopped, content: 'Hi' })).toBe(false)
    expect(isEmptyStoppedReply({ ...stopped, intermediateSteps: [{ toolName: 'bash' }] })).toBe(false)
    expect(
      isEmptyStoppedReply({ ...stopped, metadata: { interrupted: true, toolApprovals: { approvals: [{ approvalId: 'a' }] } } })
    ).toBe(false)
    expect(isEmptyStoppedReply({ ...stopped, metadata: { interrupted: true, response_failed: true } })).toBe(false)
  })
})
