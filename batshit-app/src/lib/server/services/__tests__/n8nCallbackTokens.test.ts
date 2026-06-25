import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const client = {
    set: vi.fn(async (key: string, value: string, options?: unknown) => {
      store.set(key, value)
      return 'OK'
    }),
  }

  return {
    store,
    client,
    execute: vi.fn(async (operation: (client: typeof client) => Promise<unknown>) =>
      operation(client),
    ),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: mocks.execute,
    get: mocks.get,
    del: mocks.del,
  },
}))

import {
  createN8nSseCallbackToken,
  isTrustedN8nSseCallbackRequest,
  N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER,
  N8N_SSE_CALLBACK_TOKEN_HEADER,
  N8N_SSE_CALLBACK_TOKEN_TTL_SECONDS,
  validateN8nScopedCallbackRequest,
} from '$lib/server/services/n8nCallbackTokens'

describe('n8nCallbackTokens', () => {
  beforeEach(() => {
    mocks.store.clear()
    mocks.client.set.mockClear()
    mocks.execute.mockClear()
    mocks.get.mockClear()
    mocks.del.mockClear()
  })

  it('creates a scoped callback token with a Redis TTL', async () => {
    const result = await createN8nSseCallbackToken({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      userId: 'user-1',
    })

    expect(result.token).toHaveLength(43)
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now())
    expect(mocks.client.set).toHaveBeenCalledWith(
      'n8n:sse-callback:sess-1:msg-1',
      expect.any(String),
      { EX: N8N_SSE_CALLBACK_TOKEN_TTL_SECONDS },
    )
  })

  it('trusts matching callback requests only for the scoped session and message', async () => {
    const result = await createN8nSseCallbackToken({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      userId: 'user-1',
    })
    const request = new Request('http://localhost/api/sse', {
      headers: {
        [N8N_SSE_CALLBACK_TOKEN_HEADER]: result.token,
      },
    })

    await expect(
      isTrustedN8nSseCallbackRequest(request, {
        sessionId: 'sess-1',
        messageId: 'msg-1',
      }),
    ).resolves.toBe(true)

    await expect(
      isTrustedN8nSseCallbackRequest(request, {
        sessionId: 'sess-1',
        messageId: 'msg-2',
      }),
    ).resolves.toBe(false)
  })

  it('trusts native tool dispatch callback requests with nested context identity', async () => {
    const result = await createN8nSseCallbackToken({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      userId: 'User-1',
      agentId: 'n8n_primary_agent',
      projectPath: '/Users/example/batshit',
    })
    const request = new Request('http://localhost/api/native-tools/dispatch', {
      headers: {
        [N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER]: result.token,
      },
    })

    await expect(
      validateN8nScopedCallbackRequest(
        request,
        {
          userId: 'user-1',
          action: 'runtime_addon_list',
          input: {},
          context: {
            session_id: 'sess-1',
            message_id: 'msg-1',
            agent_id: 'n8n_primary_agent',
            primary_agent_type: 'n8n',
            actor_type: 'primary',
          },
        },
        'user-1',
      ),
    ).resolves.toMatchObject({
      valid: true,
      userId: 'user-1',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      projectPath: '/Users/example/batshit',
    })
  })

  it('rejects callback tokens when the claimed user does not own the token', async () => {
    const result = await createN8nSseCallbackToken({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      userId: 'user-1',
    })
    const request = new Request('http://localhost/api/native-tools/dispatch', {
      headers: {
        [N8N_SSE_CALLBACK_TOKEN_HEADER]: result.token,
      },
    })

    await expect(
      validateN8nScopedCallbackRequest(
        request,
        {
          userId: 'user-2',
          context: {
            session_id: 'sess-1',
            message_id: 'msg-1',
          },
        },
        'user-2',
      ),
    ).resolves.toEqual({ valid: false })
  })

  it('rejects native tool callback tokens when the primary agent context does not match', async () => {
    const result = await createN8nSseCallbackToken({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      userId: 'user-1',
      agentId: 'agent-1',
    })
    const request = new Request('http://localhost/api/native-tools/dispatch', {
      headers: {
        [N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER]: result.token,
      },
    })

    await expect(
      validateN8nScopedCallbackRequest(
        request,
        {
          userId: 'user-1',
          context: {
            session_id: 'sess-1',
            message_id: 'msg-1',
            agent_id: 'agent-2',
            actor_type: 'primary',
          },
        },
        'user-1',
      ),
    ).resolves.toEqual({ valid: false })
  })

  it('rejects expired callback tokens and deletes their Redis record', async () => {
    const result = await createN8nSseCallbackToken({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      userId: 'user-1',
    })
    const key = 'n8n:sse-callback:sess-1:msg-1'
    const stored = JSON.parse(String(mocks.store.get(key)))
    mocks.store.set(
      key,
      JSON.stringify({
        ...stored,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    )

    const request = new Request('http://localhost/api/sse', {
      headers: {
        [N8N_SSE_CALLBACK_TOKEN_HEADER]: result.token,
      },
    })

    await expect(
      isTrustedN8nSseCallbackRequest(request, {
        sessionId: 'sess-1',
        messageId: 'msg-1',
      }),
    ).resolves.toBe(false)
    expect(mocks.del).toHaveBeenCalledWith(key)
  })
})
