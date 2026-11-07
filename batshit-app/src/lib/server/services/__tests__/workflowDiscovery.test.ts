/**
 * Test Suite: workflow discovery (the n8n workflow list the MCP gateway routes read).
 * Story 5.11's workflow-as-tool bridge (schema generator, executor, async handler, and the
 * tool loader) was removed with SA-139 P7; no request had supplied a workflow list since June 2026.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

// Mock env
vi.mock('$env/dynamic/private', () => ({
  env: {
    N8N_API_URL: 'http://localhost:5678',
    N8N_API_KEY: 'test-api-key'
  }
}))

useRedisTestServer()

import { workflowDiscovery, type WorkflowInfo } from '../workflowDiscovery'

describe('Workflow Discovery Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 5.11-UNIT-001: Parse n8n API response for workflows
  it('should parse n8n API response correctly', async () => {
    const mockWorkflows: WorkflowInfo[] = [
      {
        id: '1',
        name: 'Test Workflow',
        description: 'A test workflow',
        active: true,
        nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { path: 'test' } }]
      }
    ]

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockWorkflows
    })

    const workflows = await workflowDiscovery.getAvailableWorkflows(true)

    expect(workflows).toHaveLength(1)
    expect(workflows[0].name).toBe('Test Workflow')
  })

  // 5.11-UNIT-002: Filter workflows by webhook trigger presence
  it('should filter workflows with webhook triggers', async () => {
    const mockWorkflows = [
      {
        id: '1',
        name: 'Webhook Workflow',
        active: true,
        nodes: [{ type: 'n8n-nodes-base.webhook' }]
      },
      {
        id: '2',
        name: 'No Webhook',
        active: true,
        nodes: [{ type: 'n8n-nodes-base.cron' }]
      }
    ]

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockWorkflows
    })

    const workflows = await workflowDiscovery.getAvailableWorkflows(true)

    expect(workflows).toHaveLength(1)
    expect(workflows[0].name).toBe('Webhook Workflow')
  })

  // 5.11-UNIT-003: Handle empty workflow list
  it('should handle empty workflow list gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => []
    })

    const workflows = await workflowDiscovery.getAvailableWorkflows(true)

    expect(workflows).toHaveLength(0)
    expect(workflows).toEqual([])
  })
})
