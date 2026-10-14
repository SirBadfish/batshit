import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'

const Harness = (await import('./ChatMessageApprovalHarness.test.svelte')).default
const SESSION = 'session-delete-while-running'
const REPLY = 'reply-delete-while-running'

function seed(status: Message['status']) {
  messageStore.setMessagesForSession(SESSION, [{
    id: REPLY,
    role: 'assistant',
    content: 'Part of a reply',
    session_id: SESSION,
    status,
    created_at: new Date().toISOString(),
    metadata: {}
  }] as unknown as Message[])
}

afterEach(() => {
  messageStore.setMessagesForSession(SESSION, [])
})

/**
 * BL-381: a reply deleted while it streams came back (the next chunk re-created it in the tab,
 * and the finalize saved it again). The server refuses that delete with 409; the row offers no
 * Delete on a reply that is still in progress.
 */
describe('ChatMessage: Delete on a reply that is still running', () => {
  it('offers no Delete while the reply is in progress', () => {
    seed('in_progress')
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByLabelText('Delete message')).toBeNull()
    expect(screen.getByLabelText('Copy message as Markdown')).toBeTruthy()
  })

  it('offers Delete once the reply is complete', () => {
    seed('complete')
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.getByLabelText('Delete message')).toBeTruthy()
  })
})
