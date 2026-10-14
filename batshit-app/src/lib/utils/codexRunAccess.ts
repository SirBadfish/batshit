import type { CodexPermissionMode, CodexRuntimeSettings } from '$lib/types/codex'

/**
 * BL-941: the rule that decides a Codex run's mode and sandbox from the agent's record and the
 * mode a send carries. The server (`codexSettings.ts`) runs it for every Codex run; the chat bar
 * runs the same function to show the level a send will use, so the screen and the run agree.
 * No server imports: both sides load this file.
 */

export type CodexSandboxLevel = CodexRuntimeSettings['sandbox']

/** Each Codex mode's own sandbox and approval word (a mode pick writes these). */
export const CODEX_PERMISSION_PRESETS: Record<
  CodexPermissionMode,
  { sandbox: CodexSandboxLevel; approval: CodexRuntimeSettings['approval'] }
> = {
  chat: {
    sandbox: 'read-only',
    approval: 'never'
  },
  agent: {
    sandbox: 'workspace-write',
    approval: 'on-request'
  },
  agent_full: {
    sandbox: 'danger-full-access',
    approval: 'never'
  }
}

/** BL-941: the order of a Codex run's access, tightest first. */
export const CODEX_PERMISSION_ORDER: readonly CodexPermissionMode[] = ['chat', 'agent', 'agent_full']
export const CODEX_SANDBOX_ORDER: readonly CodexSandboxLevel[] = [
  'read-only',
  'workspace-write',
  'danger-full-access'
]

/** Agent Settings' words for each Sandbox Level (its Sandbox Level menu). */
export const CODEX_SANDBOX_LABELS: Record<CodexSandboxLevel, string> = {
  'read-only': 'Read-only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Danger full access'
}

/** An unknown mode counts as `chat`, so it never wins a comparison. */
export function sanitizeCodexPermission(value: unknown): CodexPermissionMode {
  if (value === 'agent' || value === 'agent_full' || value === 'chat') {
    return value
  }
  return 'chat'
}

/** A sandbox in any letter case; anything else is no sandbox. */
export function sanitizeCodexSandbox(value: unknown): CodexSandboxLevel | undefined {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (CODEX_SANDBOX_ORDER.includes(lower as CodexSandboxLevel)) {
      return lower as CodexSandboxLevel
    }
  }
  return undefined
}

/** The record's mode was tighter than the mode a send carried: both, for the reply's note. */
export interface CodexModeLimit {
  sentMode: CodexPermissionMode
  ranMode: CodexPermissionMode
}

export interface CodexRunAccess {
  /** The mode the run starts with. */
  permissionMode: CodexPermissionMode
  sandbox: CodexSandboxLevel
  modeLimitedByAgentSettings: CodexModeLimit | null
}

function tighterOf<T>(order: readonly T[], first: T, second: T): T {
  return order.indexOf(first) <= order.indexOf(second) ? first : second
}

/**
 * BL-941: the agent's record is the upper bound of a Codex run. A mode that a send carries (the
 * chat bar's `metadata.codexPermissionMode`) can make the run tighter than the record, never
 * looser.
 * 1. The mode is the tighter of the sent mode and the record's mode; with no sent mode, the record's.
 * 2. The saved level is the record's sandbox, or the record mode's own level when it has none.
 * 3. With a sent mode the sandbox is the tighter of the mode's own level and the saved level. With
 *    no sent mode it is the saved level as it is (a Worker, a wake-up, the profile file).
 * 4. The run starts as `agent_full` only with `danger-full-access`; otherwise `agent_full` starts
 *    as `agent` with that sandbox (the bridge gives an `agent_full` start full access).
 * It reads its own inputs, so an unknown value never wins a comparison: an unknown mode (saved or
 * sent) counts as `chat`, and a stored sandbox it cannot read counts as `read-only`. A missing
 * (or null) sent mode is no sent mode; a missing sandbox is the record mode's own level.
 */
export function resolveCodexRunAccess(input: {
  recordMode?: unknown
  recordSandbox?: unknown
  sentMode?: unknown
}): CodexRunAccess {
  const recordMode = sanitizeCodexPermission(input.recordMode)
  const sentMode =
    input.sentMode === undefined || input.sentMode === null ? undefined : sanitizeCodexPermission(input.sentMode)
  const mode = sentMode === undefined ? recordMode : tighterOf(CODEX_PERMISSION_ORDER, sentMode, recordMode)
  const savedSandbox =
    input.recordSandbox === undefined || input.recordSandbox === null
      ? CODEX_PERMISSION_PRESETS[recordMode].sandbox
      : (sanitizeCodexSandbox(input.recordSandbox) ?? 'read-only')
  const sandbox =
    sentMode === undefined
      ? savedSandbox
      : tighterOf(CODEX_SANDBOX_ORDER, CODEX_PERMISSION_PRESETS[mode].sandbox, savedSandbox)
  return {
    permissionMode: mode === 'agent_full' && sandbox !== 'danger-full-access' ? 'agent' : mode,
    sandbox,
    modeLimitedByAgentSettings:
      sentMode !== undefined && mode !== sentMode ? { sentMode, ranMode: mode } : null
  }
}
