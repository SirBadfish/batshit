import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import { buildSessionMessagesForSend } from '$lib/utils/sessionSendMessages'
import { moveUserMessageToEndOfChat } from './userMessageMove'

/**
 * BL-921: the server moves a kept send behind the answer to the held words it stood beside and
 * tells every tab (`user_message` with `movedToEnd`). History arrives from the browser, so an open
 * tab must have the server's order too, or its next send compiles the kept message before that
 * answer again. Drives the REAL message store and the page's history assembly.
 */
const SESSION = 'chat-bl921-parity'

const row = (id: string, role: 'user' | 'assistant', content: string, created_at: string, metadata = {}): Message =>
  ({ id, session_id: SESSION, user_id: 'user-1', role, content, created_at, timestamp: created_at, status: 'complete', metadata }) as Message

afterEach(() => messageStore.setMessagesForSession(SESSION, []))

describe('an open tab follows the server when it moves a kept send behind the held answer (BL-921)', () => {
  it('the next send\'s history reads held words, answer, kept message', () => {
    messageStore.setMessagesForSession(SESSION, [
      row('q', 'user', 'run the build', '2026-10-14T10:00:00.000Z'),
      row('card', 'assistant', 'May I run it?', '2026-10-14T10:00:05.000Z'),
      row('held', 'user', 'and then tidy up', '2026-10-14T10:00:06.000Z', { waitsForApproval: { messageId: 'card' } }),
      row('kept', 'user', 'look at this Clip', '2026-10-14T10:00:30.000Z', { keptSend: { reason: 'approval_wait' } }),
      row('answer', 'assistant', 'Tidied.', '2026-10-14T10:01:00.000Z')
    ])

    // The server's moved copy, dated when it moved.
    moveUserMessageToEndOfChat(
      row('kept', 'user', 'look at this Clip', '2026-10-14T10:01:02.000Z', { keptSend: { reason: 'approval_wait' } }),
      SESSION
    )

    const history = buildSessionMessagesForSend({ sessionId: SESSION, messages: messageStore.getMessages(SESSION), sessions: [] })
    expect(history.map((message) => message.id)).toEqual(['q', 'card', 'held', 'answer', 'kept'])
    expect(messageStore.getMessages(SESSION).filter((message) => message.id === 'kept')).toHaveLength(1)
  })

  it('the page moves a message only when the server says it moved (source pin)', () => {
    const page = readFileSync('src/routes/+page.svelte', 'utf8')
    expect(page).toContain(
      '\n        if (data.movedToEnd === true) {\n          moveUserMessageToEndOfChat(normalizedUserMessage, incoming.session_id || eventSessionContext)\n        } else {\n'
    )
  })
})
