/**
 * Redis Stream Service Tests
 * Validates the Stream-to-Zip architecture against a real Redis instance
 * Covers QA Test IDs 4.3-UNIT-001 through 4.3-UNIT-014
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '../redis'
import { RedisStreamService } from '../redisStreamService'

useRedisTestServer()

describe('RedisStreamService', () => {
  let service: RedisStreamService
  const sessionId = 'session123'
  const messageId = 'message456'

  beforeEach(() => {
    service = new RedisStreamService()
  })

  describe('Key pattern helpers', () => {
    it('generates deterministic storage keys (4.3-UNIT-001)', () => {
      const key = service.createTempStorageKey(sessionId, messageId, 'terminal', 1)
      expect(key).toBe('zip_temp:session123:message456:terminal:1')
    })

    it('generates metadata keys', () => {
      const key = service.createTempMetadataKey(sessionId, messageId)
      expect(key).toBe('zip_temp_meta:session123:message456')
    })
  })

  describe('appendChunk', () => {
    it('stores chunks in Redis lists with TTL (4.3-UNIT-002, 4.3-UNIT-004)', async () => {
      const key = service.createTempStorageKey('session-append', 'message-append', 'terminal', 1)
      await redis.del(key)

    await service.appendChunk(key, 'chunk-1')
    await service.appendChunk(key, 'chunk-2')

    const stored = await redis.lRange(key, 0, -1)
    expect(stored).toEqual(['chunk-1', 'chunk-2'])

      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(0)
    })

    it('handles empty chunks gracefully (4.3-UNIT-003)', async () => {
      const key = service.createTempStorageKey('session-empty', 'message-empty', 'terminal', 1)
      await redis.del(key)
      await service.appendChunk(key, '')
      const stored = await redis.lRange(key, 0, -1)
      expect(stored).toEqual([''])
    })

    it('refreshes the active metadata TTL when chunks keep streaming', async () => {
      const session = 'session-meta-refresh'
      const message = 'message-meta-refresh'
      const storageKey = service.createTempStorageKey(session, message, 'terminal', 1)
      const metaKey = service.createTempMetadataKey(session, message)
      await redis.del(storageKey)
      await redis.del(metaKey)

      await service.startZipBlock({
        sessionId: session,
        messageId: message,
        type: 'terminal',
        index: 1,
        startedAt: new Date().toISOString()
      })
      await redis.execute(async (client) => client.expire(metaKey, 1))

      await service.appendChunk(storageKey, 'still streaming')

      const ttl = await redis.ttl(metaKey)
      expect(ttl).toBeGreaterThan(1)
    })
  })

  describe('Zip block lifecycle', () => {
    it('assembles and cleans chunks on completion (4.3-UNIT-005)', async () => {
      const session = 'session-lifecycle'
      const message = 'message-lifecycle'
      const storageKey = service.createTempStorageKey(session, message, 'terminal', 1)

      await service.startZipBlock({
        sessionId: session,
        messageId: message,
        type: 'terminal',
        index: 1,
        startedAt: new Date().toISOString(),
        language: 'ts'
      })

      await service.appendChunk(storageKey, 'chunk1')
      await service.appendChunk(storageKey, 'chunk2')

      const content = await service.completeZipBlock(session, message, 'terminal', 1)
      expect(content).toBe('chunk1chunk2')

      expect(await redis.exists(storageKey)).toBe(false)
      expect(await redis.exists(service.createTempMetadataKey(session, message))).toBe(false)
    })

    it('reports active zip blocks (4.3-UNIT-010)', async () => {
      const session = 'session-active'
      const message = 'message-active'
      await service.startZipBlock({
        sessionId: session,
        messageId: message,
        type: 'terminal',
        index: 1,
        startedAt: new Date().toISOString()
      })

      const blocks = await service.getActiveZipBlocks(session, message)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.type).toBe('terminal')
    })
  })

  describe('cleanup utilities', () => {
    it('removes all temporary data for a session (4.3-UNIT-014)', async () => {
      const session = 'session-cleanup'
      const message = 'message-cleanup'
      const storageKey = service.createTempStorageKey(session, message, 'terminal', 1)
      await service.appendChunk(storageKey, 'chunk')
      await service.startZipBlock({
        sessionId: session,
        messageId: message,
        type: 'terminal',
        index: 1,
        startedAt: new Date().toISOString()
      })

      await service.cleanupSessionTempStorage(session)

      const tempKeys = await redis.execute(async (client) =>
        client.keys(`zip_temp:${session}:*`)
      )
      const metaKeys = await redis.execute(async (client) =>
        client.keys(`zip_temp_meta:${session}:*`)
      )

      expect(tempKeys).toHaveLength(0)
      expect(metaKeys).toHaveLength(0)
    })

    it('tracks concurrent blocks with incremental indices', async () => {
      const session = `session-concurrent-${randomUUID()}`
      const message = `message-concurrent-${randomUUID()}`

      const index1 = await service.trackConcurrentBlock(session, message, 'terminal')
      const index2 = await service.trackConcurrentBlock(session, message, 'terminal')

      expect(index1).toBe(1)
      expect(index2).toBe(2)

      const blocks = await service.getActiveZipBlocks(session, message)
      expect(blocks).toHaveLength(2)
    })
  })
})
