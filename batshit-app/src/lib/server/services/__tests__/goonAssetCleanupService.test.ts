import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  auditGoonUploadAssets,
  cleanupOrphanGoonUploadAssets,
  deleteGoonRecipeRecordsForClient
} from '../goonAssetCleanupService'

useRedisTestServer()

async function seedUpload(uploadType: string, filename: string, size = 10) {
  await redis.json.set(`upload:${uploadType}:${filename}`, '$', {
    originalName: filename,
    mimetype: 'application/octet-stream',
    size,
    uploadType,
    base64: Buffer.from(filename).toString('base64'),
    uploadedAt: '2026-05-22T00:00:00.000Z'
  })
}

describe('goonAssetCleanupService', () => {
  it('keeps assets referenced by Goons, Motion Vault, Closet, and Scenes while flagging orphans', async () => {
    await redis.sAdd('user:josh:goons', 'goon_one', 'goon_two')
    await redis.json.set('goon:goon_one', '$', {
      id: 'goon_one',
      user_id: 'josh',
      name: 'One',
      files: {
        vrm: {
          url: 'http://localhost:5601/uploads/goons/live.vrm',
          filename: 'live.vrm'
        },
        animations: [
          {
            url: 'http://localhost:5601/uploads/goon_animations/shared.vrma',
            filename: 'shared.vrma'
          }
        ]
      },
      facialArtwork: {
        schemaVersion: 'facial-artwork-state/v3',
        roles: {
          brows: {
            mode: 'shared',
            shared: {
              artwork: {
                upload: {
                  role: 'brows',
                  url: 'http://localhost:5601/uploads/goon_facial_artwork/brow-left.png',
                  filename: 'brow-left.png'
                }
              }
            }
          }
        }
      },
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z'
    })
    await redis.json.set('goon:goon_two', '$', {
      id: 'goon_two',
      user_id: 'josh',
      name: 'Two',
      files: {
        animations: [
          {
            url: 'http://localhost:5601/uploads/goon_animations/shared.vrma',
            filename: 'shared.vrma'
          }
        ]
      },
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z'
    })
    await redis.json.set('user:josh:goons_animation_library', '$', {
      vrma: [
        {
          url: 'http://localhost:5601/uploads/goon_animations/library.vrma',
          filename: 'library.vrma',
          previewVideo: {
            url: 'http://localhost:5601/uploads/goon_animation_previews/library.mp4',
            filename: 'library.mp4'
          }
        }
      ]
    })
    await redis.json.set('user:josh:settings', '$', {
      id: 'settings_josh',
      user_id: 'josh',
      goons_settings: {
        globalCloset: {
          items: {
            hoodie: {
              id: 'hoodie',
              name: 'Hoodie',
              category: 'top',
              texture: {
                url: 'http://localhost:5601/uploads/goon_closet/hoodie.png',
                filename: 'hoodie.png'
              }
            }
          }
        },
        kitchen: {
          scenes: {
            room: {
              id: 'room',
              name: 'Room',
              skybox: {
                url: 'http://localhost:5601/uploads/goon_scenes/room.jpg',
                filename: 'room.jpg',
                thumbnailUrl: 'http://localhost:5601/uploads/goon_scene_thumbs/room_thumb.jpg'
              },
              roomShell: {
                url: 'http://localhost:5601/uploads/goon_room_shells/room.glb',
                filename: 'room.glb'
              },
              props: [
                {
                  id: 'chair',
                  name: 'Chair',
                  fileRef: {
                    url: 'http://localhost:5601/uploads/goon_scene_props/chair.glb',
                    filename: 'chair.glb'
                  }
                }
              ],
              roomShellBuilder: {
                terrainSkirt: {
                  enabled: true,
                  surface: {
                    texture: {
                      url: 'http://localhost:5601/uploads/goon_room_textures/terrain.png',
                      filename: 'terrain.png'
                    }
                  }
                }
              }
            }
          },
          roomTextures: {
            floor: [
              {
                url: 'http://localhost:5601/uploads/goon_room_textures/floor.png',
                filename: 'floor.png',
                kind: 'floor'
              }
            ]
          }
        }
      }
    })

    await seedUpload('goons', 'live.vrm')
    await seedUpload('goons', 'old.vrm', 40)
    await seedUpload('goon_animations', 'shared.vrma')
    await seedUpload('goon_animations', 'library.vrma')
    await seedUpload('goon_animation_previews', 'library.mp4')
    await seedUpload('goon_closet', 'hoodie.png')
    await seedUpload('goon_scenes', 'room.jpg')
    await seedUpload('goon_scene_thumbs', 'room_thumb.jpg')
    await seedUpload('goon_room_shells', 'room.glb')
    await seedUpload('goon_room_textures', 'floor.png')
    await seedUpload('goon_room_textures', 'terrain.png')
    await seedUpload('goon_scene_props', 'chair.glb')
    await seedUpload('goon_facial_artwork', 'brow-left.png')

    const audit = await auditGoonUploadAssets('josh')

    expect(audit.orphanRecordCount).toBe(1)
    expect(audit.orphanBytes).toBe(40)
    expect(audit.orphans).toMatchObject([{ uploadType: 'goons', filename: 'old.vrm' }])
    expect(audit.entries.find((entry) => entry.filename === 'shared.vrma')?.referenced).toBe(true)
    expect(audit.entries.find((entry) => entry.filename === 'room_thumb.jpg')?.referenced).toBe(true)
    expect(audit.entries.find((entry) => entry.filename === 'terrain.png')?.referenced).toBe(true)
    expect(audit.entries.find((entry) => entry.filename === 'brow-left.png')?.referenced).toBe(true)
  })

  it('deletes only orphaned Goon upload records during cleanup', async () => {
    await redis.sAdd('user:josh:goons', 'goon_one')
    await redis.json.set('goon:goon_one', '$', {
      id: 'goon_one',
      user_id: 'josh',
      name: 'One',
      files: {
        vrm: {
          url: 'http://localhost:5601/uploads/goons/live.vrm',
          filename: 'live.vrm'
        }
      },
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z'
    })
    await seedUpload('goons', 'live.vrm')
    await seedUpload('goons', 'orphan.vrm')

    const deleted: string[] = []
    const result = await cleanupOrphanGoonUploadAssets('josh', {
      deleteAsset: async (uploadType, filename) => {
        deleted.push(`${uploadType}/${filename}`)
        await redis.del(`upload:${uploadType}:${filename}`)
      }
    })

    expect(result.deletedCount).toBe(1)
    expect(deleted).toEqual(['goons/orphan.vrm'])
    expect(await redis.exists('upload:goons:live.vrm')).toBe(true)
    expect(await redis.exists('upload:goons:orphan.vrm')).toBe(false)
  })

  it('keeps assets referenced only by durable Recipe records and deletes their records explicitly', async () => {
    await redis.sAdd('user:josh:goons', 'goon_recipe')
    await redis.json.set('goon:goon_recipe', '$', {
      id: 'goon_recipe',
      user_id: 'josh',
      name: 'Recipe Goon',
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
    await redis.json.set('goon_recipe_revision:josh:goon_recipe:revision-1', '$', {
      contract: 'goon-recipe-revision-envelope/v1',
      live: {
        package: { ref: '/uploads/goon_custom_packages/live.bgoon' },
        model: { ref: '/uploads/goon_custom_models/live.glb' },
        manifest: { ref: '/uploads/goon_custom_manifests/live.json' }
      }
    })
    await redis.json.set('goon_recipe_job:josh:goon_recipe:job-2', '$', {
      contract: 'goon-recipe-job/v1',
      cleanupAssets: [{ ref: '/uploads/goon_custom_models/staged.glb' }]
    })

    await seedUpload('goon_custom_packages', 'live.bgoon')
    await seedUpload('goon_custom_models', 'live.glb')
    await seedUpload('goon_custom_manifests', 'live.json')
    await seedUpload('goon_custom_models', 'staged.glb')
    await seedUpload('goon_custom_models', 'orphan.glb')

    const audit = await auditGoonUploadAssets('josh')
    expect(audit.orphans).toMatchObject([{ uploadType: 'goon_custom_models', filename: 'orphan.glb' }])
    expect(audit.entries.find((entry) => entry.filename === 'live.bgoon')?.referenced).toBe(true)
    expect(audit.entries.find((entry) => entry.filename === 'staged.glb')?.referenced).toBe(true)

    const deleted = await redis.execute((client) =>
      deleteGoonRecipeRecordsForClient(client as any, 'josh', 'goon_recipe')
    )
    expect(deleted).toBe(2)
    expect(await redis.exists('goon_recipe_revision:josh:goon_recipe:revision-1')).toBe(false)
    expect(await redis.exists('goon_recipe_job:josh:goon_recipe:job-2')).toBe(false)
  })
})
