// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  loadCodexCleanupWarnings,
  recordCodexCleanupWarning,
  recordRecoveredCodexCleanupWarning
} from '../codexCleanupWarnings'

// The admission is a real RedisJSON Lua transaction. The default in-memory fake deliberately
// does not advertise arbitrary EVAL scripts; this contract runs in the Redis lane.
useRedisTestServer()
const realRedis = process.env.VITEST_USE_REAL_REDIS === 'true'
let serial = 0

async function fixture() {
  const sessionId = `codex-cleanup-${Date.now()}-${++serial}`
  const messageId = `reply-${serial}`
  await redis.createSession({ id: sessionId, user_id: 'owner', name: 'cleanup', agent_id: 'agent' } as any)
  await redis.saveMessage({
    id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
    role: 'assistant', content: 'Stopped reply', metadata: { interrupted: true }
  } as any)
  return { sessionId, messageId }
}

describe.skipIf(!realRedis)('Codex cleanup warning sidecar (real RedisJSON)', () => {
  it('records one fixed warning, independent of a stale browser reply save', async () => {
    const { sessionId, messageId } = await fixture()
    const input = { userId: 'owner', sessionId, messageId }
    await recordCodexCleanupWarning(input)
    await recordCodexCleanupWarning(input)
    expect(await redis.sMembers(`codex_cleanup_warnings:${sessionId}`)).toEqual([messageId])
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({
      [messageId]: { messageId, kind: 'unconfirmed_command_cleanup' }
    })
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'Older browser copy', metadata: { interrupted: true }
    } as any)
    expect((await loadCodexCleanupWarnings(sessionId))[messageId]?.kind).toBe('unconfirmed_command_cleanup')
  })

  it('atomically upgrades an existing warning to recovered and never downgrades it', async () => {
    const { sessionId, messageId } = await fixture()
    const input = { userId: 'owner', sessionId, messageId }
    await recordCodexCleanupWarning(input)
    await recordCodexCleanupWarning({ ...input, kind: 'recorded_processes_ended' })
    await recordCodexCleanupWarning(input)
    await recordCodexCleanupWarning({ ...input, kind: 'recorded_processes_ended' })
    expect(await redis.sMembers(`codex_cleanup_warnings:${sessionId}`)).toEqual([messageId])
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({
      [messageId]: { messageId, kind: 'recorded_processes_ended' }
    })
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'Old browser copy', metadata: { interrupted: true }
    } as any)
    expect((await loadCodexCleanupWarnings(sessionId))[messageId]?.kind).toBe('recorded_processes_ended')
  })

  it('reports durable storage when creating or upgrading a recovered warning', async () => {
    const { sessionId, messageId } = await fixture()
    const input = { userId: 'owner', sessionId, messageId }
    await recordCodexCleanupWarning(input)
    expect(await recordRecoveredCodexCleanupWarning(input)).toBe('stored')
    expect(await recordRecoveredCodexCleanupWarning(input)).toBe('stored')
    await recordCodexCleanupWarning(input)
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({
      [messageId]: { messageId, kind: 'recorded_processes_ended' }
    })

    const otherId = `recovered-${serial}`
    await redis.saveMessage({
      id: otherId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'Another stopped reply'
    } as any)
    expect(await recordRecoveredCodexCleanupWarning({ ...input, messageId: otherId })).toBe('stored')
    expect((await loadCodexCleanupWarnings(sessionId))[otherId]?.kind).toBe('recorded_processes_ended')
  })

  it('distinguishes missing replies and chats without creating warning keys', async () => {
    const { sessionId, messageId } = await fixture()
    await redis.deleteMessage(messageId, sessionId, 'owner')
    const input = { userId: 'owner', sessionId, messageId }
    expect(await recordRecoveredCodexCleanupWarning(input)).toBe('missing_reply')
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
    await redis.deleteSession(sessionId)
    expect(await recordRecoveredCodexCleanupWarning(input)).toBe('missing_chat')
    expect(await redis.exists(`codex_cleanup_warnings:${sessionId}`)).toBe(false)
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
  })

  it('does not count a process-local pending warning as durable storage', async () => {
    const sessionId = `codex-cleanup-recovery-pending-${Date.now()}-${++serial}`
    const messageId = `pending-${serial}`
    const input = { userId: 'owner', sessionId, messageId }
    await redis.createSession({ id: sessionId, user_id: 'owner', name: 'pending', agent_id: 'agent' } as any)
    await recordCodexCleanupWarning({ ...input, kind: 'recorded_processes_ended' })
    expect(await recordRecoveredCodexCleanupWarning(input)).toBe('missing_reply')
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
  })

  it('throws on wrong ownership or Redis failure without reporting durable storage', async () => {
    const { sessionId, messageId } = await fixture()
    const input = { userId: 'owner', sessionId, messageId }
    await expect(recordRecoveredCodexCleanupWarning({ ...input, userId: 'other' })).rejects.toThrow('owner or reply')
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
    await redis.set(`codex_cleanup_warnings:${sessionId}`, 'wrong type')
    await expect(recordRecoveredCodexCleanupWarning(input)).rejects.toThrow('wrong type')
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
  })

  it('retains recovered kind across pre-finalizer callbacks and the first reply save', async () => {
    const sessionId = `codex-cleanup-recovered-early-${Date.now()}-${++serial}`
    const messageId = `early-${serial}`
    const input = { userId: 'owner', sessionId, messageId }
    await redis.createSession({ id: sessionId, user_id: 'owner', name: 'early', agent_id: 'agent' } as any)
    await recordCodexCleanupWarning(input)
    await recordCodexCleanupWarning({ ...input, kind: 'recorded_processes_ended' })
    await recordCodexCleanupWarning(input)
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'Stopped'
    } as any)
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({
      [messageId]: { messageId, kind: 'recorded_processes_ended' }
    })
  })

  it('refuses wrong ownership, a missing reply, and a reply removed before the callback', async () => {
    const { sessionId, messageId } = await fixture()
    await recordCodexCleanupWarning({ userId: 'other', sessionId, messageId })
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId: 'missing' })
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
    await redis.deleteMessage(messageId, sessionId, 'owner')
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId })
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
  })

  it('carries a pre-finalizer failure onto the first saved reply, without creating a message', async () => {
    const sessionId = `codex-cleanup-early-${Date.now()}-${++serial}`
    const messageId = `early-${serial}`
    await redis.createSession({ id: sessionId, user_id: 'owner', name: 'early', agent_id: 'agent' } as any)
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId })
    expect(await redis.get(`message:${sessionId}:${messageId}`)).toBeNull()
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'Stopped', metadata: { interrupted: true }
    } as any)
    expect((await loadCodexCleanupWarnings(sessionId))[messageId]?.kind).toBe('unconfirmed_command_cleanup')
  })

  it('cancels a pending callback when its chat is deleted', async () => {
    const sessionId = `codex-cleanup-pending-delete-${Date.now()}-${++serial}`
    const messageId = `pending-${serial}`
    await redis.createSession({ id: sessionId, user_id: 'owner', name: 'pending', agent_id: 'agent' } as any)
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId })
    await redis.deleteSession(sessionId)
    // A recycled id must not inherit an old process's pending warning.
    await redis.createSession({ id: sessionId, user_id: 'owner', name: 'reused', agent_id: 'agent' } as any)
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'New reply'
    } as any)
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
  })

  it('removes a reply warning on message deletion and all warning keys on chat deletion', async () => {
    const { sessionId, messageId } = await fixture()
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId })
    await redis.deleteMessage(messageId, sessionId, 'owner')
    expect(await loadCodexCleanupWarnings(sessionId)).toEqual({})
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
    await redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'owner', agent_id: 'agent',
      role: 'assistant', content: 'New reply'
    } as any)
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId })
    await redis.deleteSession(sessionId)
    expect(await redis.exists(`codex_cleanup_warnings:${sessionId}`)).toBe(false)
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId })
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
    await recordCodexCleanupWarning({ userId: 'owner', sessionId, messageId, kind: 'recorded_processes_ended' })
    expect(await redis.exists(`codex_cleanup_warning:${sessionId}:${messageId}`)).toBe(false)
  })
})
