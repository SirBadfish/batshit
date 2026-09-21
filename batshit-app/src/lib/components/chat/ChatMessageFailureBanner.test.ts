import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'

/**
 * A failed reply says its error once (bug sweep, 2026-09-18).
 *
 * A turn that fails before it says anything is stored with the error as its text AND as
 * `metadata.error_message` (`resolveFailedTurnContent`), so the reply showed the sentence and the
 * failure banner showed it again under its heading. Seen live proving sweep item 2, where every tab
 * on the chat now re-reads the stored failed turn. Drives the REAL `ChatMessage` from the REAL store.
 */

const Harness = (await import('./ChatMessageApprovalHarness.test.svelte')).default

const SESSION = 'session-failure-banner'
const REPLY = 'msg_failed_reply'
const ERROR = 'CLI agents only support CLI model presets.'

function seed(content: string) {
  const now = Date.now()
  messageStore.setMessagesForSession(SESSION, [
    { id: 'msg_user', role: 'user', content: 'Hello there.', session_id: SESSION, status: 'complete', created_at: new Date(now - 2000).toISOString() },
    {
      id: REPLY,
      role: 'assistant',
      content,
      session_id: SESSION,
      status: 'error',
      created_at: new Date(now - 1000).toISOString(),
      metadata: { response_failed: true, error_message: ERROR }
    }
  ] as unknown as Message[])
}

afterEach(() => {
  messageStore.setMessagesForSession(SESSION, [])
})

describe('ChatMessage: the failure banner', () => {
  it('does not repeat the error when the reply IS the error', () => {
    seed(ERROR)
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    expect(screen.getByTestId('message-failure-banner').textContent).toContain('This response was cut short by an error')
    expect(document.querySelector('.message-failure-detail')).toBeNull()
  })

  it('still names the error under a reply that said something first', () => {
    seed('Here is the first part of the answer.')
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    expect(document.querySelector('.message-failure-detail')?.textContent).toBe(ERROR)
  })
})
