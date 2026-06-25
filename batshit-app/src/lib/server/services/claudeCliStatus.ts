import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '$env/dynamic/private'

import {
  getManagedCliExecutableSync,
} from '$lib/server/services/managedCliInstaller'
import {
  resolveDockerComposeWorkingDirectory,
  type CliExecutableResolution,
  type CliResolutionSource
} from '$lib/server/services/codexCliStatus'
import {
  buildClaudeChildEnv,
  buildClaudeChildProcessOptions,
  buildClaudeDockerExecOptions,
  resolveClaudeRunAsIdentity
} from '$lib/server/services/claudeRuntimeUser'

const execFileAsync = promisify(execFile)

export interface ClaudeCliStatus {
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

export interface ClaudeLoginCommandRuntime {
  containerized?: boolean
  n8nApiUrl?: string | null
  composeProfiles?: string | null
  /** Absolute executable path to embed in commands (used for managed installs not on PATH). */
  executablePath?: string | null
  runAsUser?: string | null
  runAsUid?: number | null
  runAsGid?: number | null
  runAsHome?: string | null
}

export interface ClaudeLoginCommands {
  context: 'docker' | 'native'
  loginCommand: string
  statusCommand: string
}

/**
 * Resolution order matches Codex: explicit env override → Batshit-managed
 * install → PATH → well-known locations.
 */
export function resolveClaudeCliExecutableDetailed(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): CliExecutableResolution {
  const configured =
    sourceEnv.BATSHIT_CLAUDE_CLI_PATH?.trim() || sourceEnv.CLAUDE_CLI_PATH?.trim()
  if (configured && isExecutableFile(configured)) {
    return { executable: configured, source: 'env' }
  }

  const managed = getManagedCliExecutableSync('claude')
  if (managed) {
    return {
      executable: managed.executablePath,
      source: 'managed',
      managedVersion: managed.version
    }
  }

  const pathExecutable = findExecutableOnPath('claude', sourceEnv.PATH)
  if (pathExecutable) {
    return { executable: pathExecutable, source: 'path' }
  }

  for (const candidate of getClaudeCliExecutableCandidates(home)) {
    if (isExecutableFile(candidate)) {
      return { executable: candidate, source: 'well-known' }
    }
  }

  return { executable: 'claude', source: 'not-found' }
}

export function resolveClaudeCliExecutable(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): string {
  return resolveClaudeCliExecutableDetailed(sourceEnv, home).executable
}

export function getClaudeCliExecutableCandidates(home = os.homedir()): string[] {
  const candidates = [
    joinHomePath(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    joinHomePath(home, '.claude', 'local', 'claude'),
    joinHomePath(home, '.volta', 'bin', 'claude'),
    ...getNvmClaudeCandidates(home)
  ]

  return Array.from(new Set(candidates))
}

function getNvmClaudeCandidates(home: string): string[] {
  const versionsRoot = joinHomePath(home, '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsRoot)
      .sort()
      .reverse()
      .map((entry) => joinHomePath(versionsRoot, entry, 'bin', 'claude'))
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

export async function detectClaudeCliStatus(): Promise<ClaudeCliStatus> {
  const runAsIdentity = resolveClaudeRunAsIdentity()
  const execEnv = buildClaudeChildEnv(process.env, runAsIdentity)
  const childProcessOptions = buildClaudeChildProcessOptions(runAsIdentity)
  const resolution = resolveClaudeCliExecutableDetailed(execEnv, runAsIdentity.home ?? os.homedir())
  const commands = buildClaudeLoginCommands({
    executablePath: resolution.source === 'managed' ? resolution.executable : null,
    runAsUser: runAsIdentity.user,
    runAsUid: runAsIdentity.uid,
    runAsGid: runAsIdentity.gid,
    runAsHome: runAsIdentity.home
  })
  const setupWorkingDirectory = resolveCliSetupWorkingDirectory(commands.context)

  let version: string | undefined
  try {
    const { stdout } = await execFileAsync(resolution.executable, ['--version'], {
      env: execEnv,
      ...childProcessOptions,
      timeout: 4000
    })
    version = stdout?.trim() || undefined
  } catch (error: any) {
    const errorMessage = normalizeClaudeError(error)
    return {
      available: false,
      installed: false,
      authenticated: false,
      error: errorMessage,
      setupContext: commands.context,
      setupWorkingDirectory,
      executable: resolution.executable,
      source: resolution.source
    }
  }

  try {
    const status = await execFileAsync(resolution.executable, ['auth', 'status', '--json'], {
      env: execEnv,
      ...childProcessOptions,
      timeout: 4000
    })
    const statusText = `${status.stdout ?? ''}\n${status.stderr ?? ''}`.toLowerCase()
    if (isClaudeStatusAuthenticated(statusText)) {
      return {
        available: true,
        installed: true,
        authenticated: true,
        version,
        statusCommand: commands.statusCommand,
        setupContext: commands.context,
        setupWorkingDirectory,
        executable: resolution.executable,
        source: resolution.source
      }
    }

    return buildLoggedOutStatus({
      version,
      commands,
      setupWorkingDirectory,
      executable: resolution.executable,
      source: resolution.source,
      detail: statusText
    })
  } catch (error: any) {
    const statusText = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.toLowerCase()
    if (isClaudeStatusAuthenticated(statusText)) {
      return {
        available: true,
        installed: true,
        authenticated: true,
        version,
        statusCommand: commands.statusCommand,
        setupContext: commands.context,
        setupWorkingDirectory,
        executable: resolution.executable,
        source: resolution.source
      }
    }

    return buildLoggedOutStatus({
      version,
      commands,
      setupWorkingDirectory,
      executable: resolution.executable,
      source: resolution.source,
      detail: normalizeClaudeError(error)
    })
  }
}

export function buildClaudeLoginCommands(runtime: ClaudeLoginCommandRuntime = {}): ClaudeLoginCommands {
  const containerized =
    runtime.containerized ??
    ['1', 'true', 'yes'].includes((env.BATSHIT_CONTAINERIZED ?? '').trim().toLowerCase())
  const executable = runtime.executablePath?.trim() || 'claude'

  if (!containerized) {
    return {
      context: 'native',
      loginCommand: `${executable} auth login`,
      statusCommand: `${executable} auth status --text`
    }
  }

  const profileArgs = shouldIncludeN8nProfile(runtime) ? ' --profile n8n' : ''
  const runtimeRunAsIdentity = {
    ...(runtime.runAsUser ? { user: runtime.runAsUser } : {}),
    ...(runtime.runAsUid !== null && runtime.runAsUid !== undefined ? { uid: runtime.runAsUid } : {}),
    ...(runtime.runAsGid !== null && runtime.runAsGid !== undefined ? { gid: runtime.runAsGid } : {}),
    ...(runtime.runAsHome ? { home: runtime.runAsHome } : {}),
    ...(runtime.runAsHome || runtime.runAsUser ? { shell: '/bin/sh' } : {})
  }
  const hasRuntimeRunAs = Boolean(
    runtime.runAsUser ||
    (runtime.runAsUid !== null && runtime.runAsUid !== undefined) ||
    (runtime.runAsGid !== null && runtime.runAsGid !== undefined) ||
    runtime.runAsHome
  )
  const runAsOptions = buildClaudeDockerExecOptions(
    hasRuntimeRunAs ? runtimeRunAsIdentity : resolveClaudeRunAsIdentity()
  )
  const composeExecOptions = runAsOptions ? ` ${runAsOptions}` : ''
  const composePrefix = `docker compose --env-file .env.docker${profileArgs} exec${composeExecOptions} app`

  return {
    context: 'docker',
    loginCommand: `${composePrefix} ${executable} auth login`,
    statusCommand: `${composePrefix} ${executable} auth status --text`
  }
}

function shouldIncludeN8nProfile(runtime: ClaudeLoginCommandRuntime) {
  const profiles = (runtime.composeProfiles ?? env.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  if (profiles.includes('n8n')) return true

  const n8nApiUrl = (runtime.n8nApiUrl ?? env.N8N_API_URL ?? '').trim().toLowerCase()
  return /^https?:\/\/n8n(?::|\/|$)/.test(n8nApiUrl)
}

function resolveCliSetupWorkingDirectory(context: 'docker' | 'native'): string | undefined {
  return context === 'docker' ? resolveDockerComposeWorkingDirectory() : undefined
}

export function isClaudeStatusAuthenticated(statusText: string) {
  const normalized = statusText.trim().toLowerCase()
  if (!normalized) return false
  const parsed = parseClaudeAuthStatus(statusText)
  if (typeof parsed?.loggedIn === 'boolean') return parsed.loggedIn
  if (/\bnot\s+logged\s+in\b/.test(normalized)) return false
  if (/\bplease\s+run\s+\/?login\b/.test(normalized)) return false
  return /\blogged\s+in\b|\bauthenticated\b|\baccount\b/.test(normalized)
}

function isClaudeStatusLoggedOut(statusText: string) {
  const normalized = statusText.trim().toLowerCase()
  const parsed = parseClaudeAuthStatus(statusText)
  if (typeof parsed?.loggedIn === 'boolean') return !parsed.loggedIn
  return (
    /\bnot\s+logged\s+in\b/.test(normalized) ||
    /\bplease\s+run\s+\/?login\b/.test(normalized)
  )
}

function normalizeClaudeAuthStatus(parsed: unknown): { loggedIn?: boolean } | null {
  if (!parsed || typeof parsed !== 'object') return null

  const record = parsed as Record<string, unknown>
  const loggedIn = record.loggedIn ?? record.loggedin
  if (typeof loggedIn === 'boolean') {
    return { loggedIn }
  }

  return {}
}

function parseClaudeAuthStatus(statusText: string): { loggedIn?: boolean } | null {
  const trimmed = statusText.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    return normalizeClaudeAuthStatus(parsed)
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0])
      return normalizeClaudeAuthStatus(parsed)
    } catch {
      return null
    }
  }
}

function buildLoggedOutStatus({
  version,
  commands,
  setupWorkingDirectory,
  executable,
  source,
  detail
}: {
  version?: string
  commands: ClaudeLoginCommands
  setupWorkingDirectory?: string
  executable?: string
  source?: CliResolutionSource
  detail?: string
}): ClaudeCliStatus {
  return {
    available: false,
    installed: true,
    authenticated: false,
    version,
    error: buildNotLoggedInMessage(commands.loginCommand, detail),
    setupCommand: commands.loginCommand,
    statusCommand: commands.statusCommand,
    setupContext: commands.context,
    setupWorkingDirectory,
    executable,
    source
  }
}

function buildNotLoggedInMessage(command: string, detail?: string) {
  const normalized = detail?.trim()
  const suffix = normalized && !isClaudeStatusLoggedOut(normalized) ? ` (${normalized})` : ''
  return `Claude Code CLI is installed but not logged in${suffix}. Run: ${command}`
}

const CLAUDE_NOT_DETECTED_MESSAGE =
  'Claude Code CLI not detected. Use the one-click install in Agent Settings, or install it yourself, then run `claude auth login`.'

function normalizeClaudeError(error: any): string {
  if (!error) {
    return CLAUDE_NOT_DETECTED_MESSAGE
  }

  if (error.code === 'ENOENT') {
    return CLAUDE_NOT_DETECTED_MESSAGE
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

  return CLAUDE_NOT_DETECTED_MESSAGE
}
