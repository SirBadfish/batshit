import { describe, expect, it } from 'vitest'

import { presentAgentForRuntime } from '../agentRuntimePresentation'

describe('presentAgentForRuntime', () => {
  it('rewrites restored n8n primary webhook URLs to the Docker browser-facing n8n port', () => {
    const agent = {
      id: 'sample_n8n_primary',
      agentType: 'n8n',
      webhook_url: 'http://localhost:5678/webhook/sample_n8n_primary',
      webhookUrl: 'http://localhost:5678/webhook/sample_n8n_primary',
    }

    expect(
      presentAgentForRuntime(agent, {
        BATSHIT_CONTAINERIZED: '1',
        N8N_WEBHOOK_URL: 'http://127.0.0.1:5679/webhook',
      })
    ).toMatchObject({
      webhook_url: 'http://127.0.0.1:5679/webhook/sample_n8n_primary',
      webhookUrl: 'http://127.0.0.1:5679/webhook/sample_n8n_primary',
    })
  })

  it('does not rewrite API primary agents', () => {
    const agent = {
      id: 'api_primary',
      agentType: 'api',
      webhook_url: 'http://localhost:5678/webhook/should-stay',
    }

    expect(
      presentAgentForRuntime(agent, {
        BATSHIT_CONTAINERIZED: '1',
        N8N_WEBHOOK_URL: 'http://127.0.0.1:5679/webhook',
      })
    ).toBe(agent)
  })
})
