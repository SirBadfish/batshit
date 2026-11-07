import type { FileReadView } from './shellReadSplit'
import { SED_RANGE_SCRIPT } from './zipDeadCopies'

/**
 * SA-137 (live file reads, D4): where one stored Read File copy came from, written by the server
 * only after the read was proven against its file (`nativeTools.ts`: the command re-read and its
 * output matched exactly), and kept on the zip's metadata as `fileReadSource`.
 *
 * It names a path inside the original project, not a permanent file: a later compile admits the
 * current root and the exact locator again, and this record is never permission by itself. File
 * text and a model's `Path:` line never make one, and no route can mint one: the zip adapter writes
 * it only from a proof sealed in this process (`fileReadProofSeal.ts`). Anything that does not
 * validate here is a static copy, as today.
 */
export const FILE_READ_SOURCE_VERSION = 1

/** The actual execution backend of a proven read; this fact does not grant later refresh. */
export type FileReadBackend = 'local' | 'apple_container' | 'docker_sandbox'
const isFileReadBackend = (value: unknown): value is FileReadBackend =>
  value === 'local' || value === 'apple_container' || value === 'docker_sandbox'

export interface FileReadSource {
  version: typeof FILE_READ_SOURCE_VERSION
  owner: { userId: string; agentId: string; sessionId: string; messageId: string; toolCallId: string }
  /**
   * The actual read origin. Root paths and identities belong to the admitted writer's runtime.
   * In an app container they stay app-visible; operator host mappings are never saved here.
   * Refresh separately admits supported runtime/backend combinations before any file I/O.
   */
  backend: FileReadBackend
  /** The workspace root the read ran under, as its real path then. */
  workspaceRoot: string
  /** `<dev>:<ino>` of that root then: continuity evidence, never permission. */
  rootIdentity: string
  /** The working folder the command ran in. */
  cwd: string
  /** The file, relative to the workspace root (POSIX, inside it). */
  locator: string
  view: FileReadView
  /**
   * Whether live file reads were on for this agent when the read ran (Faye, 2026-10-21): only such a
   * read ever refreshes at turn start; absent or false, it stays static after a later enable. The
   * native Bash tool proves reads only when on (true); SA-136's typed read_file proves every read,
   * for its whole-read rule, and records the setting here. Every sandbox-origin record requires this
   * explicit boolean; only Local records may omit it for the legacy shape.
   */
  liveReadsOn?: boolean
}

/**
 * What the native Bash tool proved about one run's reads (`fileReadProof` on its result), before
 * the zip adapter binds each read to its zip. `part` is the read's index in the run's split parts,
 * or null for a one-file read.
 */
export interface FileReadProof {
  version: typeof FILE_READ_SOURCE_VERSION
  userId: string
  agentId: string
  sessionId: string
  messageId: string
  toolCallId: string
  backend: FileReadBackend
  workspaceRoot: string
  rootIdentity: string
  cwd: string
  reads: Array<{ part: number | null; file: string; locator: string; view: FileReadView }>
  /** As `FileReadSource.liveReadsOn`, for every read of the run. */
  liveReadsOn?: boolean
  /** The in-process seal (`fileReadProofSeal.ts`); a proof without a valid one makes no descriptor. */
  seal: string
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096

/** Exactly `keys`, plus any of `optional`, and nothing else. */
function onlyKeys(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const own = Object.keys(value)
  return keys.every((key) => own.includes(key)) && own.every((key) => keys.includes(key) || optional.includes(key))
}

/** Only the original Local shape may omit the setting bit; every sandbox origin must record it. */
const liveReadsOnValid = (value: Record<string, unknown>) => value.backend !== 'local'
  ? typeof value.liveReadsOn === 'boolean'
  : value.liveReadsOn === undefined || typeof value.liveReadsOn === 'boolean'

/** A project-relative POSIX path that stays inside its root. */
export function isFileReadLocator(value: unknown): value is string {
  if (!isText(value) || value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return false
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

const ROOT_IDENTITY = /^\d{1,20}:\d{1,20}$/

export function readFileReadView(value: unknown): FileReadView | null {
  if (!value || typeof value !== 'object') return null
  const view = value as Record<string, unknown>
  if (view.kind === 'whole' && onlyKeys(view, ['kind', 'numbering'])) {
    return view.numbering === 'none' || view.numbering === 'all' || view.numbering === 'nonblank'
      ? { kind: 'whole', numbering: view.numbering }
      : null
  }
  if (view.kind === 'lines' && onlyKeys(view, ['kind', 'script'])) {
    return typeof view.script === 'string' && SED_RANGE_SCRIPT.test(view.script) ? { kind: 'lines', script: view.script } : null
  }
  if (view.kind === 'typed' && onlyKeys(view, ['kind', 'startLine', 'endLine'])) {
    const { startLine, endLine } = view as { startLine: unknown; endLine: unknown }
    if (!Number.isSafeInteger(startLine) || (startLine as number) < 1) return null
    if (endLine !== null && (!Number.isSafeInteger(endLine) || (endLine as number) < (startLine as number))) return null
    return { kind: 'typed', startLine: startLine as number, endLine: endLine as number | null }
  }
  if ((view.kind === 'head' || view.kind === 'tail') && onlyKeys(view, ['kind', 'lines'])) {
    return Number.isSafeInteger(view.lines) && (view.lines as number) >= 1 ? { kind: view.kind, lines: view.lines as number } : null
  }
  return null
}

const SOURCE_KEYS = ['version', 'owner', 'backend', 'workspaceRoot', 'rootIdentity', 'cwd', 'locator', 'view'] as const
const OWNER_KEYS = ['userId', 'agentId', 'sessionId', 'messageId', 'toolCallId'] as const

/** A stored `fileReadSource`, or null for anything that is not exactly a v1 record. */
export function readFileReadSource(value: unknown): FileReadSource | null {
  if (!onlyKeys(value, SOURCE_KEYS, ['liveReadsOn']) || value.version !== FILE_READ_SOURCE_VERSION ||
      !isFileReadBackend(value.backend)) return null
  if (!liveReadsOnValid(value)) return null
  const owner = value.owner
  if (!onlyKeys(owner, OWNER_KEYS) || !OWNER_KEYS.every((key) => isText(owner[key]))) return null
  if (!isText(value.workspaceRoot) || !value.workspaceRoot.startsWith('/')) return null
  if (!isText(value.cwd) || !value.cwd.startsWith('/')) return null
  if (typeof value.rootIdentity !== 'string' || !ROOT_IDENTITY.test(value.rootIdentity)) return null
  if (!isFileReadLocator(value.locator)) return null
  const view = readFileReadView(value.view)
  if (!view) return null
  return {
    version: FILE_READ_SOURCE_VERSION,
    owner: {
      userId: owner.userId as string,
      agentId: owner.agentId as string,
      sessionId: owner.sessionId as string,
      messageId: owner.messageId as string,
      toolCallId: owner.toolCallId as string
    },
    backend: value.backend,
    workspaceRoot: value.workspaceRoot,
    rootIdentity: value.rootIdentity,
    cwd: value.cwd,
    locator: value.locator,
    view,
    ...(typeof value.liveReadsOn === 'boolean' ? { liveReadsOn: value.liveReadsOn } : {})
  }
}

/**
 * A cheap shape check before a proof's seal is computed: exactly the proof's keys, every field a
 * bounded string of its kind, and a short list of flat reads, so an outside value is never walked
 * deeply or hashed at size.
 */
export function hasFileReadProofShape(value: unknown): boolean {
  if (!onlyKeys(value, PROOF_KEYS, ['liveReadsOn']) || value.version !== FILE_READ_SOURCE_VERSION ||
      !isFileReadBackend(value.backend)) return false
  if (!liveReadsOnValid(value)) return false
  const texts = ['userId', 'agentId', 'sessionId', 'messageId', 'toolCallId', 'workspaceRoot', 'rootIdentity', 'cwd', 'seal'] as const
  if (!texts.every((key) => isText(value[key])) || !Array.isArray(value.reads) || value.reads.length > 512) return false
  return value.reads.every((read) =>
    onlyKeys(read, ['part', 'file', 'locator', 'view']) &&
    (read.part === null || (Number.isSafeInteger(read.part) && (read.part as number) >= 0)) &&
    isText(read.file) &&
    isFileReadLocator(read.locator) &&
    readFileReadView(read.view) !== null)
}

const PROOF_KEYS = ['version', 'userId', 'agentId', 'sessionId', 'messageId', 'toolCallId', 'backend', 'workspaceRoot', 'rootIdentity', 'cwd', 'reads', 'seal'] as const

/**
 * The descriptor for one stored part of a native Bash run (`part`: its split index, or null for a
 * one-file read), or null. The run's proof must name exactly this chat and reply; the adapter
 * gives the call id. The caller checks the proof's seal first (`verifyFileReadProofSeal`).
 */
export function fileReadSourceFromProof(
  proof: unknown,
  binding: { sessionId: string; messageId: string; toolCallId: unknown; part: number | null; file?: string }
): FileReadSource | null {
  if (!onlyKeys(proof, PROOF_KEYS, ['liveReadsOn']) || proof.version !== FILE_READ_SOURCE_VERSION || !Array.isArray(proof.reads)) return null
  // The proof names its own chat, reply and call; a copy of it (an SSE event carries the result to
  // the tabs) can only ever describe that same call's read.
  if (proof.sessionId !== binding.sessionId || proof.messageId !== binding.messageId || proof.toolCallId !== binding.toolCallId) return null
  const matches = proof.reads.filter((read) => read && typeof read === 'object' && (read as Record<string, unknown>).part === binding.part)
  if (matches.length !== 1) return null
  const read = matches[0] as Record<string, unknown>
  if (!onlyKeys(read, ['part', 'file', 'locator', 'view'])) return null
  if (binding.file !== undefined && read.file !== binding.file) return null
  return readFileReadSource({
    version: FILE_READ_SOURCE_VERSION,
    owner: {
      userId: proof.userId,
      agentId: proof.agentId,
      sessionId: proof.sessionId,
      messageId: proof.messageId,
      toolCallId: proof.toolCallId
    },
    backend: proof.backend,
    workspaceRoot: proof.workspaceRoot,
    rootIdentity: proof.rootIdentity,
    cwd: proof.cwd,
    locator: read.locator,
    view: read.view,
    ...(proof.liveReadsOn !== undefined ? { liveReadsOn: proof.liveReadsOn } : {})
  })
}
