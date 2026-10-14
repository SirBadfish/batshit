#!/usr/bin/env node
import http from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import os from 'node:os'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createSandboxLifecycleGate } from './sandbox-lifecycle-gate.mjs'
import { limitedOutput } from './agent-browser-sidecar/output-limit.mjs'
// "Stop with Batshit" for host voice engines: the SAME records and decision the Mac supervisor
// and the native launcher use, so a runtime several engines share stops only if every one of
// them says stop, and a pid that now belongs to something else is never killed.
import {
  attachLocalRuntimeLaunchRecordFile,
  decideLocalRuntimeGroupStop,
  groupLocalRuntimeLaunchRecords,
  holdLocalRuntimeStopsForUnreadableRecords,
  isLocalRuntimeProcessAlive,
  launchRecordNamesLeader,
  localRuntimeLaunchRecordWriteBlocker,
  localRuntimeProcessTreeFromWindows,
  normalizeLocalRuntimeEndpoint,
  readLocalRuntimeLaunchRecords,
  readLocalRuntimeProcessGroup,
  readWindowsLocalRuntimeProcesses,
  removeLocalRuntimeLaunchRecord,
  updateLocalRuntimeLaunchRecord,
  writeLocalRuntimeLaunchRecordFile
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs'
// Docker's sbx daemon: recorded when this operator's own call starts it, and stopped when the
// operator stops with Docker Batshit (BL-61, BL-59), by the same module the Mac app uses.
import {
  findSbxOnPath,
  sbxCallStartedDaemon,
  stopSbxDaemonIfBatshitStartedIt,
  writeSbxDaemonRecord
} from '../../batshit-mac/scripts/sbx-daemon-stop.mjs'
import { SANDBOX_COMMAND_END_TIMEOUT_MS, newSandboxCommandTag } from './command-end.mjs'
import { sameWindowsProcess, stopWindowsVoiceProcessTree, validWindowsMembers, windowsMembersAtLaunch } from './windows-voice-process-stop.mjs'
import {
  SBX_COMMAND,
  buildSbxSandboxName,
  buildSbxSessionMarker,
  classifySbxFailure,
  describeSbxFailure,
  isAbandonedSbxSandbox,
  isManagedSbxSandboxName,
  isReusableSbxSandbox,
  parseSbxSandboxList,
  sbxCommandEndArgs,
  sbxCreateArgs,
  sbxDenyAllNetworkArgs,
  sbxExecArgs,
  sbxListArgs,
  sbxPolicyListArgs,
  sbxRemoveArgs,
  sbxSandboxHasWorkspace,
  sbxStopArgs,
  sbxVersionArgs,
  toSbxSandboxPath
} from './sbx-cli.mjs'

const ROOT = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_ROOT || process.cwd()
const ENV_FILE = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_ENV_FILE || '.env.docker'

function loadOperatorEnvFile(root, envFile) {
  const envPath = path.isAbsolute(envFile) ? envFile : path.resolve(root, envFile)
  let text = ''
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    return
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadOperatorEnvFile(ROOT, ENV_FILE)

const HOST = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_HOST || '127.0.0.1'
const PORT = Number(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_PORT || 5629)
const TOKENS = Array.from(
  new Set(
    [
      process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN,
      process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )
)
const MAX_OUTPUT_CHARS = 120_000
const RUN_TIMEOUT_MS = Number(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TIMEOUT_MS || 180_000)
const MAX_RUN_TIMEOUT_MS = 300_000
const SANDBOX_NETWORK_POLICY = 'deny'
// `sbx` may start its background daemon on the first call, and the first sandbox on a
// computer downloads Docker's shell image (about 460 MB), so these are generous; a create
// gets the operator's full run ceiling.
const SBX_TIMEOUT_MS = 60_000
const SBX_CREATE_TIMEOUT_MS = MAX_RUN_TIMEOUT_MS
// Reported by /health; `start-docker` restarts an operator that reports less. It is the
// operator's protocol revision, raised for any change the app or `start-docker` must wait for,
// not only the sandbox lane.
const SANDBOX_REVISION = 12
// F-P5-1: every create and remove of a named sandbox goes through this gate, so a chat's
// parallel first bash calls share one `create`.
const sandboxGate = createSandboxLifecycleGate()
const SANDBOX_CONTAINER_WORKSPACE_ROOT =
  process.env.BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT || '/workspace'
const SANDBOX_HOST_WORKSPACE_ROOT_RAW =
  process.env.BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT ||
  process.env.BATSHIT_WORKSPACE_MOUNT ||
  ''
const HOST_BATSHIT_ROOT = process.env.BATSHIT_HOST_RUNTIME_ROOT || path.join(os.homedir(), '.batshit')
const HOST_VOICE_ALLOWED_ROOTS_RAW =
  process.env.BATSHIT_HOST_VOICE_ALLOWED_ROOTS ||
  [
    path.join(HOST_BATSHIT_ROOT, 'installs'),
    path.join(HOST_BATSHIT_ROOT, 'tools'),
    path.join(HOST_BATSHIT_ROOT, 'runtime')
  ].join(path.delimiter)
const HOST_VOICE_PROFILE_ROOT = path.resolve(HOST_BATSHIT_ROOT, 'voice-profiles')
const HOST_VOICE_RECIPE_KEY_FILE = process.env.BATSHIT_HOST_VOICE_RECIPE_KEY_FILE ||
  path.join(os.homedir(), '.batshit', 'host-operator-secrets', 'voice-recipe.key')
function readHostVoiceRecipeSigningKey() {
  try {
    const details = lstatSync(HOST_VOICE_RECIPE_KEY_FILE)
    if (!details.isFile() || details.isSymbolicLink() ||
        (process.platform !== 'win32' && ((details.mode & 0o077) !== 0 || details.uid !== process.getuid()))) {
      return ''
    }
    return readFileSync(HOST_VOICE_RECIPE_KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}
const HOST_VOICE_RECIPE_SIGNING_KEY = readHostVoiceRecipeSigningKey()
const HOST_VOICE_START_SUPPORTED = /^[a-f0-9]{64}$/i.test(HOST_VOICE_RECIPE_SIGNING_KEY)
const HOST_VOICE_RECIPE_PROOF_MAX_AGE_MS = 30_000
const HOST_VOICE_RECIPE_NONCE_DIR = path.join(path.dirname(HOST_VOICE_RECIPE_KEY_FILE), 'used-voice-recipe-nonces')
const HOST_VOICE_BLOCKED_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl', 'cscript', 'wscript', 'mshta',
  'bash.exe', 'sh.exe', 'zsh.exe', 'fish.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe',
  'wsl.exe', 'cscript.exe', 'wscript.exe', 'mshta.exe'
])
// What this operator started, one launch record per engine (the Mac supervisor's format),
// in its OWN folder: the Mac supervisor and the native launcher read
// `~/.batshit/runtime/voice-engines/`, and must never stop what Docker Batshit started, nor
// this operator what they started. Read afresh on every stop, so a restarted operator still
// knows what it started.
const HOST_VOICE_STATE_DIR = path.resolve(
  expandHomePath(
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR ||
      path.join(HOST_BATSHIT_ROOT, 'runtime', 'runtime-addon-operator', 'voice-engines')
  )
)
// The sbx daemon this operator's calls started, beside its voice records and for the same reason:
// the Mac app and the native launcher never stop what Docker Batshit started, nor it theirs.
const HOST_SBX_DAEMON_STATE_DIR = path.join(path.dirname(HOST_VOICE_STATE_DIR), 'sbx-daemon')
const OPERATOR_OWNER = `docker-operator:${ROOT}`
// Mac/native use process groups; Windows verifies each process through a held handle.
const HOST_VOICE_STOP_SUPPORTED = true
const HOST_VOICE_STOP_GRACE_MS = 2_000
const MAX_HOST_VOICE_REFERENCE_AUDIO_BYTES = 100 * 1024 * 1024
const MAX_HOST_VOICE_REFERENCE_BODY_BYTES = 4 * Math.ceil(MAX_HOST_VOICE_REFERENCE_AUDIO_BYTES / 3) + 16_384

const ADDONS = {
  cloudflared: {
    title: 'Cloudflared Clip Tunnel',
    profile: 'cloudflared',
    start: ['compose', '--env-file', ENV_FILE, '--profile', 'cloudflared', 'up', '-d', '--build', 'cloudflared'],
    stop: ['compose', '--env-file', ENV_FILE, '--profile', 'cloudflared', 'stop', 'cloudflared']
  },
  fbx2vrma: {
    title: 'FBX-to-VRMA Worker',
    profile: 'fbx2vrma',
    start: ['compose', '--env-file', ENV_FILE, '--profile', 'fbx2vrma', 'up', '-d', '--build', 'fbx2vrma-worker'],
    stop: ['compose', '--env-file', ENV_FILE, '--profile', 'fbx2vrma', 'stop', 'fbx2vrma-worker']
  },
  audio2face: {
    title: 'NVIDIA Audio2Face Bridge',
    profile: 'audio2face',
    start: [
      'compose',
      '--env-file',
      ENV_FILE,
      '--profile',
      'audio2face',
      'up',
      '-d',
      '--build',
      'audio2face-bridge'
    ],
    stop: [
      'compose',
      '--env-file',
      ENV_FILE,
      '--profile',
      'audio2face',
      'stop',
      'audio2face-bridge'
    ]
  },
  'agent-browser': {
    title: 'Agent Browser Runtime',
    profile: 'agent-browser',
    start: ['compose', '--env-file', ENV_FILE, '--profile', 'agent-browser', 'up', '-d', '--build', 'agent-browser'],
    stop: ['compose', '--env-file', ENV_FILE, '--profile', 'agent-browser', 'stop', 'agent-browser']
  },
  'comfyui-validation': {
    title: 'ComfyUI Validation Sidecar',
    profile: 'comfyui-validation',
    start: ['compose', '--env-file', ENV_FILE, '--profile', 'comfyui-validation', 'up', '-d', '--build', 'comfyui-validation'],
    stop: ['compose', '--env-file', ENV_FILE, '--profile', 'comfyui-validation', 'stop', 'comfyui-validation']
  },
  livekit: {
    title: 'LiveKit Voice Runtime',
    profile: 'livekit',
    start: [
      'compose',
      '--env-file',
      ENV_FILE,
      '--profile',
      'livekit',
      'up',
      '-d',
      '--build',
      'livekit',
      'livekit-agent'
    ],
    stop: [
      'compose',
      '--env-file',
      ENV_FILE,
      '--profile',
      'livekit',
      'stop',
      'livekit-agent',
      'livekit'
    ]
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function commandOutputLimit(value) {
  if (!Number.isInteger(value)) return MAX_OUTPUT_CHARS
  if (value < 1_000) return 1_000
  if (value > MAX_OUTPUT_CHARS) return MAX_OUTPUT_CHARS
  return value
}

// Plain comparisons, not Math.min/Math.max: CodeQL reads only a comparison as the bound on a
// request's time limit (js/resource-exhaustion, public PR 114).
function clampRunTimeoutMs(value, fallback = RUN_TIMEOUT_MS) {
  const parsed = Number(value)
  const candidate = Math.floor(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback)
  if (candidate > MAX_RUN_TIMEOUT_MS) return MAX_RUN_TIMEOUT_MS
  if (candidate < 1_000) return 1_000
  return candidate
}

function isAuthorized(req) {
  const auth = req.headers.authorization || ''
  const headerToken = req.headers['x-batshit-runtime-addon-operator-token']
  return TOKENS.some((token) => auth === `Bearer ${token}` || headerToken === token)
}

function operatorChildEnv() {
  const childEnv = { ...process.env }
  for (const name of [
    'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN',
    'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN',
    'BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY',
    'BATSHIT_HOST_VOICE_RECIPE_KEY_FILE',
    'BATSHIT_TOKEN'
  ]) delete childEnv[name]
  return childEnv
}

function readBody(req, maxBytes = 16_384) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' }))
      return
    }
    let body = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        req.pause()
        reject(Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      body += String(chunk)
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

function runDocker(args) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('docker', args, {
      cwd: ROOT,
      env: operatorChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = limitedOutput(MAX_OUTPUT_CHARS)
    const stderr = limitedOutput(MAX_OUTPUT_CHARS)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, clampRunTimeoutMs(RUN_TIMEOUT_MS))

    child.stdout.on('data', (chunk) => {
      stdout.append(String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr.append(String(chunk))
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({
        ok: false,
        error: error.message,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout)
      resolve({
        ok: exitCode === 0 && !timedOut,
        error: timedOut
          ? 'Docker Compose command timed out.'
          : exitCode === 0
            ? null
            : stderr.text.trim() || `Docker Compose exited with ${exitCode}.`,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    })
  })
}

// A Stop and a timeout end a command the same way (2026-09-18, the app's `commandEnd.ts`): the
// CLI (SIGTERM, then SIGKILL a second later) and, for a sandbox command, what it started inside
// the sandbox (`endInside`). `signal` is the app's request: it ends at once on a Stop. The run is
// over once the CLI's output has closed and that end is done.
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const maxOutputChars = commandOutputLimit(options.maxOutputChars)
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: operatorChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = limitedOutput(maxOutputChars)
    const stderr = limitedOutput(maxOutputChars)
    let timedOut = false
    let stopped = false
    let settled = false
    let ending = false
    let endedInside = true
    let closed = null
    let spawnError = null

    const settle = () => {
      if (settled || !closed || !endedInside) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      const { exitCode, signal } = closed
      resolve({
        command: [command, ...args].join(' '),
        ok: !spawnError && exitCode === 0 && !timedOut && !stopped,
        error: spawnError
          ? spawnError.message
          : timedOut
            ? 'Command timed out.'
            : stopped
              ? 'Command was stopped.'
              : exitCode === 0
                ? null
                : stderr.text.trim() || `Command exited with ${exitCode}.`,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        signal,
        timedOut,
        ...(stopped ? { stopped: true } : {}),
        durationMs: Date.now() - startedAt,
        truncated: stdout.cut || stderr.cut
      })
    }

    const end = () => {
      if (ending || settled) return
      ending = true
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }, 1_000)
      if (options.endInside) {
        endedInside = false
        options
          .endInside()
          .catch((error) => console.warn('Ending a command inside its sandbox failed:', error))
          .finally(() => {
            endedInside = true
            settle()
          })
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true
      end()
    }, clampRunTimeoutMs(options.timeoutMs))

    const onAbort = () => {
      if (settled) return
      stopped = true
      end()
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => {
      stdout.append(String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr.append(String(chunk))
    })
    child.on('error', (error) => {
      spawnError = error
      closed ??= { exitCode: null, signal: null }
      settle()
    })
    child.on('close', (exitCode, signal) => {
      closed ??= { exitCode, signal }
      settle()
    })
  })
}

function expandHomePath(value) {
  const raw = String(value || '').trim()
  if (!raw) return raw
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

function parseAllowedVoiceRoots() {
  return HOST_VOICE_ALLOWED_ROOTS_RAW.split(path.delimiter)
    .map((entry) => expandHomePath(entry))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => path.resolve(entry))
    .filter(Boolean)
}

function isPathWithinAnyRoot(candidate, roots) {
  return roots.some((root) => isPathWithinRoot(candidate, root))
}

async function resolveExistingVoicePath(value, label, roots) {
  const raw = expandHomePath(value)
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error(`${label} must be an absolute host path or ~/ path.`)
  }
  const resolved = await realpath(raw)
  const profileRoot = await realpath(HOST_VOICE_PROFILE_ROOT).catch(() => HOST_VOICE_PROFILE_ROOT)
  if (isPathWithinRoot(resolved, profileRoot)) {
    throw new Error(`${label} must not be inside Batshit voice profiles.`)
  }
  if (!isPathWithinAnyRoot(resolved, roots)) {
    throw new Error(`${label} must stay inside Batshit voice runtime roots.`)
  }
  return resolved
}

async function resolveVoiceLogPath(value, engineId, roots) {
  const fallback = path.join(HOST_BATSHIT_ROOT, 'runtime', 'voice-engines', engineId, 'logs', 'local-engine-runtime.log')
  const raw = path.resolve(expandHomePath(value || fallback))
  const parent = path.dirname(raw)
  mkdirSync(parent, { recursive: true })
  const parentReal = await realpath(parent)
  const profileRoot = await realpath(HOST_VOICE_PROFILE_ROOT).catch(() => HOST_VOICE_PROFILE_ROOT)
  if (isPathWithinRoot(parentReal, profileRoot)) {
    throw new Error('launch.logPath must not be inside Batshit voice profiles.')
  }
  if (!isPathWithinAnyRoot(parentReal, roots)) {
    throw new Error('launch.logPath must stay inside Batshit voice runtime roots.')
  }
  // A runtime's output must never land in the operator's own launch records, which decide
  // what it may stop.
  const stateDirReal = await realpath(HOST_VOICE_STATE_DIR).catch(() => HOST_VOICE_STATE_DIR)
  if (isPathWithinRoot(parentReal, stateDirReal) || isPathWithinRoot(raw, HOST_VOICE_STATE_DIR)) {
    throw new Error('launch.logPath must not be inside the operator\'s own state folder.')
  }
  return raw
}

function normalizeVoiceEngineId(value) {
  const engineId = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(engineId)) {
    throw new Error('engineId must use lowercase letters, numbers, dot, dash, or underscore.')
  }
  return engineId
}

function normalizeVoiceProfileId(value) {
  const profileId = String(value || '').trim()
  if (!/^voice_[A-Za-z0-9._-]{1,96}$/.test(profileId)) {
    throw new Error('profileId must be a Batshit voice profile id.')
  }
  return profileId
}

function resolveReferenceAudioExtension({ filename, contentType }) {
  const fromFilename = path.extname(String(filename || '')).trim().toLowerCase()
  const byContentType = {
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac'
  }
  const normalizedType = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  const fromType = byContentType[normalizedType]
  const audioExtensions = new Set(Object.values(byContentType))
  if (fromFilename && !audioExtensions.has(fromFilename)) {
    throw new Error('Reference audio filename must use a supported audio extension.')
  }
  if (normalizedType && !fromType) {
    throw new Error('Reference audio content type must be a supported audio type.')
  }
  if (fromFilename && fromType && fromFilename !== fromType) {
    throw new Error('Reference audio filename and content type must agree.')
  }
  if (!fromFilename && !fromType) {
    throw new Error('Reference audio needs a supported audio filename or content type.')
  }
  return fromFilename || fromType
}

function decodeReferenceAudioBase64(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('audioBase64 is required.')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('audioBase64 must be standard base64.')
  }
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length === 0) throw new Error('Reference audio is empty.')
  if (buffer.length > MAX_HOST_VOICE_REFERENCE_AUDIO_BYTES) {
    throw new Error('Reference audio exceeds the host voice profile size limit.')
  }
  return buffer
}

async function writeHostVoiceReferenceAudio(body) {
  const profileId = normalizeVoiceProfileId(body.profileId)
  const audio = decodeReferenceAudioBase64(body.audioBase64)
  const rootPath = path.join(HOST_BATSHIT_ROOT, 'voice-profiles')
  mkdirSync(rootPath, { recursive: true })
  const rootReal = await realpath(rootPath)
  const hostRootReal = await realpath(HOST_BATSHIT_ROOT)
  if (!isPathWithinRoot(rootReal, hostRootReal)) {
    throw new Error('Host voice profile storage root must stay inside Batshit host runtime root.')
  }

  const dirPath = path.join(rootReal, profileId)
  mkdirSync(dirPath, { recursive: true })
  const dirReal = await realpath(dirPath)
  if (!isPathWithinRoot(dirReal, rootReal)) {
    throw new Error('Host voice profile directory must stay inside the Batshit voice profile root.')
  }

  const extension = resolveReferenceAudioExtension({
    filename: body.filename,
    contentType: body.contentType
  })
  const audioPath = path.join(dirReal, `reference${extension}`)
  const tempPath = path.join(dirReal, `.reference-${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, audio, { flag: 'wx', mode: 0o600 })
    await rename(tempPath, audioPath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }

  return {
    profileId,
    audioPath,
    dirPath: dirReal,
    bytes: audio.length
  }
}

function normalizeVoiceLaunchArgs(value, commandBasename) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('launch.args must be an array of strings.')
  const args = value.map((entry) => String(entry))
  const executable = commandBasename.toLowerCase().replace(/\.exe$/, '')
  const isPython = /^(?:pythonw?\d*(?:\.\d+)*|pypy\d*(?:\.\d+)*|py)$/.test(executable)
  const isNode = executable === 'node'
  if (
    (isPython && args.some((arg) => /^-[A-Za-z]*c/.test(arg))) ||
    (isNode && args.some((arg) => /^(?:-e|-p|-pe|--eval(?:=|$)|--print(?:=|$))/.test(arg))) ||
    (isNode && args.some((arg, index) =>
      /^(?:--import|--loader|--experimental-loader|--require|-r)$/.test(arg)
        ? /^data:/i.test(args[index + 1] ?? '')
        : /^(?:--import|--loader|--experimental-loader|--require)=data:|^-rdata:/i.test(arg)
    ))
  ) {
    throw new Error('Inline eval-style launch args are not allowed for host voice runtimes.')
  }
  return args
}

function normalizeVoiceLaunchEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid launch env name "${key}".`)
    }
    if (/^NODE_OPTIONS$|^PYTHON/i.test(key)) {
      throw new Error(`Launch env name "${key}" is not allowed for host voice runtimes.`)
    }
    entries[key] = String(rawValue)
  }
  return entries
}

function verifyHostVoiceRecipeProof(body) {
  if (!HOST_VOICE_START_SUPPORTED) {
    throw new Error('Host voice recipe signing key is not configured.')
  }
  const { proof, ...recipe } = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const issuedAt = proof?.issuedAt
  const nonce = proof?.nonce
  const signature = proof?.signature
  if (
    !Number.isSafeInteger(issuedAt) ||
    Math.abs(Date.now() - issuedAt) > HOST_VOICE_RECIPE_PROOF_MAX_AGE_MS ||
    typeof nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(nonce) ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    throw new Error('A fresh saved voice launch recipe proof is required.')
  }
  const expected = createHmac('sha256', Buffer.from(HOST_VOICE_RECIPE_SIGNING_KEY, 'hex'))
    .update('batshit-host-voice-start-v1\0')
    .update(`${issuedAt}\0${nonce}\0${JSON.stringify(recipe)}`)
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    throw new Error('Saved voice launch recipe proof is invalid.')
  }
  recordHostVoiceRecipeNonce(nonce)
  return recipe
}

function recordHostVoiceRecipeNonce(nonce) {
  // Exclusive creation is the replay gate, including when the operator restarts. These
  // receipts live beside the host-only signing key, outside Docker's writable workspace.
  mkdirSync(HOST_VOICE_RECIPE_NONCE_DIR, { recursive: true, mode: 0o700 })
  const details = lstatSync(HOST_VOICE_RECIPE_NONCE_DIR)
  if (!details.isDirectory() || details.isSymbolicLink() ||
      (process.platform !== 'win32' && ((details.mode & 0o077) !== 0 || details.uid !== process.getuid()))) {
    throw new Error('Host voice recipe nonce directory is not private.')
  }
  for (const name of readdirSync(HOST_VOICE_RECIPE_NONCE_DIR)) {
    if (!/^[a-f0-9-]{36}$/i.test(name)) continue
    const receipt = path.join(HOST_VOICE_RECIPE_NONCE_DIR, name)
    try {
      if (Date.now() - statSync(receipt).mtimeMs > 2 * HOST_VOICE_RECIPE_PROOF_MAX_AGE_MS) rmSync(receipt)
    } catch { /* concurrent cleanup is harmless */ }
  }
  let fd
  try {
    fd = openSync(path.join(HOST_VOICE_RECIPE_NONCE_DIR, nonce), 'wx', 0o600)
    writeSync(fd, `${Date.now()}\n`)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Saved voice launch recipe proof was already used.')
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

async function prepareHostVoiceLaunch(body) {
  const engineId = normalizeVoiceEngineId(body.engineId)
  const launch = body.launch && typeof body.launch === 'object' ? body.launch : null
  if (!launch) throw new Error('launch is required.')
  const roots = []
  for (const root of parseAllowedVoiceRoots()) {
    const resolved = await realpath(root).catch(() => null)
    if (resolved) roots.push(resolved)
  }
  if (roots.length === 0) {
    throw new Error('No readable Batshit host voice runtime roots are configured.')
  }

  const installRoot = await resolveExistingVoicePath(body.installRoot, 'installRoot', roots)
  const command = await resolveExistingVoicePath(launch.command, 'launch.command', roots)
  const commandBasename = path.basename(command)
  if (process.platform === 'win32' && (path.extname(commandBasename).toLowerCase() !== '.exe' || !(await stat(command)).isFile())) {
    throw new Error('Host voice runtime launch.command on Windows must name a regular .exe file.')
  }
  if (HOST_VOICE_BLOCKED_COMMANDS.has(process.platform === 'win32' ? commandBasename.toLowerCase() : commandBasename)) {
    throw new Error(`Host voice runtime launch command "${commandBasename}" is not allowed.`)
  }
  const cwd = launch.cwd
    ? await resolveExistingVoicePath(launch.cwd, 'launch.cwd', roots)
    : installRoot
  const logPath = await resolveVoiceLogPath(launch.logPath, engineId, roots)
  const args = normalizeVoiceLaunchArgs(launch.args, commandBasename)
  const env = normalizeVoiceLaunchEnv(launch.env)

  return {
    engineId,
    installRoot,
    command,
    args,
    cwd,
    env,
    logPath,
    allowedRoots: roots
  }
}

function spawnHostVoiceRuntime(prepared) {
  const fd = openSync(prepared.logPath, 'a')
  try {
    const childEnv = { ...process.env, ...prepared.env }
    for (const name of [
      'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN',
      'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN',
      'BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY',
      'BATSHIT_HOST_VOICE_RECIPE_KEY_FILE',
      'BATSHIT_TOKEN'
    ]) {
      delete childEnv[name]
    }
    const child = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    })
    const launchedAt = new Date().toISOString()
    // A spawn that fails, or a later kill that fails, is reported here: unheard, it would end the
    // operator.
    child.on('error', (error) => {
      console.error(`Host voice engine "${prepared.engineId}" (pid ${child.pid ?? 'none'}): ${error?.message ?? error}`)
    })
    child.unref()
    return { pid: child.pid ?? null, launchedAt, child }
  } finally {
    closeSync(fd)
  }
}

// Every sandbox `sbx` call goes through here; a missing CLI becomes one clear reason, and a call
// that starts Docker's sbx daemon is recorded, so the operator stops it when it stops (BL-61).
async function runSbx(args, options = {}) {
  const callStartedAt = Date.now()
  const run = await runCommand(SBX_COMMAND, args, options)
  if (sbxCallStartedDaemon(run.stderr || '', run.stdout || '')) {
    await writeSbxDaemonRecord(HOST_SBX_DAEMON_STATE_DIR, {
      launchedBy: OPERATOR_OWNER,
      callStartedAt,
      callEndedAt: Date.now(),
      sbxPath: findSbxOnPath()
    }).catch((error) => console.warn(`Could not record the sbx daemon this call started: ${error?.message ?? error}`))
  }
  if (run.ok || !/ENOENT/.test(run.error || '')) return run
  return { ...run, error: `${SBX_COMMAND} is not installed (spawn ${SBX_COMMAND} ENOENT).` }
}

function sbxRunOutput(run) {
  return [run.stderr, run.stdout, run.ok ? '' : run.error]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n')
}

function describeSbxRunFailure(run, action) {
  if (run.timedOut) return `${action} timed out.`
  return describeSbxFailure(sbxRunOutput(run), `${action} failed.`)
}

async function listSandboxes() {
  const run = await runSbx(sbxListArgs(), { timeoutMs: SBX_TIMEOUT_MS })
  if (!run.ok) throw new Error(describeSbxRunFailure(run, 'Listing Docker sandboxes'))
  return parseSbxSandboxList(run.stdout)
}

// `sbx version` works before sign-in, so readiness also lists sandboxes (needs sign-in)
// and reads the policy (needs the one-time preset).
async function checkSbxReadiness() {
  const versionRun = await runSbx(sbxVersionArgs(), { timeoutMs: 10_000 })
  if (!versionRun.ok) {
    return { ok: false, version: null, reason: describeSbxRunFailure(versionRun, 'Checking sbx') }
  }
  const version = versionRun.stdout.trim() || null
  try {
    await listSandboxes()
  } catch (error) {
    return { ok: false, version, reason: error instanceof Error ? error.message : String(error) }
  }
  const policyRun = await runSbx(sbxPolicyListArgs(), { timeoutMs: SBX_TIMEOUT_MS })
  if (!policyRun.ok) {
    return { ok: false, version, reason: describeSbxRunFailure(policyRun, 'Reading the sbx network policy') }
  }
  return { ok: true, version }
}

function isPathWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function assertDirectory(value, label) {
  const details = await stat(value).catch(() => null)
  if (!details?.isDirectory()) {
    throw new Error(`${label} is not a readable directory: ${value}`)
  }
  return await realpath(value)
}

async function resolveWorkspaceMapping({ workspaceRoot, cwd }) {
  const containerRoot = path.posix.resolve('/', SANDBOX_CONTAINER_WORKSPACE_ROOT)
  if (!SANDBOX_HOST_WORKSPACE_ROOT_RAW.trim()) {
    throw new Error(
      'Docker Sandbox operator requires BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT or BATSHIT_WORKSPACE_MOUNT so /workspace can map to a real host directory.'
    )
  }

  const hostRootCandidate = path.isAbsolute(SANDBOX_HOST_WORKSPACE_ROOT_RAW)
    ? SANDBOX_HOST_WORKSPACE_ROOT_RAW
    : path.resolve(ROOT, SANDBOX_HOST_WORKSPACE_ROOT_RAW)
  const hostRoot = await assertDirectory(hostRootCandidate, 'Sandbox host workspace root')

  const mapOne = async (value, label) => {
    const raw = String(value || '').trim()
    if (!raw || !path.posix.isAbsolute(raw)) {
      throw new Error(`${label} must be an absolute path inside ${containerRoot}.`)
    }

    if (raw === hostRoot || raw.startsWith(`${hostRoot}/`)) {
      const resolved = await assertDirectory(raw, label)
      if (!isPathWithinRoot(resolved, hostRoot)) {
        throw new Error(`${label} is outside the sandbox host workspace root.`)
      }
      return resolved
    }

    const normalized = path.posix.normalize(raw)
    if (normalized !== containerRoot && !normalized.startsWith(`${containerRoot}/`)) {
      throw new Error(`${label} must be under ${containerRoot}; received ${raw}.`)
    }

    const relative = path.posix.relative(containerRoot, normalized)
    const mapped = path.resolve(hostRoot, relative)
    const resolved = await assertDirectory(mapped, label)
    if (!isPathWithinRoot(resolved, hostRoot)) {
      throw new Error(`${label} maps outside the sandbox host workspace root.`)
    }
    return resolved
  }

  const hostWorkspaceRoot = await mapOne(workspaceRoot || containerRoot, 'workspaceRoot')
  const hostCwd = await mapOne(cwd || workspaceRoot || containerRoot, 'cwd')
  if (!isPathWithinRoot(hostCwd, hostWorkspaceRoot)) {
    throw new Error('cwd must stay inside workspaceRoot after host workspace mapping.')
  }

  return {
    containerRoot,
    hostRoot,
    hostWorkspaceRoot,
    hostCwd
  }
}

function commandReferencesContainerWorkspace(commandText, containerRoot) {
  const escaped = containerRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.-])${escaped}(/|$)`).test(commandText)
}

async function removeSandbox(name) {
  if (!isManagedSbxSandboxName(name)) return null
  const isGone = (run) => run.ok || classifySbxFailure(sbxRunOutput(run)) === 'not_found'
  const run = await runSbx(sbxRemoveArgs([name]), { timeoutMs: SBX_TIMEOUT_MS })
  if (isGone(run)) return null
  await runSbx(sbxStopArgs([name]), { timeoutMs: SBX_TIMEOUT_MS })
  const retry = await runSbx(sbxRemoveArgs([name]), { timeoutMs: SBX_TIMEOUT_MS })
  if (isGone(retry)) return null
  return describeSbxRunFailure(retry, 'Removing the Docker sandbox')
}

// The prune list is read once up front, so each removal checks again inside the gate: by
// its turn the sandbox may have been used again.
async function removeSandboxIfStillAbandoned(name) {
  try {
    const current = (await listSandboxes()).find((entry) => entry.name === name)
    if (!current || !isAbandonedSbxSandbox(current)) return null
    return await removeSandbox(name)
  } catch (error) {
    return error instanceof Error ? error.message : 'Failed to list Docker sandboxes.'
  }
}

// sbx stops an idle sandbox about 30 s after its last command, so a stopped sandbox can
// belong to a chat that is still running; only one unused for an hour is removed here.
async function pruneAbandonedSandboxes() {
  const warnings = []
  let entries = []
  try {
    entries = await listSandboxes()
  } catch (error) {
    return [error instanceof Error ? error.message : 'Failed to list Docker sandboxes.']
  }
  for (const entry of entries) {
    if (!isManagedSbxSandboxName(entry.name) || !isAbandonedSbxSandbox(entry)) continue
    // A sandbox this operator is creating or using is not abandoned.
    if (sandboxGate.isBusy(entry.name)) continue
    const removal = await sandboxGate.removeIfIdle(entry.name, () =>
      removeSandboxIfStillAbandoned(entry.name)
    )
    if (removal.removed && removal.value) warnings.push(`${entry.name}: ${removal.value}`)
  }
  return warnings
}

async function prepareSandbox({ userId, sessionId, workspaceRoot, cwd }) {
  const mapping = await resolveWorkspaceMapping({ workspaceRoot, cwd })
  const sandboxName = buildSbxSandboxName({
    userId,
    workspaceRoot: mapping.hostWorkspaceRoot,
    sessionId
  })
  return { sandboxName, mapping }
}

// Runs inside `sandboxGate.ensure`, so one call at a time per sandbox name.
async function startSandbox({ sandboxName, hostWorkspaceRoot }) {
  const usable = (entry) =>
    Boolean(entry) && isReusableSbxSandbox(entry) && sbxSandboxHasWorkspace(entry, hostWorkspaceRoot)
  const existing = (await listSandboxes()).find((entry) => entry.name === sandboxName)

  if (!usable(existing)) {
    if (existing) {
      const warning = await removeSandbox(sandboxName)
      if (warning) throw new Error(`Could not replace the unusable Docker sandbox ${sandboxName}: ${warning}`)
    }
    const createRun = await runSbx(
      sbxCreateArgs({ sandboxName, workspaceRoot: hostWorkspaceRoot }),
      { timeoutMs: SBX_CREATE_TIMEOUT_MS }
    )
    if (!createRun.ok) {
      // Another process created this sandbox between the list and the create: use it.
      const createdElsewhere =
        classifySbxFailure(sbxRunOutput(createRun)) === 'already_exists' &&
        usable((await listSandboxes()).find((entry) => entry.name === sandboxName))
      if (!createdElsewhere) throw new Error(describeSbxRunFailure(createRun, 'Creating the Docker sandbox'))
    }
  }

  // Applied on every run: a repeat is a no-op, and it also covers a sandbox created without
  // the rule. A stopped sandbox needs no start here; `sbx exec` starts it.
  const policyRun = await runSbx(sbxDenyAllNetworkArgs(sandboxName), { timeoutMs: SBX_TIMEOUT_MS })
  if (!policyRun.ok) {
    throw new Error(describeSbxRunFailure(policyRun, 'Blocking network access for the Docker sandbox'))
  }
}

// Concurrent callers for one sandbox share one create.
async function ensureSandboxReady(prepared) {
  await sandboxGate.ensure(prepared.sandboxName, () =>
    startSandbox({
      sandboxName: prepared.sandboxName,
      hostWorkspaceRoot: prepared.mapping.hostWorkspaceRoot
    })
  )
  return prepared
}

async function handleSandboxStatus(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  const workspace = {
    containerRoot: SANDBOX_CONTAINER_WORKSPACE_ROOT,
    hostRoot: SANDBOX_HOST_WORKSPACE_ROOT_RAW || null
  }
  const readiness = SANDBOX_HOST_WORKSPACE_ROOT_RAW.trim()
    ? await checkSbxReadiness()
    : {
        ok: false,
        version: null,
        reason:
          'Docker Sandbox operator requires BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT or BATSHIT_WORKSPACE_MOUNT so /workspace can map to a real host directory.'
      }
  json(res, 200, {
    ok: true,
    available: readiness.ok,
    supported: true,
    reason: readiness.ok ? null : readiness.reason,
    policy: SANDBOX_NETWORK_POLICY,
    cli: readiness.version ? 'sbx' : null,
    version: readiness.version,
    driver: 'operator',
    capabilities: ['status', 'recover', 'execute', 'cleanup'],
    workspace
  })
}

async function handleSandboxRecover(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  let body
  try {
    body = await readBody(req)
    const ensured = await ensureSandboxReady(
      await prepareSandbox({
        userId: body.userId,
        workspaceRoot: body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT,
        cwd: body.cwd || body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT
      })
    )
    json(res, 200, {
      ok: true,
      success: true,
      recovered: true,
      sandboxName: ensured.sandboxName,
      workspaceRoot: body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT,
      mappedWorkspaceRoot: ensured.mapping.hostWorkspaceRoot,
      mappedCwd: ensured.mapping.hostCwd,
      cli: 'sbx',
      policy: SANDBOX_NETWORK_POLICY
    })
  } catch (error) {
    json(res, 500, {
      ok: false,
      success: false,
      recovered: false,
      error: error instanceof Error ? error.message : 'Failed to recover Docker sandbox.'
    })
  }
}

// A stopped or timed-out command's end inside its sandbox, by its tag (`command-end.mjs`).
async function endSandboxCommand(sandboxName, tag) {
  const run = await runSbx(sbxCommandEndArgs({ sandboxName, tag }), {
    timeoutMs: SANDBOX_COMMAND_END_TIMEOUT_MS
  })
  if (run.ok) return
  // A sandbox removed meanwhile (the chat's run-end cleanup) took everything in it along.
  if (classifySbxFailure(sbxRunOutput(run)) === 'not_found') return
  const stillThere = await listSandboxes()
    .then((entries) => entries.some((entry) => entry.name === sandboxName))
    .catch(() => true)
  if (!stillThere) return
  // JSON.stringify keeps the request's sandbox name and the CLI's output on one log line
  // (CodeQL js/log-injection, public PR 114).
  console.warn(
    `Could not end what a stopped command started in ${JSON.stringify(sandboxName)}: ${JSON.stringify(describeSbxRunFailure(run, `Ending the command (exit ${run.exitCode ?? run.signal})`))}`
  )
}

async function handleSandboxExecute(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  // The app ends its request at once on a Stop (2026-09-18). The operator used to run its
  // `sbx exec` on regardless, and sbx passes no signal into the sandbox, so the command ran on
  // until the chat's run-end cleanup removed the sandbox. `res` closes unfinished when the app
  // goes; `req`'s own close fires as soon as the body is read.
  const requestGone = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) requestGone.abort()
  })
  let body
  let releaseLease = null
  try {
    body = await readBody(req)
    const commandText = String(body.command || '').trim()
    if (!commandText) throw new Error('command is required.')
    const workspaceRoot = body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT
    const cwd = body.cwd || workspaceRoot
    const mapping = await resolveWorkspaceMapping({ workspaceRoot, cwd })
    if (
      mapping.containerRoot !== mapping.hostRoot &&
      commandReferencesContainerWorkspace(commandText, mapping.containerRoot)
    ) {
      throw new Error(
        `In Docker Sandbox, ${mapping.containerRoot} is ${toSbxSandboxPath(mapping.hostRoot)}; use relative paths or that path in sandbox commands.`
      )
    }
    const prepared = await prepareSandbox({
      userId: body.userId,
      sessionId: body.sessionId,
      workspaceRoot,
      cwd
    })
    // Held until the command returns, so no cleanup removes the sandbox under it.
    releaseLease = sandboxGate.lease(prepared.sandboxName)
    // A Stop never cuts a sandbox start in half: the start finishes, and the command never runs.
    const ensured = await ensureSandboxReady(prepared)
    const tag = newSandboxCommandTag()
    const run = requestGone.signal.aborted
      ? null
      : await runSbx(
          sbxExecArgs({
            sandboxName: ensured.sandboxName,
            cwd: ensured.mapping.hostCwd,
            env: body.env && typeof body.env === 'object' ? body.env : {},
            command: commandText,
            tag
          }),
          {
            timeoutMs: body.timeoutMs,
            maxOutputChars: body.maxOutputChars,
            signal: requestGone.signal,
            endInside: () => endSandboxCommand(ensured.sandboxName, tag)
          }
        )
    const warnings = []
    if (!body.sessionId) {
      // A one-shot sandbox goes away with its command, unless another one-shot command
      // for the same workspace still runs in it; that command removes it when it ends.
      releaseLease()
      releaseLease = null
      const removal = await sandboxGate.removeIfIdle(ensured.sandboxName, () =>
        removeSandbox(ensured.sandboxName)
      )
      if (removal.removed && removal.value) warnings.push(`${ensured.sandboxName}: ${removal.value}`)
      warnings.push(...(await pruneAbandonedSandboxes()))
    }
    // Nobody is waiting for an answer.
    if (requestGone.signal.aborted) return
    json(res, 200, {
      ok: true,
      sandboxName: ensured.sandboxName,
      mappedWorkspaceRoot: ensured.mapping.hostWorkspaceRoot,
      mappedCwd: ensured.mapping.hostCwd,
      cli: 'sbx',
      warnings,
      run
    })
  } catch (error) {
    if (requestGone.signal.aborted) return
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Docker Sandbox execution failed.'
    })
  } finally {
    releaseLease?.()
  }
}

async function handleSandboxCleanup(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  try {
    const body = await readBody(req)
    const sessionId = String(body.sessionId || '').trim()
    let entries
    try {
      entries = await listSandboxes()
    } catch (error) {
      // An sbx that is missing or not set up cannot have made a sandbox for this run.
      const reason = error instanceof Error ? error.message : String(error)
      const kind = classifySbxFailure(reason)
      if (kind === 'not_installed' || kind === 'not_signed_in' || kind === 'network_policy_not_initialized') {
        json(res, 200, { ok: true, warnings: [] })
        return
      }
      throw error
    }
    const warnings = []
    if (sessionId) {
      const marker = buildSbxSessionMarker(sessionId)
      for (const entry of entries) {
        if (!isManagedSbxSandboxName(entry.name) || !entry.name.includes(marker)) continue
        // The chat's run is over, so this removal does not wait for a command it started.
        // It does wait for a create already under way, instead of removing a starting sandbox.
        const warning = await sandboxGate.remove(entry.name, () => removeSandbox(entry.name))
        if (warning) warnings.push(`${entry.name}: ${warning}`)
      }
    }
    warnings.push(...(await pruneAbandonedSandboxes()))
    json(res, 200, { ok: true, warnings })
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Docker Sandbox cleanup failed.'
    })
  }
}

async function handleAddonAction(req, res, addonId, action) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }

  const addon = ADDONS[addonId]
  if (!addon) {
    json(res, 404, { ok: false, error: `Unknown runtime add-on "${addonId}".` })
    return
  }
  if (action !== 'start' && action !== 'stop') {
    json(res, 404, { ok: false, error: `Unsupported runtime add-on action "${action}".` })
    return
  }

  try {
    await readBody(req)
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Invalid request body.' })
    return
  }

  const args = addon[action]
  const result = await runDocker(args)
  json(res, result.ok ? 200 : 500, {
    ok: result.ok,
    addonId,
    action,
    title: addon.title,
    command: ['docker', ...args].join(' '),
    cwd: ROOT,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    ...result
  })
}

async function handleVoiceEngineStart(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }

  try {
    const body = verifyHostVoiceRecipeProof(await readBody(req))
    // Checked before anything starts, so a launch is never left unrecorded over a bad name.
    const owner = normalizeVoiceOwner(body.owner)
    const prepared = await prepareHostVoiceLaunch(body)
    // A launch record this operator cannot read is never written over (BL-1267), so such a start is
    // refused before anything runs. The write checks again under the folder's lock, and a launch it
    // then cannot record is stopped below.
    const blocked = await localRuntimeLaunchRecordWriteBlocker(HOST_VOICE_STATE_DIR, prepared.engineId)
    if (blocked) {
      json(res, 409, { ok: false, success: false, error: `Did not start host voice engine "${prepared.engineId}": ${blocked}` })
      return
    }
    const { pid, launchedAt, child } = spawnHostVoiceRuntime(prepared)
    if (!pid) {
      // Nothing started (the spawn failed; its error is logged above).
      json(res, 500, { ok: false, success: false, error: `Did not start host voice engine "${prepared.engineId}": its process did not start.` })
      return
    }
    const recordError = await recordHostVoiceLaunch(prepared, pid, launchedAt, body, owner)
    if (recordError) {
      // Started but unrecorded, it would run on with nothing that could ever stop it.
      const cleanup = await stopUnrecordedHostVoiceLaunch(child)
      // No hint for one that already exited: its pid may belong to another process by now.
      const stopHint = cleanup.exited
        ? ''
        : process.platform === 'win32' ? `; end process ${pid} in Task Manager` : `; stop it with "kill -TERM -${pid}"`
      const error = cleanup.stopped
        ? `Started host voice engine "${prepared.engineId}" but could not record it, so it stopped it again: ${recordError}`
        : `Started host voice engine "${prepared.engineId}" (pid ${pid}) but could not record it, and ${cleanup.reason}${stopHint}. ${recordError}`
      console.error(error)
      json(res, 500, { ok: false, success: false, engineId: prepared.engineId, pid, recorded: false, stopped: cleanup.stopped, error })
      return
    }
    json(res, 200, {
      ok: true,
      success: true,
      engineId: prepared.engineId,
      pid,
      command: prepared.command,
      args: prepared.args,
      cwd: prepared.cwd,
      installRoot: prepared.installRoot,
      logPath: prepared.logPath,
      recorded: true
    })
  } catch (error) {
    json(res, 500, {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start host voice runtime.'
    })
  }
}

// ---- "Stop with Batshit" for host voice engines (revision 5, 2026-09-18) --------------------

// The launch record for what this operator just started. A record whose process still runs is
// moved aside, never overwritten (`writeLocalRuntimeLaunchRecordFile`). It names the Docker
// Batshit that asked (`launchedBy`), when that Batshit says who it is. Answers the error text,
// or null.
async function recordHostVoiceLaunch(prepared, pid, launchedAt, body, owner) {
  const endpoint = normalizeLocalRuntimeEndpoint(body?.endpoint)
  const windowsProcesses = process.platform === 'win32' ? await readWindowsLocalRuntimeProcesses() : null
  const windowsTree = windowsProcesses ? localRuntimeProcessTreeFromWindows(windowsProcesses, pid) : null
  const windowsMembers = windowsMembersAtLaunch(windowsTree, Date.parse(launchedAt))
  try {
    await writeLocalRuntimeLaunchRecordFile(HOST_VOICE_STATE_DIR, {
      engineId: prepared.engineId,
      pid,
      command: prepared.command,
      args: prepared.args,
      cwd: prepared.cwd,
      logPath: prepared.logPath,
      ...(endpoint ? { endpoint } : {}),
      ...(typeof body?.stopOnShutdown === 'boolean' ? { stopOnShutdown: body.stopOnShutdown } : {}),
      ...(owner ? { launchedBy: owner } : {}),
      ...(process.platform === 'win32' ? { windowsMembers } : {}),
      launchedAt
    }, {
      isAlive: process.platform === 'win32'
        ? (previousPid, previous) => windowsProcesses === null || windowsRecordAlive(previousPid, previous, windowsProcesses)
        : isLocalRuntimeProcessAlive
    })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const UNRECORDED_LAUNCH_STOP_WAIT_MS = 2_000

// A launch this operator spawned but could not record (BL-1267). Only that child is stopped, and
// only while Node has not reaped it: until then its pid, and on POSIX the process group it leads
// (it was spawned detached), cannot belong to any other process, so no attached, shared or later
// process can be hit. One that already exited is left alone. Answers whether it ended, or why not.
async function stopUnrecordedHostVoiceLaunch(child) {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) {
    return { stopped: false, exited: true, reason: 'it had already exited, so anything it started was left as it was' }
  }
  let timer = null
  const ended = new Promise((resolve) => {
    child.once('exit', () => resolve(true))
    timer = setTimeout(() => resolve(false), UNRECORDED_LAUNCH_STOP_WAIT_MS)
  })
  try {
    // Windows: Node's own handle to its child, so the pid cannot have been reused.
    if (process.platform === 'win32') {
      if (!child.kill('SIGKILL')) {
        clearTimeout(timer)
        return { stopped: false, reason: 'it could not be stopped' }
      }
    } else process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      clearTimeout(timer)
      return { stopped: false, reason: `it could not be stopped (${error?.code ?? error?.message ?? error})` }
    }
  }
  const stopped = await ended
  clearTimeout(timer)
  return stopped
    ? { stopped: true }
    : { stopped: false, reason: `it did not end within ${UNRECORDED_LAUNCH_STOP_WAIT_MS / 1000} seconds of SIGKILL` }
}

// Which Docker Batshit is asking (revision 7, BL-18). Several can share this operator (two
// Compose projects started from one `.env.docker`, which holds its token, or a copied one), and
// its records are one folder, so each launch record names the Batshit that asked (`launchedBy`),
// and a stop touches only the caller's own. The name is the app's `BATSHIT_VOICE_RUNTIME_OWNER`,
// which `compose.yaml` sets to `docker:` and the Compose project name (the identity the Mac
// supervisor and the native launcher give their apps). Null when the app does not say: a
// container created from an older `compose.yaml`.
const UNNAMED_APP_OWNER = 'docker-app:unnamed'

function normalizeVoiceOwner(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('owner must be a string.')
  const owner = value.trim()
  if (!owner) return null
  if (owner.length > 200 || /\p{Cc}/u.test(owner)) {
    throw new Error('owner must be one line of at most 200 characters naming this Docker Batshit.')
  }
  if (owner === UNNAMED_APP_OWNER) throw new Error(`owner "${UNNAMED_APP_OWNER}" is reserved for an app that sends no name.`)
  return owner
}

// The records a stop may apply the caller's choices to: its own launches (and the attach records
// copied from them), and unmarked ones, written before launches named their Batshit, which keep the
// old rules. An app that names no Batshit is given only unmarked records.
function voiceRecordIsCallers(record, owner) {
  if (!record.launchedBy) return true
  return Boolean(owner) && record.launchedBy === owner
}

function normalizeVoiceStopChoices(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('engines must be an array.')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Each engine must be an object.')
    return {
      engineId: normalizeVoiceEngineId(entry.engineId),
      endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : null,
      stopOnShutdown: entry.stopOnShutdown !== false
    }
  })
}

// The app names every engine it has. So first tidy: an attach record whose engine is not named,
// or is named with another endpoint (deleted, or moved to another port), goes, or its "keep
// running" would hold a shared runtime up with no switch left; an unnamed engine's own launch
// keeps its record (the process still runs) but loses a saved "keep running": no saved choice
// means stop. Then the named engines' current choices go into their records (every copy), and
// an engine that uses a runtime another engine's launch started gets an attach record. All of it
// only on the caller's records (BL-18): another Docker Batshit's engines, even ones with the same
// id, are its own to choose for, and an engine that uses a runtime another Batshit launched gets
// no say over it (as with Connect Existing: the caller did not start it).
async function applyVoiceStopChoices(choices, owner) {
  const isCallers = (record) => voiceRecordIsCallers(record, owner)
  const named = new Map(choices.map((choice) => [choice.engineId, choice]))
  const windowsProcesses = process.platform === 'win32' ? await readWindowsLocalRuntimeProcesses() : undefined
  if (process.platform === 'win32' && windowsProcesses === null) {
    throw new Error('the Windows process table could not be read while applying voice stop choices; no host voice engines were stopped')
  }
  const recordIsAlive = process.platform === 'win32'
    ? (pid, record) => Array.isArray(windowsProcesses) && windowsRecordAlive(pid, record, windowsProcesses)
    : isLocalRuntimeProcessAlive
  for (const record of await readLocalRuntimeLaunchRecords(HOST_VOICE_STATE_DIR)) {
    if (record.invalid || !isCallers(record)) continue
    const choice = named.get(record.engineId)
    try {
      if (record.startedBy) {
        const stillUsed =
          choice &&
          normalizeLocalRuntimeEndpoint(choice.endpoint) === normalizeLocalRuntimeEndpoint(record.endpoint)
        if (!stillUsed) await removeLocalRuntimeLaunchRecord(record)
      } else if (!choice && record.stopOnShutdown === false) {
        await updateLocalRuntimeLaunchRecord(record, { stopOnShutdown: undefined })
      }
    } catch (error) {
      console.warn(`Could not tidy the launch record of "${record.engineId}": ${error?.message ?? error}`)
    }
  }

  const records = await readLocalRuntimeLaunchRecords(HOST_VOICE_STATE_DIR)
  for (const choice of choices) {
    const own = records.filter(
      (record) => record.engineId === choice.engineId && !record.invalid && isCallers(record)
    )
    try {
      for (const record of own) {
        if (record.stopOnShutdown === choice.stopOnShutdown) continue
        await updateLocalRuntimeLaunchRecord(record, { stopOnShutdown: choice.stopOnShutdown })
      }
      if (choice.endpoint && windowsProcesses !== null && !own.some((record) => recordIsAlive(record.pid, record))) {
        await attachLocalRuntimeLaunchRecordFile(HOST_VOICE_STATE_DIR, choice, {
          isStarter: isCallers,
          isAlive: recordIsAlive
        })
      }
    } catch (error) {
      console.warn(`Could not record the choice of "${choice.engineId}": ${error?.message ?? error}`)
    }
  }
}

// Is anything left in this process group?
function voiceRuntimeGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function terminateVoiceRuntimeGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch (error) {
    if (error?.code === 'ESRCH') return true
  }
  const deadline = Date.now() + HOST_VOICE_STOP_GRACE_MS
  while (Date.now() < deadline) {
    if (!voiceRuntimeGroupAlive(pgid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch (error) {
    if (error?.code === 'ESRCH') return true
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  return !voiceRuntimeGroupAlive(pgid)
}

function forceKillWindowsVoiceProcess(pid, startedAtMs) {
  // Holding the Process handle prevents PID reuse while StartTime is compared
  // and Kill runs. A separate taskkill after a CIM read would reopen a PID that
  // may already belong to another process.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `try { $target = Get-Process -Id ${pid} -ErrorAction Stop } catch { 'gone'; exit 0 }`,
    '$heldHandle = $target.Handle',
    `$started = ([DateTimeOffset]$target.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
    `if ($started -ne ${startedAtMs}) { 'mismatch'; exit 0 }`,
    '$target.Kill()',
    "'killed'"
  ].join('; ')
  return new Promise((resolve) => {
    execFile(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 3_000, windowsHide: true },
      (error, stdout, stderr) => resolve(error ? `error: ${String(stderr || error.message).trim()}` : String(stdout).trim())
    )
  })
}

// The pid-reuse test for this operator's records. Launch args come from the app container, the
// less trusted side of this boundary, so only paths the operator can vouch for count: the
// command and cwd it resolved at start, and args that are paths inside its allowed roots (never a
// root itself). An arg like `/` would otherwise match almost any process that later took the pid.
function operatorRecordMatchesCommand(record, commandLine, roots) {
  const candidates = [record.command, record.cwd, ...(Array.isArray(record.args) ? record.args : [])]
    .filter((value) => typeof value === 'string' && path.isAbsolute(value))
    .map((value) => path.resolve(value))
    .filter((value) => isPathWithinAnyRoot(value, roots) && !roots.some((root) => path.relative(root, value) === ''))
  if (process.platform !== 'win32') return candidates.some((candidate) => commandLine.includes(candidate))
  const line = String(commandLine).replaceAll('"', '').replaceAll('/', '\\').toLowerCase()
  return candidates.some((candidate) => {
    const needle = candidate.replaceAll('/', '\\').toLowerCase()
    let at = line.indexOf(needle)
    while (at !== -1) {
      const before = line[at - 1] ?? ''
      const after = line[at + needle.length] ?? ''
      if (!/[a-z0-9_.\\-]/.test(before) && !/[a-z0-9_.-]/.test(after)) return true
      at = line.indexOf(needle, at + 1)
    }
    return false
  })
}

async function voiceMatchRoots() {
  const roots = new Set()
  for (const root of parseAllowedVoiceRoots()) {
    roots.add(root)
    roots.add(await realpath(root).catch(() => root))
  }
  return [...roots]
}

function windowsRecordAlive(pid, record, processes) {
  const members = validWindowsMembers(record.windowsMembers)
  if (members.some((member) => sameWindowsProcess(processes, member))) return true
  if (members.length) return false
  const root = processes.find((entry) => entry.pid === pid)
  return root ? launchRecordNamesLeader(record, root.startedAtMs) === true : false
}

// One PROCESS with every record that names it, decided by the shared module. Detached runtimes
// lead their own process group; the leader's start time against the launch time this operator
// recorded, then the group's live command lines, are the pid-reuse guard. `owner` is the Batshit
// this stop is for: a process another Docker Batshit launched keeps running (BL-18); null only
// for the operator's own stop with Docker Batshit, when no client of it is left.
async function stopRecordedVoiceRuntime({ pid, records }, roots, owner, windowsProcesses, readWindowsProcesses) {
  const windows = process.platform === 'win32'
  const knownMembers = windows ? validWindowsMembers(records.flatMap((record) => record.windowsMembers ?? [])) : []
  const rootStarts = new Set(knownMembers.filter((member) => member.pid === pid).map((member) => member.startedAtMs))
  if (rootStarts.size > 1) {
    return { kind: 'notStopped', pid, engineIds: records.map((record) => record.engineId), reason: 'records name different Windows launches for this PID' }
  }
  const knownRoot = knownMembers.find((member) => member.pid === pid)
  const currentRoot = Array.isArray(windowsProcesses) ? windowsProcesses.find((entry) => entry.pid === pid) : null
  if (windows && !knownMembers.length && Array.isArray(windowsProcesses) &&
      !records.some((record) => currentRoot && launchRecordNamesLeader(record, currentRoot.startedAtMs) === true)) {
    for (const record of records.filter((entry) => owner === null || voiceRecordIsCallers(entry, owner))) {
      await removeLocalRuntimeLaunchRecord(record)
    }
    return {
      kind: 'notStopped', pid,
      engineIds: records.map((record) => record.engineId),
      reason: 'no process identity was recorded at launch; the root is no longer running, so its launch record was removed'
    }
  }
  const rootIsKnown = !knownRoot || currentRoot?.startedAtMs === knownRoot.startedAtMs
  const tree = windows && Array.isArray(windowsProcesses) && rootIsKnown
    ? localRuntimeProcessTreeFromWindows(windowsProcesses, pid)
    : null
  const liveKnown = Array.isArray(windowsProcesses)
    ? knownMembers.flatMap((member) => windowsProcesses.filter((entry) => entry.pid === member.pid && entry.startedAtMs === member.startedAtMs))
    : []
  // A Windows root may exit while known children survive. Keep the stop decision
  // alive until their recorded identities are checked; identity-free records are
  // handled above.
  const alive = windows ? true : isLocalRuntimeProcessAlive(pid)
  const group = windows
    ? (windowsProcesses === null ? null : {
        commandLines: [...new Set([...liveKnown, ...(tree?.members ?? [])].map((member) => member.commandLine).filter(Boolean))],
        leaderStartedAtMs: knownRoot?.startedAtMs ?? tree?.leaderStartedAtMs ?? null
      })
    : alive
      ? await readLocalRuntimeProcessGroup(pid)
      : { commandLines: [], leaderStartedAtMs: null }
  const decision = decideLocalRuntimeGroupStop({
    records,
    alive,
    commandLines: group ? group.commandLines : null,
    leaderStartedAtMs: group ? group.leaderStartedAtMs : null,
    matchesCommand: (record, line) => operatorRecordMatchesCommand(record, line, roots),
    owner
  })
  if (!windows) for (const record of decision.stale) await removeLocalRuntimeLaunchRecord(record)
  const live = records.filter((record) => !decision.stale.includes(record))
  const engineIds = (live.length ? live : records).map((record) => record.engineId)

  if (decision.action === 'drop-records') return null
  if (decision.action === 'keep-running') return { kind: 'keptRunning', pid, engineIds, reason: decision.reason }
  if (windows && !knownMembers.length && Array.isArray(windowsProcesses)) {
    return { kind: 'notStopped', pid, engineIds, reason: 'no process identity was recorded at launch; left running with its launch record' }
  }
  if (decision.action === 'refuse' || decision.action === 'unverified') {
    return { kind: 'notStopped', pid, engineIds, reason: decision.reason }
  }
  if (windows) {
    const result = await stopWindowsVoiceProcessTree({
      rootPid: pid,
      knownMembers,
      initialProcesses: windowsProcesses,
      readProcesses: readWindowsProcesses,
      killProcess: forceKillWindowsVoiceProcess,
      persistMembers: async (members) => {
        for (const record of live) {
          if (!(await updateLocalRuntimeLaunchRecord(record, { windowsMembers: members }))) {
            throw new Error(`launch record for ${record.engineId} changed while recording Windows process identities`)
          }
        }
      }
    })
    if (!result.ok) return { kind: 'notStopped', pid, engineIds, reason: result.reason }
    if (result.wasNotRunning) {
      for (const record of live) await removeLocalRuntimeLaunchRecord(record)
      return null
    }
  } else if (!(await terminateVoiceRuntimeGroup(pid))) {
    return { kind: 'notStopped', pid, engineIds, reason: 'it did not stop after SIGKILL' }
  }
  for (const record of live) await removeLocalRuntimeLaunchRecord(record)
  return { kind: 'stopped', pid, engineIds }
}

// The records a stop decides on, grouped by process. Windows may reuse a PID while a dead engine's
// record remains, so records for different root births stay separate, their copied attach records
// included. An app's stop leaves a process none of whose records are its own alone entirely: another
// Docker Batshit's launch is not decided, tidied, or reported to this one (BL-18). The decision still
// keeps anything another Batshit launched, for a process whose records are mixed.
async function readVoiceStopInventory(applyChoices, owner) {
  const { groups: pidGroups, unusable, unreadable } = groupLocalRuntimeLaunchRecords(
    await readLocalRuntimeLaunchRecords(HOST_VOICE_STATE_DIR)
  )
  const allGroups = process.platform === 'win32'
    ? pidGroups.flatMap(({ pid, records }) => {
        const byBirth = new Map()
        for (const record of records) {
          const root = validWindowsMembers(record.windowsMembers).find((member) => member.pid === pid)
          const key = root ? `birth:${root.startedAtMs}` : `launch:${record.launchedAt ?? record.engineId}`
          if (!byBirth.has(key)) byBirth.set(key, [])
          byBirth.get(key).push(record)
        }
        return [...byBirth.values()].map((grouped) => ({ pid, records: grouped }))
      })
    : pidGroups
  const groups = applyChoices
    ? allGroups.filter((group) => group.records.some((record) => voiceRecordIsCallers(record, owner)))
    : allGroups
  return { groups, unusable, unreadable }
}

// Stop what this operator started, as each engine's "Stop with Batshit" choice says (absent
// means stop). Never anything without a record here: the operator did not start it. The app sends
// its current choices first, and only what that Docker Batshit launched is stopped (`owner`, its
// name, or none for an app that does not say, which owns only unmarked records); with no choices
// (`applyChoices: false`, the operator stopping with Docker Batshit, when no client is left), each
// record's saved choice decides, whichever Batshit launched it.
async function stopRecordedVoiceRuntimes(choices, { applyChoices = true, owner = null } = {}) {
  const decisionOwner = applyChoices ? (owner ?? UNNAMED_APP_OWNER) : null
  // While one record is unreadable, it may be an engine's "keep running" for a process a readable
  // record says to stop: this stop sends no signal and changes or removes no record, the app's choices
  // included (they come again with its next stop; the operator's own stop, with no Docker Batshit left,
  // decides with the choices saved before). Decided before anything changes (BL-1269, the shared hold),
  // and again after the choices are applied, for a record that became unreadable meanwhile: that rare
  // pass stops nothing, but the choices it applied stand.
  let inventory = await readVoiceStopInventory(applyChoices, owner)
  let hold = holdLocalRuntimeStopsForUnreadableRecords(inventory.unreadable)
  if (!hold && applyChoices) {
    await applyVoiceStopChoices(choices, owner)
    inventory = await readVoiceStopInventory(applyChoices, owner)
    hold = holdLocalRuntimeStopsForUnreadableRecords(inventory.unreadable)
  }
  const { groups, unusable, unreadable } = inventory
  // A record that could not be read may name a process that still runs: it is kept and reported as
  // not stopped, never removed (BL-1264). Whose launch it was cannot be read either.
  const unreadableOutcomes = unreadable.map((record) => ({
    kind: 'notStopped', pid: 0, engineIds: record.engineId ? [record.engineId] : [], reason: `${record.reason}; it was kept`
  }))
  const pick = (outcomes, kind) => outcomes.filter((outcome) => outcome.kind === kind).map(({ kind: _kind, ...rest }) => rest)
  if (hold) {
    const held = groups.map((group) => ({
      kind: 'notStopped', pid: group.pid, engineIds: group.records.map((record) => record.engineId), reason: hold.reason
    }))
    const outcomes = [...held, ...unreadableOutcomes]
    return { stopped: [], keptRunning: [], notStopped: pick(outcomes, 'notStopped') }
  }
  await Promise.all(
    unusable.map((record) =>
      removeLocalRuntimeLaunchRecord(record).catch((error) =>
        console.warn(`Could not remove the launch record of "${record.engineId}": ${error?.message ?? error}`)
      )
    )
  )
  // Concurrently, so the whole stop stays inside one SIGTERM grace window.
  const roots = await voiceMatchRoots()
  // A read started for another engine before this member's last kill is stale.
  const readWindowsProcesses = () => readWindowsLocalRuntimeProcesses()
  const windowsProcesses = process.platform === 'win32' ? await readWindowsProcesses() : undefined
  // One process's trouble never stops the rest: it is reported as not stopped.
  const outcomes = (
    await Promise.all(
      groups.map((group) =>
        stopRecordedVoiceRuntime(group, roots, decisionOwner, windowsProcesses, readWindowsProcesses).catch((error) => ({
          kind: 'notStopped',
          pid: group.pid,
          engineIds: group.records.map((record) => record.engineId),
          reason: `it could not be handled: ${error instanceof Error ? error.message : String(error)}`
        }))
      )
    )
  ).filter(Boolean)
  outcomes.push(...unreadableOutcomes)
  return { stopped: pick(outcomes, 'stopped'), keptRunning: pick(outcomes, 'keptRunning'), notStopped: pick(outcomes, 'notStopped') }
}

async function handleVoiceEngineStop(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  let choices
  let owner
  try {
    const body = await readBody(req)
    choices = normalizeVoiceStopChoices(body.engines)
    owner = normalizeVoiceOwner(body.owner)
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Invalid request body.' })
    return
  }

  try {
    const result = await stopRecordedVoiceRuntimes(choices, { owner })
    for (const outcome of result.notStopped) {
      console.warn(`Did not stop host voice engine ${outcome.engineIds.join(', ')} (pid ${outcome.pid}): ${outcome.reason}.`)
    }
    json(res, 200, { ok: true, success: true, ...result })
  } catch (error) {
    json(res, 500, {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop host voice engines.'
    })
  }
}

async function handleVoiceReferenceAudioWrite(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }

  try {
    const body = await readBody(req, MAX_HOST_VOICE_REFERENCE_BODY_BYTES)
    const saved = await writeHostVoiceReferenceAudio(body)
    json(res, 200, {
      ok: true,
      success: true,
      ...saved
    })
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      res.setHeader('connection', 'close')
      res.once('finish', () => req.destroy())
    }
    json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 500, {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Failed to write host voice reference audio.'
    })
  }
}

function handleHealth(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  json(res, 200, {
    ok: true,
    service: 'batshit-runtime-addon-operator',
    controls: ['start', 'stop'],
    sandboxControls: ['status', 'recover', 'execute', 'cleanup'],
    // The app offers "Stop with Batshit" only when this operator lists the control.
    hostVoiceControls: [
      ...(HOST_VOICE_START_SUPPORTED ? ['start'] : []),
      ...(HOST_VOICE_STOP_SUPPORTED ? ['stop'] : []),
      'write-reference-audio'
    ],
    // Raised when the operator's protocol changes, so `start-docker` restarts an older
    // operator that is still running. 2 = sbx only, per-name lifecycle gate, idle sandboxes
    // reused. 3 = the Windows path rules. 4 = a Stop or timeout ends the command and what it
    // started inside the sandbox. 5 = the host voice engines it starts are recorded and can be
    // stopped (`POST /v1/voice-engines/stop`). 6 = it stops with Docker Batshit instead of
    // running from login forever, and stops the sbx daemon its own call started. 7 = a voice
    // launch record names the Docker Batshit that asked (`owner`), and an app's stop touches only
    // its own launches, so two Docker Batshits sharing this operator never stop each other's.
    // 8 = a separate signing key binds a fresh saved voice recipe before host launch, and
    // reference uploads accept audio only and cannot be used as launch roots.
    // 9 = Windows host voice stop with process identity checks.
    // 12 = the Pinokio admission folder joins the shared protected-home policy, with sandbox
    // mount version 4 (BL-1277): an operator started with the older list must not keep serving.
    sandboxRevision: SANDBOX_REVISION,
    // How it stops with Docker Batshit (revision 6): `start-docker` restarts an operator whose
    // login item is not the current one, so an older item (KeepAlive true) never lingers.
    watch: {
      enabled: WATCH_ENABLED,
      launchAgent: LAUNCH_AGENT_PATH || null,
      startedByOldLoginItem: STARTED_BY_OLD_LOGIN_ITEM
    },
    cwd: ROOT,
    envFile: ENV_FILE,
    sandboxWorkspace: {
      containerRoot: SANDBOX_CONTAINER_WORKSPACE_ROOT,
      hostRoot: SANDBOX_HOST_WORKSPACE_ROOT_RAW || null
    },
    hostVoice: {
      allowedRoots: parseAllowedVoiceRoots(),
      stateDir: HOST_VOICE_STATE_DIR
    },
    addons: Object.fromEntries(
      Object.entries(ADDONS).map(([id, addon]) => [
        id,
        {
          title: addon.title,
          profile: addon.profile
        }
      ])
    )
  })
}

if (TOKENS.length === 0) {
  console.error('BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN or BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN is required.')
  process.exit(1)
}

// ---- The operator stops with Docker Batshit (2026-09-21, BL-59) ----------------------------
//
// It used to run from login forever (`start-docker` installs a LaunchAgent, which had RunAtLoad and
// KeepAlive), whether or not Docker Batshit ran, so quitting Batshit could never stop it. Now it
// asks Docker every minute whether any Docker Batshit that uses it is up: a running, paused, or
// restarting `app` container whose environment holds this operator's token (any Compose project,
// any checkout: the token is what makes a container this operator's client).
// - Docker answered "none" for ten minutes, three checks in a row at least (or Docker is not
//   installed): Docker Batshit was stopped on purpose. The operator stops what it started (voice
//   engines as each one's saved choice says, and the sbx daemon its own call started), removes its
//   login item (`BATSHIT_RUNTIME_ADDON_OPERATOR_LAUNCH_AGENT`; `./start-docker.sh` installs it
//   again), and exits cleanly, which launchd does not restart (KeepAlive only after a crash).
// - Docker did not answer (quit, or still starting after a login): it waits, because Docker brings
//   Docker Batshit back when it starts. Only after an hour does it stop what it started and exit,
//   keeping its login item, so the next login is covered.
// A login item written before revision 6 keeps KeepAlive true and names no file to remove: an exit
// would only restart it, so under one the operator keeps running as it always did until
// `./start-docker.sh` writes the new item (`/health` reports it, and `start-docker` restarts it).
// `BATSHIT_RUNTIME_ADDON_OPERATOR_WATCH=0` turns the watch off.
const OPERATOR_LAUNCHD_LABEL = 'ai.batshit.sandbox-operator'
const WATCH_INTERVAL_MS = Number(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_WATCH_MS) || 60_000
const GONE_AFTER_MS = Number(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_GONE_AFTER_MS) || 10 * 60_000
const UNREACHABLE_AFTER_MS = Number(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_UNREACHABLE_AFTER_MS) || 60 * 60_000
const STOPPED_ON_PURPOSE_CHECKS = 3
const LAUNCH_AGENT_PATH = String(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_LAUNCH_AGENT || '').trim()
const STARTED_BY_OLD_LOGIN_ITEM = process.env.XPC_SERVICE_NAME === OPERATOR_LAUNCHD_LABEL && !LAUNCH_AGENT_PATH
const WATCH_ENABLED = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_WATCH !== '0' && !STARTED_BY_OLD_LOGIN_ITEM
const OPERATOR_TOKEN_ENV_NAMES = ['BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN', 'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN']
let stoppingWithDockerBatshit = false

// `running`, `stopped` (Docker answered, or is not installed, and no client of this operator is
// up), or `unreachable` (Docker did not answer).
async function dockerBatshitState() {
  const listed = await runCommand(
    'docker',
    [
      'ps',
      '--filter', 'label=com.docker.compose.service=app',
      '--filter', 'status=running',
      '--filter', 'status=paused',
      '--filter', 'status=restarting',
      '--format', '{{.ID}}'
    ],
    { timeoutMs: 15_000 }
  )
  if (!listed.ok) return /ENOENT/.test(listed.error || '') ? 'stopped' : 'unreachable'
  if (listed.truncated) return 'unreachable'
  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!ids.length) return 'stopped'
  const inspected = await runCommand('docker', ['inspect', '--format', '{{json .Config.Env}}', ...ids], {
    timeoutMs: 15_000
  })
  if (!inspected.ok) return 'unreachable'
  if (inspected.truncated) return 'unreachable'
  const holdsOurToken = inspected.stdout.split('\n').some((line) => {
    let env
    try {
      env = JSON.parse(line)
    } catch {
      return false
    }
    return (
      Array.isArray(env) &&
      env.some((entry) => OPERATOR_TOKEN_ENV_NAMES.some((name) => TOKENS.some((token) => entry === `${name}=${token}`)))
    )
  })
  return holdsOurToken ? 'running' : 'stopped'
}

async function stopBecauseDockerBatshitIsGone({ stoppedOnPurpose }) {
  // No new work from here on: a request that arrives now would be cut off by the exit.
  stoppingWithDockerBatshit = true
  server.close()
  console.log(
    stoppedOnPurpose
      ? 'Docker Batshit has stopped; stopping what this operator started.'
      : 'Docker has not answered for a long time; stopping what this operator started.'
  )
  if (HOST_VOICE_STOP_SUPPORTED) {
    try {
      const voice = await stopRecordedVoiceRuntimes([], { applyChoices: false })
      for (const entry of voice.stopped) console.log(`Stopped voice engine ${entry.engineIds.join(', ')} (pid ${entry.pid}).`)
      for (const entry of voice.keptRunning) console.log(`Left voice engine ${entry.engineIds.join(', ')} running: ${entry.reason}.`)
      for (const entry of voice.notStopped) console.log(`Could not stop voice engine ${entry.engineIds.join(', ')}: ${entry.reason}.`)
    } catch (error) {
      console.warn(`Voice engines could not be checked: ${error?.message ?? error}`)
    }
  }
  try {
    const sbx = await stopSbxDaemonIfBatshitStartedIt({
      stateDir: HOST_SBX_DAEMON_STATE_DIR,
      owner: OPERATOR_OWNER,
      ownerIsGone: () => false
    })
    if (sbx.action === 'stopped') console.log(`Stopped Docker's sbx daemon (pid ${sbx.pid}), which this operator started.`)
    else if (sbx.action === 'keep' || sbx.action === 'unverified') console.log(`Left Docker's sbx daemon running: ${sbx.reason}.`)
  } catch (error) {
    console.warn(`Docker's sbx daemon could not be checked: ${error?.message ?? error}`)
  }
  if (stoppedOnPurpose && LAUNCH_AGENT_PATH) {
    await rm(LAUNCH_AGENT_PATH, { force: true })
      .then(() => console.log(`Removed the login item ${LAUNCH_AGENT_PATH}; ./start-docker.sh installs it again.`))
      .catch((error) => console.warn(`Could not remove the login item ${LAUNCH_AGENT_PATH}: ${error?.message ?? error}`))
  }
  process.exit(0)
}

function watchDockerBatshit() {
  let lastSeenAt = Date.now()
  let stoppedChecks = 0
  let checking = false
  const timer = setInterval(async () => {
    if (checking) return
    checking = true
    try {
      const state = await dockerBatshitState()
      if (state === 'running') {
        lastSeenAt = Date.now()
        stoppedChecks = 0
        return
      }
      stoppedChecks = state === 'stopped' ? stoppedChecks + 1 : 0
      const goneForMs = Date.now() - lastSeenAt
      const stoppedOnPurpose = stoppedChecks >= STOPPED_ON_PURPOSE_CHECKS && goneForMs >= GONE_AFTER_MS
      const dockerGaveUp = state === 'unreachable' && goneForMs >= UNREACHABLE_AFTER_MS
      if (!stoppedOnPurpose && !dockerGaveUp) return
      clearInterval(timer)
      await stopBecauseDockerBatshitIsGone({ stoppedOnPurpose })
    } finally {
      checking = false
    }
  }, WATCH_INTERVAL_MS)
}

const server = http.createServer(async (req, res) => {
  if (stoppingWithDockerBatshit) {
    json(res, 503, { ok: false, error: 'The operator is stopping because Docker Batshit stopped. Run ./start-docker.sh.' })
    return
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
  if (req.method === 'GET' && url.pathname === '/health') {
    handleHealth(req, res)
    return
  }

  if (req.method === 'GET' && url.pathname === '/v1/sandbox/status') {
    await handleSandboxStatus(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/sandbox/recover') {
    await handleSandboxRecover(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/sandbox/execute') {
    await handleSandboxExecute(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/sandbox/cleanup') {
    await handleSandboxCleanup(req, res)
    return
  }

  const match = url.pathname.match(/^\/v1\/addons\/([^/]+)\/(start|stop)$/)
  if (req.method === 'POST' && match) {
    await handleAddonAction(req, res, match[1], match[2])
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/voice-engines/start') {
    await handleVoiceEngineStart(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/voice-engines/stop') {
    await handleVoiceEngineStop(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/voice-profiles/reference-audio') {
    await handleVoiceReferenceAudioWrite(req, res)
    return
  }

  json(res, 404, { ok: false, error: 'Not found.' })
})

server.listen(PORT, HOST, () => {
  console.log(`Batshit runtime add-on operator listening on http://${HOST}:${PORT}`)
  if (STARTED_BY_OLD_LOGIN_ITEM) {
    console.log('Started by an older login item: running until ./start-docker.sh installs the one that stops with Docker Batshit.')
  }
  if (WATCH_ENABLED) watchDockerBatshit()
})
