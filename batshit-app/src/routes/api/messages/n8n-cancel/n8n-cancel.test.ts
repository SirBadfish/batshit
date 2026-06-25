import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  stopRunning: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: mocks.getSession
  }
}))

vi.mock('$lib/server/services/n8nExecutionWebhookInspector', () => ({
  stopRunningN8nExecutionsForMessage: mocks.stopRunning
}))

import { POST } from './+server'

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/messages/n8n-cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('/api/messages/n8n-cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ id: 'sess-1', user_id: 'user-1' })
  })

  it('reports a permission-specific reason when n8n refuses the stop request', async () => {
    mocks.stopRunning.mockResolvedValue({
      apiConfigured: true,
      baseUrl: 'http://localhost:5678',
      checkedExecutionIds: [6378],
      matchedExecutionIds: [],
      stoppedExecutionIds: [],
      workflowFallbackExecutionIds: [6378],
      failures: [{ executionId: 6378, error: '{"message":"Forbidden"}' }]
    })

    const response = await POST({
      request: makeRequest({
        sessionId: 'sess-1',
        messageId: 'msg-1',
        webhookUrl: 'http://localhost:5678/webhook/n8n-primary'
      }),
      locals: { user: { id: 'user-1' } }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      reason: 'n8n_execution_stop_forbidden',
      checkedCount: 1,
      stoppedCount: 0,
      workflowFallbackExecutionIds: [6378]
    })
  })

  it('keeps no_matching_running_execution only for true no-match results', async () => {
    mocks.stopRunning.mockResolvedValue({
      apiConfigured: true,
      baseUrl: 'http://localhost:5678',
      checkedExecutionIds: [],
      matchedExecutionIds: [],
      stoppedExecutionIds: [],
      workflowFallbackExecutionIds: [],
      failures: []
    })

    const response = await POST({
      request: makeRequest({ sessionId: 'sess-1', messageId: 'msg-1' }),
      locals: { user: { id: 'user-1' } }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      reason: 'no_matching_running_execution'
    })
  })
})
