import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ensureManagedCloudflaredTunnel,
  getDefaultDockerManagedTunnelTargetUrl,
  getCloudflaredRuntimeStatus,
  getDefaultManagedTunnelTargetUrl,
  installCloudflaredRuntime,
  resolveCloudflaredInstallDir,
  resolveRepoRoot,
  uninstallCloudflaredRuntime
} from '../cloudflaredRuntime'

const originalContainerized = process.env.BATSHIT_CONTAINERIZED
const originalDockerStatePath = process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH
const originalDockerTargetUrl = process.env.BATSHIT_CLOUDFLARED_TARGET_URL
const originalBatshitServerUrl = process.env.BATSHIT_SERVER_URL
const originalCloudflaredDir = process.env.BATSHIT_CLOUDFLARED_DIR
const originalRuntimeDataDir = process.env.BATSHIT_RUNTIME_DATA_DIR
const originalRepoRoot = process.env.BATSHIT_REPO_ROOT
const originalMacRepoRoot = process.env.BATSHIT_MAC_REPO_ROOT
const originalCwd = process.cwd()

afterEach(() => {
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
  if (originalCloudflaredDir === undefined) {
    delete process.env.BATSHIT_CLOUDFLARED_DIR
  } else {
    process.env.BATSHIT_CLOUDFLARED_DIR = originalCloudflaredDir
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
})

describe('cloudflaredRuntime', () => {
  it('resolves native installer roots outside batshit-app and under runtime data when configured', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-cloudflared-root-'))
    const tempDir = await fs.realpath(tempRoot)
    const appDir = path.join(tempDir, 'batshit-app')
    const runtimeDir = path.join(tempDir, 'runtime')
    await fs.mkdir(appDir, { recursive: true })

    delete process.env.BATSHIT_REPO_ROOT
    delete process.env.BATSHIT_MAC_REPO_ROOT
    delete process.env.BATSHIT_CLOUDFLARED_DIR
    delete process.env.BATSHIT_RUNTIME_DATA_DIR
    process.chdir(appDir)

    expect(resolveRepoRoot()).toBe(tempDir)
    expect(resolveCloudflaredInstallDir()).toBe(path.join(tempDir, '_local', 'cloudflared'))

    process.env.BATSHIT_RUNTIME_DATA_DIR = runtimeDir
    expect(resolveCloudflaredInstallDir()).toBe(path.join(runtimeDir, 'cloudflared'))

    process.env.BATSHIT_CLOUDFLARED_DIR = path.join(tempDir, 'explicit-cloudflared')
    expect(resolveCloudflaredInstallDir()).toBe(path.join(tempDir, 'explicit-cloudflared'))

    process.chdir(originalCwd)
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('defaults managed tunnel target to the configured public batshit-server URL', () => {
    expect(
      getDefaultManagedTunnelTargetUrl({
        PUBLIC_BATSHIT_SERVER_URL: 'http://localhost:5606/',
        BATSHIT_SERVER_URL: 'http://localhost:5600',
      } as NodeJS.ProcessEnv)
    ).toBe('http://localhost:5606')
  })

  it('falls back to the configured internal batshit-server URL', () => {
    expect(
      getDefaultManagedTunnelTargetUrl({
        BATSHIT_SERVER_URL: 'http://localhost:5606/',
      } as NodeJS.ProcessEnv)
    ).toBe('http://localhost:5606')
  })

  it('keeps the normal dev-stack default when no server URL override exists', () => {
    expect(getDefaultManagedTunnelTargetUrl({} as NodeJS.ProcessEnv)).toBe(
      'http://localhost:5600'
    )
  })

  it('defaults Docker managed tunnel target to the Compose batshit-server URL', () => {
    expect(getDefaultDockerManagedTunnelTargetUrl({} as NodeJS.ProcessEnv)).toBe(
      'http://batshit-server:5600'
    )
    expect(
      getDefaultDockerManagedTunnelTargetUrl({
        BATSHIT_CLOUDFLARED_TARGET_URL: 'http://cloudflared-target:5600/',
        BATSHIT_SERVER_URL: 'http://batshit-server:5600'
      } as NodeJS.ProcessEnv)
    ).toBe('http://cloudflared-target:5600')
  })

  it('reports managed Cloudflared as a stopped Docker sidecar without probing/installing', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    delete process.env.BATSHIT_CLOUDFLARED_TARGET_URL
    delete process.env.BATSHIT_SERVER_URL

    const status = await getCloudflaredRuntimeStatus()
    const install = await installCloudflaredRuntime('linux-x64')
    const uninstall = await uninstallCloudflaredRuntime()
    const tunnel = await ensureManagedCloudflaredTunnel({ targetUrl: 'http://batshit-server:5600' })

    expect(status).toMatchObject({
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
    expect(install).toMatchObject({
      installed: false,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar'
    })
    expect(uninstall).toMatchObject({
      uninstalled: false,
      supported: true,
      dockerUnsupported: false
    })
    expect(tunnel).toMatchObject({
      started: false
    })
    expect(tunnel.reason).toMatch(/sidecar is not running/i)
  })

  it('adopts an active Docker Cloudflared sidecar status file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-cloudflared-sidecar-'))
    const statePath = path.join(tempDir, 'status.json')
    process.env.BATSHIT_CONTAINERIZED = '1'
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

    const status = await getCloudflaredRuntimeStatus()
    const tunnel = await ensureManagedCloudflaredTunnel({ targetUrl: 'http://batshit-server:5600' })

    expect(status).toMatchObject({
      installed: true,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      installScope: 'docker-sidecar',
      version: '2026.3.0',
      tunnel: {
        running: true,
        publicUrl: 'https://fresh-tunnel.trycloudflare.com',
        targetUrl: 'http://batshit-server:5600'
      }
    })
    expect(status.dockerSidecar).toMatchObject({
      mode: 'docker-sidecar',
      stale: false,
      statePath
    })
    expect(tunnel).toMatchObject({
      started: true,
      status: {
        publicUrl: 'https://fresh-tunnel.trycloudflare.com'
      }
    })

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('does not expose stale public URLs from stopped Docker sidecar status files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-cloudflared-stopped-'))
    const statePath = path.join(tempDir, 'status.json')
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH = statePath

    await fs.writeFile(
      statePath,
      JSON.stringify({
        mode: 'docker-sidecar',
        status: 'stopped',
        publicUrl: 'https://old-tunnel.trycloudflare.com',
        targetUrl: 'http://batshit-server:5600',
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        version: '2026.3.0',
        logPath: '/runtime/cloudflared/cloudflared.log',
        error: null
      })
    )

    const status = await getCloudflaredRuntimeStatus()

    expect(status).toMatchObject({
      installed: false,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      reason: 'Docker Cloudflared sidecar is stopped.',
      tunnel: {
        running: false,
        publicUrl: null,
        targetUrl: 'http://batshit-server:5600'
      },
      dockerSidecar: {
        status: 'stopped',
        publicUrl: null
      }
    })

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
