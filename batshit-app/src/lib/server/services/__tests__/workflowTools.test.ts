/**
 * Test Suite: Story 5.11 - Workflow-as-Tool Bridge
 * Priority: P0 Critical Tests
 *
 * Test IDs from QA Test Design:
 * - 5.11-UNIT-001 to 018 (Unit tests)
 * - 5.11-INT-001 to 016 (Integration tests)
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
import { generateZodSchema } from '../workflowSchemaGenerator'
import { callWorkflow } from '../workflowExecutor'
import { loadWorkflowTools } from '../workflowTools'

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

describe('Tool Schema Generator', () => {
  // 5.11-UNIT-007: Generate Zod schema from webhook config
  it('should generate valid Zod schema from webhook config', () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Test',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook',
        parameters: {
          options: {
            bodyParameters: {
              parameters: [
                { name: 'name', type: 'string', required: true },
                { name: 'age', type: 'number' },
                { name: 'active', type: 'boolean' }
              ]
            }
          }
        }
      }]
    }

    const result = generateZodSchema(workflow)

    expect(result.success).toBe(true)
    expect(result.fieldCount).toBe(3)
    expect(result.schema).toBeDefined()

    // Test schema validation
    const valid = result.schema.safeParse({ name: 'John', age: 30, active: true })
    expect(valid.success).toBe(true)

    const invalid = result.schema.safeParse({ age: 30 }) // Missing required field
    expect(invalid.success).toBe(false)
  })

  // 5.11-UNIT-008: Map string fields to z.string()
  it('should map string fields correctly', () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Test',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook',
        parameters: {
          options: {
            bodyParameters: {
              parameters: [
                { name: 'text', type: 'string', description: 'A text field' }
              ]
            }
          }
        }
      }]
    }

    const result = generateZodSchema(workflow)

    expect(result.success).toBe(true)

    const valid = result.schema.safeParse({ text: 'hello' })
    expect(valid.success).toBe(true)
  })

  // 5.11-UNIT-009: Map number fields to z.number()
  it('should map number fields correctly', () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Test',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook',
        parameters: {
          options: {
            bodyParameters: {
              parameters: [
                { name: 'count', type: 'number' }
              ]
            }
          }
        }
      }]
    }

    const result = generateZodSchema(workflow)

    const valid = result.schema.safeParse({ count: 42 })
    expect(valid.success).toBe(true)

    // Should also accept string numbers
    const stringNumber = result.schema.safeParse({ count: '42' })
    expect(stringNumber.success).toBe(true)
  })

  // 5.11-UNIT-010: Handle optional vs required fields
  it('should handle optional and required fields correctly', () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Test',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook',
        parameters: {
          options: {
            bodyParameters: {
              parameters: [
                { name: 'required', type: 'string', required: true },
                { name: 'optional', type: 'string', required: false }
              ]
            }
          }
        }
      }]
    }

    const result = generateZodSchema(workflow)

    // Valid with both fields
    const withBoth = result.schema.safeParse({
      required: 'value',
      optional: 'value'
    })
    expect(withBoth.success).toBe(true)

    // Valid with only required
    const onlyRequired = result.schema.safeParse({
      required: 'value'
    })
    expect(onlyRequired.success).toBe(true)

    // Invalid without required
    const missingRequired = result.schema.safeParse({
      optional: 'value'
    })
    expect(missingRequired.success).toBe(false)
  })

  // Test for empty schema (no webhook fields)
  it('should return empty schema for workflows without fields', () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Empty',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook',
        parameters: {}
      }]
    }

    const result = generateZodSchema(workflow)

    expect(result.success).toBe(true)
    expect(result.fieldCount).toBe(0)

    // Empty object should be valid
    const valid = result.schema.safeParse({})
    expect(valid.success).toBe(true)
  })
})

describe('Workflow Executor', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  // 5.11-UNIT-013: Build webhook request with headers
  it('should build webhook request with proper headers', async () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Test',
      active: true,
      webhookUrl: 'http://localhost:5678/webhook/test'
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true })
    })

    await callWorkflow(workflow, { test: 'data' }, {
      sessionId: 'session123',
      userId: 'user456'
    })

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:5678/webhook/test',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Source': 'batshit-mode-3'
        })
      })
    )

    const headers = (global.fetch as any).mock.calls[0][1].headers
    expect(headers).not.toHaveProperty('X-N8N-API-KEY')
  })

  // 5.11-UNIT-017: Format timeout errors for AI
  it('should format timeout errors properly', async () => {
    const workflow: WorkflowInfo = {
      id: '1',
      name: 'Slow Workflow',
      active: true,
      webhookUrl: 'http://localhost:5678/webhook/slow'
    }

    const abortError = new Error('Aborted')
    abortError.name = 'AbortError'

    global.fetch = vi.fn().mockRejectedValue(abortError)

    const result = await callWorkflow(workflow, {}, { timeout: 100 })

    expect(result.success).toBe(false)
    expect(result.timeout).toBe(true)
    expect(result.error).toContain('took longer than')
    expect(result.error).toContain('seconds')
  })
})

describe('Tool Registration', () => {
  // Integration test for full tool loading
  it('should load and register workflow tools', async () => {
    const mockWorkflows: WorkflowInfo[] = [
      {
        id: '1',
        name: 'Calculator',
        description: 'Performs calculations',
        active: true,
        webhookUrl: 'http://localhost:5678/webhook/calculator',
        nodes: [{
          type: 'n8n-nodes-base.webhook',
          parameters: {
            path: 'calculator',
            options: {
              bodyParameters: {
                parameters: [
                  { name: 'expression', type: 'string', required: true }
                ]
              }
            }
          }
        }]
      }
    ]

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockWorkflows
    })

    const tools = await loadWorkflowTools('user123', 'session456', ['calculator'])

    expect(Object.keys(tools)).toContain('calculator')
  })
})

describe('Async Workflow Support', () => {
  // Test async workflow detection
  it('should detect async workflows correctly', async () => {
    const { detectAsyncWorkflow } = await import('../workflowAsyncHandler')

    const asyncWorkflow: WorkflowInfo = {
      id: '1',
      name: 'Async',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook'
      }, {
        type: 'n8n-nodes-base.respondToWebhook'
      }]
    }

    const syncWorkflow: WorkflowInfo = {
      id: '2',
      name: 'Sync',
      active: true,
      nodes: [{
        type: 'n8n-nodes-base.webhook'
      }]
    }

    expect(detectAsyncWorkflow(asyncWorkflow)).toBe(true)
    expect(detectAsyncWorkflow(syncWorkflow)).toBe(false)
  })
})
