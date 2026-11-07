import { stat } from 'node:fs/promises'
import { AnchoredProjectReader, AnchoredReaderCleanupError, type ReaderCall } from './anchoredProjectReader'
import { resolveBashWorkspaceRoot } from './bashWorkspaceRoot'
import { readTypedFileToolsHost } from './typedFileToolsHost.server'
import type { FileReadSource } from '$lib/utils/fileReadSource'

/**
 * SA-137 (live file reads), the read half: admit the current workspace root for one API Primary
 * turn, then read the files its open Read File copies name, once, through the installed anchored
 * reader (`anchoredProjectReader.ts`: confined to the root, no links, regular files only, the file
 * unchanged across its read). P2's compile freezes what this returns into one snapshot per turn.
 *
 * Every file the turn cannot refresh comes back `static` with its reason, and its copy keeps
 * today's text and rules. Two things are never static: a Stop (the turn sends nothing, no model
 * call; `LiveFileReadStoppedError`) and a reader whose end Batshit cannot confirm
 * (`LiveFileReadCleanupError`, which fails the turn's setup and keeps its permit taken). There is
 * no other way to read a file here: no host `readFile`, no other backend, no retry.
 */

/** Why a copy stays as printed this turn. */
export type LiveReadStaticReason =
  | 'unsupported-platform'
  | 'backend-not-local'
  /** The original read ran on a backend whose stored copies cannot refresh. */
  | 'source-backend-not-local'
  | 'root-unavailable'
  | 'root-changed'
  | 'other-actor'
  /** Another member's copy whose reader no longer exists or no longer shares it here (R2-4). */
  | 'reader-gone'
  | 'reader-busy'
  | 'reader-unavailable'
  | 'deadline'
  | 'not-readable'
  | 'not-regular-or-too-large'
  | 'changed-during-read'
  | 'not-bounded-text'
  | 'read-error'

export type LiveReadOutcome = { status: 'read'; text: string } | { status: 'static'; reason: LiveReadStaticReason }

/** The root this turn may read from, admitted now, never taken from a stored record. */
export interface LiveReadAdmission {
  userId: string
  agentId: string
  sessionId: string
  root: string
  rootIdentity: string
}

/** The text envelope a refreshed copy may hold: the split's 480,000 bytes and a run's 120,000 characters. */
export const LIVE_READ_MAX_CHARS = 120_000
/** The whole read phase of one turn, opening the reader included (a proposal to qualify, SA-137 D5). */
export const LIVE_READ_PHASE_MS = 1_000
/** One file's read, within what is left of the phase. */
export const LIVE_READ_FILE_MS = 100
/** Reader owners across overlapping turns; a third turn gets `reader-busy` at once. */
export const LIVE_READ_MAX_READERS = 2

export class LiveFileReadStoppedError extends Error {
  readonly code = 'LIVE_FILE_READ_STOPPED'
  constructor() {
    super('The reply was stopped while Batshit read the open files for this turn.')
    this.name = 'LiveFileReadStoppedError'
  }
}

export class LiveFileReadCleanupError extends Error {
  readonly code = 'LIVE_FILE_READ_CLEANUP_UNVERIFIED'
  constructor() {
    super('Batshit could not confirm that the file reader for this turn stopped, so the reply was not sent.')
    this.name = 'LiveFileReadCleanupError'
  }
}

let activeReaders = 0

/** Test-only: the permit count, and a reset between tests. */
export function liveFileReadPermitsInUseForTests(): number {
  return activeReaders
}
export function resetLiveFileReadPermitsForTests(): void {
  activeReaders = 0
}

/** `<dev>:<ino>` of a directory, as the read proof records it. */
async function directoryIdentity(directory: string): Promise<string | null> {
  try {
    const details = await stat(directory, { bigint: true })
    return details.isDirectory() ? `${details.dev}:${details.ino}` : null
  } catch {
    return null
  }
}

/**
 * The backends whose reads see the host's workspace at the same path, so the host's anchored read
 * of a file is what that backend's next read of it shows (Round 2, R2-5/R2-6): `local`, and on a Mac
 * Apple Container (`--volume <root>:<root>`) and Docker Sandbox (`sbx create … <root>`, `--workdir`
 * the same path). The containerized app and Windows are not here.
 */
export function liveReadBackendMountsHostWorkspace(backend: unknown, platform: string = process.platform): boolean {
  if (backend === 'local') return platform === 'darwin' || platform === 'linux'
  return (backend === 'apple_container' || backend === 'docker_sandbox') && platform === 'darwin'
}

/**
 * The current workspace root for this turn, by the Bash tool's own resolver, with the same
 * project path the turn's Bash tool gets (`resolveBashWorkspaceRoot`), on a supported host and a
 * backend that mounts the host workspace. The caller decides the lane (API Primary, setting on,
 * `refreshedFileReadsUnavailableReason`) before asking.
 */
export async function admitLiveFileReads(input: {
  userId: string
  agentId: string
  sessionId: string
  executionBackend: string
  projectPath: string | null
}): Promise<{ admitted: true; admission: LiveReadAdmission } | { admitted: false; reason: LiveReadStaticReason }> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return { admitted: false, reason: 'unsupported-platform' }
  // The app container's workspace mapping is not qualified (Round 2): the route makes no turn there
  // (`refreshedFileReadsUnavailableReason`), and admission refuses again, so a container Local origin
  // is never read before that lane has its own proof.
  if (readTypedFileToolsHost().containerized) return { admitted: false, reason: 'unsupported-platform' }
  if (!liveReadBackendMountsHostWorkspace(input.executionBackend)) return { admitted: false, reason: 'backend-not-local' }
  const resolved = await resolveBashWorkspaceRoot({ userId: input.userId, projectPath: input.projectPath })
  if ('blocked' in resolved) return { admitted: false, reason: 'root-unavailable' }
  const rootIdentity = await directoryIdentity(resolved.workspaceRoot)
  if (!rootIdentity) return { admitted: false, reason: 'root-unavailable' }
  return {
    admitted: true,
    admission: {
      userId: input.userId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      root: resolved.workspaceRoot,
      rootIdentity
    }
  }
}

/**
 * Why one stored read cannot be refreshed under this admission, or null when it may be: the same
 * user and chat read it, on a backend that mounts the host workspace, under the same root, which is
 * still the same directory. Another member's read refreshes only under its original reader, which
 * the caller confirmed still exists and still shares it here (`readerAllowed`, Round 2 R2-4). The
 * record proves continuity; it never grants the read.
 */
export function liveReadSourceRefusal(source: FileReadSource, admission: LiveReadAdmission, readerAllowed = source.owner.agentId === admission.agentId): LiveReadStaticReason | null {
  if (!liveReadBackendMountsHostWorkspace(source.backend)) return 'source-backend-not-local'
  if (source.owner.userId !== admission.userId || source.owner.sessionId !== admission.sessionId) return 'other-actor'
  if (!readerAllowed) return 'reader-gone'
  if (source.workspaceRoot !== admission.root || source.rootIdentity !== admission.rootIdentity) return 'root-changed'
  return null
}

/** The helper's refusal codes (`anchored-project-reader.c`), as reasons. */
function refusalReason(code: string): LiveReadStaticReason {
  switch (code) {
    case 'relative-path':
    case 'confined-open':
      return 'not-readable'
    case 'ordinary-bounded-file':
      return 'not-regular-or-too-large'
    case 'name-changed':
    case 'changed-or-oversize':
    case 'stat-time-range':
      return 'changed-during-read'
    default:
      return 'read-error'
  }
}

/** What the reader exposes to this module (the real one, or a test's). */
export interface LiveReadReader {
  readonly rootIdentity: string | null
  readText(relative: string, maxChars: number, call: ReaderCall, options?: { keepByteOrderMark?: boolean }): Promise<string>
  close(): Promise<void>
}

export type LiveReadReaderOpener = (root: string, call: ReaderCall) => Promise<LiveReadReader>

const openAnchoredReader: LiveReadReaderOpener = (root, call) => AnchoredProjectReader.open(root, call)

/**
 * Reads each locator once, in order, serially, through one reader, inside the phase budget. Callers
 * pass locators of validated descriptors (`readFileReadSource`, `liveReadSourceRefusal`); the helper
 * refuses anything outside the root anyway.
 * Returns one outcome per distinct locator. A Stop throws `LiveFileReadStoppedError` after the
 * reader closed; an unconfirmed close throws `LiveFileReadCleanupError` and keeps the permit.
 */
export async function readLiveFiles(
  admission: LiveReadAdmission,
  locators: readonly string[],
  options: { signal?: AbortSignal; phaseMs?: number; fileMs?: number; openReader?: LiveReadReaderOpener; now?: () => number } = {}
): Promise<Map<string, LiveReadOutcome>> {
  const unique = [...new Set(locators)]
  const outcomes = new Map<string, LiveReadOutcome>()
  const rest = (reason: LiveReadStaticReason) => {
    for (const locator of unique) if (!outcomes.has(locator)) outcomes.set(locator, { status: 'static', reason })
  }
  if (unique.length === 0) return outcomes
  if (options.signal?.aborted) throw new LiveFileReadStoppedError()
  if (activeReaders >= LIVE_READ_MAX_READERS) {
    rest('reader-busy')
    return outcomes
  }
  // The clock is read before the permit is taken, so nothing can throw between taking it and the finally.
  const now = options.now ?? Date.now
  const phaseEnd = now() + (options.phaseMs ?? LIVE_READ_PHASE_MS)
  const fileMs = options.fileMs ?? LIVE_READ_FILE_MS
  activeReaders += 1
  let permitHeld = true
  const open = options.openReader ?? openAnchoredReader
  let reader: LiveReadReader | null = null
  let stopped = false

  try {
    try {
      reader = await open(admission.root, { timeoutMs: Math.max(0, phaseEnd - now()), signal: options.signal })
    } catch (error) {
      if (error instanceof AnchoredReaderCleanupError) {
        permitHeld = false
        throw new LiveFileReadCleanupError()
      }
      if (options.signal?.aborted) {
        stopped = true
        return outcomes
      }
      rest(now() >= phaseEnd ? 'deadline' : 'reader-unavailable')
      return outcomes
    }
    // The helper admitted the directory itself: it must be the root this turn admitted.
    if (reader.rootIdentity !== admission.rootIdentity) {
      rest('root-changed')
      return outcomes
    }

    for (const locator of unique) {
      const remaining = phaseEnd - now()
      if (remaining <= 0) {
        rest('deadline')
        break
      }
      // The helper takes a request of at most 4,100 bytes; a longer locator is this file's own
      // refusal, never the end of the phase.
      if (Buffer.byteLength(locator) + 4 > 4100) {
        outcomes.set(locator, { status: 'static', reason: 'not-readable' })
        continue
      }
      try {
        // A leading byte-order mark stays: the proven read printed it, and a refresh shows what it prints.
        const text = await reader.readText(locator, LIVE_READ_MAX_CHARS, {
          timeoutMs: Math.min(fileMs, remaining),
          signal: options.signal
        }, { keepByteOrderMark: true })
        outcomes.set(locator, { status: 'read', text })
      } catch (error) {
        if (error instanceof AnchoredReaderCleanupError) {
          permitHeld = false
          throw new LiveFileReadCleanupError()
        }
        if (options.signal?.aborted) {
          stopped = true
          break
        }
        const message = error instanceof Error ? error.message : ''
        const refused = /^anchored read refused \(([a-z-]+)\)/.exec(message)
        if (refused) {
          outcomes.set(locator, { status: 'static', reason: refusalReason(refused[1]) })
          continue
        }
        // Thrown after a complete answer: the reader is still good.
        if (message === 'not bounded UTF-8 text' || error instanceof TypeError) {
          outcomes.set(locator, { status: 'static', reason: 'not-bounded-text' })
          continue
        }
        // A deadline or a broken reader ends the phase: no retry, no second reader.
        rest(message === 'anchored project read took too long' ? 'deadline' : 'reader-unavailable')
        break
      }
    }
    return outcomes
  } finally {
    if (reader) {
      try {
        await reader.close()
      } catch {
        // Any close that did not confirm the end keeps the permit taken and fails setup; the
        // finally's own throw replaces a return.
        permitHeld = false
        // eslint-disable-next-line no-unsafe-finally
        throw new LiveFileReadCleanupError()
      }
    }
    if (permitHeld) activeReaders -= 1
    // A Stop that came after the last read, or with the phase already over, still stops the turn;
    // an unconfirmed end (the permit kept) is never hidden behind it.
    // eslint-disable-next-line no-unsafe-finally
    if (permitHeld && (stopped || options.signal?.aborted)) throw new LiveFileReadStoppedError()
  }
}
