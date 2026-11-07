import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { registerRuntimeShutdownTask } from './runtimeShutdown';

let nextReaderId = 0;
export class AnchoredReaderCleanupError extends Error {}

const HEADER = 16;
const FRAME_CAP = 8_000_000;
const GIT_OPS = { prefix: 1, list: 2, attributes: 3, stage: 4, blob: 5 } as const;
export type ReaderCall = { timeoutMs: number; signal?: AbortSignal };
type Pending = { id: number; kind: number; resolve: (body: Buffer) => void; reject: (error: Error) => void };

/**
 * What one mode of the native helper says. The reader's words are matched by its callers
 * (`liveFileReadSnapshot.server.ts`), so each mode keeps its own.
 */
export interface AnchoredHelperWords {
  stopped: string;
  tooLong: string;
  invalidResponse: string;
  closed: string;
  released: string;
  logTag: string;
  requestSize: string;
  idsExhausted: string;
  /** A helper that outlived SIGKILL's grace: the reader says its Git child's cleanup is unverified. */
  forced: string;
}

export interface AnchoredHelperOptions {
  /** argv after the executable: the reader's `[root, git]`, the writer's `['--write-v2', root]`. */
  args: string[];
  /** The runtime shutdown task's name prefix. */
  shutdownName: string;
  /**
   * The writer names the helper's own last stderr line (`anchored-reader:<reason>:<errno>`) when it
   * closes, so an old binary or a kernel without `openat2` says so. The reader's words stay exact.
   */
  closedNamesReason: boolean;
  env: NodeJS.ProcessEnv;
  words: AnchoredHelperWords;
  frameCap: number;
  requestCap: number;
  /**
   * The reader's helper runs Git: an abnormal exit after admission cannot show that it reaped its
   * child, so `close` reports it. The writer runs no child.
   */
  verifiesChildCleanup: boolean;
}

/** These are installed host files, never a project-selected executable or PATH search. */
function helperExecutable(): string {
  return process.env.VITEST === 'true' && process.env.BATSHIT_TEST_ANCHORED_READER
    ? process.env.BATSHIT_TEST_ANCHORED_READER : path.join(process.cwd(), 'scripts/anchored-project-reader');
}

/**
 * One bounded native helper process (BL-320; its writer-v2 mode, BL-2006): the frames, the one request
 * in flight, deadlines and Stop, and its release. It owns the admitted directory for its lifetime.
 */
export abstract class AnchoredHelper {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly ready: Promise<Buffer>;
  private readyResolve!: (body: Buffer) => void;
  private readyReject!: (error: Error) => void;
  private admitted = false;
  private admittedIdentity: string | null = null;
  private exited = false;
  private cleanupFailure: AnchoredReaderCleanupError | null = null;
  private failure: Error | null = null;
  /** Unparsed stdout: kept as chunks and joined once per frame (a 64 MiB writer reply). */
  private chunks: Buffer[] = [];
  private chunkBytes = 0;
  private lastStderr = '';
  private pending: Pending | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private unregisterShutdown: (() => void) | null = null;
  protected readonly words: AnchoredHelperWords;
  private readonly frameCap: number;
  private readonly requestCap: number;
  private readonly verifiesChildCleanup: boolean;
  private readonly closedNamesReason: boolean;

  protected constructor(options: AnchoredHelperOptions) {
    this.words = options.words;
    this.frameCap = options.frameCap;
    this.requestCap = options.requestCap;
    this.verifiesChildCleanup = options.verifiesChildCleanup;
    this.closedNamesReason = options.closedNamesReason;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    this.child = spawn(helperExecutable(), options.args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exited = true;
      // Native exit 2 is die(), which reaps its exact Git child before exiting.
      // A signal or unknown exit after admission cannot establish that cleanup happened.
      if (options.verifiesChildCleanup && this.admitted && (signal || (code !== 0 && code !== 2))) {
        this.cleanupFailure = new AnchoredReaderCleanupError('anchored reader exited unexpectedly; Git child cleanup is unverified');
      }
      this.unregisterShutdown?.();
      this.unregisterShutdown = null;
      const reason = this.closedNamesReason && this.lastStderr ? ` (${this.lastStderr})` : '';
      this.invalidate(new Error(`${this.words.closed}${reason}`));
      resolve();
    }));
    this.child.on('error', error => this.invalidate(error));
    this.child.stdin.on('error', error => this.invalidate(error));
    this.child.stdout.on('data', chunk => this.consume(chunk));
    if (this.closedNamesReason) {
      // The helper writes one short line before it exits; keep the last one, bounded.
      this.child.stderr.on('data', (chunk: Buffer) => {
        const lines = `${this.lastStderr}\n${chunk.toString('utf8')}`.split('\n').map(line => line.trim()).filter(Boolean);
        this.lastStderr = (lines.at(-1) ?? '').slice(0, 160);
      });
    } else {
      this.child.stderr.resume();
    }
    this.unregisterShutdown = registerRuntimeShutdownTask(`${options.shutdownName}-${++nextReaderId}`, () => this.close());
  }

  /** Waits for admission; on any failure the helper is released before the error is thrown. */
  protected static async admit<T extends AnchoredHelper>(helper: T, call: ReaderCall): Promise<T> {
    try {
      await helper.bounded(() => helper.ready, call);
      return helper;
    } catch (error) {
      await helper.close();
      throw error;
    }
  }

  /** `<dev>:<ino>` of the directory the helper admitted (its READY frame); null before admission. */
  get rootIdentity(): string | null {
    return this.admittedIdentity;
  }

  /** True once the helper can serve no more requests (closed, stopped, timed out or broken). */
  get failed(): boolean {
    return this.failure !== null;
  }

  /** The error a refusal frame (255) becomes. */
  protected abstract refusal(body: Buffer): Error;

  private invalidate(error: Error) {
    this.failure ??= error;
    this.chunks = [];
    this.chunkBytes = 0;
    this.readyReject(this.failure);
    this.pending?.reject(this.failure);
    this.pending = null;
  }

  private consume(chunk: Buffer) {
    if (this.failure) return;
    this.chunks.push(chunk);
    this.chunkBytes += chunk.length;
    if (this.chunkBytes > this.frameCap + HEADER) return this.protocolFailure();
    while (this.chunkBytes >= HEADER) {
      if (this.chunks[0].length < HEADER) this.chunks = [Buffer.concat(this.chunks, this.chunkBytes)];
      const header = this.chunks[0];
      const length = header.readUInt32BE(12);
      if (header.toString('ascii', 0, 4) !== 'B320' || header[4] !== 1 ||
          header[6] || header[7] || length > this.frameCap) return this.protocolFailure();
      if (this.chunkBytes < HEADER + length) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.chunkBytes);
      const kind = all[5], id = all.readUInt32BE(8);
      const body = Buffer.from(all.subarray(HEADER, HEADER + length));
      const rest = all.subarray(HEADER + length);
      this.chunks = rest.length ? [rest] : [];
      this.chunkBytes = rest.length;
      if (!this.admitted && kind === 128 && id === 0 && length === 16) {
        this.admitted = true;
        this.admittedIdentity = `${body.readBigUInt64BE(0)}:${body.readBigUInt64BE(8)}`;
        this.readyResolve(body);
        continue;
      }
      const pending = this.pending;
      if (!this.admitted || !pending || id !== pending.id ||
          (kind !== pending.kind && kind !== 255)) return this.protocolFailure();
      this.pending = null;
      if (kind === 255) pending.reject(this.refusal(body));
      else pending.resolve(body);
    }
  }

  protected protocolFailure() {
    this.invalidate(new Error(this.words.invalidResponse));
    void this.close().catch(error => console.error(this.words.logTag, error));
  }

  private async bounded<T>(work: () => Promise<T>, call: ReaderCall): Promise<T> {
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (reason: string) => {
      const error = new Error(reason);
      this.invalidate(error);
      rejectStop(error);
    };
    const abort = () => stop(this.words.stopped);
    call.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(this.words.tooLong), Math.max(0, call.timeoutMs));
    try {
      if (call.signal?.aborted) abort();
      return await Promise.race([this.failure ? Promise.reject(this.failure) : work(), stopped]);
    } catch (error) {
      if (this.failure) await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', abort);
    }
  }

  protected request(kind: number, expected: number, body: Buffer, call: ReaderCall): Promise<Buffer> {
    if (!body.length || body.length > this.requestCap) return Promise.reject(new Error(this.words.requestSize));
    // Include queue time in the caller's deadline; only one request reaches the native helper.
    return this.bounded(() => {
      const operation = this.queue.then(async () => {
        await this.ready;
        if (this.failure) throw this.failure;
        if (this.nextId > 0xffffffff) throw new Error(this.words.idsExhausted);
        const id = this.nextId++;
        const answer = new Promise<Buffer>((resolve, reject) => { this.pending = { id, kind: expected, resolve, reject }; });
        const header = Buffer.alloc(HEADER);
        header.write('B320'); header[4] = 1; header[5] = kind;
        header.writeUInt32BE(id, 8); header.writeUInt32BE(body.length, 12);
        this.child.stdin.write(Buffer.concat([header, body]));
        return answer;
      });
      this.queue = operation.catch(() => {});
      return operation;
    }, call);
  }

  /** EOF is normal release; TERM asks the exact helper to reap its own Git child. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.invalidate(new Error(this.words.released));
    this.closing = (async () => {
      const verifiedExit = () => {
        if (this.cleanupFailure) throw this.cleanupFailure;
        return this.exited;
      };
      if (verifiedExit()) return;
      this.child.stdin.end();
      const wait = async (ms: number) => {
        let timer!: ReturnType<typeof setTimeout>;
        await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
        clearTimeout(timer);
      };
      await wait(100);
      if (verifiedExit()) return;
      this.child.kill('SIGTERM');
      await wait(500);
      if (verifiedExit()) return;
      this.child.kill('SIGKILL');
      await wait(500);
      throw this.verifiesChildCleanup ? new AnchoredReaderCleanupError(this.words.forced) : new Error(this.words.forced);
    })();
    return this.closing;
  }
}

/** One bounded native reader owns the admitted directory for the entire reply. */
export class AnchoredProjectReader extends AnchoredHelper {
  private constructor(projectRoot: string) {
    super({
      args: [projectRoot, '/usr/bin/git'],
      shutdownName: 'anchored-reader',
      closedNamesReason: false,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C',
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}) },
      words: {
        stopped: 'anchored project read stopped',
        tooLong: 'anchored project read took too long',
        invalidResponse: 'invalid anchored reader response',
        closed: 'anchored project reader closed',
        released: 'anchored project reader released',
        logTag: '[AnchoredProjectReader]',
        requestSize: 'invalid anchored reader request size',
        idsExhausted: 'anchored reader request IDs exhausted',
        forced: 'anchored reader required forced termination; Git child cleanup is unverified',
      },
      frameCap: FRAME_CAP,
      requestCap: 4100,
      verifiesChildCleanup: true,
    });
  }

  static async open(projectRoot: string, call: ReaderCall): Promise<AnchoredProjectReader> {
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('anchored project reads are unavailable on this platform');
    }
    if (call.signal?.aborted) throw new Error('anchored project read stopped');
    return AnchoredHelper.admit(new AnchoredProjectReader(projectRoot), call);
  }

  protected refusal(body: Buffer): Error {
    return new Error(`anchored read refused (${body.toString('utf8').slice(0, 128)})`);
  }

  async git(op: keyof typeof GIT_OPS, argument: string, call: ReaderCall): Promise<string> {
    const bytes = await this.request(3, 131, Buffer.concat([Buffer.from([GIT_OPS[op]]), Buffer.from(argument)]), call);
    if (bytes.length > 5_000_000) throw new Error('Git output exceeded its limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async stat(relative: string, call: ReaderCall) {
    const bytes = await this.request(2, 130, Buffer.from(relative), call);
    if (bytes.length !== 40) { this.protocolFailure(); throw new Error('invalid anchored STAT response'); }
    return { size: bytes.readBigUInt64BE(0), dev: bytes.readBigUInt64BE(8), ino: bytes.readBigUInt64BE(16),
      ctimeNs: bytes.readBigUInt64BE(24), mtimeNs: bytes.readBigUInt64BE(32) };
  }

  /** `keepByteOrderMark`: return a leading U+FEFF as the file has it (SA-137 live reads, as `cat` prints it). */
  async readText(relative: string, maxChars: number, call: ReaderCall, options: { keepByteOrderMark?: boolean } = {}): Promise<string> {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 2_000_000) throw new Error('invalid text limit');
    const body = Buffer.alloc(4 + Buffer.byteLength(relative));
    body.writeUInt32BE(maxChars * 4); body.write(relative, 4);
    const bytes = await this.request(1, 129, body, call);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: options.keepByteOrderMark === true }).decode(bytes);
    if (bytes.length > maxChars * 4 || text.length > maxChars || /[\0\uFFFD]/.test(text)) throw new Error('not bounded UTF-8 text');
    return text;
  }
}
