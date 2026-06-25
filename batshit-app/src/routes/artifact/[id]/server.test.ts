import { describe, expect, it, vi } from 'vitest'

const { redisJsonGet } = vi.hoisted(() => ({
  redisJsonGet: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    json: {
      get: redisJsonGet
    }
  }
}))

vi.mock('$lib/artifacts/generateArtifactApi', () => ({
  injectArtifactApi: vi.fn((content: string) => content)
}))

vi.mock('$lib/artifacts/artifactIframeSandbox', () => ({
  getArtifactIframeSandbox: vi.fn(() => 'allow-scripts')
}))

vi.mock('$lib/server/services/artifactRuntimeAuth', () => ({
  createArtifactRuntimeToken: vi.fn(async () => 'runtime-token'),
  getArtifactRuntimeStorageSnapshot: vi.fn(async () => ({}))
}))

import { GET } from './+server'

function buildEvent(id: string) {
  return {
    params: { id },
    locals: { user: { id: 'user_1' } },
    url: new URL(`http://localhost/artifact/${id}`),
    request: new Request(`http://localhost/artifact/${id}`)
  } as any
}

describe('/artifact/[id]', () => {
  it('does not serve hardcoded demo artifacts when Redis misses', async () => {
    redisJsonGet.mockResolvedValueOnce(null)

    await expect(GET(buildEvent('art_1'))).rejects.toMatchObject({
      status: 404,
      body: {
        message: 'Artifact not found'
      }
    })
  })
})
