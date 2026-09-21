/**
 * F-P6-5 — a shell command that a lane normalizes into a file action (read, write, edit, list,
 * search), in the shapes each lane really produces, and the step send-routed hands to
 * `adaptCoolToolsToZipSystem` for it.
 *
 * - Codex: the managed app-server lane's `command_execution` items, captured in the SA-120 P6
 *   live proof (2026-09-17, gpt-5.5, `_local/typesafe/p6-proof/p6-codex-2-silent-failure.raw.json`).
 *   `codexAppServerLane.ts` maps `exitCode` to `exit_code` only when it is a number, and maps a
 *   declined or cancelled command to `failed`, so a `failed` item can carry no exit code.
 * - Claude: what Claude Code reports for a Bash call. A non-zero exit is `is_error: true`, the
 *   block content is `Exit code N\n<output>`, and `tool_use_result` is the same text behind
 *   `Error: `; a success is `{ stdout, stderr, interrupted, isImage, noOutputExpected }`; a command
 *   Claude Code refused before it ran is `is_error: true` with its own words and no framing.
 *   Trimmed from real Claude Code transcripts.
 * - API: the `native_bash_execute` result (`nativeBashExecute` in `nativeTools.ts`: `success` is
 *   `exitCode === 0`, plus the mapper's `mappedToolName`/`mappedToolInput`/`mappedReason`), as the
 *   P6 proof captured it (`p6-api-5-silent-failure.raw.json`); the sandbox name is anonymized.
 *
 * Keep them faithful: F-P5-2 lived behind a fake that did not match the real shape.
 */
import { normalizeToolArgs, parseJsonLike } from '$lib/server/services/sseToolNormalization'
import { mapBashCommandToRendererTool, resolveNativeBashMapping } from '$lib/server/services/bashCommandMapper'
import { buildSnapshotEditPreview, extractManagedPatchFromSource } from '$lib/utils/editDiff'

export const MISSING_FILE_PATH = '/definitely/not/a/real/file.txt'
export const MISSING_FILE_COMMAND = `cat ${MISSING_FILE_PATH}`
export const MISSING_FILE_ERROR = `cat: ${MISSING_FILE_PATH}: No such file or directory\n`

export const PRESENT_FILE_PATH = '/tmp/batshit-example/notes.md'
export const PRESENT_FILE_COMMAND = `cat ${PRESENT_FILE_PATH}`
export const PRESENT_FILE_CONTENT = '# Notes\n\nFirst line.\nSecond line.\n'

type CodexCommandOptions = {
  id: string
  /** The inner command; Codex wraps it in the login shell the way the live run did. */
  command: string
  output: string
  /** Omitted when the app-server lane had no numeric exit code. */
  exitCode?: number
  status: 'completed' | 'failed'
}

/**
 * The login-shell line Codex reports for an inner command: single quotes, or double quotes when
 * the command has a single quote of its own (the F-P6-5 live capture:
 * `/bin/zsh -lc "sed -i.bak 's/a/b/' /definitely/…"`).
 */
function codexShellLine(command: string): string {
  return command.includes("'")
    ? `/bin/zsh -lc "${command.replace(/(["\\$`])/g, '\\$1')}"`
    : `/bin/zsh -lc '${command}'`
}

/** `item.started` and `item.completed` for one command, as the Codex event adapter receives them. */
export function codexCommandEvents(options: CodexCommandOptions): any[] {
  const command = codexShellLine(options.command)
  return [
    {
      type: 'item.started',
      item: {
        id: options.id,
        type: 'command_execution',
        command,
        aggregated_output: '',
        status: 'in_progress'
      }
    },
    {
      type: 'item.completed',
      item: {
        id: options.id,
        type: 'command_execution',
        command,
        aggregated_output: options.output,
        ...(typeof options.exitCode === 'number' ? { exit_code: options.exitCode } : {}),
        status: options.status
      }
    }
  ]
}

type ClaudeBashOptions = {
  id: string
  command: string
  isError: boolean
  /** The `tool_result` block's `content`. */
  content: string
  /** The event's top-level `tool_use_result`. */
  toolUseResult: unknown
}

/** An assistant `tool_use` for Bash and the user event that answers it, as Claude Code streams them. */
export function claudeBashEvents(options: ClaudeBashOptions): any[] {
  return [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: options.id,
            name: 'Bash',
            input: { command: options.command, description: 'Read the file' }
          }
        ]
      }
    },
    {
      type: 'user',
      tool_use_result: options.toolUseResult,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: options.id,
            content: options.content,
            ...(options.isError ? { is_error: true } : {})
          }
        ]
      }
    }
  ]
}

export function claudeFailedBashEvents(id: string): any[] {
  const text = `Exit code 1\n${MISSING_FILE_ERROR.trimEnd()}`
  return claudeBashEvents({
    id,
    command: MISSING_FILE_COMMAND,
    isError: true,
    content: text,
    toolUseResult: `Error: ${text}`
  })
}

export function claudePresentBashEvents(id: string): any[] {
  return claudeBashEvents({
    id,
    command: PRESENT_FILE_COMMAND,
    isError: false,
    content: PRESENT_FILE_CONTENT.trimEnd(),
    toolUseResult: {
      stdout: PRESENT_FILE_CONTENT.trimEnd(),
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false
    }
  })
}

/**
 * send-routed's private `normalizeToolResult`, mirrored for the shapes the CLI lanes produce: an
 * object is copied, `filePath` falls back to the arguments, and the arguments ride along as
 * `input`; a string stays a string (a read's becomes `{ content, filePath }`), because a Claude
 * result can be the error text itself.
 */
function sendRoutedToolResult(raw: unknown, toolName: string, args: Record<string, any>): unknown {
  const parsed = parseJsonLike(raw)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const result: Record<string, any> = { ...(parsed as Record<string, any>) }
    if (!result.filePath) {
      if (typeof result.file_path === 'string') result.filePath = result.file_path
      else if (typeof result.path === 'string') result.filePath = result.path
      else if (typeof args.filePath === 'string') result.filePath = args.filePath
    }
    if (!result.content && typeof result.newContent === 'string') result.content = result.newContent
    if (!result.content && typeof result.updatedContent === 'string') result.content = result.updatedContent
    if (result.input === undefined && Object.keys(args).length > 0) result.input = args
    return result
  }
  if (typeof parsed === 'string' && toolName.toLowerCase().endsWith('read_file')) {
    return { content: parsed, filePath: args.filePath }
  }
  return parsed
}

/**
 * The step send-routed's `case 'tool-result'` builds for a CLI lane's `tool-result` chunk before
 * it calls `adaptCoolToolsToZipSystem` (the live zip, not the finish-time copy), with the result
 * through `sendRoutedToolResult`. `resolveToolMetadata` is the lane adapter's own
 * `getToolMetadataResolver()`.
 */
export function cliStepForZip(
  chunk: Record<string, any>,
  resolveToolMetadata: (toolName: string) => Record<string, any>,
  sessionId: string
): Record<string, any> {
  const args = normalizeToolArgs(chunk.input ?? chunk.args ?? {})
  const raw = chunk.output ?? chunk.result ?? chunk.data ?? chunk.content
  const result = sendRoutedToolResult(raw, String(chunk.toolName ?? ''), args)
  return {
    toolName: chunk.toolName,
    originalToolName: chunk.toolName,
    toolInput: args,
    toolArgs: args,
    toolResult: result,
    toolCallId: chunk.toolCallId,
    timestamp: '2026-09-17T08:37:29.415Z',
    metadata: { sessionId },
    ...resolveToolMetadata(chunk.toolName),
    ...(chunk.metadata ?? {})
  }
}

type ApiShellOptions = {
  id: string
  command: string
  stdout?: string
  stderr?: string
  exitCode: number
  /**
   * The edit target's text read just before and just after the run. `nativeBashExecute` reads it
   * only for a command mapped to `edit_file` that carries no patch of its own, whose target is
   * inside the workspace, text, and at most 24,000 bytes (an empty file is a copy); it reads the
   * after-copy only for a clean run (exit 0, no timeout), and it returns their `diff`, never the
   * copies.
   */
  snapshots?: { before: string; after: string }
}

/**
 * What `nativeBashExecute` returns for a command that ran (`nativeTools.ts`): `success` is
 * `exitCode === 0`, the mapper's classification rides along, and a clean edit carries the `diff`
 * of its target's two copies.
 */
export function apiNativeBashResult(options: ApiShellOptions): Record<string, any> {
  const mapping = mapBashCommandToRendererTool(options.command)
  const mappedPath =
    typeof mapping.args?.filePath === 'string'
      ? mapping.args.filePath
      : typeof mapping.args?.path === 'string'
        ? mapping.args.path
        : undefined
  const diff =
    options.snapshots &&
    mapping.toolName === 'batshit_server_edit_file' &&
    !extractManagedPatchFromSource(options.command) &&
    options.exitCode === 0
      ? buildSnapshotEditPreview({
          filePath: mappedPath,
          before: options.snapshots.before,
          after: options.snapshots.after
        })
      : undefined
  return {
    success: options.exitCode === 0,
    blocked: false,
    command: `container exec --workdir /Users/example/batshit batshit-apple-sandbox-example-s0000 bash -lc ${options.command}`,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    exitCode: options.exitCode,
    signal: null,
    timedOut: false,
    durationMs: 104,
    truncated: false,
    policyMode: 'workspace',
    accessMode: 'agent',
    backend: 'apple_container',
    backendLabel: 'Apple Container Sandbox',
    cwd: '/Users/example/batshit',
    workspaceRoot: '/Users/example/batshit',
    sandboxName: 'batshit-apple-sandbox-example-s0000',
    mappedToolName: mapping.toolName,
    mappedToolInput: mapping.args,
    mappedReason: mapping.reason,
    ...(diff !== undefined ? { diff } : {})
  }
}

/**
 * The step send-routed's `case 'tool-result'` builds for an API `native_bash_execute` result
 * before it calls `adaptCoolToolsToZipSystem`: the arguments through `normalizeToolArgs`, the
 * result through its private `normalizeToolResult` (mirrored: a copy with `input`), then
 * `resolveNativeBashMapping` names the file lane and stamps the mapping fields. The source
 * metadata is `vercelBrain`'s for a native tool.
 */
export function apiShellStep(options: ApiShellOptions, sessionId = 'session-shell-command'): Record<string, any> {
  const toolName = 'native_bash_execute'
  const args = normalizeToolArgs({ command: options.command })
  const resultPayload: Record<string, any> = { ...apiNativeBashResult(options), input: args }
  const mapping = resolveNativeBashMapping({ toolName, args, result: resultPayload })
  if (!mapping) throw new Error(`no native bash mapping for ${options.command}`)
  return {
    toolName: mapping.mappedToolName,
    originalToolName: toolName,
    toolInput: mapping.mappedArgs,
    toolArgs: mapping.mappedArgs,
    toolResult: {
      ...resultPayload,
      originalToolName: toolName,
      mappedToolName: mapping.mappedToolName,
      mappedReason: mapping.reason
    },
    toolCallId: options.id,
    timestamp: '2026-09-17T08:34:43.845Z',
    metadata: { sessionId },
    toolProvider: 'batshit-server',
    toolSource: 'native-tool',
    mcpServerName: 'batshit-native'
  }
}

/** The API lane's step for the same failed read as the Codex proof. */
export function apiFailedReadStep(): Record<string, any> {
  return apiShellStep({
    id: 'toolu_api_failed_read_1',
    command: MISSING_FILE_COMMAND,
    stderr: `cat: can't open '${MISSING_FILE_PATH}': No such file or directory\n`,
    exitCode: 1
  })
}

type CodexFileChangeOptions = {
  id: string
  changes: Array<{ path: string; kind: 'add' | 'update' | 'delete' }>
  status: 'completed' | 'failed'
}

/** `item.started` and `item.completed` for a Codex native patch (`file_change`). */
export function codexFileChangeEvents(options: CodexFileChangeOptions): any[] {
  return [
    {
      type: 'item.started',
      item: { id: options.id, type: 'file_change', changes: options.changes, status: 'in_progress' }
    },
    {
      type: 'item.completed',
      item: { id: options.id, type: 'file_change', changes: options.changes, status: options.status }
    }
  ]
}
