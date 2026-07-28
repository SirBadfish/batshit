#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let envFilePath = path.resolve(ROOT, process.env.BATSHIT_DOCKER_ENV_FILE || '.env.docker')
const ENV_EXAMPLE = path.join(ROOT, '.env.docker.example')
const OPERATOR_SCRIPT = path.join(ROOT, 'tools', 'docker', 'runtime-addon-operator.mjs')
const LOG_FILE = path.join(ROOT, '_local', 'logs', 'docker-sandbox-operator-current.log')
const PID_FILE = path.join(ROOT, '_local', 'docker', 'sandbox-operator.pid')
const DOCKER_MCP_GATEWAY_LOG_FILE = path.join(ROOT, '_local', 'logs', 'docker-mcp-gateway-docker-current.log')
const DOCKER_MCP_GATEWAY_PID_FILE = path.join(ROOT, '_local', 'docker', 'mcp-gateway.pid')
const LAUNCHD_LABEL = 'ai.batshit.sandbox-operator'

const DEFAULT_OPERATOR_PORT = 5629
const DEFAULT_CONTAINER_OPERATOR_URL = `http://host.docker.internal:${DEFAULT_OPERATOR_PORT}`
const DOCKER_MCP_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function usage() {
  console.log(`Usage: ./start-docker.sh [options]

Starts Batshit Docker and prepares the built-in Docker host helper.

Options:
  --profile <name>          Enable a Docker Compose profile, for example n8n.
  --env-file <path>         Use and prepare a separate Docker env file.
  --project-name <name>     Use a separate Docker Compose project/volume namespace.
  --no-build                Start without rebuilding images.
  --no-sandbox-operator     Do not start the host Docker Sandbox/add-on operator.
  --no-docker-mcp-gateway   Do not start the optional host Docker MCP Gateway.
  --help                    Show this help.
`)
}

function parseArgs(argv) {
  const profiles = []
  let build = true
  let startSandboxOperator = true
  let startDockerMcpGateway = true
  let envFile = process.env.BATSHIT_DOCKER_ENV_FILE || '.env.docker'
  let projectName = process.env.COMPOSE_PROJECT_NAME || ''

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (arg === '--profile') {
      const profile = argv[i + 1]
      if (!profile || profile.startsWith('-')) {
        throw new Error('--profile requires a profile name.')
      }
      profiles.push(profile)
      i += 1
      continue
    }
    if (arg.startsWith('--profile=')) {
      const profile = arg.slice('--profile='.length).trim()
      if (!profile) throw new Error('--profile requires a profile name.')
      profiles.push(profile)
      continue
    }
    if (arg === '--no-build') {
      build = false
      continue
    }
    if (arg === '--env-file') {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) throw new Error('--env-file requires a path.')
      envFile = value
      i += 1
      continue
    }
    if (arg.startsWith('--env-file=')) {
      envFile = arg.slice('--env-file='.length).trim()
      if (!envFile) throw new Error('--env-file requires a path.')
      continue
    }
    if (arg === '--project-name') {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) throw new Error('--project-name requires a name.')
      projectName = value
      i += 1
      continue
    }
    if (arg.startsWith('--project-name=')) {
      projectName = arg.slice('--project-name='.length).trim()
      if (!projectName) throw new Error('--project-name requires a name.')
      continue
    }
    if (arg === '--no-sandbox-operator') {
      startSandboxOperator = false
      continue
    }
    if (arg === '--no-docker-mcp-gateway') {
      startDockerMcpGateway = false
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  return { profiles, build, startSandboxOperator, startDockerMcpGateway, envFile, projectName }
}

function parseEnv(text) {
  const env = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    env.set(match[1], parseEnvValue(match[2]))
  }
  return env
}

function parseEnvValue(rawValue) {
  let value = String(rawValue ?? '').trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return value
}

function formatEnvValue(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isBlankOrPlaceholder(value) {
  return !value || value.startsWith('replace-with-')
}

function dockerMcpGatewayConfigured(env) {
  return Boolean(
    env.get('DOCKER_MCP_GATEWAY_PORT') ||
      env.get('DOCKER_MCP_GATEWAY_URL') ||
      env.get('DOCKER_MCP_URL') ||
      env.get('MCP_GATEWAY_URL')
  )
}

function setEnvValue(text, key, value, shouldReplace = () => true) {
  const lines = text.split(/\r?\n/)
  let found = false
  let changed = false

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || match[1] !== key) return line
    found = true
    const currentValue = parseEnvValue(match[2])
    if (!shouldReplace(currentValue)) return line
    const nextLine = `${key}=${formatEnvValue(value)}`
    if (line !== nextLine) changed = true
    return nextLine
  })

  if (!found) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push('')
    }
    nextLines.push(`${key}=${formatEnvValue(value)}`)
    changed = true
  }

  return { text: nextLines.join('\n'), changed }
}

function updateEnvValue(state, key, value, shouldReplace, note) {
  const result = setEnvValue(state.text, key, value, shouldReplace)
  state.text = result.text
  if (result.changed && note) state.notes.push(note)
}

function resolveWorkspaceMount(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) return ROOT
  if (value.startsWith('~')) {
    return path.resolve(os.homedir(), value.slice(1))
  }
  return path.resolve(ROOT, value)
}

function hasComposeProfile(profiles, name) {
  return profiles.some((profile) => profile.trim().toLowerCase() === name)
}

function isDefaultHostN8nApiUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '')
  return (
    !normalized ||
    normalized === 'http://localhost:5678' ||
    normalized === 'http://127.0.0.1:5678' ||
    normalized === 'http://host.docker.internal:5678'
  )
}

function prepareEnvFile(profiles = []) {
  mkdirSync(path.dirname(envFilePath), { recursive: true })
  if (!existsSync(envFilePath)) {
    copyFileSync(ENV_EXAMPLE, envFilePath)
  }

  const original = readFileSync(envFilePath, 'utf8')
  const state = { text: original, notes: [] }
  const envBefore = parseEnv(original)
  const hasDockerMcpGatewayConfig = dockerMcpGatewayConfigured(envBefore)
  const existingRuntimeOperatorToken = envBefore.get('BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN')
  const existingSandboxOperatorToken = envBefore.get('BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN')
  const sharedOperatorToken = !isBlankOrPlaceholder(existingSandboxOperatorToken)
    ? existingSandboxOperatorToken
    : !isBlankOrPlaceholder(existingRuntimeOperatorToken)
      ? existingRuntimeOperatorToken
      : randomBytes(32).toString('hex')

  updateEnvValue(
    state,
    'BATSHIT_TOKEN',
    randomBytes(32).toString('hex'),
    isBlankOrPlaceholder,
    'Generated BATSHIT_TOKEN in .env.docker.'
  )
  updateEnvValue(
    state,
    'ENCRYPTION_KEY',
    randomBytes(32).toString('hex'),
    isBlankOrPlaceholder,
    'Generated ENCRYPTION_KEY in .env.docker.'
  )
  updateEnvValue(
    state,
    'MCP_GATEWAY_AUTH_TOKEN',
    randomBytes(32).toString('hex'),
    (current) => hasDockerMcpGatewayConfig && isBlankOrPlaceholder(current),
    'Generated MCP_GATEWAY_AUTH_TOKEN in .env.docker for the optional Docker MCP Gateway.'
  )

  const workspaceMount = resolveWorkspaceMount(envBefore.get('BATSHIT_WORKSPACE_MOUNT'))
  updateEnvValue(
    state,
    'BATSHIT_WORKSPACE_MOUNT',
    workspaceMount,
    (current) => !current || !path.isAbsolute(current) || path.resolve(ROOT, current) !== workspaceMount,
    'Set BATSHIT_WORKSPACE_MOUNT to this checkout so /workspace has a real host folder.'
  )

  updateEnvValue(
    state,
    'BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER',
    'operator',
    (current) => !current,
    'Set Docker Sandbox driver to the host operator.'
  )
  updateEnvValue(
    state,
    'BATSHIT_RUNTIME_ADDON_OPERATOR_URL',
    DEFAULT_CONTAINER_OPERATOR_URL,
    (current) => !current,
    'Set runtime add-on operator URL for approved Docker sidecar controls.'
  )
  updateEnvValue(
    state,
    'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN',
    sharedOperatorToken,
    isBlankOrPlaceholder,
    'Generated runtime add-on operator token in .env.docker.'
  )
  updateEnvValue(
    state,
    'BATSHIT_AGENT_BROWSER_SIDECAR_URL',
    'http://agent-browser:8091',
    (current) => !current,
    'Set Agent Browser sidecar URL for the Docker app container.'
  )
  // The Agent Browser sidecar is its own service/boundary — it gets its own
  // secret instead of reusing the host-operator token (G-0180). The operator
  // token pair below intentionally shares one value: runtime add-ons and the
  // Docker Sandbox are served by the same host operator process.
  updateEnvValue(
    state,
    'BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN',
    randomBytes(32).toString('hex'),
    isBlankOrPlaceholder,
    'Generated Agent Browser sidecar token in .env.docker.'
  )
  updateEnvValue(
    state,
    'BATSHIT_AGENT_BROWSER_TMP_DIR',
    '/runtime/agent-browser/tmp',
    (current) => !current,
    'Set shared Agent Browser screenshot temp directory.'
  )
  updateEnvValue(
    state,
    'BATSHIT_AUDIO2FACE_BRIDGE_URL',
    'http://audio2face-bridge:8068',
    (current) => !current,
    'Set Audio2Face bridge URL for the Docker app container.'
  )
  updateEnvValue(
    state,
    'BATSHIT_AUDIO2FACE_BRIDGE_TOKEN',
    randomBytes(32).toString('hex'),
    isBlankOrPlaceholder,
    'Generated Audio2Face bridge token in .env.docker.'
  )
  updateEnvValue(
    state,
    'BATSHIT_AUDIO2FACE_NIM_ENDPOINT',
    'host.docker.internal:52000',
    (current) => !current,
    'Set default host Audio2Face-3D NIM gRPC endpoint.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_SERVER_IMAGE',
    'livekit/livekit-server:v1.12.0',
    (current) => !current,
    'Set LiveKit server image for the optional Docker voice runtime add-on.'
  )
  updateEnvValue(
    state,
    'BATSHIT_DOCKER_LIVEKIT_PORT',
    '7880',
    (current) => !current,
    'Set LiveKit browser/API port for the optional Docker voice runtime add-on.'
  )
  updateEnvValue(
    state,
    'BATSHIT_DOCKER_LIVEKIT_RTC_TCP_PORT',
    '7881',
    (current) => !current,
    'Set LiveKit RTC TCP port for the optional Docker voice runtime add-on.'
  )
  updateEnvValue(
    state,
    'BATSHIT_DOCKER_LIVEKIT_RTC_UDP_PORT',
    '7882',
    (current) => !current,
    'Set LiveKit RTC UDP port for the optional Docker voice runtime add-on.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_URL',
    'ws://localhost:7880',
    (current) => !current,
    'Set browser-facing LiveKit URL for Docker voice sessions.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_INTERNAL_URL',
    'ws://host.docker.internal:7880',
    (current) => !current,
    'Set app-container LiveKit URL for server-side agent dispatch.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_AGENT_LIVEKIT_URL',
    'ws://livekit:7880',
    (current) => !current,
    'Set LiveKit agent sidecar URL for the Compose LiveKit service.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_AGENT_HEALTH_URL',
    'http://livekit-agent:7899/worker',
    (current) => !current,
    'Set LiveKit agent health URL for Docker runtime status.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_API_KEY',
    'batshit-local',
    (current) => !current,
    'Set local LiveKit API key for the optional Docker voice runtime add-on.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_API_SECRET',
    randomBytes(32).toString('hex'),
    isBlankOrPlaceholder,
    'Generated LiveKit API secret in .env.docker.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_VOICE_AGENT_NAME',
    'batshit-livekit-agent',
    (current) => !current,
    'Set LiveKit agent dispatch name for Docker voice sessions.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_AGENT_MODE',
    'batshit-bridge',
    (current) => !current,
    'Set LiveKit agent mode for the optional Docker voice runtime add-on.'
  )
  updateEnvValue(
    state,
    'LIVEKIT_AGENT_BATSHIT_BASE_URL',
    'http://app:3000',
    (current) => !current,
    'Set LiveKit agent callback base URL for the Docker app service.'
  )
  updateEnvValue(
    state,
    'BATSHIT_DOCKER_SANDBOX_OPERATOR_URL',
    DEFAULT_CONTAINER_OPERATOR_URL,
    (current) => !current,
    'Set Docker Sandbox operator URL for the app container.'
  )
  updateEnvValue(
    state,
    'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN',
    sharedOperatorToken,
    isBlankOrPlaceholder,
    'Generated Docker Sandbox operator token in .env.docker.'
  )
  updateEnvValue(
    state,
    'BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT',
    '/workspace',
    (current) => !current,
    'Set Docker Sandbox container workspace root.'
  )
  updateEnvValue(
    state,
    'BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT',
    workspaceMount,
    (current) => !current || !path.isAbsolute(current) || path.resolve(ROOT, current) !== workspaceMount,
    'Set Docker Sandbox host workspace root.'
  )

  if (hasComposeProfile(profiles, 'n8n')) {
    updateEnvValue(
      state,
      'N8N_API_URL',
      'http://n8n:5678',
      isDefaultHostN8nApiUrl,
      'Set N8N_API_URL to the optional Docker n8n profile service URL.'
    )
  }

  if (state.text !== original) {
    // The Docker launcher updates its Batshit-owned .env.docker file after validating generated values.
    // codeql[js/file-system-race]
    writeFileSync(envFilePath, state.text.endsWith('\n') ? state.text : `${state.text}\n`)
  }

  const env = parseEnv(readFileSync(envFilePath, 'utf8'))
  const finalWorkspace = resolveWorkspaceMount(env.get('BATSHIT_WORKSPACE_MOUNT'))
  if (!existsSync(finalWorkspace)) {
    throw new Error(
      `BATSHIT_WORKSPACE_MOUNT points to a missing folder: ${finalWorkspace}`
    )
  }

  return { env, notes: state.notes }
}

function operatorHostStatusUrl(env) {
  const rawUrl = env.get('BATSHIT_DOCKER_SANDBOX_OPERATOR_URL') || DEFAULT_CONTAINER_OPERATOR_URL
  const url = new URL(rawUrl)
  if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1'
  url.pathname = '/v1/sandbox/status'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function operatorHostHealthUrl(env) {
  const rawUrl = env.get('BATSHIT_DOCKER_SANDBOX_OPERATOR_URL') || DEFAULT_CONTAINER_OPERATOR_URL
  const url = new URL(rawUrl)
  if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1'
  url.pathname = '/health'
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function fetchOperatorStatus(env) {
  const token = env.get('BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN') || ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    // The URL/token come from .env.docker and target the local Docker Sandbox operator.
    // codeql[js/file-access-to-http]
    const response = await fetch(operatorHostStatusUrl(env), {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'A Docker Sandbox operator is already running with a different token. Stop that operator or keep one .env.docker token for this Batshit instance.'
      )
    }
    if (!response.ok) return null
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') return null
    if (error instanceof Error && error.message.includes('different token')) throw error
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchOperatorHealth(env) {
  const token = env.get('BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN') || ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    // The URL/token come from .env.docker and target the local Docker Sandbox operator.
    // codeql[js/file-access-to-http]
    const response = await fetch(operatorHostHealthUrl(env), {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function operatorSupportsCurrentRuntimeControls(health) {
  return (
    Array.isArray(health?.hostVoiceControls) &&
    health.hostVoiceControls.includes('start') &&
    health.hostVoiceControls.includes('write-reference-audio')
  )
}

function pathForLaunchd() {
  const parts = [
    path.dirname(process.execPath),
    process.env.PATH || '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  return [...new Set(parts.flatMap((part) => part.split(':')).filter(Boolean))].join(':')
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function writeMacLaunchAgentPlist() {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  mkdirSync(launchAgentsDir, { recursive: true })
  mkdirSync(path.dirname(LOG_FILE), { recursive: true })

  const plistPath = path.join(launchAgentsDir, `${LAUNCHD_LABEL}.plist`)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(OPERATOR_SCRIPT)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(os.homedir())}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathForLaunchd())}</string>
    <key>USER</key>
    <string>${xmlEscape(os.userInfo().username)}</string>
    <key>BATSHIT_RUNTIME_ADDON_OPERATOR_ROOT</key>
    <string>${xmlEscape(ROOT)}</string>
    <key>BATSHIT_RUNTIME_ADDON_OPERATOR_ENV_FILE</key>
    <string>${xmlEscape(envFilePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
</dict>
</plist>
`
  writeFileSync(plistPath, plist)
  return plistPath
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  })
  return result
}

function dockerMcpGatewayPort(env) {
  const explicitPort = env.get('DOCKER_MCP_GATEWAY_PORT')
  if (explicitPort) {
    if (!/^\d+$/.test(explicitPort)) {
      throw new Error(`Invalid DOCKER_MCP_GATEWAY_PORT: ${explicitPort}`)
    }
    const port = Number(explicitPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid DOCKER_MCP_GATEWAY_PORT: ${explicitPort}`)
    }
    return port
  }

  const rawUrl =
    env.get('DOCKER_MCP_GATEWAY_URL') ||
    env.get('DOCKER_MCP_URL') ||
    env.get('MCP_GATEWAY_URL')
  if (!rawUrl) return null

  try {
    const parsed = new URL(rawUrl)
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new Error(`Invalid port in Docker MCP Gateway URL: ${rawUrl}`)
    }
    return numericPort
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid port')) throw error
    throw new Error(`Invalid DOCKER_MCP_GATEWAY_URL: ${rawUrl}`)
  }
}

function dockerMcpGatewayProfile(env) {
  const rawProfile = env.get('DOCKER_MCP_PROFILE') || env.get('DOCKER_MCP_GATEWAY_PROFILE') || ''
  const profile = rawProfile.trim()
  if (!profile) return ''
  if (!DOCKER_MCP_PROFILE_PATTERN.test(profile)) {
    throw new Error(
      `Invalid DOCKER_MCP_PROFILE '${profile}'. Use letters, numbers, dots, underscores, or hyphens.`
    )
  }
  return profile
}

function dockerMcpGatewayToken(env) {
  return (
    env.get('MCP_GATEWAY_AUTH_TOKEN') ||
    env.get('DOCKER_MCP_AUTH_TOKEN') ||
    env.get('DOCKER_MCP_GATEWAY_TOKEN') ||
    ''
  )
}

async function fetchDockerMcpGatewayStatus(env, port) {
  const token = dockerMcpGatewayToken(env)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    // The gateway token comes from .env.docker and is used only for the local Docker MCP Gateway probe.
    // codeql[js/file-access-to-http]
    const response = await fetch(`http://localhost:${port}/mcp`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal
    })
    return response.status
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function stopKnownDockerMcpGateway() {
  if (!existsSync(DOCKER_MCP_GATEWAY_PID_FILE)) return
  const rawPid = readFileSync(DOCKER_MCP_GATEWAY_PID_FILE, 'utf8').trim()
  const pid = Number(rawPid)
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Ignore stale pid files; the next start will overwrite the pid.
    }
  }
}

function startDetachedDockerMcpGateway(env, port, profile) {
  const token = dockerMcpGatewayToken(env)
  mkdirSync(path.dirname(DOCKER_MCP_GATEWAY_LOG_FILE), { recursive: true })
  mkdirSync(path.dirname(DOCKER_MCP_GATEWAY_PID_FILE), { recursive: true })

  const args = ['mcp', 'gateway', 'run', '--port', String(port), '--transport', 'streaming']
  if (profile) args.push('--profile', profile)

  const out = openSync(DOCKER_MCP_GATEWAY_LOG_FILE, 'w')
  // The gateway log path is a Batshit-owned local runtime file.
  // codeql[js/file-system-race]
  const err = openSync(DOCKER_MCP_GATEWAY_LOG_FILE, 'a')
  const child = spawn('docker', args, {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      MCP_GATEWAY_AUTH_TOKEN: token
    },
    stdio: ['ignore', out, err],
    windowsHide: true
  })
  child.unref()
  closeSync(out)
  closeSync(err)
  writeFileSync(DOCKER_MCP_GATEWAY_PID_FILE, `${child.pid}\n`)
}

async function waitForDockerMcpGateway(env, port) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const status = await fetchDockerMcpGatewayStatus(env, port)
    if (status && status !== 401 && status !== 403) return status
    if (status === 401 || status === 403) return status
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

async function ensureDockerMcpGateway(env) {
  const port = dockerMcpGatewayPort(env)
  if (!port) return

  const token = dockerMcpGatewayToken(env)
  if (!token) {
    throw new Error(
      'DOCKER_MCP_GATEWAY_PORT/URL is configured, but MCP_GATEWAY_AUTH_TOKEN is missing from .env.docker.'
    )
  }

  const profile = dockerMcpGatewayProfile(env)
  const existingStatus = await fetchDockerMcpGatewayStatus(env, port)
  if (existingStatus && existingStatus !== 401 && existingStatus !== 403) {
    const profileLabel = profile || 'Docker default'
    console.log(`Docker MCP Gateway is already running on port ${port} (${profileLabel}).`)
    return
  }
  if (existingStatus === 401 || existingStatus === 403) {
    throw new Error(
      `A Docker MCP Gateway is already running on port ${port} with a different token. Stop it or keep one .env.docker MCP_GATEWAY_AUTH_TOKEN for this Batshit instance.`
    )
  }

  const profileLabel = profile || 'Docker default'
  console.log(`Starting Docker MCP Gateway on port ${port} (${profileLabel})...`)
  stopKnownDockerMcpGateway()
  startDetachedDockerMcpGateway(env, port, profile)

  const status = await waitForDockerMcpGateway(env, port)
  if (!status || status === 401 || status === 403) {
    throw new Error(
      `Docker MCP Gateway did not become reachable on port ${port}. Check ${path.relative(ROOT, DOCKER_MCP_GATEWAY_LOG_FILE)}.`
    )
  }
  console.log(`Docker MCP Gateway started on port ${port}.`)
}

function startMacOperator() {
  const uidResult = run('id', ['-u'])
  if (uidResult.status !== 0) {
    throw new Error(uidResult.stderr?.trim() || 'Unable to read current user id.')
  }
  const uid = uidResult.stdout.trim()
  const plistPath = writeMacLaunchAgentPlist()

  run('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' })
  const bootstrap = run('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  if (bootstrap.status !== 0) {
    throw new Error(
      bootstrap.stderr?.trim() ||
        bootstrap.stdout?.trim() ||
        'launchctl bootstrap failed for Docker Sandbox operator.'
    )
  }
  const kickstart = run('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`])
  if (kickstart.status !== 0) {
    throw new Error(
      kickstart.stderr?.trim() ||
        kickstart.stdout?.trim() ||
        'launchctl kickstart failed for Docker Sandbox operator.'
    )
  }
}

function stopKnownOperator() {
  if (process.platform === 'darwin') {
    const uidResult = run('id', ['-u'])
    if (uidResult.status === 0) {
      run('launchctl', ['bootout', `gui/${uidResult.stdout.trim()}/${LAUNCHD_LABEL}`], {
        stdio: 'ignore'
      })
    }
    return
  }

  if (!existsSync(PID_FILE)) return
  const rawPid = readFileSync(PID_FILE, 'utf8').trim()
  const pid = Number(rawPid)
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Ignore stale pid files; the next start will overwrite the pid.
    }
  }
}

function startDetachedOperator() {
  mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  mkdirSync(path.dirname(PID_FILE), { recursive: true })
  const out = openSync(LOG_FILE, 'a')
  // The operator log path is a Batshit-owned local runtime file.
  // codeql[js/file-system-race]
  const err = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [OPERATOR_SCRIPT], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      BATSHIT_RUNTIME_ADDON_OPERATOR_ROOT: ROOT,
      BATSHIT_RUNTIME_ADDON_OPERATOR_ENV_FILE: envFilePath
    },
    stdio: ['ignore', out, err]
  })
  child.unref()
  closeSync(out)
  closeSync(err)
  writeFileSync(PID_FILE, `${child.pid}\n`)
}

async function waitForOperator(env) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const status = await fetchOperatorStatus(env)
    if (status) return status
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

async function ensureSandboxOperator(env) {
  const driver = env.get('BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER') || 'operator'
  if (['disabled', 'disable', 'off', 'none', 'unavailable'].includes(driver)) {
    console.log('Docker Sandbox operator is disabled by .env.docker.')
    return
  }

  let existing = null
  try {
    existing = await fetchOperatorStatus(env)
  } catch (error) {
    if (error instanceof Error && error.message.includes('different token')) {
      console.log('Restarting Docker Sandbox operator to pick up the current .env.docker token...')
      stopKnownOperator()
    } else {
      throw error
    }
  }
  if (existing) {
    const health = await fetchOperatorHealth(env)
    if (operatorSupportsCurrentRuntimeControls(health)) {
      printOperatorStatus(existing, 'Docker Sandbox operator is already running.')
      return
    }
    console.log('Restarting Docker Sandbox operator to pick up current runtime controls...')
    stopKnownOperator()
  }

  console.log('Starting Docker Sandbox operator...')
  if (process.platform === 'darwin') startMacOperator()
  else startDetachedOperator()

  const status = await waitForOperator(env)
  if (!status) {
    throw new Error(
      `Docker Sandbox operator did not become reachable. Check ${path.relative(ROOT, LOG_FILE)}.`
    )
  }
  printOperatorStatus(status, 'Docker Sandbox operator started.')
}

function printOperatorStatus(status, prefix) {
  if (status.available) {
    console.log(`${prefix} Sandbox CLI: ${status.cli || 'available'}.`)
    return
  }
  console.warn(`${prefix} Operator is reachable, but Sandbox is unavailable: ${status.reason}`)
}

function ensureDockerCli() {
  const result = run('docker', ['version', '--format', '{{.Client.Version}}'])
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        'Docker CLI is unavailable. Start Docker Desktop/Engine and try again.'
    )
  }
}

function runCompose({ profiles, build, projectName }) {
  const args = ['compose', '--env-file', envFilePath]
  if (projectName) args.push('--project-name', projectName)
  for (const profile of profiles) args.push('--profile', profile)
  args.push('up', '-d')
  if (build) args.push('--build')

  console.log(`Running: docker ${args.join(' ')}`)
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    env: {
      ...process.env,
      BATSHIT_DOCKER_ENV_FILE: envFilePath,
      ...(projectName ? { COMPOSE_PROJECT_NAME: projectName } : {})
    },
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed.`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  envFilePath = path.resolve(ROOT, options.envFile)
  ensureDockerCli()

  const { env, notes } = prepareEnvFile(options.profiles)
  for (const note of notes) console.log(note)

  if (options.startSandboxOperator) {
    await ensureSandboxOperator(env)
  }
  if (options.startDockerMcpGateway) {
    await ensureDockerMcpGateway(env)
  }

  runCompose(options)

  const appPort = process.env.BATSHIT_DOCKER_APP_PORT || env.get('BATSHIT_DOCKER_APP_PORT') || '5620'
  console.log(`Batshit Docker is starting at http://localhost:${appPort}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
