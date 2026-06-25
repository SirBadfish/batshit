import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const CLOUDFLARED_ASSETS = {
  'darwin-x64': {
    assetName: 'cloudflared-darwin-amd64.tgz',
    binaryName: 'cloudflared',
    archiveType: 'tgz',
    sha256: '0f30140c4a5e213d22f951ef4c964cac5fb6a5f061ba6eba5ea932999f7c0394'
  },
  'linux-x64': {
    assetName: 'cloudflared-linux-amd64',
    binaryName: 'cloudflared',
    archiveType: null,
    sha256: '4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30'
  },
  'windows-x64': {
    assetName: 'cloudflared-windows-amd64.exe',
    binaryName: 'cloudflared.exe',
    archiveType: null,
    sha256: '59b12880b24af581cf5b1013db601c7d843b9b097e9c78aa5957c7f39f741885'
  }
} as const

export type CloudflaredInstallPlatform = keyof typeof CLOUDFLARED_ASSETS

export type CloudflaredManifest = {
  version: string
  platform: CloudflaredInstallPlatform
  assetName: string
  binaryName: string
  installedAt: string
  source: 'github-release'
  releaseTag: string
  downloadUrl: string
  checksumAlgorithm: 'sha256'
  checksum: string
  checksumSource: 'github-release-asset-digest'
  checksumVerified: boolean
  checksumVerifiedAt: string
}

export type ManagedTunnelStatus = {
  running: boolean
  publicUrl: string | null
  targetUrl: string | null
  pid: number | null
  startedAt: string | null
  lastError: string | null
}

const CLOUDFLARED_UNINSTALL_TIMEOUT_MS = 30_000
const CLOUDFLARED_PROCESS_MAX_OUTPUT_CHARS = 250_000
const CLOUDFLARED_TUNNEL_START_TIMEOUT_MS = 20_000
const FALLBACK_MANAGED_TUNNEL_TARGET_URL = 'http://localhost:5600'
const CLOUDFLARED_RELEASE_TAG = '2026.3.0'
const DOCKER_CLOUDFLARED_STATE_PATH = '/runtime/cloudflared/status.json'
const DOCKER_CLOUDFLARED_STALE_AFTER_MS = 120_000
const CLOUDFLARED_DOWNLOAD_BASE =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE_TAG}`
const CLOUDFLARED_INSTALL_HELP =
  `Install from Settings -> Admin -> Cloudflared Runtime. Batshit pins ${CLOUDFLARED_RELEASE_TAG} and verifies the official SHA256.`
const DOCKER_CLOUDFLARED_WAITING_REASON =
  'Docker Cloudflared sidecar is not running yet. Start it from Batshit when the host operator is configured, or run the cloudflared Compose profile from the host.'
const DOCKER_CLOUDFLARED_MANAGED_REASON =
  'Docker Cloudflared is managed as an optional Compose sidecar, not as a binary inside the core app container.'
const DOCKER_CLOUDFLARED_INSTALL_HELP =
  'Docker Cloudflared is managed by the optional cloudflared Compose profile, not by downloading a binary into the core app container.'

export type CloudflaredRuntimeStatus = {
  installed: boolean
  supported: boolean
  dockerUnsupported: boolean
  supportLevel: 'native-managed' | 'docker-deferred' | 'docker-sidecar'
  command: string | null
  version: string | null
  reason: string | null
  testedVersion: string
  installScope: 'none' | 'batshit-managed' | 'system' | 'docker-sidecar'
  managedInstallPresent: boolean
  installCommand: string
  installHelp: string
  defaultPlatform: CloudflaredInstallPlatform
  manifest: CloudflaredManifest | null
  tunnel: ManagedTunnelStatus
  dockerSidecar?: DockerCloudflaredSidecarStatus | null
}

export type DockerCloudflaredSidecarStatus = {
  mode: 'docker-sidecar'
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'error'
  publicUrl: string | null
  targetUrl: string | null
  startedAt: string | null
  lastSeenAt: string | null
  version: string | null
  logPath: string | null
  stale: boolean
  statePath: string
  error: string | null
}

type ProcessRunResult = {
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  truncated: boolean
}

type TunnelState = {
  child: ChildProcess | null
  command: string | null
  args: string[]
  publicUrl: string | null
  targetUrl: string | null
  startedAt: string | null
  lastError: string | null
}

const tunnelState: TunnelState = {
  child: null,
  command: null,
  args: [],
  publicUrl: null,
  targetUrl: null,
  startedAt: null,
  lastError: null
}

type ManagedTunnelStartResult = {
  started: boolean
  status: ManagedTunnelStatus
  reason?: string
}

type InFlightTunnelStart = {
  targetUrl: string
  promise: Promise<ManagedTunnelStartResult>
}

// Serializes managed tunnel spawns. tunnelState can only track one child, so
// concurrent ensure/start callers must share a single in-flight start instead
// of each spawning their own cloudflared process and orphaning all but the
// last one from the app's point of view.
let inFlightTunnelStart: InFlightTunnelStart | null = null

function appendWithLimit(current: string, chunk: string, maxChars: number) {
  if (!chunk) return { text: current, truncated: false }
  const combined = current + chunk
  if (combined.length <= maxChars) {
    return { text: combined, truncated: false }
  }
  return {
    text: combined.slice(0, maxChars),
    truncated: true
  }
}

async function runProcess(options: {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputChars?: number
}): Promise<ProcessRunResult> {
  const args = options.args ?? []
  const timeoutMs = Math.max(500, options.timeoutMs ?? 5_000)
  const maxOutputChars = Math.max(4_096, options.maxOutputChars ?? CLOUDFLARED_PROCESS_MAX_OUTPUT_CHARS)
  const startedAt = Date.now()

  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    child.stdout.on('data', (chunk) => {
      const next = appendWithLimit(stdout, String(chunk), maxOutputChars)
      stdout = next.text
      if (next.truncated) truncated = true
    })

    child.stderr.on('data', (chunk) => {
      const next = appendWithLimit(stderr, String(chunk), maxOutputChars)
      stderr = next.text
      if (next.truncated) truncated = true
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 300)
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        command: options.command,
        args,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated
      })
    })
  })
}

function isLikelyRepoRoot(dir: string) {
  return path.basename(dir) === 'batshit'
}

export function resolveRepoRoot() {
  const explicit = process.env.BATSHIT_REPO_ROOT || process.env.BATSHIT_MAC_REPO_ROOT
  if (explicit?.trim()) return path.resolve(explicit.trim())

  const cwd = process.cwd()
  if (isLikelyRepoRoot(cwd)) {
    return cwd
  }
  if (path.basename(cwd) === 'batshit-app' || path.basename(cwd) === 'n8n') {
    return path.resolve(cwd, '..')
  }
  if (path.basename(cwd) === 'batshit-server') {
    return path.resolve(cwd, '..')
  }
  if (path.basename(cwd) === 'server' && path.basename(path.dirname(cwd)) === 'batshit-server') {
    return path.resolve(cwd, '..', '..')
  }
  return cwd
}

export function resolveCloudflaredInstallDir() {
  const explicit = process.env.BATSHIT_CLOUDFLARED_DIR?.trim()
  if (explicit) return path.resolve(explicit)

  const runtimeDataDir = process.env.BATSHIT_RUNTIME_DATA_DIR?.trim()
  if (runtimeDataDir) return path.resolve(runtimeDataDir, 'cloudflared')

  return path.join(resolveRepoRoot(), '_local', 'cloudflared')
}

function resolveManifestPath(installDir = resolveCloudflaredInstallDir()) {
  return path.join(installDir, 'manifest.json')
}

function resolveServerPlatform(): CloudflaredInstallPlatform {
  if (process.platform === 'win32') return 'windows-x64'
  if (process.platform === 'linux') return 'linux-x64'
  return 'darwin-x64'
}

function isBatshitContainerizedRuntime() {
  return (
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

function resolveDockerCloudflaredStatePath() {
  const configured = typeof process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH === 'string'
    ? process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH.trim()
    : ''
  return configured || DOCKER_CLOUDFLARED_STATE_PATH
}

function normalizeVersionText(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/cloudflared\s+version\s+([^\s]+)/i)
  if (match?.[1]) return match[1]
  return trimmed.split(/\s+/)[0] || null
}

function normalizeManagedTunnelEnvUrl(value?: string | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : null
}

function normalizeTargetUrl(value?: string | null): string {
  const fallback = getDefaultManagedTunnelTargetUrl()
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readManifest(): Promise<CloudflaredManifest | null> {
  try {
    const raw = await fs.readFile(resolveManifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as CloudflaredManifest
    if (!parsed?.binaryName || !parsed?.platform || !parsed?.assetName) return null
    return parsed
  } catch {
    return null
  }
}

function normalizeDockerSidecarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : null
}

function normalizeDockerSidecarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeDockerSidecarStatus(value: unknown): DockerCloudflaredSidecarStatus['status'] {
  if (typeof value !== 'string') return 'error'
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'starting' ||
    normalized === 'running' ||
    normalized === 'stopping' ||
    normalized === 'stopped' ||
    normalized === 'exited' ||
    normalized === 'error'
  ) {
    return normalized
  }
  return 'error'
}

async function readDockerSidecarStatus(): Promise<DockerCloudflaredSidecarStatus | null> {
  const statePath = resolveDockerCloudflaredStatePath()
  try {
    const raw = await fs.readFile(statePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed?.mode !== 'docker-sidecar') return null

    const status = normalizeDockerSidecarStatus(parsed.status)
    const lastSeenAt = normalizeDockerSidecarDate(parsed.lastSeenAt)
    const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN
    const stale = !Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > DOCKER_CLOUDFLARED_STALE_AFTER_MS

    return {
      mode: 'docker-sidecar',
      status,
      publicUrl: status === 'running' && !stale ? normalizeDockerSidecarUrl(parsed.publicUrl) : null,
      targetUrl: normalizeDockerSidecarUrl(parsed.targetUrl),
      startedAt: normalizeDockerSidecarDate(parsed.startedAt),
      lastSeenAt,
      version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null,
      logPath: typeof parsed.logPath === 'string' && parsed.logPath.trim() ? parsed.logPath.trim() : null,
      stale,
      statePath,
      error: typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null
    }
  } catch {
    return null
  }
}

function managedTunnelStatusFromDockerSidecar(
  sidecar: DockerCloudflaredSidecarStatus
): ManagedTunnelStatus {
  const running = sidecar.status === 'running' && Boolean(sidecar.publicUrl) && !sidecar.stale
  return {
    running,
    publicUrl: running ? sidecar.publicUrl : null,
    targetUrl: sidecar.targetUrl,
    pid: null,
    startedAt: sidecar.startedAt,
    lastError: sidecar.stale
      ? 'Cloudflared sidecar status is stale. Check the cloudflared container logs.'
      : sidecar.error
  }
}

function sha256Hex(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function resolveCloudflaredDownloadUrl(platform: CloudflaredInstallPlatform) {
  const asset = CLOUDFLARED_ASSETS[platform]
  return `${CLOUDFLARED_DOWNLOAD_BASE}/${asset.assetName}`
}

async function resolveManagedBinaryPath(): Promise<string | null> {
  const installDir = resolveCloudflaredInstallDir()
  const manifest = await readManifest()

  if (manifest?.binaryName) {
    const manifestPath = path.join(installDir, manifest.binaryName)
    if (await exists(manifestPath)) return manifestPath
  }

  const fallbackNames = ['cloudflared', 'cloudflared.exe']
  for (const name of fallbackNames) {
    const candidate = path.join(installDir, name)
    if (await exists(candidate)) return candidate
  }

  return null
}

async function resolveCommandCandidates(): Promise<string[]> {
  const candidates: string[] = []
  const envPath = typeof process.env.BATSHIT_CLOUDFLARED_BIN === 'string'
    ? process.env.BATSHIT_CLOUDFLARED_BIN.trim()
    : ''
  if (envPath) candidates.push(envPath)

  const managedBinary = await resolveManagedBinaryPath()
  if (managedBinary) candidates.push(managedBinary)

  candidates.push('cloudflared')
  return Array.from(new Set(candidates.filter((entry) => entry.length > 0)))
}

async function checkAvailability(): Promise<{
  available: boolean
  command?: string
  version?: string
  reason?: string
}> {
  const candidates = await resolveCommandCandidates()
  if (candidates.length === 0) {
    return {
      available: false,
      reason: `No cloudflared binary configured. ${CLOUDFLARED_INSTALL_HELP}`
    }
  }

  let lastError: string | null = null

  for (const command of candidates) {
    try {
      const probe = await runProcess({
        command,
        args: ['--version'],
        timeoutMs: 5_000,
        maxOutputChars: 4_096
      })
      if (probe.exitCode === 0) {
        const versionRaw = probe.stdout.trim() || probe.stderr.trim()
        return {
          available: true,
          command,
          version: normalizeVersionText(versionRaw) ?? (versionRaw || 'unknown')
        }
      }
      lastError = probe.stderr.trim() || `cloudflared exited with code ${probe.exitCode ?? 'unknown'}`
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      if (maybeError?.code === 'ENOENT') {
        lastError = `Command not found: ${command}`
        continue
      }
      lastError = maybeError?.message || String(error)
    }
  }

  return {
    available: false,
    reason: `${lastError || 'cloudflared is unavailable.'} ${CLOUDFLARED_INSTALL_HELP}`
  }
}

function tunnelProcessAlive() {
  return Boolean(tunnelState.child && tunnelState.child.exitCode === null && !tunnelState.child.killed)
}

function getManagedTunnelStatus(): ManagedTunnelStatus {
  return {
    running: tunnelProcessAlive(),
    publicUrl: tunnelState.publicUrl,
    targetUrl: tunnelState.targetUrl,
    pid: tunnelState.child?.pid ?? null,
    startedAt: tunnelState.startedAt,
    lastError: tunnelState.lastError
  }
}

function getWaitingDockerManagedTunnelStatus(): ManagedTunnelStatus {
  return {
    running: false,
    publicUrl: null,
    targetUrl: getDefaultDockerManagedTunnelTargetUrl(),
    pid: null,
    startedAt: null,
    lastError: null
  }
}

function resetTunnelState() {
  tunnelState.child = null
  tunnelState.command = null
  tunnelState.args = []
  tunnelState.publicUrl = null
  tunnelState.targetUrl = null
  tunnelState.startedAt = null
}

function parseTunnelUrl(line: string): string | null {
  if (!line) return null
  const tryCloudflare = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)
  if (tryCloudflare && tryCloudflare.length > 0) {
    return tryCloudflare[0] ?? null
  }
  return null
}

function wireTunnelOutputStream(child: ChildProcess, stream: NodeJS.ReadableStream) {
  let buffer = ''
  stream.on('data', (chunk) => {
    if (tunnelState.child !== child) return
    buffer += String(chunk)
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const maybeUrl = parseTunnelUrl(line)
      if (maybeUrl) {
        tunnelState.publicUrl = maybeUrl
      }
    }
  })
}

export async function getCloudflaredRuntimeStatus(): Promise<CloudflaredRuntimeStatus> {
  if (isBatshitContainerizedRuntime()) {
    const sidecar = await readDockerSidecarStatus()
    if (sidecar) {
      const tunnel = managedTunnelStatusFromDockerSidecar(sidecar)
      const reason = tunnel.running
        ? 'Docker Cloudflared sidecar is running and reporting a public tunnel URL.'
        : sidecar.stale
          ? 'Docker Cloudflared sidecar status is stale. Restart the cloudflared Compose profile or inspect its logs.'
          : sidecar.status === 'stopped'
            ? 'Docker Cloudflared sidecar is stopped.'
            : sidecar.status === 'exited'
              ? 'Docker Cloudflared sidecar exited. Inspect the cloudflared container logs.'
              : 'Docker Cloudflared sidecar is present but has not reported a public tunnel URL yet.'
      return {
        installed: tunnel.running,
        supported: true,
        dockerUnsupported: false,
        supportLevel: 'docker-sidecar',
        command: 'docker compose profile: cloudflared',
        version: sidecar.version,
        reason,
        testedVersion: CLOUDFLARED_RELEASE_TAG,
        installScope: 'docker-sidecar',
        managedInstallPresent: false,
        installCommand: 'docker compose --env-file .env.docker --profile cloudflared up -d --build cloudflared',
        installHelp: DOCKER_CLOUDFLARED_INSTALL_HELP,
        defaultPlatform: 'linux-x64',
        manifest: null,
        tunnel,
        dockerSidecar: sidecar
      }
    }

    return {
      installed: false,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar',
      command: 'docker compose profile: cloudflared',
      version: null,
      reason: DOCKER_CLOUDFLARED_WAITING_REASON,
      testedVersion: CLOUDFLARED_RELEASE_TAG,
      installScope: 'docker-sidecar',
      managedInstallPresent: false,
      installCommand: 'docker compose --env-file .env.docker --profile cloudflared up -d --build cloudflared',
      installHelp: DOCKER_CLOUDFLARED_INSTALL_HELP,
      defaultPlatform: 'linux-x64',
      manifest: null,
      tunnel: getWaitingDockerManagedTunnelStatus(),
      dockerSidecar: null
    }
  }

  const availability = await checkAvailability()
  const manifest = await readManifest()
  const managedBinaryPath = await resolveManagedBinaryPath()
  const resolvedCommand = availability.command ?? null
  const version = availability.version ?? null
  const installScope: 'none' | 'batshit-managed' | 'system' = availability.available
    ? resolvedCommand && managedBinaryPath && path.resolve(resolvedCommand) === path.resolve(managedBinaryPath)
      ? 'batshit-managed'
      : 'system'
    : 'none'
  const reason =
    availability.reason ??
    (availability.available && version && version !== CLOUDFLARED_RELEASE_TAG
      ? installScope === 'batshit-managed'
        ? `Batshit-managed cloudflared is ${version}; the tested release is ${CLOUDFLARED_RELEASE_TAG}. Reinstall from Admin to realign.`
        : `System-managed cloudflared is ${version}; Batshit's tested release is ${CLOUDFLARED_RELEASE_TAG}.`
      : `Batshit pins cloudflared ${CLOUDFLARED_RELEASE_TAG} and verifies the official SHA256 before install.`)

  return {
    installed: availability.available,
    supported: true,
    dockerUnsupported: false,
    supportLevel: 'native-managed',
    command: resolvedCommand,
    version,
    reason,
    testedVersion: CLOUDFLARED_RELEASE_TAG,
    installScope,
    managedInstallPresent: Boolean(managedBinaryPath),
    installCommand: 'Use the Admin installer',
    installHelp: CLOUDFLARED_INSTALL_HELP,
    defaultPlatform: resolveServerPlatform(),
    manifest: manifest ?? null,
    tunnel: getManagedTunnelStatus(),
    dockerSidecar: null
  }
}

async function extractArchive(archivePath: string, destination: string) {
  const result = await runProcess({
    command: 'tar',
    args: ['-xzf', archivePath, '-C', destination],
    timeoutMs: 60_000
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to extract cloudflared archive.')
  }
}

async function resolveInstalledVersion(command: string): Promise<string | null> {
  try {
    const probe = await runProcess({
      command,
      args: ['--version'],
      timeoutMs: 5_000,
      maxOutputChars: 4_096
    })
    if (probe.exitCode !== 0) return null
    const raw = probe.stdout.trim() || probe.stderr.trim()
    return normalizeVersionText(raw) ?? (raw || null)
  } catch {
    return null
  }
}

export async function installCloudflaredRuntime(platform: CloudflaredInstallPlatform): Promise<CloudflaredRuntimeStatus> {
  if (isBatshitContainerizedRuntime()) {
    return await getCloudflaredRuntimeStatus()
  }

  const asset = CLOUDFLARED_ASSETS[platform]
  if (!asset) {
    return {
      ...(await getCloudflaredRuntimeStatus()),
      installed: false,
      reason: 'Invalid cloudflared install platform.'
    }
  }

  const installDir = resolveCloudflaredInstallDir()
  const stagingDir = `${installDir}.tmp-${Date.now()}`
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(stagingDir, { recursive: true })

  try {
    const url = resolveCloudflaredDownloadUrl(platform)
    const response = await fetch(url)
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ...(await getCloudflaredRuntimeStatus()),
        installed: false,
        reason: body || `Failed to download cloudflared (${response.status}).`
      }
    }

    const data = Buffer.from(await response.arrayBuffer())
    const checksum = sha256Hex(data)
    if (checksum !== asset.sha256) {
      return {
        ...(await getCloudflaredRuntimeStatus()),
        installed: false,
        reason: `Cloudflared checksum mismatch for ${asset.assetName}. Expected ${asset.sha256}, got ${checksum}.`
      }
    }

    const targetPath = path.join(stagingDir, asset.assetName)
    // The downloaded asset is verified against the pinned SHA-256 above before this private staging write.
    // codeql[js/http-to-file-access]
    await fs.writeFile(targetPath, data)

    if (asset.archiveType === 'tgz') {
      await extractArchive(targetPath, stagingDir)
      await fs.rm(targetPath, { force: true })
    }

    const binaryPath = path.join(stagingDir, asset.binaryName)
    if (!(await exists(binaryPath))) {
      return {
        ...(await getCloudflaredRuntimeStatus()),
        installed: false,
        reason: `Cloudflared binary not found after install: ${binaryPath}`
      }
    }

    if (!binaryPath.endsWith('.exe')) {
      await fs.chmod(binaryPath, 0o755)
    }

    const installedAt = new Date().toISOString()
    const version = (await resolveInstalledVersion(binaryPath)) ?? CLOUDFLARED_RELEASE_TAG
    const manifest: CloudflaredManifest = {
      version,
      platform,
      assetName: asset.assetName,
      binaryName: asset.binaryName,
      installedAt,
      source: 'github-release',
      releaseTag: CLOUDFLARED_RELEASE_TAG,
      downloadUrl: url,
      checksumAlgorithm: 'sha256',
      checksum: asset.sha256,
      checksumSource: 'github-release-asset-digest',
      checksumVerified: true,
      checksumVerifiedAt: installedAt
    }
    await fs.writeFile(resolveManifestPath(stagingDir), JSON.stringify(manifest, null, 2))

    await fs.rm(installDir, { recursive: true, force: true })
    await fs.rename(stagingDir, installDir)

    const status = await getCloudflaredRuntimeStatus()
    return {
      ...status,
      installed: status.installed,
      reason: status.installed ? null : status.reason
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function uninstallCloudflaredRuntime(): Promise<{
  uninstalled: boolean
  supported: boolean
  dockerUnsupported: boolean
  removedManagedInstall: boolean
  reason: string | null
  status: CloudflaredRuntimeStatus
}> {
  if (isBatshitContainerizedRuntime()) {
    const status = await getCloudflaredRuntimeStatus()
    return {
      uninstalled: false,
      supported: status.supported,
      dockerUnsupported: status.dockerUnsupported,
      removedManagedInstall: false,
      reason: DOCKER_CLOUDFLARED_MANAGED_REASON,
      status
    }
  }

  const managedBinaryBefore = await resolveManagedBinaryPath()
  await stopManagedCloudflaredTunnel()
  try {
    await fs.rm(resolveCloudflaredInstallDir(), { recursive: true, force: true })
  } catch {
    // best effort
  }

  const managedBinaryAfter = await resolveManagedBinaryPath()
  const status = await getCloudflaredRuntimeStatus()
  const removedManagedInstall = Boolean(managedBinaryBefore) && !managedBinaryAfter
  const uninstalled = removedManagedInstall || !status.installed
  const reason =
    status.installed && removedManagedInstall
      ? 'Batshit-managed Cloudflared was removed. A system-managed cloudflared is still available on PATH.'
      : status.installed && !removedManagedInstall
        ? 'Cloudflared is installed outside Batshit (system-managed). Admin uninstall only removes the Batshit-managed runtime.'
        : null
  return {
    uninstalled,
    supported: status.supported,
    dockerUnsupported: status.dockerUnsupported,
    removedManagedInstall,
    reason,
    status
  }
}

export async function startManagedCloudflaredTunnel(options?: {
  targetUrl?: string
  timeoutMs?: number
}): Promise<ManagedTunnelStartResult> {
  if (isBatshitContainerizedRuntime()) {
    const status = await getCloudflaredRuntimeStatus()
    if (status.supportLevel === 'docker-sidecar') {
      return {
        started: status.tunnel.running && Boolean(status.tunnel.publicUrl),
        status: status.tunnel,
        reason: status.tunnel.running ? undefined : status.reason ?? DOCKER_CLOUDFLARED_WAITING_REASON
      }
    }
    return {
      started: false,
      status: getWaitingDockerManagedTunnelStatus(),
      reason: DOCKER_CLOUDFLARED_WAITING_REASON
    }
  }

  const targetUrl = normalizeTargetUrl(options?.targetUrl)
  const timeoutMs = Math.max(2_000, options?.timeoutMs ?? CLOUDFLARED_TUNNEL_START_TIMEOUT_MS)

  while (inFlightTunnelStart) {
    const current = inFlightTunnelStart
    if (current.targetUrl === targetUrl) {
      return await current.promise
    }
    // A start for a different target owns the spawn slot. Wait for it to
    // settle and re-check: another waiter may claim the slot first.
    await current.promise.catch(() => {})
  }

  const slot: InFlightTunnelStart = {
    targetUrl,
    // The slot must clear before this promise settles so waiters that wake up
    // never re-join an already-finished start.
    promise: performManagedTunnelStart(targetUrl, timeoutMs).finally(() => {
      if (inFlightTunnelStart === slot) {
        inFlightTunnelStart = null
      }
    })
  }
  inFlightTunnelStart = slot
  return await slot.promise
}

// Only runs under the inFlightTunnelStart guard, so between the alive-check
// and the tunnelState assignment no other caller can spawn or re-assign.
async function performManagedTunnelStart(
  targetUrl: string,
  timeoutMs: number
): Promise<ManagedTunnelStartResult> {
  if (tunnelProcessAlive()) {
    if (tunnelState.targetUrl === targetUrl) {
      return { started: true, status: getManagedTunnelStatus() }
    }
    await stopManagedTunnelProcess()
  }

  const availability = await checkAvailability()
  if (!availability.available || !availability.command) {
    return {
      started: false,
      status: getManagedTunnelStatus(),
      reason: availability.reason || CLOUDFLARED_INSTALL_HELP
    }
  }

  const args = ['tunnel', '--url', targetUrl, '--no-autoupdate']
  const child = spawn(availability.command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  tunnelState.child = child
  tunnelState.command = availability.command
  tunnelState.args = args
  tunnelState.publicUrl = null
  tunnelState.targetUrl = targetUrl
  tunnelState.startedAt = new Date().toISOString()
  tunnelState.lastError = null

  if (child.stdout) wireTunnelOutputStream(child, child.stdout)
  if (child.stderr) wireTunnelOutputStream(child, child.stderr)

  child.on('error', (error) => {
    if (tunnelState.child !== child) return
    tunnelState.lastError = error instanceof Error ? error.message : String(error)
  })

  child.on('exit', (code, signal) => {
    // A SIGKILLed predecessor can emit exit after its replacement is tracked;
    // it must never wipe the live child's state.
    if (tunnelState.child !== child) return
    if (code !== 0 && signal !== 'SIGTERM') {
      tunnelState.lastError = `cloudflared tunnel exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`
    }
    resetTunnelState()
  })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (tunnelState.publicUrl) {
      return {
        started: true,
        status: getManagedTunnelStatus()
      }
    }
    if (!tunnelProcessAlive()) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  const reason =
    tunnelState.lastError ||
    'Managed Cloudflare tunnel started but no trycloudflare URL was detected in time.'
  await stopManagedTunnelProcess()
  return {
    started: false,
    status: getManagedTunnelStatus(),
    reason
  }
}

export async function ensureManagedCloudflaredTunnel(options?: {
  targetUrl?: string
}): Promise<ManagedTunnelStartResult> {
  const targetUrl = normalizeTargetUrl(options?.targetUrl)
  if (tunnelProcessAlive() && tunnelState.targetUrl === targetUrl && tunnelState.publicUrl) {
    return {
      started: true,
      status: getManagedTunnelStatus()
    }
  }
  return await startManagedCloudflaredTunnel({
    targetUrl
  })
}

export async function stopManagedCloudflaredTunnel(): Promise<{
  stopped: boolean
  status: ManagedTunnelStatus
  reason?: string
}> {
  if (isBatshitContainerizedRuntime()) {
    const runtimeStatus = await getCloudflaredRuntimeStatus()
    return {
      stopped: false,
      status: runtimeStatus.tunnel,
      reason:
        runtimeStatus.supportLevel === 'docker-sidecar'
          ? 'Docker Cloudflared sidecars are started and stopped by Docker Compose, not by the core app container.'
          : DOCKER_CLOUDFLARED_WAITING_REASON
    }
  }

  // Let any in-flight start settle first so "stopped" means no managed tunnel
  // from an earlier start call survives this stop.
  while (inFlightTunnelStart) {
    await inFlightTunnelStart.promise.catch(() => {})
  }

  return await stopManagedTunnelProcess()
}

// Raw kill of the tracked tunnel process. performManagedTunnelStart calls this
// directly because it already holds the in-flight start slot; waiting on it
// from there would deadlock.
async function stopManagedTunnelProcess(): Promise<{
  stopped: boolean
  status: ManagedTunnelStatus
  reason?: string
}> {
  const child = tunnelState.child
  if (!child || child.exitCode !== null || child.killed) {
    resetTunnelState()
    return {
      stopped: true,
      status: getManagedTunnelStatus()
    }
  }

  const waited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CLOUDFLARED_UNINSTALL_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
    child.kill('SIGTERM')
  })

  if (!waited && child.exitCode === null && !child.killed) {
    child.kill('SIGKILL')
  }

  resetTunnelState()
  return {
    stopped: true,
    status: getManagedTunnelStatus()
  }
}

export function getDefaultManagedTunnelTargetUrl(env: NodeJS.ProcessEnv = process.env) {
  return (
    normalizeManagedTunnelEnvUrl(env.PUBLIC_BATSHIT_SERVER_URL) ||
    normalizeManagedTunnelEnvUrl(env.BATSHIT_SERVER_URL) ||
    FALLBACK_MANAGED_TUNNEL_TARGET_URL
  )
}

export function getDefaultDockerManagedTunnelTargetUrl(env: NodeJS.ProcessEnv = process.env) {
  return (
    normalizeManagedTunnelEnvUrl(env.BATSHIT_CLOUDFLARED_TARGET_URL) ||
    normalizeManagedTunnelEnvUrl(env.BATSHIT_SERVER_URL) ||
    'http://batshit-server:5600'
  )
}
