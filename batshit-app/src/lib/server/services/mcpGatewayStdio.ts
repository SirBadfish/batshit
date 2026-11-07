import path from 'node:path'
import { statSync, realpathSync } from 'node:fs'
import { access, constants as fsConstants, stat, realpath } from 'node:fs/promises'

import { redis } from '$lib/server/redis'
import {
  apiKeyService,
  normalizeApiKeyServiceName,
  INFRA_API_KEY_SERVICES
} from '$lib/services/apiKey.server'
import type {
  MCPGateway,
  MCPGatewayCwdPolicy,
  MCPGatewayEnvRef,
  MCPGatewayStdioConfig
} from '$lib/types/database'

const VALID_CWD_POLICIES = new Set<MCPGatewayCwdPolicy>(['none', 'project', 'fixed'])
const VALID_TEST_STATUSES = new Set(['never', 'passed', 'failed'])
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const STDIO_SHELL_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'cmd.exe'
])
const STDIO_INLINE_SHELL_FLAGS = new Set([
  '-c',
  '-lc',
  '-ic',
  '/c',
  '-command',
  '-encodedcommand'
])
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FILESYSTEM_SERVER_PACKAGES = new Set([
  '@modelcontextprotocol/server-filesystem',
  'mcp-server-filesystem'
])
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/

export const DEFAULT_STDIO_STARTUP_TIMEOUT_MS = 10_000
export const DEFAULT_STDIO_TOOL_TIMEOUT_MS = 60_000
export const MIN_STDIO_TIMEOUT_MS = 1_000
export const MAX_STDIO_STARTUP_TIMEOUT_MS = 120_000
export const MAX_STDIO_TOOL_TIMEOUT_MS = 300_000

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(numeric, min), max)
}

function sanitizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const values = input
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return values.length > 0 ? values : []
}

function sanitizeEnvRefs(input: unknown): MCPGatewayEnvRef[] | undefined {
  if (!Array.isArray(input)) return undefined

  const seen = new Set<string>()
  const refs: MCPGatewayEnvRef[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const envVar = normalizeString((entry as Record<string, unknown>).envVar)
    const savedKeyRef = normalizeString((entry as Record<string, unknown>).savedKeyRef)
    if (!envVar || !savedKeyRef) continue
    const dedupeKey = `${envVar}::${savedKeyRef}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    refs.push({ envVar, savedKeyRef })
  }

  return refs
}

export function isStdioGateway(gateway: Partial<MCPGateway> | null | undefined): gateway is MCPGateway {
  return gateway?.type === 'stdio'
}

export function sanitizeStdioGatewayConfig(input: unknown): MCPGatewayStdioConfig | undefined {
  if (!input || typeof input !== 'object') return undefined

  const raw = input as Record<string, unknown>
  const command = normalizeString(raw.command)
  const args = sanitizeStringArray(raw.args)
  const cwdPolicyRaw = normalizeString(raw.cwdPolicy)?.toLowerCase()
  const cwdPolicy = VALID_CWD_POLICIES.has(cwdPolicyRaw as MCPGatewayCwdPolicy)
    ? (cwdPolicyRaw as MCPGatewayCwdPolicy)
    : undefined
  const cwdValue = normalizeString(raw.cwdValue)
  const envRefs = sanitizeEnvRefs(raw.envRefs)
  const lastTestStatusRaw = normalizeString(raw.lastTestStatus)?.toLowerCase()
  const lastTestStatus = VALID_TEST_STATUSES.has(lastTestStatusRaw ?? '')
    ? lastTestStatusRaw
    : undefined
  const lastTestAt = normalizeString(raw.lastTestAt)
  const lastError = raw.lastError === null ? null : normalizeString(raw.lastError)
  const serverLabel = normalizeString(raw.serverLabel)
  const toolCount =
    typeof raw.toolCount === 'number' && Number.isFinite(raw.toolCount)
      ? Math.max(0, Math.floor(raw.toolCount))
      : undefined

  return {
    command: command ?? '',
    ...(args !== undefined ? { args } : {}),
    ...(cwdPolicy ? { cwdPolicy } : {}),
    ...(cwdValue ? { cwdValue } : {}),
    ...(envRefs !== undefined ? { envRefs } : {}),
    startupTimeoutMs: clampInteger(
      raw.startupTimeoutMs,
      DEFAULT_STDIO_STARTUP_TIMEOUT_MS,
      MIN_STDIO_TIMEOUT_MS,
      MAX_STDIO_STARTUP_TIMEOUT_MS
    ),
    toolCallTimeoutMs: clampInteger(
      raw.toolCallTimeoutMs,
      DEFAULT_STDIO_TOOL_TIMEOUT_MS,
      MIN_STDIO_TIMEOUT_MS,
      MAX_STDIO_TOOL_TIMEOUT_MS
    ),
    ...(lastTestStatus ? { lastTestStatus: lastTestStatus as MCPGatewayStdioConfig['lastTestStatus'] } : {}),
    ...(lastTestAt ? { lastTestAt } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(serverLabel ? { serverLabel } : {}),
    ...(toolCount !== undefined ? { toolCount } : {})
  }
}

export function validateStdioGatewayConfig(
  config: MCPGatewayStdioConfig | undefined
): { valid: boolean; error?: string } {
  if (!config) {
    return { valid: false, error: 'STDIO config is required' }
  }

  const command = normalizeString(config.command)
  if (!command) {
    return { valid: false, error: 'STDIO command is required' }
  }

  const commandBase = path.basename(command).toLowerCase()
  const args = Array.isArray(config.args) ? config.args : []
  if (STDIO_SHELL_COMMANDS.has(commandBase)) {
    const inlineFlag = args.find((arg) => STDIO_INLINE_SHELL_FLAGS.has(arg.trim().toLowerCase()))
    if (inlineFlag) {
      return {
        valid: false,
        error: `STDIO MCP servers must use argv-style launch args, not inline shell commands (${inlineFlag})`
      }
    }
  }

  const cwdPolicy = config.cwdPolicy ?? 'none'
  if (!VALID_CWD_POLICIES.has(cwdPolicy)) {
    return { valid: false, error: `Invalid STDIO cwd policy: ${cwdPolicy}` }
  }

  if (cwdPolicy === 'fixed') {
    const cwdValue = normalizeString(config.cwdValue)
    if (!cwdValue) {
      return { valid: false, error: 'Fixed STDIO cwd policy requires a directory path' }
    }
    if (!path.isAbsolute(cwdValue)) {
      return { valid: false, error: 'Fixed STDIO cwd must be an absolute path' }
    }
  }

  const envRefs = Array.isArray(config.envRefs) ? config.envRefs : []
  const envVars = new Set<string>()
  for (const entry of envRefs) {
    const envVar = normalizeString(entry.envVar)
    const savedKeyRef = normalizeString(entry.savedKeyRef)
    if (!envVar || !ENV_VAR_PATTERN.test(envVar)) {
      return { valid: false, error: `Invalid STDIO env var name: ${entry.envVar}` }
    }
    if (envVars.has(envVar)) {
      return { valid: false, error: `Duplicate STDIO env var mapping: ${envVar}` }
    }
    envVars.add(envVar)
    if (!savedKeyRef) {
      return { valid: false, error: `Missing saved key reference for env var ${envVar}` }
    }
    const normalizedKey = normalizeApiKeyServiceName(savedKeyRef)
    if (INFRA_API_KEY_SERVICES.has(normalizedKey)) {
      return {
        valid: false,
        error: `STDIO env refs cannot use Batshit infrastructure key "${normalizedKey}"`
      }
    }
  }

  return { valid: true }
}

async function ensureDirectoryExists(candidate: string, label: string): Promise<string> {
  const resolved = path.resolve(candidate)
  const details = await stat(resolved).catch(() => null)
  if (!details || !details.isDirectory()) {
    throw new Error(`${label} directory not found: ${resolved}`)
  }
  return resolved
}

async function resolveProjectDirectory(userId?: string, projectPath?: string | null): Promise<string> {
  const direct = normalizeString(projectPath)
  if (direct) {
    return await ensureDirectoryExists(direct, 'Project')
  }

  if (!userId) {
    throw new Error('STDIO gateway requires a project directory, but no user context was provided')
  }

  const preferences = await redis.getProjectPreferences(userId).catch(() => null)
  const fallback = normalizeString(preferences?.default_workspace_path)
  if (!fallback) {
    throw new Error(
      'STDIO gateway is set to use the project directory, but no active project or default workspace is available'
    )
  }

  return await ensureDirectoryExists(fallback, 'Default workspace')
}

async function findExecutableInPath(command: string): Promise<string | null> {
  const rawPath = process.env.PATH ?? ''
  const pathEntries = rawPath.split(path.delimiter).filter((entry) => entry.length > 0)
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : ['']

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === 'win32' ? `${command}${extension}` : command)
      try {
        await access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Keep searching.
      }
    }
  }

  return null
}

async function directoryExists(candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false
  const details = await stat(candidate).catch(() => null)
  return Boolean(details?.isDirectory())
}

function isContainerizedStdioRuntime(): boolean {
  return process.env.BATSHIT_CONTAINERIZED === '1'
}

function shouldRewriteContainerStdioPaths(): boolean {
  const raw = process.env.BATSHIT_DOCKER_STDIO_PATH_REWRITE_DISABLED?.trim().toLowerCase()
  return !TRUTHY_ENV_VALUES.has(raw ?? '')
}

function resolveContainerWorkspacePath(): string {
  return (
    normalizeString(process.env.BATSHIT_STDIO_WORKSPACE_PATH) ||
    normalizeString(process.env.BATSHIT_CODEX_WORKDIR) ||
    '/workspace'
  )
}

function isFilesystemStdioServer(config: MCPGatewayStdioConfig): boolean {
  const commandName = path.basename(config.command).toLowerCase()
  if (commandName.includes('filesystem')) return true

  return (config.args ?? []).some((arg) => {
    const normalized = arg.trim().toLowerCase()
    return FILESYSTEM_SERVER_PACKAGES.has(normalized) || normalized.includes('/server-filesystem')
  })
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) || value.startsWith('\\\\')
}

async function rewriteContainerFilesystemArgs(config: MCPGatewayStdioConfig): Promise<string[]> {
  const args = Array.isArray(config.args) ? config.args : []
  if (
    args.length === 0 ||
    !isContainerizedStdioRuntime() ||
    !shouldRewriteContainerStdioPaths() ||
    !isFilesystemStdioServer(config)
  ) {
    return args
  }

  const workspacePath = resolveContainerWorkspacePath()
  if (!(await directoryExists(workspacePath))) {
    return args
  }

  const rewrittenArgs: string[] = []
  for (const arg of args) {
    const trimmed = arg.trim()
    if (isAbsolutePathLike(trimmed) && !(await directoryExists(trimmed))) {
      rewrittenArgs.push(workspacePath)
    } else {
      rewrittenArgs.push(arg)
    }
  }

  return rewrittenArgs
}

async function resolveCommandExecutable(command: string, cwd?: string): Promise<string> {
  const trimmed = command.trim()
  if (trimmed.includes(path.sep) || trimmed.startsWith('.')) {
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd ?? process.cwd(), trimmed)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      throw new Error(`STDIO executable not found or not executable: ${candidate}`)
    }
  }

  const fromPath = await findExecutableInPath(trimmed)
  if (!fromPath) {
    throw new Error(`STDIO executable not found in PATH: ${trimmed}`)
  }
  return fromPath
}

async function resolveSavedKeyValue(savedKeyRef: string, userId?: string): Promise<string> {
  if (!userId) {
    throw new Error(`STDIO saved key "${savedKeyRef}" requires a user context`)
  }

  const normalized = normalizeApiKeyServiceName(savedKeyRef)
  const stored = await apiKeyService.retrieve(normalized, userId).catch(() => null)
  const trimmed = stored?.trim()
  if (!trimmed) {
    throw new Error(`Missing saved API key "${normalized}" for STDIO MCP server`)
  }
  return trimmed
}

export interface ResolvedStdioGatewayProcessConfig {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  startupTimeoutMs: number
  toolCallTimeoutMs: number
}

export async function resolveStdioGatewayProcessConfig(params: {
  gateway: MCPGateway
  userId?: string
  projectPath?: string | null
}): Promise<ResolvedStdioGatewayProcessConfig> {
  if (!isStdioGateway(params.gateway)) {
    throw new Error('Gateway is not an STDIO MCP gateway')
  }

  const config = sanitizeStdioGatewayConfig(params.gateway.stdioConfig)
  const validation = validateStdioGatewayConfig(config)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  const cwdPolicy = config?.cwdPolicy ?? 'none'
  let cwd: string | undefined
  if (cwdPolicy === 'fixed') {
    cwd = await ensureDirectoryExists(config!.cwdValue!, 'STDIO fixed cwd')
  } else if (cwdPolicy === 'project') {
    cwd = await resolveProjectDirectory(params.userId, params.projectPath)
  }

  const command = await resolveCommandExecutable(config!.command, cwd)
  const args = await rewriteContainerFilesystemArgs(config!)

  const env: Record<string, string> = {}
  for (const entry of config?.envRefs ?? []) {
    env[entry.envVar] = await resolveSavedKeyValue(entry.savedKeyRef, params.userId)
  }

  return {
    command,
    args,
    cwd,
    env,
    startupTimeoutMs: clampInteger(
      config?.startupTimeoutMs,
      DEFAULT_STDIO_STARTUP_TIMEOUT_MS,
      MIN_STDIO_TIMEOUT_MS,
      MAX_STDIO_STARTUP_TIMEOUT_MS
    ),
    toolCallTimeoutMs: clampInteger(
      config?.toolCallTimeoutMs,
      DEFAULT_STDIO_TOOL_TIMEOUT_MS,
      MIN_STDIO_TIMEOUT_MS,
      MAX_STDIO_TOOL_TIMEOUT_MS
    )
  }
}

export function buildManagedStdioPlaceholderName(gatewayId: string, envVar: string): string {
  const gatewayPart = gatewayId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const envPart = envVar.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const base = `BATSHIT_MCP_STDIO_${gatewayPart}_${envPart}`.replace(/_{2,}/g, '_')
  return base.slice(0, 120)
}

export function buildManagedStdioEnvironmentPlan(gateway: MCPGateway): {
  env: Record<string, string>
  placeholders: Array<{ placeholder: string; savedKeyRef: string }>
} {
  if (!isStdioGateway(gateway)) {
    return { env: {}, placeholders: [] }
  }

  const env: Record<string, string> = {}
  const placeholders: Array<{ placeholder: string; savedKeyRef: string }> = []

  for (const entry of gateway.stdioConfig?.envRefs ?? []) {
    const envVar = normalizeString(entry.envVar)
    const savedKeyRef = normalizeString(entry.savedKeyRef)
    if (!envVar || !savedKeyRef) continue
    const placeholder = buildManagedStdioPlaceholderName(gateway.id, envVar)
    env[envVar] = `\${${placeholder}}`
    placeholders.push({ placeholder, savedKeyRef })
  }

  return { env, placeholders }
}

export async function resolveManagedStdioEnvironmentValues(params: {
  gateway: MCPGateway
  userId: string
}): Promise<Record<string, string>> {
  const plan = buildManagedStdioEnvironmentPlan(params.gateway)
  const values: Record<string, string> = {}

  for (const entry of plan.placeholders) {
    values[entry.placeholder] = await resolveSavedKeyValue(entry.savedKeyRef, params.userId)
  }

  return values
}

/** Same package prerequisite classification used by supplied candidates. A runner
 * being executable never attests that its requested server is installed. */
export function stdioCommandNeedsInstallation(command: string): boolean {
  return ['npx','uvx','bunx','pipx','pnpm','npm','yarn'].includes((command.split(/[\\/]/).at(-1)?.toLowerCase() ?? '').replace(/\.(?:cmd|exe)$/, ''))
}
type InstalledStdioFile = Readonly<{ path: string; directory: boolean; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>
export type InstalledStdioLaunch = Readonly<Omit<ResolvedStdioGatewayProcessConfig, 'env' | 'args'> & { args: readonly string[]; executableIdentity: string; files: readonly InstalledStdioFile[] }>
/** Finite direct-executable cohort, not a parser for wrapper command lines or
 * an attestation of arbitrary program bytes. Shared at saved and realpath cuts. */
function assertInstalledStdioExecutable(command: string, args: readonly string[]): boolean {
  const base = (command.split(/[\\/]/).at(-1)?.toLowerCase() ?? '').replace(/\.exe$/, '')
  if (stdioCommandNeedsInstallation(command) || /^(?:npx|npm|pnpm|yarn)(?:-cli)?\.(?:cjs|mjs|js)$/.test(base) ||
    STDIO_SHELL_COMMANDS.has(base) || /\.(?:cmd|bat|ps1)$/i.test(command) ||
    /^(?:env|nice|nohup|timeout|stdbuf|setsid|sudo|doas|xargs|chroot|command|exec|busybox|time|arch|caffeinate|uv|deno|bun|pip|pip3|docker|podman)$/.test(base) ||
    args.some(arg => /^-(?:[ecmpr]|lc|ic)/i.test(arg) || /^--(?:eval|print|import|require|module|loader)(?:=|$)/i.test(arg))) {
    throw new Error('Wrappers, installation, inline execution and runtime launchers are outside this saved STDIO cohort.')
  }
  const interpreter = /^(?:node|nodejs|python(?:\d+(?:\.\d+)?)?|ruby|perl|php|lua)$/.test(base)
  if (interpreter && (!args[0] || !path.isAbsolute(args[0]))) throw new Error('A saved interpreter requires its concrete absolute installed local server entry.')
  return interpreter
}
/** Finite saved-only cohort. This is file identity, not provenance or byte
 * attestation. Ordinary resolution above intentionally keeps its own behavior. */
export function assertSavedInstalledStdioConfig(gateway: MCPGateway): void {
  const config = gateway.stdioConfig
  if (gateway.type !== 'stdio' || !config || gateway.url !== undefined || gateway.authKeyName !== undefined ||
    gateway.metadata && Object.hasOwn(gateway.metadata, 'authToken') || !validateStdioGatewayConfig(config).valid ||
    config.command !== config.command.trim() || stdioCommandNeedsInstallation(config.command) ||
    !['none','fixed'].includes(config.cwdPolicy ?? 'none') ||
    config.cwdPolicy === 'fixed' && config.cwdValue !== config.cwdValue?.trim() ||
    (config.args ?? []).some(arg => typeof arg !== 'string' || !arg || arg !== arg.trim() || arg.includes('\0')) ||
    (config.envRefs ?? []).some(row => row.envVar !== row.envVar.trim() || row.savedKeyRef !== normalizeApiKeyServiceName(row.savedKeyRef)) ||
    new Set((config.envRefs ?? []).map(row => row.savedKeyRef)).size > 13) throw new Error('This saved STDIO launch is outside the installed-source cohort.')
  assertInstalledStdioExecutable(config.command, config.args ?? [])
  for (const { value, maximum } of [{ value: config.startupTimeoutMs, maximum: MAX_STDIO_STARTUP_TIMEOUT_MS },
    { value: config.toolCallTimeoutMs, maximum: MAX_STDIO_TOOL_TIMEOUT_MS }]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < MIN_STDIO_TIMEOUT_MS || value > maximum)) throw new Error('The saved STDIO timeout cannot be silently normalized.')
  }
}
function installedFile(file: string, directory: boolean): InstalledStdioFile {
  const found = statSync(file)
  if (directory ? !found.isDirectory() : !found.isFile()) throw new Error('The retained installed STDIO path is unavailable.')
  return Object.freeze({ path: file, directory, dev: found.dev, ino: found.ino, size: directory ? 0 : found.size, mtimeMs: directory ? 0 : found.mtimeMs, ctimeMs: directory ? 0 : found.ctimeMs })
}
/** Synchronous final file fence, after every awaited admission and before spawn/send. */
export function assertInstalledStdioLaunchCurrent(launch: InstalledStdioLaunch): void {
  if (realpathSync(launch.command) !== launch.executableIdentity) throw new Error('The original installed STDIO executable identity changed.')
  for (const file of launch.files) {
    if (JSON.stringify(installedFile(file.path, file.directory)) !== JSON.stringify(file)) throw new Error('The original installed STDIO executable, entry or cwd changed.')
  }
}
export async function resolveInstalledStdioLaunch(gateway: MCPGateway): Promise<InstalledStdioLaunch> {
  assertSavedInstalledStdioConfig(gateway)
  const config = gateway.stdioConfig!
  const cwd = config.cwdPolicy === 'fixed' ? await ensureDirectoryExists(config.cwdValue!, 'STDIO fixed cwd') : undefined
  const command = await resolveCommandExecutable(config.command, cwd)
  const args = [...(config.args ?? [])]
  const executableIdentity = await realpath(command)
  const interpreter = assertInstalledStdioExecutable(executableIdentity, args)
  if (JSON.stringify(await rewriteContainerFilesystemArgs(config)) !== JSON.stringify(args)) throw new Error('A held STDIO launch cannot adopt a container path rewrite.')
  const files = [installedFile(command, false)]
  if (interpreter || /^(?:node|nodejs|python(?:\d+(?:\.\d+)?)?|ruby|perl|php|lua)(?:\.exe)?$/.test(path.basename(config.command).toLowerCase())) files.push(installedFile(args[0], false))
  if (cwd) files.push(installedFile(cwd, true))
  return Object.freeze({ command, executableIdentity, args: Object.freeze(args), ...(cwd ? { cwd } : {}), files: Object.freeze(files),
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STDIO_STARTUP_TIMEOUT_MS, toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_STDIO_TOOL_TIMEOUT_MS })
}
