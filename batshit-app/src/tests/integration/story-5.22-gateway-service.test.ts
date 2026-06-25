/**
 * Story 5.22 - Phase 7: P0 Critical Tests - Gateway Service
 *
 * Redis lane honesty (G-0228): under plain `npm test` this suite runs against the
 * in-memory RedisJSON fake from vitest-setup.ts. It uses REAL Redis (DB15 via the
 * useRedisTestServer harness) only under `npm run test:redis` — run that lane when
 * validating real RedisJSON serialization behavior.
 * Risk Coverage: DATA-001 (Redis double stringification)
 *
 * P0 Tests:
 * - 5.22-UNIT-001: Create gateway with valid data
 * - 5.22-INT-001: Store gateway without stringify (DATA-001)
 * - 5.22-INT-002: Retrieve gateway as object (DATA-001)
 * - 5.22-INT-005: Correct Redis key pattern (DATA-001)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { MCPGatewayService } from '$lib/server/services/mcpGatewayService'
import { redis } from '$lib/server/redis'
import type { MCPGateway } from '$lib/types/database'

const TEST_USER_ID = 'test-user-gateway-service'
const gatewayService = new MCPGatewayService()

useRedisTestServer()

describe('Story 5.22 - P0: Gateway Service (real Redis under test:redis)', () => {

  // Cleanup before and after each test
  beforeEach(async () => {
    await redis.del(`mcp_gateways:${TEST_USER_ID}`)
  })

  afterEach(async () => {
    await redis.del(`mcp_gateways:${TEST_USER_ID}`)
  })

  describe('P0-UNIT: Service Creation', () => {

    test('5.22-UNIT-001: Create gateway with valid data', async () => {
      const gateway: Omit<MCPGateway, 'id'> = {
        name: 'Test Docker Gateway',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true,
        autoStart: false
      }

      const created = await gatewayService.create(TEST_USER_ID, gateway)

      // Verify gateway has ID
      expect(created.id).toBeDefined()
      expect(created.id).toBeTruthy()

      // Verify all fields preserved
      expect(created.name).toBe(gateway.name)
      expect(created.type).toBe(gateway.type)
      expect(created.url).toBe(gateway.url)
      expect(created.enabled).toBe(gateway.enabled)
      expect(created.autoStart).toBe(gateway.autoStart)
    })

    test('5.22-UNIT-002: Reject gateway with invalid type', async () => {
      const invalidGateway: any = {
        name: 'Invalid Gateway',
        type: 'invalid-type',
        url: 'http://localhost:8080/mcp',
        enabled: true
      }

      await expect(
        gatewayService.create(TEST_USER_ID, invalidGateway)
      ).rejects.toThrow()
    })

    test('5.22-UNIT-003: Reject local batshit-server gateway URL by policy', async () => {
      const blockedGateway: Omit<MCPGateway, 'id'> = {
        name: 'Blocked Batshit-Server Gateway',
        type: 'custom',
        url: 'http://localhost:5601/mcp',
        enabled: true
      }

      await expect(
        gatewayService.create(TEST_USER_ID, blockedGateway)
      ).rejects.toThrow('disabled by policy')
    })
  })

  describe('P0-INT: Redis Pattern Compliance (DATA-001)', () => {

    test('5.22-INT-001: Store gateway WITHOUT JSON.stringify (CRITICAL)', async () => {
      const gateway: Omit<MCPGateway, 'id'> = {
        name: 'Redis Pattern Test Gateway',
        type: 'n8n-mcp-trigger',
        url: 'http://localhost:5678/mcp/test',
        enabled: true,
        discoveredTools: ['tool1', 'tool2', 'tool3'],
        metadata: {
          description: 'Test gateway for pattern compliance',
          tags: ['test', 'redis']
        }
      }

      // Create gateway (uses redis.json.set internally)
      const created = await gatewayService.create(TEST_USER_ID, gateway)

      // CRITICAL: Direct Redis inspection to detect double stringification
      const raw = await redis.json.get(`mcp_gateways:${TEST_USER_ID}`)

      // If double-stringified, raw would be a string with escaped quotes (\")
      expect(typeof raw).toBe('object')
      expect(raw).not.toBeNull()

      // Verify no escaped quotes in stringified form (sign of double stringify)
      const stringified = JSON.stringify(raw)
      expect(stringified).not.toMatch(/\\"/)

      // Verify data structure is correct
      expect(raw).toHaveProperty('gateways')
      expect(Array.isArray(raw.gateways)).toBe(true)
      expect(raw.gateways[0]).toEqual(created)

      // Verify nested objects preserved
      expect(raw.gateways[0].metadata).toEqual(gateway.metadata)
      expect(raw.gateways[0].discoveredTools).toEqual(gateway.discoveredTools)
    })

    test('5.22-INT-002: Retrieve gateway as object, NOT string (CRITICAL)', async () => {
      const gateway: Omit<MCPGateway, 'id'> = {
        name: 'Retrieval Test Gateway',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true
      }

      // Store gateway
      const created = await gatewayService.create(TEST_USER_ID, gateway)

      // Retrieve gateway using service
      const retrieved = await gatewayService.get(TEST_USER_ID, created.id)

      // CRITICAL: Should be an object, not a string
      expect(retrieved).toBeDefined()
      expect(typeof retrieved).toBe('object')
      expect(retrieved).not.toBeNull()

      // Verify it's not a stringified object
      expect(typeof retrieved!.name).toBe('string')
      expect(retrieved!.name).not.toMatch(/^["']/)

      // Verify all fields are correct types
      expect(typeof retrieved!.enabled).toBe('boolean')
      expect(typeof retrieved!.url).toBe('string')
      expect(typeof retrieved!.type).toBe('string')

      // Verify data matches
      expect(retrieved).toEqual(created)
    })

    test('5.22-INT-005: Uses correct Redis key pattern (CRITICAL)', async () => {
      const gateway: Omit<MCPGateway, 'id'> = {
        name: 'Key Pattern Test',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true
      }

      await gatewayService.create(TEST_USER_ID, gateway)

      // CRITICAL: Key must follow pattern: mcp_gateways:{userId}
      const expectedKey = `mcp_gateways:${TEST_USER_ID}`

      // Verify key exists with correct pattern
      const exists = await redis.exists(expectedKey)
      expect(exists).toBe(true)

      // Verify no other keys created
      const allKeys = await redis.keys('mcp_gateways:*')
      const testKeys = allKeys.filter(k => k.includes(TEST_USER_ID))
      expect(testKeys).toEqual([expectedKey])
    })
  })

  describe('P1: CRUD Operations', () => {

    test('5.22-INT-003: Update gateway preserves other gateways', async () => {
      // Create two gateways
      const gateway1 = await gatewayService.create(TEST_USER_ID, {
        name: 'Gateway 1',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true
      })

      const gateway2 = await gatewayService.create(TEST_USER_ID, {
        name: 'Gateway 2',
        type: 'n8n-mcp-trigger',
        url: 'http://localhost:5678/mcp/test',
        enabled: true
      })

      // Update gateway1
      const updated = await gatewayService.update(TEST_USER_ID, gateway1.id, {
        name: 'Gateway 1 Updated'
      })

      expect(updated.name).toBe('Gateway 1 Updated')

      // Verify gateway2 is unchanged
      const gateway2Retrieved = await gatewayService.get(TEST_USER_ID, gateway2.id)
      expect(gateway2Retrieved).toEqual(gateway2)
    })

    test('5.22-INT-004: Delete gateway removes only target', async () => {
      // Create two gateways
      const gateway1 = await gatewayService.create(TEST_USER_ID, {
        name: 'Gateway 1',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true
      })

      const gateway2 = await gatewayService.create(TEST_USER_ID, {
        name: 'Gateway 2',
        type: 'n8n-mcp-trigger',
        url: 'http://localhost:5678/mcp/test',
        enabled: true
      })

      // Delete gateway1
      await gatewayService.delete(TEST_USER_ID, gateway1.id)

      // Verify gateway1 deleted
      const gateway1Retrieved = await gatewayService.get(TEST_USER_ID, gateway1.id)
      expect(gateway1Retrieved).toBeNull()

      // Verify gateway2 still exists
      const gateway2Retrieved = await gatewayService.get(TEST_USER_ID, gateway2.id)
      expect(gateway2Retrieved).toEqual(gateway2)
    })
  })
})
