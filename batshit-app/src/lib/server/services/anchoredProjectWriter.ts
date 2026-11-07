import { AnchoredHelper, type ReaderCall } from './anchoredProjectReader';

/**
 * BL-2006: the anchored writer, the write-side partner of BL-320's anchored reader. It is the
 * same native helper (`scripts/anchored-project-reader`) in its writer mode: the helper admits
 * the configured root once, as the reader does, and every operation holds the target's parent
 * folder as a descriptor opened beneath that root, following no link and crossing no mount at
 * any component, then acts on the last component relative to it without following it. A folder
 * swapped for a link at any moment can only make an operation fail or land in the folder it
 * held, never outside the root. There is no path-based fallback: where the helper cannot run,
 * nothing is read or written.
 *
 * Paths are relative to the admitted root, with no `.`, `..`, empty or absolute part (the helper
 * refuses them), and never pass through a link: a caller that allows links inside the workspace
 * resolves them while it plans and names the real path here.
 */

export const ANCHORED_WRITE_MAX_BYTES = 64 * 1024 * 1024;
const PATH_CAP = 4096;
const STAT_BYTES = 56;
const KINDS = { lstat: 16, read: 17, write: 18, mkdir: 19, rename: 20, unlink: 21, rmdir: 22, probeWritable: 23 } as const;
const REPLIES = { lstat: 144, read: 145, write: 146, done: 147, probeWritable: 148 } as const;
const TYPES = ['absent', 'file', 'link', 'folder', 'other', 'parent-not-a-folder'] as const;

export type AnchoredEntryType = (typeof TYPES)[number];
export type AnchoredWriterOp = keyof typeof KINDS;
export type AnchoredWriterCall = ReaderCall;

/** One entry, as the helper saw it (`lstat`: the entry itself, never a link's target). */
export interface AnchoredEntryStat {
  type: AnchoredEntryType;
  /** The file mode bits (type and permissions); 0 when absent. */
  mode: number;
  size: bigint;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  nlink: bigint;
}

/**
 * A refusal from the helper. `code` is the errno name (`ENOENT`, `EEXIST`, `ELOOP`, `EXDEV`, ...), or
 * the helper's own reason (`write-input`, `ENOTREG`, `changed-or-oversize`, ...). `stage` says where:
 * `request` or `input` (refused before any system call), `parent` (the folders), `leaf` (the last
 * component, before any byte), a later step (`truncate`, `write`, `chmod`, `fsync`, `fstat`, `close`), or
 * `helper` for a read the helper refused.
 */
export class AnchoredWriteError extends Error {
  readonly code: string;
  readonly stage: string;
  constructor(stage: string, code: string) {
    super(`anchored write refused (${stage}:${code})`);
    this.stage = stage;
    this.code = code;
  }
}

/**
 * Tests only (Vitest): runs before each request reaches the helper, and may throw to stand for a
 * failure. Outside Vitest it cannot be set.
 */
type AnchoredWriterTestHook = (
  op: AnchoredWriterOp,
  paths: readonly string[],
  data: string | Buffer | undefined,
  writer: AnchoredProjectWriter
) => void | Promise<void>;
let testHook: AnchoredWriterTestHook | null = null;
export function __setAnchoredWriterTestHook(hook: AnchoredWriterTestHook | null): void {
  if (process.env.VITEST !== 'true') throw new Error('the anchored writer test hook is for tests only');
  testHook = hook;
}

function pathBytes(relative: string): Buffer {
  const bytes = Buffer.from(relative, 'utf8');
  if (!bytes.length || bytes.length > PATH_CAP || bytes.includes(0)) throw new AnchoredWriteError('request', 'relative-path');
  return bytes;
}

export class AnchoredProjectWriter extends AnchoredHelper {
  private constructor(projectRoot: string) {
    super({
      args: ['--write-v2', projectRoot],
      shutdownName: 'anchored-writer',
      closedNamesReason: true,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      words: {
        stopped: 'anchored project write stopped',
        tooLong: 'anchored project write took too long',
        invalidResponse: 'invalid anchored writer response',
        closed: 'anchored project writer closed',
        released: 'anchored project writer released',
        logTag: '[AnchoredProjectWriter]',
        requestSize: 'invalid anchored writer request size',
        idsExhausted: 'anchored writer request IDs exhausted',
        forced: 'anchored writer required forced termination',
      },
      frameCap: ANCHORED_WRITE_MAX_BYTES + STAT_BYTES,
      requestCap: ANCHORED_WRITE_MAX_BYTES + 12 + PATH_CAP,
      verifiesChildCleanup: false,
    });
  }

  /** Admits `projectRoot` (its target at this first open is the authority, as for the reader). */
  static async open(projectRoot: string, call: AnchoredWriterCall): Promise<AnchoredProjectWriter> {
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('anchored project writes are unavailable on this platform');
    }
    if (call.signal?.aborted) throw new Error('anchored project write stopped');
    return AnchoredHelper.admit(new AnchoredProjectWriter(projectRoot), call);
  }

  protected refusal(body: Buffer): Error {
    const reason = body.toString('utf8').slice(0, 64);
    const split = reason.indexOf(':');
    if (split > 0) return new AnchoredWriteError(reason.slice(0, split), reason.slice(split + 1));
    // A request the helper refused before any system call (`write-input`, `relative-path`, ...).
    const input = reason.endsWith('-input') || reason === 'relative-path';
    return new AnchoredWriteError(input ? 'input' : 'helper', reason);
  }

  private parseStat(bytes: Buffer): AnchoredEntryStat {
    const type = TYPES[bytes[0]];
    if (bytes.length < STAT_BYTES || !type || bytes[1] || bytes[2] || bytes[3]) {
      this.protocolFailure();
      throw new Error('invalid anchored writer stat');
    }
    return {
      type,
      mode: bytes.readUInt32BE(4),
      size: bytes.readBigUInt64BE(8),
      dev: bytes.readBigUInt64BE(16),
      ino: bytes.readBigUInt64BE(24),
      ctimeNs: bytes.readBigUInt64BE(32),
      mtimeNs: bytes.readBigUInt64BE(40),
      nlink: bytes.readBigUInt64BE(48),
    };
  }

  private async done(op: 'mkdir' | 'unlink' | 'rmdir', relative: string, call: AnchoredWriterCall): Promise<void> {
    await testHook?.(op, [relative], undefined, this);
    const reply = await this.request(KINDS[op], REPLIES.done, pathBytes(relative), call);
    if (reply.length) { this.protocolFailure(); throw new Error('invalid anchored writer reply'); }
  }

  /** The entry at `relative` itself (a link is reported as a link). Absent is an answer, not an error. */
  async lstat(relative: string, call: AnchoredWriterCall): Promise<AnchoredEntryStat> {
    await testHook?.('lstat', [relative], undefined, this);
    const reply = await this.request(KINDS.lstat, REPLIES.lstat, pathBytes(relative), call);
    if (reply.length !== STAT_BYTES) { this.protocolFailure(); throw new Error('invalid anchored writer stat'); }
    return this.parseStat(reply);
  }

  /**
   * Checks the kernel's write permission on an existing regular file without creating, truncating,
   * writing or changing its mode. Returns the identity of the file opened, checked against the
   * entry at its name. The precheck refuses links/non-files; a raced device may open once
   * nonblocking before refusal, with no bytes, creation or truncation.
   */
  async probeWritable(relative: string, call: AnchoredWriterCall): Promise<AnchoredEntryStat> {
    await testHook?.('probeWritable', [relative], undefined, this);
    const reply = await this.request(KINDS.probeWritable, REPLIES.probeWritable, pathBytes(relative), call);
    if (reply.length !== STAT_BYTES) { this.protocolFailure(); throw new Error('invalid anchored writer stat'); }
    const stat = this.parseStat(reply);
    if (stat.type !== 'file') { this.protocolFailure(); throw new Error('invalid anchored writable probe'); }
    return stat;
  }

  /**
   * A regular file's bytes and the stat of the file read; refused (`changed-or-oversize`) when the
   * file changed while it was read or is over `maxBytes`.
   */
  async readFile(relative: string, maxBytes: number, call: AnchoredWriterCall): Promise<{ stat: AnchoredEntryStat; bytes: Buffer }> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > ANCHORED_WRITE_MAX_BYTES) throw new Error('invalid anchored read limit');
    await testHook?.('read', [relative], undefined, this);
    const name = pathBytes(relative);
    const body = Buffer.alloc(4 + name.length);
    body.writeUInt32BE(maxBytes);
    name.copy(body, 4);
    const reply = await this.request(KINDS.read, REPLIES.read, body, call);
    if (reply.length < STAT_BYTES) { this.protocolFailure(); throw new Error('invalid anchored writer read'); }
    const stat = this.parseStat(reply.subarray(0, STAT_BYTES));
    const bytes = Buffer.from(reply.subarray(STAT_BYTES));
    if (stat.type !== 'file' || BigInt(bytes.length) !== stat.size || bytes.length > maxBytes) {
      this.protocolFailure();
      throw new Error('invalid anchored writer read');
    }
    return { stat, bytes };
  }

  /**
   * Writes `data` to the regular file at `relative`. `create: 'new'` makes a file that must not exist
   * (`EEXIST` otherwise); `'replace'` makes it or truncates the existing file in place (its inode,
   * mode and other names stay). A link, a folder, a device or a FIFO is refused before any byte.
   * `mode` applies to a file this call makes (default 0666 under the process umask; 0 keeps that
   * default). `exactMode` requires `create: 'new'` and an explicit `mode`, including literal 000:
   * after writing, fchmod applies those exact bits through the held file descriptor. Returns the
   * written file's stat. An error at `chmod` is after exclusive creation and may leave a file.
   */
  async writeFile(
    relative: string,
    data: string | Buffer,
    options: { create: 'new' | 'replace'; mode?: number; fsync?: boolean; exactMode?: boolean },
    call: AnchoredWriterCall
  ): Promise<AnchoredEntryStat> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (bytes.length > ANCHORED_WRITE_MAX_BYTES) throw new AnchoredWriteError('request', 'EFBIG');
    if ((options.create !== 'new' && options.create !== 'replace') ||
        (options.exactMode !== undefined && typeof options.exactMode !== 'boolean') ||
        (options.exactMode && (options.create !== 'new' || typeof options.mode !== 'number'))) {
      throw new AnchoredWriteError('request', 'write-input');
    }
    const mode = options.mode ?? 0;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('invalid anchored write mode');
    await testHook?.('write', [relative], data, this);
    const name = pathBytes(relative);
    const head = Buffer.alloc(12);
    head[0] = options.create === 'new' ? 1 : 2;
    head[1] = (options.fsync ? 1 : 0) | (options.exactMode ? 2 : 0);
    head.writeUInt32BE(mode, 4);
    head.writeUInt32BE(name.length, 8);
    const reply = await this.request(KINDS.write, REPLIES.write, Buffer.concat([head, name, bytes]), call);
    if (reply.length !== STAT_BYTES) { this.protocolFailure(); throw new Error('invalid anchored writer stat'); }
    return this.parseStat(reply);
  }

  /** Makes one folder (its parent must exist); `EEXIST` when the name is taken. */
  mkdir(relative: string, call: AnchoredWriterCall): Promise<void> {
    return this.done('mkdir', relative, call);
  }

  /** Renames the entry itself (a link is moved, never followed), replacing a file at `to`. */
  async rename(from: string, to: string, call: AnchoredWriterCall): Promise<void> {
    await testHook?.('rename', [from, to], undefined, this);
    const source = pathBytes(from), destination = pathBytes(to);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(source.length);
    const reply = await this.request(KINDS.rename, REPLIES.done, Buffer.concat([head, source, destination]), call);
    if (reply.length) { this.protocolFailure(); throw new Error('invalid anchored writer reply'); }
  }

  /** Removes a file or a link (the link itself). */
  unlink(relative: string, call: AnchoredWriterCall): Promise<void> {
    return this.done('unlink', relative, call);
  }

  /** Removes an empty folder. */
  rmdir(relative: string, call: AnchoredWriterCall): Promise<void> {
    return this.done('rmdir', relative, call);
  }
}
