import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdir, realpath, stat } from 'node:fs/promises'

const APPLE_CONTAINER_SANDBOX_NAME_PREFIX = 'batshit-apple-sandbox-'
const APPLE_CONTAINER_SANDBOX_NETWORK =
  process.env.BATSHIT_APPLE_CONTAINER_SANDBOX_NETWORK || 'batshit-apple-sandbox-internal'
const APPLE_CONTAINER_SANDBOX_IMAGE =
  process.env.BATSHIT_APPLE_CONTAINER_SANDBOX_IMAGE || 'bash:5.2'
const APPLE_CONTAINER_SANDBOX_CPUS =
  process.env.BATSHIT_APPLE_CONTAINER_SANDBOX_CPUS || '1'
const APPLE_CONTAINER_SANDBOX_MEMORY =
  process.env.BATSHIT_APPLE_CONTAINER_SANDBOX_MEMORY || '256M'
const APPLE_CONTAINER_STATUS_TIMEOUT_MS = 10_000
const APPLE_CONTAINER_START_TIMEOUT_MS = 120_000
const APPLE_CONTAINER_CREATE_TIMEOUT_MS = 90_000
const APPLE_CONTAINER_CLEANUP_TIMEOUT_MS = 30_000
const APPLE_CONTAINER_MAX_OUTPUT_CHARS = 120_000
const APPLE_CONTAINER_INSTALL_URL = 'https://github.com/apple/container/releases/latest'

export interface AppleContainerCommandRun {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  truncated: boolean
}

export interface AppleContainerSandboxStatus {
  available: boolean
  installed: boolean
  supported: boolean
  backend: 'apple_container'
  driver: 'apple_container'
  version: string | null
  network: string
  image: string
  policy: 'internal-network'
  reason: string | null
  installUrl: string
  capabilities: Array<'status' | 'recover' | 'execute' | 'cleanup'>
}

export interface AppleContainerSandboxExecuteOptions {
  userId?: string
  sessionId?: string | null
  workspaceRoot: string
  cwd: string
  command: string
  timeoutMs: number
  maxOutputChars?: number
  env?: Record<string, string>
}

export type AppleContainerSandboxExecuteResult =
  | { ok: true; run: AppleContainerCommandRun; sandboxName: string; cleanupWarnings: string[] }
  | { ok: false; reason: string; sandboxName?: string }

type AppleContainerCommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string
    timeoutMs?: number
    maxOutputChars?: number
    env?: Record<string, string>
  }
) => Promise<AppleContainerCommandRun>

let commandRunnerOverride: AppleContainerCommandRunner | null = null
let platformOverride: NodeJS.Platform | null = null

export function __setAppleContainerCommandRunnerForTests(
  runner: AppleContainerCommandRunner | null
) {
  commandRunnerOverride = runner
}

export function __setAppleContainerPlatformForTests(platform: NodeJS.Platform | null) {
  platformOverride = platform
}

function currentPlatform() {
  return platformOverride ?? process.platform
}

function truncateOutput(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return {
    value: `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`,
    truncated: true
  }
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: Parameters<AppleContainerCommandRunner>[2] = {}
): Promise<AppleContainerCommandRun> {
  const startedAt = Date.now()
  const maxOutputChars = options.maxOutputChars ?? APPLE_CONTAINER_MAX_OUTPUT_CHARS

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      const out = truncateOutput(stdout, maxOutputChars)
      const err = truncateOutput(stderr, maxOutputChars)
      resolve({
        command: `${command} ${args.join(' ')}`.trim(),
        stdout: out.value,
        stderr: err.value,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated: out.truncated || err.truncated
      })
    }

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
            setTimeout(() => {
              if (!settled) child.kill('SIGKILL')
            }, 1_000).unref()
          }, options.timeoutMs)
        : null
    timeout?.unref()

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      stderr += error.message
      if (timeout) clearTimeout(timeout)
      finish(1, null)
    })
    child.on('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      finish(code, signal)
    })
  })
}

async function runContainer(
  args: string[],
  options: Parameters<AppleContainerCommandRunner>[2] = {}
) {
  const runner = commandRunnerOverride ?? defaultCommandRunner
  return await runner('container', args, options)
}

function commandFailedReason(run: AppleContainerCommandRun, fallback: string) {
  if (run.timedOut) return `${fallback} timed out.`
  return run.stderr.trim() || run.stdout.trim() || fallback
}

function sessionHash(sessionId: string) {
  return createHash('sha1').update(sessionId).digest('hex').slice(0, 8)
}

function workspaceHash(workspaceRoot: string) {
  return createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 10)
}

// ~/.batshit holds managed engine installs, tools, and runtime state. Mounting it
// into sandboxes lets installer flows (for example voice-engine setup) run without
// Dangerous mode. Policy guards still protect the system-skill cache inside it.
export async function ensureBatshitHomeSandboxMountPath(): Promise<string> {
  const batshitHome = path.join(os.homedir(), '.batshit')
  await mkdir(batshitHome, { recursive: true })
  return batshitHome
}

export function isPathInsideSandboxRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function buildAppleContainerSandboxName(options: {
  userId?: string
  workspaceRoot: string
  sessionId?: string | null
}) {
  const userPrefix =
    typeof options.userId === 'string' && options.userId.trim().length > 0
      ? options.userId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 20)
      : 'user'
  const sessionSegment =
    typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? `s${sessionHash(options.sessionId.trim())}-`
      : ''
  return `${APPLE_CONTAINER_SANDBOX_NAME_PREFIX}${userPrefix}-${sessionSegment}${workspaceHash(
    options.workspaceRoot
  )}`
}

function isManagedAppleContainerSandboxName(name: string) {
  return name.startsWith(APPLE_CONTAINER_SANDBOX_NAME_PREFIX)
}

async function resolveDirectory(value: string, label: string) {
  const details = await stat(value).catch(() => null)
  if (!details?.isDirectory()) {
    throw new Error(`${label} is not a readable directory: ${path.resolve(value)}`)
  }
  return await realpath(value)
}

function isPathWithinRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveWorkspace(options: { workspaceRoot: string; cwd: string }) {
  const workspaceRoot = await resolveDirectory(options.workspaceRoot, 'workspaceRoot')
  const cwd = await resolveDirectory(options.cwd || options.workspaceRoot, 'cwd')
  if (!isPathWithinRoot(cwd, workspaceRoot)) {
    throw new Error('cwd must stay inside workspaceRoot for Apple Container sandbox execution.')
  }
  return { workspaceRoot, cwd }
}

type AppleContainerListEntry = {
  id?: string
  state?: string
  status?: string
  configuration?: { id?: string }
}

function parseJsonList<T>(output: string): T[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : []
}

function getContainerEntryId(entry: AppleContainerListEntry) {
  return entry.id ?? entry.configuration?.id ?? ''
}

function getContainerEntryState(entry: AppleContainerListEntry) {
  return (entry.state ?? entry.status ?? '').toLowerCase()
}

async function listAppleContainers() {
  const run = await runContainer(['list', '--format', 'json', '--all'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (run.exitCode !== 0 || run.timedOut) {
    throw new Error(commandFailedReason(run, 'Failed to list Apple containers.'))
  }
  return parseJsonList<AppleContainerListEntry>(run.stdout)
}

function isAppleContainerSystemRunning(run: AppleContainerCommandRun) {
  return run.exitCode === 0 && !run.timedOut && run.stdout.includes('running')
}

async function ensureAppleContainerSystem(options: { autoStart?: boolean } = {}) {
  if (currentPlatform() !== 'darwin') {
    throw new Error('Apple Container sandbox is only supported on macOS.')
  }
  const versionRun = await runContainer(['--version'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (versionRun.exitCode !== 0 || versionRun.timedOut) {
    throw new Error(commandFailedReason(versionRun, 'Apple Container CLI is unavailable.'))
  }
  const statusRun = await runContainer(['system', 'status'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (isAppleContainerSystemRunning(statusRun)) {
    return versionRun.stdout.trim() || null
  }

  if (options.autoStart !== false) {
    const startRun = await runContainer(['system', 'start'], {
      timeoutMs: APPLE_CONTAINER_START_TIMEOUT_MS
    })
    const retryStatusRun = await runContainer(['system', 'status'], {
      timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
    })
    if (isAppleContainerSystemRunning(retryStatusRun)) {
      return versionRun.stdout.trim() || null
    }
    throw new Error(
      commandFailedReason(
        startRun.timedOut || startRun.exitCode !== 0 ? startRun : retryStatusRun,
        'Apple Container system is not running. Start it with `container system start`.'
      )
    )
  }

  throw new Error(
    commandFailedReason(
      statusRun,
      'Apple Container system is not running. Start it with `container system start`.'
    )
  )
}

async function ensureInternalNetwork() {
  const listRun = await runContainer(['network', 'list', '--format', 'json'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (listRun.exitCode !== 0 || listRun.timedOut) {
    throw new Error(commandFailedReason(listRun, 'Failed to list Apple Container networks.'))
  }
  const networks = parseJsonList<{ id?: string; state?: string }>(listRun.stdout)
  const existing = networks.find((network) => network.id === APPLE_CONTAINER_SANDBOX_NETWORK)
  if (existing) return

  const createRun = await runContainer(
    ['network', 'create', '--internal', APPLE_CONTAINER_SANDBOX_NETWORK],
    { timeoutMs: APPLE_CONTAINER_CLEANUP_TIMEOUT_MS }
  )
  if (createRun.exitCode !== 0 || createRun.timedOut) {
    throw new Error(
      commandFailedReason(createRun, 'Failed to create Apple Container internal sandbox network.')
    )
  }
}

async function removeAppleContainer(name: string) {
  if (!isManagedAppleContainerSandboxName(name)) return null
  const deleteRun = await runContainer(['delete', '--force', name], {
    timeoutMs: APPLE_CONTAINER_CLEANUP_TIMEOUT_MS
  })
  if (!deleteRun.timedOut && deleteRun.exitCode === 0) return null

  await runContainer(['stop', '--time', '1', name], {
    timeoutMs: APPLE_CONTAINER_CLEANUP_TIMEOUT_MS
  })
  const retryRun = await runContainer(['delete', '--force', name], {
    timeoutMs: APPLE_CONTAINER_CLEANUP_TIMEOUT_MS
  })
  if (!retryRun.timedOut && retryRun.exitCode === 0) return null
  return commandFailedReason(retryRun, 'Failed to delete Apple Container sandbox.')
}

async function pruneStoppedAppleContainerSandboxes(options?: { keepNames?: string[] }) {
  const keepNames = new Set(options?.keepNames ?? [])
  const warnings: string[] = []
  let entries: AppleContainerListEntry[] = []
  try {
    entries = await listAppleContainers()
  } catch (error) {
    return [error instanceof Error ? error.message : 'Failed to list Apple containers.']
  }
  for (const entry of entries) {
    const id = getContainerEntryId(entry)
    if (!id || keepNames.has(id) || !isManagedAppleContainerSandboxName(id)) continue
    if (getContainerEntryState(entry) === 'running') continue
    const warning = await removeAppleContainer(id)
    if (warning) warnings.push(`${id}: ${warning}`)
  }
  return warnings
}

async function ensureAppleContainerSandboxReady(options: {
  userId?: string
  sessionId?: string | null
  workspaceRoot: string
  cwd: string
}) {
  const version = await ensureAppleContainerSystem()
  await ensureInternalNetwork()
  const workspace = await resolveWorkspace(options)
  const sandboxName = buildAppleContainerSandboxName({
    userId: options.userId,
    workspaceRoot: workspace.workspaceRoot,
    sessionId: options.sessionId
  })
  const entries = await listAppleContainers()
  const existing = entries.find((entry) => getContainerEntryId(entry) === sandboxName)
  const existingState = existing ? getContainerEntryState(existing) : null
  if (existing && existingState !== 'running') {
    const warning = await removeAppleContainer(sandboxName)
    if (warning) throw new Error(warning)
  }

  if (!existing || existingState !== 'running') {
    const batshitHomeMount = await ensureBatshitHomeSandboxMountPath()
    const volumeArgs = ['--volume', `${workspace.workspaceRoot}:${workspace.workspaceRoot}`]
    if (
      !isPathInsideSandboxRoot(batshitHomeMount, workspace.workspaceRoot) &&
      !isPathInsideSandboxRoot(workspace.workspaceRoot, batshitHomeMount)
    ) {
      volumeArgs.push('--volume', `${batshitHomeMount}:${batshitHomeMount}`)
    }
    const run = await runContainer(
      [
        'run',
        '--detach',
        '--name',
        sandboxName,
        '--network',
        APPLE_CONTAINER_SANDBOX_NETWORK,
        '--cpus',
        APPLE_CONTAINER_SANDBOX_CPUS,
        '--memory',
        APPLE_CONTAINER_SANDBOX_MEMORY,
        '--read-only',
        '--tmpfs',
        '/tmp',
        ...volumeArgs,
        '--workdir',
        workspace.cwd,
        APPLE_CONTAINER_SANDBOX_IMAGE,
        'bash',
        '-lc',
        'trap "exit 0" TERM INT; while true; do sleep 1; done'
      ],
      { timeoutMs: APPLE_CONTAINER_CREATE_TIMEOUT_MS }
    )
    if (run.exitCode !== 0 || run.timedOut) {
      throw new Error(commandFailedReason(run, 'Failed to create Apple Container sandbox.'))
    }
  }

  return { sandboxName, workspace, version }
}

export async function getAppleContainerSandboxStatus(): Promise<AppleContainerSandboxStatus> {
  try {
    const version = await ensureAppleContainerSystem()
    await ensureInternalNetwork()
    return {
      available: true,
      installed: true,
      supported: true,
      backend: 'apple_container',
      driver: 'apple_container',
      version,
      network: APPLE_CONTAINER_SANDBOX_NETWORK,
      image: APPLE_CONTAINER_SANDBOX_IMAGE,
      policy: 'internal-network',
      reason: null,
      installUrl: APPLE_CONTAINER_INSTALL_URL,
      capabilities: ['status', 'recover', 'execute', 'cleanup']
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Apple Container sandbox is unavailable.'
    const cliMissing = /CLI is unavailable|not installed|ENOENT|spawn container/i.test(reason)
    return {
      available: false,
      installed: !cliMissing,
      supported: currentPlatform() === 'darwin',
      backend: 'apple_container',
      driver: 'apple_container',
      version: null,
      network: APPLE_CONTAINER_SANDBOX_NETWORK,
      image: APPLE_CONTAINER_SANDBOX_IMAGE,
      policy: 'internal-network',
      reason,
      installUrl: APPLE_CONTAINER_INSTALL_URL,
      capabilities: ['status', 'recover', 'execute', 'cleanup']
    }
  }
}

export async function recoverAppleContainerSandbox(options: {
  userId?: string
  workspaceRoot: string
  cwd: string
  sessionId?: string | null
}) {
  const ensured = await ensureAppleContainerSandboxReady(options)
  return {
    success: true,
    recovered: true,
    backend: 'apple_container' as const,
    sandboxName: ensured.sandboxName,
    workspaceRoot: ensured.workspace.workspaceRoot,
    cwd: ensured.workspace.cwd,
    network: APPLE_CONTAINER_SANDBOX_NETWORK,
    image: APPLE_CONTAINER_SANDBOX_IMAGE,
    version: ensured.version
  }
}

export async function executeAppleContainerSandboxCommand(
  options: AppleContainerSandboxExecuteOptions
): Promise<AppleContainerSandboxExecuteResult> {
  let sandboxName: string | null = null
  try {
    const ensured = await ensureAppleContainerSandboxReady(options)
    sandboxName = ensured.sandboxName
    const envArgs: string[] = []
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!key || typeof value !== 'string') continue
      envArgs.push('--env', `${key}=${value}`)
    }

    const run = await runContainer(
      [
        'exec',
        '--workdir',
        ensured.workspace.cwd,
        ...envArgs,
        ensured.sandboxName,
        'bash',
        '-lc',
        options.command
      ],
      {
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars ?? APPLE_CONTAINER_MAX_OUTPUT_CHARS
      }
    )

    const cleanupWarnings: string[] = []
    if (!options.sessionId) {
      const warning = await removeAppleContainer(ensured.sandboxName)
      if (warning) cleanupWarnings.push(`${ensured.sandboxName}: ${warning}`)
      cleanupWarnings.push(...(await pruneStoppedAppleContainerSandboxes()))
    }

    return { ok: true, run, sandboxName: ensured.sandboxName, cleanupWarnings }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Apple Container sandbox execution failed.',
      ...(sandboxName ? { sandboxName } : {})
    }
  }
}

export async function cleanupAppleContainerSandboxesForSession(sessionId: string) {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return [] as string[]
  const marker = `s${sessionHash(normalizedSessionId)}-`
  const warnings: string[] = []
  let entries: AppleContainerListEntry[] = []
  try {
    await ensureAppleContainerSystem({ autoStart: false })
    entries = await listAppleContainers()
  } catch (error) {
    return [error instanceof Error ? error.message : 'Failed to list Apple Container sandboxes.']
  }

  for (const entry of entries) {
    const id = getContainerEntryId(entry)
    if (!id || !isManagedAppleContainerSandboxName(id) || !id.includes(marker)) continue
    const warning = await removeAppleContainer(id)
    if (warning) warnings.push(`${id}: ${warning}`)
  }
  warnings.push(...(await pruneStoppedAppleContainerSandboxes()))
  return warnings
}
