import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  buildManagedCliRegistryMetadataUrl,
  classifyLinuxLibcEvidence,
  getManagedCliExecutableSync,
  getManagedCliInstallStatus,
  getManagedCliOperationStatus,
  installManagedCli,
  isManagedCliRuntimeId,
  MANAGED_CLI_PINNED_VERSIONS,
  ManagedCliOperationInProgressError,
  resolveManagedCliRoot,
  resolveManagedCliShimPath,
  resolveManagedCliTarget,
  resolveManagedCliVersionRoot,
  uninstallManagedCli,
  verifySha512Integrity
} from '../managedCliInstaller'

const execFileAsync = promisify(execFile)
const platformInstallIt = process.platform === 'win32' ? it.skip : it

let installsRoot: string
let previousInstallsRoot: string | undefined

beforeEach(async () => {
  installsRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-cli-installer-'))
  previousInstallsRoot = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
  process.env.BATSHIT_MANAGED_INSTALLS_ROOT = installsRoot
})

afterEach(async () => {
  if (previousInstallsRoot === undefined) {
    delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
  } else {
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = previousInstallsRoot
  }
  vi.unstubAllGlobals()
  await rm(installsRoot, { recursive: true, force: true })
})

describe('resolveManagedCliTarget', () => {
  it('pins the tested current model runtimes exactly', () => {
    expect(MANAGED_CLI_PINNED_VERSIONS).toEqual({ claude: '2.1.296' })
  })

  it('SA-139 R1: knows only Claude Code as a managed runtime; the removed Codex CLI is none', () => {
    expect(isManagedCliRuntimeId('claude')).toBe(true)
    expect(isManagedCliRuntimeId('codex')).toBe(false)
    expect(Object.keys(MANAGED_CLI_PINNED_VERSIONS)).toEqual(['claude'])
  })

  it('maps claude platform keys onto real per-platform packages with musl variants', () => {
    const version = MANAGED_CLI_PINNED_VERSIONS.claude

    const darwinArm = resolveManagedCliTarget('claude', { platform: 'darwin', arch: 'arm64' })
    expect(darwinArm.packageName).toBe('@anthropic-ai/claude-code-darwin-arm64')
    expect(darwinArm.packageVersion).toBe(version)
    expect(darwinArm.executableRelativePath).toBe(path.join('package', 'claude'))

    const muslLinux = resolveManagedCliTarget('claude', {
      platform: 'linux',
      arch: 'x64',
      libc: 'musl'
    })
    expect(muslLinux.packageName).toBe('@anthropic-ai/claude-code-linux-x64-musl')

    const glibcLinux = resolveManagedCliTarget('claude', {
      platform: 'linux',
      arch: 'arm64',
      libc: 'glibc'
    })
    expect(glibcLinux.packageName).toBe('@anthropic-ai/claude-code-linux-arm64')
  })

  it('fails loudly for unsupported platforms', () => {
    expect(() => resolveManagedCliTarget('claude', { platform: 'win32', arch: 'x64' })).toThrow(
      /macOS and Linux only/
    )
    expect(() =>
      resolveManagedCliTarget('claude', { platform: 'linux', arch: 'ia32' as any })
    ).toThrow(/arm64 and x64 only/)
  })

  it('requires positive Linux libc evidence for Claude package selection', () => {
    expect(
      classifyLinuxLibcEvidence({ glibcVersionRuntime: '2.36', sharedObjects: [] }),
    ).toBe('glibc')
    expect(
      classifyLinuxLibcEvidence({ sharedObjects: ['/lib/ld-musl-x86_64.so.1'] }),
    ).toBe('musl')
    expect(classifyLinuxLibcEvidence({ sharedObjects: [] })).toBe('unknown')
    expect(
      classifyLinuxLibcEvidence({
        glibcVersionRuntime: '2.36',
        sharedObjects: ['/lib/ld-musl-x86_64.so.1'],
      }),
    ).toBe('unknown')
    expect(() =>
      resolveManagedCliTarget('claude', { platform: 'linux', arch: 'x64', libc: 'unknown' }),
    ).toThrow(/could not positively identify/)
  })

  it('builds version-specific registry metadata URLs', () => {
    const target = resolveManagedCliTarget('claude', { platform: 'darwin', arch: 'arm64' })
    expect(buildManagedCliRegistryMetadataUrl(target)).toBe(
      `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/${MANAGED_CLI_PINNED_VERSIONS.claude}`
    )
  })
})

describe('verifySha512Integrity', () => {
  it('accepts matching sha512 integrity values', () => {
    const data = Buffer.from('batshit')
    const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`
    expect(() => verifySha512Integrity(data, integrity)).not.toThrow()
  })

  it('throws on integrity mismatch', () => {
    expect(() => verifySha512Integrity(Buffer.from('batshit'), 'sha512-AAAA')).toThrow(
      /integrity verification/
    )
  })
})

async function buildFixtureTarball(params: {
  executableRelativePath: string
  versionOutput: string
}): Promise<Buffer> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-cli-fixture-'))
  try {
    const executablePath = path.join(fixtureRoot, params.executableRelativePath)
    await mkdir(path.dirname(executablePath), { recursive: true })
    await writeFile(executablePath, `#!/bin/sh\necho "${params.versionOutput}"\n`)
    await chmod(executablePath, 0o755)

    const archivePath = path.join(fixtureRoot, 'fixture.tgz')
    await execFileAsync('tar', ['-czf', archivePath, '-C', fixtureRoot, 'package'])
    return await readFile(archivePath)
  } finally {
    // The archive bytes are already in memory; the staging dir can go.
    setTimeout(() => {
      void rm(fixtureRoot, { recursive: true, force: true })
    }, 0)
  }
}

function stubRegistryFetch(params: {
  metadataUrl: string
  tarballUrl: string
  tarball: Buffer
  integrity: string
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url
      if (url === params.metadataUrl) {
        return new Response(
          JSON.stringify({ dist: { tarball: params.tarballUrl, integrity: params.integrity } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url === params.tarballUrl) {
        return new Response(new Uint8Array(params.tarball), { status: 200 })
      }
      throw new Error(`Unexpected fetch in test: ${url}`)
    })
  )
}

describe('installManagedCli', () => {
  it('resolves a stale Docker root manifest through the active managed install root', async () => {
    const version = MANAGED_CLI_PINNED_VERSIONS.claude
    const versionRoot = path.join(installsRoot, 'cli', 'claude', version)
    const executablePath = path.join(versionRoot, 'package', 'claude')
    await mkdir(path.dirname(executablePath), { recursive: true })
    await writeFile(executablePath, '#!/bin/sh\necho claude-test\n')
    await chmod(executablePath, 0o755)
    await writeFile(
      path.join(versionRoot, 'batshit-managed-cli.json'),
      JSON.stringify(
        {
          runtime: 'claude',
          version,
          installRoot: `/root/.batshit/installs/cli/claude/${version}`,
          executablePath: `/root/.batshit/installs/cli/claude/${version}/package/claude`
        },
        null,
        2
      )
    )

    expect(getManagedCliExecutableSync('claude')?.executablePath).toBe(executablePath)
    await expect(getManagedCliInstallStatus('claude')).resolves.toMatchObject({
      installed: true,
      executablePath
    })
  })

  platformInstallIt('installs a verified claude tarball, exposes status/resolution, and uninstalls cleanly', async () => {
    const target = resolveManagedCliTarget('claude')
    const tarball = await buildFixtureTarball({
      executableRelativePath: target.executableRelativePath,
      versionOutput: `${MANAGED_CLI_PINNED_VERSIONS.claude} (Claude Code)`
    })
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const metadataUrl = buildManagedCliRegistryMetadataUrl(target)
    const tarballUrl = `https://registry.example/claude.tgz`
    stubRegistryFetch({ metadataUrl, tarballUrl, tarball, integrity })

    const result = await installManagedCli('claude')

    expect(result.installedVersion).toBe(MANAGED_CLI_PINNED_VERSIONS.claude)
    expect(result.executablePath).toContain(
      path.join(installsRoot, 'cli', 'claude', MANAGED_CLI_PINNED_VERSIONS.claude)
    )
    await expect(stat(result.executablePath)).resolves.toBeTruthy()

    const status = await getManagedCliInstallStatus('claude')
    expect(status.installed).toBe(true)
    expect(status.version).toBe(MANAGED_CLI_PINNED_VERSIONS.claude)
    expect(status.manifest?.checksumVerified).toBe(true)
    expect(status.manifest?.sourceUrl).toBe(tarballUrl)

    const managed = getManagedCliExecutableSync('claude')
    expect(managed?.executablePath).toBe(result.executablePath)

    const second = await installManagedCli('claude')
    expect(second.reused).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)

    // Stable shim symlink resolves to the versioned executable.
    const shim = resolveManagedCliShimPath('claude')
    const { stdout } = await execFileAsync(shim, [])
    expect(stdout).toContain('(Claude Code)')

    const afterUninstall = await uninstallManagedCli('claude')
    expect(afterUninstall.installed).toBe(false)
    expect(getManagedCliExecutableSync('claude')).toBeNull()
    await expect(stat(shim)).rejects.toThrow()
  })

  platformInstallIt('refuses to install when the download fails integrity verification', async () => {
    const target = resolveManagedCliTarget('claude')
    const tarball = await buildFixtureTarball({
      executableRelativePath: target.executableRelativePath,
      versionOutput: 'claude tampered'
    })
    const metadataUrl = buildManagedCliRegistryMetadataUrl(target)
    const tarballUrl = `https://registry.example/claude.tgz`
    stubRegistryFetch({
      metadataUrl,
      tarballUrl,
      tarball,
      integrity: `sha512-${createHash('sha512').update(Buffer.from('different bytes')).digest('base64')}`
    })

    await expect(installManagedCli('claude')).rejects.toThrow(/integrity verification/)
    expect(getManagedCliExecutableSync('claude')).toBeNull()
    expect((await getManagedCliInstallStatus('claude')).installed).toBe(false)
  })

  platformInstallIt('refuses to install when the registry metadata has no sha512 integrity', async () => {
    const target = resolveManagedCliTarget('claude')
    const metadataUrl = buildManagedCliRegistryMetadataUrl(target)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url
        if (url === metadataUrl) {
          return new Response(JSON.stringify({ dist: { tarball: 'https://x.example/t.tgz' } }), {
            status: 200
          })
        }
        throw new Error(`Unexpected fetch in test: ${url}`)
      })
    )

    await expect(installManagedCli('claude')).rejects.toThrow(/sha512 integrity/)
  })

  platformInstallIt('surfaces registry download failures clearly', async () => {
    const target = resolveManagedCliTarget('claude')
    const metadataUrl = buildManagedCliRegistryMetadataUrl(target)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url
        if (url === metadataUrl) {
          return new Response('not found', { status: 404 })
        }
        throw new Error(`Unexpected fetch in test: ${url}`)
      })
    )

    await expect(installManagedCli('claude')).rejects.toThrow(/HTTP 404/)
  })

  platformInstallIt('serializes install and uninstall through a filesystem operation lock', async () => {
    const target = resolveManagedCliTarget('claude')
    const tarball = await buildFixtureTarball({
      executableRelativePath: target.executableRelativePath,
      versionOutput: 'claude locked',
    })
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const metadataUrl = buildManagedCliRegistryMetadataUrl(target)
    const tarballUrl = 'https://registry.example/claude-lock.tgz'
    let releaseMetadata!: () => void
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url
        if (url === metadataUrl) {
          await metadataGate
          return new Response(
            JSON.stringify({ dist: { tarball: tarballUrl, integrity } }),
            { status: 200 },
          )
        }
        if (url === tarballUrl) return new Response(new Uint8Array(tarball), { status: 200 })
        throw new Error(`Unexpected fetch in test: ${url}`)
      }),
    )

    const first = installManagedCli('claude')
    await vi.waitFor(async () => {
      expect((await getManagedCliOperationStatus('claude'))?.phase).toBe('metadata')
    })
    await expect(installManagedCli('claude')).rejects.toBeInstanceOf(
      ManagedCliOperationInProgressError,
    )
    await expect(uninstallManagedCli('claude')).rejects.toBeInstanceOf(
      ManagedCliOperationInProgressError,
    )

    releaseMetadata()
    await expect(first).resolves.toMatchObject({ reused: false })
    await expect(getManagedCliOperationStatus('claude')).resolves.toBeNull()
  })
})
