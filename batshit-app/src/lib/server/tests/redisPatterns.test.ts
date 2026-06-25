/**
 * Redis 8 Stack Pattern Compliance Tests
 * Ensures integration code uses RedisJSON and list semantics correctly
 * Test IDs reference QA audit 4.3 series
 */

import { describe, it, expect } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '../redis'
import { redisStreamService } from '../redisStreamService'

useRedisTestServer()

describe('Redis 8 Pattern Compliance', () => {
  it('stores metadata objects without stringification (4.3-UNIT-REDIS-001)', async () => {
    const key = 'test:metadata'
    const metadata = { test: 'data', nested: { value: 123 } }

    await redis.set(key, metadata)

    const storedViaJson = await redis.json.get(key)
    expect(storedViaJson).toEqual(metadata)

    await expect(
      redis.execute(async (client) => client.get(key))
    ).rejects.toThrow(/WRONGTYPE/)
  })

  it('returns parsed objects from redis.json.get (4.3-UNIT-REDIS-002)', async () => {
    const key = 'test:json_get'
    const payload = { hello: 'world', count: 2 }

    await redis.json.set(key, '$', payload)

    const result = await redis.json.get(key)
    expect(result).toEqual(payload)
  })

  it('distinguishes between JSON and string keys (4.3-UNIT-REDIS-003)', async () => {
    const jsonKey = 'test:type:json'
    const stringKey = 'test:type:string'

    await redis.set(jsonKey, { value: 42 })
    await redis.set(stringKey, 'hello world')

    const jsonType = await redis.execute(async (client) => client.type(jsonKey))
    const stringType = await redis.execute(async (client) => client.type(stringKey))

    expect(jsonType).toBe('ReJSON-RL')
    expect(stringType).toBe('string')

    const stringValue = await redis.get(stringKey)
    expect(stringValue).toBe('hello world')
  })

  it('uses list operations for streaming chunks (4.3-UNIT-REDIS-004)', async () => {
    const key = redisStreamService.createTempStorageKey('session-chunks', 'message-chunks', 'terminal', 1)

    await redisStreamService.appendChunk(key, 'chunk1')
    await redisStreamService.appendChunk(key, 'chunk2')

    const storedChunks = await redis.lRange(key, 0, -1)
    expect(storedChunks).toEqual(['chunk1', 'chunk2'])

    const keyType = await redis.execute(async (client) => client.type(key))
    expect(keyType).toBe('list')
  })

  it('cleans up temporary metadata after completing blocks', async () => {
    const sessionId = 'session-cleanup'
    const messageId = 'message-cleanup'
    const metadataKey = redisStreamService.createTempMetadataKey(sessionId, messageId)
    const storageKey = redisStreamService.createTempStorageKey(sessionId, messageId, 'terminal', 1)

    await redisStreamService.startZipBlock({
      sessionId,
      messageId,
      type: 'terminal',
      index: 1,
      startedAt: new Date().toISOString()
    })
    await redisStreamService.appendChunk(storageKey, 'chunk')

    const content = await redisStreamService.completeZipBlock(sessionId, messageId, 'terminal', 1)
    expect(content).toBe('chunk')

    expect(await redis.exists(storageKey)).toBe(false)
    expect(await redis.exists(metadataKey)).toBe(false)
  })

  it('preserves failed assistant message status for reload recovery', async () => {
    const sessionId = 'session-failed-assistant'
    const userId = 'user-failed-assistant'
    const messageId = 'msg-failed-assistant'

    await redis.createSession({
      id: sessionId,
      user_id: userId,
      name: 'Failed Assistant Recovery'
    })

    await redis.saveMessage({
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      agent_id: 'agent-failed-assistant',
      role: 'assistant',
      status: 'error',
      content: 'Input exceeds the maximum length of 1048576 characters.',
      metadata: {
        error_message: 'Input exceeds the maximum length of 1048576 characters.',
        response_failed: true
      }
    })

    const [message] = await redis.getMessages(sessionId)

    expect(message.status).toBe('error')
    expect(message.content).toContain('Input exceeds the maximum length')
    expect(message.metadata?.error_message).toContain('Input exceeds the maximum length')
  })
})
