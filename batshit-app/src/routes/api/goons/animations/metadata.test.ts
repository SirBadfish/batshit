import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { DELETE, GET, PATCH, POST } from './+server'
import { POST as uploadPreview } from './previews/+server'

const USER_ID = 'user-1'
const LIBRARY_KEY = `user:${USER_ID}:goons_animation_library`

function authedEvent(request: Request) {
  return {
    request,
    locals: {
      user: {
        id: USER_ID
      }
    }
  } as any
}

function jsonRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/goons/animations', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function seedLibrary() {
  await redis.json.set(LIBRARY_KEY, '$', {
    vrma: [
      {
        url: 'http://localhost:5600/uploads/goon_animations/belly.vrma',
        filename: 'belly.vrma',
        displayName: 'Belly Dance',
        originalName: 'belly.fbx',
        tags: ['dance'],
        motionMeta: {
          posture: 'stand',
          playback: 'loop',
          eyeContact: 'off'
        }
      }
    ],
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z'
  })
}

describe('/api/goons/animations metadata persistence', () => {
  useRedisTestServer()

  beforeEach(() => {
    vi.stubEnv('BATSHIT_TOKEN', 'goon-motion-test-token')
    vi.stubEnv('BATSHIT_SERVER_URL', 'http://batshit-server.test')
    vi.stubEnv('PUBLIC_BATSHIT_SERVER_URL', 'http://localhost:5600')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('returns normalized legacy Vault references without losing their motion metadata', async () => {
    await redis.json.set(LIBRARY_KEY, '$', { vrma: [{
      url: '/uploads/goon_animations/wave.glb', filename: 'wave.glb', originalname: 'Wave.glb',
      uploaded_at: '2026-06-01T00:00:00Z', size: 42,
      motionMeta: { posture: ' stand ', playback: 'loop', eyeContact: 'off' }
    }] })
    const response = await GET(authedEvent(new Request('http://localhost/api/goons/animations')))
    expect(response.status).toBe(200)
    expect((await response.json()).library.vrma[0]).toMatchObject({
      url: 'http://localhost:5600/uploads/goon_animations/wave.glb', filename: 'wave.glb',
      originalName: 'Wave.glb', uploadedAt: '2026-06-01T00:00:00Z', size: 42,
      motionMeta: { posture: 'stand', playback: 'loop', eyeContact: 'off' }
    })
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('distinguishes a missing library from malformed present records without modifying them', async () => {
    const empty = await GET(authedEvent(new Request('http://localhost/api/goons/animations')))
    expect(empty.status).toBe(200)
    expect((await empty.json()).library.vrma).toEqual([])
    for (const invalid of [null, [], {}, { vrma: 'broken' }, { vrma: [null] },
      { vrma: [{ filename: 'lost.glb' }] }, { vrma: [{ url: '/lost.glb', filename: 'lost.glb', originalName: 42 }] }]) {
      await redis.json.set(LIBRARY_KEY, '$', invalid as any)
      const before = await redis.execute((client) => client.sendCommand(['JSON.GET', LIBRARY_KEY]))
      const result = await GET(authedEvent(new Request('http://localhost/api/goons/animations')))
      expect(result.status).toBe(500)
      expect(await redis.execute((client) => client.sendCommand(['JSON.GET', LIBRARY_KEY]))).toBe(before)
    }
  })

  it('refuses malformed saved libraries before a Motion or preview upload and before deletion', async () => {
    const invalid = { vrma: 'broken', retained: { keep: true } }
    await redis.json.set(LIBRARY_KEY, '$', invalid as any)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const file = new File(['bytes'], 'wave.glb', { type: 'model/gltf-binary' })
    const motion = new FormData()
    motion.append('file', file)
    motion.append('replaceExisting', 'true')
    const preview = new FormData()
    preview.append('animationFilename', 'wave.glb')
    preview.append('file', new File(['video'], 'wave.webm', { type: 'video/webm' }))
    const responses = [
      await POST({ ...authedEvent(new Request('http://localhost/api/goons/animations')), request: { formData: async () => motion } } as any),
      await PATCH(authedEvent(jsonRequest({ filename: 'wave.glb', displayName: 'Wave' }))),
      await DELETE(authedEvent(new Request('http://localhost/api/goons/animations', {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filenames: ['wave.glb'] })
      }))),
      await uploadPreview({ ...authedEvent(new Request('http://localhost/api/goons/animations/previews')), request: { formData: async () => preview } } as any)
    ]
    expect(responses.map((response) => response.status)).toEqual([500, 500, 500, 500])
    expect(fetcher).not.toHaveBeenCalled()
    expect(await redis.json.get(LIBRARY_KEY)).toEqual(invalid)
  })

  it('saves posture, playback, eye contact, and tags on motion metadata updates', async () => {
    await seedLibrary()
    await redis.execute(async (client) => {
      const existing = await client.json.get(LIBRARY_KEY) as any
      existing.vrma[0].extraMetadata = { retained: true }
      existing.vrma[0].thumbnailUrl = '/thumb.png'
      existing.vrma[0].previewVideo = { url: '/preview.webm', filename: 'preview.webm',
        originalName: null, size: null, mimeType: null, uploadedAt: null, extra: { retained: true } }
      await client.json.set(LIBRARY_KEY, '$', existing)
    })

    const response = await PATCH(
      authedEvent(
        jsonRequest({
          filename: 'belly.vrma',
          displayName: 'Belly Dance 2',
          tags: ['dance', 'gesture'],
          motionMeta: {
            posture: 'sit',
            playback: 'oneshot',
            eyeContact: 'off'
          }
        })
      )
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.library.vrma[0]).toMatchObject({
      filename: 'belly.vrma',
      displayName: 'Belly Dance 2',
      tags: ['dance', 'gesture'],
      motionMeta: {
        posture: 'sit',
        playback: 'oneshot',
        eyeContact: 'off'
      }
    })
    expect((await redis.json.get(LIBRARY_KEY) as any).vrma[0]).toMatchObject({
      extraMetadata: { retained: true }, thumbnailUrl: '/thumb.png',
      previewVideo: { originalName: null, size: null, mimeType: null, uploadedAt: null, extra: { retained: true } }
    })
  })

  it('uploads a preview for a valid retained Motion without losing its metadata', async () => {
    await seedLibrary()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      file: { url: 'http://batshit-server.test/uploads/goon_animation_previews/belly.webm', filename: 'belly.webm' }
    }))
    const preview = new FormData()
    preview.append('animationFilename', 'belly.vrma')
    preview.append('file', new File(['video'], 'belly.webm', { type: 'video/webm' }))
    const response = await uploadPreview({ ...authedEvent(new Request('http://localhost/api/goons/animations/previews')),
      request: { formData: async () => preview } } as any)
    expect(response.status).toBe(200)
    expect((await response.json()).library.vrma[0]).toMatchObject({
      filename: 'belly.vrma', tags: ['dance'], motionMeta: { posture: 'stand', playback: 'loop', eyeContact: 'off' },
      previewVideo: { filename: 'belly.webm' }
    })
  })

  it('keeps existing metadata when a consented same-filename replace returns a bare file ref', async () => {
    await seedLibrary()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        file: {
          url: 'http://batshit-server.test/uploads/goon_animations/belly.vrma',
          filename: 'belly.vrma',
          originalName: 'belly.vrma',
          size: 9,
          mimetype: 'model/vrm',
          uploadedAt: '2026-06-18T00:00:00.000Z'
        }
      })
    )

    const form = new FormData()
    form.append('file', new File(['new bytes'], 'belly.vrma', { type: 'model/vrm' }))
    // same-name uploads without consent 409 by design (confirm-first
    // replace-on-reupload, 2026-07-07); the metadata-preservation contract
    // applies to the consented replace path
    form.append('replaceExisting', '1')

    const response = await POST({
      request: {
        formData: async () => form
      },
      locals: {
        user: {
          id: USER_ID
        }
      }
    } as any)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.library.vrma[0]).toMatchObject({
      url: 'http://localhost:5600/uploads/goon_animations/belly.vrma',
      filename: 'belly.vrma',
      originalName: 'belly.vrma',
      size: 9,
      tags: ['dance'],
      motionMeta: {
        posture: 'stand',
        playback: 'loop',
        eyeContact: 'off'
      }
    })

    const stored = (await redis.json.get(LIBRARY_KEY)) as any
    expect(stored.vrma[0].url).toBe('/uploads/goon_animations/belly.vrma')
  })
})
