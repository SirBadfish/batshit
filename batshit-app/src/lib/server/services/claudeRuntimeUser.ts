import { chown } from 'node:fs/promises'

export interface ClaudeRunAsIdentity {
  uid?: number
  gid?: number
  user?: string
  home?: string
  shell?: string
}

function parseRuntimeId(value: string | undefined): number | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
}

function trimRuntimeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

export function resolveClaudeRunAsIdentity(
  sourceEnv: Record<string, string | undefined> = process.env
): ClaudeRunAsIdentity {
  const uid = parseRuntimeId(sourceEnv.BATSHIT_CLAUDE_RUN_AS_UID)
  const gid = parseRuntimeId(sourceEnv.BATSHIT_CLAUDE_RUN_AS_GID)
  const user = trimRuntimeValue(sourceEnv.BATSHIT_CLAUDE_RUN_AS_USER)
  const home = trimRuntimeValue(sourceEnv.BATSHIT_CLAUDE_RUN_AS_HOME)
  const shell = trimRuntimeValue(sourceEnv.BATSHIT_CLAUDE_RUN_AS_SHELL) ?? (home || user ? '/bin/sh' : undefined)

  return {
    ...(uid !== undefined ? { uid } : {}),
    ...(gid !== undefined ? { gid } : {}),
    ...(user ? { user } : {}),
    ...(home ? { home } : {}),
    ...(shell ? { shell } : {})
  }
}

export function buildClaudeChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  identity: ClaudeRunAsIdentity = resolveClaudeRunAsIdentity(baseEnv)
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv }

  if (identity.home) {
    nextEnv.HOME = identity.home
  }
  if (identity.user) {
    nextEnv.USER = identity.user
    nextEnv.LOGNAME = identity.user
  }
  if (identity.shell) {
    nextEnv.SHELL = identity.shell
  }

  return nextEnv
}

export function buildClaudeChildProcessOptions(
  identity: ClaudeRunAsIdentity = resolveClaudeRunAsIdentity()
): { uid?: number; gid?: number } {
  return {
    ...(identity.uid !== undefined ? { uid: identity.uid } : {}),
    ...(identity.gid !== undefined ? { gid: identity.gid } : {})
  }
}

export function resolveClaudeRuntimeUid(
  sourceEnv: Record<string, string | undefined> = process.env
): number | null {
  const identity = resolveClaudeRunAsIdentity(sourceEnv)
  if (identity.uid !== undefined) return identity.uid

  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid
  return typeof getuid === 'function' ? getuid.call(process) : null
}

export function buildClaudeDockerExecOptions(
  identity: ClaudeRunAsIdentity = resolveClaudeRunAsIdentity()
): string {
  const args: string[] = []
  const userSpec =
    identity.user ??
    (identity.uid !== undefined
      ? identity.gid !== undefined
        ? `${identity.uid}:${identity.gid}`
        : String(identity.uid)
      : null)

  if (userSpec) {
    args.push('--user', userSpec)
  }
  if (identity.home) {
    args.push('--env', `HOME=${identity.home}`)
  }
  if (identity.user) {
    args.push('--env', `USER=${identity.user}`)
    args.push('--env', `LOGNAME=${identity.user}`)
  }
  if (identity.shell) {
    args.push('--env', `SHELL=${identity.shell}`)
  }

  return args.join(' ')
}

export async function applyClaudeRuntimeOwnership(filePath: string): Promise<void> {
  const identity = resolveClaudeRunAsIdentity()
  if (identity.uid === undefined && identity.gid === undefined) return

  const currentProcess = process as NodeJS.Process & {
    getuid?: () => number
    getgid?: () => number
  }
  await chown(
    filePath,
    identity.uid ?? currentProcess.getuid?.() ?? 0,
    identity.gid ?? currentProcess.getgid?.() ?? 0
  )
}
