import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  privateEnv: {} as Record<string, string | undefined>,
  publicEnv: {} as Record<string, string | undefined>
}))

vi.mock('$env/dynamic/private', () => ({
  env: mocks.privateEnv
}))

vi.mock('$env/dynamic/public', () => ({
  env: mocks.publicEnv
}))

import { DELETE, POST } from './+server'

describe('/api/goons/closet', () => {
  const originalServerUrl = process.env.BATSHIT_SERVER_URL
  const originalPublicServerUrl = process.env.PUBLIC_BATSHIT_SERVER_URL

  beforeEach(() => {
    vi.restoreAllMocks()
    for (const key of Object.keys(mocks.privateEnv)) {
      delete mocks.privateEnv[key]
    }
    for (const key of Object.keys(mocks.publicEnv)) {
      delete mocks.publicEnv[key]
    }
    restoreEnv()
    // batshit-server uploads are service-token-gated; the route attaches it.
    vi.stubEnv('BATSHIT_TOKEN', 'closet-test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    restoreEnv()
  })

  function restoreEnv() {
    if (originalServerUrl === undefined) {
      delete process.env.BATSHIT_SERVER_URL
    } else {
      process.env.BATSHIT_SERVER_URL = originalServerUrl
    }

    if (originalPublicServerUrl === undefined) {
      delete process.env.PUBLIC_BATSHIT_SERVER_URL
    } else {
      process.env.PUBLIC_BATSHIT_SERVER_URL = originalPublicServerUrl
    }
  }

  it('uses the internal batshit-server URL for Docker uploads', async () => {
    mocks.privateEnv.BATSHIT_SERVER_URL = 'http://batshit-server:5600'
    mocks.publicEnv.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600'
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          file: {
            filename: 'shirt.vrm',
            url: 'http://localhost:5600/uploads/goon-closet/shirt.vrm'
          }
        })
      )
    )

    const form = new FormData()
    form.append('file', new File(['vrm'], 'shirt.vrm'))

    const response = await POST({
      request: {
        formData: async () => form
      },
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://batshit-server:5600/api/upload/goon-closet')
  })

  it('uses the internal batshit-server URL for Docker deletes', async () => {
    mocks.privateEnv.BATSHIT_SERVER_URL = 'http://batshit-server:5600'
    mocks.publicEnv.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600'
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }))
    )

    const response = await DELETE({
      request: new Request('http://localhost/api/goons/closet', {
        method: 'DELETE',
        body: JSON.stringify({ filename: 'shirt.vrm' })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://batshit-server:5600/api/upload/goon-closet')
  })
})
