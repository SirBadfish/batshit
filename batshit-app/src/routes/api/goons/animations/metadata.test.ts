import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { PATCH, POST } from './+server'

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

  it('saves posture, playback, eye contact, and tags on motion metadata updates', async () => {
    await seedLibrary()

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
  })

  it('keeps existing metadata when a same-filename upload refresh returns a bare file ref', async () => {
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
  })
})
