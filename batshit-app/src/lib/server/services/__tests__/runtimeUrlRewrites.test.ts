import { describe, expect, it } from 'vitest'

import {
  resolveRuntimeN8nBaseUrl,
  rewriteBatshitCallbackUrlsForN8nRuntime,
  rewriteLoopbackUrlToDockerHostForRuntime,
  rewriteLoopbackUrlForRuntimeBase,
  rewriteN8nGatewayUrlForRuntime,
  rewriteN8nWebhookUrlForRuntime,
  shouldUseInternalBatshitCallbacksForN8n
} from '../runtimeUrlRewrites'
import type { MCPGateway } from '$lib/types/database'

const baseGateway: MCPGateway = {
  id: 'gw_n8n',
  name: 'n8n Instance MCP',
  type: 'n8n-instance-mcp',
  url: 'http://localhost:5678/mcp-server/http',
  enabled: true,
  created_at: '2026-05-22T00:00:00.000Z'
}

describe('runtimeUrlRewrites', () => {
  it('prefers bundled Docker n8n URL over saved n8n URL inside containers', () => {
    expect(
      resolveRuntimeN8nBaseUrl('http://host.docker.internal:5678', {
        BATSHIT_CONTAINERIZED: '1',
        N8N_API_URL: 'http://n8n:5678'
      })
    ).toBe('http://n8n:5678')
  })

  it('uses Docker env n8n URL when a restored saved n8n URL is loopback', () => {
    expect(
      resolveRuntimeN8nBaseUrl('http://localhost:5678', {
        BATSHIT_CONTAINERIZED: '1',
        N8N_API_URL: 'http://host.docker.internal:5678'
      })
    ).toBe('http://host.docker.internal:5678')
  })

  it('respects a saved non-loopback n8n URL inside containers', () => {
    expect(
      resolveRuntimeN8nBaseUrl('https://n8n.example.test', {
        BATSHIT_CONTAINERIZED: '1',
        N8N_API_URL: 'http://host.docker.internal:5678'
      })
    ).toBe('https://n8n.example.test')
  })

  it('prefers saved n8n URL outside containers', () => {
    expect(
      resolveRuntimeN8nBaseUrl('http://localhost:5678', {
        N8N_API_URL: 'http://n8n:5678'
      })
    ).toBe('http://localhost:5678')
  })

  it('rewrites loopback URLs to the Docker-reachable runtime base inside containers', () => {
    expect(
      rewriteLoopbackUrlForRuntimeBase(
        'http://localhost:5678/webhook/demo?x=1',
        'http://host.docker.internal:5678',
        { BATSHIT_CONTAINERIZED: '1' }
      )
    ).toBe('http://host.docker.internal:5678/webhook/demo?x=1')
  })

  it('leaves loopback URLs alone outside containers', () => {
    expect(
      rewriteLoopbackUrlForRuntimeBase(
        'http://localhost:5678/webhook/demo',
        'http://host.docker.internal:5678',
        {}
      )
    ).toBe('http://localhost:5678/webhook/demo')
  })

  it('rewrites n8n MCP gateway URLs without changing the stored gateway object', () => {
    const rewritten = rewriteN8nGatewayUrlForRuntime(
      baseGateway,
      'http://host.docker.internal:5678',
      { BATSHIT_CONTAINERIZED: '1' }
    )

    expect(rewritten.url).toBe('http://host.docker.internal:5678/mcp-server/http')
    expect(baseGateway.url).toBe('http://localhost:5678/mcp-server/http')
  })

  it('rewrites n8n workflow webhooks to bundled Docker n8n', () => {
    expect(
      rewriteN8nWebhookUrlForRuntime(
        'http://localhost:5678/webhook/subagent',
        'http://localhost:5678',
        {
          BATSHIT_CONTAINERIZED: '1',
          N8N_API_URL: 'http://n8n:5678'
        }
      )
    ).toBe('http://n8n:5678/webhook/subagent')
  })

  it('rewrites n8n workflow webhooks to host n8n from Docker', () => {
    expect(
      rewriteN8nWebhookUrlForRuntime(
        'http://127.0.0.1:5678/webhook/subagent',
        'http://localhost:5678',
        {
          BATSHIT_CONTAINERIZED: '1',
          N8N_API_URL: 'http://host.docker.internal:5678'
        }
      )
    ).toBe('http://host.docker.internal:5678/webhook/subagent')
  })

  it('leaves external n8n workflow webhooks unchanged in Docker', () => {
    expect(
      rewriteN8nWebhookUrlForRuntime(
        'https://n8n.example.test/webhook/subagent',
        'http://host.docker.internal:5678',
        { BATSHIT_CONTAINERIZED: '1' }
      )
    ).toBe('https://n8n.example.test/webhook/subagent')
  })

  it('leaves n8n workflow webhooks unchanged outside containers', () => {
    expect(
      rewriteN8nWebhookUrlForRuntime(
        'http://localhost:5678/webhook/subagent',
        'http://n8n:5678',
        {}
      )
    ).toBe('http://localhost:5678/webhook/subagent')
  })

  it('rewrites generic loopback runtime URLs to the Docker host gateway while preserving port', () => {
    expect(
      rewriteLoopbackUrlToDockerHostForRuntime('http://localhost:8000/webhook/demo?x=1', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe('http://host.docker.internal:8000/webhook/demo?x=1')
  })

  it('leaves generic loopback runtime URLs unchanged outside Docker', () => {
    expect(
      rewriteLoopbackUrlToDockerHostForRuntime('http://localhost:8000/webhook/demo', {})
    ).toBe('http://localhost:8000/webhook/demo')
  })

  it('does not rewrite non-n8n gateway URLs', () => {
    const gateway: MCPGateway = {
      ...baseGateway,
      type: 'custom',
      url: 'http://localhost:9999/mcp'
    }

    expect(
      rewriteN8nGatewayUrlForRuntime(gateway, 'http://host.docker.internal:5678', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe(gateway)
  })

  it('uses internal Batshit callbacks when containerized Batshit targets bundled n8n', () => {
    expect(
      shouldUseInternalBatshitCallbacksForN8n('http://n8n:5678', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe(true)

    const rewritten = rewriteBatshitCallbackUrlsForN8nRuntime(
      {
        batshit_frontend_url: 'http://localhost:5613',
        batshit_sse_endpoint: 'http://localhost:5613/api/sse',
        batshit_artifact_complete_url: 'http://localhost:5613/api/artifacts/complete',
        other: 'kept'
      },
      'http://n8n:5678',
      { BATSHIT_CONTAINERIZED: '1' }
    )

    expect(rewritten).toMatchObject({
      batshit_frontend_url: 'http://app:3000',
      batshitFrontendUrl: 'http://app:3000',
      batshit_sse_endpoint: 'http://app:3000/api/sse',
      batshitSseEndpoint: 'http://app:3000/api/sse',
      batshit_artifact_complete_url: 'http://app:3000/api/artifacts/complete',
      batshitArtifactCompleteUrl: 'http://app:3000/api/artifacts/complete',
      other: 'kept'
    })
  })

  it('canonicalizes local Batshit callbacks to IPv4 loopback for host-managed n8n', () => {
    const payload = {
      batshit_frontend_url: 'http://localhost:5613',
      batshitFrontendUrl: 'http://[::1]:5613',
      batshit_sse_endpoint: 'http://localhost:5613/api/sse',
      batshitSseEndpoint: 'http://[::1]:5613/api/sse',
      batshit_artifact_complete_url: 'http://localhost:5613/api/artifacts/complete',
      batshitArtifactCompleteUrl: 'http://[::1]:5613/api/artifacts/complete',
      external: 'https://batshit.example.test/api/sse'
    }

    const rewritten = rewriteBatshitCallbackUrlsForN8nRuntime(
      payload,
      'http://host.docker.internal:5678',
      {
        BATSHIT_CONTAINERIZED: '1'
      }
    )

    expect(rewritten).toMatchObject({
      batshit_frontend_url: 'http://127.0.0.1:5613',
      batshitFrontendUrl: 'http://127.0.0.1:5613',
      batshit_sse_endpoint: 'http://127.0.0.1:5613/api/sse',
      batshitSseEndpoint: 'http://127.0.0.1:5613/api/sse',
      batshit_artifact_complete_url: 'http://127.0.0.1:5613/api/artifacts/complete',
      batshitArtifactCompleteUrl: 'http://127.0.0.1:5613/api/artifacts/complete',
      external: 'https://batshit.example.test/api/sse'
    })
    expect(payload.batshit_sse_endpoint).toBe('http://localhost:5613/api/sse')
  })

  it('canonicalizes local Batshit callbacks for native n8n too', () => {
    expect(
      rewriteBatshitCallbackUrlsForN8nRuntime(
        {
          batshit_frontend_url: 'http://localhost:5620',
          batshit_sse_endpoint: 'http://localhost:5620/api/sse'
        },
        'http://localhost:5678',
        {}
      )
    ).toMatchObject({
      batshit_frontend_url: 'http://127.0.0.1:5620',
      batshit_sse_endpoint: 'http://127.0.0.1:5620/api/sse'
    })
  })
})
