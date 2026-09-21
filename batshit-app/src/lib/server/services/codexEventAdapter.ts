import type {
  ThreadEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  ThreadItem,
  Usage,
} from "$lib/types/codexProtocol";
import type { NativeModeRequest } from "./vercelBrain";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "$lib/utils/logger";
import { buildCompactEditPreview, buildSnapshotEditPreview } from "$lib/utils/editDiff";
import { mapBashCommandToMode4Tool } from "./bashCommandMapper";
import {
  hasSubagentToolSegment,
  isDynamicMcpFindToolName,
  isDynamicMcpUseToolName
} from "$lib/utils/toolNameNormalization";
import {
  unwrapStructuredToolValue,
  unwrapSubagentToolResult
} from "$lib/utils/toolPayloadUnwrap";
import {
  getInternalBatshitServerTaskUrl,
  getInternalBatshitServerAuthHeaders,
} from "./batshitServerUrls";
import { stripToolZipControl } from "./toolZipControlNotice";
import { stripMcpImageContentBlocks } from "./toolResultImageDelivery";

type CodexTransport = "sdk" | "cli";
const execFileAsync = promisify(execFile);
const GIT_DIFF_MAX_BUFFER_BYTES = 5_000_000;
// F-P6-5: a failure Codex reports without an exit code keeps its failure as a reason.
const CODEX_COMMAND_FAILED_WITHOUT_EXIT_CODE =
  "Codex reported this command as failed and gave no exit code.";
const CODEX_PATCH_FAILED = "Codex reported that this patch failed.";
// Known copies: the most files kept, and the largest copy kept (bigger files are read again).
const MAX_KNOWN_COPIES = 32;
const MAX_KNOWN_COPY_CHARS = 2_000_000;

/** The key a known copy is kept under: the file's absolute path. */
function copyKey(filePath: string, projectPath: string | null): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(projectPath && projectPath.trim().length > 0 ? projectPath : "/", filePath);
}

function extractShellCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return command;
  const match = trimmed.match(/-lc\s+(['"])([\s\S]*?)\1/);
  if (match?.[2]) return match[2];
  const simpleMatch = trimmed.match(/-c\s+(['"])([\s\S]*?)\1/);
  if (simpleMatch?.[2]) return simpleMatch[2];
  return command;
}

function normalizeWebSearchResults(rawResults: any): Array<Record<string, any>> {
  const list = Array.isArray(rawResults) ? rawResults : [];
  return list.map((entry: any) => {
    if (typeof entry === "string") {
      return { title: entry, url: entry };
    }
    return {
      ...entry,
      title: entry?.title ?? entry?.url ?? entry?.name ?? "Search result",
      url: entry?.url ?? entry?.link ?? entry?.href,
      snippet:
        entry?.snippet ??
        entry?.summary ??
        entry?.description ??
        entry?.content ??
        entry?.text,
    };
  });
}

function firstNonEmptyArray(...candidates: any[]): any[] | null {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function buildCodexWebSearchResult(item: any, fallbackResult?: any) {
  const base = fallbackResult ?? item?.result ?? item?.action ?? item;
  const unwrapped = unwrapStructuredToolValue(base);
  const action = item?.action && typeof item.action === "object" ? item.action : {};
  const queries =
    Array.isArray((unwrapped as any)?.queries) && (unwrapped as any).queries.length > 0
      ? (unwrapped as any).queries
      : Array.isArray(action?.queries) && action.queries.length > 0
        ? action.queries
        : [];
  const fallbackUrl =
    (typeof (unwrapped as any)?.url === "string" && (unwrapped as any).url) ||
    (typeof action?.url === "string" && action.url) ||
    (typeof item?.url === "string" && item.url) ||
    (typeof (unwrapped as any)?.link === "string" && (unwrapped as any).link) ||
    (typeof action?.link === "string" && action.link);
  const rawResults =
    firstNonEmptyArray(
      (unwrapped as any)?.results,
      (unwrapped as any)?.sources,
      (unwrapped as any)?.items,
      action?.sources,
      action?.results,
    ) ??
    (fallbackUrl
      ? [
          {
            title: fallbackUrl,
            url: fallbackUrl,
            source:
              (unwrapped as any)?.type === "open_page" || action?.type === "open_page"
                ? "Opened page"
                : undefined,
          },
        ]
      : []);
  const results = normalizeWebSearchResults(rawResults);
  const query =
    item?.query ??
    (unwrapped as any)?.query ??
    action?.query ??
    queries[0];
  const explicitTotalMatches =
    typeof (unwrapped as any)?.totalMatches === "number"
      ? (unwrapped as any).totalMatches
      : typeof (unwrapped as any)?.total_matches === "number"
        ? (unwrapped as any).total_matches
        : typeof (unwrapped as any)?.count === "number"
          ? (unwrapped as any).count
          : undefined;
  const actionType =
    typeof action?.type === "string"
      ? action.type
      : typeof (unwrapped as any)?.type === "string"
        ? (unwrapped as any).type
        : undefined;
  const resultsUnavailable =
    results.length === 0 &&
    !fallbackUrl &&
    (actionType === "search" || actionType === "web_search_call");

  return {
    ...((unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) ? unwrapped : {}),
    results,
    ...(query ? { query } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    ...(explicitTotalMatches !== undefined || results.length > 0
      ? { totalMatches: Math.max(explicitTotalMatches ?? 0, results.length) }
      : {}),
    ...(resultsUnavailable ? { resultsUnavailable: true } : {}),
  };
}

export type CodexStreamChunk =
  | { type: "text-delta"; text: string }
  /**
   * SA-114 P2 (DL-114-06) — the app server confirmed a steer reached this turn.
   *
   * Carries only ids. The words are already in Batshit's own steer inbox, and send-routed
   * writes the transcript marker from there in its `case 'steer'`; putting the text on the
   * chunk would give two places the same bytes and one of them would eventually drift.
   */
  | { type: "steer"; steerIds: string[]; lane: "codex" }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args?: Record<string, any>;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      args?: Record<string, any>;
      result?: any;
      metadata?: Record<string, any>;
    }
  | {
      type: "finish";
      totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cachedInputTokens?: number;
      };
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cachedInputTokens?: number;
      };
    }
  | {
      type: "thinking";
      itemId: string;
      content: string;
      final?: boolean;
    };

interface CodexEventAdapterOptions {
  request: NativeModeRequest;
  transport: CodexTransport;
  onFinish?: (payload: {
    text: string;
    steps: any[];
    totalUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    };
    reasoning?: string[];
  }) => Promise<void> | void;
}

interface CodexToolState {
  id: string;
  toolName: string;
  args?: Record<string, any>;
  result?: any;
  startTimestamp: number;
}

// Try to recover the real tool name a dynamic wrapper executed.
// Dynamic MCP use responses often include the executed tool in `toolName`,
// `tool_name`, `name`, nested `result`, or even a text blob. Codex transports
// differ (sdk vs cli), so keep this tolerant and side-effect free.
function extractExecutedToolName(result: any, args?: any): string | undefined {
  const tryParse = (val: any): any => {
    if (typeof val !== "string") return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  };

  const search = (val: any): string | undefined => {
    if (!val) return undefined;

    if (typeof val === "string") {
      const match = val.match(/toolName\s*[:=]\s*"?([A-Za-z0-9._-]+)"?/i);
      return match?.[1];
    }

    if (Array.isArray(val)) {
      for (const item of val) {
        const found = search(item);
        if (found) return found;
      }
      return undefined;
    }

    if (typeof val === "object") {
      return (
        (val as any).executedToolName ||
        (val as any).toolName ||
        (val as any).tool_name ||
        (val as any).name ||
        search((val as any).result) ||
        search((val as any).output) ||
        search((val as any).content) ||
        search((val as any).text)
      );
    }

    return undefined;
  };

  return search(tryParse(result)) || search(tryParse(args));
}

// Codex thread items sometimes emit non-string `text` payloads (arrays/objects).
// Downstream zip and rendering pipelines expect plain strings.
function coerceThreadText(val: any): string {
  if (typeof val === "string") return val;

  if (Array.isArray(val)) {
    return val
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return (
            (part as any).text ??
            (part as any).content ??
            (part as any).value ??
            ""
          );
        }
        return "";
      })
      .join("");
  }

  if (val && typeof val === "object") {
    if (typeof (val as any).text === "string") return (val as any).text;
    if (typeof (val as any).content === "string") return (val as any).content;
  }

  try {
    const stringified = JSON.stringify(val);
    if (typeof stringified === "string") return stringified;
  } catch {
    // fall through
  }

  return String(val ?? "");
}

function coerceReasoningItemText(item: any): string {
  if (!item || typeof item !== "object") return "";

  const summary = Array.isArray(item.summary)
    ? item.summary
        .map((part: any) => coerceThreadText(part?.text ?? part?.content ?? part))
        .filter((text: string) => text.trim().length > 0)
        .join("\n\n")
    : undefined;

  return coerceThreadText(
    item.text ??
      item.content ??
      item.reasoning ??
      item.reasoningText ??
      item.reasoning_text ??
      summary ??
      "",
  );
}

function findSubagentResultMetadata(raw: any, depth = 0, seen = new WeakSet<object>()): Record<string, any> | null {
  if (raw == null || depth > 8) return null;

  if (typeof raw === "string") {
    try {
      return findSubagentResultMetadata(JSON.parse(raw), depth + 1, seen);
    } catch {
      return null;
    }
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findSubagentResultMetadata(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  if (typeof raw !== "object") return null;

  const obj = raw as Record<string, any>;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (
    typeof obj.subagentType === "string" ||
    typeof obj.subagent_type === "string" ||
    typeof obj.toolSource === "string" ||
    typeof obj.tool_source === "string"
  ) {
    return obj;
  }

  for (const key of [
    "output",
    "result",
    "toolResult",
    "tool_result",
    "data",
    "structuredContent",
    "structured_content",
    "content",
    "text",
    "value",
  ]) {
    const found = findSubagentResultMetadata(obj[key], depth + 1, seen);
    if (found) return found;
  }

  return null;
}

type CodexFileChange = {
  path?: string
  filePath?: string
  filepath?: string
  from?: string
  to?: string
  oldPath?: string
  old_path?: string
  newPath?: string
  new_path?: string
  previousPath?: string
  previous_path?: string
  destination?: string
  dest?: string
  targetPath?: string
  target_path?: string
  /** A word (`update`, `add`, …), or the app server's `{ type, move_path }` object. */
  kind?: unknown
  /** Codex's own record of this file's change (app-server lane; see `mapAppServerFileChange`). */
  diff?: string
}

/**
 * A change's kind as a word. The app server sends an object (`{ type: 'update', move_path }`),
 * which the lane maps to a word; reading one here anyway must never throw, because a throw in
 * this adapter ends the whole reply (every native patch did, until 2026-09-18).
 */
function normalizeFileChangeKind(kind: unknown): string | null {
  const record = kind && typeof kind === 'object' ? (kind as Record<string, unknown>) : null
  if (record && typeof record.move_path === 'string' && record.move_path) return 'move'
  const word = typeof kind === 'string' ? kind : typeof record?.type === 'string' ? record.type : ''
  if (!word) return null
  const normalized = word.toLowerCase()
  if (normalized === 'modify') return 'update'
  if (normalized === 'remove') return 'delete'
  if (normalized === 'create') return 'add'
  return normalized
}

/** The path a file change reads from (the old path of a rename). */
function fileChangePath(change?: CodexFileChange): string | undefined {
  return (
    change?.path ||
    change?.filePath ||
    change?.filepath ||
    change?.from ||
    change?.oldPath ||
    change?.old_path ||
    change?.previousPath ||
    change?.previous_path
  )
}

/** Where a file change moves its file, if it moves it. */
function fileChangeTargetPath(change?: CodexFileChange): string | undefined {
  return (
    change?.to ||
    (typeof (change?.kind as any)?.move_path === 'string' ? (change?.kind as any).move_path : undefined) ||
    change?.newPath ||
    change?.new_path ||
    change?.destination ||
    change?.dest ||
    change?.targetPath ||
    change?.target_path
  )
}

function resolveFileChangeTool(changes: CodexFileChange[] | undefined): {
  toolName: string
  args: Record<string, any>
  result: Record<string, any>
} {
  const safeChanges = Array.isArray(changes) ? changes : []
  const kinds = new Set(
    safeChanges
      .map((change) => normalizeFileChangeKind(change?.kind))
      .filter((value): value is string => Boolean(value))
  )

  const paths = safeChanges
    .map((change) => fileChangePath(change))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  let toolName = 'batshit_server_overwrite_file'
  let deciding: string | null = null
  if (kinds.has('update')) {
    toolName = 'batshit_server_edit_file'
    deciding = 'update'
  } else if (kinds.has('add')) {
    toolName = 'batshit_server_overwrite_file'
    deciding = 'add'
  } else if (kinds.has('delete') || kinds.has('rename') || kinds.has('move')) {
    toolName = 'batshit_server_execute_command'
    deciding = kinds.has('delete') ? 'delete' : kinds.has('rename') ? 'rename' : 'move'
  }

  // The change that decided the tool names the card, its read-back, and its command. The first
  // path of the patch did, so a patch that added one file and edited another was an Edit File
  // card titled with the ADDED file (whose start copy and read-back were that file too, on the
  // exec lane), an add beside a delete stored the deleted file's text as the written content,
  // and `rm`/`mv` could name a file the patch had not deleted or moved.
  const primaryChange =
    (deciding
      ? safeChanges.find((change) => normalizeFileChangeKind(change?.kind) === deciding && fileChangePath(change))
      : undefined) ?? safeChanges.find((change) => fileChangePath(change))
  const primaryPath = fileChangePath(primaryChange)
  const targetPath = fileChangeTargetPath(primaryChange)

  const args: Record<string, any> = {}
  if (primaryPath) {
    args.filePath = primaryPath
    args.path = primaryPath
  }
  if (paths.length > 1) {
    args.paths = paths
  }

  const result: Record<string, any> = {
    changes: withoutCodexRecords(safeChanges),
    ...(primaryPath ? { filePath: primaryPath } : {}),
    ...(paths.length > 1 ? { filePaths: paths } : {})
  }

  if (toolName === 'batshit_server_execute_command') {
    const kind = deciding ?? 'change'
    let command = `file_change ${kind}`
    if (kind === 'delete' && primaryPath) {
      command = `rm ${primaryPath}`
    } else if ((kind === 'rename' || kind === 'move') && primaryPath) {
      command = targetPath ? `mv ${primaryPath} ${targetPath}` : `mv ${primaryPath} <new-path>`
    } else if (primaryPath) {
      command = `${command} ${primaryPath}`
    }
    args.command = command
    result.command = command
  }

  return { toolName, args, result }
}

/**
 * A patch's changes without Codex's per-file records, for the call's arguments and result. The
 * records become the diff (or an add's content) once; left in, whole-file texts would ride along in
 * every event, the Execution Viewer, and the raw sidecar.
 */
function withoutCodexRecords<T>(changes: T[]): T[] {
  return changes.map((change) => {
    if (!change || typeof change !== 'object' || !('diff' in (change as object))) return change
    const { diff: _record, ...rest } = change as Record<string, unknown>
    return rest as T
  })
}

/** True when every change of a native patch carries Codex's own record of it (app-server lane). */
function fileChangesCarryCodexDiffs(changes: CodexFileChange[] | undefined): boolean {
  return Array.isArray(changes) && changes.length > 0 && changes.every((change) => typeof change?.diff === 'string')
}

/**
 * A native patch's diff from Codex's own per-file records (the app server's `fileChange.changes`),
 * as one git-style unified diff so the files of a patch stay apart. It is exact and needs no
 * copy of the file: a start copy is read only after the item starts, and Codex applies a patch in
 * its own process, so that copy can already hold the patched text. `undefined` when a change
 * carries no record (the exec lane), which leaves the adapter to its copies.
 */
function buildCodexPatchDiff(
  changes: CodexFileChange[] | undefined,
  projectPath: string | null,
): string | undefined {
  if (!fileChangesCarryCodexDiffs(changes)) return undefined
  const project = projectPath?.replace(/\/+$/, '') ?? ''
  const shown = (filePath: string) =>
    project && filePath.startsWith(`${project}/`)
      ? filePath.slice(project.length + 1)
      : filePath.replace(/^\/+/, '')
  const textLines = (text: string) => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  return (changes as CodexFileChange[])
    .map((change) => {
      const from = shown(change.path ?? '')
      const kind = normalizeFileChangeKind(change.kind)
      const record = change.diff as string
      if (kind === 'add') {
        const lines = textLines(record)
        return [
          `diff --git a/${from} b/${from}`,
          '--- /dev/null',
          `+++ b/${from}`,
          ...(lines.length > 0 ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)] : []),
        ].join('\n')
      }
      if (kind === 'delete') {
        const lines = textLines(record)
        return [
          `diff --git a/${from} b/${from}`,
          `--- a/${from}`,
          '+++ /dev/null',
          ...(lines.length > 0 ? [`@@ -1,${lines.length} +0,0 @@`, ...lines.map((line) => `-${line}`)] : []),
        ].join('\n')
      }
      const target = typeof change.to === 'string' && change.to ? shown(change.to) : from
      // A rename's record ends `\n\nMoved to: <path>`; the rename lines below say that already.
      const hunks = (target === from ? record : record.replace(/\n*\n\nMoved to: [^\n]*$/, ''))
        .replace(/\n+$/, '')
      return [
        `diff --git a/${from} b/${target}`,
        ...(target !== from ? [`rename from ${from}`, `rename to ${target}`] : []),
        ...(hunks ? [`--- a/${from}`, `+++ b/${target}`, hunks] : []),
      ].join('\n')
    })
    .join('\n')
}

async function readFileFromCommander(
  filePath: string,
  projectPath: string | null,
): Promise<string | null> {
  if (!filePath) return null;
  let normalizedProject = projectPath?.replace(/\/+$/, "") ?? null;
  let resolvedPath = filePath;

  if (normalizedProject && filePath.startsWith(normalizedProject)) {
    resolvedPath = filePath.slice(normalizedProject.length).replace(/^\/+/, "");
  } else if (!normalizedProject && filePath.includes("/batshit/")) {
    const match = filePath.match(/^(.*\/batshit)(?:\/|$)/);
    if (match?.[1]) {
      normalizedProject = match[1];
      resolvedPath = filePath.slice(normalizedProject.length).replace(/^\/+/, "");
    }
  } else if (normalizedProject && path.isAbsolute(filePath)) {
    return null;
  } else if (!normalizedProject) {
    return null;
  }

  if (!normalizedProject) return null;

  try {
    const response = await fetch(getInternalBatshitServerTaskUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getInternalBatshitServerAuthHeaders() },
      body: JSON.stringify({
        serviceName: "built-in",
        toolName: "read_file",
        input: { filePath: resolvedPath },
        params: { projectPath: normalizedProject },
      }),
    });

    if (!response.ok) return null;
    const result = await response.json();
    if (typeof result?.content === "string") return result.content;
    return null;
  } catch (error) {
    console.warn("[CodexEventAdapter] Failed to read file via batshit-server:", error);
    return null;
  }
}

async function readGitDiffForFile(
  filePath: string,
  projectPath: string | null,
): Promise<string | null> {
  const normalizedProject = projectPath?.trim().replace(/\/+$/, "") ?? null;
  if (!normalizedProject) return null;

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(normalizedProject, filePath);
  const relativePath = path.relative(normalizedProject, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", normalizedProject, "diff", "--no-ext-diff", "--no-color", "--", relativePath],
      {
        maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
        timeout: 5000,
      },
    );
    return typeof stdout === "string" && stdout.trim().length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

export class CodexEventAdapter {
  private readonly request: NativeModeRequest;
  private readonly transport: CodexTransport;
  private readonly onFinish?: CodexEventAdapterOptions["onFinish"];
  private readonly toolStates = new Map<string, CodexToolState>();
  private readonly intermediateSteps: any[] = [];
  private readonly rawEvents: ThreadEvent[] = [];
  /**
   * Batshit's own whole copy of each file an item it can follow has shown it, keyed by absolute
   * path: read from batshit-server when a read completes, or the read-back of a write or an edit,
   * and read again after any command Batshit cannot follow. It is never a command's OUTPUT: a
   * partial read (`sed -n 1,3p`, `head`) or a numbered one (`cat -n`, `nl`) is not the file, and
   * kept as the file it made the next edit's diff draw the rest of the file as added.
   *
   * An edit's "before" comes from here when it can. On the app-server lane a command's
   * `item/started` reaches Batshit about a millisecond before its `item/completed`, after the
   * command has run (measured live, 2026-09-18), so a copy read at the edit's own start is too
   * late for a fast command: it matched the edited file, and a real `sed -i` said "No change
   * seen". A copy read when an EARLIER item completed was read before the model even chose this
   * command. The one gap: a model that sends a read and an edit of the same file in one reply.
   */
  private readonly knownCopies = new Map<string, string>();
  /**
   * Each edit's "before", keyed by the item: its file's known copy (`known: true`), or else a copy
   * read at the item's own start, which only a slow command lets Batshit read in time.
   */
  private readonly startCopies = new Map<string, { text: string; known: boolean }>();
  private finalText = "";
  private usageSummary:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cachedInputTokens?: number;
      }
    | undefined;
  private completed = false;
  private readonly reasoningSegments = new Map<string, string>();
  private readonly reasoningOrder: string[] = [];
  private readonly agentMessageText = new Map<string, string>();

  constructor(options: CodexEventAdapterOptions) {
    this.request = options.request;
    this.transport = options.transport;
    this.onFinish = options.onFinish;
  }

  private parseCommandArgs(raw: string | undefined | null): any {
    if (!raw) return undefined;
    let trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        return trimmed.slice(1, -1);
      }
      return trimmed;
    }
  }

  private extractCommandParts(command: string) {
    const trimmed = command.trim();
    if (!trimmed) {
      return { verb: "", args: "" };
    }
    const match = trimmed.match(/^([A-Za-z0-9_]+)([\s\S]*)$/);
    if (!match) {
      return { verb: trimmed.toLowerCase(), args: "" };
    }
    let args = (match[2] || "").trim();
    if (args.startsWith(":") || args.startsWith("=")) {
      args = args.slice(1).trim();
    }
    if (args.startsWith("(") && args.endsWith(")")) {
      args = args.slice(1, -1).trim();
    }
    return {
      verb: match[1].toLowerCase(),
      args,
    };
  }

  private mapCommandToTool(command: string) {
    const trimmed = command.trim();
    if (!trimmed) return null;
    const shellCommand = extractShellCommand(trimmed);
    const { verb, args } = this.extractCommandParts(shellCommand);
    if (!verb) return null;
    const parsed = this.parseCommandArgs(args);
    let normalized: Record<string, any>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      normalized = parsed as Record<string, any>;
    } else if (parsed !== undefined) {
      normalized = { input: parsed };
    } else if (args) {
      normalized = { input: args };
    } else {
      normalized = {};
    }
    const withCommand: Record<string, any> = {
      ...(normalized as Record<string, any>),
    };
    withCommand.command = command;
    withCommand.innerCommand = shellCommand;

    if (
      (verb === "read_file" ||
        verb === "write_file" ||
        verb === "edit_file") &&
      typeof normalized.input === "string"
    ) {
      const trimmedInput = normalized.input.trim();
      if (trimmedInput) {
        withCommand.path = withCommand.path ?? trimmedInput;
        withCommand.filePath = withCommand.filePath ?? trimmedInput;
      }
    }

    switch (verb) {
      case "read_file":
        return { toolName: "batshit_server_read_file", args: withCommand };
      case "write_file":
        return { toolName: "batshit_server_overwrite_file", args: withCommand };
      case "list_dir":
      case "list_files":
        return { toolName: "batshit_server_list_files", args: withCommand };
      case "search_files":
      case "search_repo":
        return { toolName: "batshit_server_search_files", args: withCommand };
      case "edit_file":
      case "apply_patch":
        return { toolName: "batshit_server_edit_file", args: withCommand };
      default:
        return mapBashCommandToMode4Tool(command);
    }
  }

  private requestProjectPath(): string | null {
    return typeof this.request.projectPath === "string" ? this.request.projectPath : null;
  }

  private rememberCopy(filePath: string, text: string): void {
    const key = copyKey(filePath, this.requestProjectPath());
    this.knownCopies.delete(key);
    if (text.length > MAX_KNOWN_COPY_CHARS) return;
    this.knownCopies.set(key, text);
    while (this.knownCopies.size > MAX_KNOWN_COPIES) {
      const oldest = this.knownCopies.keys().next().value;
      if (oldest === undefined) break;
      this.knownCopies.delete(oldest);
    }
  }

  private forgetCopy(filePath: unknown): void {
    if (typeof filePath !== "string" || filePath.trim().length === 0) return;
    this.knownCopies.delete(copyKey(filePath, this.requestProjectPath()));
  }

  /** Read the whole file now and keep it as its known copy (or forget it if it cannot be read). */
  private async learnCopy(filePath: unknown): Promise<void> {
    if (typeof filePath !== "string" || filePath.trim().length === 0) return;
    const content = await readFileFromCommander(filePath, this.requestProjectPath());
    if (typeof content === "string") this.rememberCopy(filePath, content);
    else this.forgetCopy(filePath);
  }

  /** A command Batshit cannot follow may have changed any file: read every known one again. */
  private async refreshKnownCopies(): Promise<void> {
    await Promise.all([...this.knownCopies.keys()].map((key) => this.learnCopy(key)));
  }

  private async captureStartCopy(itemId: string, filePath: unknown): Promise<void> {
    if (typeof filePath !== "string" || filePath.trim().length === 0) return;
    const known = this.knownCopies.get(copyKey(filePath, this.requestProjectPath()));
    if (known !== undefined) {
      this.startCopies.set(itemId, { text: known, known: true });
      return;
    }
    const content = await readFileFromCommander(filePath, this.requestProjectPath());
    if (typeof content === "string") {
      this.startCopies.set(itemId, { text: content, known: false });
    }
  }

  private async buildEditDiff(options: {
    itemId: string;
    filePath: string;
    projectPath: string | null;
    after: string;
    inputPreview?: string;
    /**
     * A shell command's start copy that matches the file proves Batshit saw no change. A native
     * patch always changes its file, so a matching copy there was read after the patch landed.
     */
    matchingCopyMeansNoChange: boolean;
  }): Promise<string> {
    const before = this.startCopies.get(options.itemId);

    if (options.inputPreview) return options.inputPreview;

    // A copy that differs from the file now was read before the command wrote it.
    if (before && before.text !== options.after) {
      return (
        buildSnapshotEditPreview({
          filePath: options.filePath,
          before: before.text,
          after: options.after,
        }) ?? `Updated ${options.filePath}. Diff unavailable.`
      );
    }

    // A KNOWN copy (read when an earlier item completed) that matches the file now means this
    // command changed nothing Batshit could see: say that, and never `git diff -- <file>`, which
    // is every unstaged change in the file, not this command's (it drew a no-match `sed -i` as the
    // file's older edits). "Seen", where the API lane, which reads its copies around the run
    // itself, says "No changes". A copy read at this item's own start that matches proves
    // nothing: it is usually read after the command ran (see `knownCopies`), and saying "No
    // change seen" there hid a real `sed -i` edit.
    if (before?.known && options.matchingCopyMeansNoChange) {
      return `No change seen: ${options.filePath} matches the copy Batshit read before this command ran.`;
    }

    // No copy from before the command, or a patch that beat its copy: the file's git diff is the
    // best record left, then the summary.
    return (
      (await readGitDiffForFile(options.filePath, options.projectPath)) ??
      buildCompactEditPreview({
        filePath: options.filePath,
        after: options.after,
      }) ??
      `Updated ${options.filePath}. Diff unavailable.`
    );
  }

  private isReasoningItem(item: any): boolean {
    return item?.type === "reasoning" || item?.type === "agent_reasoning";
  }

  private isReasoningSummaryStreamEvent(event: any): boolean {
    const type = typeof event?.type === "string" ? event.type : "";
    return (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_summary_text.done" ||
      type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_part.done"
    );
  }

  private *handleReasoningItem(
    item: any,
    final: boolean,
  ): Generator<CodexStreamChunk> {
    const reasoningText = coerceReasoningItemText(item);
    this.reasoningSegments.set(item.id, reasoningText);
    if (!this.reasoningOrder.includes(item.id)) {
      this.reasoningOrder.push(item.id);
    }
    if (reasoningText.trim().length > 0) {
      yield {
        type: "thinking",
        itemId: item.id,
        content: reasoningText,
        final,
      };
    }
  }

  private *handleReasoningSummaryStreamEvent(
    event: any,
  ): Generator<CodexStreamChunk> {
    const type = typeof event?.type === "string" ? event.type : "";
    const itemId =
      event?.item_id ??
      event?.itemId ??
      event?.id ??
      `reasoning_summary_${event?.output_index ?? 0}`;
    const previous = this.reasoningSegments.get(itemId) ?? "";
    const text =
      typeof event?.text === "string"
        ? event.text
        : typeof event?.delta === "string"
          ? event.delta
          : typeof event?.text_delta === "string"
            ? event.text_delta
            : "";
    const final =
      type === "response.reasoning_summary_text.done" ||
      type === "response.reasoning_summary_part.done";
    const next = final && typeof event?.text === "string" ? text : `${previous}${text}`;

    this.reasoningSegments.set(itemId, next);
    if (!this.reasoningOrder.includes(itemId)) {
      this.reasoningOrder.push(itemId);
    }
    if (next.trim().length > 0) {
      yield {
        type: "thinking",
        itemId,
        content: next,
        final,
      };
    }
  }

  async *stream(
    events: AsyncGenerator<ThreadEvent>,
  ): AsyncGenerator<CodexStreamChunk> {
    try {
      for await (const event of events) {
        this.rawEvents.push(event);
        if (event.type === "item.started") {
          yield* this.handleItemStarted(event);
        } else if (event.type === "item.updated") {
          yield* this.handleItemUpdated(event);
        } else if (event.type === "item.completed") {
          yield* this.handleItemCompleted(event);
        } else if (event.type === "steer.delivered") {
          // Straight through. The adapter deliberately does NOT mark the steer delivered
          // itself (F-P1-3's rule for a CLI lane): send-routed's own `case` does that, so
          // the transcript marker lands exactly where this chunk sits in the stream.
          yield {
            type: "steer",
            steerIds: [...event.steer_ids],
            lane: "codex",
          };
        } else if (event.type === "turn.completed") {
          yield this.handleTurnCompleted(event.usage);
        } else if (event.type === "turn.failed") {
          throw new Error(event.error?.message || "Codex run failed");
        } else if (event.type === "error") {
          throw new Error(
            event.message ||
              (typeof (event as any).error?.message === "string"
                ? (event as any).error.message
                : "Codex stream emitted an unrecoverable error"),
          );
        } else if (this.isReasoningSummaryStreamEvent(event)) {
          yield* this.handleReasoningSummaryStreamEvent(event);
        }
      }
    } finally {
      await this.finalize();
    }
  }

  private async *handleItemStarted(
    event: ItemStartedEvent,
  ): AsyncGenerator<CodexStreamChunk> {
    const item = event.item;
    if (this.isReasoningItem(item)) {
      yield* this.handleReasoningItem(item, false);
      return;
    }
    switch (item.type) {
      case "command_execution": {
        const commandMatch = this.mapCommandToTool(item.command || "");
        const toolName = commandMatch?.toolName ?? "batshit_server_execute_command";
        const args = commandMatch?.args ?? { command: item.command };
        this.toolStates.set(item.id, {
          id: item.id,
          toolName,
          args,
          startTimestamp: Date.now(),
        });
        yield {
          type: "tool-call",
          toolCallId: item.id,
          toolName,
          args,
        };
        if (toolName === "batshit_server_edit_file") {
          await this.captureStartCopy(item.id, args?.filePath ?? args?.path ?? args?.input);
        }
        break;
      }

      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes : undefined;
        const resolved = resolveFileChangeTool(changes);
        const args: Record<string, any> = {
          ...resolved.args,
          ...(item.changes ? { changes: withoutCodexRecords(item.changes) } : {}),
        };
        this.toolStates.set(item.id, {
          id: item.id,
          toolName: resolved.toolName,
          args,
          startTimestamp: Date.now(),
        });
        yield {
          type: "tool-call",
          toolCallId: item.id,
          toolName: resolved.toolName,
          args,
        };
        // A patch Codex describes itself needs no start copy, which it can beat.
        if (
          resolved.toolName === "batshit_server_edit_file" &&
          !fileChangesCarryCodexDiffs(changes)
        ) {
          await this.captureStartCopy(item.id, args?.filePath ?? args?.path);
        }
        break;
      }

      case "mcp_tool_call": {
        const toolName = `mcp.${item.server}.${item.tool}`;
        const isSubagentCall = hasSubagentToolSegment(toolName);
        const input =
          item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
            ? item.arguments as Record<string, unknown>
            : {};
        const args = isSubagentCall
          ? {
              // Normalize the displayed request without dropping supplied fields
              // such as thread from tool events and Execution Viewer evidence.
              ...input,
              chatInput:
                input.chatInput ??
                input.prompt ??
                input.input ??
                item.arguments,
            }
          : { arguments: item.arguments };
        this.toolStates.set(item.id, {
          id: item.id,
          toolName,
          args,
          startTimestamp: Date.now(),
        });
        yield {
          type: "tool-call",
          toolCallId: item.id,
          toolName,
          args,
        };
        break;
      }

      case "todo_list": {
        const args = { items: item.items };
        this.toolStates.set(item.id, {
          id: item.id,
          toolName: "codex_plan_update",
          args,
          startTimestamp: Date.now(),
        });
        yield {
          type: "tool-call",
          toolCallId: item.id,
          toolName: "codex_plan_update",
          args,
        };
        break;
      }

      case "web_search": {
        const args = { query: item.query };
        this.toolStates.set(item.id, {
          id: item.id,
          toolName: "codex_web_search",
          args,
          startTimestamp: Date.now(),
        });
        yield {
          type: "tool-call",
          toolCallId: item.id,
          toolName: "codex_web_search",
          args,
        };
        break;
      }

      case "agent_message": {
        this.agentMessageText.set(item.id, coerceThreadText(item.text));
        break;
      }

      default:
        break;
    }
  }

  private *handleItemUpdated(
    event: ItemUpdatedEvent,
  ): Generator<CodexStreamChunk> {
    const item = event.item;
    if (this.isReasoningItem(item)) {
      yield* this.handleReasoningItem(item, false);
    } else if (item.type === "todo_list") {
      yield {
        type: "tool-result",
        toolCallId: item.id,
        toolName: "codex_plan_update",
        args: { items: item.items },
        result: item.items,
        metadata: { status: "updated" },
      };
    } else if (item.type === "agent_message") {
      const previous = this.agentMessageText.get(item.id) ?? "";
      const nextText = coerceThreadText(item.text);
      if (nextText.length > previous.length) {
        const delta = nextText.slice(previous.length);
        if (delta) {
          yield {
            type: "text-delta",
            text: delta,
          };
        }
      }
      this.agentMessageText.set(item.id, nextText);
    }
  }

  private async *handleItemCompleted(
    event: ItemCompletedEvent,
  ): AsyncGenerator<CodexStreamChunk> {
    const item = event.item as ThreadItem;

    if (item.type === "agent_message") {
      const previous = this.agentMessageText.get(item.id) ?? "";
      const finalText = coerceThreadText(item.text);
      this.finalText = finalText;
      if (finalText.length > previous.length) {
        const delta = finalText.slice(previous.length);
        if (delta) {
          yield {
            type: "text-delta",
            text: delta,
          };
        }
      }
      this.agentMessageText.delete(item.id);
      return;
    }

    if (this.isReasoningItem(item)) {
      yield* this.handleReasoningItem(item, true);
      return;
    }

    let tracked = this.toolStates.get(item.id);
    if (!tracked && item.type === "file_change") {
      const resolved = resolveFileChangeTool(
        Array.isArray(item.changes) ? item.changes : undefined,
      );
      tracked = {
        id: item.id,
        toolName: resolved.toolName,
        args: {
          ...resolved.args,
          ...(item.changes ? { changes: item.changes } : {}),
        },
        startTimestamp: Date.now(),
      };
    }
    if (!tracked) {
      return;
    }

    let toolResult: any = null;
    let executedToolName: string | undefined;
    if (item.type === "command_execution") {
      const projectPath =
        typeof this.request.projectPath === "string"
          ? this.request.projectPath
          : null;
      // A command that exited non-zero, or that Codex reports `failed` with no exit code (the
      // app-server lane maps a declined or cancelled command that way), changed nothing Batshit
      // can show: its file is not read back, and its output is not the file's content (F-P6-5).
      const commandFailed =
        item.status === "failed" ||
        (typeof item.exit_code === "number" && item.exit_code !== 0);
      const failureWithoutExitCode =
        item.status === "failed" && typeof item.exit_code !== "number"
          ? { success: false, error: CODEX_COMMAND_FAILED_WITHOUT_EXIT_CODE }
          : {};
      if (tracked.toolName === "batshit_server_read_file") {
        const filePath =
          tracked.args?.filePath ?? tracked.args?.path ?? tracked.args?.input;
        toolResult = {
          content: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...(filePath ? { filePath } : {}),
          ...failureWithoutExitCode,
        };
        // The file as Batshit reads it now, before the model has chosen its next command; never
        // this read's output, which can be part of the file or numbered (see `knownCopies`).
        if (!commandFailed) await this.learnCopy(filePath);
      } else if (tracked.toolName === "batshit_server_overwrite_file") {
        const filePath =
          tracked.args?.filePath ?? tracked.args?.path ?? tracked.args?.input;
        toolResult = {
          output: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...(filePath ? { filePath } : {}),
          ...failureWithoutExitCode,
        };
        if (typeof filePath === "string" && !commandFailed) {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") {
            toolResult.content = content;
            this.rememberCopy(filePath, content);
          } else {
            this.forgetCopy(filePath);
            if (toolResult.content === undefined) {
              toolResult.content = "(content unavailable from codex command_execution)";
            }
          }
        } else {
          // A failed write is never read back, so its file's copy may be stale.
          this.forgetCopy(filePath);
        }
      } else if (tracked.toolName === "batshit_server_edit_file") {
        const filePath =
          tracked.args?.filePath ?? tracked.args?.path ?? tracked.args?.input;
        toolResult = {
          output: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...(filePath ? { filePath } : {}),
          ...failureWithoutExitCode,
        };
        const inputPreview = buildCompactEditPreview({
          filePath: typeof filePath === "string" ? filePath : undefined,
          command:
            typeof tracked.args?.command === "string"
              ? tracked.args.command
              : undefined,
          oldText:
            typeof tracked.args?.oldString === "string"
              ? tracked.args.oldString
              : undefined,
          newText:
            typeof tracked.args?.newString === "string"
              ? tracked.args.newString
              : undefined,
          allowSummary: false,
        });
        if (commandFailed) {
          // Only the change the command meant to make; never "Updated <path>". Never read back,
          // so its file's copy may be stale.
          if (inputPreview) toolResult.diff = inputPreview;
          this.forgetCopy(filePath);
        } else if (typeof filePath === "string") {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") {
            toolResult.diff = await this.buildEditDiff({
              itemId: item.id,
              filePath,
              projectPath,
              after: content,
              inputPreview,
              matchingCopyMeansNoChange: true,
            });
            this.rememberCopy(filePath, content);
          } else {
            this.forgetCopy(filePath);
            if (toolResult.diff === undefined) {
              toolResult.diff =
                inputPreview ??
                `Updated ${filePath}. Diff unavailable because Batshit could not reconstruct the before/after change.`;
            }
          }
        } else if (toolResult.diff === undefined) {
          toolResult.diff =
            inputPreview ??
            "Updated file. Diff unavailable because Batshit could not reconstruct the before/after change.";
        }
      } else {
        toolResult = {
          output: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...failureWithoutExitCode,
        };
        // Any other command may have changed a file Batshit knows (a formatter, a checkout, a
        // `python3 -c` one-liner); a listing or a search does not.
        if (
          tracked.toolName !== "batshit_server_list_files" &&
          tracked.toolName !== "batshit_server_search_files"
        ) {
          await this.refreshKnownCopies();
        }
      }
      this.startCopies.delete(item.id);
    } else if (item.type === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : undefined;
      const resolved = resolveFileChangeTool(changes);
      tracked.toolName = resolved.toolName;
      tracked.args = {
        ...resolved.args,
        ...(tracked.args || {}),
        ...(item.changes ? { changes: withoutCodexRecords(item.changes) } : {}),
      };
      // A patch Codex could not apply changed nothing Batshit can show: no read-back, no
      // "Updated <path>", and the failure travels as `success: false` plus a reason (F-P6-5).
      const patchFailed = item.status === "failed";
      toolResult = {
        ...resolved.result,
        status: item.status,
        ...(patchFailed ? { success: false, error: CODEX_PATCH_FAILED } : {}),
      };

      const projectPath =
        typeof this.request.projectPath === "string"
          ? this.request.projectPath
          : null;
      const filePath =
        toolResult?.filePath || tracked.args?.filePath || tracked.args?.path;
      // Codex's own record of the patch (app-server lane) is its diff, exactly; a failed patch
      // keeps it as the change it meant to make (F-P6-5 D3), with no read-back.
      const codexDiff =
        resolved.toolName === "batshit_server_edit_file"
          ? buildCodexPatchDiff(changes, projectPath)
          : undefined;
      if (patchFailed && codexDiff) toolResult.diff = codexDiff;
      /** A file of this patch as Batshit read it back (or an add's own text), by path. */
      const readBack = new Map<string, string>();

      if (resolved.toolName === "batshit_server_overwrite_file" && !patchFailed) {
        // An add's own record is exactly the text it wrote; without one (the exec lane) the file
        // is read back.
        const recorded = changes?.find(
          (change) => change?.path === filePath && typeof change?.diff === "string",
        )?.diff;
        const content =
          recorded ??
          (typeof filePath === "string"
            ? await readFileFromCommander(filePath, projectPath)
            : null);
        if (typeof content === "string") {
          toolResult.content = content;
          if (typeof filePath === "string") readBack.set(filePath, content);
        } else if (toolResult.content === undefined) {
          toolResult.content = "(content unavailable from codex file_change)";
        }
      }

      if (resolved.toolName === "batshit_server_edit_file" && !patchFailed) {
        if (codexDiff) {
          toolResult.diff = codexDiff;
        } else if (typeof filePath === "string") {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") readBack.set(filePath, content);
          toolResult.diff =
            typeof content === "string"
              ? await this.buildEditDiff({
                  itemId: item.id,
                  filePath,
                  projectPath,
                  after: content,
                  matchingCopyMeansNoChange: false,
                })
              : `Updated ${filePath}. Diff unavailable because Batshit could not reconstruct the before/after change.`;
        } else {
          toolResult.diff =
            "Updated file. Diff unavailable because Batshit could not reconstruct the before/after change.";
        }
      }

      // The patch changed its own files; keep what Batshit knows of them current. A failed patch
      // is never read back, so its files' copies are dropped. Otherwise a file just read back (or
      // an add's own text) is kept, and any other file of the patch Batshit knew is read again (a
      // deleted or moved-away path fails that read and is dropped).
      const patchPaths = new Set(
        (changes ?? [])
          .flatMap((change) => [fileChangePath(change), fileChangeTargetPath(change)])
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      );
      for (const patchPath of patchPaths) {
        const text = readBack.get(patchPath);
        if (patchFailed) this.forgetCopy(patchPath);
        else if (text !== undefined) this.rememberCopy(patchPath, text);
        else if (this.knownCopies.has(copyKey(patchPath, projectPath))) await this.learnCopy(patchPath);
      }
      this.startCopies.delete(item.id);
    } else if (item.type === "mcp_tool_call") {
      // SA-105 P3: an MCP result can now carry image content blocks (the helper
      // bridge delivers recalled memory photos that way on this runtime). The
      // object below becomes an intermediate step, then a zip, then compiled
      // history — so the bytes come out here, at the same boundary the API lanes
      // strip them from `providerMessages`. The model already saw the image in
      // its own turn; what persists is the note.
      toolResult = stripMcpImageContentBlocks(
        item.result ?? (item.error ? { error: item.error } : null),
      );

      const isSubagentCall = hasSubagentToolSegment(tracked.toolName);
      if (isSubagentCall) {
        toolResult = unwrapSubagentToolResult(toolResult);
      }

      const isDynamicMcpUse = isDynamicMcpUseToolName(tracked.toolName);
      const isDynamicMcpFind = isDynamicMcpFindToolName(tracked.toolName);

      if (isDynamicMcpUse) {
        executedToolName =
          // Prefer the requested tool from call arguments (most reliable)
          (tracked.args as any)?.arguments?.toolName ||
          (tracked.args as any)?.arguments?.tool ||
          // Fallback to parsed result payloads
          extractExecutedToolName(toolResult, tracked.args);

        if (
          executedToolName &&
          toolResult &&
          typeof toolResult === "object" &&
          !Array.isArray(toolResult)
        ) {
          toolResult = { ...toolResult, executedToolName };
        }
      }

      if (isDynamicMcpFind) {
        const argsObj = (tracked.args as any)?.arguments || {};
        const params = argsObj.params || {};
        const query = params.query || argsObj.query || argsObj.input?.query;

        const unwrapped = unwrapStructuredToolValue(toolResult);
        const isArrayResult = Array.isArray(unwrapped);
        const resultList =
          (isArrayResult ? unwrapped : (unwrapped as any)?.results) ||
          (unwrapped as any)?.data ||
          (unwrapped as any)?.tools ||
          [];

        const totalMatches =
          (unwrapped as any)?.totalMatches ??
          (unwrapped as any)?.total_matches ??
          (unwrapped as any)?.count ??
          (isArrayResult ? (unwrapped as any)?.length : undefined) ??
          (Array.isArray(resultList) ? resultList.length : undefined);

        toolResult = {
          ...((unwrapped && typeof unwrapped === "object") ? unwrapped : {}),
          results: Array.isArray(resultList) ? resultList : (isArrayResult ? (unwrapped as any) : []),
          ...(totalMatches !== undefined ? { totalMatches } : {}),
          ...(query ? { query } : {})
        };
      }
      // An MCP tool may write a file (a helper's own write tools do), so read every known one again.
      await this.refreshKnownCopies();
    } else if (item.type === "todo_list") {
      toolResult = item.items;
    } else if (item.type === "web_search") {
      toolResult = buildCodexWebSearchResult(item, (item as any).result);
      if ((toolResult as any)?.totalMatches === 0) {
        logger.debug("[SA049 Codex web_search debug]", JSON.stringify(item));
      }
      if (tracked.args && (!tracked.args.query || String(tracked.args.query).trim().length === 0)) {
        const resolvedQuery =
          typeof (toolResult as any)?.query === "string"
            ? (toolResult as any).query
            : typeof item?.query === "string"
              ? item.query
              : Array.isArray((toolResult as any)?.queries) && (toolResult as any).queries.length > 0
                ? (toolResult as any).queries[0]
                : undefined;
        if (resolvedQuery) {
          tracked.args = {
            ...tracked.args,
            query: resolvedQuery,
          };
        }
      }
    } else if (item.type === "error") {
      toolResult = { error: item.message };
    }

    const displayToolName =
      executedToolName && tracked.toolName ? executedToolName : tracked.toolName;
    // F-P4-9: Batshit announces no zip id to the model, so there is nothing to register
    // here. A `batshitZipControl` marker can still arrive from a user-installed MCP server,
    // and it must not reach the stored step.
    toolResult = stripToolZipControl(toolResult);
    const metadata = this.detectToolMetadata(tracked.toolName, tracked.args, toolResult);

    this.intermediateSteps.push({
      toolName: displayToolName,
      originalToolName: tracked.toolName,
      toolInput: tracked.args ?? {},
      toolResult: toolResult,
      toolOutput: toolResult,
      toolCallId: tracked.id,
      timestamp: Date.now(),
      ...(executedToolName ? { executedToolName } : {}),
      ...metadata,
    });

    yield {
      type: "tool-result",
      toolCallId: tracked.id,
      toolName: displayToolName,
      args: tracked.args,
      result: toolResult,
      metadata,
    };

    this.toolStates.delete(item.id);
  }

  private handleTurnCompleted(usage: Usage): CodexStreamChunk {
    const rawUsage = usage as any;
    const inputTokens = rawUsage?.input_tokens;
    const outputTokens = rawUsage?.output_tokens;
    const reasoningTokens =
      rawUsage?.reasoning_output_tokens ??
      rawUsage?.output_tokens_details?.reasoning_tokens ??
      rawUsage?.outputTokenDetails?.reasoningTokens;
    const cachedInputTokens =
      rawUsage?.cached_input_tokens ??
      rawUsage?.input_tokens_details?.cached_tokens ??
      rawUsage?.inputTokenDetails?.cacheReadTokens;
    const summary = {
      inputTokens,
      outputTokens,
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
      ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    };
    this.usageSummary = summary;

    return {
      type: "finish",
      totalUsage: summary,
      usage: summary,
    };
  }

  private detectToolMetadata(toolName: string, args?: any, result?: any) {
    const lower = toolName.toLowerCase();
    if (lower.includes("subagent_")) {
      const match = lower.match(/subagent_([a-z0-9_-]+)/);
      const slug = match?.[1];
      const unslugged = slug ? slug.replace(/[_-]+/g, " ").trim() : undefined;
      const displayName = unslugged
        ? unslugged
            .split(" ")
            .map((word) =>
              word === "batshit"
                ? "Batshit"
                : word === "n8n"
                  ? "n8n"
                : word.length
                  ? word[0].toUpperCase() + word.slice(1)
                  : word,
            )
            .join(" ")
        : undefined;
      const resultObj =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, any>)
          : {};
      const resultMetadataObj = findSubagentResultMetadata(result) ?? resultObj;
      const argObj =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, any>)
          : {};
      const subagentType =
        typeof resultMetadataObj.subagentType === "string"
          ? resultMetadataObj.subagentType
          : typeof resultMetadataObj.subagent_type === "string"
            ? resultMetadataObj.subagent_type
            : typeof argObj.subagentType === "string"
              ? argObj.subagentType
              : undefined;
      const explicitToolSource =
        typeof resultMetadataObj.toolSource === "string"
          ? resultMetadataObj.toolSource
          : typeof resultMetadataObj.tool_source === "string"
            ? resultMetadataObj.tool_source
            : undefined;
      const toolSource =
        explicitToolSource ||
        (subagentType === "api"
          ? "managed-api-subagent"
          : subagentType === "cli"
            ? "managed-cli-subagent"
            : "workflow-webhook");
      const subagentId =
        typeof resultMetadataObj.subagentId === "string" && resultMetadataObj.subagentId.trim()
          ? resultMetadataObj.subagentId.trim()
          : typeof resultMetadataObj.subagent_id === "string" && resultMetadataObj.subagent_id.trim()
            ? resultMetadataObj.subagent_id.trim()
          : slug;
      const subagentName =
        typeof resultMetadataObj.subagentName === "string" && resultMetadataObj.subagentName.trim()
          ? resultMetadataObj.subagentName.trim()
          : typeof resultMetadataObj.subagent_name === "string" && resultMetadataObj.subagent_name.trim()
            ? resultMetadataObj.subagent_name.trim()
          : displayName;
      return {
        toolProvider: "subagent",
        toolSource,
        isSubagent: true,
        ...(subagentType ? { subagentType } : {}),
        ...(subagentId ? { subagentId } : {}),
        ...(subagentName ? { subagentName } : {}),
      };
    }

    if (toolName.startsWith("mcp.")) {
      const [, server] = toolName.split(".");
      return {
        toolProvider: "mcp",
        toolSource: "mcp-gateway",
        mcpServerName: server,
      };
    }

    if (toolName.startsWith("batshit_server_")) {
      return {
        toolProvider: "batshit-server",
        toolSource: "mode3-workflow",
      };
    }

    if (toolName.startsWith("codex_")) {
      return {
        toolProvider: "codex",
        toolSource: "codex",
      };
    }

    return {
      toolProvider: "codex",
      toolSource: "codex",
    };
  }

  private async finalize() {
    if (this.completed) return;
    this.completed = true;
    const combinedText = this.finalText || "";
    await this.onFinish?.({
      text: combinedText,
      steps: this.intermediateSteps,
      totalUsage: this.usageSummary,
      reasoning: this.getOrderedReasoningSegments(),
    });
  }

  getToolMetadataResolver() {
    return (toolName: string) => this.detectToolMetadata(toolName);
  }

  getRawEvents(): ThreadEvent[] {
    return this.rawEvents;
  }

  getTransport(): CodexTransport {
    return this.transport;
  }

  getIntermediateSteps() {
    return this.intermediateSteps;
  }

  private getOrderedReasoningSegments(): string[] {
    if (this.reasoningOrder.length === 0) {
      return [];
    }
    const segments: string[] = [];
    for (const id of this.reasoningOrder) {
      const text = this.reasoningSegments.get(id);
      if (text && text.trim().length > 0) {
        segments.push(text.trim());
      }
    }
    return segments;
  }
}
