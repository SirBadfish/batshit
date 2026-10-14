import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ default: { spawn: spawnMock }, spawn: spawnMock }))

import {
  CLOUDFLARED_ASSETS,
  getCloudflaredRuntimeStatus,
  installCloudflaredRuntime,
  uninstallCloudflaredRuntime,
  type CloudflaredInstallPlatform
} from '../cloudflaredRuntime'

class ProbeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

const archiveBytes = Buffer.from('verified test archive, no network or production runtime')
const extractedBytes = Buffer.from('isolated staged executable')
const fixtureChecksum = createHash('sha256').update(archiveBytes).digest('hex')
const originalChecksum = CLOUDFLARED_ASSETS['darwin-arm64'].sha256
const rawPlatforms = ['linux-x64', 'windows-x64'] as const
const originalRawChecksums = rawPlatforms.map((platform) => CLOUDFLARED_ASSETS[platform].sha256)
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
const mutableAsset = CLOUDFLARED_ASSETS['darwin-arm64'] as { sha256: string }
let root: string
let installDir: string
let stagedFailure: NodeJS.ErrnoException | null
let stagedVersion: string
let stagedExit: number

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-cloudflared-install-proof-'))
  installDir = path.join(root, 'cloudflared')
  await fs.mkdir(installDir)
  await fs.writeFile(path.join(installDir, 'cloudflared'), 'prior executable')
  await fs.writeFile(path.join(installDir, 'manifest.json'), '{"binaryName":"cloudflared","platform":"darwin-x64","assetName":"prior.tgz"}')
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', 'native')
  vi.stubEnv('BATSHIT_CLOUDFLARED_BIN', '')
  vi.stubEnv('BATSHIT_CLOUDFLARED_DIR', installDir)
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...archDescriptor, value: 'arm64' })
  mutableAsset.sha256 = fixtureChecksum
  stagedFailure = null
  stagedVersion = 'cloudflared version 2026.3.0 (built fixture)'
  stagedExit = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response(archiveBytes)))
  spawnMock.mockReset()
  spawnMock.mockImplementation((command: string, args: string[]) => {
    if (command === 'cloudflared') {
      throw Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' })
    }
    const staged = command.startsWith(`${installDir}.tmp-`)
    if (staged && stagedFailure) throw stagedFailure
    const child = new ProbeChild()
    setImmediate(async () => {
      if (command === 'tar') {
        await fs.writeFile(path.join(args[3], 'cloudflared'), extractedBytes)
        child.emit('close', 0, null)
      } else {
        child.stdout.emit('data', staged ? stagedVersion : 'cloudflared version 2026.3.0')
        if (staged && stagedExit !== 0) child.stderr.emit('data', 'executable refused')
        child.emit('close', staged ? stagedExit : 0, null)
      }
    })
    return child
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  mutableAsset.sha256 = originalChecksum
  rawPlatforms.forEach((platform, index) => {
    const mutableRawAsset = CLOUDFLARED_ASSETS[platform] as { sha256: string }
    mutableRawAsset.sha256 = originalRawChecksums[index]
  })
  Object.defineProperty(process, 'platform', platformDescriptor)
  Object.defineProperty(process, 'arch', archDescriptor)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

// Real temporary filesystem, mocked platform and process responses. These cases
// prove installer paths and recovery, not Linux/Windows executable compatibility.
describe.each(rawPlatforms)('Cloudflared raw installer: %s', (platform) => {
  const asset = CLOUDFLARED_ASSETS[platform]
  let priorManifest: string

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform === 'linux-x64' ? 'linux' : 'win32' })
    Object.defineProperty(process, 'arch', { ...archDescriptor, value: 'x64' })
    const mutableRawAsset = asset as { sha256: string }
    mutableRawAsset.sha256 = fixtureChecksum
    await fs.rm(path.join(installDir, 'cloudflared'))
    await fs.writeFile(path.join(installDir, asset.binaryName), 'prior raw executable')
    priorManifest = JSON.stringify({ binaryName: asset.binaryName, platform, assetName: 'prior raw asset' })
    await fs.writeFile(path.join(installDir, 'manifest.json'), priorManifest)
  })

  async function expectPriorRawInstallRetained() {
    expect(await fs.readFile(path.join(installDir, asset.binaryName), 'utf8')).toBe('prior raw executable')
    expect(await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8')).toBe(priorManifest)
    expect(await fs.readdir(root)).toEqual(['cloudflared'])
  }

  it('publishes verified raw bytes under the executable basename, retaining release provenance', async () => {
    const chmod = vi.spyOn(fs, 'chmod')
    const status = await installCloudflaredRuntime(platform)
    expect(fetch).toHaveBeenCalledWith(`https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/${asset.assetName}`)
    expect(status).toMatchObject({ installed: true, installScope: 'batshit-managed', version: '2026.3.0', defaultPlatform: platform })
    expect(await fs.readFile(path.join(installDir, asset.binaryName))).toEqual(archiveBytes)
    expect((await fs.readdir(installDir)).sort()).toEqual([asset.binaryName, 'manifest.json'].sort())
    expect(JSON.parse(await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8'))).toMatchObject({
      platform, assetName: asset.assetName, binaryName: asset.binaryName, checksum: fixtureChecksum,
      checksumVerified: true, version: '2026.3.0', releaseTag: '2026.3.0',
      downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/${asset.assetName}`
    })
    const stagedProbe = spawnMock.mock.calls.find(([command]) => String(command).startsWith(`${installDir}.tmp-`))!
    expect(path.basename(stagedProbe[0])).toBe(asset.binaryName)
    expect(stagedProbe[1]).toEqual(['--version'])
    expect(spawnMock.mock.calls.some(([command]) => command === 'tar')).toBe(false)
    if (platform === 'linux-x64') {
      expect(chmod).toHaveBeenCalledWith(stagedProbe[0], 0o755)
      expect((await fs.stat(path.join(installDir, asset.binaryName))).mode & 0o777).toBe(0o755)
    } else {
      expect(chmod).not.toHaveBeenCalled()
    }
    expect(await fs.readdir(root)).toEqual(['cloudflared'])
  })

  it('rejects unverified raw bytes before any staging file write or publication', async () => {
    const write = vi.spyOn(fs, 'writeFile')
    const rename = vi.spyOn(fs, 'rename')
    vi.mocked(fetch).mockResolvedValueOnce(new Response('corrupt raw bytes'))
    const status = await installCloudflaredRuntime(platform)
    expect(status).toMatchObject({ installed: false })
    expect(status.reason).toContain(`checksum mismatch for ${asset.assetName}`)
    expect(write).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(spawnMock.mock.calls.some(([command]) => String(command).startsWith(`${installDir}.tmp-`))).toBe(false)
    await expectPriorRawInstallRetained()
  })

  it.each([
    { output: 'cloudflared version 2026.3.0', exit: 1, reason: 'executable refused' },
    { output: 'cloudflared version 2026.2.0', exit: 0, reason: 'expected version 2026.3.0' },
    { output: 'unrecognized output', exit: 0, reason: 'unrecognized version output' }
  ])('rejects raw staged verification: $reason', async ({ output, exit, reason }) => {
    const rename = vi.spyOn(fs, 'rename')
    stagedVersion = output
    stagedExit = exit
    await expect(installCloudflaredRuntime(platform)).rejects.toThrow(reason)
    expect(rename).not.toHaveBeenCalled()
    await expectPriorRawInstallRetained()
  })

  it('preserves the raw prior copy when the staged executable cannot launch', async () => {
    stagedFailure = Object.assign(new Error('synthetic executable format failure'), { code: 'ENOEXEC' })
    await expect(installCloudflaredRuntime(platform)).rejects.toThrow('synthetic executable format failure')
    await expectPriorRawInstallRetained()
  })

  it('restores the raw prior executable and manifest when publication fails', async () => {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(source).startsWith(`${installDir}.tmp-`)) throw new Error('Synthetic raw publish failure')
      await rename(source, destination)
    })
    await expect(installCloudflaredRuntime(platform)).rejects.toThrow('The previous installation was restored')
    await expectPriorRawInstallRetained()
  })

  it('retains raw recovery copies and refuses further mutation when rollback also fails', async () => {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(source).startsWith(`${installDir}.tmp-`)) throw new Error('Synthetic raw publish failure')
      if (String(source) === `${installDir}.previous`) throw new Error('Synthetic raw rollback failure')
      await rename(source, destination)
    })
    await expect(installCloudflaredRuntime(platform)).rejects.toThrow('verified replacement retained at')
    expect(await fs.readFile(path.join(`${installDir}.previous`, asset.binaryName), 'utf8')).toBe('prior raw executable')
    expect(await fs.readFile(path.join(`${installDir}.previous`, 'manifest.json'), 'utf8')).toBe(priorManifest)
    const staging = (await fs.readdir(root)).find((entry) => entry.startsWith('cloudflared.tmp-'))!
    expect(await fs.readFile(path.join(root, staging, asset.binaryName))).toEqual(archiveBytes)
    await expect(installCloudflaredRuntime(platform)).rejects.toThrow('recovery is required')
    await expect(uninstallCloudflaredRuntime()).rejects.toThrow('recovery is required')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bypasses native staging, download and process probing in Docker', async () => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
    vi.stubEnv('BATSHIT_RUNTIME_ENV', 'docker')
    vi.stubEnv('BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH', path.join(root, 'absent-sidecar-status.json'))
    const status = await installCloudflaredRuntime(platform)
    expect(status).toMatchObject({ supportLevel: 'docker-sidecar', installScope: 'docker-sidecar', managedInstallPresent: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    await expectPriorRawInstallRetained()
  })
})

async function expectPriorInstallRetained() {
  expect(await fs.readFile(path.join(installDir, 'cloudflared'), 'utf8')).toBe('prior executable')
  expect(JSON.parse(await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8')).platform).toBe('darwin-x64')
  expect(await fs.readdir(root)).toEqual(['cloudflared'])
}

describe('Cloudflared native installer admission and verification', () => {
  it('keeps a managed wrong-architecture error visible after the missing PATH candidate', async () => {
    spawnMock.mockImplementation((command: string) => {
      if (command === 'cloudflared') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      throw Object.assign(new Error('spawn Unknown system error -86'), { errno: -86, code: 'Unknown system error -86' })
    })
    const status = await getCloudflaredRuntimeStatus()
    expect(status).toMatchObject({ installed: false, managedInstallPresent: true, defaultPlatform: 'darwin-arm64' })
    expect(status.reason).toContain('wrong CPU architecture')
    expect(status.reason).toContain('macOS (Apple Silicon/arm64)')
    expect(status.reason).not.toContain('Command not found')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('extracts and verifies the selected official arm64 asset before publishing its manifest', async () => {
    const status = await installCloudflaredRuntime('darwin-arm64')
    expect(fetch).toHaveBeenCalledWith('https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-darwin-arm64.tgz')
    expect(spawnMock).toHaveBeenCalledWith('tar', expect.arrayContaining(['-xzf']), expect.any(Object))
    expect(status).toMatchObject({ installed: true, installScope: 'batshit-managed', version: '2026.3.0', defaultPlatform: 'darwin-arm64' })
    expect(await fs.readFile(path.join(installDir, 'cloudflared'))).toEqual(extractedBytes)
    expect(JSON.parse(await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8'))).toMatchObject({
      platform: 'darwin-arm64', assetName: 'cloudflared-darwin-arm64.tgz', version: '2026.3.0', checksumVerified: true, checksum: fixtureChecksum
    })
    expect(await fs.readdir(root)).toEqual(['cloudflared'])
  })

  it('refuses a checksum mismatch before extraction and preserves the prior installation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('unverified bytes'))
    const status = await installCloudflaredRuntime('darwin-arm64')
    expect(status.installed).toBe(false)
    expect(status.reason).toContain('checksum mismatch')
    expect(spawnMock.mock.calls.some(([command]) => command === 'tar')).toBe(false)
    await expectPriorInstallRetained()
  })

  it('refuses a staged executable with macOS EBADARCH before replacing existing files', async () => {
    stagedFailure = Object.assign(new Error('spawn Unknown system error -86'), { errno: -86, code: 'Unknown system error -86' })
    await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow('wrong CPU architecture')
    await expectPriorInstallRetained()
  })

  it('preserves existing files when moving the prior installation fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic prior-move failure'))
    await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow('Synthetic prior-move failure')
    await expectPriorInstallRetained()
  })

  it('restores the prior executable and manifest if publishing staging fails', async () => {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(source).startsWith(`${installDir}.tmp-`)) throw new Error('Synthetic publish failure')
      await rename(source, destination)
    })
    await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow('The previous installation was restored')
    await expectPriorInstallRetained()
  })

  it('retains both copies and blocks later mutation if publication and rollback fail', async () => {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(source).startsWith(`${installDir}.tmp-`)) throw new Error('Synthetic publish failure')
      if (String(source) === `${installDir}.previous`) throw new Error('Synthetic rollback failure')
      await rename(source, destination)
    })
    await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow('verified replacement retained at')
    expect(await fs.readFile(path.join(`${installDir}.previous`, 'cloudflared'), 'utf8')).toBe('prior executable')
    expect(JSON.parse(await fs.readFile(path.join(`${installDir}.previous`, 'manifest.json'), 'utf8')).platform).toBe('darwin-x64')
    const staging = (await fs.readdir(root)).find((entry) => entry.startsWith('cloudflared.tmp-'))!
    expect(await fs.readFile(path.join(root, staging, 'cloudflared'))).toEqual(extractedBytes)
    await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow('recovery is required')
    await expect(uninstallCloudflaredRuntime()).rejects.toThrow('recovery is required')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses concurrent install/removal while another install holds the same root', async () => {
    let release!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const installation = installCloudflaredRuntime('darwin-arm64')
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow('already in progress')
      await expect(uninstallCloudflaredRuntime()).rejects.toThrow('already in progress')
      expect((await getCloudflaredRuntimeStatus()).installed).toBe(true)
    } finally {
      release(new Response(archiveBytes))
      await installation
    }
    await expect(installCloudflaredRuntime('darwin-arm64')).resolves.toMatchObject({ installed: true })
  })

  it.each([
    { output: 'cloudflared version 2026.3.0', exit: 1, reason: 'executable refused' },
    { output: 'cloudflared version 2026.2.0', exit: 0, reason: 'expected version 2026.3.0' },
    { output: 'unrecognized output', exit: 0, reason: 'unrecognized version output' }
  ])('refuses failed/mismatched staged verification: $reason', async ({ output, exit, reason }) => {
    stagedVersion = output
    stagedExit = exit
    await expect(installCloudflaredRuntime('darwin-arm64')).rejects.toThrow(reason)
    await expectPriorInstallRetained()
  })

  it.each(['__proto__', 'constructor', 'toString'])('refuses inherited platform key %s before staging/download', async (platform) => {
    const status = await installCloudflaredRuntime(platform as CloudflaredInstallPlatform)
    expect(status.reason).toBe('Invalid cloudflared install platform.')
    expect(fetch).not.toHaveBeenCalled()
    await expectPriorInstallRetained()
  })
})
