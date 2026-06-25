#!/usr/bin/env node
import http from 'node:http'
import { spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { realpath, stat, writeFile } from 'node:fs/promises'

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
const SANDBOX_NETWORK_POLICY = 'deny'
const SANDBOX_NAME_PREFIX = 'batshit-'
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
    path.join(HOST_BATSHIT_ROOT, 'runtime'),
    path.join(HOST_BATSHIT_ROOT, 'voice-profiles')
  ].join(path.delimiter)
const HOST_VOICE_BLOCKED_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish'])
const MAX_HOST_VOICE_REFERENCE_AUDIO_BYTES = 100 * 1024 * 1024

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

function appendOutput(current, chunk) {
  const next = current + String(chunk)
  return next.length > MAX_OUTPUT_CHARS ? next.slice(0, MAX_OUTPUT_CHARS) : next
}

function isAuthorized(req) {
  const auth = req.headers.authorization || ''
  const headerToken = req.headers['x-batshit-runtime-addon-operator-token']
  return TOKENS.some((token) => auth === `Bearer ${token}` || headerToken === token)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
      if (body.length > 16_384) {
        reject(new Error('Request body too large.'))
        req.destroy()
      }
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
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, Math.max(1_000, RUN_TIMEOUT_MS))

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({
        ok: false,
        error: error.message,
        stdout,
        stderr,
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
            : stderr.trim() || `Docker Compose exited with ${exitCode}.`,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    })
  })
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, Math.max(1_000, options.timeoutMs || RUN_TIMEOUT_MS))

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({
        command: [command, ...args].join(' '),
        ok: false,
        error: error.message,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated: stdout.length >= MAX_OUTPUT_CHARS || stderr.length >= MAX_OUTPUT_CHARS
      })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout)
      resolve({
        command: [command, ...args].join(' '),
        ok: exitCode === 0 && !timedOut,
        error: timedOut
          ? 'Command timed out.'
          : exitCode === 0
            ? null
            : stderr.trim() || `Command exited with ${exitCode}.`,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated: stdout.length >= MAX_OUTPUT_CHARS || stderr.length >= MAX_OUTPUT_CHARS
      })
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
  if (!isPathWithinAnyRoot(parentReal, roots)) {
    throw new Error('launch.logPath must stay inside Batshit voice runtime roots.')
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
  if (/^\.[a-z0-9]{1,10}$/.test(fromFilename)) {
    return fromFilename
  }

  const normalizedType = String(contentType || '').trim().toLowerCase()
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

  return byContentType[normalizedType] || '.wav'
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
  const allowedRoots = []
  for (const root of parseAllowedVoiceRoots()) {
    const resolved = await realpath(root).catch(() => null)
    if (resolved) allowedRoots.push(resolved)
  }
  if (!isPathWithinAnyRoot(rootReal, allowedRoots)) {
    throw new Error('Host voice profile storage root must stay inside Batshit voice runtime roots.')
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
  await writeFile(audioPath, audio)

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
  if (
    ['python', 'python3', 'node'].includes(commandBasename) &&
    args.some((arg) => arg === '-c' || arg === '--eval' || arg === '-e')
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
    entries[key] = String(rawValue)
  }
  return entries
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
  if (HOST_VOICE_BLOCKED_COMMANDS.has(commandBasename)) {
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
    const child = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: {
        ...process.env,
        ...prepared.env
      },
      detached: true,
      stdio: ['ignore', fd, fd]
    })
    child.unref()
    return child.pid ?? null
  } finally {
    closeSync(fd)
  }
}

function normalizeSandboxCliKind(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'sbx') return 'sbx'
  if (value === 'docker-sandbox' || value === 'docker_sandbox' || value === 'docker sandbox') {
    return 'docker-sandbox'
  }
  return null
}

function orderedSandboxCliCandidates() {
  const candidates = [
    { kind: 'sbx', command: 'sbx', versionArgs: ['version'] },
    { kind: 'docker-sandbox', command: 'docker', versionArgs: ['sandbox', 'version'] }
  ]
  const preferred = normalizeSandboxCliKind(process.env.BATSHIT_DOCKER_SANDBOX_CLI)
  if (!preferred) return candidates
  return [
    ...candidates.filter((candidate) => candidate.kind === preferred),
    ...candidates.filter((candidate) => candidate.kind !== preferred)
  ]
}

function buildSandboxCommand(kind, input) {
  if (kind === 'sbx') {
    if (input.action === 'version') return { command: 'sbx', args: ['version'] }
    if (input.action === 'ls') return { command: 'sbx', args: ['ls'] }
    if (input.action === 'create') {
      return { command: 'sbx', args: ['create', '--name', input.sandboxName, 'codex', input.workspaceRoot] }
    }
    if (input.action === 'rm') {
      return { command: 'sbx', args: ['rm', '--force', ...input.sandboxNames] }
    }
    if (input.action === 'stop') return { command: 'sbx', args: ['stop', ...input.sandboxNames] }
    if (input.action === 'policy-deny-network') {
      return { command: 'sbx', args: ['policy', 'deny', 'network', input.sandboxName, '**'] }
    }
    if (input.action === 'exec') {
      return {
        command: 'sbx',
        args: [
          'exec',
          '--workdir',
          input.cwd,
          ...input.envArgs,
          input.sandboxName,
          '/bin/bash',
          '-lc',
          input.commandText
        ]
      }
    }
  }

  if (input.action === 'version') return { command: 'docker', args: ['sandbox', 'version'] }
  if (input.action === 'ls') return { command: 'docker', args: ['sandbox', 'ls'] }
  if (input.action === 'create') {
    return {
      command: 'docker',
      args: ['sandbox', 'create', '--name', input.sandboxName, 'codex', input.workspaceRoot]
    }
  }
  if (input.action === 'rm') return { command: 'docker', args: ['sandbox', 'rm', ...input.sandboxNames] }
  if (input.action === 'stop') return { command: 'docker', args: ['sandbox', 'stop', ...input.sandboxNames] }
  if (input.action === 'policy-deny-network') {
    return {
      command: 'docker',
      args: ['sandbox', 'network', 'proxy', input.sandboxName, '--policy', SANDBOX_NETWORK_POLICY]
    }
  }
  if (input.action === 'exec') {
    return {
      command: 'docker',
      args: [
        'sandbox',
        'exec',
        '--workdir',
        input.cwd,
        ...input.envArgs,
        input.sandboxName,
        '/bin/bash',
        '-lc',
        input.commandText
      ]
    }
  }
  throw new Error(`Unsupported Docker Sandbox action: ${input.action}`)
}

async function resolveSandboxCli() {
  const errors = []
  for (const candidate of orderedSandboxCliCandidates()) {
    const run = await runCommand(candidate.command, candidate.versionArgs, { timeoutMs: 5_000 })
    const message = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n')
    if (run.ok) return { ok: true, cli: candidate, version: message || null }
    errors.push(`${candidate.kind}: ${message || run.error || 'version command failed.'}`)
  }
  return {
    ok: false,
    reason: errors.join(' | ') || 'Docker Sandbox CLI is unavailable.'
  }
}

function parseSandboxList(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length <= 1) return []

  const header = lines[0].split(/\s{2,}/).map((part) => part.trim().toLowerCase())
  const nameIndex = header.findIndex((part) => part === 'sandbox' || part === 'name')
  const statusIndex = header.findIndex((part) => part === 'status')
  const workspaceIndex = header.findIndex((part) => part === 'workspace')

  return lines.slice(1).map((line) => {
    const parts = line.split(/\s{2,}/).filter(Boolean)
    return {
      name: parts[nameIndex >= 0 ? nameIndex : 0] || '',
      status: String(parts[statusIndex >= 0 ? statusIndex : 2] || '').toLowerCase(),
      workspace: parts[workspaceIndex >= 0 ? workspaceIndex : parts.length - 1] || ''
    }
  })
}

function isManagedSandboxName(name) {
  return Boolean(name && name.startsWith(SANDBOX_NAME_PREFIX))
}

function sessionHash(sessionId) {
  return createHash('sha1').update(String(sessionId || '')).digest('hex').slice(0, 8)
}

function sandboxSessionMarker(sessionId) {
  return `-s${sessionHash(sessionId)}-`
}

function buildSandboxName({ userId, workspaceRoot, sessionId }) {
  const userPrefix = String(userId || 'user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 20)
  const workspaceHash = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 10)
  const sessionSegment = sessionId ? `s${sessionHash(sessionId)}-` : ''
  return `${SANDBOX_NAME_PREFIX}${userPrefix || 'user'}-${sessionSegment}${workspaceHash}`
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

async function listSandboxes(cli) {
  const commandSpec = buildSandboxCommand(cli.kind, { action: 'ls' })
  const run = await runCommand(commandSpec.command, commandSpec.args, { timeoutMs: 15_000 })
  if (!run.ok) throw new Error(run.stderr.trim() || run.error || 'Failed to list Docker sandboxes.')
  return parseSandboxList(run.stdout)
}

async function removeSandbox(cli, name) {
  if (!isManagedSandboxName(name)) return null
  const commandSpec = buildSandboxCommand(cli.kind, { action: 'rm', sandboxNames: [name] })
  const run = await runCommand(commandSpec.command, commandSpec.args, { timeoutMs: 30_000 })
  if (run.ok) return null
  return run.stderr.trim() || run.stdout.trim() || run.error || 'Failed to remove Docker sandbox.'
}

async function pruneStoppedSandboxes(cli, keepNames = []) {
  const warnings = []
  let entries = []
  try {
    entries = await listSandboxes(cli)
  } catch (error) {
    return [error instanceof Error ? error.message : 'Failed to list Docker sandboxes.']
  }
  const keep = new Set(keepNames)
  for (const entry of entries) {
    if (keep.has(entry.name)) continue
    if (!isManagedSandboxName(entry.name)) continue
    if (entry.status === 'running') continue
    const warning = await removeSandbox(cli, entry.name)
    if (warning) warnings.push(`${entry.name}: ${warning}`)
  }
  return warnings
}

async function ensureSandboxReady({ userId, sessionId, workspaceRoot, cwd }) {
  const resolvedCli = await resolveSandboxCli()
  if (!resolvedCli.ok) {
    throw new Error(resolvedCli.reason)
  }
  const cli = resolvedCli.cli
  const mapping = await resolveWorkspaceMapping({ workspaceRoot, cwd })
  const sandboxName = buildSandboxName({
    userId,
    workspaceRoot: mapping.hostWorkspaceRoot,
    sessionId
  })
  const entries = await listSandboxes(cli)
  const existing = entries.find((entry) => entry.name === sandboxName)
  const hasWorkspaceMismatch =
    existing?.workspace && existing.workspace !== '-' && existing.workspace !== mapping.hostWorkspaceRoot
  if (existing && (existing.status !== 'running' || hasWorkspaceMismatch)) {
    const warning = await removeSandbox(cli, sandboxName)
    if (warning) throw new Error(warning)
  }

  if (!existing || existing.status !== 'running' || hasWorkspaceMismatch) {
    const createSpec = buildSandboxCommand(cli.kind, {
      action: 'create',
      sandboxName,
      workspaceRoot: mapping.hostWorkspaceRoot
    })
    const createRun = await runCommand(createSpec.command, createSpec.args, { timeoutMs: 90_000 })
    if (!createRun.ok) {
      throw new Error(createRun.stderr.trim() || createRun.error || 'Failed to create Docker sandbox.')
    }
  }

  const policySpec = buildSandboxCommand(cli.kind, {
    action: 'policy-deny-network',
    sandboxName
  })
  const policyRun = await runCommand(policySpec.command, policySpec.args, { timeoutMs: 15_000 })
  if (!policyRun.ok) {
    throw new Error(policyRun.stderr.trim() || policyRun.error || 'Failed to apply Docker sandbox network policy.')
  }

  return {
    sandboxName,
    cli,
    version: resolvedCli.version,
    mapping
  }
}

async function handleSandboxStatus(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  const resolvedCli = await resolveSandboxCli()
  const workspace = {
    containerRoot: SANDBOX_CONTAINER_WORKSPACE_ROOT,
    hostRoot: SANDBOX_HOST_WORKSPACE_ROOT_RAW || null
  }
  if (!SANDBOX_HOST_WORKSPACE_ROOT_RAW.trim()) {
    json(res, 200, {
      ok: true,
      available: false,
      supported: true,
      reason:
        'Docker Sandbox operator requires BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT or BATSHIT_WORKSPACE_MOUNT so /workspace can map to a real host directory.',
      policy: SANDBOX_NETWORK_POLICY,
      cli: null,
      version: null,
      driver: 'operator',
      capabilities: ['status', 'recover', 'execute', 'cleanup'],
      workspace
    })
    return
  }
  if (!resolvedCli.ok) {
    json(res, 200, {
      ok: true,
      available: false,
      supported: true,
      reason: resolvedCli.reason,
      policy: SANDBOX_NETWORK_POLICY,
      cli: null,
      version: null,
      driver: 'operator',
      capabilities: ['status', 'recover', 'execute', 'cleanup'],
      workspace
    })
    return
  }
  json(res, 200, {
    ok: true,
    available: true,
    supported: true,
    reason: null,
    policy: SANDBOX_NETWORK_POLICY,
    cli: resolvedCli.cli.kind,
    version: resolvedCli.version,
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
    const ensured = await ensureSandboxReady({
      userId: body.userId,
      workspaceRoot: body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT,
      cwd: body.cwd || body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT
    })
    json(res, 200, {
      ok: true,
      success: true,
      recovered: true,
      sandboxName: ensured.sandboxName,
      workspaceRoot: body.workspaceRoot || SANDBOX_CONTAINER_WORKSPACE_ROOT,
      mappedWorkspaceRoot: ensured.mapping.hostWorkspaceRoot,
      mappedCwd: ensured.mapping.hostCwd,
      cli: ensured.cli.kind,
      version: ensured.version,
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

async function handleSandboxExecute(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }
  let body
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
        `Docker Sandbox operator maps ${mapping.containerRoot} to ${mapping.hostRoot}; use relative paths or the mapped host path in sandbox commands.`
      )
    }
    const ensured = await ensureSandboxReady({
      userId: body.userId,
      sessionId: body.sessionId,
      workspaceRoot,
      cwd
    })
    const envArgs = []
    const envInput = body.env && typeof body.env === 'object' ? body.env : {}
    for (const [key, value] of Object.entries(envInput)) {
      if (!key || typeof value !== 'string') continue
      envArgs.push('--env', `${key}=${value}`)
    }
    const execSpec = buildSandboxCommand(ensured.cli.kind, {
      action: 'exec',
      sandboxName: ensured.sandboxName,
      cwd: ensured.mapping.hostCwd,
      envArgs,
      commandText
    })
    const run = await runCommand(execSpec.command, execSpec.args, {
      timeoutMs: Number(body.timeoutMs || RUN_TIMEOUT_MS)
    })
    const warnings = []
    if (!body.sessionId) {
      const warning = await removeSandbox(ensured.cli, ensured.sandboxName)
      if (warning) warnings.push(`${ensured.sandboxName}: ${warning}`)
      warnings.push(...(await pruneStoppedSandboxes(ensured.cli)))
    }
    json(res, 200, {
      ok: true,
      sandboxName: ensured.sandboxName,
      mappedWorkspaceRoot: ensured.mapping.hostWorkspaceRoot,
      mappedCwd: ensured.mapping.hostCwd,
      cli: ensured.cli.kind,
      warnings,
      run
    })
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Docker Sandbox execution failed.'
    })
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
    const resolvedCli = await resolveSandboxCli()
    if (!resolvedCli.ok) throw new Error(resolvedCli.reason)
    const warnings = []
    if (sessionId) {
      const entries = await listSandboxes(resolvedCli.cli)
      for (const entry of entries) {
        if (isManagedSandboxName(entry.name) && entry.name.includes(sandboxSessionMarker(sessionId))) {
          const warning = await removeSandbox(resolvedCli.cli, entry.name)
          if (warning) warnings.push(`${entry.name}: ${warning}`)
        }
      }
    }
    warnings.push(...(await pruneStoppedSandboxes(resolvedCli.cli)))
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
    const body = await readBody(req)
    const prepared = await prepareHostVoiceLaunch(body)
    const pid = spawnHostVoiceRuntime(prepared)
    json(res, 200, {
      ok: true,
      success: true,
      engineId: prepared.engineId,
      pid,
      command: prepared.command,
      args: prepared.args,
      cwd: prepared.cwd,
      installRoot: prepared.installRoot,
      logPath: prepared.logPath
    })
  } catch (error) {
    json(res, 500, {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start host voice runtime.'
    })
  }
}

async function handleVoiceReferenceAudioWrite(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }

  try {
    const body = await readBody(req)
    const saved = await writeHostVoiceReferenceAudio(body)
    json(res, 200, {
      ok: true,
      success: true,
      ...saved
    })
  } catch (error) {
    json(res, 500, {
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
    hostVoiceControls: ['start', 'write-reference-audio'],
    cwd: ROOT,
    envFile: ENV_FILE,
    sandboxWorkspace: {
      containerRoot: SANDBOX_CONTAINER_WORKSPACE_ROOT,
      hostRoot: SANDBOX_HOST_WORKSPACE_ROOT_RAW || null
    },
    hostVoice: {
      allowedRoots: parseAllowedVoiceRoots()
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

const server = http.createServer(async (req, res) => {
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

  if (req.method === 'POST' && url.pathname === '/v1/voice-profiles/reference-audio') {
    await handleVoiceReferenceAudioWrite(req, res)
    return
  }

  json(res, 404, { ok: false, error: 'Not found.' })
})

server.listen(PORT, HOST, () => {
  console.log(`Batshit runtime add-on operator listening on http://${HOST}:${PORT}`)
})
