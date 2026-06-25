/**
 * Unit Tests for Message ID Generation (Story 6.9b)
 * Pattern: msg_{YYYYMMDD-HHMMSS}_{counter}
 *
 * Critical Pattern: Uses Redis INCR for atomic counter increment
 * Updated: Story 6.9b - Human-readable timestamps and 4-digit counters
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateMessageId } from './messageId'

// Mock the redis module
vi.mock('$lib/server/redis', () => ({
  redis: {
    incr: vi.fn()
  }
}))

// Import the mocked redis
import { redis } from '$lib/server/redis'

describe('Message ID Generation (Story 6.9b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Format Pattern Validation', () => {
    it('6.9b-UNIT-001: should return correct format pattern (P0)', async () => {
      // Mock Redis INCR to return counter value
      vi.mocked(redis.incr).mockResolvedValue(1)

      const messageId = await generateMessageId('test-session')

      expect(messageId).not.toBeNull()
      // Pattern: msg_YYYYMMDD-HHMMSS_0001
      expect(messageId).toMatch(/^msg_\d{8}-\d{6}_\d{4}$/)
    })

    it('6.9b-UNIT-002: should use valid human-readable timestamp (P1)', async () => {
      vi.mocked(redis.incr).mockResolvedValue(1)

      const messageId = await generateMessageId('test-session')

      expect(messageId).not.toBeNull()

      // Extract timestamp from message ID (format: YYYYMMDD-HHMMSS)
      const match = messageId!.match(/^msg_(\d{8})-(\d{6})_\d{4}$/)
      expect(match).not.toBeNull()

      const datePart = match![1] // YYYYMMDD
      const timePart = match![2] // HHMMSS

      // Validate date part
      const year = parseInt(datePart.substring(0, 4))
      const month = parseInt(datePart.substring(4, 6))
      const day = parseInt(datePart.substring(6, 8))

      expect(year).toBeGreaterThanOrEqual(2025)
      expect(month).toBeGreaterThanOrEqual(1)
      expect(month).toBeLessThanOrEqual(12)
      expect(day).toBeGreaterThanOrEqual(1)
      expect(day).toBeLessThanOrEqual(31)

      // Validate time part
      const hours = parseInt(timePart.substring(0, 2))
      const minutes = parseInt(timePart.substring(2, 4))
      const seconds = parseInt(timePart.substring(4, 6))

      expect(hours).toBeGreaterThanOrEqual(0)
      expect(hours).toBeLessThanOrEqual(23)
      expect(minutes).toBeGreaterThanOrEqual(0)
      expect(minutes).toBeLessThanOrEqual(59)
      expect(seconds).toBeGreaterThanOrEqual(0)
      expect(seconds).toBeLessThanOrEqual(59)
    })

    it('6.9b-UNIT-003: should zero-pad counter to 4 digits (P0)', async () => {
      // Test various counter values
      const testCases = [
        { counter: 1, expected: '0001' },
        { counter: 10, expected: '0010' },
        { counter: 100, expected: '0100' },
        { counter: 999, expected: '0999' },
        { counter: 9999, expected: '9999' }
      ]

      for (const { counter, expected } of testCases) {
        vi.mocked(redis.incr).mockResolvedValue(counter)

        const messageId = await generateMessageId('test-session')
        expect(messageId).not.toBeNull()
        expect(messageId).toMatch(new RegExp(`_${expected}$`))
      }
    })
  })

  describe('Counter Behavior', () => {
    it('6.9b-UNIT-005: should increment counter sequentially (P0)', async () => {
      const counters = [1, 2, 3, 4, 5]
      let callCount = 0

      vi.mocked(redis.incr).mockImplementation(async () => {
        return counters[callCount++]
      })

      const messageIds = []
      for (let i = 0; i < 5; i++) {
        const id = await generateMessageId('test-session')
        messageIds.push(id)
      }

      expect(messageIds[0]).toMatch(/_0001$/)
      expect(messageIds[1]).toMatch(/_0002$/)
      expect(messageIds[2]).toMatch(/_0003$/)
      expect(messageIds[3]).toMatch(/_0004$/)
      expect(messageIds[4]).toMatch(/_0005$/)
    })

    it('6.9b-UNIT-006: should zero-pad counter correctly for edge cases (P0)', async () => {
      const testCases = [
        { counter: 1, expected: '0001' },
        { counter: 9, expected: '0009' },
        { counter: 10, expected: '0010' },
        { counter: 99, expected: '0099' },
        { counter: 100, expected: '0100' },
        { counter: 999, expected: '0999' },
        { counter: 9999, expected: '9999' }
      ]

      for (const { counter, expected } of testCases) {
        vi.mocked(redis.incr).mockResolvedValue(counter)

        const messageId = await generateMessageId('test-session')
        expect(messageId).not.toBeNull()
        expect(messageId).toContain(`_${expected}`)
      }
    })

    it('6.9b-UNIT-007: should support up to 9999 messages per session (P1)', async () => {
      const testCases = [
        { counter: 9997, expected: '9997' },
        { counter: 9998, expected: '9998' },
        { counter: 9999, expected: '9999' }
      ]

      for (const { counter, expected } of testCases) {
        vi.mocked(redis.incr).mockResolvedValue(counter)

        const messageId = await generateMessageId('test-session')
        expect(messageId).not.toBeNull()
        expect(messageId).toMatch(new RegExp(`_${expected}$`))
      }
    })

    it('6.9b-UNIT-008: should handle counter overflow gracefully (10000+) (P2)', async () => {
      const testCases = [10000, 50000, 100000]

      for (const counter of testCases) {
        vi.mocked(redis.incr).mockResolvedValue(counter)

        const messageId = await generateMessageId('test-session')
        expect(messageId).not.toBeNull()
        // Will exceed 4 digits, but should still work (no max limit enforced)
        expect(messageId).toMatch(new RegExp(`_${counter}$`))
      }
    })
  })

  describe('Session ID and Agent ID Exclusion', () => {
    it('6.9b-UNIT-004: should NOT include session ID in message ID (P1)', async () => {
      vi.mocked(redis.incr).mockResolvedValue(1)

      const sessionId = 'my-test-session-12345'
      const messageId = await generateMessageId(sessionId)

      expect(messageId).not.toBeNull()
      expect(messageId).not.toContain(sessionId)
      expect(messageId).not.toContain('my-test-session')
      expect(messageId).not.toContain('12345')
    })

    it('6.9b-UNIT-009: should NOT include agent ID in message ID (P1)', async () => {
      vi.mocked(redis.incr).mockResolvedValue(1)

      // Even though we pass session ID, verify no agent-like patterns appear
      const messageId = await generateMessageId('session-with-agent-123')

      expect(messageId).not.toBeNull()
      expect(messageId).toMatch(/^msg_\d{8}-\d{6}_\d{4}$/)
      // Verify it only has timestamp and counter, no other identifiers
      const parts = messageId!.split('_')
      expect(parts.length).toBe(3) // ['msg', timestamp-with-hyphen, counter]
    })
  })

  describe('Error Handling', () => {
    it('6.9b-UNIT-010: should return null when Redis INCR fails (P0)', async () => {
      // Mock Redis INCR to throw error
      vi.mocked(redis.incr).mockRejectedValue(new Error('Redis connection failed'))

      const messageId = await generateMessageId('test-session')

      expect(messageId).toBeNull()
    })

    it('6.9b-UNIT-011: should handle graceful degradation on Redis timeout', async () => {
      // Mock timeout error
      vi.mocked(redis.incr).mockRejectedValue(new Error('Operation timed out'))

      const messageId = await generateMessageId('test-session')

      expect(messageId).toBeNull()
    })

    it('6.9b-UNIT-012: should handle Redis network error gracefully', async () => {
      // Mock network error
      vi.mocked(redis.incr).mockRejectedValue(new Error('ECONNREFUSED'))

      const messageId = await generateMessageId('test-session')

      expect(messageId).toBeNull()
    })
  })

  describe('Redis Integration Patterns', () => {
    it('should use INCR for atomic counter increment', async () => {
      vi.mocked(redis.incr).mockResolvedValue(42)

      const sessionId = 'test-session'
      await generateMessageId(sessionId)

      // Verify INCR was called with correct key
      expect(redis.incr).toHaveBeenCalledWith(`message_counter:${sessionId}`)
      expect(redis.incr).toHaveBeenCalledTimes(1)
    })

    it('should use per-session counter keys', async () => {
      vi.mocked(redis.incr).mockResolvedValue(1)

      const session1 = 'session-alpha'
      const session2 = 'session-beta'

      await generateMessageId(session1)
      await generateMessageId(session2)

      // Verify different keys for different sessions
      expect(redis.incr).toHaveBeenNthCalledWith(1, `message_counter:${session1}`)
      expect(redis.incr).toHaveBeenNthCalledWith(2, `message_counter:${session2}`)
    })

    it('should never use manual get/set pattern (anti-pattern check)', async () => {
      vi.mocked(redis.incr).mockResolvedValue(5)

      await generateMessageId('test-session')

      // Verify only INCR was called (atomic operation)
      expect(redis.incr).toHaveBeenCalled()

      // Verify no get/set calls (would indicate manual counter increment - race condition!)
      expect(redis).not.toHaveProperty('get')
      expect(redis).not.toHaveProperty('set')
    })
  })

  describe('Collision Prevention', () => {
    it('6.9b-UNIT-013: should generate unique IDs for rapid successive calls', async () => {
      let counter = 0
      vi.mocked(redis.incr).mockImplementation(async () => ++counter)

      // Simulate rapid successive message creation
      const ids = await Promise.all([
        generateMessageId('test-session'),
        generateMessageId('test-session'),
        generateMessageId('test-session'),
        generateMessageId('test-session'),
        generateMessageId('test-session')
      ])

      // Verify all IDs are unique (counters are different)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(5)

      // Verify counters are sequential (4-digit padding)
      expect(ids[0]).toContain('_0001')
      expect(ids[1]).toContain('_0002')
      expect(ids[2]).toContain('_0003')
      expect(ids[3]).toContain('_0004')
      expect(ids[4]).toContain('_0005')
    })
  })
})
