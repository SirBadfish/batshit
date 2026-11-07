import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hasFileReadProofShape, type FileReadProof } from '$lib/utils/fileReadSource'

/**
 * SA-137: the seal that makes a Bash read proof (`fileReadProof`) the only source of a
 * `fileReadSource` descriptor. The native Bash tool seals the proof it built in this process; the
 * zip adapter writes a descriptor only from a proof whose seal verifies. A tool result that
 * arrives any other way (a tab's `POST /api/sse` tool event, BL-2002; a stored or replayed
 * result) carries no valid seal, so it can never mint one.
 *
 * The key is random, made once per app process and never stored, logged or sent. Its lifetime is
 * the process: the Bash run and the zip write happen in the same app process (the reply's live
 * stream or its finish), so a proof is checked by the process that sealed it. After a restart every older proof fails to verify, and
 * its read is stored as an ordinary static copy (nothing is lost but the refresh).
 */
const PROCESS_KEY = randomBytes(32)

/** JSON with sorted keys at every level (as JSON itself: an undefined field is left out, an undefined item is null). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The MAC of a value without its top-level seal, in its own domain (a proof never verifies as a replay). */
function mac(domain: 'file-read-proof' | 'live-file-read-replay', value: Record<string, unknown>): Buffer {
  const { seal: _seal, ...fields } = value
  return createHmac('sha256', PROCESS_KEY).update(`${domain}\u0000${canonical(fields)}`).digest()
}

function sealMatches(domain: 'file-read-proof' | 'live-file-read-replay', value: Record<string, unknown>): boolean {
  const seal = value.seal
  if (typeof seal !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(seal)) return false
  const expected = mac(domain, value)
  const given = Buffer.from(seal, 'base64url')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * SA-137 (D7): the paused record's live-file-read replay is sealed the same way, so a replay this
 * process did not write (a copy written back by another writer, a restored or older record) is
 * never used. After a restart a paused reply's replay no longer verifies either; its resume then
 * runs without live reads and reads nothing (P2 settle, Faye: an unverifiable seal resumes static).
 */
export function sealLiveFileReadReplay<T extends Record<string, unknown>>(replay: T): T & { seal: string } {
  return { ...replay, seal: mac('live-file-read-replay', replay).toString('base64url') }
}

/** Callers check the replay's shape and size first (`readLiveFileReadReplay`). */
export function verifyLiveFileReadReplaySeal(replay: Record<string, unknown>): boolean {
  return sealMatches('live-file-read-replay', replay)
}

export function sealFileReadProof(proof: Omit<FileReadProof, 'seal'>): FileReadProof {
  return { ...proof, seal: mac('file-read-proof', proof as Record<string, unknown>).toString('base64url') }
}

/** Whether `value` is a proof this process sealed, unchanged since. */
export function verifyFileReadProofSeal(value: unknown): boolean {
  if (!hasFileReadProofShape(value)) return false
  return sealMatches('file-read-proof', value as Record<string, unknown>)
}
