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
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "$lib/utils/logger";
import { buildCompactEditPreview } from "$lib/utils/editDiff";
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
import { extractAndStripToolZipControl } from "./toolZipControlNotice";
import { stripMcpImageContentBlocks } from "./toolResultImageDelivery";

type CodexTransport = "sdk" | "cli";
const execFileAsync = promisify(execFile);
const GIT_DIFF_MAX_BUFFER_BYTES = 5_000_000;

function extractShellCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return command;
  const match = trimmed.match(/-lc\s+(['"])([\s\S]*?)\1/);
  if (match?.[2]) return match[2];
  const simpleMatch = trimmed.match(/-c\s+(['"])([\s\S]*?)\1/);
  if (simpleMatch?.[2]) return simpleMatch[2];
  return command;
}

function normalizeSnapshotPath(
  filePath: string | undefined,
  projectPath: string | null,
): string | null {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return filePath;
  const base = projectPath && projectPath.trim().length > 0 ? projectPath : os.homedir();
  return path.resolve(base, filePath);
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
  kind?: string
}

function normalizeFileChangeKind(kind?: string): string | null {
  if (!kind) return null
  const normalized = kind.toLowerCase()
  if (normalized === 'modify') return 'update'
  if (normalized === 'remove') return 'delete'
  if (normalized === 'create') return 'add'
  return normalized
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

  const resolvePath = (change?: CodexFileChange) =>
    change?.path ||
    change?.filePath ||
    change?.filepath ||
    change?.from ||
    change?.oldPath ||
    change?.old_path ||
    change?.previousPath ||
    change?.previous_path

  const resolveTargetPath = (change?: CodexFileChange) =>
    change?.to ||
    change?.newPath ||
    change?.new_path ||
    change?.destination ||
    change?.dest ||
    change?.targetPath ||
    change?.target_path

  const paths = safeChanges
    .map((change) => resolvePath(change))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  const primaryPath = paths[0]
  const targetPath = safeChanges
    .map((change) => resolveTargetPath(change))
    .find((value): value is string => typeof value === 'string' && value.length > 0)

  let toolName = 'batshit_server_overwrite_file'
  if (kinds.has('update')) {
    toolName = 'batshit_server_edit_file'
  } else if (kinds.has('add')) {
    toolName = 'batshit_server_overwrite_file'
  } else if (kinds.has('delete') || kinds.has('rename') || kinds.has('move')) {
    toolName = 'batshit_server_execute_command'
  }

  const args: Record<string, any> = {}
  if (primaryPath) {
    args.filePath = primaryPath
    args.path = primaryPath
  }
  if (paths.length > 1) {
    args.paths = paths
  }

  const result: Record<string, any> = {
    changes: safeChanges,
    ...(primaryPath ? { filePath: primaryPath } : {}),
    ...(paths.length > 1 ? { filePaths: paths } : {})
  }

  if (toolName === 'batshit_server_execute_command') {
    const kind = kinds.has('delete')
      ? 'delete'
      : kinds.has('rename')
      ? 'rename'
      : kinds.has('move')
      ? 'move'
      : 'change'
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
  private readonly fileSnapshots = new Map<string, string>();
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

  private async captureFileSnapshot(filePath: unknown): Promise<void> {
    if (typeof filePath !== "string" || filePath.trim().length === 0) return;
    const projectPath =
      typeof this.request.projectPath === "string" ? this.request.projectPath : null;
    const snapshotKey = normalizeSnapshotPath(filePath, projectPath);
    if (!snapshotKey || this.fileSnapshots.has(snapshotKey)) return;

    const content = await readFileFromCommander(filePath, projectPath);
    if (typeof content === "string") {
      this.fileSnapshots.set(snapshotKey, content);
    }
  }

  private async buildEditDiff(options: {
    filePath: string;
    projectPath: string | null;
    after: string;
    inputPreview?: string;
  }): Promise<string> {
    const snapshotKey = normalizeSnapshotPath(options.filePath, options.projectPath);
    const before =
      snapshotKey && this.fileSnapshots.has(snapshotKey)
        ? this.fileSnapshots.get(snapshotKey)
        : undefined;

    const snapshotDiff =
      typeof before === "string"
        ? buildCompactEditPreview({
            filePath: options.filePath,
            before,
            after: options.after,
          })
        : undefined;
    const gitDiff =
      snapshotDiff || options.inputPreview
        ? null
        : await readGitDiffForFile(options.filePath, options.projectPath);

    return (
      options.inputPreview ??
      snapshotDiff ??
      gitDiff ??
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
          await this.captureFileSnapshot(args?.filePath ?? args?.path ?? args?.input);
        }
        break;
      }

      case "file_change": {
        const resolved = resolveFileChangeTool(
          Array.isArray(item.changes) ? item.changes : undefined,
        );
        const args: Record<string, any> = {
          ...resolved.args,
          ...(item.changes ? { changes: item.changes } : {}),
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
        if (resolved.toolName === "batshit_server_edit_file") {
          await this.captureFileSnapshot(args?.filePath ?? args?.path);
        }
        break;
      }

      case "mcp_tool_call": {
        const toolName = `mcp.${item.server}.${item.tool}`;
        const isSubagentCall = hasSubagentToolSegment(toolName);
        const args = isSubagentCall
          ? {
              // Flatten to the standard subagent arg shape so CallSubagentRenderer
              // can display the request cleanly.
              chatInput:
                (item.arguments as any)?.chatInput ??
                (item.arguments as any)?.prompt ??
                (item.arguments as any)?.input ??
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
      if (tracked.toolName === "batshit_server_read_file") {
        const filePath =
          tracked.args?.filePath ?? tracked.args?.path ?? tracked.args?.input;
        toolResult = {
          content: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...(filePath ? { filePath } : {}),
        };
        const snapshotKey = normalizeSnapshotPath(filePath, projectPath);
        if (snapshotKey && typeof toolResult.content === "string") {
          this.fileSnapshots.set(snapshotKey, toolResult.content);
        }
      } else if (tracked.toolName === "batshit_server_overwrite_file") {
        const filePath =
          tracked.args?.filePath ?? tracked.args?.path ?? tracked.args?.input;
        toolResult = {
          output: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...(filePath ? { filePath } : {}),
        };
        if (typeof filePath === "string") {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") {
            toolResult.content = content;
            const snapshotKey = normalizeSnapshotPath(filePath, projectPath);
            if (snapshotKey) {
              this.fileSnapshots.set(snapshotKey, content);
            }
          } else if (toolResult.content === undefined) {
            toolResult.content = "(content unavailable from codex command_execution)";
          }
        }
      } else if (tracked.toolName === "batshit_server_edit_file") {
        const filePath =
          tracked.args?.filePath ?? tracked.args?.path ?? tracked.args?.input;
        toolResult = {
          output: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
          ...(filePath ? { filePath } : {}),
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
        if (typeof filePath === "string") {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") {
            const snapshotKey = normalizeSnapshotPath(filePath, projectPath);
            toolResult.diff = await this.buildEditDiff({
              filePath,
              projectPath,
              after: content,
              inputPreview,
            });
            if (snapshotKey) {
              this.fileSnapshots.set(snapshotKey, content);
            }
          } else if (toolResult.diff === undefined) {
            toolResult.diff =
              inputPreview ??
              `Updated ${filePath}. Diff unavailable because Batshit could not reconstruct the before/after change.`;
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
        };
      }
    } else if (item.type === "file_change") {
      const resolved = resolveFileChangeTool(
        Array.isArray(item.changes) ? item.changes : undefined,
      );
      tracked.toolName = resolved.toolName;
      tracked.args = {
        ...resolved.args,
        ...(tracked.args || {}),
        ...(item.changes ? { changes: item.changes } : {}),
      };
      toolResult = {
        ...resolved.result,
        status: item.status,
      };

      const projectPath =
        typeof this.request.projectPath === "string"
          ? this.request.projectPath
          : null;
      const filePath =
        toolResult?.filePath || tracked.args?.filePath || tracked.args?.path;
      const snapshotKey =
        typeof filePath === "string"
          ? normalizeSnapshotPath(filePath, projectPath)
          : null;

      if (resolved.toolName === "batshit_server_overwrite_file") {
        if (typeof filePath === "string") {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") {
            toolResult.content = content;
            if (snapshotKey) {
              this.fileSnapshots.set(snapshotKey, content);
            }
          } else if (toolResult.content === undefined) {
            toolResult.content =
              "(content unavailable from codex file_change)";
          }
        } else if (toolResult.content === undefined) {
          toolResult.content = "(content unavailable from codex file_change)";
        }
      }

      if (resolved.toolName === "batshit_server_edit_file") {
        if (typeof filePath === "string") {
          const content = await readFileFromCommander(filePath, projectPath);
          if (typeof content === "string") {
            toolResult.diff = await this.buildEditDiff({
              filePath,
              projectPath,
              after: content,
            });
            if (snapshotKey) {
              this.fileSnapshots.set(snapshotKey, content);
            }
          } else if (toolResult.diff === undefined) {
            toolResult.diff = `Updated ${filePath}. Diff unavailable because Batshit could not reconstruct the before/after change.`;
          }
        } else if (toolResult.diff === undefined) {
          toolResult.diff =
            "Updated file. Diff unavailable because Batshit could not reconstruct the before/after change.";
        }
      }
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
    const zipControl = extractAndStripToolZipControl(toolResult);
    if (zipControl.zipId) {
      toolResult = zipControl.value;
      this.request.registerReservedToolZipId?.({
        toolCallId: tracked.id,
        toolName: displayToolName,
        zipId: zipControl.zipId,
      });
    }
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
