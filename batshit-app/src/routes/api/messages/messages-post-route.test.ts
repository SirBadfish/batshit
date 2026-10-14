import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  beginSessionDelete,
  endSessionDelete
} from '$lib/server/services/streamAbortRegistry'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  execute: vi.fn(),
  saveMessage: vi.fn()
}))

/** What `redis.get` answers per key: the chat, and any message already stored. */
const stored = new Map<string, unknown>()

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

/**
 * The browser saves a finished reply when `end` arrives, from every tab showing the chat
 * (`dbService.saveMessage` in the chat page). A chat deleted mid-reply now has its reply
 * stopped while the delete waits, so that `end` and that save land DURING the delete
 * (`sessionDeleteTurnStop.ts`, 2026-09-18). A save that reaches Redis while the delete sweeps
 * would put the message and the list entry back after the sweep passed them. So this route
 * refuses a chat that is being deleted, with the same answer it gives a chat that is gone.
 */
async function post(sessionId: string, content = 'Done.', role = 'user', id = 'msg-reply', metadata?: unknown) {
  const { POST } = await import('./+server')
  const response = await POST({
    request: new Request('http://localhost/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        id,
        session_id: sessionId,
        role,
        content,
        metadata
      })
    }),
    locals: { user: { id: 'user-1' } }
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('POST /api/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStreamAbortRegistryForTests()
    stored.clear()
    redisMock.get.mockImplementation(async (key: string) =>
      key.startsWith('session:') ? { id: key.slice('session:'.length), user_id: 'user-1' } : (stored.get(key) ?? null)
    )
    redisMock.execute.mockImplementation(async (fn: any) => fn({ json: { get: async (key: string) => stored.get(key) ?? null } }))
    redisMock.saveMessage.mockResolvedValue(undefined)
  })

  afterEach(() => {
    __resetStreamAbortRegistryForTests()
  })

  it('saves a message into an existing chat', async () => {
    expect(await post('session-1')).toEqual({ status: 200, payload: { success: true, id: 'msg-reply' } })
    expect(redisMock.saveMessage).toHaveBeenCalledTimes(1)
  })

  it('stores a message whole when it quotes a toolCallId key (BL-548)', async () => {
    // A message that shows an example tool result as JSON. The retired n8n webhook guard cut the
    // content at the first quoted key.
    const content = 'Here is the shape:\n```json\n{ "toolCallId": "call_1", "result": "ok" }\n```\nThat is all.'
    expect((await post('session-1', content)).status).toBe(200)
    expect(redisMock.saveMessage).toHaveBeenCalledTimes(1)
    expect(redisMock.saveMessage.mock.calls[0][0].content).toBe(content)
  })

  it('refuses a chat that is being deleted, as it refuses a chat that is gone', async () => {
    beginSessionDelete('session-1')

    expect(await post('session-1')).toEqual({ status: 404, payload: { error: 'Session not found' } })
    expect(redisMock.saveMessage).not.toHaveBeenCalled()

    // Another chat still saves.
    expect((await post('session-2')).status).toBe(200)

    endSessionDelete('session-1')
    redisMock.get.mockResolvedValue(null)
    expect(await post('session-1')).toEqual({ status: 404, payload: { error: 'Session not found' } })
    expect(redisMock.saveMessage).toHaveBeenCalledTimes(1)
  })

  /**
   * BL-775, BL-776: the server owns an agent's reply. send-routed's finalize saves the whole reply
   * from the stream's record, and a tab's copy could be shorter (its connection was down) or stale
   * (the reply was deleted meanwhile), so this route refuses an assistant record from a tab, new or
   * a replacement, and never touches the stored one.
   */
  it('refuses to create an assistant reply (BL-775, BL-776)', async () => {
    const answer = await post('session-1', 'A shorter copy.', 'assistant')
    expect(answer.status).toBe(403)
    expect(answer.payload.code).toBe('reply_saved_by_server')
    expect(redisMock.saveMessage).not.toHaveBeenCalled()
  })

  it('refuses a save whose id names a stored assistant reply, whatever role it claims', async () => {
    stored.set('message:session-1:msg-reply', { id: 'msg-reply', role: 'assistant', content: 'The whole reply.' })
    const answer = await post('session-1', 'Now a user message.', 'user', 'msg-reply')
    expect(answer.status).toBe(403)
    expect(redisMock.saveMessage).not.toHaveBeenCalled()
  })

  it('accepts only the user’s own messages: any other role, or none, is refused (an allow-list)', async () => {
    for (const role of ['system', 'tool', 'Assistant', '', null]) {
      const answer = await post('session-1', 'x', role as any, `msg-${String(role)}`)
      expect(answer.status, String(role)).toBe(403)
    }
    stored.set('message:session-1:msg-summary', { id: 'msg-summary', role: 'system', content: 'Summary.' })
    expect((await post('session-1', 'Overwrite it.', 'user', 'msg-summary')).status).toBe(403)
    expect(redisMock.saveMessage).not.toHaveBeenCalled()
  })

  it('still saves the user’s own message, new or saved again', async () => {
    expect((await post('session-1', 'My question.', 'user', 'msg-user')).status).toBe(200)
    stored.set('message:session-1:msg-user', { id: 'msg-user', session_id: 'session-1', user_id: 'user-1', role: 'user', content: 'My question.' })
    expect((await post('session-1', 'My question.', 'user', 'msg-user')).status).toBe(200)
    expect(redisMock.saveMessage).toHaveBeenCalledTimes(2)
    expect(redisMock.saveMessage.mock.calls[0][1].browserMutation).toEqual({ sessionId: 'session-1', messageId: 'msg-user', userId: 'user-1', expectedExists: false })
    expect(redisMock.saveMessage.mock.calls[1][1].browserMutation.expectedExists).toBe(true)
  })
  it('cannot mint a server steer/approval marker on a new browser save (BL-1302)', async () => {
    const forged = { steerPromoted: { steerIds: ['forged'] }, waitsForApproval: { messageId: 'forged-card' }, approvalCardExpired: true,
      clipIds: ['kept-clip'], tts: true, imageOrigins: { userChoice: 'kept' } }
    expect((await post('session-1', 'ordinary words', 'user', 'new', forged)).status).toBe(200)
    expect(redisMock.saveMessage.mock.calls[0][0]).toMatchObject({ content: 'ordinary words', metadata: {
      clipIds: ['kept-clip'], tts: true, imageOrigins: { userChoice: 'kept' } } })
    for (const key of ['steerPromoted', 'waitsForApproval', 'approvalCardExpired']) {
      expect(redisMock.saveMessage.mock.calls[0][0].metadata).not.toHaveProperty(key)
    }
  })

  it('replacement uses actual stored markers, not a request echo, while allowing text and unrelated metadata edits', async () => {
    const markers = { steerPromoted: { steerIds: ['actual'], disposition: 'awaiting_approval' },
      waitsForApproval: { messageId: 'actual-card' }, approvalCardExpired: false }
    stored.set('message:session-1:held', { id: 'held', role: 'user', session_id: 'session-1', user_id: 'user-1',
      content: 'old', metadata: { ...markers, oldUserSetting: 'not-restored' } })
    expect((await post('session-1', 'edited', 'user', 'held', { steerPromoted: null, waitsForApproval: {}, approvalCardExpired: true,
      tts: false, clipIds: ['new-clip'] })).status).toBe(200)
    expect(redisMock.saveMessage.mock.calls[0][0]).toMatchObject({ content: 'edited', metadata: { ...markers, tts: false, clipIds: ['new-clip'] } })
    expect(redisMock.saveMessage.mock.calls[0][0].metadata).not.toHaveProperty('oldUserSetting')
  })

  it('a failed/mismatched stored read refuses before any browser write can erase a marker', async () => {
    redisMock.execute.mockRejectedValueOnce(new Error('message read unavailable'))
    expect((await post('session-1')).status).toBe(500)
    expect(redisMock.saveMessage).not.toHaveBeenCalled()
    stored.set('message:session-1:msg-reply', { role: 'user', session_id: 'somewhere-else', metadata: { steerPromoted: { steerIds: ['actual'] } } })
    expect((await post('session-1')).status).toBe(403)
    expect(redisMock.saveMessage).not.toHaveBeenCalled()
  })

})
