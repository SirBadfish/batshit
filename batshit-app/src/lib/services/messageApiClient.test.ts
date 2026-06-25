import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageApiClient } from './messageApiClient'

describe('MessageApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('surfaces missing sessions when loading full session history', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )

    const store = new MessageApiClient()

    await expect(store.getSessionMessages('missing-session')).rejects.toThrow('Session not found')
  })

  it('maps persisted assistant error metadata back to an error message state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            {
              id: 'msg-error',
              session_id: 'session-error',
              user_id: 'user-1',
              agent_id: 'agent-1',
              role: 'assistant',
              content: 'Input exceeds the maximum length of 1048576 characters.',
              created_at: '2026-06-08T00:00:00.000Z',
              metadata: {
                error_message:
                  'Input exceeds the maximum length of 1048576 characters.',
                response_failed: true
              }
            }
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
    )

    const store = new MessageApiClient()
    const [message] = await store.getSessionMessages('session-error')

    expect(message.status).toBe('error')
    expect(message.content).toContain('Input exceeds the maximum length')
    expect(message.metadata?.error_message).toContain('Input exceeds the maximum length')
  })
})
