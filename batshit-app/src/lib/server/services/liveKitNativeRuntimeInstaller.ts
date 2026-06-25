import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { apiKeyService } from '$lib/services/apiKey.server'
import {
  resolveManagedInstallsRoot,
  startLocalVoiceRuntime
} from '$lib/server/services/voiceLocalEngineSetup'

const execFileAsync = promisify(execFile)

export const LIVEKIT_NATIVE_SERVER_ENGINE_ID = 'livekit-server'
export const LIVEKIT_NATIVE_SIDECAR_ENGINE_ID = 'livekit-sidecar'
export const LIVEKIT_NATIVE_RUNTIME_VERSION = '1.12.0'
const LIVEKIT_HOMEBREW_FORMULA_URL = 'https://formulae.brew.sh/api/formula/livekit.json'
const LIVEKIT_DEFAULT_LOCAL_URL = 'ws://127.0.0.1:7880'
const LIVEKIT_DEFAULT_LOCAL_API_KEY = 'batshit-local'
const LIVEKIT_DEFAULT_HTTP_PORT = 7880
const LIVEKIT_DEFAULT_RTC_TCP_PORT = 7881
const LIVEKIT_DEFAULT_RTC_UDP_PORT = 7882
const NPM_INSTALL_TIMEOUT_MS = 240_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const LIVEKIT_READY_TIMEOUT_MS = 15_000
const LIVEKIT_READY_POLL_MS = 500

const LIVEKIT_REDIS_ENV_TO_UNSET = [
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_URL',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_TLS',
  'REDIS_DB'
]

export type LiveKitNativeInstallManifest = {
  kind: 'livekit-server' | 'livekit-sidecar'
  version: string
  installedAt: string
  installRoot: string
  source: 'homebrew-bottle' | 'batshit-bundled-sidecar'
  sourceUrl?: string
  bottleTag?: string
  checksumAlgorithm?: 'sha256'
  checksum?: string
  checksumVerified?: boolean
  binaryPath?: string
  packageManager?: 'npm'
}

export type LiveKitNativeInstallStatus = {
  supported: boolean
  installed: boolean
  serverInstalled: boolean
  sidecarInstalled: boolean
  reason: string | null
  version: string
  serverInstallRoot: string
  sidecarInstallRoot: string
  serverBinaryPath: string | null
  sidecarPackagePath: string | null
  serverManifest: LiveKitNativeInstallManifest | null
  sidecarManifest: LiveKitNativeInstallManifest | null
}

export type LiveKitNativeInstallResult = {
  installed: boolean
  credentialsSaved: boolean
  status: LiveKitNativeInstallStatus
  serverUrl: string
  apiKey: string
}

export type LiveKitNativeServerStartResult = {
  started: boolean
  alreadyRunning: boolean
  pid: number | null
  logPath: string | null
  statusHint: string
}

export type LiveKitLocalPortOwner = {
  pids: number[]
  commands: string[]
  dockerOwned: boolean
}

type HomebrewBottleFile = {
  url: string
  sha256: string
}

type HomebrewFormula = {
  versions?: {
    stable?: string
  }
  bottle?: {
    stable?: {
      files?: Record<string, HomebrewBottleFile>
    }
  }
}

function isContainerizedRuntime(): boolean {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function manifestPath(installRoot: string, name: string): string {
  return path.join(installRoot, name)
}

export function resolveNativeLiveKitServerInstallRoot(): string {
  const explicit = process.env.LIVEKIT_SERVER_INSTALL_ROOT?.trim()
  if (explicit) return path.resolve(expandHome(explicit))
  return path.join(resolveManagedInstallsRoot(), LIVEKIT_NATIVE_SERVER_ENGINE_ID)
}

export function resolveNativeLiveKitSidecarInstallRoot(): string {
  const explicit = process.env.LIVEKIT_AGENT_INSTALL_ROOT?.trim()
  if (explicit) return path.resolve(expandHome(explicit))
  return path.join(resolveManagedInstallsRoot(), LIVEKIT_NATIVE_SIDECAR_ENGINE_ID)
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function resolveOptionalEnvPath(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? path.resolve(expandHome(trimmed)) : null
}

async function resolveBundledSidecarSourceRoot(): Promise<string | null> {
  const packagedRuntimeRoot = resolveOptionalEnvPath(process.env.BATSHIT_PACKAGED_RUNTIME_ROOT)
  const macRepoRoot = resolveOptionalEnvPath(process.env.BATSHIT_MAC_REPO_ROOT)
  const repoRoot = resolveOptionalEnvPath(process.env.BATSHIT_REPO_ROOT)
  const candidates = Array.from(new Set([
    resolveOptionalEnvPath(process.env.LIVEKIT_AGENT_SOURCE_ROOT),
    packagedRuntimeRoot ? path.join(packagedRuntimeRoot, 'tools', 'livekit-agent-sidecar') : null,
    macRepoRoot ? path.join(macRepoRoot, 'tools', 'livekit-agent-sidecar') : null,
    repoRoot ? path.join(repoRoot, 'tools', 'livekit-agent-sidecar') : null,
    path.resolve(process.cwd(), '..', 'tools', 'livekit-agent-sidecar'),
    path.resolve(process.cwd(), 'tools', 'livekit-agent-sidecar')
  ].filter((entry): entry is string => Boolean(entry))))

  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, 'package.json'))) {
      return candidate
    }
  }

  return null
}

async function findFileByName(root: string, basename: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isFile() && entry.name === basename) return entryPath
    if (entry.isDirectory()) {
      const nested = await findFileByName(entryPath, basename)
      if (nested) return nested
    }
  }
  return null
}

export async function resolveNativeLiveKitServerBinaryPath(
  installRoot = resolveNativeLiveKitServerInstallRoot()
): Promise<string | null> {
  const manifest = await readJsonFile<LiveKitNativeInstallManifest>(
    manifestPath(installRoot, 'batshit-livekit-server-manifest.json')
  )
  if (manifest?.binaryPath && await fileExists(manifest.binaryPath)) {
    return manifest.binaryPath
  }
  const binaryName = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'
  return findFileByName(installRoot, binaryName)
}

async function sidecarPackageInstalled(installRoot = resolveNativeLiveKitSidecarInstallRoot()): Promise<boolean> {
  return (
    await fileExists(path.join(installRoot, 'package.json')) &&
    await fileExists(path.join(installRoot, 'node_modules', '.bin', 'tsx'))
  )
}

async function getLiveKitServerVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], { timeout: 5_000 })
    const raw = `${stdout}\n${stderr}`.trim()
    const match = raw.match(/version\s+([^\s]+)/i)
    return match?.[1]?.trim() || raw || null
  } catch {
    return null
  }
}

export async function getNativeLiveKitInstallStatus(): Promise<LiveKitNativeInstallStatus> {
  const serverInstallRoot = resolveNativeLiveKitServerInstallRoot()
  const sidecarInstallRoot = resolveNativeLiveKitSidecarInstallRoot()
  const serverManifest = await readJsonFile<LiveKitNativeInstallManifest>(
    manifestPath(serverInstallRoot, 'batshit-livekit-server-manifest.json')
  )
  const sidecarManifest = await readJsonFile<LiveKitNativeInstallManifest>(
    manifestPath(sidecarInstallRoot, 'batshit-livekit-sidecar-manifest.json')
  )
  const serverBinaryPath = await resolveNativeLiveKitServerBinaryPath(serverInstallRoot)
  const serverVersion = serverBinaryPath ? await getLiveKitServerVersion(serverBinaryPath) : null
  const serverInstalled = Boolean(serverBinaryPath && serverVersion === LIVEKIT_NATIVE_RUNTIME_VERSION)
  const sidecarInstalled = await sidecarPackageInstalled(sidecarInstallRoot)
  const supported = !isContainerizedRuntime() && process.platform !== 'win32'
  const reason = !supported
    ? 'Native LiveKit install is only supported in native macOS/Linux Batshit. Docker Batshit uses the optional LiveKit runtime add-on.'
    : serverInstalled && sidecarInstalled
      ? null
      : 'Native LiveKit runtime is not installed yet.'

  return {
    supported,
    installed: serverInstalled && sidecarInstalled,
    serverInstalled,
    sidecarInstalled,
    reason,
    version: LIVEKIT_NATIVE_RUNTIME_VERSION,
    serverInstallRoot,
    sidecarInstallRoot,
    serverBinaryPath,
    sidecarPackagePath: sidecarInstalled ? sidecarInstallRoot : null,
    serverManifest,
    sidecarManifest
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}.`)
  }
  return (await response.json()) as T
}

function parseWwwAuthenticate(value: string | null): {
  realm: string
  service: string
  scope: string
} | null {
  if (!value?.trim().toLowerCase().startsWith('bearer ')) return null
  const field = (name: string) => {
    const match = new RegExp(`${name}="([^"]+)"`).exec(value)
    return match?.[1] ?? ''
  }
  const realm = field('realm')
  const service = field('service')
  const scope = field('scope')
  return realm && service && scope ? { realm, service, scope } : null
}

async function fetchDownloadBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  try {
    let response = await fetch(url, { signal: controller.signal })
    if (response.status === 401) {
      const auth = parseWwwAuthenticate(response.headers.get('www-authenticate'))
      if (auth) {
        const tokenUrl =
          `${auth.realm}?service=${encodeURIComponent(auth.service)}&scope=${encodeURIComponent(auth.scope)}`
        const tokenResponse = await fetch(tokenUrl, { signal: controller.signal })
        const tokenPayload = (await tokenResponse.json().catch(() => null)) as Record<string, unknown> | null
        const token = cleanString(tokenPayload?.token)
        if (token) {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { authorization: `Bearer ${token}` }
          })
        }
      }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(body || `Download failed with HTTP ${response.status}.`)
    }

    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

async function getMacosBottleName(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], { timeout: 2_000 })
    const major = Number.parseInt(stdout.trim().split('.')[0] ?? '', 10)
    if (!Number.isFinite(major)) return process.arch === 'arm64' ? 'arm64_sonoma' : 'sonoma'
    const releaseNames = major >= 26
      ? ['tahoe', 'sequoia', 'sonoma']
      : major >= 15
        ? ['sequoia', 'sonoma']
        : ['sonoma']
    if (process.arch === 'arm64') return `arm64_${releaseNames[0]}`
    return 'sonoma'
  } catch {
    return process.arch === 'arm64' ? 'arm64_sonoma' : 'sonoma'
  }
}

async function resolveBottleFile(formula: HomebrewFormula): Promise<{
  tag: string
  file: HomebrewBottleFile
}> {
  const files = formula.bottle?.stable?.files ?? {}
  const candidates: string[] = []

  if (process.platform === 'darwin') {
    const macosTag = await getMacosBottleName()
    if (macosTag) candidates.push(macosTag)
    if (process.arch === 'arm64') candidates.push('arm64_sequoia', 'arm64_sonoma')
    candidates.push('sonoma')
  } else if (process.platform === 'linux') {
    if (process.arch === 'arm64') candidates.push('arm64_linux')
    if (process.arch === 'x64') candidates.push('x86_64_linux')
  }

  for (const tag of Array.from(new Set(candidates))) {
    const file = files[tag]
    if (file?.url && file.sha256) return { tag, file }
  }

  throw new Error(`No Homebrew LiveKit bottle is available for ${process.platform}/${process.arch}.`)
}

async function extractTarGz(archivePath: string, destination: string): Promise<void> {
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destination], { timeout: 120_000 })
}

async function installLiveKitServerBinary(): Promise<void> {
  const formula = await fetchJson<HomebrewFormula>(LIVEKIT_HOMEBREW_FORMULA_URL)
  const formulaVersion = cleanString(formula.versions?.stable)
  if (formulaVersion && formulaVersion !== LIVEKIT_NATIVE_RUNTIME_VERSION) {
    throw new Error(
      `Homebrew livekit is ${formulaVersion}, but Batshit pins ${LIVEKIT_NATIVE_RUNTIME_VERSION}. Update Batshit's pin before installing.`
    )
  }

  const { tag, file } = await resolveBottleFile(formula)
  const data = await fetchDownloadBuffer(file.url)
  const checksum = sha256Hex(data)
  if (checksum !== file.sha256) {
    throw new Error(`LiveKit bottle checksum mismatch. Expected ${file.sha256}, got ${checksum}.`)
  }

  const installRoot = resolveNativeLiveKitServerInstallRoot()
  const stagingRoot = `${installRoot}.tmp-${Date.now()}`
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  try {
    const archivePath = path.join(stagingRoot, `livekit-${LIVEKIT_NATIVE_RUNTIME_VERSION}.bottle.tar.gz`)
    // The LiveKit bottle bytes are verified against Homebrew's SHA-256 before this staging write.
    // codeql[js/http-to-file-access]
    await writeFile(archivePath, data)
    await extractTarGz(archivePath, stagingRoot)
    await rm(archivePath, { force: true })

    const binaryPath = await findFileByName(
      stagingRoot,
      process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'
    )
    if (!binaryPath) {
      throw new Error('LiveKit bottle did not contain a livekit-server binary.')
    }

    if (process.platform !== 'win32') {
      await chmod(binaryPath, 0o755)
    }

    const installedVersion = await getLiveKitServerVersion(binaryPath)
    if (installedVersion !== LIVEKIT_NATIVE_RUNTIME_VERSION) {
      throw new Error(
        `Installed livekit-server reported ${installedVersion ?? 'unknown'}, expected ${LIVEKIT_NATIVE_RUNTIME_VERSION}.`
      )
    }

    const finalBinaryPath = path.join(installRoot, path.relative(stagingRoot, binaryPath))
    const installedAt = new Date().toISOString()
    const manifest: LiveKitNativeInstallManifest = {
      kind: 'livekit-server',
      version: LIVEKIT_NATIVE_RUNTIME_VERSION,
      installedAt,
      installRoot,
      source: 'homebrew-bottle',
      sourceUrl: file.url,
      bottleTag: tag,
      checksumAlgorithm: 'sha256',
      checksum: file.sha256,
      checksumVerified: true,
      binaryPath: finalBinaryPath
    }
    // The manifest records the verified install metadata inside the private staging directory.
    // codeql[js/http-to-file-access]
    await writeFile(
      manifestPath(stagingRoot, 'batshit-livekit-server-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    )

    await rm(installRoot, { recursive: true, force: true })
    await rename(stagingRoot, installRoot)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function installLiveKitSidecarPackage(): Promise<void> {
  const sourceRoot = await resolveBundledSidecarSourceRoot()
  if (!sourceRoot) {
    throw new Error(
      'Batshit could not find the bundled LiveKit sidecar source package. Rebuild or reinstall Batshit, or configure LIVEKIT_AGENT_SOURCE_ROOT.'
    )
  }

  const installRoot = resolveNativeLiveKitSidecarInstallRoot()
  const stagingRoot = `${installRoot}.tmp-${Date.now()}`
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  try {
    await cp(path.join(sourceRoot, 'package.json'), path.join(stagingRoot, 'package.json'))
    if (await fileExists(path.join(sourceRoot, 'package-lock.json'))) {
      await cp(path.join(sourceRoot, 'package-lock.json'), path.join(stagingRoot, 'package-lock.json'))
    }
    await cp(path.join(sourceRoot, 'tsconfig.json'), path.join(stagingRoot, 'tsconfig.json'))
    await cp(path.join(sourceRoot, 'src'), path.join(stagingRoot, 'src'), { recursive: true })

    await execFileAsync('npm', ['ci'], {
      cwd: stagingRoot,
      timeout: NPM_INSTALL_TIMEOUT_MS
    })

    const installedAt = new Date().toISOString()
    const manifest: LiveKitNativeInstallManifest = {
      kind: 'livekit-sidecar',
      version: LIVEKIT_NATIVE_RUNTIME_VERSION,
      installedAt,
      installRoot,
      source: 'batshit-bundled-sidecar',
      packageManager: 'npm'
    }
    await writeFile(
      manifestPath(stagingRoot, 'batshit-livekit-sidecar-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    )

    await rm(installRoot, { recursive: true, force: true })
    await rename(stagingRoot, installRoot)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function ensureLocalLiveKitCredentials(userId: string): Promise<{
  serverUrl: string
  apiKey: string
  apiSecret: string
  saved: boolean
}> {
  const [savedUrl, savedApiKey, savedApiSecret] = await Promise.all([
    apiKeyService.retrieve('livekit_url', userId).catch(() => null),
    apiKeyService.retrieve('livekit_api_key', userId).catch(() => null),
    apiKeyService.retrieve('livekit_api_secret', userId).catch(() => null)
  ])

  if (savedUrl?.trim() && savedApiKey?.trim() && savedApiSecret?.trim()) {
    return {
      serverUrl: savedUrl.trim(),
      apiKey: savedApiKey.trim(),
      apiSecret: savedApiSecret.trim(),
      saved: false
    }
  }

  const apiSecret = randomBytes(24).toString('hex')
  await Promise.all([
    apiKeyService.store('livekit_url', LIVEKIT_DEFAULT_LOCAL_URL, userId),
    apiKeyService.store('livekit_api_key', LIVEKIT_DEFAULT_LOCAL_API_KEY, userId),
    apiKeyService.store('livekit_api_secret', apiSecret, userId)
  ])

  return {
    serverUrl: LIVEKIT_DEFAULT_LOCAL_URL,
    apiKey: LIVEKIT_DEFAULT_LOCAL_API_KEY,
    apiSecret,
    saved: true
  }
}

export async function installNativeLiveKitRuntime(
  userId: string
): Promise<LiveKitNativeInstallResult> {
  if (isContainerizedRuntime()) {
    throw new Error(
      'Dockerized Batshit uses the optional LiveKit runtime add-on instead of native install.'
    )
  }

  const before = await getNativeLiveKitInstallStatus()
  if (!before.supported) {
    throw new Error(before.reason ?? 'Native LiveKit runtime install is not supported here.')
  }

  if (!before.serverInstalled) {
    await installLiveKitServerBinary()
  }
  if (!before.sidecarInstalled) {
    await installLiveKitSidecarPackage()
  }

  const credentials = await ensureLocalLiveKitCredentials(userId)
  const status = await getNativeLiveKitInstallStatus()

  return {
    installed: status.installed,
    credentialsSaved: credentials.saved,
    status,
    serverUrl: credentials.serverUrl,
    apiKey: credentials.apiKey
  }
}

export function getLocalLiveKitPort(serverUrl: string): number | null {
  try {
    const parsed = new URL(serverUrl)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    if (!local) return null
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : LIVEKIT_DEFAULT_HTTP_PORT
    return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

export function liveKitServerHttpUrl(serverUrl: string, port: number): string {
  try {
    const parsed = new URL(serverUrl)
    parsed.protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:'
    parsed.hostname = parsed.hostname || '127.0.0.1'
    parsed.port = String(port)
    parsed.pathname = '/'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return `http://127.0.0.1:${port}`
  }
}

export async function fetchLiveKitServerReady(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/plain,application/json' }
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function inspectLocalLiveKitPortOwner(port: number): Promise<LiveKitLocalPortOwner> {
  if (process.platform === 'win32') {
    return { pids: [], commands: [], dockerOwned: false }
  }

  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-F',
      'pc'
    ])
    const pids: number[] = []
    const commands: string[] = []

    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const field = line.slice(0, 1)
      const value = line.slice(1).trim()

      if (field === 'p') {
        const pid = Number.parseInt(value, 10)
        if (Number.isFinite(pid) && pid > 0) pids.push(pid)
      } else if (field === 'c' && value) {
        commands.push(value)
      }
    }

    return {
      pids: Array.from(new Set(pids)),
      commands: Array.from(new Set(commands)),
      dockerOwned: commands.some((command) => /docker|com\.docker/i.test(command))
    }
  } catch {
    return { pids: [], commands: [], dockerOwned: false }
  }
}

export async function waitForLiveKitServerReady(url: string): Promise<boolean> {
  const deadline = Date.now() + LIVEKIT_READY_TIMEOUT_MS
  let ready = await fetchLiveKitServerReady(url)
  while (!ready && Date.now() < deadline) {
    await sleep(LIVEKIT_READY_POLL_MS)
    ready = await fetchLiveKitServerReady(url)
  }
  return ready
}

export async function startNativeLiveKitServerRuntime(options: {
  userId: string
  serverUrl: string
  apiKey: string
  apiSecret: string
}): Promise<LiveKitNativeServerStartResult> {
  if (isContainerizedRuntime()) {
    throw new Error('Dockerized Batshit starts LiveKit through the runtime add-on operator.')
  }

  const port = getLocalLiveKitPort(options.serverUrl)
  if (!port) {
    return {
      started: false,
      alreadyRunning: true,
      pid: null,
      logPath: null,
      statusHint: 'LiveKit server is externally managed.'
    }
  }

  const url = liveKitServerHttpUrl(options.serverUrl, port)
  if (await fetchLiveKitServerReady(url)) {
    const owner = await inspectLocalLiveKitPortOwner(port)
    if (owner.dockerOwned) {
      throw new Error(
        `Native LiveKit cannot start because port ${port} is already owned by Docker (${owner.commands.join(', ') || 'docker process'}). Stop the Docker LiveKit container or change the saved LiveKit URL before starting the native runtime.`
      )
    }

    return {
      started: false,
      alreadyRunning: true,
      pid: null,
      logPath: null,
      statusHint: `Local LiveKit server is reachable at ${url}.`
    }
  }

  const status = await getNativeLiveKitInstallStatus()
  if (!status.serverInstalled || !status.serverBinaryPath) {
    throw new Error('Native LiveKit server is not installed yet.')
  }

  const rtcTcpPort = Number(process.env.LIVEKIT_SERVER_RTC_TCP_PORT || process.env.LIVEKIT_RTC_TCP_PORT) ||
    defaultRtcPortForHttp(port, LIVEKIT_DEFAULT_RTC_TCP_PORT)
  const rtcUdpPort = Number(process.env.LIVEKIT_SERVER_RTC_UDP_PORT || process.env.LIVEKIT_RTC_UDP_PORT) ||
    defaultRtcPortForHttp(port, LIVEKIT_DEFAULT_RTC_UDP_PORT)

  const launched = await startLocalVoiceRuntime({
    userId: options.userId,
    engineId: LIVEKIT_NATIVE_SERVER_ENGINE_ID,
    installRoot: status.serverInstallRoot,
    installOwnership: 'batshit-managed',
    launch: {
      command: status.serverBinaryPath,
      args: [
        '--dev',
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--rtc.tcp_port',
        String(rtcTcpPort),
        '--udp-port',
        String(rtcUdpPort),
        '--keys',
        `${options.apiKey}: ${options.apiSecret}`
      ],
      unsetEnv: LIVEKIT_REDIS_ENV_TO_UNSET
    }
  })

  const ready = await waitForLiveKitServerReady(url)
  return {
    started: ready,
    alreadyRunning: false,
    pid: launched.pid,
    logPath: launched.logPath,
    statusHint: ready
      ? `Native LiveKit server is reachable at ${url}.`
      : 'Batshit launched the native LiveKit server, but it did not become reachable before timeout.'
  }
}

function defaultRtcPortForHttp(httpPort: number, defaultPort: number): number {
  if (httpPort === LIVEKIT_DEFAULT_HTTP_PORT) return defaultPort
  return httpPort + (defaultPort - LIVEKIT_DEFAULT_HTTP_PORT)
}
