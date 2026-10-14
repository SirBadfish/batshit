import path from "node:path";
import { buildSnapshotEditPreview } from "$lib/utils/editDiff";
import { AnchoredProjectReader, AnchoredReaderCleanupError } from "./anchoredProjectReader";
import { logger } from "$lib/utils/logger";

/**
 * BL-9 — a read-only git baseline for one Codex reply.
 *
 * A Codex edit card needs the file as it was before the command. Batshit's own copy of the file
 * (the adapter's `knownCopies`) is the best "before", but for a file the reply never read there
 * is none, and a copy read at the command's own start is too late (the app server reports a
 * command's start after it ran). The old fallback, `git diff -- <file>`, is every unstaged
 * change in the file, so a `sed -i` that changed nothing showed the file's older, unrelated
 * edits as if it had made them.
 *
 * This baseline is taken before Codex starts, in the project folder:
 * - it lists the tracked files that already have unstaged changes, and the adapter keeps a copy
 *   of each (up to `CODEX_MAX_KNOWN_COPIES`), so such a file's "before" is its start-of-reply
 *   copy;
 * - for another ordinary tracked text file, it compares a file-descriptor-bound copy against the raw
 *   index blob, without asking Git to convert worktree contents;
 * - it lists again after commands Batshit cannot follow. Uncertain files stay unvouched.
 *
 * This Git runs on the host outside Codex's sandbox. BL-290 therefore uses only stat-based
 * cached-index stat listings and raw object reads: no status, patch generation, filters, textconv, external
 * diff, fsmonitor, index refresh writes, or lazy network fetches. Configured filter discovery
 * cannot close a concurrent config-change race. Every pathspec is literal.
 *
 * The baseline is taken before Codex starts, so it ends at once on a Stop and has one total
 * time limit; one that could not finish vouches for nothing.
 */

/** The most files the adapter keeps a known copy of, and the largest copy it keeps. */
export const CODEX_MAX_KNOWN_COPIES = 32;
export const CODEX_MAX_KNOWN_COPY_CHARS = 2_000_000;

const GIT_TIMEOUT_MS = 3_000;
/**
 * The whole baseline's time limit: its git calls and bounded file-descriptor reads together.
 * It sits before Codex starts, so it must not
 * hold the reply; one that does not finish in time vouches for nothing.
 */
const BASELINE_TIME_LIMIT_MS = 5_000;

export type CodexReplyBaselineDiff =
  | { kind: "diff"; diff: string }
  | { kind: "unchanged" }
  | { kind: "unvouched"; reason: string };

export interface CodexReplyBaselineOptions {
  /** The project folder the adapter reads files and diffs in (the request's `projectPath`). */
  projectPath: string | null | undefined;
  maxCopies?: number;
  maxCopyChars?: number;
  gitTimeoutMs?: number;
  /** The whole baseline's time limit (`BASELINE_TIME_LIMIT_MS`). */
  totalTimeoutMs?: number;
  /** The reply's Stop: the baseline ends at once and vouches for nothing. */
  signal?: AbortSignal | null;
}

type GitCall = { timeoutMs: number; signal?: AbortSignal };

function describeGitFailure(error: unknown): string {
  const failure = error as { killed?: boolean; code?: unknown; stderr?: unknown; message?: unknown };
  if (failure?.killed) return "git took too long";
  if (failure?.code === "ENOENT") return "git is not installed";
  const stderr = typeof failure?.stderr === "string" ? failure.stderr.trim().split("\n")[0] : "";
  return stderr || (typeof failure?.message === "string" ? failure.message.split("\n")[0] : "git failed");
}

export class CodexReplyBaseline {
  /** The project folder, resolved, in the same spelling the adapter's copy keys use. */
  private readonly projectRoot: string | null;
  private failure: string | null;
  private readonly reader: AnchoredProjectReader | null;
  private readonly timeoutMs: number;
  /** Tracked files whose worktree differed from the index at the last listing. */
  private dirty = new Set<string>();
  /** Files a step of this reply changed since the last listing. */
  private readonly changedSinceListing = new Set<string>();
  private copies = new Map<string, string>();
  private scanCopies = new Map<string, string>();
  private indexOids = new Map<string, string>();
  private scanOids = new Map<string, string>();
  private maxCopies = CODEX_MAX_KNOWN_COPIES;
  private maxCopyChars = CODEX_MAX_KNOWN_COPY_CHARS;

  private constructor(options: { projectRoot: string | null; failure: string | null; timeoutMs: number; reader?: AnchoredProjectReader }) {
    this.projectRoot = options.projectRoot;
    this.reader = options.reader ?? null;
    this.failure = options.failure;
    this.timeoutMs = options.timeoutMs;
  }

  /** The start-of-reply copies of the files that already had changes, by absolute path. */
  get startCopies(): ReadonlyMap<string, string> {
    return this.copies;
  }

  /** A baseline that vouches for nothing, with its reason. */
  static unavailable(reason: string): CodexReplyBaseline {
    return new CodexReplyBaseline({ projectRoot: null, failure: reason, timeoutMs: GIT_TIMEOUT_MS });
  }

  /**
   * Lists the project's changed files and copies them. Read failures vouch for nothing.
   * Unverified process cleanup rejects so the bridge records its existing cleanup warning.
   */
  static async take(options: CodexReplyBaselineOptions): Promise<CodexReplyBaseline> {
    const timeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
    const totalTimeoutMs = options.totalTimeoutMs ?? BASELINE_TIME_LIMIT_MS;
    const raw = typeof options.projectPath === "string" ? options.projectPath.trim() : "";
    if (!raw) return CodexReplyBaseline.unavailable("this reply has no project folder");
    const projectRoot = path.resolve(raw);

    // Review finding 3: one controller ends every step, on the reply's Stop or at the time
    // limit; git children are killed through it and the copy reads are raced against it.
    const replyStop = options.signal ?? null;
    const STOPPED = "the reply was stopped before its git baseline was taken";
    const TOO_SLOW = `the git baseline took longer than ${Math.round(totalTimeoutMs / 1000)} s`;
    if (replyStop?.aborted) return CodexReplyBaseline.unavailable(STOPPED);
    const stop = new AbortController();
    let stopReason = TOO_SLOW;
    const onReplyStop = () => {
      stopReason = STOPPED;
      stop.abort();
    };
    replyStop?.addEventListener("abort", onReplyStop, { once: true });
    const limit = setTimeout(() => stop.abort(), totalTimeoutMs);
    limit.unref?.();
    const stopped = new Promise<never>((_resolve, reject) => {
      stop.signal.addEventListener("abort", () => reject(new Error(stopReason)), { once: true });
    });
    stopped.catch(() => {});
    const call: GitCall = { timeoutMs, signal: stop.signal };

    let reader: AnchoredProjectReader | null = null;
    let retained = false;
    try {
      try { reader = await AnchoredProjectReader.open(projectRoot, call); }
      catch (error) {
        if (error instanceof AnchoredReaderCleanupError) throw error;
        return CodexReplyBaseline.unavailable(stop.signal.aborted ? stopReason :
          `safe project reads are unavailable (${describeGitFailure(error)})`);
      }
      const baseline = new CodexReplyBaseline({ projectRoot, failure: null, timeoutMs, reader });
      baseline.maxCopies = Math.max(0, options.maxCopies ?? CODEX_MAX_KNOWN_COPIES);
      baseline.maxCopyChars = options.maxCopyChars ?? CODEX_MAX_KNOWN_COPY_CHARS;
      try {
        await Promise.race([reader.git("prefix", "", call), stopped]);
      } catch (error) {
        if (stop.signal.aborted) return CodexReplyBaseline.unavailable(stopReason);
        return CodexReplyBaseline.unavailable(
          `the project folder is not a git repository Batshit can read (${describeGitFailure(error)})`,
        );
      }
      const listed = await Promise.race([baseline.list(call), stopped]).catch(() => null);
      if (stop.signal.aborted) return CodexReplyBaseline.unavailable(stopReason);
      if (!listed) return CodexReplyBaseline.unavailable(baseline.failure ?? "git could not list the project");
      baseline.dirty = listed;
      baseline.indexOids = baseline.scanOids;

      baseline.copies = baseline.scanCopies;
      logger.debug("[CodexReplyBaseline] Taken", {
        projectRoot,
        changedFiles: listed.size,
        copied: baseline.copies.size,
      });
      retained = true;
      return baseline;
    } finally {
      clearTimeout(limit);
      replyStop?.removeEventListener("abort", onReplyStop);
      if (!retained) await reader?.close();
    }
  }

  /** The bridge releases after normal stream consumption, or when failed setup/Stop discards further reads. */
  async dispose(): Promise<void> {
    this.failure ??= "the reply baseline was released";
    await this.reader?.close();
  }

  get ready(): boolean {
    return this.failure === null && this.projectRoot !== null;
  }

  get unavailableReason(): string | null {
    return this.failure;
  }

  /**
   * Lists the project again after a command Batshit cannot follow. Returns the files that have
   * changes now and had none at the last listing, which the adapter copies as their new start.
   * A listing that fails ends the baseline for the rest of the reply: it can no longer vouch.
   */
  async relist(signal?: AbortSignal | null): Promise<string[]> {
    if (!this.ready) return [];
    // Review finding 4: the reply's Stop ends the listing (its git child is killed).
    const listed = await this.list({ timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) });
    if (signal?.aborted) {
      this.failure = "the reply was stopped";
      return [];
    }
    if (!listed) return [];
    const newlyChanged = [...listed].filter((filePath) => !this.dirty.has(filePath)).sort();
    this.dirty = listed;
    this.indexOids = this.scanOids;
    this.changedSinceListing.clear();
    return newlyChanged;
  }

  /** A step Batshit follows (a write, an edit, a patch) changed this file, or may have. */
  markChanged(filePath: unknown): void {
    const absolute = this.absolutePath(filePath);
    if (absolute) this.changedSinceListing.add(absolute);
  }

  /**
   * What git says changed in this file since the last listing, when the baseline can vouch for
   * it: a tracked file with no changes of its own at the last listing and none from an earlier
   * step since. An empty diff is `unchanged`.
   */
  async readDiff(filePath: string): Promise<CodexReplyBaselineDiff> {
    if (!this.ready || !this.projectRoot) {
      return { kind: "unvouched", reason: this.failure ?? "no baseline was taken" };
    }
    const absolute = this.absolutePath(filePath);
    if (!absolute) return { kind: "unvouched", reason: "no file was named" };
    const relative = path.relative(this.projectRoot, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { kind: "unvouched", reason: "the file is outside the project folder" };
    }
    if (this.dirty.has(absolute)) {
      return { kind: "unvouched", reason: "the file already had changes when Batshit last looked" };
    }
    if (this.changedSinceListing.has(absolute)) {
      return { kind: "unvouched", reason: "an earlier step of this reply changed the file" };
    }

    try {
      const call = { timeoutMs: this.timeoutMs };
      // Conversion attributes make a raw index blob a different representation. Fail closed
      // rather than show pointers, encoded bytes, or line-ending normalization as an edit.
      const attributes = (await this.reader!.git("attributes", relative, call)).split("\0");
      for (let i = 0; i + 2 < attributes.length; i += 3) {
        const value = attributes[i + 2];
        if (value !== "unspecified" && value !== "unset") {
          return { kind: "unvouched", reason: `a ${attributes[i + 1]} attribute stores the file differently from its content` };
        }
      }
      const savedOid = this.indexOids.get(absolute);
      if (!savedOid) return { kind: "unvouched", reason: "the file has no stable index baseline" };
      const before = await this.indexCopy(relative, call, savedOid);
      const after = await this.safeCopy(absolute, call);
      if (after === null) return { kind: "unvouched", reason: "the file is not readable ordinary text" };
      if (before === after) return { kind: "unchanged" };
      const diff = buildSnapshotEditPreview({ filePath: relative, before, after });
      return diff ? { kind: "diff", diff } : { kind: "unvouched", reason: "the text diff is unavailable" };
    } catch (error) {
      return { kind: "unvouched", reason: `git could not read the file (${describeGitFailure(error)})` };
    }
  }

  private absolutePath(filePath: unknown): string | null {
    if (typeof filePath !== "string" || !filePath.trim() || !this.projectRoot) return null;
    return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(this.projectRoot, filePath);
  }

  /** Read only ordinary stage-0 index blobs; `H` also excludes skip/assume-unchanged. */
  private async indexCopy(relative: string, call: GitCall, expectedOid: string): Promise<string> {
    const entries = (await this.reader!.git("stage", relative, call))
      .split("\0").filter(Boolean);
    const match = entries.length === 1 ? /^H (100644|100755) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entries[0]) : null;
    if (!match || match[3] !== relative) {
      throw new Error(entries.length ? "git does not compare the file's changes as ordinary text" : "git does not track the file");
    }
    if (match[2] !== expectedOid) throw new Error("the index changed since the last baseline listing");
    // Read the captured object id, not a second lookup of an index that might change meanwhile.
    const text = await this.reader!.git("blob", expectedOid, call);
    if (text.length > this.maxCopyChars || /[\0\uFFFD]/.test(text)) throw new Error("the index blob is not bounded UTF-8 text");
    return text;
  }

  /** Every component and byte read stays relative to the once-admitted root handle. */
  private async safeCopy(absolute: string, call: GitCall): Promise<string | null> {
    try {
      const relative = path.relative(this.projectRoot!, absolute);
      return await this.reader!.readText(relative, this.maxCopyChars, call);
    } catch { return null; }
  }

  /** Read cached index metadata only. Even diff-files --name-only can run clean filters. */
  private async list(call: GitCall = { timeoutMs: this.timeoutMs }): Promise<Set<string> | null> {
    if (!this.projectRoot) return null;
    this.scanCopies = new Map();
    this.scanOids = new Map();
    const controller = new AbortController();
    const abort = () => controller.abort();
    call.signal?.addEventListener("abort", abort, { once: true });
    if (call.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, BASELINE_TIME_LIMIT_MS);
    const bounded = { ...call, signal: controller.signal };
    try {
      const output = await this.reader!.git("list", "", bounded);
      const listed = new Set<string>();
      let offset = 0;
      while (offset < output.length) {
        if (controller.signal.aborted) throw new Error("the baseline listing was stopped or took too long");
        const end = output.indexOf("\0", offset);
        if (end < 0) throw new Error("unrecognized Git index listing");
        const header = /^([A-Za-z?]) ([0-7]+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(output.slice(offset, end));
        // Git documents --debug as a diagnostic format, not a stable machine contract. An
        // unknown shape invalidates the baseline; never treat unparsed entries as clean.
        const stat = /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([0-9a-f]+)\n/.exec(output.slice(end + 1));
        if (!header || !stat) throw new Error("unrecognized Git index metadata");
        offset = end + 1 + stat[0].length;
        const relative = header[5]; // ls-files paths are relative to -C, unlike diff-files.
        if (header[1] !== "H" || header[4] !== "0" || !/^(100644|100755)$/.test(header[2])) continue;
        const absolute = path.resolve(this.projectRoot, relative);
        const local = path.relative(this.projectRoot, absolute);
        if (!local || local === ".." || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) throw new Error("index path outside project");
        this.scanOids.set(absolute, header[3]);
        try {
          const current = await this.reader!.stat(local, bounded);
          const ctime = BigInt(stat[1]) * 1_000_000_000n + BigInt(stat[2]);
          const mtime = BigInt(stat[3]) * 1_000_000_000n + BigInt(stat[4]);
          if (current.size === BigInt(stat[9]) && current.ctimeNs === ctime && current.mtimeNs === mtime) continue;
        } catch { /* missing/inaccessible stays uncertain */ }
        listed.add(absolute);
        if (this.scanCopies.size >= this.maxCopies) continue;
        const text = await this.safeCopy(absolute, bounded);
        if (text === null) continue;
        let before: string | null = null;
        try { before = await this.indexCopy(relative, bounded, header[3]); } catch { /* uncertain stays listed */ }
        if (before === text) listed.delete(absolute);
        else this.scanCopies.set(absolute, text);
      }
      return listed;
    } catch (error) {
      this.failure = `git could not list the project's changes (${describeGitFailure(error)})`;
      return null;
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", abort);
    }
  }
}
