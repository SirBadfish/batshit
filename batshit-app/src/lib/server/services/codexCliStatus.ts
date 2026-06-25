import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '$env/dynamic/private'
import {
  getManagedCliExecutableSync,
  resolveManagedCliShimPath
} from '$lib/server/services/managedCliInstaller'

const execFileAsync = promisify(execFile)

/** Which lookup step produced the resolved CLI executable. */
export type CliResolutionSource = 'env' | 'managed' | 'path' | 'well-known' | 'not-found'

export interface CliExecutableResolution {
  executable: string
  source: CliResolutionSource
  managedVersion?: string
}

export interface CodexCliStatus {
  available: boolean
  installed?: boolean
  authenticated?: boolean
  version?: string
  error?: string
  setupCommand?: string
  statusCommand?: string
  setupContext?: 'docker' | 'native'
  setupWorkingDirectory?: string
  executable?: string
  /** How the executable was found: env override, Batshit-managed install, PATH, or well-known location. */
  source?: CliResolutionSource
}

export interface CodexCliStatusOptions {
  codexHome?: string | null
  transientRetries?: number
}

export interface CodexLoginCommandRuntime {
  containerized?: boolean
  n8nApiUrl?: string | null
  composeProfiles?: string | null
  /** Absolute executable path to embed in commands (used for managed installs not on PATH). */
  executablePath?: string | null
}

export interface CodexLoginCommands {
  context: 'docker' | 'native'
  loginCommand: string
  statusCommand: string
}

export async function detectCodexCliStatus(options: CodexCliStatusOptions = {}): Promise<CodexCliStatus> {
  const execEnv = buildCodexExecEnv(options.codexHome)
  const resolution = resolveCodexCliExecutableDetailed(execEnv)
  const codexExecutable = resolution.executable
  const commands = buildCodexLoginCommands({
    executablePath: resolution.source === 'managed' ? resolveManagedCliShimPath('codex') : null
  })

  try {
    const { stdout } = await execFileAsync(codexExecutable, ['--version'], {
      env: execEnv,
      timeout: 4000
    })

    const version = stdout?.trim() || undefined

    try {
      const loginStatus = await execCodexLoginStatusWithRetry(
        codexExecutable,
        execEnv,
        options.transientRetries ?? 2
      )
      const statusText = `${loginStatus.stdout ?? ''}\n${loginStatus.stderr ?? ''}`.toLowerCase()

      if (isCodexLoginStatusAuthenticated(statusText)) {
        return {
          available: true,
          installed: true,
          authenticated: true,
          version,
          statusCommand: commands.statusCommand,
          setupContext: commands.context,
          setupWorkingDirectory: resolveCliSetupWorkingDirectory(commands.context),
          executable: codexExecutable,
          source: resolution.source
        }
      }

      return buildLoggedOutStatus({
        version,
        commands,
        executable: codexExecutable,
        source: resolution.source
      })
    } catch (error: any) {
      return buildLoggedOutStatus({
        version,
        commands,
        executable: codexExecutable,
        source: resolution.source,
        detail: normalizeCodexError(error)
      })
    }
  } catch (error: any) {
    const errorMessage = normalizeCodexError(error)
    return {
      available: false,
      installed: false,
      authenticated: false,
      error: errorMessage,
      setupContext: commands.context,
      setupWorkingDirectory: resolveCliSetupWorkingDirectory(commands.context),
      executable: codexExecutable,
      source: resolution.source
    }
  }
}

function buildCodexExecEnv(codexHome?: string | null): NodeJS.ProcessEnv {
  const execEnv: NodeJS.ProcessEnv = { ...process.env }
  const trimmedHome = typeof codexHome === 'string' ? codexHome.trim() : ''
  if (trimmedHome) {
    execEnv.CODEX_HOME = trimmedHome
  }
  return execEnv
}

/**
 * Resolution order: explicit env override → Batshit-managed install → PATH →
 * well-known locations. Reports which step won so the UI can show the source.
 */
export function resolveCodexCliExecutableDetailed(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): CliExecutableResolution {
  const configured =
    sourceEnv.BATSHIT_CODEX_CLI_PATH?.trim() || sourceEnv.CODEX_CLI_PATH?.trim()
  if (configured && isExecutableFile(configured)) {
    return { executable: configured, source: 'env' }
  }

  const managed = getManagedCliExecutableSync('codex')
  if (managed) {
    return {
      executable: managed.executablePath,
      source: 'managed',
      managedVersion: managed.version
    }
  }

  const pathExecutable = findExecutableOnPath('codex', sourceEnv.PATH)
  if (pathExecutable) {
    return { executable: pathExecutable, source: 'path' }
  }

  for (const candidate of getCodexCliExecutableCandidates(home)) {
    if (isExecutableFile(candidate)) {
      return { executable: candidate, source: 'well-known' }
    }
  }

  return { executable: 'codex', source: 'not-found' }
}

export function resolveCodexCliExecutable(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): string {
  return resolveCodexCliExecutableDetailed(sourceEnv, home).executable
}

export function getCodexCliExecutableCandidates(home = os.homedir()): string[] {
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    joinHomePath(home, '.local', 'bin', 'codex'),
    joinHomePath(home, '.volta', 'bin', 'codex'),
    ...getNvmCodexCandidates(home),
    '/Applications/Codex.app/Contents/Resources/codex'
  ]

  return Array.from(new Set(candidates))
}

function getNvmCodexCandidates(home: string): string[] {
  const versionsRoot = joinHomePath(home, '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsRoot)
      .sort()
      .reverse()
      .map((entry) => joinHomePath(versionsRoot, entry, 'bin', 'codex'))
  } catch {
    return []
  }
}

function joinHomePath(home: string, ...segments: string[]): string {
  return home.startsWith('/') ? path.posix.join(home, ...segments) : path.join(home, ...segments)
}

function findExecutableOnPath(command: string, pathValue?: string): string | null {
  for (const entry of String(pathValue || '').split(path.delimiter)) {
    if (!entry) continue
    const candidate = path.join(entry, command)
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return null
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function execCodexLoginStatusWithRetry(
  codexExecutable: string,
  env: NodeJS.ProcessEnv,
  retries: number
) {
  let lastError: unknown
  const attempts = Math.max(1, retries + 1)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await execFileAsync(codexExecutable, ['login', 'status'], {
        env,
        timeout: 4000
      })
    } catch (error) {
      lastError = error
      if (!isTransientCodexConfigError(error) || attempt >= attempts - 1) {
        throw error
      }
      await wait(150 * (attempt + 1))
    }
  }

  throw lastError
}

function isTransientCodexConfigError(error: unknown) {
  const message = normalizeCodexError(error).toLowerCase()
  return (
    message.includes('error loading configuration') &&
    (message.includes('no such file or directory') || message.includes('os error 2'))
  )
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function buildCodexLoginCommands(runtime: CodexLoginCommandRuntime = {}): CodexLoginCommands {
  const containerized =
    runtime.containerized ??
    ['1', 'true', 'yes'].includes((env.BATSHIT_CONTAINERIZED ?? '').trim().toLowerCase())

  // Managed installs are not on PATH, so login/status commands must reference
  // the stable managed executable path instead of a bare `codex`.
  const executable = runtime.executablePath?.trim() || 'codex'

  if (!containerized) {
    return {
      context: 'native',
      loginCommand: `${executable} login`,
      statusCommand: `${executable} login status`
    }
  }

  const profileArgs = shouldIncludeN8nProfile(runtime) ? ' --profile n8n' : ''
  const composePrefix = `docker compose --env-file .env.docker${profileArgs} exec app`

  return {
    context: 'docker',
    loginCommand: `${composePrefix} ${executable} login --device-auth`,
    statusCommand: `${composePrefix} ${executable} login status`
  }
}

export function resolveDockerComposeWorkingDirectory(
  sourceEnv: Record<string, string | undefined> = env
): string | undefined {
  const candidates = [
    sourceEnv.BATSHIT_DOCKER_PROJECT_DIR,
    sourceEnv.BATSHIT_COMPOSE_PROJECT_DIR,
    sourceEnv.BATSHIT_WORKSPACE_MOUNT
  ]

  for (const candidate of candidates) {
    const value = unwrapEnvPath(candidate)
    if (value) return value
  }

  return undefined
}

function resolveCliSetupWorkingDirectory(context: 'docker' | 'native'): string | undefined {
  return context === 'docker' ? resolveDockerComposeWorkingDirectory() : undefined
}

function unwrapEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined
  }
  return trimmed
}

function shouldIncludeN8nProfile(runtime: CodexLoginCommandRuntime) {
  const profiles = (runtime.composeProfiles ?? env.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  if (profiles.includes('n8n')) return true

  const n8nApiUrl = (runtime.n8nApiUrl ?? env.N8N_API_URL ?? '').trim().toLowerCase()
  return /^https?:\/\/n8n(?::|\/|$)/.test(n8nApiUrl)
}

export function isCodexLoginStatusAuthenticated(statusText: string) {
  const normalized = statusText.trim().toLowerCase()
  if (!normalized) return false
  if (/\bnot\s+logged\s+in\b/.test(normalized)) return false
  return /\blogged\s+in\b/.test(normalized)
}

function buildLoggedOutStatus({
  version,
  commands,
  executable,
  source,
  detail
}: {
  version?: string
  commands: CodexLoginCommands
  executable?: string
  source?: CliResolutionSource
  detail?: string
}): CodexCliStatus {
  return {
    available: false,
    installed: true,
    authenticated: false,
    version,
    error: buildNotLoggedInMessage(commands.loginCommand, detail),
    setupCommand: commands.loginCommand,
    statusCommand: commands.statusCommand,
    setupContext: commands.context,
    setupWorkingDirectory: resolveCliSetupWorkingDirectory(commands.context),
    executable,
    source
  }
}

function buildNotLoggedInMessage(command: string, detail?: string) {
  const normalized = detail?.trim()
  const suffix = normalized && normalized !== 'Not logged in' ? ` (${normalized})` : ''
  return `Codex CLI is installed but not logged in${suffix}. Run: ${command}`
}

const CODEX_NOT_DETECTED_MESSAGE =
  'Codex CLI not detected. Use the one-click install in Agent Settings, or install it yourself with `npm i -g @openai/codex`, then run `codex login`.'

function normalizeCodexError(error: any): string {
  if (!error) return CODEX_NOT_DETECTED_MESSAGE

  if (error.code === 'ENOENT') {
    return CODEX_NOT_DETECTED_MESSAGE
  }

  if (typeof error.stderr === 'string' && error.stderr.trim().length > 0) {
    return error.stderr.trim()
  }

  if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
    return error.stdout.trim()
  }

  if (typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return CODEX_NOT_DETECTED_MESSAGE
}
