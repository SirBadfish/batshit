import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn(),
    store: vi.fn()
  }
}))

vi.mock('$lib/server/services/voiceLocalEngineSetup', () => ({
  resolveLocalVoiceRuntimeLaunchRecordPath: vi.fn(
    (engineId: string) => `/tmp/${engineId}/launch-record.json`
  ),
  resolveManagedInstallsRoot: vi.fn(() => '/tmp/batshit-managed-installs'),
  startLocalVoiceRuntime: vi.fn()
}))

import {
  getBundledLiveKitSidecarMetadata,
  getNativeLiveKitInstallStatus
} from '$lib/server/services/liveKitNativeRuntimeInstaller'

describe('liveKitNativeRuntimeInstaller', () => {
  const originalSidecarRoot = process.env.LIVEKIT_AGENT_INSTALL_ROOT
  const originalServerRoot = process.env.LIVEKIT_SERVER_INSTALL_ROOT
  const originalSourceRoot = process.env.LIVEKIT_AGENT_SOURCE_ROOT

  beforeEach(() => {
    process.env.LIVEKIT_AGENT_SOURCE_ROOT = path.resolve(
      process.cwd(),
      '..',
      'tools',
      'livekit-agent-sidecar'
    )
  })

  afterEach(() => {
    if (originalSidecarRoot === undefined) delete process.env.LIVEKIT_AGENT_INSTALL_ROOT
    else process.env.LIVEKIT_AGENT_INSTALL_ROOT = originalSidecarRoot
    if (originalServerRoot === undefined) delete process.env.LIVEKIT_SERVER_INSTALL_ROOT
    else process.env.LIVEKIT_SERVER_INSTALL_ROOT = originalServerRoot
    if (originalSourceRoot === undefined) delete process.env.LIVEKIT_AGENT_SOURCE_ROOT
    else process.env.LIVEKIT_AGENT_SOURCE_ROOT = originalSourceRoot
  })

  it('fingerprints the exact bundled LiveKit Agents source package', async () => {
    await expect(getBundledLiveKitSidecarMetadata()).resolves.toMatchObject({
      version: '1.6.3',
      sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('marks an installed sidecar stale until its manifest matches the bundled fingerprint', async () => {
    const sidecarRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-install-'))
    const serverRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-server-'))
    process.env.LIVEKIT_AGENT_INSTALL_ROOT = sidecarRoot
    process.env.LIVEKIT_SERVER_INSTALL_ROOT = serverRoot

    await mkdir(path.join(sidecarRoot, 'node_modules', '.bin'), { recursive: true })
    await mkdir(path.join(sidecarRoot, 'node_modules', '@livekit', 'agents'), { recursive: true })
    await writeFile(path.join(sidecarRoot, 'package.json'), '{}\n')
    await writeFile(path.join(sidecarRoot, 'node_modules', '.bin', 'tsx'), '')
    await writeFile(
      path.join(sidecarRoot, 'node_modules', '@livekit', 'agents', 'package.json'),
      '{"version":"1.6.3"}\n'
    )

    await expect(getNativeLiveKitInstallStatus()).resolves.toMatchObject({
      sidecarInstalled: true,
      sidecarUpdateAvailable: true
    })

    const bundled = await getBundledLiveKitSidecarMetadata()
    await writeFile(
      path.join(sidecarRoot, 'batshit-livekit-sidecar-manifest.json'),
      `${JSON.stringify({
        kind: 'livekit-sidecar',
        version: '1.6.3',
        installedAt: new Date().toISOString(),
        installRoot: sidecarRoot,
        source: 'batshit-bundled-sidecar',
        packageManager: 'npm',
        sourceFingerprint: bundled.sourceFingerprint
      })}\n`
    )

    await expect(getNativeLiveKitInstallStatus()).resolves.toMatchObject({
      sidecarInstalled: true,
      sidecarUpdateAvailable: false
    })
  })
})
