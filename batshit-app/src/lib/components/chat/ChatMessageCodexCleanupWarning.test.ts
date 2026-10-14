import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import { applyCodexCleanupWarnings, forgetCodexCleanupWarnings } from '$lib/stores/codexCleanupWarnings.svelte'
import { CODEX_CLEANUP_WARNING_TEXT, CODEX_RECORDED_PROCESSES_ENDED_TEXT } from '$lib/utils/codexCleanupWarning'

const Harness = (await import('./ChatMessageApprovalHarness.test.svelte')).default
const SESSION = 'session-codex-cleanup-warning'
const REPLY = 'reply-codex-cleanup-warning'

function seed(content: string) {
  messageStore.setMessagesForSession(SESSION, [{
    id: REPLY,
    role: 'assistant',
    content,
    session_id: SESSION,
    status: 'complete',
    created_at: new Date().toISOString(),
    metadata: { interrupted: true }
  }] as unknown as Message[])
}

afterEach(() => {
  forgetCodexCleanupWarnings(SESSION)
  messageStore.setMessagesForSession(SESSION, [])
})

describe('ChatMessage: stopped Codex command cleanup warning', () => {
  it('renders the server-owned fixed line even when the reply metadata has no warning', () => {
    seed('The reply stopped.')
    applyCodexCleanupWarnings(SESSION, {
      [REPLY]: { messageId: REPLY, kind: 'unconfirmed_command_cleanup' }
    })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.getByTestId('codex-cleanup-warning').textContent).toContain(CODEX_CLEANUP_WARNING_TEXT)
    expect(screen.queryByTestId('message-failure-banner')).toBeNull()
  })

  it('renders the recovered notice in the same warning layout', () => {
    seed('The reply stopped.')
    applyCodexCleanupWarnings(SESSION, {
      [REPLY]: { messageId: REPLY, kind: 'recorded_processes_ended' }
    })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    const warning = screen.getByTestId('codex-cleanup-warning')
    expect(warning.textContent).toContain(CODEX_RECORDED_PROCESSES_ENDED_TEXT)
    expect(warning.textContent).not.toContain(CODEX_CLEANUP_WARNING_TEXT)
    expect(warning.getAttribute('role')).toBe('alert')
  })
})
