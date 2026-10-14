import { getBatshitHomeDir, getDefaultBatshitHomeDir } from './batshitHome'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { createSandboxLifecycleGate } from './sandboxLifecycleGate'
import { recordAppleContainerSystemStart } from './appleContainerSystemRecord'
import { resolveVoiceRuntimeLaunchOwner } from './voiceRuntimeLaunchRecords'
import { sandboxProtectedHomeRoots, sandboxHomeMountIdentity, ensureBatshitHomeSandboxMountPaths, SANDBOX_BATSHIT_PROTECTED_DIRS, SANDBOX_MOUNT_VERSION } from './sandboxHomeMounts'
import { stripHostOperatorAuthorityFromChildEnv } from './cliChildEnv'
import { limitedOutput } from './commandOutputLimit'
import { attachCommandModelCapture, createCommandModelCapture } from './commandModelCapture'
import {
  SANDBOX_COMMAND_END_TIMEOUT_MS,
  SANDBOX_COMMAND_TAG_ENV,
  endCommandProcess,
  newSandboxCommandTag,
  sandboxCommandEndArgv
} from './commandEnd'

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
const APPLE_CONTAINER_COMMAND_END_GRACE_MS = 1_000
// After the CLI exits, a descendant can still hold its inherited output pipes open. Give
// commandEnd its SIGKILL grace before releasing only our read handles.
const APPLE_CONTAINER_CLOSE_DRAIN_GRACE_MS = APPLE_CONTAINER_COMMAND_END_GRACE_MS + 100
const APPLE_CONTAINER_OUTPUT_INCOMPLETE_NOTE =
  '[Command output capture incomplete: pipes did not close; any later output was not kept.]'
const APPLE_CONTAINER_INSTALL_URL = 'https://github.com/apple/container/releases/latest'
// BL-129: with no default Linux kernel, `container system start` asks on stdin whether to install the
// recommended one; Batshit gives it no input, so 0.12.3 failed "failed to read user input" after
// registering the apiserver, and every create then failed "default kernel not found". Batshit never
// lets it ask (`--disable-kernel-install`, in every release since 0.1.0) and names the one command
// instead: the download is about 600 MB (kata-static 3.28.0 for 0.12.3), too big to start from an
// agent's command. The Mac supervisor's Start button says the same.
export const APPLE_CONTAINER_NO_KERNEL_REASON =
  'Apple Container has no Linux kernel yet, so it cannot start a sandbox. Run `container system kernel set --recommended` once in Terminal (it downloads about 600 MB), then try again. See https://docs.batshit.ai/installation/install-mac-app/#apple-container-has-no-linux-kernel-yet'
const APPLE_CONTAINER_NO_KERNEL_ANSWER = /default kernel not found|no default kernel configured|failed to read user input/i
// A sandbox another process just created lists as `stopped` for about a second while it
// starts (measured with container CLI 0.12.3), so a create that answers "already exists"
// waits this long for it to run before failing.
const APPLE_CONTAINER_EXISTING_START_WAIT_MS = 30_000
const APPLE_CONTAINER_EXISTING_START_POLL_MS = 250
// Every sandbox Batshit creates carries the time it was asked for (Unix ms), so a prune in ANY
// Batshit process on the Mac can tell a sandbox that is still starting from a dead one.
const APPLE_CONTAINER_CREATED_AT_LABEL = 'batshit.created-at'
// A start never takes this long (the create itself times out after 90 s), so a sandbox that
// never started and was created longer ago than this is dead.
const APPLE_CONTAINER_NEVER_STARTED_DEAD_AFTER_MS = 10 * 60_000
// Every sandbox also carries the Batshit that created it (BL-149): a quit in the middle of a run
// never gets that run's cleanup, so that Batshit's quit removes the sandboxes carrying its own label
// (`batshit-mac/scripts/apple-container-system-stop.mjs`, the twin of this rule).
const APPLE_CONTAINER_OWNER_LABEL = 'batshit.owner'

/**
 * The owner label's value for this Batshit (`BATSHIT_VOICE_RUNTIME_OWNER`, which the Mac supervisor
 * and the native source launcher give the app), or null when it has none, so no quit would claim its sandboxes.
 * A digest, because Apple's CLI splits a label at `=` and rejects a third part (0.12.3), and a data
 * folder may hold one.
 */
function appleContainerOwnerLabelValue(): string | null {
  const owner = resolveVoiceRuntimeLaunchOwner()
  return owner ? createHash('sha256').update(owner).digest('hex').slice(0, 16) : null
}

// F-P5-1: every create and remove of a named sandbox goes through this gate, so a chat's
// parallel first bash calls share one create instead of racing to make the same container.
const sandboxGate = createSandboxLifecycleGate()
let internalNetworkFlight: Promise<void> | null = null
let systemStartFlight: Promise<string | null> | null = null

export interface AppleContainerCommandRun {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  truncated: boolean
  /** Ended by its caller's abort signal (a Stop), not by itself or the timeout. */
  stopped?: boolean
  /** The CLI could not be run because it is not there (spawn ENOENT). */
  notFound?: boolean
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
  /**
   * Whether Apple's container system runs now. A status check never starts it (BL-62): with the
   * CLI installed and the system stopped, the sandbox is still `available`, and the first
   * sandboxed command starts the system and the internal network.
   */
  systemRunning: boolean
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
  /** The model run's abort signal: a Stop ends the command instead of waiting for it. */
  abortSignal?: AbortSignal
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
    abortSignal?: AbortSignal
    /** Only the actual user command has a model-visible raw output sidecar. */
    captureModelOutput?: boolean
    /** A sandbox command: what a Stop or timeout also ends inside the sandbox (`commandEnd.ts`). */
    endInside?: () => Promise<void>
  }
) => Promise<AppleContainerCommandRun>

let commandRunnerOverride: AppleContainerCommandRunner | null = null
let platformOverride: NodeJS.Platform | null = null
let existingStartWaitOverride: { timeoutMs: number; pollMs: number } | null = null
let batshitHomeMountRootOverride: string | null = null

export function __setAppleContainerCommandRunnerForTests(
  runner: AppleContainerCommandRunner | null
) {
  commandRunnerOverride = runner
}

export function __setAppleContainerPlatformForTests(platform: NodeJS.Platform | null) {
  platformOverride = platform
}

export function __setAppleContainerExistingStartWaitForTests(
  wait: { timeoutMs: number; pollMs: number } | null
) {
  existingStartWaitOverride = wait
}

export function __setAppleContainerBatshitHomeMountRootForTests(root: string | null) {
  batshitHomeMountRootOverride = root
}

function currentPlatform() {
  return platformOverride ?? process.platform
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: Parameters<AppleContainerCommandRunner>[2] = {}
): Promise<AppleContainerCommandRun> {
  const startedAt = Date.now()
  const maxOutputChars = options.maxOutputChars ?? APPLE_CONTAINER_MAX_OUTPUT_CHARS
  const abortSignal = options.abortSignal

  // Stopped before it began: never start it.
  if (abortSignal?.aborted) {
    const stoppedRun: AppleContainerCommandRun = {
      command: `${command} ${args.join(' ')}`.trim(),
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      truncated: false,
      stopped: true
    }
    return options.captureModelOutput
      ? attachCommandModelCapture(stoppedRun, createCommandModelCapture().finish(stoppedRun))
      : stoppedRun
  }

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: stripHostOperatorAuthorityFromChildEnv({ ...process.env, ...(options.env ?? {}) }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = limitedOutput(maxOutputChars)
    const stderr = limitedOutput(maxOutputChars)
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const modelCapture = options.captureModelOutput ? createCommandModelCapture() : null
    let timedOut = false
    let stopped = false
    let notFound = false
    let settled = false
    let ending = false
    let endedInside = true
    let exited: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null
    let pipesFinished = false
    let closeDrainTimer: ReturnType<typeof setTimeout> | null = null
    let outputIncomplete = false

    // Wait for the CLI's output pipes to close before freezing the original character count;
    // Node can emit `exit` while readable stdout/stderr bytes are still pending. A Stop or
    // timeout also waits for what the command started inside the sandbox to be ended.
    const finish = () => {
      if (settled || !exited || !pipesFinished || !endedInside) return
      settled = true
      if (closeDrainTimer) clearTimeout(closeDrainTimer)
      abortSignal?.removeEventListener('abort', onAbort)
      stdout.append(stdoutDecoder.end())
      stderr.append(stderrDecoder.end())
      const visibleStderr = outputIncomplete
        ? `${stderr.text}${stderr.text ? '\n' : ''}${APPLE_CONTAINER_OUTPUT_INCOMPLETE_NOTE}`
        : stderr.text
      const run: AppleContainerCommandRun = {
        command: `${command} ${args.join(' ')}`.trim(),
        stdout: stdout.text,
        stderr: visibleStderr,
        exitCode: exited.exitCode,
        signal: exited.signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated: stdout.cut || stderr.cut || outputIncomplete,
        ...(stopped ? { stopped: true } : {}),
        ...(notFound ? { notFound: true } : {})
      }
      resolve(modelCapture
        ? attachCommandModelCapture(run, modelCapture.finish({ ...run, outputIncomplete }))
        : run)
    }

    const finishAfterPipeGrace = () => {
      if (settled) return
      if (!child.stdout.readableEnded) {
        outputIncomplete = true
        child.stdout.destroy()
      }
      if (!child.stderr.readableEnded) {
        outputIncomplete = true
        child.stderr.destroy()
      }
      // Our pipe handles are now released. The inside-sandbox end still owns its own wait.
      pipesFinished = true
      finish()
    }

    const waitForPipeClose = () => {
      if (closeDrainTimer || settled) return
      closeDrainTimer = setTimeout(finishAfterPipeGrace, APPLE_CONTAINER_CLOSE_DRAIN_GRACE_MS)
    }

    // A Stop and a timeout end the command the same way (2026-09-18, `commandEnd.ts`): the CLI
    // (SIGTERM, then SIGKILL a second later), and, inside the sandbox, what the command started.
    // `container exec` passes the SIGTERM to the command's top shell only: both parts of
    // `sleep 61 & sleep 62` ran on inside after it.
    const end = () => {
      if (ending || settled) return
      ending = true
      endCommandProcess(child, { ownGroup: false, graceMs: APPLE_CONTAINER_COMMAND_END_GRACE_MS })
      if (options.endInside) {
        endedInside = false
        void options
          .endInside()
          .catch((error) => {
            console.warn('[Apple Container] Ending a command inside its sandbox failed:', error)
          })
          .finally(() => {
            endedInside = true
            finish()
          })
      }
    }

    const onAbort = () => {
      if (settled) return
      stopped = true
      end()
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            end()
          }, options.timeoutMs)
        : null
    timeout?.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.append(stdoutDecoder.write(chunk))
      modelCapture?.appendStdout(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.append(stderrDecoder.write(chunk))
      modelCapture?.appendStderr(chunk)
    })
    child.on('error', (error) => {
      stderr.append(error.message)
      modelCapture?.appendStderr(error.message)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') notFound = true
      exited ??= { exitCode: 1, signal: null }
      waitForPipeClose()
    })
    child.on('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      abortSignal?.removeEventListener('abort', onAbort)
      exited ??= { exitCode: code, signal }
      waitForPipeClose()
    })
    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      if (closeDrainTimer) clearTimeout(closeDrainTimer)
      exited ??= { exitCode: code, signal }
      pipesFinished = true
      finish()
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

/** The real runner, for tests that drive it with a stand-in command. */
export const __runAppleContainerCommandForTests = defaultCommandRunner

// `fallback` is a whole sentence naming what failed; a call that ran out of time says so after it
// (BL-146: it read "<fallback> timed out.", and "… status timed out. timed out." for status).
function commandFailedReason(run: AppleContainerCommandRun, fallback: string) {
  if (run.timedOut) return `${fallback} The \`container\` command did not answer in time.`
  return run.stderr.trim() || run.stdout.trim() || fallback
}

/**
 * Apple Container cannot be on this computer: it is not a Mac, or there is no `container` CLI
 * (BL-151). Status reports it as unavailable; run-end cleanup, which every chat turn runs whatever
 * sandbox the agent uses, has nothing to clean and says nothing.
 */
class AppleContainerAbsentError extends Error {}

function commandSucceeded(run: AppleContainerCommandRun) {
  return run.exitCode === 0 && !run.timedOut
}

function describeCommandEndFailure(run: AppleContainerCommandRun) {
  if (run.timedOut) return 'Ending the command timed out.'
  const words = run.stderr.trim() || run.stdout.trim()
  return words || `Ending the command exited ${run.exitCode ?? `on ${run.signal ?? 'a signal'}`}.`
}

// Apple's answer when there is no default Linux kernel: a create's "default kernel not found", or a
// start that asked for one anyway ("No default kernel configured", "failed to read user input").
function commandFailedForNoKernel(run: AppleContainerCommandRun) {
  return !run.timedOut && run.exitCode !== 0 && APPLE_CONTAINER_NO_KERNEL_ANSWER.test(`${run.stderr}\n${run.stdout}`)
}

// The CLI answers a create for a name it already has with "... already exists" (both
// `run` and `network create`, container CLI 0.12.3).
function commandFailedBecauseItAlreadyExists(run: AppleContainerCommandRun) {
  return !run.timedOut && run.exitCode !== 0 && /already exists/i.test(`${run.stderr}\n${run.stdout}`)
}

function sessionHash(sessionId: string) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
}

function workspaceHash(workspaceRoot: string) {
  // A changed mount policy must never reuse a sandbox with older, broader mounts.
  return createHash('sha256').update(`managed-mounts-v${SANDBOX_MOUNT_VERSION}:${workspaceRoot}${sandboxHomeMountIdentity()}`).digest('hex').slice(0, 10)
}

// Keep this wrapper for the Docker sbx caller; its create-args builder expands the
// home into the same explicit writable roots as Apple Container.
export async function ensureBatshitHomeSandboxMountPath(): Promise<string> {
  const batshitHome = batshitHomeMountRootOverride ?? getBatshitHomeDir()
  await ensureBatshitHomeSandboxMountPaths(batshitHome, batshitHomeMountRootOverride ?? getDefaultBatshitHomeDir())
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
  return `${APPLE_CONTAINER_SANDBOX_NAME_PREFIX}${userPrefix}-${sessionSegment}m${SANDBOX_MOUNT_VERSION}-${workspaceHash(
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

type ResolvedWorkspace = { workspaceRoot: string; cwd: string }

async function resolveWorkspace(options: {
  workspaceRoot: string
  cwd: string
}): Promise<ResolvedWorkspace> {
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
  // Seconds since 2001-01-01: null until the container first runs, kept after it stops.
  startedDate?: number | null
  configuration?: { id?: string; labels?: Record<string, string> }
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

async function findAppleContainer(name: string) {
  return (await listAppleContainers()).find((entry) => getContainerEntryId(entry) === name) ?? null
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isAppleContainerSystemRunning(run: AppleContainerCommandRun) {
  return run.exitCode === 0 && !run.timedOut && run.stdout.includes('running')
}

// Apple's answer for a stopped system (0.12.3): exit 1 and "apiserver is not running and not
// registered with launchd".
const APPLE_CONTAINER_STOPPED_ANSWER = /not registered with launchd/i

const APPLE_CONTAINER_NOT_RUNNING_REASON =
  'Apple Container system is not running. Start it with `container system start`.'

type AppleContainerSystemState =
  | { state: 'running'; version: string | null }
  | { state: 'stopped'; version: string | null; statusRun: AppleContainerCommandRun }

/** Looks only: the CLI's version and whether the system runs. Starts nothing. */
async function readAppleContainerSystemState(): Promise<AppleContainerSystemState> {
  if (currentPlatform() !== 'darwin') {
    throw new AppleContainerAbsentError('Apple Container sandbox is only supported on macOS.')
  }
  const versionRun = await runContainer(['--version'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (versionRun.notFound) {
    throw new AppleContainerAbsentError(commandFailedReason(versionRun, 'Apple Container CLI is unavailable.'))
  }
  if (versionRun.exitCode !== 0 || versionRun.timedOut) {
    throw new Error(commandFailedReason(versionRun, 'Apple Container CLI is unavailable.'))
  }
  const version = versionRun.stdout.trim() || null
  const statusRun = await runContainer(['system', 'status'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (isAppleContainerSystemRunning(statusRun)) return { state: 'running', version }
  // A status check that hung says nothing about the system: that is a failure, not "stopped".
  // Runtime Doctor says the same words (`classifyAppleContainerStatus` in the Mac supervisor).
  if (statusRun.timedOut) {
    throw new Error('`container system status` did not answer in time.')
  }
  // Only Apple's own stopped answer is stopped (0.12.3, SystemStatus.swift: exit 1, "apiserver is
  // not running and not registered with launchd"), so only then may the first sandboxed command start
  // it. An XPC or launchd error, or a registered apiserver that did not answer its ping ("apiserver
  // is not running"), is a broken install: reported with its own words, never started behind the
  // user's back (BL-83 review; the Mac supervisor's `classifyAppleContainerStatus` is the same rule).
  if (!APPLE_CONTAINER_STOPPED_ANSWER.test(`${statusRun.stderr}\n${statusRun.stdout}`)) {
    const words = `${statusRun.stderr}\n${statusRun.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean).pop()
    throw new Error(`Apple Container system status failed: ${words || `exit ${statusRun.exitCode ?? 'unknown'}`}`)
  }
  return { state: 'stopped', version, statusRun }
}

async function startAppleContainerSystem(version: string | null) {
  const callStartedAt = Date.now()
  const startRun = await runContainer(['system', 'start', '--disable-kernel-install'], {
    timeoutMs: APPLE_CONTAINER_START_TIMEOUT_MS
  })
  const callEndedAt = Date.now()
  const retryStatusRun = await runContainer(['system', 'status'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (isAppleContainerSystemRunning(retryStatusRun)) {
    // This call started it: record it, so quitting Batshit stops it again when nothing runs in it
    // (BL-62 part 2). A record that cannot be written costs only that stop, never this sandbox.
    await recordAppleContainerSystemStart(callStartedAt, callEndedAt).catch((error) => {
      console.warn('[Apple Container] Could not record the Apple Container system this call started:', error)
    })
    // Running, but a start that still asked for a kernel is no success: nothing can run in it.
    if (commandFailedForNoKernel(startRun)) throw new Error(APPLE_CONTAINER_NO_KERNEL_REASON)
    return version
  }
  if (commandFailedForNoKernel(startRun)) throw new Error(APPLE_CONTAINER_NO_KERNEL_REASON)
  throw new Error(
    commandFailedReason(
      startRun.timedOut || startRun.exitCode !== 0 ? startRun : retryStatusRun,
      APPLE_CONTAINER_NOT_RUNNING_REASON
    )
  )
}

/**
 * The system, running, for a real sandbox use. Only sandbox use starts it (BL-62), from inside
 * `sandboxGate.ensure`; two sandboxes' first calls on a cold Mac share one `system start`. Run-end
 * cleanup never gets here: it only reads the state, and a stopped system has nothing to clean.
 */
async function ensureAppleContainerSystem() {
  const system = await readAppleContainerSystemState()
  if (system.state === 'running') return system.version
  systemStartFlight ??= startAppleContainerSystem(system.version).finally(() => {
    systemStartFlight = null
  })
  return systemStartFlight
}

async function internalNetworkExists() {
  const listRun = await runContainer(['network', 'list', '--format', 'json'], {
    timeoutMs: APPLE_CONTAINER_STATUS_TIMEOUT_MS
  })
  if (!commandSucceeded(listRun)) {
    throw new Error(commandFailedReason(listRun, 'Failed to list Apple Container networks.'))
  }
  const networks = parseJsonList<{ id?: string; state?: string }>(listRun.stdout)
  return networks.some((network) => network.id === APPLE_CONTAINER_SANDBOX_NETWORK)
}

async function createInternalNetworkIfMissing() {
  if (await internalNetworkExists()) return

  const createRun = await runContainer(
    ['network', 'create', '--internal', APPLE_CONTAINER_SANDBOX_NETWORK],
    { timeoutMs: APPLE_CONTAINER_CLEANUP_TIMEOUT_MS }
  )
  if (commandSucceeded(createRun)) return
  // Another process made it between our list and our create.
  if (commandFailedBecauseItAlreadyExists(createRun) && (await internalNetworkExists())) return
  throw new Error(
    commandFailedReason(createRun, 'Failed to create Apple Container internal sandbox network.')
  )
}

// Two chats' first calls can both find the network missing; they share one create.
function ensureInternalNetwork() {
  internalNetworkFlight ??= createInternalNetworkIfMissing().finally(() => {
    internalNetworkFlight = null
  })
  return internalNetworkFlight
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

/**
 * True when a sandbox that is not running is dead rather than starting. Apple lists a sandbox
 * that is still starting as `stopped` with no `startedDate`, in every process's list, and a
 * process's gate knows only its own starts. So a sandbox that ran and stopped (it keeps its
 * `startedDate`; a Mac restart leaves these) is dead, and one that never started is dead only
 * when Batshit's creation stamp proves it older than any start takes. One with no stamp, made
 * by an older Batshit, cannot be told from a start in progress and is kept.
 */
function isAbandonedAppleContainerSandbox(entry: AppleContainerListEntry, nowMs: number) {
  if (getContainerEntryState(entry) === 'running') return false
  if (entry.startedDate !== null && entry.startedDate !== undefined) return true
  const createdAt = Number(entry.configuration?.labels?.[APPLE_CONTAINER_CREATED_AT_LABEL])
  return Number.isFinite(createdAt) && nowMs - createdAt > APPLE_CONTAINER_NEVER_STARTED_DEAD_AFTER_MS
}

// The list is read once up front, so each removal checks again inside the gate: by its
// turn the sandbox may have been started for a command, or replaced by a new one.
async function removeAppleContainerIfStillAbandoned(name: string) {
  try {
    const current = await findAppleContainer(name)
    if (!current || !isAbandonedAppleContainerSandbox(current, Date.now())) return null
    return await removeAppleContainer(name)
  } catch (error) {
    return error instanceof Error ? error.message : 'Failed to check Apple Container sandbox state.'
  }
}

async function pruneStoppedAppleContainerSandboxes() {
  const warnings: string[] = []
  let entries: AppleContainerListEntry[] = []
  try {
    entries = await listAppleContainers()
  } catch (error) {
    return [error instanceof Error ? error.message : 'Failed to list Apple containers.']
  }
  const now = Date.now()
  for (const entry of entries) {
    const id = getContainerEntryId(entry)
    if (!id || !isManagedAppleContainerSandboxName(id)) continue
    // Every chat turn in every Batshit process on this Mac runs this prune, so a sandbox
    // another process is starting (listed `stopped`) must survive it.
    if (!isAbandonedAppleContainerSandbox(entry, now)) continue
    // Work this process has on the name (a start, a command, a removal) is left alone
    // without queueing another removal behind it.
    if (sandboxGate.isBusy(id)) continue
    const removal = await sandboxGate.removeIfIdle(id, () => removeAppleContainerIfStillAbandoned(id))
    if (removal.removed && removal.value) warnings.push(`${id}: ${removal.value}`)
  }
  return warnings
}

// Another process created this sandbox between our list and our create. It lists as
// `stopped` while it starts, so wait for it to run rather than fail, and fail visibly
// when it never does.
async function waitForExistingAppleContainerToRun(sandboxName: string, createFailure: string) {
  const { timeoutMs, pollMs } = existingStartWaitOverride ?? {
    timeoutMs: APPLE_CONTAINER_EXISTING_START_WAIT_MS,
    pollMs: APPLE_CONTAINER_EXISTING_START_POLL_MS
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entry = await findAppleContainer(sandboxName)
    if (!entry) {
      throw new Error(
        `Apple Container reported that sandbox ${sandboxName} already exists, but it is not listed. ${createFailure}`
      )
    }
    const state = getContainerEntryState(entry) || 'unknown'
    if (state === 'running') return
    if (Date.now() >= deadline) {
      throw new Error(
        `Apple Container sandbox ${sandboxName} already exists but is still ${state} after ${timeoutMs} ms. ${createFailure}`
      )
    }
    await sleep(pollMs)
  }
}

// Runs inside `sandboxGate.ensure`, so one call at a time per sandbox name.
async function startAppleContainerSandbox(sandboxName: string, workspace: ResolvedWorkspace) {
  const version = await ensureAppleContainerSystem()
  await ensureInternalNetwork()
  const existing = await findAppleContainer(sandboxName)
  const existingState = existing ? getContainerEntryState(existing) : null
  if (existing && existingState !== 'running') {
    const warning = await removeAppleContainer(sandboxName)
    if (warning) throw new Error(warning)
  }

  if (!existing || existingState !== 'running') {
    const batshitHomeMount = batshitHomeMountRootOverride ?? getBatshitHomeDir()
    const batshitHomeMounts = await ensureBatshitHomeSandboxMountPaths(batshitHomeMount, batshitHomeMountRootOverride ?? getDefaultBatshitHomeDir())
    const volumeArgs = ['--volume', `${workspace.workspaceRoot}:${workspace.workspaceRoot}`]
    for (const protectedRoot of sandboxProtectedHomeRoots(batshitHomeMount, batshitHomeMountRootOverride ?? getDefaultBatshitHomeDir())) {
      const resolvedRoot = await realpath(protectedRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return protectedRoot
        throw error
      })
      if ([protectedRoot, resolvedRoot].some((root) =>
        [workspace.workspaceRoot, ...batshitHomeMounts].some((mount) =>
          isPathInsideSandboxRoot(root, mount) || isPathInsideSandboxRoot(mount, root)
        )
      )) {
        throw new Error('Sandbox workspace exposes managed agent homes or protected runtime/Pinokio data.')
      }
    }
    for (const mount of batshitHomeMounts) {
      if (!isPathInsideSandboxRoot(mount, workspace.workspaceRoot)) {
        volumeArgs.push('--volume', `${mount}:${mount}`)
      }
    }
    const owner = appleContainerOwnerLabelValue()
    const run = await runContainer(
      [
        'run',
        '--detach',
        '--name',
        sandboxName,
        '--label',
        `${APPLE_CONTAINER_CREATED_AT_LABEL}=${Date.now()}`,
        ...(owner ? ['--label', `${APPLE_CONTAINER_OWNER_LABEL}=${owner}`] : []),
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
    if (commandFailedBecauseItAlreadyExists(run)) {
      await waitForExistingAppleContainerToRun(
        sandboxName,
        commandFailedReason(run, 'Failed to create Apple Container sandbox.')
      )
    } else if (commandFailedForNoKernel(run)) {
      throw new Error(APPLE_CONTAINER_NO_KERNEL_REASON)
    } else if (!commandSucceeded(run)) {
      throw new Error(commandFailedReason(run, 'Failed to create Apple Container sandbox.'))
    }
  }

  return { version }
}

async function prepareAppleContainerSandbox(options: {
  userId?: string
  sessionId?: string | null
  workspaceRoot: string
  cwd: string
}) {
  const workspace = await resolveWorkspace(options)
  const sandboxName = buildAppleContainerSandboxName({
    userId: options.userId,
    workspaceRoot: workspace.workspaceRoot,
    sessionId: options.sessionId
  })
  return { sandboxName, workspace }
}

/**
 * What Settings and Admin show. It only looks (BL-62): it never starts Apple's container system
 * or creates the internal network, because nothing would stop them again. A stopped system with
 * the CLI installed is `available` with `systemRunning: false`; the first sandboxed command
 * starts it (`startAppleContainerSandbox`, inside the lifecycle gate).
 */
export async function getAppleContainerSandboxStatus(): Promise<AppleContainerSandboxStatus> {
  try {
    const system = await readAppleContainerSystemState()
    return {
      available: true,
      installed: true,
      supported: true,
      backend: 'apple_container',
      driver: 'apple_container',
      version: system.version,
      network: APPLE_CONTAINER_SANDBOX_NETWORK,
      image: APPLE_CONTAINER_SANDBOX_IMAGE,
      policy: 'internal-network',
      systemRunning: system.state === 'running',
      reason: null,
      installUrl: APPLE_CONTAINER_INSTALL_URL,
      capabilities: ['status', 'recover', 'execute', 'cleanup']
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Apple Container sandbox is unavailable.'
    return {
      available: false,
      // Not a Mac, or no `container` CLI: not installed. Any other failure is an installed CLI that
      // fails (it read `installed: true` off macOS).
      installed: !(error instanceof AppleContainerAbsentError),
      supported: currentPlatform() === 'darwin',
      backend: 'apple_container',
      driver: 'apple_container',
      version: null,
      network: APPLE_CONTAINER_SANDBOX_NETWORK,
      image: APPLE_CONTAINER_SANDBOX_IMAGE,
      policy: 'internal-network',
      systemRunning: false,
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
  const { sandboxName, workspace } = await prepareAppleContainerSandbox(options)
  const { version } = await sandboxGate.ensure(sandboxName, () =>
    startAppleContainerSandbox(sandboxName, workspace)
  )
  return {
    success: true,
    recovered: true,
    backend: 'apple_container' as const,
    sandboxName,
    workspaceRoot: workspace.workspaceRoot,
    cwd: workspace.cwd,
    network: APPLE_CONTAINER_SANDBOX_NETWORK,
    image: APPLE_CONTAINER_SANDBOX_IMAGE,
    version
  }
}

/** A stopped or timed-out command's end inside its sandbox, by its tag (`commandEnd.ts`). */
async function endAppleContainerCommand(sandboxName: string, tag: string) {
  const run = await runContainer(['exec', sandboxName, ...sandboxCommandEndArgv(tag)], {
    timeoutMs: SANDBOX_COMMAND_END_TIMEOUT_MS
  })
  if (commandSucceeded(run)) return
  // A sandbox removed (the chat's run-end sweep) or stopped meanwhile took everything in it
  // along. Its `exec` then fails with no words at all, so ask the CLI rather than the output.
  const sandbox = await findAppleContainer(sandboxName).catch(() => undefined)
  if (sandbox === null || (sandbox && getContainerEntryState(sandbox) !== 'running')) return
  console.warn('[Apple Container] Could not end what a stopped command started:', {
    sandboxName,
    reason: describeCommandEndFailure(run)
  })
}

export async function executeAppleContainerSandboxCommand(
  options: AppleContainerSandboxExecuteOptions
): Promise<AppleContainerSandboxExecuteResult> {
  let sandboxName: string | null = null
  let releaseLease: (() => void) | null = null
  try {
    const prepared = await prepareAppleContainerSandbox(options)
    const name = prepared.sandboxName
    sandboxName = name
    // Held until the command returns, so no cleanup removes the sandbox under it.
    releaseLease = sandboxGate.lease(name)
    await sandboxGate.ensure(name, () => startAppleContainerSandbox(name, prepared.workspace))
    // The command's tag names it for its end on a Stop or timeout (`commandEnd.ts`). It goes
    // last, so no caller's env replaces it.
    const tag = newSandboxCommandTag()
    const envArgs: string[] = []
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!key || typeof value !== 'string' || key === SANDBOX_COMMAND_TAG_ENV) continue
      envArgs.push('--env', `${key}=${value}`)
    }
    envArgs.push('--env', `${SANDBOX_COMMAND_TAG_ENV}=${tag}`)

    const run = await runContainer(
      ['exec', '--workdir', prepared.workspace.cwd, ...envArgs, name, 'bash', '-lc', options.command],
      {
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars ?? APPLE_CONTAINER_MAX_OUTPUT_CHARS,
        captureModelOutput: true,
        abortSignal: options.abortSignal,
        endInside: () => endAppleContainerCommand(name, tag)
      }
    )

    const cleanupWarnings: string[] = []
    if (!options.sessionId) {
      // A one-shot sandbox goes away with its command, unless another one-shot command
      // for the same workspace still runs in it; that command removes it when it ends.
      releaseLease()
      releaseLease = null
      const removal = await sandboxGate.removeIfIdle(name, () => removeAppleContainer(name))
      if (removal.removed && removal.value) cleanupWarnings.push(`${name}: ${removal.value}`)
      cleanupWarnings.push(...(await pruneStoppedAppleContainerSandboxes()))
    }

    return { ok: true, run, sandboxName: name, cleanupWarnings }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Apple Container sandbox execution failed.',
      ...(sandboxName ? { sandboxName } : {})
    }
  } finally {
    releaseLease?.()
  }
}

export async function cleanupAppleContainerSandboxesForSession(sessionId: string) {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return [] as string[]
  const marker = `s${sessionHash(normalizedSessionId)}-`
  const warnings: string[] = []
  let entries: AppleContainerListEntry[] = []
  try {
    // A stopped system (Apple's own stopped answer) holds no running sandbox: nothing to clean and
    // nothing to say. Since BL-62 part 2 it is the normal state after launch, so every chat turn's
    // cleanup meets it. One that does not answer still throws, and is reported.
    const system = await readAppleContainerSystemState()
    if (system.state === 'stopped') return []
    entries = await listAppleContainers()
  } catch (error) {
    // Not a Mac, or no `container` CLI: no Apple sandbox can exist, so nothing to say (BL-151).
    if (error instanceof AppleContainerAbsentError) return []
    return [error instanceof Error ? error.message : 'Failed to list Apple Container sandboxes.']
  }

  for (const entry of entries) {
    const id = getContainerEntryId(entry)
    if (!id || !isManagedAppleContainerSandboxName(id) || !id.includes(marker)) continue
    // The chat's run is over, so this removal does not wait for a command it started.
    // It does wait for a create already under way, instead of deleting a starting sandbox.
    const warning = await sandboxGate.remove(id, () => removeAppleContainer(id))
    if (warning) warnings.push(`${id}: ${warning}`)
  }
  warnings.push(...(await pruneStoppedAppleContainerSandboxes()))
  return warnings
}
