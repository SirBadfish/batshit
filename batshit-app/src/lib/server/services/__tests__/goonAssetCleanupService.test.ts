import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  auditGoonUploadAssets,
  cleanupOrphanGoonUploadAssets
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
              ]
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
    await seedUpload('goon_scene_props', 'chair.glb')

    const audit = await auditGoonUploadAssets('josh')

    expect(audit.orphanRecordCount).toBe(1)
    expect(audit.orphanBytes).toBe(40)
    expect(audit.orphans).toMatchObject([{ uploadType: 'goons', filename: 'old.vrm' }])
    expect(audit.entries.find((entry) => entry.filename === 'shared.vrma')?.referenced).toBe(true)
    expect(audit.entries.find((entry) => entry.filename === 'room_thumb.jpg')?.referenced).toBe(true)
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
})
