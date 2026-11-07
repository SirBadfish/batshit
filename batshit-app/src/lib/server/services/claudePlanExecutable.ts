import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { resolveClaudeCliExecutableDetailed } from '$lib/server/services/claudeCliStatus'
import {
  buildClaudeChildProcessOptions,
  resolveClaudeRunAsIdentity,
  type ClaudeRunAsIdentity
} from '$lib/server/services/claudeRuntimeUser'
import { MANAGED_CLI_PINNED_VERSIONS } from '$lib/server/services/managedCliInstaller'

const execFileAsync = promisify(execFile)

/**
 * SA-139 (D2, startup admission step 1): the Claude plan connection runs exactly one qualified,
 * unmodified Claude Code executable. This module binds it (real path, `--version`, file identity
 * with a SHA-256) and reads `claude auth status --json` with that binary and the connection's
 * strict child environment. Both are documented and make no model call.
 *
 * It never installs, replaces, repairs or signs in; it never reads a credential file, and it never
 * keeps the account's email or organization (`auth status` prints them; only the plan facts leave
 * this module). P1's readiness and P2's run both use it, so the run and the Settings display agree.
 */

/** Versions the connection's stream-json, hook and MCP contract was qualified on (P0 probes, D13). */
export const CLAUDE_PLAN_QUALIFIED_VERSIONS: readonly string[] = Object.freeze([MANAGED_CLI_PINNED_VERSIONS.claude])

const VERSION_TIMEOUT_MS = 10_000
const AUTH_STATUS_TIMEOUT_MS = 10_000

export type ClaudePlanExecutableErrorCode = 'not_found' | 'not_executable' | 'version_unreadable' | 'version_unqualified' | 'changed'

export class ClaudePlanExecutableError extends Error {
  constructor(public readonly code: ClaudePlanExecutableErrorCode, message: string) {
    super(message)
    this.name = 'ClaudePlanExecutableError'
  }
}

const REPAIR = 'Install or reinstall the managed Claude Code from Agent Settings, then refresh.'

export type ClaudePlanExecutable = Readonly<{
  /** The path the resolver chose (env override, managed install, PATH or a well-known place). */
  requestedPath: string
  /** Its real path: the file every run spawns. */
  realPath: string
  version: string
  size: number
  mtimeMs: number
  /**
   * Evidence only (lead S6, 2026-10-27): no trusted reference exists for a user's own install, and a managed
   * install is verified by the installer's sha512 when it is installed. The checks are the version and the
   * file identity; the hash is never compared.
   */
  sha256: string
  source: ReturnType<typeof resolveClaudeCliExecutableDetailed>['source']
  /** Device, inode, size, mtime and ctime in nanoseconds: what a later check compares. */
  identity: string
}>

type IdentityFacts = { identity: string; size: number; mtimeMs: number }

async function identityOf(file: string): Promise<IdentityFacts> {
  const facts = await stat(file, { bigint: true })
  if (!facts.isFile()) throw new ClaudePlanExecutableError('not_executable', `Claude Code at ${file} is not a file. ${REPAIR}`)
  return {
    identity: [facts.dev, facts.ino, facts.size, facts.mtimeNs, facts.ctimeNs].map(String).join(':'),
    size: Number(facts.size),
    mtimeMs: Number(facts.mtimeMs)
  }
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
  })
}

/** `2.1.296 (Claude Code)` → `2.1.296`. Anything else is unreadable, never guessed. */
export function parseClaudeCodeVersion(output: string): string | null {
  const match = /^\s*(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/.exec(output)
  return match ? match[1] : null
}

/** The network proxy names a container behind a proxy needs (Faye S7, lead's pick): passed by name, Docker only. */
const DOCKER_PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'] as const

function isContainerized(source: NodeJS.ProcessEnv): boolean {
  return ['1', 'true', 'yes'].includes((source.BATSHIT_CONTAINERIZED ?? '').trim().toLowerCase())
}

/**
 * The child environment's strict allowlist (D2). Nothing from the app's own environment passes
 * except the locale and, in the Docker app container only, the standard proxy names (a container
 * behind a proxy cannot reach Anthropic otherwise): no `ANTHROPIC_*`, `CLAUDE_CODE_*`, session,
 * Batshit or provider variable. The run adds only its own documented Claude Code settings on top.
 */
export function buildClaudePlanBaseEnv(identity: ClaudeRunAsIdentity = resolveClaudeRunAsIdentity(), source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const nodeDir = path.dirname(process.execPath)
  const searchPath = Array.from(new Set([nodeDir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])).join(':')
  const user = identity.user ?? os.userInfo().username
  const runAs = identity.uid !== undefined || identity.home !== undefined || identity.user !== undefined
  const proxies: Record<string, string> = {}
  if (isContainerized(source)) {
    for (const name of DOCKER_PROXY_NAMES) {
      const value = source[name]?.trim()
      if (value) proxies[name] = value
    }
  }
  return {
    HOME: identity.home ?? os.homedir(),
    USER: user,
    LOGNAME: user,
    SHELL: identity.shell ?? '/bin/sh',
    PATH: searchPath,
    TMPDIR: runAs ? '/tmp' : os.tmpdir(),
    LANG: source.LANG?.trim() || 'en_US.UTF-8',
    ...proxies
  }
}

/** The file a check found, without the evidence hash: what display readiness binds (lead, 2026-10-27). */
export type ClaudePlanExecutableCheck = Omit<ClaudePlanExecutable, 'sha256'>

const versionCache = new Map<string, string>()
const hashCache = new Map<string, string>()

/** Exported for tests only. */
export function clearClaudePlanExecutableCacheForTests(): void {
  versionCache.clear()
  hashCache.clear()
}

type BindOptions = {
  resolution?: ReturnType<typeof resolveClaudeCliExecutableDetailed>
  runAs?: ClaudeRunAsIdentity
  qualifiedVersions?: readonly string[]
}

/**
 * Bind the executable a run will spawn. The version (and, with `evidence`, the hash) is reused only
 * while the file's identity (device, inode, size, mtime, ctime) is unchanged, so a replaced binary is
 * read again.
 */
async function bindFile(options: BindOptions, evidence: boolean): Promise<ClaudePlanExecutableCheck & { sha256?: string }> {
  const runAs = options.runAs ?? resolveClaudeRunAsIdentity()
  const resolution = options.resolution ?? resolveClaudeCliExecutableDetailed(process.env, runAs.home ?? os.homedir())
  if (resolution.source === 'not-found') {
    throw new ClaudePlanExecutableError('not_found', `Claude Code is not installed. ${REPAIR}`)
  }
  let realPath: string
  try {
    realPath = await realpath(resolution.executable)
    await access(realPath, constants.X_OK)
  } catch {
    throw new ClaudePlanExecutableError('not_executable', `Claude Code at ${resolution.executable} cannot be run. ${REPAIR}`)
  }
  const before = await identityOf(realPath)
  const key = `${realPath}\n${before.identity}`
  let version = versionCache.get(key)
  let sha256 = evidence ? hashCache.get(key) : undefined
  const readVersion = !version
  if (readVersion) {
    let output: string
    try {
      const result = await execFileAsync(realPath, ['--version'], {
        env: buildClaudePlanBaseEnv(runAs),
        ...buildClaudeChildProcessOptions(runAs),
        timeout: VERSION_TIMEOUT_MS
      })
      output = String(result.stdout ?? '')
    } catch {
      throw new ClaudePlanExecutableError('version_unreadable', `Claude Code at ${realPath} did not report its version. ${REPAIR}`)
    }
    version = parseClaudeCodeVersion(output) ?? undefined
    if (!version) throw new ClaudePlanExecutableError('version_unreadable', `Claude Code at ${realPath} reported a version Batshit cannot read. ${REPAIR}`)
  }
  const readHash = evidence && !sha256
  if (readHash) sha256 = await sha256Of(realPath)
  if (readVersion || readHash) {
    const after = await identityOf(realPath)
    if (after.identity !== before.identity) throw new ClaudePlanExecutableError('changed', `Claude Code at ${realPath} changed while Batshit checked it. Try again.`)
    versionCache.set(key, version!)
    if (sha256) hashCache.set(key, sha256)
  }
  const qualified = options.qualifiedVersions ?? CLAUDE_PLAN_QUALIFIED_VERSIONS
  if (!qualified.includes(version!)) {
    throw new ClaudePlanExecutableError('version_unqualified',
      `Claude Code ${version} is not a version the Claude plan connection was tested with (${qualified.join(', ')}). ${REPAIR}`)
  }
  return {
    requestedPath: resolution.executable,
    realPath,
    version: version!,
    size: before.size,
    mtimeMs: before.mtimeMs,
    source: resolution.source,
    identity: before.identity,
    ...(sha256 ? { sha256 } : {})
  }
}

/** Bind the executable a run will spawn, with the SHA-256 recorded as evidence (never compared). */
export async function bindClaudePlanExecutable(options: BindOptions = {}): Promise<ClaudePlanExecutable> {
  const bound = await bindFile(options, true)
  return Object.freeze({ ...bound, sha256: bound.sha256! })
}

/**
 * The same binding by path, identity and qualified version, without hashing the file (display
 * readiness: Settings, pickers, saved presets; lead, 2026-10-27). Admission and runs bind with the hash.
 */
export async function checkClaudePlanExecutable(options: BindOptions = {}): Promise<ClaudePlanExecutableCheck> {
  return Object.freeze(await bindFile(options, false))
}

/** Right before a spawn: the same real path still names the same file. */
export async function assertClaudePlanExecutableUnchanged(bound: ClaudePlanExecutableCheck): Promise<void> {
  let current: IdentityFacts
  try {
    if (await realpath(bound.requestedPath) !== bound.realPath) throw new Error('moved')
    current = await identityOf(bound.realPath)
  } catch {
    throw new ClaudePlanExecutableError('changed', `Claude Code at ${bound.requestedPath} changed since Batshit checked it. Try again.`)
  }
  if (current.identity !== bound.identity) {
    throw new ClaudePlanExecutableError('changed', `Claude Code at ${bound.realPath} changed since Batshit checked it. Try again.`)
  }
}

export type ClaudePlanAuthStatus =
  | { state: 'plan'; subscriptionType: string }
  | { state: 'refused'; code: 'signed_out' | 'api_key' | 'oauth_token' | 'third_party' | 'not_first_party' | 'unreadable'; reason: string }

const SIGN_IN = 'Sign in to Claude Code with your Claude plan (`claude auth login`), then refresh.'

/** Projects `claude auth status --json`. Only plan facts leave: never the email or organization. */
export function projectClaudePlanAuthStatus(raw: unknown): ClaudePlanAuthStatus {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!record) return { state: 'refused', code: 'unreadable', reason: `Batshit could not read Claude Code's sign-in status. ${SIGN_IN}` }
  if (record.loggedIn !== true) return { state: 'refused', code: 'signed_out', reason: `Claude Code is not signed in. ${SIGN_IN}` }
  const method = record.authMethod
  if (method === 'api_key' || method === 'api_key_helper') {
    return { state: 'refused', code: 'api_key', reason: 'Claude Code is set to use an API key, not a Claude plan. Remove the API key setting from Claude Code, then sign in with `claude auth login`.' }
  }
  if (method === 'oauth_token') {
    return { state: 'refused', code: 'oauth_token', reason: 'Claude Code is set to use a separate sign-in token, not its own Claude plan sign-in. Remove that token setting, then sign in with `claude auth login`.' }
  }
  if (method === 'third_party') {
    return { state: 'refused', code: 'third_party', reason: 'Claude Code is set to use a cloud provider (Bedrock, Vertex or similar), not a Claude plan.' }
  }
  if (record.apiProvider !== 'firstParty') {
    return { state: 'refused', code: 'not_first_party', reason: 'Claude Code is not signed in directly with Anthropic.' }
  }
  const subscription = typeof record.subscriptionType === 'string' ? record.subscriptionType.trim() : ''
  if (method !== 'claude.ai' || !subscription) {
    return { state: 'refused', code: 'unreadable', reason: `Claude Code's sign-in does not show a Claude plan. ${SIGN_IN}` }
  }
  return { state: 'plan', subscriptionType: subscription }
}

/**
 * `claude auth status --json` with the bound binary and the strict environment (no model call), with
 * the run's `--setting-sources ""` so it reads the sign-in the run will use: user, project and local
 * settings (an `apiKeyHelper`, say) are left out on both sides; managed settings load on both (Faye
 * S11). On the pin the flag is a top-level option and must come before `auth`; after it Claude Code
 * answers "unknown option". Measured 2026-10-27 on 2.1.296 with zero model calls: a project
 * `apiKeyHelper` read as `api_key_helper` without the flag and as the `claude.ai` plan with it.
 */
export const CLAUDE_PLAN_AUTH_STATUS_ARGS: readonly string[] = Object.freeze(['--setting-sources', '', 'auth', 'status', '--json'])

export async function readClaudePlanAuthStatus(bound: ClaudePlanExecutableCheck, runAs: ClaudeRunAsIdentity = resolveClaudeRunAsIdentity()): Promise<ClaudePlanAuthStatus> {
  await assertClaudePlanExecutableUnchanged(bound)
  let stdout = ''
  try {
    const result = await execFileAsync(bound.realPath, [...CLAUDE_PLAN_AUTH_STATUS_ARGS], {
      env: buildClaudePlanBaseEnv(runAs),
      ...buildClaudeChildProcessOptions(runAs),
      timeout: AUTH_STATUS_TIMEOUT_MS
    })
    stdout = String(result.stdout ?? '')
  } catch (error: any) {
    // A signed-out Claude Code answers with a non-zero exit and the same JSON.
    stdout = typeof error?.stdout === 'string' ? error.stdout : ''
  }
  let parsed: unknown = null
  try { parsed = JSON.parse(stdout) } catch { parsed = null }
  return projectClaudePlanAuthStatus(parsed)
}

/**
 * Managed (organization) policy that turns hooks off, read before any spawn (S2). Only the documented
 * policy documents are read (code.claude.com/docs/en/managed-settings, read 2026-10-27): the system
 * folder's `managed-settings.json` and `managed-settings.d/*.json` (macOS `/Library/Application
 * Support/ClaudeCode`, Linux and WSL `/etc/claude-code`) and, on macOS, the `com.anthropic.claudecode`
 * managed preferences. Never a credential. Managed settings always load: `--setting-sources` names only
 * user, project and local. Server-managed settings live with Anthropic, so the run's SessionStart check
 * is the catch-all for them; this read only gives the clearer reason earlier.
 */
const HOOK_POLICY_KEYS = ['disableAllHooks', 'allowManagedHooksOnly'] as const
const POLICY_DIRS: Partial<Record<NodeJS.Platform, string>> = { darwin: '/Library/Application Support/ClaudeCode', linux: '/etc/claude-code' }
const MANAGED_PREFERENCES = 'com.anthropic.claudecode.plist'

async function readJsonDocument(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

async function readPlistDocument(file: string): Promise<unknown> {
  try {
    await access(file, constants.R_OK)
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: VERSION_TIMEOUT_MS })
    return JSON.parse(String(stdout))
  } catch { return null }
}

export async function checkClaudeCodeHookPolicy(options: { platform?: NodeJS.Platform; policyDir?: string | null; managedPreferences?: string[] } = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const dir = options.policyDir === undefined ? POLICY_DIRS[platform] ?? null : options.policyDir
  const documents: Array<{ source: string; value: unknown }> = []
  if (dir) {
    documents.push({ source: path.join(dir, 'managed-settings.json'), value: await readJsonDocument(path.join(dir, 'managed-settings.json')) })
    let dropIns: string[] = []
    try { dropIns = (await readdir(path.join(dir, 'managed-settings.d'))).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort() } catch { dropIns = [] }
    for (const name of dropIns) {
      const file = path.join(dir, 'managed-settings.d', name)
      documents.push({ source: file, value: await readJsonDocument(file) })
    }
  }
  const preferences = options.managedPreferences ?? (platform === 'darwin'
    ? [path.join('/Library/Managed Preferences', MANAGED_PREFERENCES), path.join('/Library/Managed Preferences', os.userInfo().username, MANAGED_PREFERENCES)]
    : [])
  for (const file of preferences) documents.push({ source: file, value: await readPlistDocument(file) })
  for (const { source, value } of documents) {
    if (!value || typeof value !== 'object') continue
    const key = HOOK_POLICY_KEYS.find(name => (value as Record<string, unknown>)[name] === true)
    if (key) {
      return `Your organization's Claude Code policy (${source}) sets ${key}, which turns off the hooks the Claude plan connection needs to check every call. Batshit started nothing.`
    }
  }
  return null
}
