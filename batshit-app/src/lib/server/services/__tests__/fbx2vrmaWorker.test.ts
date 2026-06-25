import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  convertFbxToVrmaWithDockerWorker,
  getFbx2VrmaDockerWorkerStatus
} from '../fbx2vrmaWorker'

const originalWorkerUrl = process.env.BATSHIT_FBX2VRMA_WORKER_URL
const originalConvertTimeout = process.env.BATSHIT_FBX2VRMA_CONVERT_TIMEOUT_MS

function restoreEnv() {
  if (originalWorkerUrl === undefined) {
    delete process.env.BATSHIT_FBX2VRMA_WORKER_URL
  } else {
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = originalWorkerUrl
  }

  if (originalConvertTimeout === undefined) {
    delete process.env.BATSHIT_FBX2VRMA_CONVERT_TIMEOUT_MS
  } else {
    process.env.BATSHIT_FBX2VRMA_CONVERT_TIMEOUT_MS = originalConvertTimeout
  }
}

describe('fbx2vrma Docker worker helpers', () => {
  afterEach(() => {
    restoreEnv()
    vi.unstubAllGlobals()
  })

  it('reports worker health from the configured URL', async () => {
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          status: 'ready',
          mode: 'docker-worker',
          version: 'v0.9.7'
        })
      )
    )

    await expect(getFbx2VrmaDockerWorkerStatus()).resolves.toMatchObject({
      running: true,
      url: 'http://fbx-worker.test',
      health: {
        status: 'ready',
        version: 'v0.9.7'
      }
    })
  })

  it('converts through the worker using octet-stream bytes', async () => {
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx-worker.test'
    process.env.BATSHIT_FBX2VRMA_CONVERT_TIMEOUT_MS = '12345'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        return Response.json({ ok: true, status: 'ready', version: 'v0.9.7' })
      }

      expect(url).toBe('http://fbx-worker.test/convert')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>)['x-batshit-filename']).toBe('walk.fbx')
      return new Response(new Uint8Array([123, 34, 118, 114, 109, 34, 58, 49, 125]), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'x-batshit-output-filename': 'walk.vrma'
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await convertFbxToVrmaWithDockerWorker(
      new File([new Uint8Array([1, 2, 3])], 'walk.fbx')
    )

    expect(result.file.name).toBe('walk.vrma')
    expect(result.size).toBe(9)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})
