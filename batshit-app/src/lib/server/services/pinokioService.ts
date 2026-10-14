/**
 * SA-072 P1: Pinokio, driven only through its own `pterm` command (DL-02).
 *
 * Pinokio is optional (DL-01). Every function here answers a typed result when Pinokio is
 * absent, closed, too old, or out of reach, and never throws for "not installed" or retries in
 * a loop. The parser reads exactly what `pterm` 0.0.25 prints on Pinokio 8.2.0 (DL-11, the
 * fixtures in `src/lib/server/tests/fixtures/pinokio/`): `search`, `status`, and `logs` print
 * JSON, `version` prints `name@version`, and every failed request is an uncaught AxiosError on
 * stderr with exit 1. Anything else is a visible parse error carrying the raw text, never a guess.
 *
 * Rules the P0 spike measured, and that this file keeps (story "P1 run rules"):
 * 1. `run` asks `status` first and returns at once for an app that is online and ready.
 * 2. It runs only the absolute `path` status reports, after checking `source.local` and that the
 *    path sits under `<home>/api/`. Ids that are URLs, `pinokio://` refs, or `id@host` are refused.
 * 3. `pterm run` is spawned in its own process group, polled with `status`, and confirmed with
 *    `status --probe` (`ready` alone is Pinokio's lifecycle flag, not reachability).
 * 4. SIGTERM or SIGINT to `pterm run` STOPS the app, so Batshit never sends either. It ends the
 *    child with SIGKILL, which leaves the app running and nothing of Batshit's behind. Every
 *    `pterm` child gets its own process group for the same reason: a Ctrl+C aimed at Batshit's
 *    group must never reach one.
 * 5. An app whose `ENVIRONMENT` names `PINOKIO_SCRIPT_REQUIRES` starts those apps first, so the
 *    call must name them (`alsoStarts`) and the Approve card shows them.
 * 6. Batshit checks `127.0.0.1:42000` itself before calling `pterm`: with Pinokio closed, `pterm`
 *    falls back to the LAN address stored in Pinokio's config.
 *
 * The child's environment is an allowlist: no Batshit token, key, or secret reaches `pterm` (DL-06).
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { isContainerizedRuntime } from '$lib/server/services/runtimeUrlRewrites'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'

/** DL-13: the pair P0 proved. A later Pinokio that breaks a fixture moves the floor, never two parsers. */
export const PINOKIO_VERSION_FLOOR = '8.2.0'
export const PINOKIO_CONTROL_PLANE_HOST = '127.0.0.1'
export const PINOKIO_CONTROL_PLANE_PORT = 42000

/** Short commands answer in about 150 ms; `logs` of a chatty app can take longer. */
const PTERM_COMMAND_TIMEOUT_MS = 15_000
const CONTROL_PLANE_CONNECT_TIMEOUT_MS = 800
const DETECTION_CACHE_MS = 5_000
/**
 * The managed CLI helper gives a control call 60 s. A start that takes longer answers
 * "still starting" and the agent checks again with `sys.pinokio.app_status`.
 */
export const PINOKIO_RUN_DEFAULT_WAIT_SECONDS = 45
export const PINOKIO_RUN_MAX_WAIT_SECONDS = 50
const RUN_POLL_INTERVAL_MS = 2_000
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const RUN_OUTPUT_TAIL_BYTES = 16 * 1024
const RAW_EXCERPT_CHARS = 800
const LOG_LINE_MAX_CHARS = 500
const LOG_TOTAL_MAX_CHARS = 16_000
const MAX_REQUIRES_DEPTH = 16
const PTERM_SCRIPT_UNAVAILABLE_MESSAGE = "Pinokio's pterm command is not a readable Node.js script. Check its local installation."

class PtermScriptAdmissionError extends Error {}

function ptermStartFailure(error: unknown) {
  return {
    message: error instanceof PtermScriptAdmissionError
      ? PTERM_SCRIPT_UNAVAILABLE_MESSAGE
      : 'The local pterm command could not be started. Check its local installation.'
  }
}

/** Environment keys `pterm` may inherit. Nothing else crosses (DL-06). */
const PTERM_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'] as const

export type PinokioUnavailableReason =
  | 'containerized'
  | 'unsupported_platform'
  | 'not_installed'
  | 'unsupported_version'
  | 'pterm_missing'
  | 'not_running'

export interface PinokioDetection {
  available: boolean
  reason: PinokioUnavailableReason | null
  /** One plain sentence, the same words Settings → Admin shows. */
  message: string
  /** The Pinokio desktop version (`pterm version pinokio`, or the config's when Pinokio is closed). */
  version: string | null
  versionFloor: string
  home: string | null
  ptermPath: string | null
  ptermVersion: string | null
  controlPlaneReachable: boolean
}

export type PinokioAppState = 'offline' | 'starting' | 'online'

export interface PinokioAppStatus {
  appId: string
  title: string
  state: PinokioAppState
  running: boolean
  ready: boolean
  readyUrl: string | null
  /** `true` or `false` only after `--probe`; `null` when the probe was not asked for. */
  probe: boolean | null
  path: string | null
  lastError: string | null
}

export interface PinokioSearchApp {
  appId: string
  title: string
  description: string | null
  state: PinokioAppState
  running: boolean
  ready: boolean
  readyUrl: string | null
}

export interface PinokioSearchResult {
  query: string
  apps: PinokioSearchApp[]
  /** Apps a peer machine reported; left out, because this story is local only (DL-07). */
  skippedRemote: number
}

export interface PinokioLogs {
  appId: string
  script: string | null
  lineCount: number | null
  lines: string[]
  truncated: boolean
}

export interface PinokioRunResult {
  appId: string
  title: string
  /** True when the app was already online and ready: nothing was started. */
  alreadyRunning: boolean
  /** True when the app answered its probe before the wait ended. */
  ready: boolean
  state: PinokioAppState
  readyUrl: string | null
  alsoStarted: string[]
  waitedMs: number
  message: string
  /** The last lines `pterm run` printed, when the app was not ready in time. */
  outputTail?: string[]
}

export type PinokioFailureKind = 'unavailable' | 'not_found' | 'refused' | 'error'

export type PinokioOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false
      kind: PinokioFailureKind
      message: string
      reason?: PinokioUnavailableReason
      /** A short excerpt of what `pterm` printed, for an unrecognised answer. */
      raw?: string
    }

export interface PtermResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/* ------------------------------------------------------------------ *
 * The seams tests replace. Production uses the real file system, sockets, and processes.
 * ------------------------------------------------------------------ */

export interface PinokioSpawnedRun {
  pid: number | null
  /** Resolves when the child exits (any way). */
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  /** The last bytes of combined output, capped. */
  outputTail(): string
  kill(): void
}

export interface PinokioDeps {
  platform: NodeJS.Platform
  containerized(): boolean
  homedir(): string
  readFile(file: string): Promise<string | null>
  isFile(file: string): Promise<boolean>
  realpath(file: string): Promise<string | null>
  tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean>
  pathEnv(): string
  runPterm(ptermPath: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<PtermResult>
  spawnPtermRun(ptermPath: string, args: string[], options: { cwd: string }): Promise<PinokioSpawnedRun>
  sleep(ms: number): Promise<void>
  now(): number
}

/* ------------------------------------------------------------------ *
 * Real process plumbing
 * ------------------------------------------------------------------ */

/** Children still running, so a shutdown can end them (SIGKILL only: rule 4). */
const livePtermChildren = new Set<number>()
let shutdownRegistered = false

function killLivePtermChildren() {
  for (const pid of livePtermChildren) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  livePtermChildren.clear()
}

function ensureShutdownHooks() {
  if (shutdownRegistered) return
  shutdownRegistered = true
  registerRuntimeShutdownTask('pinokio-pterm', () => killLivePtermChildren())
  process.on('exit', () => killLivePtermChildren())
}

export function ptermChildEnv(): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1', FORCE_COLOR: '0' }
  for (const key of PTERM_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return env
}

/**
 * `pterm` is a Node script (`#!/usr/bin/env node`). Batshit runs it with its own Node, so a
 * packaged app whose PATH has no `node` still works.
 */
async function ptermScriptPath(ptermPath: string): Promise<string> {
  const resolved = await fs.realpath(ptermPath)
  if (!(await fs.stat(resolved)).isFile()) throw new PtermScriptAdmissionError(PTERM_SCRIPT_UNAVAILABLE_MESSAGE)
  if (/\.(c|m)?js$/.test(resolved)) return resolved
  const head = await fs
    .open(resolved, 'r')
    .then(async (handle) => {
      try {
        const buffer = Buffer.alloc(64)
        const { bytesRead } = await handle.read(buffer, 0, 64, 0)
        return buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    })
    .catch(() => '')
  if (/^#!\s*(?:\/usr\/bin\/env\s+node|(?:\/[^\s/]+)*\/node)\s*$/.test(head.split('\n')[0] ?? '')) {
    return resolved
  }
  throw new PtermScriptAdmissionError(PTERM_SCRIPT_UNAVAILABLE_MESSAGE)
}

function appendCapped(current: string, chunk: string, cap: number): string {
  const next = current + chunk
  return next.length > cap ? next.slice(next.length - cap) : next
}

const realDeps: PinokioDeps = {
  platform: process.platform,
  containerized: () => isContainerizedRuntime(),
  homedir: () => os.homedir(),
  readFile: async (file) => fs.readFile(file, 'utf8').catch(() => null),
  isFile: async (file) =>
    fs
      .stat(file)
      .then((stat) => stat.isFile())
      .catch(() => false),
  realpath: async (file) => fs.realpath(file).catch(() => null),
  tcpReachable: (host, port, timeoutMs) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port })
      const done = (reachable: boolean) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(reachable)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    }),
  pathEnv: () => process.env.PATH ?? '',
  runPterm: async (ptermPath, args, { cwd, timeoutMs }) => {
    ensureShutdownHooks()
    const script = await ptermScriptPath(ptermPath)
    const started = Date.now()
    return await new Promise<PtermResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const child = spawn(process.execPath, [script, ...args], {
        cwd,
        env: ptermChildEnv(),
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const pid = child.pid ?? null
      if (pid) livePtermChildren.add(pid)
      const timer = setTimeout(() => {
        timedOut = true
        if (pid) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }, timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout = appendCapped(stdout, chunk, MAX_CAPTURE_BYTES)
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = appendCapped(stderr, chunk, MAX_CAPTURE_BYTES)
      })
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        if (pid) livePtermChildren.delete(pid)
        resolve({ exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - started })
      }
      child.once('error', (error) => {
        stderr = appendCapped(stderr, `${error.message}\n`, MAX_CAPTURE_BYTES)
        finish(null, null)
      })
      child.once('close', (code, signal) => finish(code, signal))
    })
  },
  spawnPtermRun: async (ptermPath, args, { cwd }) => {
    ensureShutdownHooks()
    const script = await ptermScriptPath(ptermPath)
    let tail = ''
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: ptermChildEnv(),
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const pid = child.pid ?? null
    if (pid) livePtermChildren.add(pid)
    const onData = (chunk: Buffer | string) => {
      tail = appendCapped(tail, typeof chunk === 'string' ? chunk : chunk.toString('utf8'), RUN_OUTPUT_TAIL_BYTES)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', () => {
        if (pid) livePtermChildren.delete(pid)
        resolve({ exitCode: null, signal: null })
      })
      child.once('close', (code, signal) => {
        if (pid) livePtermChildren.delete(pid)
        resolve({ exitCode: code, signal })
      })
    })
    return {
      pid,
      exited,
      outputTail: () => tail,
      kill: () => {
        // Rule 4: SIGKILL only. SIGTERM or SIGINT would make pterm stop the app it started.
        if (pid && livePtermChildren.has(pid)) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now()
}

let deps: PinokioDeps = realDeps

/** The real plumbing, for the tests that run a stand-in `pterm` as a real process. */
export const realPinokioDepsForTests: PinokioDeps = realDeps

export function __setPinokioDepsForTests(overrides: Partial<PinokioDeps> | null) {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps
  detectionCache = null
  runsInFlight.clear()
}

/* ------------------------------------------------------------------ *
 * Parsing (DL-11)
 * ------------------------------------------------------------------ */

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

function excerpt(text: string): string {
  const clean = stripAnsi(text).trim()
  return clean.length > RAW_EXCERPT_CHARS ? `${clean.slice(0, RAW_EXCERPT_CHARS)}…` : clean
}

/** Compares `major.minor.patch`; anything unparsable counts as below the floor. */
export function pinokioVersionAtLeast(version: string | null | undefined, floor = PINOKIO_VERSION_FLOOR): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const have = typeof version === 'string' ? parse(version) : null
  const need = parse(floor)
  if (!have || !need) return false
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index]
  }
  return true
}

/** `pterm version pinokio` prints `pinokio@8.2.0`; with the control plane down it prints nothing. */
export function parsePtermVersion(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([\w.-]+)@(\d+\.\d+\.\d+\S*)\s*$/.exec(line.trim())
    if (match && match[1] === name) return match[2]
  }
  return null
}

/**
 * Reads a failed `pterm` call. Every failure in 0.0.25 is an uncaught AxiosError dump: a closed
 * Pinokio reads ECONNREFUSED, an unknown app reads HTTP 404 with `data: { error: 'App not found' }`.
 */
export function classifyPtermFailure(result: PtermResult): PinokioOutcome<never> {
  if (result.timedOut) {
    return { ok: false, kind: 'error', message: 'Pinokio did not answer in time.' }
  }
  const stderr = stripAnsi(result.stderr)
  if (/\bECONNREFUSED\b/.test(stderr)) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'not_running',
      message: 'Pinokio is installed but not running. Open Pinokio, then try again.'
    }
  }
  const status = /status code (\d{3})/.exec(stderr)?.[1] ?? null
  const dataError = /data:\s*\{\s*error:\s*'([^']*)'/.exec(stderr)?.[1] ?? null
  if (status === '404') {
    return {
      ok: false,
      kind: 'not_found',
      message: `Pinokio has no installed app with that id (${dataError ?? 'App not found'}). Use sys.pinokio.search to list installed apps.`
    }
  }
  const firstLine =
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[A-Za-z]*Error\b/.test(line)) ?? null
  return {
    ok: false,
    kind: 'error',
    message: `pterm failed${status ? ` (HTTP ${status}${dataError ? `: ${dataError}` : ''})` : ''}${
      firstLine && !status ? `: ${firstLine}` : ''
    }.`,
    raw: excerpt(result.stderr || result.stdout)
  }
}

/** `search`, `status`, and `logs` print pretty JSON on stdout. */
export function parsePtermJson(result: PtermResult): PinokioOutcome<Record<string, unknown>> {
  if (result.timedOut || result.exitCode !== 0) return classifyPtermFailure(result)
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
  } catch {
    // Falls through to the visible parse error.
  }
  return {
    ok: false,
    kind: 'error',
    message: 'pterm printed something Batshit does not recognise, so it was not used.',
    raw: excerpt(result.stdout || result.stderr)
  }
}

const APP_STATES = new Set<PinokioAppState>(['offline', 'starting', 'online'])

function unrecognised(json: unknown, what: string): PinokioOutcome<never> {
  return {
    ok: false,
    kind: 'error',
    message: `pterm's ${what} answer is missing a field Batshit reads, so it was not used.`,
    raw: excerpt(JSON.stringify(json))
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** True when the answer came from this machine's Pinokio (DL-07). */
export function isLocalPinokioAnswer(json: Record<string, unknown>): boolean {
  const source = json.source
  return Boolean(source && typeof source === 'object' && (source as Record<string, unknown>).local === true)
}

export function parsePinokioAppStatus(json: Record<string, unknown>): PinokioOutcome<PinokioAppStatus> {
  const appId = stringOrNull(json.app_id)
  const state = json.state
  if (
    !appId ||
    typeof state !== 'string' ||
    !APP_STATES.has(state as PinokioAppState) ||
    typeof json.running !== 'boolean' ||
    typeof json.ready !== 'boolean'
  ) {
    return unrecognised(json, 'status')
  }
  const lastError = json.last_error
  return {
    ok: true,
    value: {
      appId,
      title: stringOrNull(json.title) ?? appId,
      state: state as PinokioAppState,
      running: json.running,
      ready: json.ready,
      readyUrl: stringOrNull(json.ready_url),
      probe: typeof json.probe === 'boolean' ? json.probe : null,
      path: stringOrNull(json.path),
      lastError: lastError == null ? null : typeof lastError === 'string' ? lastError : excerpt(JSON.stringify(lastError))
    }
  }
}

const SEARCH_DESCRIPTION_MAX_CHARS = 240

export function parsePinokioSearch(json: Record<string, unknown>): PinokioOutcome<PinokioSearchResult> {
  if (!Array.isArray(json.apps)) return unrecognised(json, 'search')
  const apps: PinokioSearchApp[] = []
  let skippedRemote = 0
  for (const entry of json.apps) {
    if (!entry || typeof entry !== 'object') return unrecognised(json, 'search')
    const app = entry as Record<string, unknown>
    const appId = stringOrNull(app.app_id)
    const state = app.state
    if (!appId || typeof state !== 'string' || !APP_STATES.has(state as PinokioAppState)) {
      return unrecognised(json, 'search')
    }
    if (!isLocalPinokioAnswer(app)) {
      skippedRemote += 1
      continue
    }
    const description = stringOrNull(app.description)
    apps.push({
      appId,
      title: stringOrNull(app.title) ?? appId,
      description:
        description && description.length > SEARCH_DESCRIPTION_MAX_CHARS
          ? `${description.slice(0, SEARCH_DESCRIPTION_MAX_CHARS)}…`
          : description,
      state: state as PinokioAppState,
      running: app.running === true,
      ready: app.ready === true,
      readyUrl: stringOrNull(app.ready_url)
    })
  }
  return { ok: true, value: { query: typeof json.q === 'string' ? json.q : '', apps, skippedRemote } }
}

export function parsePinokioLogs(json: Record<string, unknown>): PinokioOutcome<PinokioLogs> {
  const appId = stringOrNull(json.app_id)
  if (!appId || !Array.isArray(json.lines)) return unrecognised(json, 'logs')
  const lines: string[] = []
  let total = 0
  let truncated = false
  // Newest last: keep the END of the tail when it is too long.
  for (let index = json.lines.length - 1; index >= 0; index -= 1) {
    const raw = json.lines[index]
    let line = stripAnsi(typeof raw === 'string' ? raw : String(raw))
    if (line.length > LOG_LINE_MAX_CHARS) {
      line = `${line.slice(0, LOG_LINE_MAX_CHARS)}…`
      truncated = true
    }
    if (total + line.length > LOG_TOTAL_MAX_CHARS) {
      truncated = true
      break
    }
    total += line.length
    lines.unshift(line)
  }
  return {
    ok: true,
    value: {
      appId,
      script: stringOrNull(json.script),
      lineCount: typeof json.line_count === 'number' ? json.line_count : null,
      lines,
      truncated
    }
  }
}

/* ------------------------------------------------------------------ *
 * Input rules
 * ------------------------------------------------------------------ */

/**
 * An installed app is named by its folder under `<home>/api/` (for example `comfy.git`).
 * Refused: URLs (`pterm run <url>` downloads and installs), `pinokio://` refs and `id@host`
 * (another machine, DL-07), and anything that could leave the folder.
 */
export function pinokioAppIdProblem(appId: string): string | null {
  const value = appId.trim()
  if (!value) return 'appId is required.'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('://')) {
    return 'appId must be an installed app folder id such as comfy.git, not a URL or a pinokio:// ref. Batshit never installs apps.'
  }
  if (value.includes('@')) {
    return 'appId must name an app on this computer; id@host names another machine, which Batshit does not reach.'
  }
  if (value.includes('/') || value.includes('\\') || value.startsWith('.') || value.length > 200) {
    return 'appId must be one app folder id from sys.pinokio.search, such as comfy.git.'
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value)) {
    return 'appId must be one app folder id from sys.pinokio.search (letters, digits, dots, dashes, underscores).'
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

interface PinokioConfig {
  home: string | null
  version: string | null
}

async function readPinokioConfig(): Promise<PinokioConfig | 'missing' | 'unreadable'> {
  const text = await deps.readFile(path.join(deps.homedir(), '.pinokio', 'config.json'))
  if (text === null) return 'missing'
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    return {
      home: typeof parsed.home === 'string' && parsed.home.trim() ? parsed.home : null,
      version: typeof parsed.version === 'string' ? parsed.version : null
    }
  } catch {
    return 'unreadable'
  }
}

/** Local installation authority only: Pinokio's two npm-prefix paths, then local `PATH`. */
async function resolvePterm(home: string): Promise<string | null> {
  for (const bundled of [path.join(home, 'bin', 'npm', 'bin', 'pterm'), path.join(home, 'bin', 'npm', 'pterm')]) {
    if (await deps.isFile(bundled)) return bundled
  }
  for (const directory of deps.pathEnv().split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, 'pterm')
    if (await deps.isFile(candidate)) return candidate
  }
  return null
}

function unavailableDetection(
  reason: PinokioUnavailableReason,
  message: string,
  extra: Partial<PinokioDetection> = {}
): PinokioDetection {
  return {
    available: false,
    reason,
    message,
    version: null,
    versionFloor: PINOKIO_VERSION_FLOOR,
    home: null,
    ptermPath: null,
    ptermVersion: null,
    controlPlaneReachable: false,
    ...extra
  }
}

let detectionCache: { at: number; value: PinokioDetection } | null = null

export async function detectPinokio(options: { fresh?: boolean } = {}): Promise<PinokioDetection> {
  if (!options.fresh && detectionCache && deps.now() - detectionCache.at < DETECTION_CACHE_MS) {
    return detectionCache.value
  }
  const value = await detectPinokioUncached()
  detectionCache = { at: deps.now(), value }
  return value
}

async function detectPinokioUncached(): Promise<PinokioDetection> {
  if (deps.containerized()) {
    return unavailableDetection(
      'containerized',
      'Pinokio runs on your computer, and Docker Batshit cannot reach it. Use the Mac app or a source install to drive Pinokio.'
    )
  }
  if (deps.platform === 'win32') {
    return unavailableDetection('unsupported_platform', 'Pinokio support needs macOS or Linux for now.')
  }

  const config = await readPinokioConfig()
  if (config === 'missing') return unavailableDetection('not_installed', 'Pinokio not detected.')
  if (config === 'unreadable' || !config.home) {
    return unavailableDetection('not_installed', 'Pinokio not detected: its settings file (~/.pinokio/config.json) could not be read.')
  }
  const home = config.home
  if (config.version && !pinokioVersionAtLeast(config.version)) {
    return unavailableDetection(
      'unsupported_version',
      `Pinokio ${config.version} found; Batshit needs ${PINOKIO_VERSION_FLOOR} or newer.`,
      { version: config.version, home }
    )
  }

  const controlPlaneReachable = await deps.tcpReachable(
    PINOKIO_CONTROL_PLANE_HOST,
    PINOKIO_CONTROL_PLANE_PORT,
    CONTROL_PLANE_CONNECT_TIMEOUT_MS
  )
  const ptermPath = await resolvePterm(home)
  if (!ptermPath) {
    return unavailableDetection('pterm_missing', `Pinokio is installed at ${home}, but its pterm command was not found.`, {
      version: config.version,
      home,
      controlPlaneReachable
    })
  }
  if (!controlPlaneReachable) {
    return unavailableDetection('not_running', 'Pinokio is installed but not running. Open Pinokio, then try again.', {
      version: config.version,
      home,
      ptermPath
    })
  }

  const versionRun = await deps.runPterm(ptermPath, ['version', 'pinokio'], { cwd: home, timeoutMs: PTERM_COMMAND_TIMEOUT_MS }).catch(ptermStartFailure)
  if ('message' in versionRun) {
    return unavailableDetection('pterm_missing', versionRun.message, { home, ptermPath, controlPlaneReachable })
  }
  const version = versionRun.exitCode === 0 ? parsePtermVersion(versionRun.stdout, 'pinokio') : null
  if (!version) {
    // 0.0.25 prints nothing, exit 0, when the control plane went away between the checks.
    return unavailableDetection('not_running', 'Pinokio is installed but not running. Open Pinokio, then try again.', {
      version: config.version,
      home,
      ptermPath
    })
  }
  if (!pinokioVersionAtLeast(version)) {
    return unavailableDetection(
      'unsupported_version',
      `Pinokio ${version} found; Batshit needs ${PINOKIO_VERSION_FLOOR} or newer.`,
      { version, home, ptermPath, controlPlaneReachable }
    )
  }
  const terminalRun = await deps.runPterm(ptermPath, ['version', 'terminal'], { cwd: home, timeoutMs: PTERM_COMMAND_TIMEOUT_MS }).catch(ptermStartFailure)
  if ('message' in terminalRun) {
    return unavailableDetection('pterm_missing', terminalRun.message, { version, home, ptermPath, controlPlaneReachable })
  }
  const ptermVersion = terminalRun.exitCode === 0 ? parsePtermVersion(terminalRun.stdout, 'pterm') : null

  return {
    available: true,
    reason: null,
    message: `Pinokio ${version} detected at ${home}.`,
    version,
    versionFloor: PINOKIO_VERSION_FLOOR,
    home,
    ptermPath,
    ptermVersion,
    controlPlaneReachable: true
  }
}

type ReadyPinokio = PinokioDetection & { available: true; home: string; ptermPath: string }

async function requirePinokio(): Promise<{ ok: true; value: ReadyPinokio } | PinokioOutcome<never>> {
  const detection = await detectPinokio()
  if (!detection.available || !detection.home || !detection.ptermPath) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: detection.reason ?? 'not_installed',
      message: detection.message
    }
  }
  // Rule 6, per call: a Pinokio closed since the cached detection must not become a LAN request.
  const reachable = await deps.tcpReachable(PINOKIO_CONTROL_PLANE_HOST, PINOKIO_CONTROL_PLANE_PORT, CONTROL_PLANE_CONNECT_TIMEOUT_MS)
  if (!reachable) {
    detectionCache = null
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'not_running',
      message: 'Pinokio is installed but not running. Open Pinokio, then try again.'
    }
  }
  return { ok: true, value: detection as ReadyPinokio }
}

async function ptermJson(pinokio: ReadyPinokio, args: string[]): Promise<PinokioOutcome<Record<string, unknown>>> {
  const result = await deps.runPterm(pinokio.ptermPath, args, { cwd: pinokio.home, timeoutMs: PTERM_COMMAND_TIMEOUT_MS }).catch(ptermStartFailure)
  if ('message' in result) {
    detectionCache = null
    return { ok: false, kind: 'error', message: result.message }
  }
  const parsed = parsePtermJson(result)
  if (!parsed.ok && parsed.kind === 'unavailable') detectionCache = null
  return parsed
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

const REMOTE_REFUSAL = 'That app belongs to another Pinokio machine. Batshit drives only the Pinokio on this computer.'

export async function searchPinokioApps(input: { query?: string; limit?: number } = {}): Promise<PinokioOutcome<PinokioSearchResult>> {
  const ready = await requirePinokio()
  if (!ready.ok) return ready
  const args = ['search']
  const query = input.query?.trim()
  if (query) args.push(`--q=${query}`)
  if (input.limit) args.push(`--limit=${input.limit}`)
  const json = await ptermJson(ready.value, args)
  if (!json.ok) return json
  return parsePinokioSearch(json.value)
}

async function readAppStatus(
  pinokio: ReadyPinokio,
  appId: string,
  probe: boolean
): Promise<PinokioOutcome<PinokioAppStatus>> {
  const json = await ptermJson(pinokio, probe ? ['status', appId, '--probe'] : ['status', appId])
  if (!json.ok) return json
  if (!isLocalPinokioAnswer(json.value)) return { ok: false, kind: 'refused', message: REMOTE_REFUSAL }
  return parsePinokioAppStatus(json.value)
}

export async function getPinokioAppStatus(input: { appId: string; probe?: boolean }): Promise<PinokioOutcome<PinokioAppStatus>> {
  const problem = pinokioAppIdProblem(input.appId)
  if (problem) return { ok: false, kind: 'refused', message: problem }
  const ready = await requirePinokio()
  if (!ready.ok) return ready
  return await readAppStatus(ready.value, input.appId.trim(), input.probe !== false)
}

export async function getPinokioAppLogs(input: { appId: string; tail?: number }): Promise<PinokioOutcome<PinokioLogs>> {
  const problem = pinokioAppIdProblem(input.appId)
  if (problem) return { ok: false, kind: 'refused', message: problem }
  const ready = await requirePinokio()
  if (!ready.ok) return ready
  const appId = input.appId.trim()
  // DL-07: logs carry no host, so the status answer vouches for the app first.
  const status = await readAppStatus(ready.value, appId, false)
  if (!status.ok) return status
  const json = await ptermJson(ready.value, ['logs', appId, '--tail', String(input.tail ?? 50)])
  if (!json.ok) return json
  return parsePinokioLogs(json.value)
}

/** Reads `PINOKIO_SCRIPT_REQUIRES=a.git,b` from an app's `ENVIRONMENT` file. */
export function parseScriptRequires(environmentText: string | null): string[] {
  if (!environmentText) return []
  for (const rawLine of environmentText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('PINOKIO_SCRIPT_REQUIRES=')) continue
    const value = line.slice('PINOKIO_SCRIPT_REQUIRES='.length).trim().replace(/^["']|["']$/g, '')
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * Every app a start also starts: Pinokio resolves requirements recursively (A needs B, B needs C
 * and D, so C, D, and B start first). Sorted, without the app itself.
 */
async function resolveRequiredApps(home: string, appId: string): Promise<PinokioOutcome<string[]>> {
  const apiRoot = path.join(home, 'api')
  const found = new Set<string>()
  const visit = async (id: string, depth: number): Promise<string | null> => {
    if (depth > MAX_REQUIRES_DEPTH) return `The requirement chain from ${appId} is deeper than ${MAX_REQUIRES_DEPTH} apps.`
    const requires = parseScriptRequires(await deps.readFile(path.join(apiRoot, id, 'ENVIRONMENT')))
    for (const required of requires) {
      const problem = pinokioAppIdProblem(required)
      if (problem) return `${id} lists a requirement Batshit cannot name safely ("${required}").`
      if (required === appId || found.has(required)) continue
      found.add(required)
      const nested = await visit(required, depth + 1)
      if (nested) return nested
    }
    return null
  }
  const problem = await visit(appId, 0)
  if (problem) return { ok: false, kind: 'refused', message: problem }
  return { ok: true, value: [...found].sort() }
}

function sameSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left.map((entry) => entry.trim()))].sort()
  const b = [...new Set(right.map((entry) => entry.trim()))].sort()
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

function tailLines(text: string, count: number): string[] {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .map((line) => (line.length > LOG_LINE_MAX_CHARS ? `${line.slice(0, LOG_LINE_MAX_CHARS)}…` : line))
}

export interface PinokioStartPreview {
  appId: string
  title: string
  state: PinokioAppState
  ready: boolean
  /** Every app a start also starts (`PINOKIO_SCRIPT_REQUIRES`, followed recursively), sorted. */
  alsoStarts: string[]
}

/**
 * SA-072 P2: what a start of this app would do, for the confirm dialog Batshit's own page
 * shows before a "Start with Pinokio" click reaches `startPinokioApp` (rule 5: the words the
 * user approves name every app the start also starts). Read-only.
 */
export async function previewPinokioAppStart(input: { appId: string }): Promise<PinokioOutcome<PinokioStartPreview>> {
  const problem = pinokioAppIdProblem(input.appId)
  if (problem) return { ok: false, kind: 'refused', message: problem }
  const ready = await requirePinokio()
  if (!ready.ok) return ready
  const appId = input.appId.trim()
  const status = await readAppStatus(ready.value, appId, false)
  if (!status.ok) return status
  const required = await resolveRequiredApps(ready.value.home, appId)
  if (!required.ok) return required
  return {
    ok: true,
    value: {
      appId,
      title: status.value.title,
      state: status.value.state,
      ready: status.value.ready,
      alsoStarts: required.value
    }
  }
}

/** One start per app at a time: parallel tool calls for the same app share the first one. */
const runsInFlight = new Map<string, Promise<PinokioOutcome<PinokioRunResult>>>()

export async function startPinokioApp(input: {
  appId: string
  alsoStarts?: string[]
  waitSeconds?: number
}): Promise<PinokioOutcome<PinokioRunResult>> {
  const problem = pinokioAppIdProblem(input.appId)
  if (problem) return { ok: false, kind: 'refused', message: problem }
  const appId = input.appId.trim()
  const existing = runsInFlight.get(appId)
  if (existing) return await existing
  const run = startPinokioAppOnce({ ...input, appId }).finally(() => runsInFlight.delete(appId))
  runsInFlight.set(appId, run)
  return await run
}

async function startPinokioAppOnce(input: {
  appId: string
  alsoStarts?: string[]
  waitSeconds?: number
}): Promise<PinokioOutcome<PinokioRunResult>> {
  const ready = await requirePinokio()
  if (!ready.ok) return ready
  const pinokio = ready.value
  const { appId } = input
  const startedAt = deps.now()

  // Rule 1: never `pterm run` an app that is already online and ready.
  const before = await readAppStatus(pinokio, appId, false)
  if (!before.ok) return before
  if (before.value.state === 'online' && before.value.ready) {
    const probed = await readAppStatus(pinokio, appId, true)
    const app = probed.ok ? probed.value : before.value
    return {
      ok: true,
      value: {
        appId,
        title: app.title,
        alreadyRunning: true,
        ready: app.probe !== false,
        state: app.state,
        readyUrl: app.readyUrl,
        alsoStarted: [],
        waitedMs: deps.now() - startedAt,
        message:
          app.probe === false
            ? `${app.title} is already running in Pinokio, but it did not answer its probe yet. Nothing was started.`
            : `${app.title} is already running in Pinokio. Nothing was started.`
      }
    }
  }

  // Rule 2: run by the absolute path status reports, inside <home>/api/.
  const appPath = before.value.path
  if (!appPath || !path.isAbsolute(appPath)) {
    return { ok: false, kind: 'refused', message: `Pinokio did not report a folder for ${appId}, so Batshit will not start it.` }
  }
  const realApp = await deps.realpath(appPath)
  const realApiRoot = await deps.realpath(path.join(pinokio.home, 'api'))
  const relative = realApp && realApiRoot ? path.relative(realApiRoot, realApp) : null
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      ok: false,
      kind: 'refused',
      message: `${appId} is not an app folder inside ${path.join(pinokio.home, 'api')}, so Batshit will not start it.`
    }
  }

  // Rule 5: the Approve card must name every app this start also starts.
  const required = await resolveRequiredApps(pinokio.home, appId)
  if (!required.ok) return required
  const alsoStarts = input.alsoStarts ?? []
  if (!sameSet(alsoStarts, required.value)) {
    return {
      ok: false,
      kind: 'refused',
      message:
        required.value.length > 0
          ? `Starting ${before.value.title} also starts ${required.value.join(', ')} (its PINOKIO_SCRIPT_REQUIRES). Nothing was started. Call sys.pinokio.run again with alsoStarts: ${JSON.stringify(required.value)} so the Approve card names every app it starts.`
          : `Starting ${before.value.title} starts no other app. Nothing was started. Call sys.pinokio.run again without alsoStarts.`
    }
  }

  const waitSeconds = Math.min(
    PINOKIO_RUN_MAX_WAIT_SECONDS,
    Math.max(5, Math.round(input.waitSeconds ?? PINOKIO_RUN_DEFAULT_WAIT_SECONDS))
  )
  const deadline = startedAt + waitSeconds * 1000
  console.info(`[pinokio] starting ${appId} through pterm run (wait up to ${waitSeconds}s)`)
  const child = await deps.spawnPtermRun(pinokio.ptermPath, ['run', realApp as string], { cwd: pinokio.home }).catch(ptermStartFailure)
  if ('message' in child) {
    detectionCache = null
    return { ok: false, kind: 'error', message: child.message }
  }
  let childExited = false
  void child.exited.then(() => {
    childExited = true
  })

  try {
    let last: PinokioAppStatus = before.value
    while (deps.now() < deadline) {
      await deps.sleep(RUN_POLL_INTERVAL_MS)
      const status = await readAppStatus(pinokio, appId, false)
      if (!status.ok) return status
      last = status.value
      if (last.state === 'online' && last.ready) {
        const probed = await readAppStatus(pinokio, appId, true)
        if (probed.ok && probed.value.probe === true) {
          console.info(`[pinokio] ${appId} is ready at ${probed.value.readyUrl ?? 'its ready URL'}`)
          return {
            ok: true,
            value: {
              appId,
              title: probed.value.title,
              alreadyRunning: false,
              ready: true,
              state: probed.value.state,
              readyUrl: probed.value.readyUrl,
              alsoStarted: required.value,
              waitedMs: deps.now() - startedAt,
              message: `${probed.value.title} is running in Pinokio and answered its probe.`
            }
          }
        }
        if (probed.ok) last = probed.value
      }
      if (childExited && last.state === 'offline') break
    }

    const outputTail = tailLines(child.outputTail(), 30)
    if (last.state === 'offline') {
      console.warn(`[pinokio] ${appId} did not start (state offline after ${deps.now() - startedAt} ms)`)
      return {
        ok: false,
        kind: 'error',
        message: `${last.title} did not start in Pinokio.${last.lastError ? ` Pinokio reports: ${last.lastError}` : ''} Check sys.pinokio.logs for the reason.`,
        raw: outputTail.join('\n') || undefined
      }
    }
    console.info(`[pinokio] ${appId} is still ${last.state} after ${waitSeconds}s; left starting in Pinokio`)
    return {
      ok: true,
      value: {
        appId,
        title: last.title,
        alreadyRunning: false,
        ready: false,
        state: last.state,
        readyUrl: last.readyUrl,
        alsoStarted: required.value,
        waitedMs: deps.now() - startedAt,
        message: `${last.title} is still starting in Pinokio after ${waitSeconds} s. Pinokio keeps starting it; check again with sys.pinokio.app_status in a little while.`,
        outputTail
      }
    }
  } finally {
    // Rule 4: SIGKILL leaves the app running in Pinokio and nothing of Batshit's behind.
    child.kill()
  }
}
