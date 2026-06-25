import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DELETE, GET, POST } from './+server'
import {
  resolveFbxInstallDir,
  resolveRepoRoot
} from '$lib/server/converters/fbx2vrmaInstaller'

const originalContainerized = process.env.BATSHIT_CONTAINERIZED
const originalWorkerUrl = process.env.BATSHIT_FBX2VRMA_WORKER_URL
const originalFbxDir = process.env.BATSHIT_FBX2GLTF_DIR
const originalRuntimeDataDir = process.env.BATSHIT_RUNTIME_DATA_DIR
const originalRepoRoot = process.env.BATSHIT_REPO_ROOT
const originalMacRepoRoot = process.env.BATSHIT_MAC_REPO_ROOT
const originalCwd = process.cwd()

function restoreContainerizedEnv() {
  if (originalContainerized === undefined) {
    delete process.env.BATSHIT_CONTAINERIZED
  } else {
    process.env.BATSHIT_CONTAINERIZED = originalContainerized
  }

  if (originalWorkerUrl === undefined) {
    delete process.env.BATSHIT_FBX2VRMA_WORKER_URL
  } else {
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = originalWorkerUrl
  }

  if (originalFbxDir === undefined) {
    delete process.env.BATSHIT_FBX2GLTF_DIR
  } else {
    process.env.BATSHIT_FBX2GLTF_DIR = originalFbxDir
  }

  if (originalRuntimeDataDir === undefined) {
    delete process.env.BATSHIT_RUNTIME_DATA_DIR
  } else {
    process.env.BATSHIT_RUNTIME_DATA_DIR = originalRuntimeDataDir
  }

  if (originalRepoRoot === undefined) {
    delete process.env.BATSHIT_REPO_ROOT
  } else {
    process.env.BATSHIT_REPO_ROOT = originalRepoRoot
  }

  if (originalMacRepoRoot === undefined) {
    delete process.env.BATSHIT_MAC_REPO_ROOT
  } else {
    process.env.BATSHIT_MAC_REPO_ROOT = originalMacRepoRoot
  }

  process.chdir(originalCwd)
}

function requestJson(body: Record<string, unknown>) {
  return new Request('http://localhost/api/goons/animations/converter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

const authedEvent = {
  locals: {
    user: {
      id: 'user-1'
    }
  }
} as any

describe('/api/goons/animations/converter', () => {
  afterEach(() => {
    restoreContainerizedEnv()
    vi.unstubAllGlobals()
  })

  it('resolves native installer roots outside batshit-app and under runtime data when configured', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-fbx-root-'))
    const tempDir = await fs.realpath(tempRoot)
    const appDir = path.join(tempDir, 'batshit-app')
    const runtimeDir = path.join(tempDir, 'runtime')
    await fs.mkdir(appDir, { recursive: true })

    delete process.env.BATSHIT_REPO_ROOT
    delete process.env.BATSHIT_MAC_REPO_ROOT
    delete process.env.BATSHIT_FBX2GLTF_DIR
    delete process.env.BATSHIT_RUNTIME_DATA_DIR
    process.chdir(appDir)

    expect(resolveRepoRoot()).toBe(tempDir)
    expect(resolveFbxInstallDir()).toBe(path.join(tempDir, '_local', 'fbx2vrma'))

    process.env.BATSHIT_RUNTIME_DATA_DIR = runtimeDir
    expect(resolveFbxInstallDir()).toBe(path.join(runtimeDir, 'fbx2vrma'))

    process.env.BATSHIT_FBX2GLTF_DIR = path.join(tempDir, 'explicit-fbx')
    expect(resolveFbxInstallDir()).toBe(path.join(tempDir, 'explicit-fbx'))

    process.chdir(originalCwd)
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('reports the converter as waiting for the Docker worker in containerized Batshit', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('worker offline')
      })
    )

    const response = await GET(authedEvent)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installed: false,
      supported: false,
      dockerUnsupported: true,
      supportLevel: 'docker-worker-missing',
      defaultPlatform: 'linux-x64'
    })
  })

  it('reports an active Docker worker when the sidecar is healthy', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          status: 'ready',
          mode: 'docker-worker',
          version: 'v0.9.7',
          fbx2gltfVersion: 'v0.9.7'
        })
      )
    )

    const response = await GET(authedEvent)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installed: true,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-worker',
      defaultPlatform: 'linux-x64',
      worker: {
        running: true,
        url: 'http://fbx2vrma-worker.test'
      }
    })
  })

  it('blocks converter install attempts in containerized Batshit', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
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

    const response = await POST({
      ...authedEvent,
      request: requestJson({ platform: 'linux-x64' })
    } as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      installed: true,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-worker'
    })
  })

  it('blocks converter uninstall attempts in containerized Batshit', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
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

    const response = await DELETE(authedEvent)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      installed: true,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-worker'
    })
  })
})
