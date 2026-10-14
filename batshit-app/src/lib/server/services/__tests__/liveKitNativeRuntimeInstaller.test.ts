import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
  getNativeLiveKitInstallStatus,
  startNativeLiveKitServerRuntime
} from '$lib/server/services/liveKitNativeRuntimeInstaller'
import { resolveVoiceRuntimeRegistryIdentity } from '$lib/server/services/voiceRuntimeLaunchRecords'
import { startLocalVoiceRuntime } from '$lib/server/services/voiceLocalEngineSetup'

describe('liveKitNativeRuntimeInstaller', () => {
  const fixtureRoots: string[] = []
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

  afterEach(async () => {
    if (originalSidecarRoot === undefined) delete process.env.LIVEKIT_AGENT_INSTALL_ROOT
    else process.env.LIVEKIT_AGENT_INSTALL_ROOT = originalSidecarRoot
    if (originalServerRoot === undefined) delete process.env.LIVEKIT_SERVER_INSTALL_ROOT
    else process.env.LIVEKIT_SERVER_INSTALL_ROOT = originalServerRoot
    if (originalSourceRoot === undefined) delete process.env.LIVEKIT_AGENT_SOURCE_ROOT
    else process.env.LIVEKIT_AGENT_SOURCE_ROOT = originalSourceRoot
    await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('fingerprints the exact bundled LiveKit Agents source package', async () => {
    await expect(getBundledLiveKitSidecarMetadata()).resolves.toMatchObject({
      version: '1.6.3',
      sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('marks an installed sidecar stale until its manifest matches the bundled fingerprint', async () => {
    const sidecarRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-install-'))
    fixtureRoots.push(sidecarRoot)
    const serverRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-server-'))
    fixtureRoots.push(serverRoot)
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

  // BL-1296: the LiveKit server's install folder is shared by every Batshit on this computer, so
  // the process listening on the port can be another Batshit's. A restart (after an update)
  // stops it only when this Batshit alone started it. A real listener stands in for the server.
  describe('force restart stops only a LiveKit server this Batshit alone started (BL-1296)', () => {
    const originalStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    const originalPath = process.env.PATH
    let stateRoot: string
    let serverRoot: string
    let listener: ChildProcess | null = null
    let port = 0

    beforeEach(async () => {
      stateRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-records-'))
      serverRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-server-'))
      fixtureRoots.push(stateRoot, serverRoot)
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
      process.env.LIVEKIT_SERVER_INSTALL_ROOT = serverRoot
      // The port owner comes from `lsof`, which lives in /usr/sbin on macOS.
      process.env.PATH = `${originalPath ?? ''}${path.delimiter}/usr/sbin`
      listener = spawn(
        process.execPath,
        ['-e', "const s = require('http').createServer((q, r) => r.end('OK')).listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port)))"],
        // Detached, as a launch is: it leads its own process group, which the reuse guard reads.
        { stdio: ['ignore', 'pipe', 'ignore'], detached: true }
      )
      port = await new Promise<number>((resolve) => listener?.stdout?.once('data', (chunk) => resolve(Number(String(chunk)))))
    })

    afterEach(() => {
      if (originalStateRoot === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
      else process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalStateRoot
      process.env.PATH = originalPath
      try {
        if (listener?.pid) process.kill(-listener.pid, 'SIGKILL')
      } catch {}
      listener = null
    })

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    async function recordLaunch(registry: string | null) {
      const dir = path.join(stateRoot, 'livekit-server')
      await mkdir(dir, { recursive: true })
      const contents = JSON.stringify({
        engineId: 'livekit-server',
        pid: listener?.pid,
        command: path.join(serverRoot, 'livekit-server'),
        launchedAt: new Date().toISOString(),
        ...(registry ? { registry } : {})
      })
      await writeFile(path.join(dir, '.batshit-local-runtime-launch.json'), contents)
      return contents
    }

    const restart = () =>
      startNativeLiveKitServerRuntime({ userId: 'user-1', serverUrl: `ws://127.0.0.1:${port}`, apiKey: 'k', apiSecret: 's', forceRestart: true })

    it("another Batshit's server is refused visibly, keeps running, and its record keeps its bytes", async () => {
      const contents = await recordLaunch('redis-0000000000000000')

      await expect(restart()).rejects.toThrow(/did not restart the LiveKit server on port \d+: another Batshit on this computer, or another engine, also uses it/)
      expect(alive(listener?.pid as number)).toBe(true)
      expect(await readFile(path.join(stateRoot, 'livekit-server', '.batshit-local-runtime-launch.json'), 'utf8')).toBe(contents)
    })

    it('a server whose record has no registry (owner unknown) is refused too', async () => {
      await recordLaunch(null)

      await expect(restart()).rejects.toThrow(/another Batshit on this computer, or another engine, also uses it/)
      expect(alive(listener?.pid as number)).toBe(true)
    })

    it('a server no record names is still "not started by Batshit"', async () => {
      await expect(restart()).rejects.toThrow(/but Batshit did not start that process/)
      expect(alive(listener?.pid as number)).toBe(true)
    })

    it('its own record naming a command outside the managed LiveKit folder is still refused', async () => {
      const dir = path.join(stateRoot, 'livekit-server')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.batshit-local-runtime-launch.json'),
        JSON.stringify({ engineId: 'livekit-server', pid: listener?.pid, command: '/usr/local/bin/livekit-server', launchedAt: new Date().toISOString(), registry: await resolveVoiceRuntimeRegistryIdentity() })
      )

      await expect(restart()).rejects.toThrow(/but Batshit did not start that process/)
      expect(alive(listener?.pid as number)).toBe(true)
    })

    it('its own server is stopped for the restart, as before', async () => {
      await recordLaunch(await resolveVoiceRuntimeRegistryIdentity())
      const exited = new Promise((resolve) => listener?.once('exit', resolve))

      // Stopped, then the restart goes on to the install check (nothing is installed here).
      await expect(restart()).rejects.toThrow('Native LiveKit server is not installed yet.')
      await exited
      expect(alive(listener?.pid as number)).toBe(false)
    })
  })

  describe('the server keys go in its environment, never on its command line (BL-1332)', () => {
    let server: Server | null = null

    afterEach(async () => {
      if (server) await new Promise((resolve) => server?.close(resolve))
      server = null
    })

    it('launches with LIVEKIT_KEYS in its environment, no key in its args, and without an inherited LIVEKIT_CONFIG', async () => {
      const serverRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-server-'))
      fixtureRoots.push(serverRoot)
      process.env.LIVEKIT_SERVER_INSTALL_ROOT = serverRoot
      // Installed, as the status reads it: a file of that name. Nothing runs it as a server; its
      // version probe fails and reads as unknown.
      await writeFile(path.join(serverRoot, 'livekit-server'), '')
      // A port this test holds from the start: not ready until the (mocked) launch, then ready, as a
      // started server answers.
      let launched = false
      server = createServer((_request, response) => {
        response.statusCode = launched ? 200 : 503
        response.end(launched ? 'OK' : '')
      })
      const port = await new Promise<number>((resolve) =>
        server?.listen(0, '127.0.0.1', () => resolve((server?.address() as AddressInfo).port))
      )
      const launch = vi.mocked(startLocalVoiceRuntime)
      launch.mockReset()
      launch.mockImplementation(async () => {
        launched = true
        return { pid: 4242, logPath: '/tmp/livekit-server.log' } as never
      })
      const secret = 'a-secret-never-on-the-command-line'

      await expect(
        startNativeLiveKitServerRuntime({ userId: 'user-1', serverUrl: `ws://127.0.0.1:${port}`, apiKey: 'devkey', apiSecret: secret })
      ).resolves.toMatchObject({ started: true, alreadyRunning: false })

      expect(launch).toHaveBeenCalledOnce()
      const spec = launch.mock.calls[0][0]
      expect(spec.engineId).toBe('livekit-server')
      expect(spec.launch.args).not.toContain('--keys')
      expect(JSON.stringify(spec.launch.args)).not.toContain(secret)
      expect(spec.launch.env).toEqual({ LIVEKIT_KEYS: `devkey: ${secret}` })
      expect(spec.launch.unsetEnv).toEqual(expect.arrayContaining(['LIVEKIT_CONFIG', 'REDIS_URL', 'REDIS_PASSWORD']))
    })
  })
})
