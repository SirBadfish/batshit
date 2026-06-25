/**
 * SA-009 - Redis Persistence Tests (Flat List Model)
 *
 * Redis lane honesty (G-0228): under plain `npm test` this suite runs against the
 * in-memory RedisJSON fake from vitest-setup.ts. It uses REAL Redis (DB15 via the
 * useRedisTestServer harness) only under `npm run test:redis` — run that lane when
 * validating real RedisJSON serialization behavior.
 * Tests persist/load tool selections as flat string arrays
 *
 * P0 Tests:
 * - Save/load tool selections with Redis JSON operations
 * - Agent without tool selections loads all tools (backward compat)
 * - Save agent with tool selections persists to Redis
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import type { AgentRow, MCPToolSelections } from '$lib/types/database'

const TEST_USER_ID = 'test-user-tool-selections'
const TEST_AGENT_ID = 'test-agent-tool-persist'

useRedisTestServer()

describe('SA-009 - Redis Persistence (Flat List Model)', () => {

	// Cleanup before and after each test
	beforeEach(async () => {
		await redis.del(`agent:${TEST_AGENT_ID}`)
	})

	afterEach(async () => {
		await redis.del(`agent:${TEST_AGENT_ID}`)
	})

	describe('Tool Selection Persistence', () => {

		test('Save/load tool selections with Redis JSON operations (NO double stringify)', async () => {
			// SA-009: MCPToolSelections is now a flat string array
			const toolSelections: MCPToolSelections = [
				'redis_get', 'redis_set', 'redis_del', 'redis_hgetall',
				'github_search-issues', 'github_create-issue'
			]

			const agent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'Test Agent',
				defaultMCPToolSelections: toolSelections
			}

			// Save agent with tool selections using Redis JSON
			// CRITICAL: NO JSON.stringify before json.set
			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', agent)
			})

			// Load agent back
			// CRITICAL: NO JSON.parse after json.get (already an object)
			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Verify tool selections persisted correctly
			expect(loaded).toBeDefined()
			expect(loaded.defaultMCPToolSelections).toBeDefined()
			expect(Array.isArray(loaded.defaultMCPToolSelections)).toBe(true)
			expect(loaded.defaultMCPToolSelections).toEqual(toolSelections)

			// Verify flat array preserved
			expect(loaded.defaultMCPToolSelections).toContain('redis_get')
			expect(loaded.defaultMCPToolSelections).toContain('github_search-issues')
		})

		test('Save agent with many tool selections', async () => {
			// SA-009: Large flat array of tool names
			const manySelections: MCPToolSelections = [
				'batshit_server_read_file', 'batshit_server_overwrite_file', 'batshit_server_edit_file',
				'batshit_server_list_files', 'batshit_server_search_files', 'batshit_server_execute_command',
				'redis_get', 'redis_set', 'redis_del', 'redis_hgetall',
				'github_search-issues', 'github_create-issue', 'github_get-pr',
				'tavily_search'
			]

			const agent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'Many Tools Agent',
				defaultMCPGateways: ['docker-gateway', 'n8n-gateway'],
				defaultMCPToolSelections: manySelections
			}

			// Save
			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', agent)
			})

			// Load
			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Verify all selections preserved correctly
			expect(loaded.defaultMCPToolSelections).toEqual(manySelections)
			expect(loaded.defaultMCPToolSelections?.length).toBe(14)
		})

		test('Save agent with empty tool selections array', async () => {
			// SA-009: Empty array = no tools enabled
			const agent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'No Tools Agent',
				defaultMCPGateways: ['docker-gateway'],
				defaultMCPToolSelections: []
			}

			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', agent)
			})

			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Verify empty array preserved (not converted to undefined or null)
			expect(Array.isArray(loaded.defaultMCPToolSelections)).toBe(true)
			expect(loaded.defaultMCPToolSelections).toHaveLength(0)
		})
	})

	describe('Backward Compatibility', () => {

		test('Agent without tool selections loads all tools (default behavior)', async () => {
			// Create agent WITHOUT defaultMCPToolSelections field
			const agent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'Legacy Agent',
				defaultMCPGateways: ['docker-gateway']
				// NO defaultMCPToolSelections field
			}

			// Save legacy agent
			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', agent)
			})

			// Load agent
			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Verify agent loaded successfully
			expect(loaded).toBeDefined()
			expect(loaded.id).toBe(TEST_AGENT_ID)

			// Verify defaultMCPToolSelections is undefined (not present)
			expect(loaded.defaultMCPToolSelections).toBeUndefined()

			// This simulates backward compatibility:
			// - undefined = no filtering (handled by resolver)
			// - Existing agents continue to work without changes
		})

		test('Newly created agent defaults to undefined (no tool selections)', async () => {
			const newAgent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'New Agent',
				defaultMCPGateways: ['docker-gateway']
				// Explicitly NOT setting defaultMCPToolSelections
			}

			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', newAgent)
			})

			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Should be undefined, meaning "no explicit selections"
			expect(loaded.defaultMCPToolSelections).toBeUndefined()
		})
	})

	describe('Data Integrity', () => {

		test('Flat array structure preserved exactly', async () => {
			const toolSelections: MCPToolSelections = [
				'tool_a_1', 'tool_a_2',
				'tool_b_x', 'tool_b_y', 'tool_b_z'
			]

			const agent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'Test Agent',
				defaultMCPToolSelections: toolSelections
			}

			// Round-trip through Redis
			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', agent)
			})

			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Verify exact structural equality
			expect(JSON.stringify(loaded.defaultMCPToolSelections)).toBe(JSON.stringify(toolSelections))

			// Verify no corruption occurred
			expect(Array.isArray(loaded.defaultMCPToolSelections)).toBe(true)
			expect(loaded.defaultMCPToolSelections?.length).toBe(5)
		})

		test('Large tool selection set (stress test)', async () => {
			// Create a large selection set with many tools
			const largeSelections: MCPToolSelections = []

			for (let g = 1; g <= 5; g++) {
				for (let m = 1; m <= 10; m++) {
					for (let t = 1; t <= 3; t++) {
						largeSelections.push(`gateway${g}_mcp${m}_tool${t}`)
					}
				}
			}

			const agent: AgentRow = {
				id: TEST_AGENT_ID,
				user_id: TEST_USER_ID,
				displayName: 'Large Agent',
				defaultMCPToolSelections: largeSelections
			}

			// Save large structure
			await redis.execute(async (client) => {
				await client.json.set(`agent:${TEST_AGENT_ID}`, '$', agent)
			})

			// Load back
			const loaded = await redis.execute(async (client) => {
				return await client.json.get(`agent:${TEST_AGENT_ID}`)
			}) as AgentRow

			// Verify entire structure preserved
			expect(loaded.defaultMCPToolSelections).toEqual(largeSelections)
			expect(loaded.defaultMCPToolSelections?.length).toBe(150) // 5 * 10 * 3

			// Spot check a few entries
			expect(loaded.defaultMCPToolSelections).toContain('gateway3_mcp5_tool2')
			expect(loaded.defaultMCPToolSelections).toContain('gateway1_mcp1_tool1')
		})
	})
})
