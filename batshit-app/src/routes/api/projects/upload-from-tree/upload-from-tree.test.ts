import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  privateEnv: {} as Record<string, string | undefined>,
  publicEnv: {} as Record<string, string | undefined>
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: mocks.getUserSettings
  }
}))

vi.mock('$env/dynamic/private', () => ({
  env: mocks.privateEnv
}))

vi.mock('$env/dynamic/public', () => ({
  env: mocks.publicEnv
}))

import { POST } from './+server'

describe('/api/projects/upload-from-tree', () => {
  const originalServerUrl = process.env.BATSHIT_SERVER_URL
  const originalPublicServerUrl = process.env.PUBLIC_BATSHIT_SERVER_URL
  const originalToken = process.env.BATSHIT_TOKEN

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    for (const key of Object.keys(mocks.privateEnv)) {
      delete mocks.privateEnv[key]
    }
    for (const key of Object.keys(mocks.publicEnv)) {
      delete mocks.publicEnv[key]
    }
    mocks.getUserSettings.mockResolvedValue({})
    restoreEnv()
    // batshit-server calls are service-token-gated; the route attaches this.
    process.env.BATSHIT_TOKEN = 'upload-from-tree-test-token'
  })

  afterEach(() => {
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

    if (originalToken === undefined) {
      delete process.env.BATSHIT_TOKEN
    } else {
      process.env.BATSHIT_TOKEN = originalToken
    }
  }

  it('uses internal batshit-server URLs from Docker server-side callers', async () => {
    mocks.privateEnv.BATSHIT_SERVER_URL = 'http://batshit-server:5600'
    mocks.publicEnv.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600'
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server:5600'
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5600'

    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            content: Buffer.from('hello').toString('base64')
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                originalName: 'hello.txt',
                externalUrl: 'http://localhost:5600/uploads/hello.txt',
                clipData: {
                  id: 'clip-1',
                  storageMode: 'local',
                  tokens: 1
                }
              }
            ]
          })
        )
      )

    const response = await POST({
      request: new Request('http://localhost/api/projects/upload-from-tree', {
        method: 'POST',
        body: JSON.stringify({
          projectPath: '/workspace',
          relativePath: 'hello.txt'
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://batshit-server:5600/api/v1/task/s')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://batshit-server:5600/api/upload')
  })

  it('accepts empty file content from the file tree', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            content: ''
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                originalName: 'empty.txt',
                clipData: {
                  id: 'clip-empty',
                  storageMode: 'local',
                  tokens: 0
                }
              }
            ]
          })
        )
      )

    const response = await POST({
      request: new Request('http://localhost/api/projects/upload-from-tree', {
        method: 'POST',
        body: JSON.stringify({
          projectPath: '/workspace',
          relativePath: 'empty.txt'
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      clip: {
        id: 'clip-empty',
        filename: 'empty.txt'
      }
    })
  })
})
