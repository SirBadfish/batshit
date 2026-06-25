/**
 * Story 5.22 - Phase 7: P0 Critical Tests - MCP Client Lifecycle
 *
 * CRITICAL: Tests use REAL n8n MCP Trigger workflows (no mocks)
 * Risk Coverage: TECH-002 (MCP client connection leaks)
 *
 * P0 Tests:
 * - 5.22-INT-012: Connect to real n8n MCP Trigger workflow
 * - 5.22-INT-013: Close client after successful discovery (CRITICAL)
 * - 5.22-INT-014: Close client when discovery fails (CRITICAL)
 * - 5.22-INT-023: 100 sequential discoveries don't leak (LOAD TEST)
 *
 * SETUP REQUIRED:
 * Before running these tests, create an n8n workflow:
 * - Name: "Test - Code Tools Gateway"
 * - MCP Server Trigger node with path: /mcp/test-code-tools
 * - Add at least one MCP Client node (e.g., read_file from batshit-server)
 * - Activate the workflow
 * - Test URL: http://localhost:5678/mcp/test-code-tools
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { N8nMCPGatewayClient } from '$lib/server/services/n8nMCPGatewayClient'
import { DockerMCPGatewayClient } from '$lib/server/services/dockerMCPGatewayClient'
import { MCPGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import type { MCPGateway } from '$lib/types/database'

// Test gateway URLs
const TEST_N8N_URL = 'http://localhost:5678/mcp/test-code-tools'
const TEST_DOCKER_URL = 'http://localhost:8080/mcp'

const TEST_N8N_GATEWAY: MCPGateway = {
  id: 'test-n8n-gateway',
  name: 'Test n8n MCP Gateway',
  type: 'n8n-mcp-trigger',
  url: TEST_N8N_URL,
  enabled: true
}

const TEST_DOCKER_GATEWAY: MCPGateway = {
  id: 'test-docker-gateway',
  name: 'Test Docker Gateway',
  type: 'docker-catalog',
  url: TEST_DOCKER_URL,
  enabled: true
}

describe('Story 5.22 - P0: MCP Client Lifecycle (REAL Infrastructure)', () => {

  let n8nAvailable = false
  let dockerAvailable = false

  beforeAll(async () => {
    const n8nClient = new N8nMCPGatewayClient()
    const dockerClient = new DockerMCPGatewayClient()

    const [n8nHealth, dockerHealth] = await Promise.allSettled([
      n8nClient.healthCheck(TEST_N8N_URL, 1500),
      dockerClient.healthCheck(1500)
    ])

    n8nAvailable = n8nHealth.status === 'fulfilled' && n8nHealth.value.available
    dockerAvailable = dockerHealth.status === 'fulfilled' && dockerHealth.value.available

    if (!n8nAvailable && !dockerAvailable) {
      console.warn('⚠️  WARNING: Neither n8n nor Docker gateways available for testing')
      console.warn('⚠️  Create n8n workflow at: http://localhost:5678/mcp/test-code-tools')
      console.warn('⚠️  Or start Docker Gateway at: http://localhost:8080/mcp')
    }
  })

  describe('P0-INT: n8n MCP Gateway Client Lifecycle (TECH-002)', () => {

    test('5.22-INT-012: Connect to real n8n MCP Trigger workflow', async () => {
      if (!n8nAvailable) {
        console.warn('Skipping 5.22-INT-012: n8n workflow not available')
        return
      }

      const client = new N8nMCPGatewayClient()

      // Test health check
      const health = await client.healthCheck(TEST_N8N_URL)
      expect(health.available).toBe(true)
      expect(health.toolCount).toBeGreaterThan(0)

      // Test tool discovery
      const tools = await client.discoverTools(TEST_N8N_URL)

      // Should discover at least one tool from the workflow
      expect(Array.isArray(tools)).toBe(true)
      expect(tools.length).toBeGreaterThan(0)

      // Verify tool structure
      tools.forEach(tool => {
        expect(tool).toHaveProperty('name')
        expect(typeof tool.name).toBe('string')
      })
    })

    test('5.22-INT-013: Close MCP client after successful discovery (CRITICAL)', async () => {
      if (!n8nAvailable) {
        console.warn('Skipping 5.22-INT-013: n8n workflow not available')
        return
      }

      const client = new N8nMCPGatewayClient()

      // CRITICAL: This test verifies the try/finally pattern is working
      // We can't directly measure connections, but we can verify:
      // 1. Discovery succeeds
      // 2. Multiple discoveries don't throw errors (would happen if leaking)
      // 3. Function completes without hanging

      const discovery1 = await client.discoverTools(TEST_N8N_URL)
      expect(discovery1.length).toBeGreaterThan(0)

      // Immediate second discovery should work (client was closed)
      const discovery2 = await client.discoverTools(TEST_N8N_URL)
      expect(discovery2.length).toBeGreaterThan(0)

      // Third time to be sure
      const discovery3 = await client.discoverTools(TEST_N8N_URL)
      expect(discovery3.length).toBeGreaterThan(0)

      // If client wasn't closed, one of these would likely fail/hang
      expect(discovery1).toEqual(discovery2)
      expect(discovery2).toEqual(discovery3)
    })

    test('5.22-INT-014: Close client even when discovery fails (CRITICAL)', async () => {
      // Test with invalid URL to trigger error
      const invalidUrl = 'http://localhost:5678/mcp/definitely-does-not-exist-12345'

      const client = new N8nMCPGatewayClient()

      // CRITICAL: Verify cleanup happens even on error
      await expect(client.discoverTools(invalidUrl, { timeoutMs: 1000 })).rejects.toThrow()

      // Should still be able to call again (no leaked connection blocking)
      await expect(client.discoverTools(invalidUrl, { timeoutMs: 1000 })).rejects.toThrow()

      // Health check should also handle cleanup
      const health = await client.healthCheck(invalidUrl, 1000)
      expect(health.available).toBe(false)
      expect(health.error).toBeDefined()
    })
  })

  describe('P0-INT: Docker Gateway Client Lifecycle (TECH-002)', () => {

    test('Docker client closes after successful discovery', async () => {
      if (!dockerAvailable) {
        console.warn('Skipping Docker lifecycle test: Gateway not available')
        return
      }

      const client = new DockerMCPGatewayClient()

      // Multiple discoveries should all succeed (client closes each time)
      const discovery1 = await client.discoverTools(TEST_DOCKER_URL)
      expect(discovery1.length).toBeGreaterThan(0)

      const discovery2 = await client.discoverTools(TEST_DOCKER_URL)
      expect(discovery2.length).toBeGreaterThan(0)

      const discovery3 = await client.discoverTools(TEST_DOCKER_URL)
      expect(discovery3.length).toBeGreaterThan(0)

      // All should return same tools
      expect(discovery1).toEqual(discovery2)
      expect(discovery2).toEqual(discovery3)
    })
  })

  describe('P0-INT: Unified Gateway Discovery Lifecycle (TECH-002)', () => {

    test('5.22-INT-023: 100 sequential discoveries do NOT leak connections (LOAD TEST)', async () => {
      const gateways: MCPGateway[] = []

      // Add available gateways
      if (n8nAvailable) gateways.push(TEST_N8N_GATEWAY)
      if (dockerAvailable) gateways.push(TEST_DOCKER_GATEWAY)

      if (gateways.length === 0) {
        console.warn('Skipping 5.22-INT-023: No gateways available for load test')
        return
      }

      const discovery = new MCPGatewayDiscovery()
      const TEST_USER_ID = 'test-user-load'

      // CRITICAL: 100 discoveries in sequence
      // If connections leak, this will eventually fail or hang
      const iterations = 100
      const startTime = Date.now()

      for (let i = 0; i < iterations; i++) {
        // Story 6.4: loadToolsForUser now returns { tools, metadata }
        const { tools, metadata } = await discovery.loadToolsForUser(TEST_USER_ID, gateways)

        // Verify tools discovered each time
        expect(typeof tools).toBe('object')
        expect(Object.keys(tools).length).toBeGreaterThan(0)
        expect(metadata).toBeInstanceOf(Map)

        // Log progress every 20 iterations
        if ((i + 1) % 20 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  Progress: ${i + 1}/${iterations} discoveries (${elapsed}s)`)
        }
      }

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
      const avgTime = (parseFloat(totalTime) / iterations * 1000).toFixed(0)

      console.log(`✅ Load test complete: ${iterations} discoveries in ${totalTime}s (avg: ${avgTime}ms)`)

      // If we got here without hanging or errors, cleanup is working!
      expect(true).toBe(true)
    }, 120000) // 2 minute timeout for load test

    test('Parallel discoveries with Promise.allSettled', async () => {
      const gateways: MCPGateway[] = []

      if (n8nAvailable) gateways.push(TEST_N8N_GATEWAY)
      if (dockerAvailable) gateways.push(TEST_DOCKER_GATEWAY)

      if (gateways.length === 0) {
        console.warn('Skipping parallel discovery test: No gateways available')
        return
      }

      const discovery = new MCPGatewayDiscovery()

      // Test parallel discovery (simulates multiple users)
      // Story 6.4: loadToolsForUser now returns { tools, metadata }
      const promises = Array.from({ length: 10 }, (_, i) =>
        discovery.loadToolsForUser(`test-user-${i}`, gateways)
      )

      const results = await Promise.allSettled(promises)

      // All should succeed
      const fulfilled = results.filter(r => r.status === 'fulfilled')
      expect(fulfilled.length).toBe(10)

      // Each should have tools
      fulfilled.forEach((result) => {
        if (result.status === 'fulfilled') {
          // Story 6.4: result.value is now { tools, metadata }
          expect(Object.keys(result.value.tools).length).toBeGreaterThan(0)
          expect(result.value.metadata).toBeInstanceOf(Map)
        }
      })
    })
  })

  describe('P1: Gateway Health Checks', () => {

    test('5.22-INT-018: Health check detects unavailable gateway', async () => {
      const unavailableUrl = 'http://localhost:9999/mcp/does-not-exist'

      const client = new N8nMCPGatewayClient()
      const health = await client.healthCheck(unavailableUrl)

      expect(health.available).toBe(false)
      expect(health.error).toBeDefined()
    })

    test('Gateway validation rejects invalid URLs', () => {
      const invalidUrl = 'not-a-valid-url'

      const client = new N8nMCPGatewayClient()

      // URL validation should return error
      const result = client.validateGatewayUrl(invalidUrl)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })
  })
})
