import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  env: {} as Record<string, string | undefined>
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: mocks.retrieve
  }
}))

vi.mock('$env/dynamic/private', () => ({
  env: mocks.env
}))

import { POST } from './+server'

describe('/api/messages/n8n-runtime-callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mocks.env)) {
      delete mocks.env[key]
    }
    mocks.retrieve.mockResolvedValue('http://localhost:5678')
  })

  it('rewrites callback URLs for bundled Docker n8n', async () => {
    mocks.env.BATSHIT_CONTAINERIZED = '1'
    mocks.env.N8N_API_URL = 'http://n8n:5678'

    const response = await POST({
      request: new Request('http://localhost/api/messages/n8n-runtime-callbacks', {
        method: 'POST',
        body: JSON.stringify({
          batshit_frontend_url: 'http://localhost:5620',
          batshit_sse_endpoint: 'http://localhost:5620/api/sse',
          batshit_artifact_complete_url: 'http://localhost:5620/api/artifacts/complete'
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      callbackUrls: {
        batshit_frontend_url: 'http://app:3000',
        batshit_sse_endpoint: 'http://app:3000/api/sse',
        batshit_artifact_complete_url: 'http://app:3000/api/artifacts/complete'
      }
    })
  })

  it('canonicalizes callback URLs for host-managed Docker n8n', async () => {
    mocks.env.BATSHIT_CONTAINERIZED = '1'
    mocks.env.N8N_API_URL = 'http://host.docker.internal:5678'

    const response = await POST({
      request: new Request('http://localhost/api/messages/n8n-runtime-callbacks', {
        method: 'POST',
        body: JSON.stringify({
          batshit_frontend_url: 'http://localhost:5620',
          batshit_sse_endpoint: 'http://localhost:5620/api/sse'
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      callbackUrls: {
        batshit_frontend_url: 'http://127.0.0.1:5620',
        batshit_sse_endpoint: 'http://127.0.0.1:5620/api/sse'
      }
    })
  })
})
