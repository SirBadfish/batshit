import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { env } from '$env/dynamic/private'
import { zipSync } from 'fflate/node'

import { redis } from '$lib/server/redis'
import { resolveRuntimeContext } from '$lib/server/services/runtimeContext'
import { checkCoreSystemPromptDefaults } from '$lib/server/services/systemPromptRegistry'

const DIAGNOSTICS_SCHEMA_VERSION = 1
const MAX_LOG_FILES = 18
const MAX_LOG_BYTES_PER_FILE = 256 * 1024
const PREVIEW_SAMPLE_MAX_CHARS = 1400
const LOG_EXTENSIONS = new Set(['.log', '.txt', '.jsonl'])

type RuntimeEnv = Partial<Record<string, string | undefined>>

type LogCandidate = {
  filePath: string
  source: string
  sizeBytes: number
  modifiedAt: string
}

type CapturedLogFile = DiagnosticsLogFilePreview & {
  content: string
}

export type DiagnosticsLogFilePreview = {
  entryName: string
  source: string
  sizeBytes: number
  includedBytes: number
  truncated: boolean
  modifiedAt: string
  sample: string
}

export type DiagnosticsPreview = {
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION
  createdAt: string
  filename: string
  app: {
    name: 'Batshit'
    version: string
  }
  runtime: {
    mode: string
    label: string
    platform: NodeJS.Platform
    arch: string
    node: string
    pid: number
    uptimeSeconds: number
    cwd: string
  }
  health: {
    ok: boolean
    checks: {
      redis: boolean
      systemPromptDefaults: boolean
    }
    systemPromptDefaults?: unknown
    errors: string[]
  }
  environment: Record<string, string | boolean | null>
  contents: {
    included: Array<{
      path: string
      label: string
      description: string
    }>
    logFiles: DiagnosticsLogFilePreview[]
    totalLogBytes: number
  }
  safety: {
    redactionApplied: boolean
    redactionPatterns: string[]
    notIncluded: string[]
    warnings: string[]
  }
}

export type DiagnosticsBundle = {
  bytes: Uint8Array
  filename: string
  preview: DiagnosticsPreview
}

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_\-.])(api[_-]?key|token|secret|password|authorization|cookie|credential|encryption[_-]?key|auth[_-]?tag|private[_-]?key|session)(?:$|[_\-.])/i

const REDACTION_PATTERNS = [
  'API keys, provider keys, and service tokens',
  'Authorization and Cookie headers',
  'Password, secret, and credential fields',
  'Common GitHub/OpenAI/Anthropic token formats',
  'JWT-style bearer tokens',
  'URL username/password credentials',
  'Local home directory paths'
]

const NOT_INCLUDED = [
  'Chat messages and session history',
  'System prompts, agent prompts, and prompt drafts',
  'Uploads, clips, artifacts, backups, and project files',
  'Saved API keys, tokens, passwords, cookies, and encrypted credential records',
  'Redis database exports or raw application data',
  'n8n workflow contents and external runtime data'
]

function encodeText(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

function jsonBytes(value: unknown): Uint8Array {
  return encodeText(`${JSON.stringify(redactDiagnosticsValue(value), null, 2)}\n`)
}

function formatIsoFilenameDate(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-')
}

function createDiagnosticsFilename(createdAt: string): string {
  return `batshit-diagnostics-${formatIsoFilenameDate(new Date(createdAt))}.zip`
}

function redactHome(value: string): string {
  const home = os.homedir()
  if (!home || home === '/') return value
  return value.split(home).join('~')
}

function redactPath(value: string): string {
  return redactHome(value)
}

function safeEntrySegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return sanitized || 'log'
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

export function redactDiagnosticsText(input: string): string {
  let text = redactHome(input)

  text = text.replace(
    /(\b(?:Bearer|Token|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    '$1[REDACTED]'
  )
  text = text.replace(
    /(\bAuthorization\s*[:=]\s*)(['"]?)(?:Bearer|Token|Basic)?\s*[A-Za-z0-9._~+/=-]{12,}\2/gi,
    '$1[REDACTED]'
  )
  text = text.replace(
    /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credential|cookie|encryption[_-]?key|auth[_-]?tag|private[_-]?key)[A-Za-z0-9_.-]*\b\s*[:=]\s*)(["']?)[^\s"',}]+/gi,
    '$1[REDACTED]'
  )
  text = text.replace(
    /(["'])([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credential|cookie|encryption[_-]?key|auth[_-]?tag|private[_-]?key)[A-Za-z0-9_.-]*)\1\s*:\s*(["'])(?:(?!\3).)*\3/gi,
    '$1$2$1: "[REDACTED]"'
  )
  text = text.replace(/\bsk-proj-[A-Za-z0-9_-]{16,}\b/g, 'sk-proj-[REDACTED]')
  text = text.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'sk-ant-[REDACTED]')
  text = text.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[REDACTED]')
  text = text.replace(/\bghp_[A-Za-z0-9_]{20,}\b/g, 'ghp_[REDACTED]')
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]')
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, 'xox[REDACTED]')
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_JWT]'
  )
  text = text.replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1[REDACTED]@')

  return text
}

export function redactDiagnosticsValue(value: unknown, key = '', depth = 0): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]'
  if (depth > 8) return '[MAX_DEPTH]'

  if (typeof value === 'string') return redactDiagnosticsText(value)
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticsValue(entry, key, depth + 1))
  }

  const redacted: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    redacted[entryKey] = redactDiagnosticsValue(entryValue, entryKey, depth + 1)
  }
  return redacted
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function readPackageVersion(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(process.cwd(), 'batshit-app', 'package.json'),
    path.resolve(process.cwd(), '..', 'batshit-app', 'package.json')
  ]

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8')
      const parsed = JSON.parse(raw) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim()
      }
    } catch {
      // Try the next packaged/source location.
    }
  }

  return 'unknown'
}

function selectedEnvironment(runtimeEnv: RuntimeEnv): Record<string, string | boolean | null> {
  const valueKeys = [
    'NODE_ENV',
    'BATSHIT_RUNTIME_OWNER',
    'BATSHIT_RUNTIME_ENV',
    'BATSHIT_CONTAINERIZED',
    'PUBLIC_BASE_URL',
    'ORIGIN',
    'BATSHIT_FRONTEND_URL',
    'BATSHIT_SERVER_URL',
    'PUBLIC_BATSHIT_SERVER_URL',
    'N8N_EDITOR_URL',
    'BATSHIT_LOG_DIR',
    'BATSHIT_SERVER_LOG_DIR'
  ]
  const presenceKeys = [
    'BATSHIT_TOKEN',
    'ENCRYPTION_KEY',
    'MCP_GATEWAY_AUTH_TOKEN',
    'N8N_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET'
  ]

  const summary: Record<string, string | boolean | null> = {}
  for (const key of valueKeys) {
    const value = runtimeEnv[key]
    summary[key] = typeof value === 'string' && value.trim() ? redactPath(value.trim()) : null
  }
  for (const key of presenceKeys) {
    summary[`${key}_CONFIGURED`] = Boolean(runtimeEnv[key]?.trim())
  }
  return summary
}

async function collectHealth(): Promise<DiagnosticsPreview['health']> {
  const errors: string[] = []
  let redisReady = false
  let systemPromptDefaultsReady = false
  let systemPromptDefaults: unknown = undefined

  try {
    redisReady = (await redis.ping()) === 'PONG'
  } catch (error) {
    errors.push(redactDiagnosticsText(error instanceof Error ? error.message : 'Redis check failed'))
  }

  try {
    systemPromptDefaults = await checkCoreSystemPromptDefaults()
    systemPromptDefaultsReady = Boolean((systemPromptDefaults as { ready?: unknown })?.ready)
  } catch (error) {
    errors.push(
      redactDiagnosticsText(
        error instanceof Error ? error.message : 'System prompt defaults check failed'
      )
    )
  }

  return {
    ok: redisReady && systemPromptDefaultsReady,
    checks: {
      redis: redisReady,
      systemPromptDefaults: systemPromptDefaultsReady
    },
    systemPromptDefaults,
    errors
  }
}

function addExistingPath(paths: Set<string>, candidate: string | undefined): void {
  const trimmed = candidate?.trim()
  if (!trimmed) return
  paths.add(path.resolve(trimmed))
}

function defaultLogDirs(runtimeEnv: RuntimeEnv): Set<string> {
  const dirs = new Set<string>()
  addExistingPath(dirs, runtimeEnv.BATSHIT_LOG_DIR)
  addExistingPath(dirs, runtimeEnv.BATSHIT_SERVER_LOG_DIR)

  if (dirs.size > 0) {
    return dirs
  }

  addExistingPath(dirs, path.resolve(process.cwd(), '..', '_local', 'logs'))
  addExistingPath(dirs, '/data/logs')

  if (process.platform === 'darwin' || runtimeEnv.BATSHIT_RUNTIME_OWNER === 'mac-app') {
    addExistingPath(dirs, path.join(os.homedir(), 'Library', 'Logs', 'Batshit'))
  }

  return dirs
}

function defaultLogFiles(runtimeEnv: RuntimeEnv): Set<string> {
  const files = new Set<string>()
  addExistingPath(files, runtimeEnv.N8N_LOG_FILE)
  return files
}

async function inspectLogFile(filePath: string, sourceDir?: string): Promise<LogCandidate | null> {
  try {
    const lstat = await fs.lstat(filePath)
    if (lstat.isSymbolicLink()) return null

    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null
    if (!LOG_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null

    return {
      filePath,
      source: redactPath(sourceDir ?? path.dirname(filePath)),
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString()
    }
  } catch {
    return null
  }
}

async function discoverLogCandidates(runtimeEnv: RuntimeEnv): Promise<LogCandidate[]> {
  const candidates: LogCandidate[] = []

  for (const dir of defaultLogDirs(runtimeEnv)) {
    if (!(await pathExists(dir))) continue
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const candidate = await inspectLogFile(path.join(dir, entry.name), dir)
      if (candidate) candidates.push(candidate)
    }
  }

  for (const filePath of defaultLogFiles(runtimeEnv)) {
    const candidate = await inspectLogFile(filePath)
    if (candidate) candidates.push(candidate)
  }

  const deduped = new Map<string, LogCandidate>()
  for (const candidate of candidates) {
    deduped.set(path.resolve(candidate.filePath), candidate)
  }

  return Array.from(deduped.values())
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
    .slice(0, MAX_LOG_FILES)
}

async function readLogTail(filePath: string): Promise<{
  text: string
  includedBytes: number
  truncated: boolean
}> {
  const stat = await fs.stat(filePath)
  const includedBytes = Math.min(stat.size, MAX_LOG_BYTES_PER_FILE)
  const start = Math.max(0, stat.size - includedBytes)
  const buffer = Buffer.alloc(includedBytes)
  const handle = await fs.open(filePath, 'r')
  try {
    await handle.read(buffer, 0, includedBytes, start)
  } finally {
    await handle.close()
  }

  return {
    text: buffer.toString('utf8'),
    includedBytes,
    truncated: start > 0
  }
}

function previewSample(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= PREVIEW_SAMPLE_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, PREVIEW_SAMPLE_MAX_CHARS)}\n...`
}

async function captureLogs(runtimeEnv: RuntimeEnv): Promise<CapturedLogFile[]> {
  const candidates = await discoverLogCandidates(runtimeEnv)
  const captured: CapturedLogFile[] = []

  for (const [index, candidate] of candidates.entries()) {
    try {
      const tail = await readLogTail(candidate.filePath)
      const content = redactDiagnosticsText(tail.text)
      const entryName = `logs/${String(index + 1).padStart(2, '0')}-${safeEntrySegment(
        path.basename(candidate.filePath)
      )}`
      captured.push({
        entryName,
        source: candidate.source,
        sizeBytes: candidate.sizeBytes,
        includedBytes: tail.includedBytes,
        truncated: tail.truncated,
        modifiedAt: candidate.modifiedAt,
        sample: previewSample(content),
        content
      })
    } catch {
      // Skip unreadable logs. Diagnostics should still export the rest.
    }
  }

  return captured
}

function totalIncludedLogBytes(logs: DiagnosticsLogFilePreview[]): number {
  return logs.reduce((total, log) => total + log.includedBytes, 0)
}

function createWarnings(runtimeMode: string, logs: DiagnosticsLogFilePreview[]): string[] {
  const warnings: string[] = []
  if (logs.length === 0) {
    warnings.push('No file-based Batshit logs were found for this runtime.')
  }
  if (runtimeMode === 'docker') {
    warnings.push(
      'Docker stdout logs may still need Docker Desktop or docker compose logs if no file logs exist.'
    )
  }
  return warnings
}

async function buildDiagnosticsSnapshot(runtimeEnv: RuntimeEnv = env): Promise<{
  preview: DiagnosticsPreview
  logs: CapturedLogFile[]
}> {
  const createdAt = new Date().toISOString()
  const runtimeContext = resolveRuntimeContext(runtimeEnv)
  const [appVersion, health, logs] = await Promise.all([
    readPackageVersion(),
    collectHealth(),
    captureLogs(runtimeEnv)
  ])
  const runtimeMode = runtimeContext.mode
  const previewLogs = logs.map(({ content: _content, ...log }) => log)

  const preview: DiagnosticsPreview = {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    createdAt,
    filename: createDiagnosticsFilename(createdAt),
    app: {
      name: 'Batshit',
      version: appVersion
    },
    runtime: {
      mode: runtimeContext.mode,
      label: runtimeContext.label,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      cwd: redactPath(process.cwd())
    },
    health,
    environment: selectedEnvironment(runtimeEnv),
    contents: {
      included: [
        {
          path: 'manifest.json',
          label: 'Manifest',
          description: 'Summary of this diagnostics bundle and its safety rules.'
        },
        {
          path: 'README.md',
          label: 'README',
          description: 'Plain-English explanation of what the bundle contains.'
        },
        {
          path: 'runtime/context.json',
          label: 'Runtime Context',
          description: 'Batshit runtime mode, platform, Node version, and app version.'
        },
        {
          path: 'runtime/environment.json',
          label: 'Safe Environment Summary',
          description: 'Selected non-secret environment values plus configured/not-configured flags.'
        },
        {
          path: 'runtime/health.json',
          label: 'Health Check',
          description: 'Redis and system prompt default readiness status.'
        },
        {
          path: 'logs/*.log',
          label: 'Recent Log Tails',
          description: `Up to ${MAX_LOG_FILES} recent log files, capped at ${Math.round(
            MAX_LOG_BYTES_PER_FILE / 1024
          )} KB each.`
        }
      ],
      logFiles: previewLogs,
      totalLogBytes: totalIncludedLogBytes(previewLogs)
    },
    safety: {
      redactionApplied: true,
      redactionPatterns: REDACTION_PATTERNS,
      notIncluded: NOT_INCLUDED,
      warnings: createWarnings(runtimeMode, previewLogs)
    }
  }

  return { preview, logs }
}

function createReadme(preview: DiagnosticsPreview): string {
  return [
    '# Batshit Diagnostics Export',
    '',
    `Created: ${preview.createdAt}`,
    `Runtime: ${preview.runtime.label}`,
    `Batshit version: ${preview.app.version}`,
    '',
    'This bundle is meant for GitHub bug reports and support triage.',
    '',
    'Included:',
    ...preview.contents.included.map((entry) => `- ${entry.path}: ${entry.description}`),
    '',
    'Not included:',
    ...preview.safety.notIncluded.map((entry) => `- ${entry}`),
    '',
    'Safety:',
    '- Known secret patterns are redacted before files are added to the zip.',
    '- Log files are capped to recent tails, not full unbounded history.',
    '- Review the preview in Batshit before sharing this zip publicly.',
    ''
  ].join('\n')
}

export async function createDiagnosticsPreview(): Promise<DiagnosticsPreview> {
  const { preview } = await buildDiagnosticsSnapshot()
  return preview
}

export async function createDiagnosticsBundle(): Promise<DiagnosticsBundle> {
  const { preview, logs } = await buildDiagnosticsSnapshot()
  const entries: Record<string, Uint8Array> = {
    'manifest.json': jsonBytes(preview),
    'README.md': encodeText(createReadme(preview)),
    'runtime/context.json': jsonBytes({
      app: preview.app,
      runtime: preview.runtime
    }),
    'runtime/environment.json': jsonBytes(preview.environment),
    'runtime/health.json': jsonBytes(preview.health),
    'logs/index.json': jsonBytes(preview.contents.logFiles)
  }

  for (const log of logs) {
    entries[log.entryName] = encodeText(log.content)
  }

  return {
    bytes: zipSync(entries, { level: 6 }),
    filename: preview.filename,
    preview
  }
}
