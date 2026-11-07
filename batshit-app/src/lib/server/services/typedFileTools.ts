/**
 * SA-136 (2026-10-21): the API lane's typed file tools, `read_file`, `write_file` and `edit_file`,
 * built in beside `native_bash_execute` (never a Tool Search or DCM discovery entry).
 *
 * In SA-126 Claude models lost requests and tokens on file work done through Bash: writes refused
 * at the 4,000-character command cap or by the strict patch shape and then resent, reads the
 * dead-copy ledger could not trace, and edits that restated old code. These tools take the shapes
 * coding agents use (Pi 1.2.0: `read {path, offset, limit}`, `write {path, content}`,
 * `edit {path, edits: [{oldText, newText}]}`).
 *
 * The rules they keep (the P1 design settle, accepted by Faye on 2026-10-21):
 *
 * - Custody: the app process reads and writes at the workspace root, exactly as the managed
 *   `apply_patch` does; a sandbox backend sees the bytes through its workspace mount. No backend
 *   command runs. The containerized Docker path first asks its authenticated host operator for
 *   read-only workspace/policy admission; file work stays on the app writer with no fallback.
 * - Paths resolve as a managed patch's (`resolveManagedPatchPath`): the nearest existing folder is
 *   resolved through its links and must lie inside the workspace root. A link at the file itself
 *   is refused for all three tools (never followed); a folder link inside the workspace resolves.
 * - Consent is the standalone managed patch's: such a patch never asks, so these never raise a
 *   card. Plan mode allows writes and edits only on Markdown files; the protected targets (system
 *   skills, Batshit's own source) refuse in every mode. Never Allow covers them by name
 *   (`typedFileNeverAllowEntry`).
 * - A write or an edit is all or nothing: the new text is staged in a hidden file in the same
 *   folder and renamed over the target (`commitTypedFileWrite`). A Stop before that rename writes
 *   nothing; the call reports `committing` just before it and `applied` right after it
 *   (`onProgress`, BL-1978's path), so a reply stopped meanwhile still saves what happened.
 * - Results carry a frozen, versioned block (`typedFileRead`, `typedFileWrite`, `typedFileEdit`,
 *   v1) that the zip shapers keep as it is.
 *
 * Custody: one native anchored writer admits the planned real root and holds it for the call.
 * Planning may resolve folder aliases; every actual file operation then uses a strict relative
 * name through that writer, with no pathname fallback. The admitted READY identity owns read
 * proofs. Replacement stages beside the target and retains exact old permission bits.
 *
 * Named limits: last writer wins between the final check and rename; no crash durability (no
 * fsync); replacement does not retain owner, ACLs or extended attributes; other hard links keep
 * the old text. Kernel write permission is checked before replacement. An interrupted mutation
 * whose reply was lost is unknown, never claimed unapplied or restored. Cleanup only removes a
 * staged entry whose owned identity is verified; unreachable or unverified residue is named.
 */
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import { buildSnapshotEditPreview } from '$lib/utils/editDiff'
import { countTextLines } from '$lib/utils/writePreview'
import {
  sliceTypedRead,
  type TypedReadSlice,
  TYPED_READ_MAX_CHARS,
  type TypedFileChangeFacts,
  type TypedFileLineEnding,
  type TypedFileOutcome,
  type TypedFileReadFacts
} from '$lib/utils/typedFileFacts'
import { FILE_READ_SOURCE_VERSION, isFileReadLocator, type FileReadProof } from '$lib/utils/fileReadSource'
import { emulateFileReadView, type FileReadView } from '$lib/utils/shellReadSplit'
import { isRegexCommandPattern, parseCommandPattern } from './commandPatterns'
import { sealFileReadProof } from './fileReadProofSeal'
import { assertSandboxMountRootsSafe } from './sandboxHomeMounts'
import { readTypedFileToolsHost } from './typedFileToolsHost.server'
import { assertTypedContainerWorkspace } from './typedFileWorkspaceAdmission.server'
import { AnchoredProjectWriter, AnchoredWriteError, type AnchoredEntryStat } from './anchoredProjectWriter'

export { sliceTypedRead, TYPED_READ_MAX_CHARS, type TypedReadSlice } from '$lib/utils/typedFileFacts'

export const TYPED_READ_FILE_TOOL = 'read_file'
export const TYPED_WRITE_FILE_TOOL = 'write_file'
export const TYPED_EDIT_FILE_TOOL = 'edit_file'
export const TYPED_FILE_TOOL_NAMES = [TYPED_READ_FILE_TOOL, TYPED_WRITE_FILE_TOOL, TYPED_EDIT_FILE_TOOL] as const
/**
 * SA-139 (D4): marks the registered typed reader, which only reads, so the Claude plan bridge may let
 * Claude Code run its calls together (`readOnlyHint`). An own enumerable symbol, so every wrapper that
 * spreads the definition keeps it; a tool that merely shares the name never carries it.
 */
export const TYPED_READ_FILE_MARKER: unique symbol = Symbol('batshit.typedReadFile')
export type TypedFileToolName = (typeof TYPED_FILE_TOOL_NAMES)[number]

/** The most text one write sends, the managed patch's 200,000-character limit. */
export const TYPED_WRITE_MAX_CHARS = 200_000
/** The most text one edit's `oldText`s and `newText`s hold together. */
export const TYPED_EDIT_MAX_CHARS = 200_000
/** The most edits one call makes. */
export const TYPED_EDIT_MAX_EDITS = 50
/** The largest file read or edited (bytes); larger files are for Bash (`head`, `sed -n`). */
export const TYPED_FILE_MAX_BYTES = 10_000_000
/** How far `edit_file` counts matches of one `oldText` before it says "or more". */
const MAX_MATCHES_COUNTED = 1_000

/** Names a Never Allow entry must name to refuse each tool (P1 settle, 2026-10-21). */
const NEVER_ALLOW_NAMES_FOR_WRITES = ['apply_patch', TYPED_WRITE_FILE_TOOL, TYPED_EDIT_FILE_TOOL]
const NEVER_ALLOW_NAMES_FOR_READS = [TYPED_READ_FILE_TOOL]

const NOTHING_WRITTEN = 'Nothing was written.'
const NOTHING_READ = 'Nothing was read.'

export type TypedFileAccessMode = 'plan' | 'agent' | 'dangerous'

export interface TypedFileEnvironment {
  /** The workspace root, already resolved by the Bash workspace resolver. */
  workspaceRoot: string
  /** The folder a relative path starts from (the project), inside the root, already resolved. */
  cwd: string
  accessMode: TypedFileAccessMode
  /** The agent's actual command backend; anchored Local/Apple reads may carry provenance. */
  commandBackend?: string
  neverAllowList?: readonly string[] | null
  /** The managed patch's protected-target checks, for a write or an edit of this real path. */
  protectedWriteReason?: (targetPath: string) => string | null
  /** The model run's Stop. */
  abortSignal?: AbortSignal | null
  /** BL-1978: what the call already did, for a Stop that ends the stream before it returns. */
  onProgress?: (facts: Record<string, unknown>) => void
  /**
   * SA-136 P2b: who a read's sealed proof names (`fileReadProof`, SA-137's v1), from the server's
   * own context and the SDK's call id. Set only on a Primary API run (SA-137 leaves delegated runs
   * static); absent, a read makes no proof.
   */
  readProofOwner?: { userId: string; agentId: string; sessionId: string; messageId: string; toolCallId: string } | null
  /**
   * SA-137: whether live file reads are on for this agent now. Recorded in the read's proof (and so
   * its `fileReadSource`): only a read made with them on is ever refreshed at a later turn's start.
   */
  liveReadsOn?: boolean
  /** Server-owned operator policy admission; never supplied by tool arguments or a model. */
  admitDockerWorkspace?: (realRoot: string, realCwd: string, signal?: AbortSignal | null) => Promise<void>
}

/** One edit as the model sends it. */
export interface TypedFileEdit {
  oldText: string
  newText: string
}

export type TypedFileErrorCode = 'POLICY_BLOCKED' | 'INVALID_INPUT' | 'NOT_FOUND' | 'FILE_CHANGED' | 'IO_ERROR' | 'STOPPED'

export type TypedFileToolResult = Record<string, any> & {
  success: boolean
  tool: TypedFileToolName
  path: string
}

// ---------------------------------------------------------------------------------------------
// Descriptions and input schemas (Agent Docs; every API agent with the grant pays for them)

export const TYPED_READ_FILE_DESCRIPTION =
  'Read a UTF-8 text file in the project. `path` is relative to the project folder (or absolute inside it). ' +
  'Without offset/limit it returns the whole file, up to 90,000 characters; `offset` is the first line (1-based), `limit` the number of lines. ' +
  "The first line of the result names the lines shown and the file's total. Use this, not cat, sed or head in Bash."
export const TYPED_WRITE_FILE_DESCRIPTION =
  'Create or replace a whole UTF-8 text file in the project (content up to 200,000 characters; missing folders are made). ' +
  'The file is replaced in one step: it is either fully written or unchanged. To change part of a file, use edit_file.'
const TYPED_EDIT_FILE_MATCH_RULES =
  "Change a text file by exact replacement. Each oldText must match the file's current text exactly once (spaces and line breaks included) and is replaced by its newText. " +
  'All oldTexts are matched against the file as it was before this call, must not overlap, and apply together or not at all. '
/** Josh (2026-10-23): small changes, small diffs, as Pi steers its edit tool. */
export const TYPED_EDIT_FILE_PRECISE =
  'Keep each oldText as small as it can be while it is still unique, without unchanged lines it does not need. Merge nearby changes into one edit, and make every change to one file in one call. '
const TYPED_EDIT_FILE_TAIL = 'No regex or fuzzy matching. Use Bash for commands; apply_patch stays for multi-file patches.'
export const TYPED_EDIT_FILE_DESCRIPTION = TYPED_EDIT_FILE_MATCH_RULES + TYPED_EDIT_FILE_PRECISE + 'Copy oldText from a fresh read. ' + TYPED_EDIT_FILE_TAIL
/**
 * Josh, 2026-10-22: a turn that runs Refreshed File Reads shows open reads as fresh snapshots and
 * says not to read a file again just to see it fresh, so its edit_file text drops the
 * "fresh read" sentence that would ask for one.
 */
export const TYPED_EDIT_FILE_DESCRIPTION_REFRESHED = TYPED_EDIT_FILE_MATCH_RULES + TYPED_EDIT_FILE_PRECISE + TYPED_EDIT_FILE_TAIL
const PLAN_MODE_WRITE_SENTENCE = ' Plan mode: only .md files.'

const pathSchema = z.string().min(1).describe('File path, relative to the project folder')
export const TYPED_READ_FILE_INPUT_SCHEMA = z.object({
  path: pathSchema,
  offset: z.number().int().min(1).optional().describe('First line to read, 1-based'),
  limit: z.number().int().min(1).optional().describe('Number of lines to read')
})
export const TYPED_WRITE_FILE_INPUT_SCHEMA = z.object({
  path: pathSchema,
  content: z.string()
})
export const TYPED_EDIT_FILE_INPUT_SCHEMA = z.object({
  path: pathSchema,
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1)
})

// ---------------------------------------------------------------------------------------------
// Never Allow

/**
 * The Never Allow entry that refuses this tool, or null. An entry covers the typed tools by NAME
 * only (P1 settle; Ashe: no shell command is made up for matching, and no entry is read as a
 * file-path rule): a plain entry's first word, read with the list's own wildcard reader, is tested
 * against the bare names (`apply_patch`, `write_file` and `edit_file` for a write or an edit,
 * `read_file` for a read), and a regex entry is tested against the same names. So `apply_patch`,
 * `apply_patch*`, `apply_patch *.env`, `apply*`, `*` and `re:^apply` refuse writes; `rm*`, `cat*`
 * and `re:\.env` do not.
 */
export function typedFileNeverAllowEntry(
  neverAllowList: readonly string[] | null | undefined,
  tool: TypedFileToolName
): { entry: string; name: string } | null {
  const names = tool === TYPED_READ_FILE_TOOL ? NEVER_ALLOW_NAMES_FOR_READS : NEVER_ALLOW_NAMES_FOR_WRITES
  for (const raw of neverAllowList ?? []) {
    if (typeof raw !== 'string') continue
    const entry = raw.trim()
    if (!entry) continue
    const pattern = isRegexCommandPattern(entry) ? entry : entry.split(/\s+/)[0]
    const regex = parseCommandPattern(pattern)
    if (!regex) continue
    const name = names.find((candidate) => {
      regex.lastIndex = 0
      return regex.test(candidate)
    })
    if (name) return { entry, name }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Pure text rules

function lineEndingOf(text: string): TypedFileLineEnding {
  const crlf = /\r\n/.test(text)
  const bare = /(^|[^\r])\n/.test(text) || /\r(?!\n)/.test(text)
  if (crlf && bare) return 'mixed'
  if (crlf) return 'crlf'
  return bare ? 'lf' : 'none'
}

/** Every place `needle` starts in `text`, overlapping ones included, up to `MAX_MATCHES_COUNTED`. */
function matchStarts(text: string, needle: string): number[] {
  const starts: number[] = []
  for (let index = text.indexOf(needle); index >= 0 && starts.length < MAX_MATCHES_COUNTED; index = text.indexOf(needle, index + 1)) {
    starts.push(index)
  }
  return starts
}

export type TypedEditOutcome = { ok: true; text: string } | { ok: false; reason: string }

/**
 * `edit_file`'s rule, on text alone: every `oldText` matches the original text exactly once, the
 * matches do not overlap, and all of them are replaced together. A file whose every line ends in
 * CRLF is matched as LF (the model's CRLF too) and written back with CRLF; any other file is
 * matched exactly as it is. A byte-order mark is kept and is never part of a match.
 */
export function applyTypedEdits(original: string, edits: readonly TypedFileEdit[], displayPath: string): TypedEditOutcome {
  const bom = original.startsWith('﻿') ? '﻿' : ''
  const body = bom ? original.slice(1) : original
  const crlf = lineEndingOf(body) === 'crlf'
  const text = crlf ? body.replace(/\r\n/g, '\n') : body
  const asMatched = (value: string) => (crlf ? value.replace(/\r\n/g, '\n') : value)

  const ranges: Array<{ index: number; start: number; end: number; newText: string }> = []
  for (const [index, edit] of edits.entries()) {
    const oldText = asMatched(edit.oldText)
    const newText = asMatched(edit.newText)
    if (oldText.length === 0) {
      return { ok: false, reason: `edits[${index}].oldText is empty. To create or replace a whole file, use write_file. ${NOTHING_WRITTEN}` }
    }
    if (oldText === newText) {
      return { ok: false, reason: `edits[${index}] changes nothing: its oldText and newText are the same. ${NOTHING_WRITTEN}` }
    }
    const starts = matchStarts(text, oldText)
    if (starts.length === 0) {
      return { ok: false, reason: `edits[${index}].oldText is not in ${displayPath}. The file may have changed; read it again. ${NOTHING_WRITTEN}` }
    }
    if (starts.length > 1) {
      const count = starts.length >= MAX_MATCHES_COUNTED ? `${MAX_MATCHES_COUNTED.toLocaleString('en-US')} or more` : String(starts.length)
      return {
        ok: false,
        reason: `edits[${index}].oldText matches ${count} places in ${displayPath}; it must match exactly once. Add nearby lines to make it unique. ${NOTHING_WRITTEN}`
      }
    }
    ranges.push({ index, start: starts[0], end: starts[0] + oldText.length, newText })
  }

  const ordered = [...ranges].sort((a, b) => a.start - b.start)
  for (let position = 1; position < ordered.length; position += 1) {
    const before = ordered[position - 1]
    const after = ordered[position]
    if (after.start < before.end) {
      const [low, high] = [before.index, after.index].sort((a, b) => a - b)
      return { ok: false, reason: `edits[${low}] and edits[${high}] change overlapping text in ${displayPath}. Merge them into one edit. ${NOTHING_WRITTEN}` }
    }
  }

  let next = ''
  let cursor = 0
  for (const range of ordered) {
    next += text.slice(cursor, range.start) + range.newText
    cursor = range.end
  }
  next += text.slice(cursor)
  return { ok: true, text: bom + (crlf ? next.replace(/\n/g, '\r\n') : next) }
}

// ---------------------------------------------------------------------------------------------
// Paths

type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }

const identityOf = (info: AnchoredEntryStat): FileIdentity => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs })
const sameIdentity = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
const sameInode = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino
/** A replacement must still match its original full write baseline, including ctime and mode. */
const sameWriteIdentity = (a: AnchoredEntryStat, b: AnchoredEntryStat) =>
  a.type === 'file' && b.type === 'file' && sameIdentity(identityOf(a), identityOf(b)) && a.ctimeNs === b.ctimeNs && a.mode === b.mode

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const withSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return candidate === root || candidate.startsWith(withSeparator)
}

interface TypedFileTarget {
  /** The path the model named, resolved against the project folder (not through links). */
  absolutePath: string
  /** The real folder the file is in (or will be in), inside the workspace root. */
  realParent: string
  /** The folders a write must make, outermost first (empty when the folder exists). */
  missingFolders: string[]
  /** `realParent` + the file's name: the only path these tools touch. */
  targetPath: string
  /** The path as results show it: relative to the project folder when inside it. */
  displayPath: string
  /** The workspace root's real path, as this call resolved it. */
  realRoot: string
  /** This call's canonical project folder, checked with the planned root before admission. */
  realCwd: string
  /** Planning metadata, bound to the native helper READY identity before any file operation. */
  rootIdentity: string
  relativePath: string
}

type Refusal = { refused: true; code: TypedFileErrorCode; reason: string }

function refusal(code: TypedFileErrorCode, reason: string): Refusal {
  return { refused: true, code, reason }
}

function displayPathOf(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : absolutePath
}

/**
 * The managed patch's path rule (`resolveManagedPatchPath`, `nativeTools.ts`): the nearest existing
 * folder is resolved through its links and must lie inside the real workspace root.
 */
async function resolveTypedFileTarget(rawPath: string, env: TypedFileEnvironment, done: string): Promise<TypedFileTarget | Refusal> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return refusal('INVALID_INPUT', `A path is required. ${done}`)
  if (rawPath.includes('\0')) return refusal('INVALID_INPUT', `The path holds a NUL character. ${done}`)
  const lexicalRoot = path.resolve(env.workspaceRoot)
  const realRoot = (await realpath(lexicalRoot).catch(() => null)) ?? lexicalRoot
  const rootInfo = await lstat(realRoot, { bigint: true }).catch(() => null)
  if (!rootInfo?.isDirectory()) return refusal('IO_ERROR', `Could not admit workspace ${realRoot}. ${done}`)
  const realCwd = await realpath(path.resolve(env.cwd)).catch(() => null)
  if (!realCwd || !isPathWithinRoot(realCwd, realRoot)) return refusal('POLICY_BLOCKED', `The project folder is outside the admitted workspace (${realRoot}). ${done}`)
  const absolutePath = path.resolve(env.cwd, rawPath)
  const displayPath = displayPathOf(absolutePath, env.cwd)
  if (absolutePath === path.parse(absolutePath).root) return refusal('INVALID_INPUT', `${displayPath} is a folder, not a file. ${done}`)

  const missing: string[] = []
  let ancestor = path.dirname(absolutePath)
  let realAncestor: string | null = null
  for (;;) {
    realAncestor = await realpath(ancestor).catch(() => null)
    if (realAncestor) break
    if (await lstat(ancestor).then(() => true, () => false)) {
      return refusal('POLICY_BLOCKED', `${displayPath} goes through a link that cannot be resolved. ${done}`)
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    missing.unshift(path.basename(ancestor))
    ancestor = parent
  }
  if (!realAncestor) return refusal('POLICY_BLOCKED', `${displayPath} is outside the workspace (${realRoot}). ${done}`)
  const realParent = path.join(realAncestor, ...missing)
  if (!isPathWithinRoot(realParent, realRoot)) {
    return refusal('POLICY_BLOCKED', `${displayPath} is outside the workspace (${realRoot}). ${done}`)
  }
  const missingFolders = missing.map((_, index) => path.join(realAncestor!, ...missing.slice(0, index + 1)))
  const targetPath = path.join(realParent, path.basename(absolutePath))
  const relativePath = relativeBeneathRoot(targetPath, realRoot)
  if (!relativePath) return refusal('INVALID_INPUT', `${displayPath} is a folder, not a file. ${done}`)
  return { absolutePath, realParent, missingFolders, targetPath, displayPath, realRoot, realCwd, relativePath, rootIdentity: `${rootInfo.dev}:${rootInfo.ino}` }
}

/** All content and mutation calls use one admitted root and strict relative names. */
const TYPED_HELPER_CALL = { timeoutMs: 60_000 }
const readCall = (env: TypedFileEnvironment) => ({ ...TYPED_HELPER_CALL, ...(env.abortSignal ? { signal: env.abortSignal } : {}) })

function relativeBeneathRoot(candidate: string, root: string): string | null {
  const relative = path.relative(root, candidate)
  return relative && !path.isAbsolute(relative) && relative.split(path.sep).every((part) => part && part !== '.' && part !== '..')
    ? relative.split(path.sep).join('/') : null
}

async function admitTypedWriter(target: TypedFileTarget, env: TypedFileEnvironment, done: string): Promise<AnchoredProjectWriter | Refusal> {
  const containerized = readTypedFileToolsHost().containerized
  // Host file custody must not grant a sandboxed agent (Apple Container, or Docker Sandbox since
  // SA-137 Round 2) a workspace its actual sandbox would refuse. This read-only planning guard runs
  // before even admitting the native helper.
  if (env.commandBackend === 'apple_container' || env.commandBackend === 'docker_sandbox' || containerized) {
    try { await assertSandboxMountRootsSafe([target.realRoot]) }
    catch (error) { return refusal('POLICY_BLOCKED', `${errorText(error)} ${done}`) }
  }
  if (containerized) {
    try {
      if (env.abortSignal?.aborted) return refusal('STOPPED', `The call was stopped. ${done}`)
      await assertTypedContainerWorkspace({ workspaceRoot: env.workspaceRoot, cwd: env.cwd, realRoot: target.realRoot, realCwd: target.realCwd }, env.commandBackend)
      if (env.commandBackend === 'docker_sandbox') {
        if (!env.admitDockerWorkspace) throw new Error('Docker Sandbox typed file tools need the current host operator workspace admission.')
        await env.admitDockerWorkspace(target.realRoot, target.realCwd, env.abortSignal)
      } else if (env.commandBackend !== 'local') {
        throw new Error('Typed file tools are not qualified with this app-container backend.')
      }
      if (env.abortSignal?.aborted) return refusal('STOPPED', `The call was stopped. ${done}`)
    } catch (error) {
      if (env.abortSignal?.aborted) return refusal('STOPPED', `The call was stopped. ${done}`)
      return refusal('POLICY_BLOCKED', `${errorText(error)} ${done}`)
    }
  }
  let writer: AnchoredProjectWriter | null = null
  try {
    writer = await AnchoredProjectWriter.open(target.realRoot, readCall(env))
    if (writer.rootIdentity !== target.rootIdentity) {
      await writer.close()
      return folderReplaced(target, done)
    }
    return writer
  } catch (error) {
    await writer?.close().catch(() => {})
    return env.abortSignal?.aborted
      ? refusal('STOPPED', `Stopped before anything was ${done === NOTHING_READ ? 'read' : 'written'}. ${done}`)
      : refusal('IO_ERROR', `Could not admit workspace ${target.realRoot}: ${errorText(error)}. ${done}`)
  }
}

type LeafState = { kind: 'absent' } | { kind: 'file'; info: AnchoredEntryStat } | Refusal

/** What is at the target now. A link is never followed; only a regular file is a file. */
async function inspectLeaf(writer: AnchoredProjectWriter, target: TypedFileTarget, done: string, env: TypedFileEnvironment): Promise<LeafState> {
  try {
    const info = await writer.lstat(target.relativePath, readCall(env))
    if (info.type === 'absent') return { kind: 'absent' }
    if (info.type === 'parent-not-a-folder') return refusal('INVALID_INPUT', `A folder in ${target.displayPath} is a file. ${done}`)
    if (info.type === 'link') return refusal('POLICY_BLOCKED', `${target.displayPath} is a symbolic link; Batshit does not read or write through links. Use the path it points to. ${done}`)
    if (info.type === 'folder') return refusal('INVALID_INPUT', `${target.displayPath} is a folder, not a file. ${done}`)
    if (info.type !== 'file') return refusal('INVALID_INPUT', `${target.displayPath} is not a regular file. ${done}`)
    return { kind: 'file', info }
  } catch (error) {
    if (env.abortSignal?.aborted) return refusal('STOPPED', `Stopped before anything was ${done === NOTHING_READ ? 'read' : 'written'}. ${done}`)
    if (['ELOOP', 'EXDEV', 'ENOTDIR'].includes(errorCode(error) ?? '')) return folderReplaced(target, done)
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' }
    return refusal('IO_ERROR', `Could not look at ${target.displayPath}: ${errorText(error)}. ${done}`)
  }
}

/** Where a test may act during a call: a race, a Stop. */
export type TypedFileTestStage = 'afterResolve' | 'afterRead' | 'beforeStage' | 'afterTempOpen' | 'beforeCommit' | 'afterCommit'
const testHooks = new Map<TypedFileTestStage, () => void | Promise<void>>()
async function testHook(stage: TypedFileTestStage): Promise<void> {
  await testHooks.get(stage)?.()
}

/** Tests only: act at one stage of every call (null removes it). */
export function __setTypedFileTestHook(stage: TypedFileTestStage, hook: (() => void | Promise<void>) | null): void {
  if (hook) testHooks.set(stage, hook)
  else testHooks.delete(stage)
}

/** Tests only: act between staging and the final checks. */
export function __setTypedFileBeforeCommitForTests(hook: (() => void | Promise<void>) | null): void {
  __setTypedFileTestHook('beforeCommit', hook)
}

/** Tests only: act after the rename and its `applied` report, before the call returns. */
export function __setTypedFileAfterCommitForTests(hook: (() => void | Promise<void>) | null): void {
  __setTypedFileTestHook('afterCommit', hook)
}

/** The refusal for a folder that stopped being the one this call resolved inside the workspace. */
const folderReplaced = (target: TypedFileTarget, done: string) =>
  refusal('FILE_CHANGED', `A folder in ${target.displayPath} was replaced while this call ran. ${done}`)

/** The root's identity is from READY; the helper intentionally does not accept a '.' path. */
async function parentIdentity(writer: AnchoredProjectWriter, target: TypedFileTarget): Promise<{ dev: bigint; ino: bigint }> {
  if (target.realParent === target.realRoot) {
    const [dev, ino] = writer.rootIdentity!.split(':').map(BigInt)
    return { dev, ino }
  }
  const relative = relativeBeneathRoot(target.realParent, target.realRoot)
  if (!relative) throw new Error('invalid typed parent path')
  const info = await writer.lstat(relative, TYPED_HELPER_CALL)
  if (info.type !== 'folder') throw new AnchoredWriteError('parent', 'ENOTDIR')
  return info
}

/** Read bytes and verify the helper's opened stat plus the final entry against the original. */
async function readCheckedBytes(writer: AnchoredProjectWriter, target: TypedFileTarget, seen: AnchoredEntryStat, done: string, env: TypedFileEnvironment): Promise<Buffer | Refusal> {
  if (seen.size > BigInt(TYPED_FILE_MAX_BYTES)) {
    return refusal('INVALID_INPUT', `${target.displayPath} is ${seen.size.toLocaleString('en-US')} bytes; read_file and edit_file take files up to ${TYPED_FILE_MAX_BYTES.toLocaleString('en-US')} bytes. Use Bash. ${done}`)
  }
  try {
    const parent = await parentIdentity(writer, target)
    const read = await writer.readFile(target.relativePath, TYPED_FILE_MAX_BYTES, readCall(env))
    if (!sameIdentity(identityOf(read.stat), identityOf(seen))) return refusal('FILE_CHANGED', `${target.displayPath} changed while this call read it. Read it again. ${done}`)
    await testHook('afterRead')
    const atPath = await writer.lstat(target.relativePath, readCall(env))
    if (atPath.type !== 'file' || !sameIdentity(identityOf(atPath), identityOf(read.stat)) || !sameInode(parent, await parentIdentity(writer, target))) return folderReplaced(target, done)
    return read.bytes
  } catch (error) {
    if (env.abortSignal?.aborted) return refusal('STOPPED', `Stopped before anything was ${done === NOTHING_READ ? 'read' : 'written'}. ${done}`)
    if (['ELOOP', 'EXDEV', 'ENOTDIR'].includes(errorCode(error) ?? '')) return folderReplaced(target, done)
    if (errorCode(error) === 'ENOENT') return refusal('FILE_CHANGED', `${target.displayPath} was removed while this call read it. ${done}`)
    if (errorCode(error) === 'changed-or-oversize') return refusal('FILE_CHANGED', `${target.displayPath} changed while this call read it. Read it again. ${done}`)
    return refusal('IO_ERROR', `Could not read ${target.displayPath}: ${errorText(error)}. ${done}`)
  }
}

/** UTF-8 text, or null for bytes that are not (a NUL byte, or an invalid sequence). */
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// The commit


type CommitResult =
  | { committed: true; created: boolean; otherHardLinks: number }
  | (Refusal & { committed: false; stopped?: boolean; outcome: 'unapplied' | 'unknown' })

/** Only the mutation phases after exclusive creation can have made our staged entry. */
function refusedBeforeCreate(error: unknown): boolean {
  return error instanceof AnchoredWriteError && ['request', 'input', 'parent', 'leaf'].includes(error.stage)
}

/** A replacement helper may clean up only the same directory object the original admitted. */
async function writerForCleanup(writer: AnchoredProjectWriter, realRoot: string): Promise<AnchoredProjectWriter | null> {
  if (!writer.failed) return writer
  const fresh = await AnchoredProjectWriter.open(realRoot, TYPED_HELPER_CALL).catch(() => null)
  if (fresh && fresh.rootIdentity === writer.rootIdentity) return fresh
  await fresh?.close().catch(() => {})
  return null
}

/** Atomic staging and rename through the call's one admitted directory, never absolute paths. */
async function commitTypedFileWrite(options: {
  writer: AnchoredProjectWriter
  target: TypedFileTarget
  seen: { kind: 'absent' } | { kind: 'file'; info: AnchoredEntryStat }
  text: string
  env: TypedFileEnvironment
  committingFacts: Record<string, unknown>
  appliedFacts: (created: boolean, otherHardLinks: number) => Record<string, unknown>
}): Promise<CommitResult> {
  const { writer, target, seen, env } = options
  const made: Array<{ relative: string; identity: { dev: bigint; ino: bigint } | null }> = []
  let temp: string | null = null
  let staged: AnchoredEntryStat | null = null
  let stageMayExist = false
  let mutationUnknown = false
  let unverifiedStage = false
  const undo = async (): Promise<string> => {
    if (!stageMayExist && !made.length) return ''
    const cleanup = await writerForCleanup(writer, target.realRoot)
    const left: string[] = []
    try {
      if (stageMayExist && temp) {
        if (!cleanup) left.push(`${temp} (cleanup could not admit the original workspace)`)
        else {
          try {
            const current = await cleanup.lstat(temp, TYPED_HELPER_CALL)
            if (current.type !== 'absent') {
              if (!staged || current.type !== 'file' || !sameInode(current, staged)) left.push(`${temp} (its owned identity could not be verified)`)
              else await cleanup.unlink(temp, TYPED_HELPER_CALL)
            }
          } catch (error) { left.push(`${temp} (${errorText(error)}; removal is unverified)`) }
        }
      }
      for (const folder of [...made].reverse()) {
        if (!cleanup) { left.push(`${folder.relative} (folder cleanup is unverified)`); continue }
        try {
          const current = await cleanup.lstat(folder.relative, TYPED_HELPER_CALL)
          if (current.type === 'absent') continue
          if (!folder.identity || current.type !== 'folder' || !sameInode(current, folder.identity)) { left.push(`${folder.relative} (its created folder identity could not be verified)`); continue }
          await cleanup.rmdir(folder.relative, TYPED_HELPER_CALL)
        } catch (error) {
          // An empty-folder removal never removes someone else's newly-created content.
          if (errorCode(error) !== 'ENOTEMPTY' && errorCode(error) !== 'EEXIST') left.push(`${folder.relative} (${errorText(error)}; folder removal is unverified)`)
        }
      }
    } finally {
      if (cleanup && cleanup !== writer) await cleanup.close().catch(() => {})
    }
    return left.length ? ` Batshit could not verify cleanup of ${left.join(', ')}.` : ''
  }
  const fail = async (code: TypedFileErrorCode, reason: string, stopped = false): Promise<CommitResult> => {
    const cleanup = await undo()
    return { committed: false, refused: true, code, reason: `${reason}${cleanup}`, outcome: mutationUnknown ? 'unknown' : 'unapplied', ...(stopped ? { stopped: true } : {}) }
  }
  const changedFolder = () => fail('FILE_CHANGED', folderReplaced(target, NOTHING_WRITTEN).reason)
  const created = seen.kind === 'absent'
  const otherHardLinks = seen.kind === 'file' && seen.info.nlink > 1n ? Number(seen.info.nlink - 1n) : 0
  try {
    if (env.abortSignal?.aborted) return fail('STOPPED', `Stopped before anything was written. ${NOTHING_WRITTEN}`, true)
    for (const folder of target.missingFolders) {
      const relative = relativeBeneathRoot(folder, target.realRoot)
      if (!relative) throw new Error('invalid typed folder path')
      const entry = { relative, identity: null as { dev: bigint; ino: bigint } | null }
      made.push(entry)
      let confirmed = false
      try {
        await writer.mkdir(relative, TYPED_HELPER_CALL)
        confirmed = true
        const info = await writer.lstat(relative, TYPED_HELPER_CALL)
        if (info.type !== 'folder') return changedFolder()
        entry.identity = info
      } catch (error) {
        // A missing reply may hide a created folder. Keep its unverified name visible, never
        // adopt a later entry as ours merely because its path matches the pending request.
        if (!confirmed && error instanceof AnchoredWriteError) made.pop()
        if (errorCode(error) !== 'EEXIST') {
          if (writer.failed || !(error instanceof AnchoredWriteError)) mutationUnknown = true
          throw error
        }
        if ((await writer.lstat(relative, TYPED_HELPER_CALL)).type !== 'folder') return changedFolder()
      }
    }
    const parent = await parentIdentity(writer, target)
    await testHook('beforeStage')
    if (env.abortSignal?.aborted) return fail('STOPPED', `Stopped before anything was written. ${NOTHING_WRITTEN}`, true)
    temp = relativeBeneathRoot(path.join(target.realParent, `.${path.basename(target.targetPath)}.batshit-write-${randomBytes(4).toString('hex')}`), target.realRoot)
    if (!temp) throw new Error('invalid typed stage path')
    try {
      staged = await writer.writeFile(temp, options.text, seen.kind === 'file' ? { create: 'new', mode: seen.info.mode & 0o777, exactMode: true } : { create: 'new' }, TYPED_HELPER_CALL)
      stageMayExist = true
    } catch (error) {
      stageMayExist = !refusedBeforeCreate(error)
      if (stageMayExist) {
        mutationUnknown = writer.failed || !(error instanceof AnchoredWriteError)
        unverifiedStage = !mutationUnknown
      }
      throw error
    }
    await testHook('afterTempOpen')
    await testHook('beforeCommit')
    if (!sameInode(parent, await parentIdentity(writer, target))) return changedFolder()
    const stagedNow = await writer.lstat(temp, TYPED_HELPER_CALL)
    if (stagedNow.type !== 'file' || !sameIdentity(identityOf(stagedNow), identityOf(staged))) return changedFolder()
    const leafNow = await writer.lstat(target.relativePath, TYPED_HELPER_CALL)
    if (seen.kind === 'absent' && leafNow.type !== 'absent') return fail('FILE_CHANGED', `A file appeared at ${target.displayPath} while this call ran. ${NOTHING_WRITTEN}`)
    if (seen.kind === 'file' && (leafNow.type !== 'file' || !sameWriteIdentity(leafNow, seen.info))) return fail('FILE_CHANGED', `${target.displayPath} changed on disk after this call read it (another program or another call wrote it). Read it again. ${NOTHING_WRITTEN}`)
    if (seen.kind === 'file') {
      const writableNow = await writer.probeWritable(target.relativePath, TYPED_HELPER_CALL)
      if (!sameWriteIdentity(writableNow, seen.info)) return fail('FILE_CHANGED', `${target.displayPath} changed on disk after this call read it (another program or another call wrote it). Read it again. ${NOTHING_WRITTEN}`)
    }
    // These mutations are bounded without the Stop signal: an aborted rename cannot invent a
    // known failure. The explicit Stop check and committing report remain one synchronous step.
    if (env.abortSignal?.aborted) return fail('STOPPED', `Stopped before anything was written. ${NOTHING_WRITTEN}`, true)
    env.onProgress?.(options.committingFacts)
    try { await writer.rename(temp, target.relativePath, TYPED_HELPER_CALL) }
    catch (error) { if (writer.failed || !(error instanceof AnchoredWriteError)) mutationUnknown = true; throw error }
  } catch (error) {
    if (unverifiedStage) return fail('IO_ERROR', `The target was not replaced. A temporary file may remain at ${temp}; Batshit could not verify ownership, so it kept that entry. ${errorText(error)}.`)
    if (mutationUnknown) return fail('IO_ERROR', `Could not verify the result of writing ${target.displayPath}: ${errorText(error)}. Its write outcome is unknown; read it again before retrying.`)
    if (['ELOOP', 'EXDEV', 'ENOTDIR'].includes(errorCode(error) ?? '')) return changedFolder()
    if (['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')) return fail('POLICY_BLOCKED', `${target.displayPath} is read-only for Batshit; it does not replace a file it may not write. ${NOTHING_WRITTEN}`)
    return fail('IO_ERROR', `Could not write ${target.displayPath}: ${errorText(error)}. ${NOTHING_WRITTEN}`)
  }
  // A confirmed rename is applied, reported synchronously before any later await or test hook.
  try { env.onProgress?.(options.appliedFacts(created, otherHardLinks)) } catch {}
  try { await testHook('afterCommit') } catch {}
  return { committed: true, created, otherHardLinks }
}

// ---------------------------------------------------------------------------------------------
// The three tools

function failure(
  tool: TypedFileToolName,
  rawPath: string,
  code: TypedFileErrorCode,
  reason: string,
  extra: Record<string, unknown> = {}
): TypedFileToolResult {
  return {
    success: false,
    tool,
    path: rawPath,
    ...(code === 'POLICY_BLOCKED' ? { blocked: true } : {}),
    ...(code === 'STOPPED' ? { stopped: true } : {}),
    errorCode: code,
    reason,
    error: reason,
    ...extra
  }
}

function unappliedBlock(tool: TypedFileToolName): Record<string, unknown> {
  if (tool === TYPED_WRITE_FILE_TOOL) return { typedFileWrite: { v: 1, outcome: 'unapplied' } satisfies TypedFileChangeFacts }
  if (tool === TYPED_EDIT_FILE_TOOL) return { typedFileEdit: { v: 1, outcome: 'unapplied' } satisfies TypedFileChangeFacts }
  return {}
}

function neverAllowRefusal(env: TypedFileEnvironment, tool: TypedFileToolName, rawPath: string): TypedFileToolResult | null {
  const denied = typedFileNeverAllowEntry(env.neverAllowList, tool)
  if (!denied) return null
  const reason =
    tool === TYPED_READ_FILE_TOOL
      ? `Blocked by your bash Never Allow list: the entry "${denied.entry}" names read_file. ${NOTHING_READ}`
      : `Blocked by your bash Never Allow list: the entry "${denied.entry}" names ${denied.name}, which also covers write_file and edit_file. ${NOTHING_WRITTEN}`
  return failure(tool, rawPath, 'POLICY_BLOCKED', reason, unappliedBlock(tool))
}

/** `read_file`: whole lines of a UTF-8 text file inside the workspace, with the range and total. */
export async function typedReadFile(
  input: { path: string; offset?: number; limit?: number },
  env: TypedFileEnvironment
): Promise<TypedFileToolResult> {
  const tool = TYPED_READ_FILE_TOOL
  const rawPath = typeof input?.path === 'string' ? input.path : ''
  const denied = neverAllowRefusal(env, tool, rawPath)
  if (denied) return denied
  const target = await resolveTypedFileTarget(rawPath, env, NOTHING_READ)
  if ('refused' in target) return failure(tool, rawPath, target.code, target.reason)
  await testHook('afterResolve')
  const writer = await admitTypedWriter(target, env, NOTHING_READ)
  if ('refused' in writer) return failure(tool, rawPath, writer.code, writer.reason, writer.code === 'STOPPED' ? { stopped: true } : {})
  try {
    const leaf = await inspectLeaf(writer, target, NOTHING_READ, env)
    if ('refused' in leaf) return failure(tool, rawPath, leaf.code, leaf.reason, { filePath: target.displayPath })
    if (leaf.kind === 'absent') return failure(tool, rawPath, 'NOT_FOUND', `No file at ${target.displayPath}. ${NOTHING_READ}`, { filePath: target.displayPath })
    const bytes = await readCheckedBytes(writer, target, leaf.info, NOTHING_READ, env)
    if ('refused' in bytes) return failure(tool, rawPath, bytes.code, bytes.reason, { filePath: target.displayPath })
    const text = decodeText(bytes)
    if (text === null) {
      return failure(tool, rawPath, 'INVALID_INPUT', `${target.displayPath} is not UTF-8 text; read_file reads text only. ${NOTHING_READ}`, { filePath: target.displayPath })
    }
    const slice = sliceTypedRead(text, input.offset, input.limit)
    const fileReadProof = await typedReadProof(env, target, input, text, slice, writer.rootIdentity!)
    return {
      ...typedReadResult(input, target.displayPath, text, bytes.length, slice),
      ...(fileReadProof ? { fileReadProof } : {})
    }
  } finally { await writer.close().catch(() => {}) }
}

/**
 * The `read_file` result for a file's bytes, with no file access, or null where `read_file`
 * refuses those bytes (over its size limit, a NUL byte, invalid UTF-8; a byte-order mark is kept).
 * SA-137's live file reads rebuild a refreshed typed copy with it, so a refreshed copy has exactly
 * the shape and model text the tool returned and makes no decoding choice of its own; the proof is
 * the read's own and is not part of it.
 */
export function typedReadResultFromBytes(
  input: { path: string; offset?: number; limit?: number },
  filePath: string,
  bytes: Buffer
): TypedFileToolResult | null {
  if (bytes.length > TYPED_FILE_MAX_BYTES) return null
  const text = decodeText(bytes)
  return text === null ? null : typedReadResult(input, filePath, text, bytes.length)
}

/** A successful `read_file` result from the call's input, display path, text and size in bytes. */
function typedReadResult(
  input: { path: string; offset?: number; limit?: number },
  filePath: string,
  text: string,
  byteLength: number,
  slice: TypedReadSlice = sliceTypedRead(text, input.offset, input.limit)
): TypedFileToolResult {
  const shownLines = slice.endLine >= slice.startLine && slice.startLine > 0 ? slice.endLine - slice.startLine + 1 : 0
  const facts: TypedFileReadFacts = {
    v: 1,
    startLine: slice.startLine,
    endLine: slice.endLine,
    totalLines: slice.totalLines,
    whole: slice.empty || (slice.startLine === 1 && slice.endLine === slice.totalLines && !slice.truncated),
    truncated: slice.truncated,
    empty: slice.empty,
    bytes: byteLength,
    lineEnding: lineEndingOf(text)
  }
  return {
    success: true,
    tool: TYPED_READ_FILE_TOOL,
    path: typeof input?.path === 'string' ? input.path : '',
    filePath,
    content: slice.content,
    lineCount: shownLines,
    ...(slice.partialLine ? { partialLine: true } : {}),
    typedFileRead: facts
  }
}

/**
 * SA-136 P2b: the sealed proof of what one typed read showed (SA-137's `fileReadProof` v1, one
 * read, part null), for the zip adapter's `fileReadSource`: the range ASKED for as a `typed` view,
 * made only for a read that shows lines uncut (or an empty file), and only when the view shows
 * exactly what was returned. The file was read through a handle checked against its path, so the
 * bytes behind the proof are the bytes returned; nothing is read again.
 */
async function typedReadProof(
  env: TypedFileEnvironment,
  target: TypedFileTarget,
  input: { offset?: number; limit?: number },
  text: string,
  slice: ReturnType<typeof sliceTypedRead>,
  rootIdentity: string
): Promise<FileReadProof | undefined> {
  const owner = env.readProofOwner
  const backend = env.commandBackend
  if (!owner || (backend !== 'local' && backend !== 'apple_container' && backend !== 'docker_sandbox')) return undefined
  if (slice.truncated || slice.partialLine || (!slice.empty && slice.endLine < slice.startLine)) return undefined
  const startLine = input.offset && input.offset > 0 ? input.offset : 1
  const view: FileReadView = { kind: 'typed', startLine, endLine: input.limit && input.limit > 0 ? startLine + input.limit - 1 : null }
  if (emulateFileReadView(view, text) !== slice.content) return undefined
  const realRoot = target.realRoot
  const locator = path.relative(realRoot, target.targetPath).split(path.sep).join('/')
  if (!isFileReadLocator(locator)) return undefined
  return sealFileReadProof({
    version: FILE_READ_SOURCE_VERSION,
    ...owner,
    backend,
    workspaceRoot: realRoot,
    rootIdentity,
    cwd: target.realCwd,
    reads: [{ part: null, file: target.displayPath, locator, view }],
    liveReadsOn: env.liveReadsOn === true
  })
}

/** `write_file`: create or replace a whole UTF-8 text file inside the workspace, in one step. */
export async function typedWriteFile(
  input: { path: string; content: string },
  env: TypedFileEnvironment
): Promise<TypedFileToolResult> {
  const tool = TYPED_WRITE_FILE_TOOL
  const rawPath = typeof input?.path === 'string' ? input.path : ''
  const content = typeof input?.content === 'string' ? input.content : null
  const unapplied = unappliedBlock(tool)
  if (content === null) return failure(tool, rawPath, 'INVALID_INPUT', `content must be text. ${NOTHING_WRITTEN}`, unapplied)
  if (content.length > TYPED_WRITE_MAX_CHARS) {
    return failure(
      tool,
      rawPath,
      'INVALID_INPUT',
      `content is ${content.length.toLocaleString('en-US')} characters; the limit is ${TYPED_WRITE_MAX_CHARS.toLocaleString('en-US')} per call. Write the first part, then add the rest with edit_file. ${NOTHING_WRITTEN}`,
      unapplied
    )
  }
  const denied = neverAllowRefusal(env, tool, rawPath)
  if (denied) return denied
  const prepared = await prepareChange(tool, rawPath, env)
  if ('result' in prepared) return prepared.result
  const { target, leaf, writer } = prepared
  try {

    const totalLines = countTextLines(content)
    const bytes = Buffer.byteLength(content, 'utf8')
    const lineEnding = lineEndingOf(content)
    const block = (outcome: TypedFileOutcome, extra: Partial<TypedFileChangeFacts> = {}): TypedFileChangeFacts => ({
      v: 1,
      outcome,
      totalLines,
      bytes,
      lineEnding,
      ...extra
    })
    if (env.abortSignal?.aborted) {
      return failure(tool, rawPath, 'STOPPED', `Stopped before anything was written. ${NOTHING_WRITTEN}`, { filePath: target.displayPath, stopped: true, ...unapplied })
    }
    const commit = await commitTypedFileWrite({
      writer,
      target,
      seen: leaf,
      text: content,
      env,
      committingFacts: { tool, path: rawPath, filePath: target.displayPath, typedFileWrite: block('unknown', { stage: 'committing' }) },
      appliedFacts: (created, otherHardLinks) => ({
        tool,
        path: rawPath,
        filePath: target.displayPath,
        typedFileWrite: block('applied', { created, ...(otherHardLinks ? { otherHardLinks } : {}) })
      })
    })
    if (!commit.committed) {
      return failure(tool, rawPath, commit.code, commit.reason, {
        filePath: target.displayPath,
        ...(commit.stopped ? { stopped: true } : {}),
        ...(commit.outcome === 'unknown' ? { typedFileWrite: block('unknown') } : unapplied)
      })
    }
    return {
      success: true,
      tool,
      path: rawPath,
      filePath: target.displayPath,
      lineCount: totalLines,
      typedFileWrite: block('applied', { created: commit.created, ...(commit.otherHardLinks ? { otherHardLinks: commit.otherHardLinks } : {}) })
    }
  } finally { await writer.close().catch(() => {}) }
}

/** `edit_file`: exact-once replacements in an existing UTF-8 text file, all or nothing, in one step. */
export async function typedEditFile(
  input: { path: string; edits: TypedFileEdit[] },
  env: TypedFileEnvironment
): Promise<TypedFileToolResult> {
  const tool = TYPED_EDIT_FILE_TOOL
  const rawPath = typeof input?.path === 'string' ? input.path : ''
  const edits = Array.isArray(input?.edits) ? input.edits : []
  const unapplied = unappliedBlock(tool)
  if (edits.length === 0) return failure(tool, rawPath, 'INVALID_INPUT', `edits must name at least one change. ${NOTHING_WRITTEN}`, unapplied)
  if (edits.length > TYPED_EDIT_MAX_EDITS) {
    return failure(tool, rawPath, 'INVALID_INPUT', `${edits.length} edits in one call; the limit is ${TYPED_EDIT_MAX_EDITS}. ${NOTHING_WRITTEN}`, unapplied)
  }
  if (edits.some((edit) => typeof edit?.oldText !== 'string' || typeof edit?.newText !== 'string')) {
    return failure(tool, rawPath, 'INVALID_INPUT', `Every edit needs oldText and newText as text. ${NOTHING_WRITTEN}`, unapplied)
  }
  const size = edits.reduce((total, edit) => total + edit.oldText.length + edit.newText.length, 0)
  if (size > TYPED_EDIT_MAX_CHARS) {
    return failure(
      tool,
      rawPath,
      'INVALID_INPUT',
      `The edits hold ${size.toLocaleString('en-US')} characters; the limit is ${TYPED_EDIT_MAX_CHARS.toLocaleString('en-US')} per call. Split them over more calls. ${NOTHING_WRITTEN}`,
      unapplied
    )
  }
  const denied = neverAllowRefusal(env, tool, rawPath)
  if (denied) return denied
  const prepared = await prepareChange(tool, rawPath, env)
  if ('result' in prepared) return prepared.result
  const { target, leaf, writer } = prepared
  try {
    if (leaf.kind === 'absent') {
      return failure(tool, rawPath, 'NOT_FOUND', `No file at ${target.displayPath}; edit_file changes an existing file. To create it, use write_file. ${NOTHING_WRITTEN}`, {
        filePath: target.displayPath,
        ...unapplied
      })
    }
    const bytes = await readCheckedBytes(writer, target, leaf.info, NOTHING_WRITTEN, env)
    if ('refused' in bytes) return failure(tool, rawPath, bytes.code, bytes.reason, { filePath: target.displayPath, ...unapplied })
    const original = decodeText(bytes)
    if (original === null) {
      return failure(tool, rawPath, 'INVALID_INPUT', `${target.displayPath} is not UTF-8 text; edit_file changes text only. ${NOTHING_WRITTEN}`, {
        filePath: target.displayPath,
        ...unapplied
      })
    }
    const edited = applyTypedEdits(original, edits, target.displayPath)
    if (!edited.ok) return failure(tool, rawPath, 'INVALID_INPUT', edited.reason, { filePath: target.displayPath, ...unapplied })

    const totalLines = countTextLines(edited.text)
    const block = (outcome: TypedFileOutcome, extra: Partial<TypedFileChangeFacts> = {}): TypedFileChangeFacts => ({
      v: 1,
      outcome,
      editsApplied: edits.length,
      totalLines,
      bytes: Buffer.byteLength(edited.text, 'utf8'),
      lineEnding: lineEndingOf(edited.text),
      ...extra
    })
    const diff = buildSnapshotEditPreview({ filePath: target.displayPath, before: original, after: edited.text })
    if (env.abortSignal?.aborted) {
      return failure(tool, rawPath, 'STOPPED', `Stopped before anything was written. ${NOTHING_WRITTEN}`, { filePath: target.displayPath, stopped: true, ...unapplied })
    }
    const commit = await commitTypedFileWrite({
      writer,
      target,
      seen: leaf,
      text: edited.text,
      env,
      committingFacts: { tool, path: rawPath, filePath: target.displayPath, typedFileEdit: block('unknown', { stage: 'committing' }) },
      appliedFacts: (_created, otherHardLinks) => ({
        tool,
        path: rawPath,
        filePath: target.displayPath,
        ...(diff ? { diff } : {}),
        typedFileEdit: block('applied', otherHardLinks ? { otherHardLinks } : {})
      })
    })
    if (!commit.committed) {
      return failure(tool, rawPath, commit.code, commit.reason, {
        filePath: target.displayPath,
        ...(commit.stopped ? { stopped: true } : {}),
        ...(commit.outcome === 'unknown' ? { typedFileEdit: block('unknown') } : unapplied)
      })
    }
    return {
      success: true,
      tool,
      path: rawPath,
      filePath: target.displayPath,
      ...(diff ? { diff } : {}),
      typedFileEdit: block('applied', commit.otherHardLinks ? { otherHardLinks: commit.otherHardLinks } : {})
    }
  } finally { await writer.close().catch(() => {}) }
}

/** The checks a write and an edit share, in order: Plan mode, the path, protected targets, the file. */
async function prepareChange(
  tool: TypedFileToolName,
  rawPath: string,
  env: TypedFileEnvironment
): Promise<{ result: TypedFileToolResult } | { target: TypedFileTarget; writer: AnchoredProjectWriter; leaf: { kind: 'absent' } | { kind: 'file'; info: AnchoredEntryStat } }> {
  const unapplied = unappliedBlock(tool)
  const target = await resolveTypedFileTarget(rawPath, env, NOTHING_WRITTEN)
  if ('refused' in target) return { result: failure(tool, rawPath, target.code, target.reason, unapplied) }
  await testHook('afterResolve')
  if (env.accessMode === 'plan' && !/\.md$/i.test(target.targetPath)) {
    return {
      result: failure(
        tool,
        rawPath,
        'POLICY_BLOCKED',
        `Plan mode allows write_file and edit_file only on Markdown (.md) files. Blocked: ${target.displayPath}. ${NOTHING_WRITTEN}`,
        { filePath: target.displayPath, ...unapplied }
      )
    }
  }
  const protectedReason = env.protectedWriteReason?.(target.targetPath) ?? null
  if (protectedReason) {
    return { result: failure(tool, rawPath, 'POLICY_BLOCKED', `${protectedReason.replace(/\s+$/, '')} ${NOTHING_WRITTEN}`, { filePath: target.displayPath, ...unapplied }) }
  }
  const writer = await admitTypedWriter(target, env, NOTHING_WRITTEN)
  if ('refused' in writer) return { result: failure(tool, rawPath, writer.code, writer.reason, { ...unapplied, ...(writer.code === 'STOPPED' ? { stopped: true } : {}) }) }
  let keep = false
  try {
    const leaf = await inspectLeaf(writer, target, NOTHING_WRITTEN, env)
    if ('refused' in leaf) return { result: failure(tool, rawPath, leaf.code, leaf.reason, { filePath: target.displayPath, ...unapplied }) }
    // Opening without truncate/create tests the kernel's actual permissions (including ACLs),
    // through the admitted root, before a rename could replace a file we may not write.
    if (leaf.kind === 'file') {
      try {
        const writable = await writer.probeWritable(target.relativePath, readCall(env))
        if (!sameIdentity(identityOf(writable), identityOf(leaf.info))) return { result: failure(tool, rawPath, 'FILE_CHANGED', `${target.displayPath} changed while this call checked it. ${NOTHING_WRITTEN}`, { filePath: target.displayPath, ...unapplied }) }
      } catch (error) {
        const denied = ['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')
        return { result: failure(tool, rawPath, denied ? 'POLICY_BLOCKED' : 'IO_ERROR', denied
          ? `${target.displayPath} is read-only for Batshit; it does not replace a file it may not write. ${NOTHING_WRITTEN}`
          : `Could not check write permission for ${target.displayPath}: ${errorText(error)}. ${NOTHING_WRITTEN}`, { filePath: target.displayPath, ...unapplied }) }
      }
    }
    keep = true
    return { target, leaf, writer }
  } finally { if (!keep) await writer.close().catch(() => {}) }
}

// ---------------------------------------------------------------------------------------------
// What the model reads back

const count = (value: number) => value.toLocaleString('en-US')

const hardLinkNote = (others: number | undefined) =>
  others ? ` It had ${others} other hard link${others === 1 ? ', which keeps' : 's, which keep'} the old text.` : ''

/** The lean text a typed file tool's result gives the model (the stored result keeps every field). */
export function formatTypedFileResultForModel(result: TypedFileToolResult): string {
  const shown = typeof result.filePath === 'string' ? result.filePath : result.path
  if (!result.success) return `${result.tool}: ${result.reason ?? 'the call failed.'}`

  if (result.tool === TYPED_READ_FILE_TOOL) {
    const facts = result.typedFileRead as TypedFileReadFacts
    let range: string
    if (facts.empty) range = 'empty file'
    else if (facts.endLine < facts.startLine) range = `no lines: the file has ${count(facts.totalLines)} lines`
    else if (result.partialLine) {
      range = `line ${count(facts.startLine)} of ${count(facts.totalLines)} is longer than ${count(TYPED_READ_MAX_CHARS)} characters; only its start is shown; read the rest of that line with Bash`
    } else {
      range = `lines ${count(facts.startLine)}–${count(facts.endLine)} of ${count(facts.totalLines)}`
      if (facts.truncated) range += `; cut at ${count(TYPED_READ_MAX_CHARS)} characters, read on with offset=${facts.endLine + 1}`
    }
    return `read_file: ${shown} (${range})\n${result.content ?? ''}`
  }

  if (result.tool === TYPED_WRITE_FILE_TOOL) {
    const facts = result.typedFileWrite as TypedFileChangeFacts
    const links = hardLinkNote(facts.otherHardLinks)
    const lines = facts.totalLines ?? 0
    return `write_file: wrote ${shown} (${facts.created ? 'created' : 'replaced'}; ${count(lines)} line${lines === 1 ? '' : 's'}, ${count(facts.bytes ?? 0)} bytes).${links}`
  }

  const facts = result.typedFileEdit as TypedFileChangeFacts
  const applied = facts.editsApplied ?? 0
  const links = hardLinkNote(facts.otherHardLinks)
  // Only the immediate model reply is concise; the result and its saved/UI/Zip diff stay rich.
  return `edit_file: ${shown}: ${applied} edit${applied === 1 ? '' : 's'} applied; it has ${count(facts.totalLines ?? 0)} lines now.${links}`
}

// ---------------------------------------------------------------------------------------------
// The AI SDK tools

export interface TypedFileToolsOptions {
  accessMode: TypedFileAccessMode
  /**
   * The call's environment, resolved for each call by the caller (`buildMode3NativeTools`): the
   * workspace, the saved policy, the Stop and the progress report of THIS call (`options` are the
   * AI SDK's execution options, with its `toolCallId` and `abortSignal`).
   */
  resolveEnvironment: (options: unknown) => Promise<TypedFileEnvironment | { blocked: true; reason: string }>
  /** This turn runs Refreshed File Reads (the compile's own answer, `refreshedFileReadsTurn`). */
  refreshedFileReadsTurn?: boolean
}

/** `read_file`, `write_file` and `edit_file` for the API lane's tool list. */
export function buildTypedFileTools(options: TypedFileToolsOptions): Record<TypedFileToolName, any> {
  const planSentence = options.accessMode === 'plan' ? PLAN_MODE_WRITE_SENTENCE : ''
  const run = async <Input extends { path: string }>(
    tool: TypedFileToolName,
    input: Input,
    executionOptions: unknown,
    execute: (input: Input, env: TypedFileEnvironment) => Promise<TypedFileToolResult>
  ): Promise<TypedFileToolResult> => {
    const env = await options.resolveEnvironment(executionOptions)
    if ('blocked' in env) {
      const done = tool === TYPED_READ_FILE_TOOL ? NOTHING_READ : NOTHING_WRITTEN
      return failure(tool, typeof input?.path === 'string' ? input.path : '', 'POLICY_BLOCKED', `${env.reason.replace(/\s+$/, '')} ${done}`, unappliedBlock(tool))
    }
    return execute(input, env)
  }
  const toModelOutput = async ({ output }: { output: unknown }) => ({
    type: 'text' as const,
    value:
      output && typeof output === 'object' && typeof (output as any).tool === 'string'
        ? formatTypedFileResultForModel(output as TypedFileToolResult)
        : JSON.stringify(output ?? null)
  })
  return {
    read_file: Object.assign(tool({
      description: TYPED_READ_FILE_DESCRIPTION,
      inputSchema: TYPED_READ_FILE_INPUT_SCHEMA,
      execute: async (input, executionOptions) => run(TYPED_READ_FILE_TOOL, input, executionOptions, typedReadFile),
      toModelOutput
    }), { [TYPED_READ_FILE_MARKER]: true as const }),
    write_file: tool({
      description: TYPED_WRITE_FILE_DESCRIPTION + planSentence,
      inputSchema: TYPED_WRITE_FILE_INPUT_SCHEMA,
      execute: async (input, executionOptions) => run(TYPED_WRITE_FILE_TOOL, input, executionOptions, typedWriteFile),
      toModelOutput
    }),
    edit_file: tool({
      description: (options.refreshedFileReadsTurn === true ? TYPED_EDIT_FILE_DESCRIPTION_REFRESHED : TYPED_EDIT_FILE_DESCRIPTION) + planSentence,
      inputSchema: TYPED_EDIT_FILE_INPUT_SCHEMA,
      execute: async (input, executionOptions) => run(TYPED_EDIT_FILE_TOOL, input, executionOptions, typedEditFile),
      toModelOutput
    })
  }
}

// ---------------------------------------------------------------------------------------------
// The grant (`typed_file_tools`, SA-136 D1): one owner the browser shares (`typedFileToolsGrant.ts`)

export {
  TYPED_FILE_TOOLS_FACTORY_DEFAULT,
  readTypedFileToolsValue,
  agentTypedFileToolsValue,
  globalTypedFileToolsValue,
  resolveTypedFileToolsGrant
} from '$lib/utils/typedFileToolsGrant'
