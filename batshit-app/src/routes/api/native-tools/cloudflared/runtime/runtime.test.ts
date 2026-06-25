import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DELETE, GET, POST } from './+server'

const originalContainerized = process.env.BATSHIT_CONTAINERIZED
const originalDockerStatePath = process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH
const originalDockerTargetUrl = process.env.BATSHIT_CLOUDFLARED_TARGET_URL
const originalBatshitServerUrl = process.env.BATSHIT_SERVER_URL

function restoreContainerizedEnv() {
  if (originalContainerized === undefined) {
    delete process.env.BATSHIT_CONTAINERIZED
  } else {
    process.env.BATSHIT_CONTAINERIZED = originalContainerized
  }
  if (originalDockerStatePath === undefined) {
    delete process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH
  } else {
    process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH = originalDockerStatePath
  }
  if (originalDockerTargetUrl === undefined) {
    delete process.env.BATSHIT_CLOUDFLARED_TARGET_URL
  } else {
    process.env.BATSHIT_CLOUDFLARED_TARGET_URL = originalDockerTargetUrl
  }
  if (originalBatshitServerUrl === undefined) {
    delete process.env.BATSHIT_SERVER_URL
  } else {
    process.env.BATSHIT_SERVER_URL = originalBatshitServerUrl
  }
}

async function writeSidecarState() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-cloudflared-route-'))
  const statePath = path.join(tempDir, 'status.json')
  process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH = statePath
  await fs.writeFile(
    statePath,
    JSON.stringify({
      mode: 'docker-sidecar',
      status: 'running',
      publicUrl: 'https://fresh-tunnel.trycloudflare.com',
      targetUrl: 'http://batshit-server:5600',
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      version: '2026.3.0',
      logPath: '/runtime/cloudflared/cloudflared.log',
      error: null
    })
  )
  return tempDir
}

function requestJson(body: Record<string, unknown>) {
  return new Request('http://localhost/api/native-tools/cloudflared/runtime', {
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

describe('/api/native-tools/cloudflared/runtime', () => {
  afterEach(() => {
    restoreContainerizedEnv()
  })

  it('reports Cloudflared as a stopped Docker sidecar in containerized Batshit', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    delete process.env.BATSHIT_CLOUDFLARED_TARGET_URL
    delete process.env.BATSHIT_SERVER_URL

    const response = await GET(authedEvent)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installed: false,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      defaultPlatform: 'linux-x64',
      installScope: 'docker-sidecar',
      tunnel: {
        running: false,
        targetUrl: 'http://batshit-server:5600'
      }
    })
  })

  it('blocks Cloudflared install attempts in containerized Batshit', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'

    const response = await POST({
      ...authedEvent,
      request: requestJson({ platform: 'linux-x64' })
    } as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      installed: false,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar'
    })
  })

  it('blocks Cloudflared uninstall attempts in containerized Batshit', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'

    const response = await DELETE(authedEvent)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      uninstalled: false,
      supported: true,
      dockerUnsupported: false,
      status: {
        supportLevel: 'docker-sidecar'
      }
    })
  })

  it('reports an active Docker sidecar but keeps native installer endpoints blocked', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    const tempDir = await writeSidecarState()

    const getResponse = await GET(authedEvent)
    const postResponse = await POST({
      ...authedEvent,
      request: requestJson({ platform: 'linux-x64' })
    } as any)
    const deleteResponse = await DELETE(authedEvent)

    expect(getResponse.status).toBe(200)
    await expect(getResponse.json()).resolves.toMatchObject({
      installed: true,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      tunnel: {
        running: true,
        publicUrl: 'https://fresh-tunnel.trycloudflare.com'
      }
    })
    expect(postResponse.status).toBe(503)
    await expect(postResponse.json()).resolves.toMatchObject({
      supportLevel: 'docker-sidecar',
      installScope: 'docker-sidecar'
    })
    expect(deleteResponse.status).toBe(503)
    await expect(deleteResponse.json()).resolves.toMatchObject({
      status: {
        supportLevel: 'docker-sidecar',
        installScope: 'docker-sidecar'
      }
    })

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
