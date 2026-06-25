import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetRuntimeEnv = vi.fn()
const mockLoadPublishedCompatibilityMatrix = vi.fn()
const mockPublishCompatibilityMatrix = vi.fn()
const mockRunN8nCompatibilitySync = vi.fn()
const mockBuildCronProofRequestMetadata = vi.fn()
const mockStoreRegistryCronProof = vi.fn()

vi.mock('$lib/server/services/runtimeEnv', () => ({
  getRuntimeEnv: mockGetRuntimeEnv
}))

vi.mock('$lib/server/services/compatibilityMatrixAdmin', () => ({
  loadPublishedCompatibilityMatrix: mockLoadPublishedCompatibilityMatrix,
  publishCompatibilityMatrix: mockPublishCompatibilityMatrix
}))

vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({
  runN8nCompatibilitySync: mockRunN8nCompatibilitySync
}))

vi.mock('$lib/server/services/registryCronProofStore', () => ({
  buildCronProofRequestMetadata: mockBuildCronProofRequestMetadata,
  storeRegistryCronProof: mockStoreRegistryCronProof
}))

describe('compatibility matrix cron route', () => {
  const previousVercel = process.env.VERCEL

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env.VERCEL = '1'

    mockGetRuntimeEnv.mockImplementation(async (key: string) => {
      if (key === 'CRON_SECRET') return 'secret'
      return null
    })
    mockLoadPublishedCompatibilityMatrix.mockResolvedValue({
      version: 1,
      fetchedAt: '2026-06-20T12:00:00.000Z',
      entries: [{ scope: { connection: 'openai' }, allow: ['temperature'] }]
    })
    mockBuildCronProofRequestMetadata.mockReturnValue({
      userAgent: 'vercel-cron/1.0',
      vercelCron: true,
      vercelId: 'iad1::test'
    })
    mockStoreRegistryCronProof.mockImplementation(async (input) => ({
      id: 'compatibility-matrix:2026-06-20T12-01-00-000Z',
      completedAt: input.completedAt,
      vercelCron: input.vercelCron
    }))
  })

  afterEach(() => {
    if (previousVercel === undefined) {
      delete process.env.VERCEL
    } else {
      process.env.VERCEL = previousVercel
    }
  })

  it('skips live n8n sync on hosted Vercel unless explicitly enabled', async () => {
    const { GET } = await import('./+server')
    const response = await GET({
      request: new Request('https://api.batshit.ai/api/admin/cron/compatibility-matrix', {
        headers: {
          'x-cron-secret': 'secret',
          'user-agent': 'vercel-cron/1.0',
          'x-vercel-id': 'iad1::test'
        }
      })
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      status: 'ok',
      source: 'published-unchanged',
      sync: {
        status: 'skipped',
        entries: 0,
        error: null
      }
    })
    expect(mockRunN8nCompatibilitySync).not.toHaveBeenCalled()
    expect(mockPublishCompatibilityMatrix).not.toHaveBeenCalled()
    expect(mockStoreRegistryCronProof).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        summary: expect.objectContaining({
          hostedCompatibilitySync: 'skipped',
          entries: 1
        })
      })
    )
  })

  it('runs the live n8n sync on hosted Vercel when opted in', async () => {
    mockGetRuntimeEnv.mockImplementation(async (key: string) => {
      if (key === 'CRON_SECRET') return 'secret'
      if (key === 'BATSHIT_HOSTED_COMPATIBILITY_SYNC') return '1'
      return null
    })
    mockRunN8nCompatibilitySync.mockResolvedValue({
      version: 1,
      fetchedAt: '2026-06-20T12:05:00.000Z',
      entries: [{ scope: { connection: 'anthropic' }, allow: ['temperature'] }]
    })
    mockPublishCompatibilityMatrix.mockResolvedValue({
      version: 1,
      fetchedAt: '2026-06-20T12:05:00.000Z',
      entries: [{ scope: { connection: 'anthropic' }, allow: ['temperature'] }]
    })

    const { GET } = await import('./+server')
    const response = await GET({
      request: new Request('https://api.batshit.ai/api/admin/cron/compatibility-matrix', {
        headers: { 'x-cron-secret': 'secret' }
      })
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      status: 'published',
      source: 'n8n-sync',
      sync: {
        status: 'ok',
        entries: 1,
        error: null
      }
    })
    expect(mockRunN8nCompatibilitySync).toHaveBeenCalledTimes(1)
    expect(mockPublishCompatibilityMatrix).toHaveBeenCalledTimes(1)
  })
})
