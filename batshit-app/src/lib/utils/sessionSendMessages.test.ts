import { describe, expect, it } from 'vitest'

import type { ChatSession } from '$lib/stores/session.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import { buildSessionMessagesForSend } from '$lib/utils/sessionSendMessages'

function message(overrides: Partial<Message> & { id: string; session_id: string; content: string }): Message {
  return {
    id: overrides.id,
    session_id: overrides.session_id,
    user_id: overrides.user_id ?? 'user-1',
    role: overrides.role ?? 'user',
    content: overrides.content,
    timestamp: overrides.timestamp ?? '2026-06-06T00:00:00.000Z',
    created_at: overrides.created_at ?? '2026-06-06T00:00:00.000Z',
    status: overrides.status ?? 'complete',
    ...overrides
  }
}

function session(id: string): ChatSession {
  return {
    id,
    user_id: 'user-1',
    name: id,
    created_at: '2026-06-06T00:00:00.000Z',
    last_modified_at: '2026-06-06T00:00:00.000Z'
  }
}

describe('buildSessionMessagesForSend', () => {
  it('uses the captured session messages and trim state instead of another active session', () => {
    const sessionAMessages = [
      message({ id: 'a-old', session_id: 'session-a', content: 'Older Cody context' }),
      message({ id: 'a-new', session_id: 'session-a', content: 'Hey Cody follow-up' })
    ]
    const sessionBMessages = [
      message({ id: 'b-old', session_id: 'session-b', content: 'Different chat context' }),
      message({ id: 'b-new', session_id: 'session-b', content: 'Other session message' })
    ]

    const result = buildSessionMessagesForSend({
      sessionId: 'session-a',
      messages: sessionAMessages,
      sessions: [session('session-a'), session('session-b')],
      trimmedMessageIdsBySession: {
        'session-a': ['a-old'],
        'session-b': ['b-old', 'b-new']
      },
      userId: 'user-1'
    })

    expect(result.map((entry) => entry.session_id)).toEqual(['session-a', 'session-a'])
    expect(result.map((entry) => entry.id)).toEqual([
      'batshit_manual_context_trim_notice',
      'a-new'
    ])
    expect(result.some((entry) => sessionBMessages.some((other) => other.id === entry.id))).toBe(false)
  })
})
