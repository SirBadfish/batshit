/**
 * F-P5-2 — a zip fetch whose fetched zip is itself a tool result, in the shapes each lane
 * really hands to `adaptCoolToolsToZipSystem`.
 *
 * Captured from the SA-120 P5 live proof (2026-09-17, `_local/typesafe/p5-proof/`) and
 * trimmed; ids and the sandbox name are anonymized. Keep them faithful. The defect lived
 * behind a fake that nested the fetch payload under `result` with plain-text content, while
 * the real API broker spreads the payload at the top level and the content is the fetched
 * zip's stored JSON body — which is itself a normalized tool payload.
 */

export const FETCHED_ZIP_ID = 'cool_tool_1789624908784_kd008'
export const FETCHED_ZIP_DESCRIPTION = 'bash: git log --oneline -5 - error - 11 lines'
export const MANAGED_HELPER_SERVER = 'batshit_gateway_example-mode4-controls'

/** A cool_tool zip body exactly as `coolToolZipAdapter` stores it (here, a bash call). */
export function storedBashToolPayload(): Record<string, any> {
  return {
    schemaVersion: 1,
    type: 'tool',
    toolName: 'bash',
    displayToolName: 'native_bash_execute',
    originalToolName: 'native_bash_execute',
    operationKind: 'bash',
    rendererFamily: 'bash',
    toolCallId: 'toolu_fetched_bash_1',
    toolArgs: {
      command: 'git log --oneline -5',
      innerCommand: 'git log --oneline -5'
    },
    toolResult: {
      command: 'git log --oneline -5',
      innerCommand: 'git log --oneline -5',
      stdout: '',
      stderr: '',
      exitCode: 0,
      interrupted: false,
      isImage: false,
      stdoutTruncated: false,
      stderrTruncated: false
    },
    // The adapter's circular replacer writes this, because `observation` IS `toolResult`.
    observation: '[Circular]',
    error:
      '[6/6] Starting container [0s]\nError: failed to create container (cause: "exists: "container already exists: batshit-apple-sandbox-example-s0000""")',
    timestamp: '2026-09-17T06:01:49.655Z',
    toolProvider: 'batshit-server',
    toolSource: 'native-tool',
    mcpServerName: 'batshit-native',
    rawSidecar: { status: 'not_retained', reason: 'compact-main-payload' },
    storage: { compacted: false, truncated: false, binaryLikeOmitted: false, forceCompress: false },
    metadata: {
      sessionId: 'session-fetch-1',
      mcpServerName: 'batshit-native',
      operationKind: 'bash',
      rendererFamily: 'bash',
      forceCompress: false,
      compacted: false,
      truncated: false,
      binaryLikeOmitted: false
    }
  }
}

/** The fetched zip's stored body: one line of JSON, as `createZipFromContent` keeps it. */
export function fetchedZipContent(): string {
  return JSON.stringify(storedBashToolPayload())
}

/** The fetched zip record's own metadata, which names the INNER tool. */
export function fetchedZipMetadata(): Record<string, any> {
  return {
    sessionId: 'session-fetch-1',
    messageId: 'msg_20260917-020142_0002',
    toolName: 'bash',
    displayToolName: 'native_bash_execute',
    operationKind: 'bash',
    rendererFamily: 'bash',
    zipDescriptionLabel: 'bash',
    zipDescriptionTarget: 'git log --oneline -5',
    zipDescriptionStatus: 'error',
    zipDescriptionSize: '11 lines',
    toolIndex: 0,
    tokens: 21,
    aiTokens: 21,
    promptTokens: 21,
    tokenBasis: 'ai_expanded',
    originalType: 'cool_tool',
    toolCallId: 'toolu_fetched_bash_1',
    toolProvider: 'batshit-server',
    toolSource: 'native-tool',
    forceCompress: false,
    resultLineCount: 11,
    contentLineCount: 11
  }
}

/** What the `sys.zip.fetch` control returns (`nativeFetchZip` and `executeZipFetch` agree). */
export function zipFetchControlResult(): Record<string, any> {
  const content = fetchedZipContent()
  return {
    found: true,
    zipId: FETCHED_ZIP_ID,
    type: 'cool_tool',
    tokens: 21,
    description: FETCHED_ZIP_DESCRIPTION,
    createdAt: 1789624909655,
    metadata: fetchedZipMetadata(),
    content,
    contentLength: content.length,
    contentTruncated: false
  }
}

/**
 * API lane: `native_batshit_tool_use` as send-routed hands it to the adapter. The broker
 * spreads the native helper's payload at the TOP level (`executeBatshitToolUse`), and
 * `normalizeToolArgs` flattens the model's `input` beside the ref.
 */
export function apiBrokeredZipFetchStep(): Record<string, any> {
  const args = { ref: 'fabric:sys.zip.fetch', zipId: FETCHED_ZIP_ID }
  return {
    toolName: 'native_batshit_tool_use',
    originalToolName: 'native_batshit_tool_use',
    toolInput: { ...args },
    toolArgs: { ...args },
    toolResult: {
      success: true,
      ...zipFetchControlResult(),
      controlId: 'sys.zip.fetch',
      riskLevel: 'safe',
      status: 'published',
      ref: 'fabric:sys.zip.fetch',
      family: 'fabric',
      target: 'sys.zip.fetch',
      operationKind: 'fetch_zip',
      rendererFamily: 'generic_tool',
      input: { ...args }
    },
    toolCallId: 'toolu_api_fetch_1',
    timestamp: 1789624921525,
    toolProvider: 'batshit-server',
    toolSource: 'native-tool',
    mcpServerName: 'batshit-native',
    success: true
  }
}

/** What the managed CLI helper's direct `batshit_server_fetch_zip` returns (`formatFetchZipResult`). */
export function directHelperZipFetchOutput(): Record<string, any> {
  const fetched = zipFetchControlResult()
  return {
    success: true,
    tool: 'fetch_zip',
    zipId: FETCHED_ZIP_ID,
    truncated: false,
    totalLength: fetched.contentLength,
    content: fetched.content,
    metadata: {
      type: fetched.type,
      tokens: fetched.tokens,
      description: fetched.description,
      ...fetched.metadata
    }
  }
}

/**
 * Managed Codex lane, direct helper: Codex wraps every helper call's arguments in
 * `{ arguments }` and its result in an MCP text envelope; send-routed adds `input`.
 */
export function codexDirectZipFetchStep(): Record<string, any> {
  const args = { arguments: { zipId: FETCHED_ZIP_ID, includeContent: true, maxChars: 20000 } }
  return {
    toolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_server_fetch_zip`,
    originalToolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_server_fetch_zip`,
    toolInput: args,
    toolArgs: args,
    toolResult: {
      content: [{ type: 'text', text: JSON.stringify(directHelperZipFetchOutput(), null, 2) }],
      structured_content: null,
      input: args
    },
    toolCallId: 'call_codex_fetch_1',
    timestamp: 1789624876250,
    toolProvider: 'mcp',
    toolSource: 'mcp-gateway',
    mcpServerName: MANAGED_HELPER_SERVER,
    success: true
  }
}

/**
 * Managed Claude lane, direct helper: Claude's `tool_use_result` is a one-item text array,
 * which send-routed's `normalizeToolResult` parses into the helper's object (plus `input`).
 */
export function claudeDirectZipFetchStep(): Record<string, any> {
  const args = { zipId: FETCHED_ZIP_ID, includeContent: true }
  return {
    toolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_server_fetch_zip`,
    originalToolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_server_fetch_zip`,
    toolInput: args,
    toolArgs: args,
    toolResult: { ...directHelperZipFetchOutput(), input: args },
    toolCallId: 'toolu_claude_fetch_1',
    timestamp: 1789624876250,
    toolProvider: 'mcp',
    toolSource: 'mcp-gateway',
    mcpServerName: MANAGED_HELPER_SERVER,
    success: true
  }
}

/**
 * Managed CLI lanes, broker: `batshit_tool_use` with a `fabric:` ref goes through
 * `/api/controls/use`, so the control's result stays nested under `result`, and the helper
 * stamps the presentation on top. Pass the helper's real MCP text (see the black-box test).
 */
export function codexBrokeredZipFetchStep(helperText: string): Record<string, any> {
  const args = { arguments: { ref: 'fabric:sys.zip.fetch', input: { zipId: FETCHED_ZIP_ID } } }
  return {
    toolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_tool_use`,
    originalToolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_tool_use`,
    toolInput: args,
    toolArgs: args,
    toolResult: {
      content: [{ type: 'text', text: helperText }],
      structured_content: null,
      input: args
    },
    toolCallId: 'call_codex_broker_fetch_1',
    timestamp: 1789624876250,
    toolProvider: 'mcp',
    toolSource: 'mcp-gateway',
    mcpServerName: MANAGED_HELPER_SERVER,
    success: true
  }
}

export function claudeBrokeredZipFetchStep(helperText: string): Record<string, any> {
  const args = { ref: 'fabric:sys.zip.fetch', zipId: FETCHED_ZIP_ID }
  return {
    toolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_tool_use`,
    originalToolName: `mcp.${MANAGED_HELPER_SERVER}.batshit_tool_use`,
    toolInput: args,
    toolArgs: args,
    toolResult: { ...JSON.parse(helperText), input: args },
    toolCallId: 'toolu_claude_broker_fetch_1',
    timestamp: 1789624876250,
    toolProvider: 'mcp',
    toolSource: 'mcp-gateway',
    mcpServerName: MANAGED_HELPER_SERVER,
    success: true
  }
}

/** The body `/api/controls/use` answers a `sys.zip.fetch` call with (agent lane). */
export function controlsUseZipFetchBody(): Record<string, any> {
  return {
    auth: 'agent',
    userId: 'user-1',
    actingAgentId: 'agent-1',
    success: true,
    controlId: 'sys.zip.fetch',
    dryRun: false,
    riskLevel: 'safe',
    status: 'published',
    result: zipFetchControlResult()
  }
}
