import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const HOST = process.env.BATSHIT_AGENT_BROWSER_HOST || '0.0.0.0'
const PORT = Number(process.env.BATSHIT_AGENT_BROWSER_PORT || 8091)
const TOKEN = String(process.env.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN || '').trim()
const TMP_DIR = process.env.BATSHIT_AGENT_BROWSER_TMP_DIR || '/runtime/agent-browser/tmp'
const BROWSER_EXECUTABLE_PATH = process.env.AGENT_BROWSER_EXECUTABLE_PATH || null
const BROWSER_ARGS = process.env.AGENT_BROWSER_ARGS || null
const MAX_BODY_CHARS = 64_000
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 200_000
const ABSOLUTE_MAX_OUTPUT_CHARS = 400_000
const ALLOWED_ENV_KEYS = new Set([
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'BROWSERBASE_API_URL',
  'BROWSERBASE_URL',
  'BROWSER_USE_API_KEY',
  'BROWSERUSE_API_KEY',
  'BROWSER_USE_BASE_URL',
  'BROWSERUSE_BASE_URL',
  'KERNEL_API_KEY',
  'KERNEL_BASE_URL',
  'KERNEL_API_URL'
])

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function appendWithLimit(current, chunk, limit) {
  const next = current + String(chunk)
  if (next.length <= limit) return { text: next, truncated: false }
  return { text: next.slice(0, limit), truncated: true }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length)
  })
  res.end(body)
}

function isAuthorized(req) {
  if (!TOKEN) return true
  const auth = req.headers.authorization || ''
  const headerToken = req.headers['x-batshit-agent-browser-sidecar-token']
  return auth === `Bearer ${TOKEN}` || headerToken === TOKEN
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
      if (body.length > MAX_BODY_CHARS) {
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

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new Error('args must be an array.')
  if (args.length > 80) throw new Error('args contains too many entries.')
  return args.map((arg) => {
    if (typeof arg === 'string') return arg
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
    throw new Error('args may only contain string, number, or boolean values.')
  })
}

function normalizeEnv(rawEnv) {
  const env = {}
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return env
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!ALLOWED_ENV_KEYS.has(key)) continue
    if (typeof value !== 'string' || value.length === 0) continue
    env[key] = value
  }
  return env
}

function runAgentBrowser(args, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)
  const maxOutputChars = clampNumber(
    options.maxOutputChars,
    DEFAULT_MAX_OUTPUT_CHARS,
    1_000,
    ABSOLUTE_MAX_OUTPUT_CHARS
  )
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const child = spawn('agent-browser', args, {
      cwd: options.cwd || TMP_DIR || os.tmpdir(),
      env: {
        ...process.env,
        BATSHIT_AGENT_BROWSER_TMP_DIR: TMP_DIR,
        ...normalizeEnv(options.env)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 400).unref()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      const next = appendWithLimit(stdout, chunk, maxOutputChars)
      stdout = next.text
      truncated = truncated || next.truncated
    })

    child.stderr.on('data', (chunk) => {
      const next = appendWithLimit(stderr, chunk, maxOutputChars)
      stderr = next.text
      truncated = truncated || next.truncated
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        command: 'agent-browser',
        args,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
        error: error.message
      })
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        command: 'agent-browser',
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

async function handleHealth(_req, res) {
  const run = await runAgentBrowser(['--version'], {
    timeoutMs: 5_000,
    maxOutputChars: 4_096
  })
  const versionOutput = run.stdout.trim() || run.stderr.trim() || null
  sendJson(res, run.exitCode === 0 ? 200 : 503, {
    ok: run.exitCode === 0,
    service: 'batshit-agent-browser-sidecar',
    mode: 'docker-sidecar',
    version: versionOutput,
    tmpDir: TMP_DIR,
    browserExecutablePath: BROWSER_EXECUTABLE_PATH,
    browserArgs: BROWSER_ARGS,
    tokenConfigured: Boolean(TOKEN),
    run
  })
}

async function handleRun(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized.' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
    const args = normalizeArgs(body.args)
    const run = await runAgentBrowser(args, {
      env: body.env,
      maxOutputChars: body.maxOutputChars,
      cwd: TMP_DIR
    })
    sendJson(res, 200, { ok: run.exitCode === 0 && !run.timedOut, run })
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: 'Invalid Agent Browser sidecar request.'
    })
  }
}

async function handleRequest(req, res) {
  try {
    await mkdir(TMP_DIR, { recursive: true, mode: 0o700 })
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      await handleHealth(req, res)
      return
    }

    if (req.method === 'POST' && pathname === '/v1/run') {
      await handleRun(req, res)
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not found.' })
  } catch (error) {
    console.error('[agent-browser-sidecar] request failed:', error instanceof Error ? error.message : 'Unknown error')
    sendJson(res, 500, {
      ok: false,
      error: 'Agent Browser sidecar request failed.'
    })
  }
}

http.createServer(handleRequest).listen(PORT, HOST, () => {
  console.log(`Batshit Agent Browser sidecar listening on ${HOST}:${PORT}`)
})
