import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageRouter } from '../messageRouter'

const agent = {
  id: 'n8n_agent',
  user_id: 'user_1',
  displayName: 'n8n Agent',
  agentType: 'n8n',
  webhook_url: 'http://localhost:5678/webhook/test'
} as any

describe('MessageRouter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts an empty successful n8n webhook response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const router = new MessageRouter()
    const result = await router.route({
      sessionId: 'session_1',
      agentId: agent.id,
      agent,
      messages: [{ role: 'user', content: 'hello' }] as any,
      webhookUrl: agent.webhook_url,
      batshitInput: { user_message: 'hello' }
    })

    expect(result.success).toBe(true)
    expect(result.data).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      agent.webhook_url,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('returns parsed JSON when an n8n webhook responds with JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )

    const router = new MessageRouter()
    const result = await router.route({
      sessionId: 'session_1',
      agentId: agent.id,
      agent,
      messages: [] as any,
      webhookUrl: agent.webhook_url,
      batshitInput: {}
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ ok: true })
  })

  it('treats an n8n workflow error JSON response as a failed route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            metadata: {
              nodeName: 'Batshit AI Agent node',
              message: 'Model Selector failed'
            }
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
    )

    const router = new MessageRouter()
    const result = await router.route({
      sessionId: 'session_1',
      agentId: agent.id,
      agent,
      messages: [] as any,
      webhookUrl: agent.webhook_url,
      batshitInput: {}
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('n8n workflow error in Batshit AI Agent node')
  })
})
