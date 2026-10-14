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

/** One bounded native reader owns the admitted directory for the entire reply. */
export class AnchoredProjectReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly ready: Promise<Buffer>;
  private readyResolve!: (body: Buffer) => void;
  private readyReject!: (error: Error) => void;
  private admitted = false;
  private exited = false;
  private cleanupFailure: AnchoredReaderCleanupError | null = null;
  private failure: Error | null = null;
  private buffered: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private unregisterShutdown: (() => void) | null = null;

  private constructor(projectRoot: string) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    // These are installed host files, never a project-selected executable or PATH search.
    const executable = process.env.VITEST === 'true' && process.env.BATSHIT_TEST_ANCHORED_READER
      ? process.env.BATSHIT_TEST_ANCHORED_READER : path.join(process.cwd(), 'scripts/anchored-project-reader');
    this.child = spawn(executable, [projectRoot, '/usr/bin/git'], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C',
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exited = true;
      // Native exit 2 is die(), which reaps its exact Git child before exiting.
      // A signal or unknown exit after admission cannot establish that cleanup happened.
      if (this.admitted && (signal || (code !== 0 && code !== 2))) {
        this.cleanupFailure = new AnchoredReaderCleanupError('anchored reader exited unexpectedly; Git child cleanup is unverified');
      }
      this.unregisterShutdown?.();
      this.unregisterShutdown = null;
      this.invalidate(new Error('anchored project reader closed'));
      resolve();
    }));
    this.child.on('error', error => this.invalidate(error));
    this.child.stdin.on('error', error => this.invalidate(error));
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.resume();
    this.unregisterShutdown = registerRuntimeShutdownTask(`anchored-reader-${++nextReaderId}`, () => this.close());
  }

  static async open(projectRoot: string, call: ReaderCall): Promise<AnchoredProjectReader> {
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('anchored project reads are unavailable on this platform');
    }
    if (call.signal?.aborted) throw new Error('anchored project read stopped');
    const reader = new AnchoredProjectReader(projectRoot);
    try {
      await reader.bounded(() => reader.ready, call);
      return reader;
    } catch (error) {
      await reader.close();
      throw error;
    }
  }

  private invalidate(error: Error) {
    this.failure ??= error;
    this.buffered = Buffer.alloc(0);
    this.readyReject(this.failure);
    this.pending?.reject(this.failure);
    this.pending = null;
  }

  private consume(chunk: Buffer) {
    if (this.failure) return;
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > FRAME_CAP + HEADER) return this.protocolFailure();
    while (this.buffered.length >= HEADER) {
      const header = this.buffered;
      const length = header.readUInt32BE(12);
      if (header.toString('ascii', 0, 4) !== 'B320' || header[4] !== 1 ||
          header[6] || header[7] || length > FRAME_CAP) return this.protocolFailure();
      if (header.length < HEADER + length) return;
      const kind = header[5], id = header.readUInt32BE(8);
      const body = Buffer.from(header.subarray(HEADER, HEADER + length));
      this.buffered = header.subarray(HEADER + length);
      if (!this.admitted && kind === 128 && id === 0 && length === 16) {
        this.admitted = true;
        this.readyResolve(body);
        continue;
      }
      const pending = this.pending;
      if (!this.admitted || !pending || id !== pending.id ||
          (kind !== pending.kind && kind !== 255)) return this.protocolFailure();
      this.pending = null;
      if (kind === 255) pending.reject(new Error(`anchored read refused (${body.toString('utf8').slice(0, 128)})`));
      else pending.resolve(body);
    }
  }

  private protocolFailure() {
    this.invalidate(new Error('invalid anchored reader response'));
    void this.close().catch(error => console.error('[AnchoredProjectReader]', error));
  }

  private async bounded<T>(work: () => Promise<T>, call: ReaderCall): Promise<T> {
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (reason: string) => {
      const error = new Error(reason);
      this.invalidate(error);
      rejectStop(error);
    };
    const abort = () => stop('anchored project read stopped');
    call.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('anchored project read took too long'), Math.max(0, call.timeoutMs));
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

  private request(kind: number, expected: number, body: Buffer, call: ReaderCall): Promise<Buffer> {
    if (!body.length || body.length > 4100) return Promise.reject(new Error('invalid anchored reader request size'));
    // Include queue time in the caller's deadline; only one request reaches the native helper.
    return this.bounded(() => {
      const operation = this.queue.then(async () => {
        await this.ready;
        if (this.failure) throw this.failure;
        if (this.nextId > 0xffffffff) throw new Error('anchored reader request IDs exhausted');
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

  async readText(relative: string, maxChars: number, call: ReaderCall): Promise<string> {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 2_000_000) throw new Error('invalid text limit');
    const body = Buffer.alloc(4 + Buffer.byteLength(relative));
    body.writeUInt32BE(maxChars * 4); body.write(relative, 4);
    const bytes = await this.request(1, 129, body, call);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.length > maxChars * 4 || text.length > maxChars || /[\0\uFFFD]/.test(text)) throw new Error('not bounded UTF-8 text');
    return text;
  }

  /** EOF is normal release; TERM asks the exact helper to reap its own Git child. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.invalidate(new Error('anchored project reader released'));
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
      throw new AnchoredReaderCleanupError('anchored reader required forced termination; Git child cleanup is unverified');
    })();
    return this.closing;
  }
}
