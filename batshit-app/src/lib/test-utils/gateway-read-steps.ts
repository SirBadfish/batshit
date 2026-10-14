/**
 * BL-418: a file read through a gateway MCP tool, as the API lane hands it to the zip adapter.
 *
 * Real shapes, not invented ones:
 * - The MCP results are what `@modelcontextprotocol/server-filesystem` 2026.8.31 (isolated test driver's
 *   "Filesystem STDIO" gateway) answered for `read_file` on a five-line file, captured over stdio
 *   on 2026-09-27;
 *   only the file's path is replaced. `head`/`tail` return part of the file and say nothing about
 *   it in the result; a missing file is `isError`.
 * - The broker output is `executeDynamicMcpUse`'s (`dynamicMcpTools.ts`) plus the fields
 *   `nativeBatshitToolUse` adds (`nativeTools.ts`).
 * - The step is built the way `send-routed` builds `stepForZip`: the model's input through
 *   `normalizeToolArgs`, and its private `normalizeToolResult`, which copies `filePath` and the
 *   input into the result. Stored through `adaptCoolToolsToZipSystem`, it gives the reference
 *   `dynamic_use: read_file - success - N lines`, the one the SA-129 P2b live run stored
 *   (`_local/sa129-proof/p2b/approval-api-run2-gateway-read.json`).
 */
import { normalizeToolArgs } from '$lib/server/services/sseToolNormalization'

export const GATEWAY_READ_FILE_TEXT = 'line one\nline two\nline three\nline four\nline five\n'

/** What the server answered, by call. */
export const FILESYSTEM_MCP_READ_RESULTS = {
  whole: {
    content: [{ type: 'text', text: GATEWAY_READ_FILE_TEXT }],
    structuredContent: { content: GATEWAY_READ_FILE_TEXT }
  },
  head2: {
    content: [{ type: 'text', text: 'line one\nline two' }],
    structuredContent: { content: 'line one\nline two' }
  },
  tail2: {
    content: [{ type: 'text', text: 'line five\n' }],
    structuredContent: { content: 'line five\n' }
  },
  /** `head: 0` is falsy to the server, which then reads the whole file. */
  head0: {
    content: [{ type: 'text', text: GATEWAY_READ_FILE_TEXT }],
    structuredContent: { content: GATEWAY_READ_FILE_TEXT }
  },
  missing: (path: string) => ({
    content: [{ type: 'text', text: `ENOENT: no such file or directory, open '${path}'` }],
    isError: true
  })
} as const

/** The same answer for a file of `lines` lines (the server returns the file's text as it is). */
export function filesystemMcpWholeRead(lines: number) {
  const text = Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  return { content: [{ type: 'text', text }], structuredContent: { content: text } }
}

let stepCounter = 0

/**
 * One gateway `read_file` call as `send-routed` hands it to `adaptCoolToolsToZipSystem`.
 * `input` is the `input` the model sent to `native_batshit_tool_use` for `mcp:<toolName>`; `call`,
 * when given, is the model's whole tool input instead (top-level keys, `params`, `input`).
 */
export function gatewayReadStep(options: {
  input?: Record<string, unknown>
  call?: Record<string, unknown>
  result: unknown
  toolName?: string
  sessionId: string
}) {
  stepCounter += 1
  const toolName = options.toolName ?? 'read_file'
  const args = normalizeToolArgs(options.call ?? { ref: `mcp:${toolName}`, input: options.input ?? {} })
  const brokerOutput = {
    success: true,
    toolName,
    requestedToolName: toolName,
    result: options.result,
    executionTimeMs: 12,
    gatewayId: 'megasmoke_filesystem_stdio_gateway',
    gatewayName: 'Filesystem STDIO',
    groupName: 'Filesystem Tools',
    originalToolName: toolName,
    ref: `mcp:${toolName}`,
    family: 'mcp',
    target: toolName,
    operationKind: 'dynamic_use',
    rendererFamily: 'generic_tool'
  }
  // `send-routed`'s `normalizeToolResult` for an object result: `filePath` from the input, and
  // the input itself.
  const resultPayload = {
    ...brokerOutput,
    ...(typeof args.filePath === 'string' ? { filePath: args.filePath } : {}),
    input: args
  }
  return {
    toolName: 'native_batshit_tool_use',
    originalToolName: 'native_batshit_tool_use',
    toolInput: args,
    toolArgs: args,
    toolResult: resultPayload,
    toolCallId: `toolu_gateway_read_${stepCounter}`,
    timestamp: new Date().toISOString(),
    metadata: { sessionId: options.sessionId },
    toolProvider: 'batshit-server',
    toolSource: 'native-tool',
    mcpServerName: 'batshit-native'
  }
}
