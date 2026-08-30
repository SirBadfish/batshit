import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, createWriteStream, readdirSync, readFileSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { resolveManagedInstallsRoot } from '$lib/server/services/voiceLocalEngineSetup'

const execFileAsync = promisify(execFile)

/**
 * Batshit-managed CLI runtime installer.
 *
 * Batshit no longer bundles the Codex CLI binary inside its own builds, and it
 * never bundled Claude Code. This service gives users a one-click managed
 * install instead: it downloads the official pinned npm platform package,
 * verifies the registry sha512 integrity, extracts it under the managed
 * installs root (`~/.batshit/installs/cli/<runtime>/<version>/`), and exposes a
 * stable executable path that the CLI status resolvers pick up automatically.
 *
 * No silent fallbacks: failed downloads, integrity mismatches, unsupported
 * platforms, and broken extractions all throw with clear messages.
 */

export type ManagedCliRuntimeId = 'codex' | 'claude'

export const MANAGED_CLI_RUNTIME_IDS: ManagedCliRuntimeId[] = ['codex', 'claude']

/**
 * Pinned versions. Update deliberately (and re-verify the platform package
 * list) instead of floating to `latest`.
 */
export const MANAGED_CLI_PINNED_VERSIONS: Record<ManagedCliRuntimeId, string> = {
  codex: '0.141.0',
  claude: '2.1.185'
}

export const MANAGED_CLI_DISPLAY_NAMES: Record<ManagedCliRuntimeId, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code CLI'
}

const MANAGED_CLI_MANIFEST_FILE = 'batshit-managed-cli.json'
const REGISTRY_METADATA_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const VERSION_PROBE_TIMEOUT_MS = 20_000
const LEGACY_DOCKER_MANAGED_INSTALLS_ROOT = '/root/.batshit/installs'
const MANAGED_CLI_OPERATION_DIR = '.operations'

export type ManagedCliInstallManifest = {
  runtime: ManagedCliRuntimeId
  version: string
  installedAt: string
  installRoot: string
  packageName: string
  sourceUrl: string
  integrity: string
  checksumVerified: boolean
  executablePath: string
  versionOutput?: string
}

export type ManagedCliInstallStatus = {
  runtime: ManagedCliRuntimeId
  displayName: string
  supported: boolean
  unsupportedReason: string | null
  installed: boolean
  version: string | null
  pinnedVersion: string
  executablePath: string | null
  installRoot: string
  manifest: ManagedCliInstallManifest | null
  operation: ManagedCliOperationStatus | null
}

export type ManagedCliOperationKind = 'install' | 'reinstall' | 'uninstall'
export type ManagedCliOperationPhase =
  | 'starting'
  | 'metadata'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'validating'
  | 'activating'
  | 'cleaning-up'

export type ManagedCliOperationStatus = {
  runtime: ManagedCliRuntimeId
  operation: ManagedCliOperationKind
  phase: ManagedCliOperationPhase
  startedAt: string
}

type ManagedCliOperationRecord = ManagedCliOperationStatus & {
  ownerId: string
  pid: number
  hostname: string
}

export class ManagedCliOperationInProgressError extends Error {
  readonly code = 'CLI_RUNTIME_OPERATION_IN_PROGRESS'
  constructor(readonly operationStatus: ManagedCliOperationStatus) {
    super(
      `${MANAGED_CLI_DISPLAY_NAMES[operationStatus.runtime]} already has a ${operationStatus.operation} operation in progress (${operationStatus.phase}).`,
    )
    this.name = 'ManagedCliOperationInProgressError'
  }
}

export type ManagedCliTarget = {
  /** npm platform key, e.g. `darwin-arm64` or `linux-x64-musl`. */
  key: string
  /** Full npm package name to download. */
  packageName: string
  /** Exact published version string for that package. */
  packageVersion: string
  /** Path of the executable inside the extracted tarball (tarballs unpack into `package/`). */
  executableRelativePath: string
  /** Extra files that must be made executable (relative to the extracted tarball root). */
  additionalExecutableRelativePaths: string[]
}

export function isManagedCliRuntimeId(value: unknown): value is ManagedCliRuntimeId {
  return value === 'codex' || value === 'claude'
}

export function resolveManagedCliRoot(): string {
  return path.join(resolveManagedInstallsRoot(), 'cli')
}

export function resolveManagedCliRuntimeRoot(runtime: ManagedCliRuntimeId): string {
  return path.join(resolveManagedCliRoot(), runtime)
}

export function resolveManagedCliVersionRoot(runtime: ManagedCliRuntimeId, version: string): string {
  return path.join(resolveManagedCliRuntimeRoot(runtime), version)
}

/** Stable shim directory whose entries survive version bumps (used by Docker login commands). */
export function resolveManagedCliBinDir(): string {
  return path.join(resolveManagedCliRoot(), 'bin')
}

export function resolveManagedCliShimPath(runtime: ManagedCliRuntimeId): string {
  return path.join(resolveManagedCliBinDir(), runtime)
}

function resolveOperationPaths(runtime: ManagedCliRuntimeId, cliRoot = resolveManagedCliRoot()) {
  const operationsRoot = path.join(cliRoot, MANAGED_CLI_OPERATION_DIR)
  return {
    operationsRoot,
    lockPath: path.join(operationsRoot, `${runtime}.lock`),
    statusPath: path.join(operationsRoot, `${runtime}.status.json`),
  }
}

function operationRecordToStatus(record: ManagedCliOperationRecord): ManagedCliOperationStatus {
  return {
    runtime: record.runtime,
    operation: record.operation,
    phase: record.phase,
    startedAt: record.startedAt,
  }
}

async function readOperationRecord(filePath: string): Promise<ManagedCliOperationRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as ManagedCliOperationRecord
    if (
      !isManagedCliRuntimeId(parsed.runtime) ||
      !['install', 'reinstall', 'uninstall'].includes(parsed.operation) ||
      typeof parsed.ownerId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

async function writeOperationStatus(
  statusPath: string,
  record: ManagedCliOperationRecord,
): Promise<void> {
  const tempPath = `${statusPath}.tmp-${record.ownerId}`
  await writeFile(tempPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, statusPath)
}

export async function getManagedCliOperationStatus(
  runtime: ManagedCliRuntimeId,
  cliRoot = resolveManagedCliRoot(),
): Promise<ManagedCliOperationStatus | null> {
  const { lockPath, statusPath } = resolveOperationPaths(runtime, cliRoot)
  if (!(await stat(lockPath).catch(() => null))) return null
  const record = (await readOperationRecord(statusPath)) ?? (await readOperationRecord(lockPath))
  return record ? operationRecordToStatus(record) : {
    runtime,
    operation: 'install',
    phase: 'starting',
    startedAt: new Date(0).toISOString(),
  }
}

async function acquireManagedCliOperation(
  runtime: ManagedCliRuntimeId,
  operation: ManagedCliOperationKind,
  cliRoot: string,
): Promise<{
  update: (phase: ManagedCliOperationPhase) => Promise<void>
  release: () => Promise<void>
}> {
  const paths = resolveOperationPaths(runtime, cliRoot)
  await mkdir(paths.operationsRoot, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownerId = randomUUID()
    const record: ManagedCliOperationRecord = {
      runtime,
      operation,
      phase: 'starting',
      startedAt: new Date().toISOString(),
      ownerId,
      pid: process.pid,
      hostname: os.hostname(),
    }
    let acquired = false
    try {
      const handle = await open(paths.lockPath, 'wx', 0o600)
      acquired = true
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      await writeOperationStatus(paths.statusPath, record)

      return {
        update: async (phase) => {
          record.phase = phase
          await writeOperationStatus(paths.statusPath, record)
        },
        release: async () => {
          const current = await readOperationRecord(paths.lockPath)
          if (current?.ownerId !== ownerId) return
          await rm(paths.statusPath, { force: true })
          await rm(paths.lockPath, { force: true })
        },
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        if (acquired) {
          await rm(paths.statusPath, { force: true }).catch(() => undefined)
          await rm(paths.lockPath, { force: true }).catch(() => undefined)
        }
        throw error
      }
      const current = await readOperationRecord(paths.lockPath)
      if (
        attempt === 0 &&
        current?.hostname === os.hostname() &&
        !processIsAlive(current.pid)
      ) {
        await rm(paths.statusPath, { force: true })
        await rm(paths.lockPath, { force: true })
        continue
      }
      const currentStatus = await getManagedCliOperationStatus(runtime, cliRoot)
      throw new ManagedCliOperationInProgressError(
        currentStatus ?? {
          runtime,
          operation,
          phase: 'starting',
          startedAt: new Date(0).toISOString(),
        },
      )
    }
  }
  throw new Error(`Failed to acquire ${MANAGED_CLI_DISPLAY_NAMES[runtime]} operation lock.`)
}

export type LinuxLibc = 'glibc' | 'musl' | 'unknown'

export function classifyLinuxLibcEvidence(evidence: {
  glibcVersionRuntime?: unknown
  sharedObjects?: unknown
  lddOutput?: unknown
  alpineReleasePresent?: boolean
}): LinuxLibc {
  const glibc = typeof evidence.glibcVersionRuntime === 'string' && evidence.glibcVersionRuntime.trim()
  const sharedObjects = Array.isArray(evidence.sharedObjects)
    ? evidence.sharedObjects.filter((value): value is string => typeof value === 'string')
    : []
  const lddOutput = typeof evidence.lddOutput === 'string' ? evidence.lddOutput : ''
  const musl =
    evidence.alpineReleasePresent === true ||
    sharedObjects.some((value) => /(?:^|[/_-])(?:ld-)?musl(?:[-_.]|$)/i.test(value)) ||
    /\bmusl\b/i.test(lddOutput)
  const gnu = Boolean(glibc) || /\bglibc\b|GNU C Library|GNU libc/i.test(lddOutput)

  if (musl && gnu) return 'unknown'
  if (musl) return 'musl'
  if (gnu) return 'glibc'
  return 'unknown'
}

export function detectLinuxLibc(): LinuxLibc {
  if (process.platform !== 'linux') return 'unknown'
  let report: any = null
  try {
    report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null
  } catch {
    report = null
  }
  const ldd = spawnSync('ldd', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  })
  let alpineReleasePresent = false
  try {
    accessSync('/etc/alpine-release', constants.F_OK)
    alpineReleasePresent = true
  } catch {
    // Non-Alpine hosts are expected to lack this marker.
  }
  return classifyLinuxLibcEvidence({
    glibcVersionRuntime: report?.header?.glibcVersionRuntime,
    sharedObjects: report?.sharedObjects,
    lddOutput: `${ldd.stdout ?? ''}\n${ldd.stderr ?? ''}`,
    alpineReleasePresent,
  })
}

/**
 * Maps the current (or provided) platform/arch onto the pinned npm platform
 * package for a runtime. Throws for unsupported combinations.
 */
export function resolveManagedCliTarget(
  runtime: ManagedCliRuntimeId,
  options: {
    platform?: NodeJS.Platform
    arch?: string
    libc?: LinuxLibc
  } = {}
): ManagedCliTarget {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const version = MANAGED_CLI_PINNED_VERSIONS[runtime]

  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(
      `${MANAGED_CLI_DISPLAY_NAMES[runtime]} managed install supports macOS and Linux only (detected ${platform}).`
    )
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(
      `${MANAGED_CLI_DISPLAY_NAMES[runtime]} managed install supports arm64 and x64 only (detected ${arch}).`
    )
  }

  if (runtime === 'codex') {
    // Codex publishes platform builds as npm alias versions of @openai/codex
    // (e.g. 0.141.0-darwin-arm64). The Linux builds are musl-static, so the
    // same package works on glibc and musl distros.
    //
    // Layout note (verified against the live 0.141.0 tarballs): the binary
    // lives at `package/vendor/<triple>/bin/codex`, with helper executables at
    // `codex-path/rg`, `codex-resources/zsh/bin/zsh`, and Linux `bwrap`. Older versions
    // (≤0.130.x) used `codex/codex` + `path/rg` — re-verify on any pin bump.
    const key = `${platform}-${arch}`
    const tripleByKey: Record<string, string> = {
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
      'linux-arm64': 'aarch64-unknown-linux-musl',
      'linux-x64': 'x86_64-unknown-linux-musl'
    }
    const triple = tripleByKey[key]
    if (!triple) {
      throw new Error(`Codex CLI managed install has no build for ${key}.`)
    }
    return {
      key,
      packageName: '@openai/codex',
      packageVersion: `${version}-${key}`,
      executableRelativePath: path.join('package', 'vendor', triple, 'bin', 'codex'),
      additionalExecutableRelativePaths: [
        path.join('package', 'vendor', triple, 'codex-path', 'rg'),
        ...(platform === 'linux'
          ? [path.join('package', 'vendor', triple, 'codex-resources', 'bwrap')]
          : []),
        path.join('package', 'vendor', triple, 'codex-resources', 'zsh', 'bin', 'zsh')
      ]
    }
  }

  // Claude Code publishes real per-platform packages containing a native
  // `claude` binary at the package root. Linux needs the musl variants on
  // musl-based distros such as Alpine. Batshit's current Docker image is
  // Debian/glibc, but the public installer supports both libc families.
  let libc = options.libc
  if (platform === 'linux') {
    libc ??= detectLinuxLibc()
    if (libc === 'unknown') {
      throw new Error(
        'Claude Code managed install could not positively identify this Linux host as glibc or musl. Set up a supported libc runtime instead of installing a guessed binary.',
      )
    }
  }
  const key = platform === 'linux' ? `linux-${arch}${libc === 'musl' ? '-musl' : ''}` : `${platform}-${arch}`
  return {
    key,
    packageName: `@anthropic-ai/claude-code-${key}`,
    packageVersion: version,
    executableRelativePath: path.join('package', 'claude'),
    additionalExecutableRelativePaths: []
  }
}

export function buildManagedCliRegistryMetadataUrl(target: ManagedCliTarget): string {
  return `https://registry.npmjs.org/${target.packageName}/${target.packageVersion}`
}

type RegistryVersionMetadata = {
  dist?: {
    tarball?: string
    integrity?: string
  }
}

async function fetchRegistryMetadata(target: ManagedCliTarget): Promise<{
  tarballUrl: string
  integrity: string
}> {
  const url = buildManagedCliRegistryMetadataUrl(target)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REGISTRY_METADATA_TIMEOUT_MS)

  let metadata: RegistryVersionMetadata
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status} for ${url}.`)
    }
    metadata = (await response.json()) as RegistryVersionMetadata
  } finally {
    clearTimeout(timeout)
  }

  const tarballUrl = metadata.dist?.tarball?.trim()
  const integrity = metadata.dist?.integrity?.trim()
  if (!tarballUrl) {
    throw new Error(`npm registry metadata for ${target.packageName}@${target.packageVersion} has no tarball URL.`)
  }
  if (!integrity || !integrity.startsWith('sha512-')) {
    throw new Error(
      `npm registry metadata for ${target.packageName}@${target.packageVersion} has no sha512 integrity value.`
    )
  }

  return { tarballUrl, integrity }
}

async function downloadTarball(url: string, destination: string, integrity: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status} for ${url}.`)
    }
    if (!response.body) {
      throw new Error(`Download returned no response body for ${url}.`)
    }
    const hash = createHash('sha512')
    const hashingStream = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as any),
      hashingStream,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    )
    const expected = integrity.replace(/^sha512-/, '').trim()
    const actual = hash.digest('base64')
    if (actual !== expected) {
      throw new Error(
        `Downloaded file failed sha512 integrity verification (expected ${expected}, got ${actual}). The download may be corrupted or tampered with — nothing was installed.`,
      )
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function verifySha512Integrity(data: Buffer, integrity: string): void {
  const expected = integrity.replace(/^sha512-/, '').trim()
  const actual = createHash('sha512').update(data).digest('base64')
  if (actual !== expected) {
    throw new Error(
      `Downloaded file failed sha512 integrity verification (expected ${expected}, got ${actual}). The download may be corrupted or tampered with — nothing was installed.`
    )
  }
}

async function extractTarGz(archivePath: string, destination: string): Promise<void> {
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destination], { timeout: 300_000 })
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function executableExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function readManifest(versionRoot: string): Promise<ManagedCliInstallManifest | null> {
  try {
    const raw = await readFile(path.join(versionRoot, MANAGED_CLI_MANIFEST_FILE), 'utf8')
    return JSON.parse(raw) as ManagedCliInstallManifest
  } catch {
    return null
  }
}

function resolveManifestExecutableCandidate(
  runtime: ManagedCliRuntimeId,
  versionRoot: string,
  manifest: ManagedCliInstallManifest
): string {
  try {
    const target = resolveManagedCliTarget(runtime)
    return path.join(versionRoot, target.executableRelativePath)
  } catch {
    return manifest.executablePath
  }
}

function remapLegacyDockerManagedInstallPath(filePath: string | undefined): string | null {
  if (!filePath) return null

  const normalized = filePath.replace(/\\/g, '/')
  if (
    normalized !== LEGACY_DOCKER_MANAGED_INSTALLS_ROOT &&
    !normalized.startsWith(`${LEGACY_DOCKER_MANAGED_INSTALLS_ROOT}/`)
  ) {
    return filePath
  }

  const relative = normalized.slice(LEGACY_DOCKER_MANAGED_INSTALLS_ROOT.length).replace(/^\/+/, '')
  return path.join(resolveManagedInstallsRoot(), ...relative.split('/').filter(Boolean))
}

async function resolveInstalledManifestExecutable(
  runtime: ManagedCliRuntimeId,
  versionRoot: string,
  manifest: ManagedCliInstallManifest
): Promise<string | null> {
  const candidates = [
    resolveManifestExecutableCandidate(runtime, versionRoot, manifest),
    remapLegacyDockerManagedInstallPath(manifest.executablePath),
    manifest.executablePath
  ]

  for (const candidate of Array.from(new Set(candidates.filter(Boolean)))) {
    if (candidate && (await executableExists(candidate))) return candidate
  }

  return null
}

function resolveInstalledManifestExecutableSync(
  runtime: ManagedCliRuntimeId,
  versionRoot: string,
  manifest: ManagedCliInstallManifest
): string | null {
  const candidates = Array.from(
    new Set(
      [
        resolveManifestExecutableCandidate(runtime, versionRoot, manifest),
        remapLegacyDockerManagedInstallPath(manifest.executablePath),
        manifest.executablePath
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  )

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

async function probeExecutableVersion(executablePath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS
    })
    return `${stdout}\n${stderr}`.trim()
  } catch (error: any) {
    const detail =
      typeof error?.message === 'string' && error.message.trim().length > 0
        ? ` (${error.message.trim()})`
        : ''
    throw new Error(
      `Installed binary at ${executablePath} failed to run \`--version\`${detail}. The install was rolled back.`
    )
  }
}

async function refreshShim(runtime: ManagedCliRuntimeId, executablePath: string): Promise<void> {
  const binDir = resolveManagedCliBinDir()
  await mkdir(binDir, { recursive: true })
  const shimPath = resolveManagedCliShimPath(runtime)
  const temporaryShimPath = path.join(binDir, `.${runtime}.tmp-${randomUUID()}`)
  try {
    await symlink(executablePath, temporaryShimPath)
    await rename(temporaryShimPath, shimPath)
  } finally {
    await rm(temporaryShimPath, { force: true }).catch(() => undefined)
  }
}

async function removeShim(runtime: ManagedCliRuntimeId): Promise<void> {
  await rm(resolveManagedCliShimPath(runtime), { force: true })
}

function buildUnsupportedReason(runtime: ManagedCliRuntimeId): string | null {
  try {
    resolveManagedCliTarget(runtime)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Reports the managed-install state for one runtime. This only describes
 * Batshit-managed installs; PATH/global installs are reported separately by
 * the CLI status resolvers.
 */
export async function getManagedCliInstallStatus(
  runtime: ManagedCliRuntimeId
): Promise<ManagedCliInstallStatus> {
  const runtimeRoot = resolveManagedCliRuntimeRoot(runtime)
  const pinnedVersion = MANAGED_CLI_PINNED_VERSIONS[runtime]
  const unsupportedReason = buildUnsupportedReason(runtime)
  const operation = await getManagedCliOperationStatus(runtime)

  let installedManifest: ManagedCliInstallManifest | null = null
  const entries = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const versionRoot = path.join(runtimeRoot, entry.name)
    const manifest = await readManifest(versionRoot)
    if (!manifest) continue

    const executablePath = await resolveInstalledManifestExecutable(runtime, versionRoot, manifest)
    if (executablePath) {
      // Prefer the pinned version when multiple version folders exist.
      if (!installedManifest || manifest.version === pinnedVersion) {
        installedManifest = {
          ...manifest,
          executablePath,
          installRoot: versionRoot
        }
      }
    }
  }

  return {
    runtime,
    displayName: MANAGED_CLI_DISPLAY_NAMES[runtime],
    supported: unsupportedReason === null,
    unsupportedReason,
    installed: Boolean(installedManifest),
    version: installedManifest?.version ?? null,
    pinnedVersion,
    executablePath: installedManifest?.executablePath ?? null,
    installRoot: runtimeRoot,
    manifest: installedManifest,
    operation,
  }
}

/**
 * Synchronous managed-executable lookup for the CLI status resolvers (which
 * are sync today). Returns null when no healthy managed install exists.
 */
export function getManagedCliExecutableSync(
  runtime: ManagedCliRuntimeId
): { executablePath: string; version: string } | null {
  const runtimeRoot = resolveManagedCliRuntimeRoot(runtime)
  let entries: string[]
  try {
    entries = readdirSync(runtimeRoot)
  } catch {
    return null
  }

  let fallback: { executablePath: string; version: string } | null = null
  for (const entry of entries) {
    let manifest: ManagedCliInstallManifest
    try {
      manifest = JSON.parse(
        readFileSync(path.join(runtimeRoot, entry, MANAGED_CLI_MANIFEST_FILE), 'utf8')
      ) as ManagedCliInstallManifest
    } catch {
      continue
    }
    const versionRoot = path.join(runtimeRoot, entry)
    const executablePath = resolveInstalledManifestExecutableSync(runtime, versionRoot, manifest)
    if (!executablePath) continue

    const resolved = { executablePath, version: manifest.version }
    if (manifest.version === MANAGED_CLI_PINNED_VERSIONS[runtime]) {
      return resolved
    }
    fallback = resolved
  }

  return fallback
}

export type ManagedCliInstallResult = {
  status: ManagedCliInstallStatus
  installedVersion: string
  executablePath: string
  sourceUrl: string
  reused: boolean
}

/**
 * Downloads, verifies, and installs the pinned runtime version. Reinstalls are
 * allowed (the version folder is replaced atomically via a staging directory).
 */
export async function installManagedCli(
  runtime: ManagedCliRuntimeId,
  options: {
    /** Override the install destination (used by verification scripts/tests). */
    installRootOverride?: string
    /** Skip stable-shim creation (used with installRootOverride). */
    skipShim?: boolean
    /** Explicitly replace an already-healthy pinned install. */
    force?: boolean
  } = {}
): Promise<ManagedCliInstallResult> {
  const version = MANAGED_CLI_PINNED_VERSIONS[runtime]
  const cliRoot = options.installRootOverride ?? resolveManagedCliRoot()
  const versionRoot = path.join(cliRoot, runtime, version)
  const operation = await acquireManagedCliOperation(
    runtime,
    options.force ? 'reinstall' : 'install',
    cliRoot,
  )
  let stagingRoot: string | null = null
  try {
    if (!options.force && !options.installRootOverride) {
      const current = await getManagedCliInstallStatus(runtime)
      if (current.installed && current.version === version && current.manifest) {
        return {
          status: current,
          installedVersion: version,
          executablePath: current.executablePath!,
          sourceUrl: current.manifest.sourceUrl,
          reused: true,
        }
      }
    }

    const target = resolveManagedCliTarget(runtime)
    await operation.update('metadata')
    const { tarballUrl, integrity } = await fetchRegistryMetadata(target)
    const { operationsRoot } = resolveOperationPaths(runtime, cliRoot)
    stagingRoot = await mkdtemp(path.join(operationsRoot, `${runtime}-${version}-staging-`))
    const archivePath = path.join(stagingRoot, `${runtime}-${version}.tgz`)
    await operation.update('downloading')
    // codeql[js/http-to-file-access]
    await downloadTarball(tarballUrl, archivePath, integrity)
    await operation.update('extracting')
    await extractTarGz(archivePath, stagingRoot)
    await rm(archivePath, { force: true })

    await operation.update('validating')
    const stagedExecutable = path.join(stagingRoot, target.executableRelativePath)
    if (!(await fileExists(stagedExecutable))) {
      throw new Error(
        `The downloaded ${MANAGED_CLI_DISPLAY_NAMES[runtime]} package did not contain the expected executable at ${target.executableRelativePath}.`
      )
    }
    await chmod(stagedExecutable, 0o755)
    for (const extra of target.additionalExecutableRelativePaths) {
      const extraPath = path.join(stagingRoot, extra)
      if (await fileExists(extraPath)) {
        await chmod(extraPath, 0o755)
      }
    }

    const versionOutput = await probeExecutableVersion(stagedExecutable)

    const executablePath = path.join(versionRoot, target.executableRelativePath)
    const manifest: ManagedCliInstallManifest = {
      runtime,
      version,
      installedAt: new Date().toISOString(),
      installRoot: versionRoot,
      packageName: target.packageName,
      sourceUrl: tarballUrl,
      integrity,
      checksumVerified: true,
      executablePath,
      versionOutput
    }
    // The manifest records verified package metadata inside the private staging directory.
    // codeql[js/http-to-file-access]
    await writeFile(
      path.join(stagingRoot, MANAGED_CLI_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    )

    await mkdir(path.dirname(versionRoot), { recursive: true })
    const rollbackRoot = path.join(
      resolveOperationPaths(runtime, cliRoot).operationsRoot,
      `${runtime}-${version}-rollback-${randomUUID()}`,
    )
    const hadExistingInstall = Boolean(await stat(versionRoot).catch(() => null))
    let promoted = false
    await operation.update('activating')
    try {
      if (hadExistingInstall) await rename(versionRoot, rollbackRoot)
      await rename(stagingRoot, versionRoot)
      stagingRoot = null
      promoted = true

      if (!options.skipShim && !options.installRootOverride) {
        await refreshShim(runtime, executablePath)
      }
    } catch (error) {
      if (promoted) await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined)
      if (hadExistingInstall && (await stat(rollbackRoot).catch(() => null))) {
        await rename(rollbackRoot, versionRoot).catch(() => undefined)
      }
      throw error
    }
    await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined)

    if (!options.installRootOverride) {
      // Remove any stale sibling versions so old ~190MB trees do not pile up.
      const runtimeRoot = resolveManagedCliRuntimeRoot(runtime)
      const siblings = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => [])
      for (const sibling of siblings) {
        if (sibling.isDirectory() && sibling.name !== version) {
          await rm(path.join(runtimeRoot, sibling.name), { recursive: true, force: true }).catch(
            () => undefined
          )
        }
      }
    }

    const status = await getManagedCliInstallStatus(runtime)

    return {
      status,
      installedVersion: version,
      executablePath,
      sourceUrl: tarballUrl,
      reused: false,
    }
  } finally {
    await operation.update('cleaning-up').catch(() => undefined)
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    await operation.release()
  }
}

/** Removes the managed install (all versions) and the stable shim for a runtime. */
export async function uninstallManagedCli(runtime: ManagedCliRuntimeId): Promise<ManagedCliInstallStatus> {
  const cliRoot = resolveManagedCliRoot()
  const operation = await acquireManagedCliOperation(runtime, 'uninstall', cliRoot)
  const runtimeRoot = resolveManagedCliRuntimeRoot(runtime)
  const trashRoot = path.join(
    resolveOperationPaths(runtime, cliRoot).operationsRoot,
    `${runtime}-uninstall-${randomUUID()}`,
  )
  let moved = false
  try {
    await operation.update('activating')
    if (await stat(runtimeRoot).catch(() => null)) {
      await rename(runtimeRoot, trashRoot)
      moved = true
    }
    try {
      await removeShim(runtime)
    } catch (error) {
      if (moved) await rename(trashRoot, runtimeRoot).catch(() => undefined)
      throw error
    }
    await operation.update('cleaning-up')
    await rm(trashRoot, { recursive: true, force: true })
    return getManagedCliInstallStatus(runtime)
  } finally {
    await operation.release()
  }
}
