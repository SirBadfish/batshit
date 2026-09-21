// Docker Sandbox through Docker's standalone `sbx` CLI, for the Docker host operator.
//
// This is the operator's copy of batshit-app's `dockerSandboxSbx.ts`; the operator runs as
// its own Node process from the checkout and cannot import app source, so a change to
// either copy must be made in both. Pure helpers only: the command lines the operator runs,
// how it reads `sbx ls --json`, the sandbox name, which sandboxes are idle or abandoned, and
// plain-language reasons for failures. Measured against sbx v0.43.0 on 2026-09-18 (see the
// app copy for the full list): every command needs `sbx login` and a one-time
// `sbx policy init`; a per-sandbox deny rule needs `--sandbox`; names reject underscores;
// sbx stops an idle sandbox after about 30 s and `exec` starts it again with its state; a
// sandbox mounts its workspace at exactly the host path it was given. Windows, from Docker's
// issue tracker and not yet measured on a PC: `C:\Users\me\work` is `/c/Users/me/work`
// inside the sandbox, and a call that starts sbx's daemon prints daemon-start lines to
// stdout ahead of any JSON.
import { createHash } from 'node:crypto'
import { SANDBOX_COMMAND_TAG_ENV, sandboxCommandEndArgv } from './command-end.mjs'

export const SBX_COMMAND = 'sbx'
export const SBX_SANDBOX_NAME_PREFIX = 'batshit-'
const SBX_SANDBOX_KIT = 'shell'
const SBX_ALL_HOSTS = '**'
export const SBX_ABANDONED_AFTER_MS = 60 * 60_000

export const SBX_SETUP_STEPS =
  "Install Docker's sbx tool (Mac: `brew install docker/tap/sbx`; Windows: `winget install -h Docker.sbx`), " +
  'sign in once with `sbx login` (a free Docker account works), and run `sbx policy init balanced` once.'

function hashHex(value, length) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

export function buildSbxSessionMarker(sessionId) {
  return `-s${hashHex(sessionId, 8)}-`
}

export function buildSbxSandboxName({ userId, workspaceRoot, sessionId }) {
  const userPart =
    String(userId || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 20) || 'user'
  const session = typeof sessionId === 'string' ? sessionId.trim() : ''
  const sessionSegment = session ? `s${hashHex(session, 8)}-` : ''
  return `${SBX_SANDBOX_NAME_PREFIX}${userPart}-${sessionSegment}${hashHex(workspaceRoot, 10)}`
}

export function isManagedSbxSandboxName(name) {
  return Boolean(name) && name.startsWith(SBX_SANDBOX_NAME_PREFIX)
}

export const sbxVersionArgs = () => ['version']
export const sbxListArgs = () => ['ls', '--json']
export const sbxPolicyListArgs = () => ['policy', 'ls']

export function sbxCreateArgs({ sandboxName, workspaceRoot, extraWorkspaces = [] }) {
  return ['create', '--name', sandboxName, '--deny-network', SBX_ALL_HOSTS, SBX_SANDBOX_KIT, workspaceRoot, ...extraWorkspaces]
}

export function sbxDenyAllNetworkArgs(sandboxName) {
  return ['policy', 'deny', 'network', '--sandbox', sandboxName, SBX_ALL_HOSTS]
}

// Where a host folder is inside a sandbox: the same path, except that a Windows drive path
// becomes `/<drive letter>/…`. Other paths pass through unchanged.
export function toSbxSandboxPath(hostPath) {
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(hostPath)
  if (!drive) return hostPath
  const rest = hostPath
    .slice(drive[0].length)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
  return `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

// `cwd` is the host folder; `--workdir` is a path inside the sandbox, which sbx does not translate.
// `tag` names the command for its end on a Stop or timeout (`command-end.mjs`). It goes last, so
// no caller's env replaces it.
export function sbxExecArgs({ sandboxName, cwd, env = {}, command, tag }) {
  if (!tag) throw new Error('sbxExecArgs needs the command tag.')
  const envArgs = []
  for (const [key, value] of Object.entries(env)) {
    if (!key || typeof value !== 'string' || key === SANDBOX_COMMAND_TAG_ENV) continue
    envArgs.push('--env', `${key}=${value}`)
  }
  envArgs.push('--env', `${SANDBOX_COMMAND_TAG_ENV}=${tag}`)
  return ['exec', '--workdir', toSbxSandboxPath(cwd), ...envArgs, sandboxName, '/bin/bash', '-lc', command]
}

/** A stopped or timed-out command's end, in its own sandbox. */
export function sbxCommandEndArgs({ sandboxName, tag }) {
  return ['exec', sandboxName, ...sandboxCommandEndArgv(tag)]
}

export const sbxRemoveArgs = (names) => ['rm', '--force', ...names]
export const sbxStopArgs = (names) => ['stop', ...names]

// The list starts at the first line that opens a JSON object, after any daemon-start lines.
// Throws on output that is not the JSON `sbx ls --json` prints, so a CLI change is loud.
export function parseSbxSandboxList(stdout) {
  const trimmed = String(stdout || '').trim()
  if (!trimmed) return []
  const jsonStart = trimmed.search(/^\{/m)
  if (jsonStart < 0) throw new Error('sbx ls --json printed no JSON.')
  const parsed = JSON.parse(trimmed.slice(jsonStart))
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sandboxes)) {
    throw new Error('sbx ls --json did not return a sandboxes list.')
  }
  return parsed.sandboxes.flatMap((entry) => {
    if (typeof entry?.name !== 'string' || !entry.name) return []
    return [
      {
        name: entry.name,
        status: typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : '',
        workspaces: Array.isArray(entry.workspaces)
          ? entry.workspaces.filter((value) => typeof value === 'string')
          : [],
        lastUsedAt: typeof entry.last_used_at === 'string' ? entry.last_used_at : null
      }
    ]
  })
}

export function isReusableSbxSandbox(entry) {
  return entry.status === 'running' || entry.status === 'stopped'
}

// Windows paths ignore case and accept either slash.
function comparableHostPath(value) {
  if (!/^[A-Za-z]:[\\/]/.test(value)) return value
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function sbxSandboxHasWorkspace(entry, workspaceRoot) {
  return (
    entry.workspaces.length === 0 ||
    comparableHostPath(entry.workspaces[0]) === comparableHostPath(workspaceRoot)
  )
}

export function isAbandonedSbxSandbox(entry, nowMs = Date.now()) {
  if (entry.status === 'running') return false
  const lastUsed = entry.lastUsedAt ? Date.parse(entry.lastUsedAt) : Number.NaN
  if (!Number.isFinite(lastUsed)) return true
  return nowMs - lastUsed > SBX_ABANDONED_AFTER_MS
}

export function classifySbxFailure(output) {
  const text = String(output || '').toLowerCase()
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

// The CLI's own output stays attached, so nothing it said is hidden.
export function describeSbxFailure(output, fallback) {
  const detail = String(output || '').trim()
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
