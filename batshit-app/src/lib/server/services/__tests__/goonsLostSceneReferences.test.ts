import { describe, expect, it } from 'vitest'
import { POST } from '../../../../routes/api/user/settings/+server'
import { normalizeGoonsSettings } from '$lib/goons/resolve'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { auditGoonUploadAssets } from '../goonAssetCleanupService'

useRedisTestServer()

const USER = 'goons-lost-scene-reference'
const SCENE_FILE = 'saved-skybox.jpg'
const SCENE_URL = `http://localhost:5601/uploads/goon_scenes/${SCENE_FILE}`

function postSettings(goonsSettings: unknown) {
  return POST({
    request: new Request('http://localhost/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goons_settings: goonsSettings })
    }),
    locals: { user: { id: USER, email: 'goons-test@example.com' } }
  } as any)
}

describe('Goons settings lost scene references', () => {
  it('makes a saved skybox eligible as an orphan after an old defaults-based whole-settings POST', async () => {
    await redis.json.set(`user:${USER}:settings`, '$', {
      id: `settings_${USER}`,
      user_id: USER,
      goons_settings: {
        immersiveMode: false,
        kitchen: {
          scenes: {
            saved_scene: {
              id: 'saved_scene',
              name: 'Saved Scene',
              skybox: { url: SCENE_URL, filename: SCENE_FILE }
            }
          }
        }
      }
    })
    await redis.json.set(`upload:goon_scenes:${SCENE_FILE}`, '$', {
      originalName: SCENE_FILE,
      mimetype: 'image/jpeg',
      size: 1234,
      uploadType: 'goon_scenes',
      base64: Buffer.from('scene-upload-fixture').toString('base64'),
      uploadedAt: '2026-09-29T00:00:00.000Z'
    })

    const before = await auditGoonUploadAssets(USER)
    const beforeEntry = before.entries.find((entry) => entry.filename === SCENE_FILE)
    expect(beforeEntry).toMatchObject({
      uploadType: 'goon_scenes',
      referenced: true,
      size: 1234
    })
    expect(beforeEntry?.references).toContain('Scene Saved Scene skybox')
    expect(before.orphans).not.toContainEqual(expect.objectContaining({ filename: SCENE_FILE }))

    // This is the old failed-store behavior: the panel resolves an empty store to defaults,
    // then a section save posts that whole normalized record. The real route replaces the saved
    // goons_settings value with it, including its empty Scenes library.
    const staleDefaults = normalizeGoonsSettings(null)
    expect(staleDefaults.kitchen.scenes).toEqual({})
    const response = await postSettings(staleDefaults)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.settings.goons_settings.kitchen.scenes).toEqual({})
    expect((await redis.getUserSettings(USER) as any)?.goons_settings.kitchen.scenes).toEqual({})

    const after = await auditGoonUploadAssets(USER)
    const afterEntry = after.entries.find((entry) => entry.filename === SCENE_FILE)
    expect(afterEntry).toMatchObject({
      uploadType: 'goon_scenes',
      referenced: false,
      size: 1234,
      storage: 'redis'
    })
    expect(afterEntry?.references).toEqual([])
    expect(after.orphans).toContainEqual(expect.objectContaining({
      uploadType: 'goon_scenes',
      filename: SCENE_FILE
    }))
    expect(after.byType.find((summary) => summary.uploadType === 'goon_scenes')).toMatchObject({
      orphanRecordCount: 1,
      orphanBytes: 1234
    })
  })
})
