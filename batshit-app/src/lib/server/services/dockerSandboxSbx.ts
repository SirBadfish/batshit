import { createHash } from 'node:crypto'
import { SANDBOX_COMMAND_TAG_ENV, sandboxCommandEndArgv } from './commandEnd'

/**
 * Docker Sandbox through Docker's standalone `sbx` CLI (Docker Sandboxes).
 *
 * Docker Desktop removed the older `docker sandbox` command ("deprecated and has been
 * removed"), so `sbx` is the only CLI Batshit drives. This module is pure: the command lines
 * Batshit runs, how it reads `sbx ls --json`, the sandbox name, which sandboxes are idle or
 * abandoned, and plain-language reasons for the failures the CLI reports. Measured against
 * sbx v0.43.0 on 2026-09-18:
 *
 * - Every command needs a signed-in Docker account (`sbx login`) and a one-time global
 *   network preset (`sbx policy init …`); without either, the CLI refuses.
 * - A deny rule for one sandbox is `policy deny network --sandbox <name> "**"`; the older
 *   positional sandbox name is rejected. `create --deny-network "**"` adds it at creation, a
 *   repeat of the same rule is a no-op, and removing the sandbox removes its rules.
 * - Names allow only letters, digits, hyphens, and periods.
 * - sbx stops a sandbox about 30 s after its last command ends, and `exec` starts it again in
 *   about a second with its state, so `stopped` is an idle sandbox, not a broken one.
 * - A sandbox mounts its workspace at exactly the host path it was given (no symlink
 *   resolution), so the create path and every `--workdir` must use the same path form.
 * - A second create of the same name fails with "409 Conflict … already exists".
 *
 * Windows, from Docker's issue tracker (docker/sbx-releases), not yet measured on a PC:
 * a drive path such as `C:\Users\me\work` appears inside the Linux sandbox as
 * `/c/Users/me/work` (#215, #449, #498), while `sbx ls --json` reports the `C:\…` form; and
 * when a call starts sbx's background daemon, the Windows build prints three
 * "Starting sandboxd daemon..." lines to stdout ahead of any JSON (#201, open at v0.42; the
 * Mac build prints its one line to stderr).
 *
 * The Docker host operator keeps a plain-JS twin, `tools/docker/sbx-cli.mjs`; change both
 * together.
 */

export const SBX_COMMAND = 'sbx'
export const SBX_SANDBOX_NAME_PREFIX = 'batshit-'
// The plain shell kit (Ubuntu with bash, git, curl, node, python3). An agent kit such as
// `codex` would add that agent's own network allowances, which Batshit does not need.
const SBX_SANDBOX_KIT = 'shell'
const SBX_ALL_HOSTS = '**'
// A stopped sandbox is idle, so only one nobody has used for this long counts as abandoned.
export const SBX_ABANDONED_AFTER_MS = 60 * 60_000

export const SBX_SETUP_STEPS =
  "Install Docker's sbx tool (Mac: `brew install docker/tap/sbx`; Windows: `winget install -h Docker.sbx`), " +
  'sign in once with `sbx login` (a free Docker account works), and run `sbx policy init balanced` once.'

export type SbxSandboxEntry = {
  name: string
  status: string
  workspaces: string[]
  lastUsedAt: string | null
}

export type SbxFailureKind =
  | 'not_installed'
  | 'not_signed_in'
  | 'network_policy_not_initialized'
  | 'already_exists'
  | 'not_found'
  | 'other'

function hashHex(value: string, length: number) {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export function buildSbxSessionMarker(sessionId: string) {
  return `-s${hashHex(sessionId, 8)}-`
}

export function buildSbxSandboxName(options: {
  userId?: string | null
  workspaceRoot: string
  sessionId?: string | null
}) {
  const userPart =
    (typeof options.userId === 'string' ? options.userId : '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 20) || 'user'
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  const sessionSegment = sessionId ? `s${hashHex(sessionId, 8)}-` : ''
  return `${SBX_SANDBOX_NAME_PREFIX}${userPart}-${sessionSegment}${hashHex(options.workspaceRoot, 10)}`
}

export function isManagedSbxSandboxName(name: string) {
  return Boolean(name) && name.startsWith(SBX_SANDBOX_NAME_PREFIX)
}

export function sbxVersionArgs() {
  return ['version']
}

export function sbxListArgs() {
  return ['ls', '--json']
}

export function sbxPolicyListArgs() {
  return ['policy', 'ls']
}

export function sbxCreateArgs(options: {
  sandboxName: string
  workspaceRoot: string
  extraWorkspaces?: string[]
}) {
  return [
    'create',
    '--name',
    options.sandboxName,
    '--deny-network',
    SBX_ALL_HOSTS,
    SBX_SANDBOX_KIT,
    options.workspaceRoot,
    ...(options.extraWorkspaces ?? [])
  ]
}

export function sbxDenyAllNetworkArgs(sandboxName: string) {
  return ['policy', 'deny', 'network', '--sandbox', sandboxName, SBX_ALL_HOSTS]
}

/**
 * Where a host folder is inside a sandbox: the same path, except that a Windows drive path
 * becomes `/<drive letter>/…`. Other paths pass through unchanged.
 */
export function toSbxSandboxPath(hostPath: string) {
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(hostPath)
  if (!drive) return hostPath
  const rest = hostPath
    .slice(drive[0].length)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
  return `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

/**
 * `cwd` is the host folder; `--workdir` is a path inside the sandbox, which sbx does not
 * translate. `tag` names the command for its end on a Stop or timeout (`commandEnd.ts`); it goes
 * last, so no caller's env replaces it.
 */
export function sbxExecArgs(options: {
  sandboxName: string
  cwd: string
  env?: Record<string, string>
  command: string
  tag: string
}) {
  const envArgs: string[] = []
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!key || typeof value !== 'string' || key === SANDBOX_COMMAND_TAG_ENV) continue
    envArgs.push('--env', `${key}=${value}`)
  }
  envArgs.push('--env', `${SANDBOX_COMMAND_TAG_ENV}=${options.tag}`)
  return [
    'exec',
    '--workdir',
    toSbxSandboxPath(options.cwd),
    ...envArgs,
    options.sandboxName,
    '/bin/bash',
    '-lc',
    options.command
  ]
}

/** A stopped or timed-out command's end, in its own sandbox. */
export function sbxCommandEndArgs(options: { sandboxName: string; tag: string }) {
  return ['exec', options.sandboxName, ...sandboxCommandEndArgv(options.tag)]
}

export function sbxRemoveArgs(names: string[]) {
  return ['rm', '--force', ...names]
}

export function sbxStopArgs(names: string[]) {
  return ['stop', ...names]
}

/**
 * The list starts at the first line that opens a JSON object, after any daemon-start lines.
 * Throws on output that is not the JSON `sbx ls --json` prints, so a CLI change is loud.
 */
export function parseSbxSandboxList(stdout: string): SbxSandboxEntry[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const jsonStart = trimmed.search(/^\{/m)
  if (jsonStart < 0) throw new Error('sbx ls --json printed no JSON.')
  const parsed = JSON.parse(trimmed.slice(jsonStart)) as { sandboxes?: unknown }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sandboxes)) {
    throw new Error('sbx ls --json did not return a sandboxes list.')
  }
  return parsed.sandboxes.flatMap((raw): SbxSandboxEntry[] => {
    const entry = raw as Record<string, unknown>
    if (typeof entry?.name !== 'string' || !entry.name) return []
    return [
      {
        name: entry.name,
        status: typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : '',
        workspaces: Array.isArray(entry.workspaces)
          ? entry.workspaces.filter((value): value is string => typeof value === 'string')
          : [],
        lastUsedAt: typeof entry.last_used_at === 'string' ? entry.last_used_at : null
      }
    ]
  })
}

/** Running, or stopped by sbx's idle timer: `exec` starts a stopped sandbox with its state. */
export function isReusableSbxSandbox(entry: SbxSandboxEntry) {
  return entry.status === 'running' || entry.status === 'stopped'
}

// Windows paths ignore case and accept either slash.
function comparableHostPath(value: string) {
  if (!/^[A-Za-z]:[\\/]/.test(value)) return value
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function sbxSandboxHasWorkspace(entry: SbxSandboxEntry, workspaceRoot: string) {
  return (
    entry.workspaces.length === 0 ||
    comparableHostPath(entry.workspaces[0]) === comparableHostPath(workspaceRoot)
  )
}

/** Not running and unused for an hour, or never timestamped: left behind by a crash or restart. */
export function isAbandonedSbxSandbox(entry: SbxSandboxEntry, nowMs = Date.now()) {
  if (entry.status === 'running') return false
  const lastUsed = entry.lastUsedAt ? Date.parse(entry.lastUsedAt) : Number.NaN
  if (!Number.isFinite(lastUsed)) return true
  return nowMs - lastUsed > SBX_ABANDONED_AFTER_MS
}

export function classifySbxFailure(output: string): SbxFailureKind {
  const text = output.toLowerCase()
  if (
    text.includes('enoent') ||
    text.includes('is not installed') ||
    text.includes('command not found') ||
    text.includes('is not recognized')
  ) {
    return 'not_installed'
  }
  if (text.includes('not authenticated')) return 'not_signed_in'
  if (text.includes('network policy has not been initialized')) return 'network_policy_not_initialized'
  if (text.includes('already exists')) return 'already_exists'
  if (text.includes('not found')) return 'not_found'
  return 'other'
}

/** The CLI's own output stays attached, so nothing it said is hidden. */
export function describeSbxFailure(output: string, fallback: string) {
  const detail = output.trim()
  const kind = classifySbxFailure(detail)
  const lead =
    kind === 'not_installed'
      ? `Docker Sandbox needs Docker's sbx tool, and it is not installed on this computer. ${SBX_SETUP_STEPS}`
      : kind === 'not_signed_in'
        ? 'Docker Sandbox is not signed in. Run `sbx login` on this computer (a free Docker account works), then try again.'
        : kind === 'network_policy_not_initialized'
          ? 'Docker Sandbox needs its one-time network setup. Run `sbx policy init balanced` on this computer, then try again.'
          : null
  if (!lead) return detail || fallback
  return detail ? `${lead} (sbx: ${detail.split('\n')[0].trim()})` : lead
}
