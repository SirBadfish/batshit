import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  createRecipeArchiveContainmentReceipt
} from '$lib/goons/recipe'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

const mocks = vi.hoisted(() => ({
  deleteAsset: vi.fn(async () => undefined)
}))

vi.mock('$lib/server/services/goonAssetCleanupService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/goonAssetCleanupService')>()),
  deleteGoonUploadAsset: mocks.deleteAsset
}))

import { POST } from './+server'

const USER_ID = 'recipe-cleanup-user'
const GOON_ID = 'recipe-cleanup-goon'
const sha = (character: string) => character.repeat(64)

async function receipt() {
  return createRecipeArchiveContainmentReceipt({
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: 'zip',
    extractor: { id: 'batshit-server-recipe-archive', version: 1 },
    archive: {
      ref: '/uploads/goon_custom_packages/rejected.bgoon',
      sha256: sha('a'),
      bytes: 300
    },
    entryCount: 2,
    totalUncompressedBytes: 240,
    members: [
      {
        role: 'manifest',
        path: 'avatar.json',
        sha256: sha('b'),
        bytes: 40,
        extracted: {
          ref: '/uploads/goon_custom_manifests/rejected.json',
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
          ref: '/uploads/goon_custom_models/rejected.glb',
          sha256: sha('c'),
          bytes: 200
        }
      }
    ]
  })
}

function event(archiveReceipt: unknown) {
  return {
    params: { id: GOON_ID },
    request: new Request('http://batshit.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archiveReceipt })
    }),
    locals: { user: { id: USER_ID } }
  } as any
}

describe('/api/goons/[id]/advanced-package/cleanup', () => {
  useRedisTestServer()

  beforeEach(async () => {
    mocks.deleteAsset.mockClear()
    await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)
    await redis.json.set(`goon:${GOON_ID}`, '$', {
      id: GOON_ID,
      user_id: USER_ID,
      name: 'Recipe cleanup fixture',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
  })

  it('deletes all rejected assets when no durable Goon or Recipe record owns them', async () => {
    const response = await POST(event(await receipt()))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.retained).toEqual([])
    expect(body.deleted).toEqual([
      'goon_custom_manifests/rejected.json',
      'goon_custom_models/rejected.glb',
      'goon_custom_packages/rejected.bgoon'
    ])
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(3)
  })

  it('retains every asset after a successful ownership write', async () => {
    const goon = await redis.json.get(`goon:${GOON_ID}`) as Record<string, unknown>
    await redis.json.set(`goon:${GOON_ID}`, '$', {
      ...goon,
      customAvatar: {
        package: {
          url: '/uploads/goon_custom_packages/rejected.bgoon',
          filename: 'rejected.bgoon'
        },
        model: {
          url: '/uploads/goon_custom_models/rejected.glb',
          filename: 'rejected.glb'
        },
        manifest: {
          url: '/uploads/goon_custom_manifests/rejected.json',
          filename: 'rejected.json'
        }
      }
    })

    const response = await POST(event(await receipt()))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.deleted).toEqual([])
    expect(body.retained).toHaveLength(3)
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })
})
