import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  getSessionMessages: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

import { resolveContextPreviewMessages } from '$lib/server/services/contextTokenPreview'

describe('context preview message source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses stored session messages when the client requests a post-save preview', async () => {
    redisMock.getSessionMessages.mockResolvedValue([
      {
        id: 'stored-assistant',
        session_id: 'session-1',
        user_id: 'user-1',
        role: 'assistant',
        content: '{{batshit-zip:zip_1:::Saved tool result}}',
        created_at: '2026-06-01T00:00:00.000Z'
      }
    ])

    const messages = await resolveContextPreviewMessages({
      sessionId: 'session-1',
      providedMessages: [
        {
          id: 'client-assistant',
          session_id: 'session-1',
          user_id: 'user-1',
          role: 'assistant',
          content: 'A'.repeat(20_000),
          created_at: '2026-06-01T00:00:00.000Z'
        }
      ],
      useStoredMessages: true
    })

    expect(redisMock.getSessionMessages).toHaveBeenCalledWith('session-1')
    expect(messages.map((message) => message.id)).toEqual(['stored-assistant'])
    expect(messages[0]?.content).toContain('{{batshit-zip:zip_1')
  })

  it('keeps using provided client messages for normal local context-control previews', async () => {
    const messages = await resolveContextPreviewMessages({
      sessionId: 'session-1',
      providedMessages: [
        {
          id: 'client-user',
          session_id: 'session-1',
          user_id: 'user-1',
          role: 'user',
          content: 'Current in-memory trimmed view',
          created_at: '2026-06-01T00:00:00.000Z'
        }
      ],
      useStoredMessages: false
    })

    expect(redisMock.getSessionMessages).not.toHaveBeenCalled()
    expect(messages.map((message) => message.id)).toEqual(['client-user'])
  })
})

// SA-139 R4: the CLI token path (the Claude Code CLI model's 1M cap, the CLI runtime flavor and
// its wrapper overhead) left with the Claude Code CLI Primary lane.
