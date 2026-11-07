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

function seed(content: string, metadata: Record<string, unknown> = { response_failed: true, error_message: ERROR }) {
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
      metadata
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

  // BL-239: a reply that stopped at the model's output limit used to show as a finished reply
  // (GLM 5.3 once thought for 65,534 tokens and the whole reply was "I").
  it('says an output-limit stop is the output limit, not an error, and names what to do', () => {
    const advice =
      'The model reached its output limit of 65,536 tokens before this reply was finished. Ask the agent to continue, or raise Max Tokens in its model preset.'
    seed('I', { response_failed: true, failure_kind: 'output_limit', error_message: advice })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    const banner = screen.getByTestId('message-failure-banner').textContent ?? ''
    expect(banner).toContain("This response stopped at the model's output limit")
    expect(banner).not.toContain('cut short by an error')
    expect(document.querySelector('.message-failure-detail')?.textContent).toBe(advice)
  })

  // BL-775: when a reply's stream record could not be had, the server saves its own full copy and
  // marks it; the chat says so in plain words, and only then.
  it('says a reply was saved from Batshit’s own copy when the record says so, and never otherwise', () => {
    seed('The whole reply.', { replySavedFromOwnCopy: true })
    const first = render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.getByTestId('reply-saved-from-own-copy').textContent).toContain(
      'Batshit saved this reply from its own copy, because the live copy was incomplete.'
    )
    first.unmount()

    seed('The whole reply.', {})
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByTestId('reply-saved-from-own-copy')).toBeNull()
  })

  // BL-759: a managed lane lost its connection mid-answer and started the answer again; the
  // unfinished first try was taken out. The reply says so, naming the program, and only then.
  it('says the answer started again after a lost connection when the record says so, and never otherwise', () => {
    seed('The retried answer.', { restartedAfterLostConnection: { program: 'Claude Code' } })
    const first = render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.getByTestId('reply-restarted-after-lost-connection').textContent).toContain(
      'Claude Code lost its connection during this answer and started it again. The unfinished first try was removed.'
    )
    first.unmount()

    seed('The whole reply.', {})
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByTestId('reply-restarted-after-lost-connection')).toBeNull()
  })

  // BL-941: the agent's record made the run tighter than the mode its send carried (a group member
  // whose record holds Chat, an older window); the server saves the note at every way the reply
  // ends, and the reply says what ran, in one line, and only then.
  it('says what ran when Agent Settings made the run tighter than the mode the chat bar sent, and never otherwise', () => {
    seed('The planned answer.', {
      modeLimitedByAgentSettings: { program: 'Claude Code', sentMode: 'acceptEdits', ranMode: 'plan' }
    })
    const claude = render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.getByTestId('reply-mode-limited-by-agent-settings').textContent?.trim()).toBe(
      'Claude Code ran as Plan because Agent Settings holds that for this agent; the chat bar sent Edit automatically.'
    )
    claude.unmount()

    seed('The whole reply.', {})
    const none = render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByTestId('reply-mode-limited-by-agent-settings')).toBeNull()
    none.unmount()

    // SA-139 R1: a note an older Codex CLI reply saved names a program Batshit no longer runs; it
    // shows nothing rather than words for modes that no longer exist.
    seed('The read-only answer.', {
      modeLimitedByAgentSettings: { program: 'Codex', sentMode: 'agent_full', ranMode: 'chat', sandbox: 'read-only' }
    })
    const retired = render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByTestId('reply-mode-limited-by-agent-settings')).toBeNull()
    retired.unmount()

    // A note Batshit cannot read shows nothing rather than words it made up.
    seed('The whole reply.', { modeLimitedByAgentSettings: { program: 'Claude Code', sentMode: 'acceptEdits', ranMode: 'bogus' } })
    const bogus = render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByTestId('reply-mode-limited-by-agent-settings')).toBeNull()
    bogus.unmount()

    // A mode named like a built-in of every object is no mode.
    seed('The whole reply.', { modeLimitedByAgentSettings: { program: 'Claude Code', sentMode: 'constructor', ranMode: 'plan' } })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })
    expect(screen.queryByTestId('reply-mode-limited-by-agent-settings')).toBeNull()
  })

  // BL-969 (a): the note is information, not a failure. It is the reply's quiet status line (the
  // empty stopped reply's style, BL-934) with an information icon, never the pink failure banner
  // with its warning triangle.
  it('shows the note as a quiet information line, not as the failure banner', () => {
    seed('The planned answer.', {
      modeLimitedByAgentSettings: { program: 'Claude Code', sentMode: 'acceptEdits', ranMode: 'plan' }
    })
    render(Harness, { props: { messageId: REPLY, sessionId: SESSION } })

    const note = screen.getByTestId('reply-mode-limited-by-agent-settings')
    expect(note.classList.contains('message-stopped-note')).toBe(true)
    expect(note.classList.contains('message-mode-limited-note')).toBe(true)
    expect(note.getAttribute('role')).toBe('note')
    expect(note.closest('.message-failure-banner')).toBeNull()
    expect(note.querySelector('.message-failure-icon')).toBeNull()
    expect(note.querySelector('.message-stopped-note-icon')).not.toBeNull()
    expect(document.querySelector('.message-failure-banner')).toBeNull()
  })
})
