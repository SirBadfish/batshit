import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { verifyRecipeArchiveContainmentReceipt } from '$lib/goons/recipe'

const mocks = vi.hoisted(() => ({
  deleteAsset: vi.fn(async () => undefined)
}))

vi.mock('$lib/server/services/goonAssetCleanupService', () => ({
  deleteGoonUploadAsset: mocks.deleteAsset
}))

import { POST } from './+server'

const USER_ID = 'user-1'
const GOON_ID = 'goon-1'
const sha = (character: string) => character.repeat(64)

describe('/api/goons/[id]/advanced-package Recipe containment', () => {
  useRedisTestServer()

  beforeEach(async () => {
    vi.stubEnv('BATSHIT_TOKEN', 'recipe-route-test-token')
    vi.stubEnv('BATSHIT_SERVER_URL', 'http://batshit-server.test')
    vi.stubEnv('PUBLIC_BATSHIT_SERVER_URL', 'http://localhost:5600')
    mocks.deleteAsset.mockClear()
    await redis.json.set(`goon:${GOON_ID}`, '$', {
      id: GOON_ID,
      user_id: USER_ID,
      name: 'Recipe Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      customAvatar: {},
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function event() {
    const form = new FormData()
    form.append('file', new File(['package'], 'recipe.bgoon', { type: 'application/zip' }))
    return {
      params: { id: GOON_ID },
      request: { formData: async () => form },
      locals: { user: { id: USER_ID } }
    } as any
  }

  function uploadPayload(entryCount = 2) {
    return {
      files: {
        package: {
          url: 'http://batshit-server.test/uploads/goon_custom_packages/source.bgoon',
          filename: 'source.bgoon'
        },
        model: {
          url: 'http://batshit-server.test/uploads/goon_custom_models/avatar.glb',
          filename: 'avatar.glb'
        },
        manifest: {
          url: 'http://batshit-server.test/uploads/goon_custom_manifests/avatar.json',
          filename: 'avatar.json'
        }
      },
      manifestData: { name: 'Recipe Goon' },
      archiveExtraction: {
        contract: 'recipe-archive-extraction/v1',
        extractor: { id: 'batshit-server-recipe-archive', version: 1 },
        archive: {
          ref: '/uploads/goon_custom_packages/source.bgoon',
          sha256: sha('a'),
          bytes: 300
        },
        entryCount,
        totalUncompressedBytes: 240,
        members: [
          {
            role: 'manifest',
            path: 'avatar.json',
            sha256: sha('b'),
            bytes: 40,
            extracted: {
              ref: '/uploads/goon_custom_manifests/avatar.json',
              sha256: sha('b'),
              bytes: 40
            }
          },
          {
            role: 'model',
            path: 'avatar.glb',
            sha256: sha('c'),
            bytes: 200,
            extracted: {
              ref: '/uploads/goon_custom_models/avatar.glb',
              sha256: sha('c'),
              bytes: 200
            }
          }
        ]
      }
    }
  }

  it('returns a canonical self-hashed containment receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(uploadPayload()))

    const response = await POST(event())
    expect(response.status).toBe(200)
    const body = await response.json()
    await expect(verifyRecipeArchiveContainmentReceipt(body.archiveReceipt)).resolves.toEqual(
      body.archiveReceipt
    )
    expect(body.archiveReceipt.archive.ref).toBe(
      '/uploads/goon_custom_packages/source.bgoon'
    )
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })

  it('compensates every staged asset when the extraction receipt is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(uploadPayload(3)))

    const response = await POST(event())
    expect(response.status).toBe(500)
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(3)
    expect(mocks.deleteAsset).toHaveBeenCalledWith('goon_custom_packages', 'source.bgoon')
    expect(mocks.deleteAsset).toHaveBeenCalledWith('goon_custom_models', 'avatar.glb')
    expect(mocks.deleteAsset).toHaveBeenCalledWith('goon_custom_manifests', 'avatar.json')
  })

  it('fails loudly when rejected staged assets cannot be cleaned completely', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(uploadPayload(3)))
    mocks.deleteAsset.mockImplementation(async (uploadType) => {
      if (uploadType === 'goon_custom_models') throw new Error('Injected delete failure')
    })

    const response = await POST(event())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('rejected assets could not be cleaned completely')
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(3)
  })
})
