import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  privateEnv: {} as Record<string, string | undefined>,
  publicEnv: {} as Record<string, string | undefined>,
  dispose: vi.fn()
}))

vi.mock('$env/dynamic/private', () => ({
  env: mocks.privateEnv
}))

vi.mock('$env/dynamic/public', () => ({
  env: mocks.publicEnv
}))

vi.mock('$lib/server/services/goonAssetCleanupService', () => ({ deleteGoonUploadAssetDisposition: mocks.dispose }))

import { DELETE, POST } from './+server'

describe('/api/goons/closet', () => {
  const originalServerUrl = process.env.BATSHIT_SERVER_URL
  const originalPublicServerUrl = process.env.PUBLIC_BATSHIT_SERVER_URL

  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.dispose.mockReset().mockResolvedValue('deleted')
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

  it.each(['deleted', 'retained', 'missing'])('uses the app custody owner and reports %s without accepting browser authority', async disposition => {
    mocks.dispose.mockResolvedValue(disposition)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await DELETE({ request: new Request('http://localhost/api/goons/closet', {
      method: 'DELETE', body: JSON.stringify({ filename: 'shirt.png', uploadType: 'images', deletionToken: 'browser-token' })
    }), locals: { user: { id: 'user-1' } } } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, disposition, deleted: disposition === 'deleted',
      retained: disposition === 'retained', missing: disposition === 'missing' })
    expect(mocks.dispose).toHaveBeenCalledExactlyOnceWith('goon_closet', 'shirt.png')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires authentication and one filename before asking the custody owner', async () => {
    const request = (filename: string) => new Request('http://localhost/api/goons/closet', {
      method: 'DELETE', body: JSON.stringify({ filename })
    })
    expect((await DELETE({ request: request('shirt.png'), locals: {} } as any)).status).toBe(401)
    for (const filename of ['', '../other.png', 'folder/other.png', 'folder\\other.png']) {
      expect((await DELETE({ request: request(filename), locals: { user: { id: 'user-1' } } } as any)).status).toBe(400)
    }
    expect(mocks.dispose).not.toHaveBeenCalled()
  })

  it('surfaces an uncertain owner failure without falling through to raw delete', async () => {
    mocks.dispose.mockRejectedValue(new Error('Clothing cleanup remains unfinished.'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await DELETE({ request: new Request('http://localhost/api/goons/closet', {
      method: 'DELETE', body: JSON.stringify({ filename: 'shirt.png' })
    }), locals: { user: { id: 'user-1' } } } as any)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Clothing cleanup remains unfinished.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
