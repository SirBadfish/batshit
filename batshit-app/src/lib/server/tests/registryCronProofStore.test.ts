import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpstashKvGet = vi.fn()
const mockUpstashKvSet = vi.fn()

vi.mock('$lib/server/services/upstashKv', () => ({
  upstashKvGet: (...args: any[]) => mockUpstashKvGet(...args),
  upstashKvSet: (...args: any[]) => mockUpstashKvSet(...args)
}))

describe('registryCronProofStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpstashKvSet.mockResolvedValue(undefined)
  })

  it('does not overwrite the cron proof index when the existing index cannot be read', async () => {
    const { storeRegistryCronProof } = await import('../services/registryCronProofStore')
    mockUpstashKvGet.mockRejectedValue(new Error('read failed'))

    await expect(
      storeRegistryCronProof({
        name: 'model-catalog',
        route: '/api/admin/model-catalog/sync',
        status: 'failed',
        startedAt: '2026-06-14T00:00:00.000Z',
        completedAt: '2026-06-14T00:00:01.000Z',
        userAgent: 'test',
        vercelCron: false,
        vercelId: null,
        summary: {},
        error: 'sync failed'
      })
    ).rejects.toThrow('read failed')

    expect(mockUpstashKvSet).not.toHaveBeenCalled()
  })

  it('prepends a new cron proof record to the existing index', async () => {
    const { storeRegistryCronProof } = await import('../services/registryCronProofStore')
    mockUpstashKvGet.mockResolvedValue([
      {
        id: 'model-catalog:2026-06-13T00-00-00-000Z',
        name: 'model-catalog',
        route: '/api/admin/model-catalog/sync',
        status: 'ok',
        startedAt: '2026-06-13T00:00:00.000Z',
        completedAt: '2026-06-13T00:00:01.000Z',
        durationMs: 1000,
        vercelCron: true
      }
    ])

    const record = await storeRegistryCronProof({
      name: 'compatibility-matrix',
      route: '/api/admin/model-catalog/compatibility-matrix/sync',
      status: 'ok',
      startedAt: '2026-06-14T00:00:00.000Z',
      completedAt: '2026-06-14T00:00:01.000Z',
      userAgent: 'test',
      vercelCron: true,
      vercelId: 'iad1::test',
      summary: { entries: 10 },
      error: null
    })

    expect(record.id).toBe('compatibility-matrix:2026-06-14T00-00-01-000Z')
    expect(mockUpstashKvSet).toHaveBeenCalledWith(
      'registry:cron-proof:index:v1',
      expect.arrayContaining([
        expect.objectContaining({
          id: record.id,
          name: 'compatibility-matrix'
        }),
        expect.objectContaining({
          id: 'model-catalog:2026-06-13T00-00-00-000Z',
          name: 'model-catalog'
        })
      ])
    )
  })
})
