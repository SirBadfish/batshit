import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { GET } from './+server'

/**
 * GET /api/messages/[sessionId]?limit=N gives the NEWEST N messages, oldest first (bug sweep,
 * 2026-09-18).
 *
 * The chat page loads a chat with `limit=1000`, and the route read `getMessages`, which is the
 * FIRST N: a chat longer than 1,000 messages showed its oldest messages and never its newest, and
 * a send carried that history. Every other caller asks only whether a chat has messages, or reads
 * its latest reply (the dev smoke runner, the proof drivers), so the newest window is right for all of them.
 */

vi.mock('$lib/server/services/messageZipTrust', () => ({
  enrichMessagesWithTrustedZipMetadata: async (messages: unknown[]) => messages
}))

useRedisTestServer()

const USER = 'user-messages-window'

async function chatWith(count: number) {
  const sessionId = `messages-window-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  await redis.createSession({ id: sessionId, user_id: USER, name: 'chat', agent_id: 'agent-1' } as any)
  for (let index = 1; index <= count; index += 1) {
    await redis.saveMessage({
      id: `m${index}`,
      session_id: sessionId,
      user_id: USER,
      agent_id: 'agent-1',
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `message ${index}`,
      metadata: {}
    } as any)
  }
  return sessionId
}

async function load(sessionId: string, limit?: number) {
  const url = new URL(`http://localhost/api/messages/${sessionId}${limit ? `?limit=${limit}` : ''}`)
  const response = await GET({ params: { sessionId }, url, locals: { user: { id: USER } } } as any)
  expect(response.status).toBe(200)
  return ((await response.json()) as Array<{ id: string }>).map((message) => message.id)
}

describe('GET /api/messages/[sessionId]', () => {
  it('a window smaller than the chat is its newest messages, in order', async () => {
    const sessionId = await chatWith(5)
    expect(await load(sessionId, 2)).toEqual(['m4', 'm5'])
  })

  it('a window as large as the chat is the whole chat, in order', async () => {
    const sessionId = await chatWith(5)
    expect(await load(sessionId, 1000)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })

  it('a one-message window still says whether the chat has messages', async () => {
    const empty = await chatWith(0)
    expect(await load(empty, 1)).toEqual([])
    const full = await chatWith(3)
    expect(await load(full, 1)).toEqual(['m3'])
  })
})
