/**
 * Tool Result Processor
 * Processes intermediate steps from tool transports and converts them to properly formatted segments
 * This enables beautiful rendering of tool results without requiring AI to add XML tags
 */

import {
  detectLanguage,
  getToolSettings,
  canonicalToolName,
} from "./toolRenderMap";
import { detectToolSource } from "./toolSourceDetector";
import { extractManagedPatchFromSources } from "./editDiff";
import { logger } from '$lib/utils/logger'
import type { IntermediateStep, ToolProvider, ToolSource } from './toolStepTypes'
import { unwrapDynamicMcpUsePayload } from './toolPayloadUnwrap'
import {
  commandFoundNothing,
  failedCommandExitCode,
  failedCommandOutput,
  joinListingSectionPath,
  shellActionCommand,
  shellCommandFailed,
  splitLsSections,
  stripShellErrorLines
} from './toolActivityContract'
import { estimateTokens } from './tokens'
export type { IntermediateStep } from './toolStepTypes'

/** The lanes a shell command becomes when it is stored as a file action (never bash). */
const MAPPED_SHELL_FILE_LANES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
]);

const NON_SUBAGENT_OPERATION_KINDS = new Set([
  "artifact_find",
  "artifact_use",
  "fabric_find",
  "fabric_use",
  "dynamic_find",
  "dynamic_use",
  "tool_find",
  "cli_tool",
  "agent_browser_find",
  "agent_browser_use",
  "fetch_zip",
])

function parseMaybeJsonValue(value: any): any {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function normalizeOperationHint(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return normalized || null
}

function familyFromTypedRef(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = value.trim().match(/^([a-z_]+):/i)
  return match?.[1]?.toLowerCase() ?? null
}

function extractExplicitNonSubagentOperationKind(step: IntermediateStep, args: any, result: any): string | null {
  const parsedResult = parseMaybeJsonValue(result)
  const resultRecord = parsedResult && typeof parsedResult === "object" && !Array.isArray(parsedResult)
    ? parsedResult
    : null
  const argsRecord = args && typeof args === "object" && !Array.isArray(args) ? args : null
  const nestedArgs =
    argsRecord?.arguments && typeof argsRecord.arguments === "object" && !Array.isArray(argsRecord.arguments)
      ? argsRecord.arguments
      : argsRecord?.params && typeof argsRecord.params === "object" && !Array.isArray(argsRecord.params)
        ? argsRecord.params
        : null

  const explicit = [
    normalizeOperationHint((step as any).operationKind),
    normalizeOperationHint((step as any).operation_kind),
    normalizeOperationHint(resultRecord?.operationKind),
    normalizeOperationHint(resultRecord?.operation_kind),
    normalizeOperationHint(argsRecord?.operationKind),
    normalizeOperationHint(argsRecord?.operation_kind),
    normalizeOperationHint(nestedArgs?.operationKind),
    normalizeOperationHint(nestedArgs?.operation_kind),
  ].find((hint) => hint && NON_SUBAGENT_OPERATION_KINDS.has(hint))

  if (explicit) return explicit

  const family = [
    resultRecord?.family,
    argsRecord?.family,
    nestedArgs?.family,
    familyFromTypedRef(resultRecord?.ref),
    familyFromTypedRef(argsRecord?.ref),
    familyFromTypedRef(nestedArgs?.ref),
  ]
    .map(normalizeOperationHint)
    .find(Boolean)

  switch (family) {
    case "artifact":
      return "artifact_use"
    case "fabric":
      return "fabric_use"
    case "mcp":
      return "dynamic_use"
    case "cli":
      return "cli_tool"
    case "agent_browser":
      return "agent_browser_use"
    default:
      return null
  }
}

// Segment type matching what MessageContent.svelte expects
export interface ContentSegment {
  id?: string;
  type:
    | "text"
    | "code"
    | "terminal"
    | "batshit"
    | "image"
    | "file"
    | "error"
    | "diff"
    | "cool_tool";
  content: string;
  language?: string;
  filename?: string;
  source?: string;
  tokens?: number;
  name?: string;
  path?: string;
  description?: string;
  // Image props
  src?: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
  // File props
  url?: string;
  size?: number;
  fileType?: string;
  // Error props
  errorTitle?: string;
  stack?: string;
  code?: string | number;
  // Zip detection props
  zipId?: string;
  zipType?: string;
  isZip?: boolean;
  // Tool result props
  toolName?: string;
  toolStatus?: string;
  toolData?: any;
  intermediateStep?: any;
  lineCount?: number;
  toolResult?: any;
  attrs?: any;
  subagentName?: string;
  agentName?: string;
  // Content type for Batshit zips
  contentType?: string;

  // Tool Source Detection (Epic 6.2)
  /** Identifies which system provided this tool (e.g., 'batshit-server', 'mcp', 'n8n-workflow') */
  toolProvider?: ToolProvider;
  /** Identifies how the tool was attached (e.g., 'direct-attachment', 'mcp-gateway') */
  toolSource?: ToolSource;
  /** Indicates if this tool call is a subagent execution */
  isSubagent?: boolean;
  /** Gateway context metadata (when toolSource === 'mcp-gateway') */
  gatewayId?: string;
  gatewayName?: string;
  gatewayType?: "docker" | "n8n-mcp-trigger" | "n8n-instance-mcp" | "custom" | "stdio";
  mcpServerName?: string;
}

/**
 * Process intermediate steps into renderable segments
 * This is the main entry point for converting tool results to visual blocks
 * Tool results will be automatically zipped if they exceed threshold
 */
export function processIntermediateSteps(
  intermediateSteps: IntermediateStep[] | undefined,
  agent?: any,
  sessionId?: string,
  messageId?: string,
  globalSettings?: any,
): ContentSegment[] {
  if (!intermediateSteps || intermediateSteps.length === 0) {
    return [];
  }

  const segments: ContentSegment[] = [];

  for (let i = 0; i < intermediateSteps.length; i++) {
    const step = normalizeToolStep(intermediateSteps[i]);
    const segment = createSegmentFromStep(step, agent);

    if (segment) {
      // Check if this segment should be zipped (all tools now use cool_tool threshold)
      const toolNameForZip = canonicalToolName(step.toolName || "tool");
      if (
        shouldZipToolResult(
          segment.content,
          toolNameForZip,
          agent,
          globalSettings,
        )
      ) {
        // Generate a unique zip ID for this tool result
        const zipId = generateToolZipId(step.toolName, Date.now() + i);
        segment.zipId = zipId;
        segment.isZip = true;
        segment.zipType = "cool_tool";

        // Note: The actual zip storage will happen when the message is saved
        // This just marks it as zippable with the necessary metadata
      }

      segments.push(segment);
    }
  }

  return segments;
}

/**
 * Create a properly formatted segment from an intermediate step
 */
function createSegmentFromStep(
  step: IntermediateStep,
  agent?: any,
): ContentSegment | null {
  // Detect tool source (Epic 6.2)
  const detected = detectToolSource(step);

  // Handle errors specially
  if (step.type === "tool_error" || step.type === "error") {
    return createErrorSegment(step, detected);
  }

  // All tools now go through cool_tool segments for Cool Tools rendering
  return createToolResultSegment(step, detected);
}

function getToolStatus(step: IntermediateStep): "success" | "error" {
  return step.type === "tool" && step.success !== false && !step.error
    ? "success"
    : "error";
}

/**
 * Create a terminal-style segment for command outputs
 */
function createTerminalSegment(
  step: IntermediateStep,
  agent?: any,
): ContentSegment {
  const content = formatToolResult(step, agent);
  const tokens = estimateTokens(content);

  return {
    type: "terminal",
    content: content,
    toolName: step.toolName,
    toolStatus: getToolStatus(step),
    tokens: tokens,
    name: `Tool: ${step.toolName}`,
    description: getToolDescription(step.toolName),
    // Note: zipId will be generated later if needed for zipping
  };
}

/**
 * Create a code segment with syntax highlighting
 */
function createCodeSegment(step: IntermediateStep): ContentSegment {
  const content = formatToolResult(step, undefined);
  const tokens = estimateTokens(content);
  const lineCount = content ? content.split("\n").length : 0;

  // Try to get file path from toolArgs first, then from parsed toolResult
  let filePath =
    step.toolArgs?.filePath || step.toolArgs?.path || step.toolArgs?.file_path;

  // Parse the toolResult to get metadata
  let metadata: any = null;
  try {
    let resultData = step.toolResult;
    if (typeof resultData === "string") {
      // First check if it's wrapped in an array with text property
      if (resultData.startsWith("[{")) {
        const parsed = JSON.parse(resultData);
        if (parsed[0]?.text) {
          resultData = JSON.parse(parsed[0].text);
        }
      } else if (resultData.startsWith("{")) {
        resultData = JSON.parse(resultData);
      }
    }

    // Extract metadata if available
    if (resultData?.metadata) {
      metadata = resultData.metadata;
      filePath = metadata.path || filePath;
    } else if (resultData?.absolutePath) {
      filePath = resultData.absolutePath;
    } else if (!filePath || !filePath.startsWith("/")) {
      // Fallback to filePath from result
      if (resultData?.filePath) {
        filePath = resultData.filePath;
      }
    }
  } catch {
    // Ignore parse errors; fall back to best-effort metadata.
  }

  const language = detectLanguage(filePath);

  // For write_file, show what was written to where
  let description = getToolDescription(step.toolName);
  if (step.toolName === "write_file" && filePath) {
    description = `Wrote to ${filePath}`;
  } else if (step.toolName === "read_file" && filePath) {
    description = filePath;
  } else if (filePath) {
    description = filePath;
  }

  return {
    type: "code",
    content: content,
    language: metadata?.language || language,
    filename: extractFilename(filePath),
    path: filePath,
    toolName: metadata?.toolName || step.toolName, // Use display name from metadata
    toolStatus: getToolStatus(step),
    tokens: tokens,
    lineCount: metadata?.lineCount || lineCount,
    // Don't set name here - let CodeRenderer build the title from parts
    description: description,
  };
}

/**
 * Create a diff segment for file changes
 */
function createDiffSegment(step: IntermediateStep): ContentSegment {
  const content = formatToolResult(step, undefined);
  const tokens = estimateTokens(content);
  const lineCount = content ? content.split("\n").length : 0;

  // Try to get file path from toolArgs first, then from parsed toolResult
  let filePath =
    step.toolArgs?.filePath || step.toolArgs?.path || step.toolArgs?.oldPath;

  // Parse the toolResult to get metadata
  let metadata: any = null;
  try {
    let resultData = step.toolResult;
    if (typeof resultData === "string") {
      // First check if it's wrapped in an array with text property
      if (resultData.startsWith("[{")) {
        const parsed = JSON.parse(resultData);
        if (parsed[0]?.text) {
          resultData = JSON.parse(parsed[0].text);
        }
      } else if (resultData.startsWith("{")) {
        resultData = JSON.parse(resultData);
      }
    } else if (Array.isArray(resultData) && resultData[0]?.text) {
      // Handle array format directly
      resultData = JSON.parse(resultData[0].text);
    }

    // Extract metadata if available
    if (resultData?.metadata) {
      metadata = resultData.metadata;
      filePath = metadata.path || filePath;
    } else if (resultData?.absolutePath) {
      filePath = resultData.absolutePath;
    } else if (!filePath || !filePath.startsWith("/")) {
      // Fallback logic
      if (step.toolArgs && typeof step.toolArgs === "object") {
        filePath = step.toolArgs.filePath || step.toolArgs.path || filePath;
      }
      if (resultData?.filePath && resultData.filePath.startsWith("/")) {
        filePath = resultData.filePath;
      }
    }
  } catch (e) {
    logger.debug(
      "[createDiffSegment] Could not parse toolResult for metadata:",
      e,
    );
  }

  const language = detectLanguage(filePath); // Add language detection for diffs too

  // Try to analyze the diff for a summary
  let description = "File changes";
  if (filePath) {
    const additions = (content.match(/^\+[^+]/gm) || []).length;
    const deletions = (content.match(/^-[^-]/gm) || []).length;

    if (additions > 0 || deletions > 0) {
      description = `${filePath} (+${additions}, -${deletions})`;
    } else {
      description = filePath;
    }
  }

  return {
    type: "diff",
    content: content,
    language: metadata?.language || language, // Use language from metadata if available
    path: filePath,
    filename: extractFilename(filePath),
    toolName: metadata?.toolName || step.toolName, // Use display name from metadata
    toolStatus: getToolStatus(step),
    tokens: tokens,
    lineCount: metadata?.lineCount || lineCount,
    // Don't set name here - let CodeRenderer build the title from parts
    description: description,
  };
}

/**
 * Create an error segment for tool failures
 */
function createErrorSegment(
  step: IntermediateStep,
  detected: ReturnType<typeof detectToolSource>,
): ContentSegment {
  const errorMessage = step.error || step.toolResult || "Tool execution failed";
  const tokens = estimateTokens(errorMessage);

  return {
    type: "error",
    content: errorMessage,
    errorTitle: `Error in ${step.toolName}`,
    toolName: step.toolName,
    toolStatus: "error",
    tokens: tokens,
    name: `Tool Error: ${step.toolName}`,
    description: "Tool execution failed",

    // Add tool source detection metadata (Epic 6.2)
    toolProvider: detected.toolProvider,
    toolSource: detected.toolSource,
    isSubagent: detected.isSubagent,
    gatewayId: step.gatewayId,
    gatewayName: step.gatewayName,
    gatewayType: step.gatewayType,
    mcpServerName: step.mcpServerName,
  };
}

function extractNestedIntermediateSteps(value: any, visited = new WeakSet<object>()): any[] | undefined {
  if (!value) return undefined;

  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  if (visited.has(parsed as object)) return undefined;
  visited.add(parsed as object);

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const nested = extractNestedIntermediateSteps(entry, visited);
      if (nested) return nested;
    }
    return undefined;
  }

  if (Array.isArray(parsed.intermediateSteps)) return parsed.intermediateSteps;
  if (Array.isArray(parsed.intermediate_steps)) return parsed.intermediate_steps;

  const outputSteps = extractNestedIntermediateSteps(parsed.output, visited);
  if (outputSteps) return outputSteps;

  const resultSteps = extractNestedIntermediateSteps(parsed.result, visited);
  if (resultSteps) return resultSteps;

  return extractNestedIntermediateSteps(parsed.toolResult, visited);
}

/**
 * Create a generic tool result segment for structured data
 */
function createToolResultSegment(
  step: IntermediateStep,
  detected: ReturnType<typeof detectToolSource>,
): ContentSegment {
  const explicitNonSubagentKind = extractExplicitNonSubagentOperationKind(
    step,
    step.toolArgs,
    step.toolResult,
  );
  // Special handling for subagent calls to preserve the full conversation data
  // Check if it's a subagent call by looking for the Prompt__User_Message_ field
  // (n8n uses the subagent name as the tool name, not 'call_subagent')
  const isSubagentCall =
    !explicitNonSubagentKind &&
    (
      step.toolName === "call_subagent" ||
      step.toolName === "subagent" ||
      step.isSubagent === true ||
      step.toolProvider === "subagent" ||
      (step.toolArgs && "Prompt__User_Message_" in step.toolArgs)
    );

  if (isSubagentCall) {
    // Parse the tool result to extract the conversation
    let parsedResult = step.toolResult;
    if (typeof parsedResult === "string") {
      try {
        parsedResult = JSON.parse(parsedResult);
      } catch {
        // Keep as string if parsing fails
      }
    }

    // Extract the input and output for the renderer
    const input =
      parsedResult?.input ||
      step.toolArgs?.Prompt__User_Message_ ||
      step.toolArgs?.prompt ||
      step.toolArgs;
    let output = parsedResult?.output ?? parsedResult?.result ?? parsedResult;

    // Prevent double-JSON when upstream already sends clean objects (SA-012/SA-013)
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        // leave as-is if not JSON
      }
    }
    // Use the tool name as the subagent name (since n8n uses the subagent name as the tool name)
    let subagentName =
      step.subagentName ||
      parsedResult?.subagentName ||
      (step.toolName !== "call_subagent" && step.toolName !== "subagent"
        ? step.toolName
        : step.toolArgs?.subagentName || "Subagent");
    let agentName = step.agentName || parsedResult?.agentName || step.toolArgs?.agentName || "Primary Agent";

    // If result is an array with output field, extract it
    if (Array.isArray(parsedResult) && parsedResult[0]?.output) {
      output = parsedResult;
    }
    const intermediateSteps = extractNestedIntermediateSteps(parsedResult);
    const intermediateStepToolResult =
      intermediateSteps &&
      parsedResult &&
      typeof parsedResult === "object" &&
      !Array.isArray(parsedResult) &&
      !Array.isArray(parsedResult.intermediateSteps)
        ? { ...parsedResult, intermediateSteps }
        : parsedResult;

    // Create a special tool result that preserves all the conversation data
    const toolResult = {
      input: input,
      output: output,
      subagentName: subagentName,
      agentName: agentName,
      toolName: "call_subagent",
      ...(intermediateSteps ? { intermediateSteps } : {}),
    };

    // Format for display (this will be used for text fallback)
    const content = formatToolResult(step, undefined);
    const tokens = estimateTokens(content);

    return {
      type: "cool_tool",
      content: content,
      toolName: "call_subagent", // Always use 'call_subagent' for the renderer lookup
      toolStatus: getToolStatus(step),
      tokens: tokens,
      name: `Subagent: ${subagentName}`,
      description: "Subagent conversation",
      toolResult: toolResult, // Pass the full structured data for the renderer
      // Include intermediateStep data so CoolToolRenderer will be used
      intermediateStep: {
        toolName: "call_subagent",
        toolArgs: step.toolArgs,
        toolResult: intermediateStepToolResult,
        error: step.error,
        ...(intermediateSteps ? { isSubagent: true } : {}),
      },
      // Pass additional data for the renderer
      subagentName: subagentName,
      agentName: agentName,

      // Add tool source detection metadata (Epic 6.2)
      toolProvider: detected.toolProvider,
      toolSource: detected.toolSource,
      isSubagent: detected.isSubagent,
      gatewayId: step.gatewayId,
      gatewayName: step.gatewayName,
      gatewayType: step.gatewayType,
      mcpServerName: step.mcpServerName,
    };
  }

  // Default handling for other tools
  const content = formatToolResult(step, undefined);
  const tokens = estimateTokens(content);
  const toolProvider = explicitNonSubagentKind && detected.toolProvider === "subagent"
    ? "unknown"
    : detected.toolProvider;
  const isSubagent = explicitNonSubagentKind ? false : detected.isSubagent;

  return {
    type: "cool_tool",
    content: content,
    toolName: step.toolName,
    toolStatus: getToolStatus(step),
    tokens: tokens,
    name: `Tool: ${step.toolName}`,
    description: getToolDescription(step.toolName),
    intermediateStep: step,
    toolResult: step.toolResult,

    // Add tool source detection metadata (Epic 6.2)
    toolProvider,
    toolSource: detected.toolSource,
    isSubagent,
    gatewayId: step.gatewayId,
    gatewayName: step.gatewayName,
    gatewayType: step.gatewayType,
    mcpServerName: step.mcpServerName,
  };
}

/**
 * Helper function to format file sizes
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format tool result for display - ONLY THE GOOD STUFF!
 * Filters out technical noise and shows what users actually care about
 */
function formatToolResult(step: IntermediateStep, agent?: any): string {
  let { toolResult, toolArgs, toolName } = step;

  // COOL TOOLS FIX: Sometimes toolResult is still a JSON string, parse it first
  if (
    typeof toolResult === "string" &&
    (toolResult.startsWith("[") || toolResult.startsWith("{"))
  ) {
    try {
      toolResult = JSON.parse(toolResult);
    } catch {
      // Keep as string if parsing fails
    }
  }

  // COOL TOOLS FIX: Check for our new clean structure first!
  if (Array.isArray(toolResult) && toolResult.length > 0) {
    const firstItem = toolResult[0];

    // Handle new Cool Tools structure with preserved data
    if (firstItem?.type === "coolToolResult" && firstItem?.toolResult) {
      // We have clean, structured data! No parsing needed!
      toolResult = firstItem.toolResult;
      // toolResult is now the actual structured object from builtInService
      // No JSON parsing, no unwrapping, just clean data!
    }
    // Fallback for text-based tool result structures.
    else if (firstItem?.type === "text" && firstItem?.text) {
      // Try to parse the text as JSON if it looks like JSON
      const text = firstItem.text;
      if (
        typeof text === "string" &&
        (text.startsWith("{") || text.startsWith("["))
      ) {
        try {
          toolResult = JSON.parse(text);
        } catch {
          toolResult = text;
        }
      } else {
        toolResult = text;
      }
    } else {
      // Just take the first element if it's a regular array
      toolResult = toolResult[0];
    }
  }

  // For write/edit operations, we want to show WHAT was written
  if (canonicalToolName(toolName) === "write_file") {
    // First priority: show the content that was written from toolArgs
    if (toolArgs?.content) {
      return toolArgs.content;
    }
    // Second priority: check if toolResult has the content field
    if (toolResult?.content) {
      return toolResult.content;
    }
    // Third priority: check for fileContent field
    if (toolArgs?.fileContent) {
      return toolArgs.fileContent;
    }
    // Otherwise extract meaningful content from the result
    return extractMeaningfulContent(toolResult);
  }

  // For edit operations, try to show the diff or changes
  if (
    canonicalToolName(toolName) === "edit_file" ||
    toolName === "apply_diff"
  ) {
    // Look for diff content in various places
    if (toolArgs?.diff) return toolArgs.diff;
    if (toolArgs?.changes) return toolArgs.changes;
    if (toolArgs?.oldContent && toolArgs?.newContent) {
      // Create a simple diff display if we have old and new content
      return `--- Before\n+++ After\n${toolArgs.oldContent}\n---\n${toolArgs.newContent}`;
    }
    if (toolResult?.diff) return toolResult.diff;
    if (toolResult?.changes) return toolResult.changes;
    // Fallback to showing what we have
    return extractMeaningfulContent(toolResult);
  }

  // For command execution, show with terminal prompt styling
  if (canonicalToolName(toolName) === "execute_command") {
    // If result is a string, that's probably the command output
    if (typeof toolResult === "string") {
      return toolResult;
    }

    // Build the terminal output with realistic prompt
    let output = "";

    // Create terminal prompt with agent name, directory, and timestamp
    const agentName = agent?.displayName || agent?.name || "Agent";
    const directory =
      toolResult?.cwd ||
      toolArgs?.cwd ||
      toolResult?.directory ||
      toolArgs?.directory ||
      "~";
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // Add terminal prompt header (will be styled with CSS)
    output = `<span class="terminal-prompt-header">${agentName}@batshit [${timestamp}] ${directory}</span>\n`;

    // Show the command that was run
    const command = toolResult?.command || toolArgs?.command;
    if (command) {
      output += `<span class="terminal-prompt">$</span> <span class="terminal-command">${command}</span>\n`;
      if (output.length > 1) output += "\n"; // Add spacing after command
    }

    // Add the stdout - use our universal formatting for arrays
    let stdoutContent = "";

    // COOL TOOLS FIX: Check for stdout/output in the clean data structure
    if (toolResult?.stdout !== undefined && toolResult?.stdout !== null) {
      if (Array.isArray(toolResult.stdout)) {
        stdoutContent = formatArray(toolResult.stdout);
      } else if (typeof toolResult.stdout === "string") {
        stdoutContent = toolResult.stdout;
      } else if (typeof toolResult.stdout === "object") {
        stdoutContent = formatObject(toolResult.stdout);
      } else {
        stdoutContent = String(toolResult.stdout);
      }
    } else if (
      toolResult?.output !== undefined &&
      toolResult?.output !== null
    ) {
      if (Array.isArray(toolResult.output)) {
        stdoutContent = formatArray(toolResult.output);
      } else if (typeof toolResult.output === "string") {
        stdoutContent = toolResult.output;
      } else if (typeof toolResult.output === "object") {
        stdoutContent = formatObject(toolResult.output);
      } else {
        stdoutContent = String(toolResult.output);
      }
    } else if (toolResult?.result) {
      if (Array.isArray(toolResult.result)) {
        stdoutContent = formatArray(toolResult.result);
      } else if (typeof toolResult.result === "string") {
        stdoutContent = toolResult.result;
      } else if (typeof toolResult.result === "object") {
        stdoutContent = formatObject(toolResult.result);
      } else {
        stdoutContent = String(toolResult.result);
      }
    }

    // Always add stdout content if we have it (even if empty string)
    if (stdoutContent !== undefined && stdoutContent !== null) {
      output += stdoutContent;
    }

    // Add stderr if there is any (but only if it's an actual error)
    if (toolResult?.stderr && toolResult.stderr.trim()) {
      // Only add stderr if it's not empty and looks like an error
      const stderrContent = toolResult.stderr.trim();
      if (stderrContent && !output.includes(stderrContent)) {
        output +=
          (output ? "\n" : "") +
          `<span class="terminal-stderr">[stderr] ${stderrContent}</span>`;
      }
    }

    // If we still don't have output but the command succeeded
    // Check if stdout is actually empty (not just an empty string)
    const hasStdout =
      toolResult?.stdout !== undefined && toolResult?.stdout !== null;
    const hasOutput =
      toolResult?.output !== undefined && toolResult?.output !== null;
    if (toolResult?.success === true && !hasStdout && !hasOutput) {
      // Check if there's any message indicating success
      if (toolResult?.message) {
        output += toolResult.message;
      } else if (command) {
        // Command succeeded but no output (common for some commands)
        output +=
          '<span class="terminal-success">(Command completed successfully with no output)</span>';
      }
    }

    // If we still don't have meaningful output, try to extract it
    // Check for various empty output patterns
    const isEmptyOutput =
      !output ||
      output === "$ \n\n" ||
      output.trim() === "$" ||
      output.trim().endsWith("$\n");
    if (isEmptyOutput) {
      return extractMeaningfulContent(toolResult);
    }

    return output.trim();
  }

  // For list_files, format the file listing nicely
  if (canonicalToolName(toolName) === "list_files" && toolResult?.files) {
    const files = toolResult.files;
    let output = "";

    // Group by type (directories first, then files)
    const dirs = files.filter((f: any) => f.type === "directory");
    const regularFiles = files.filter((f: any) => f.type === "file");

    if (dirs.length > 0) {
      dirs.forEach((dir: any) => {
        output += `[dir] ${dir.path || dir.name}\n`;
      });
    }

    if (regularFiles.length > 0) {
      if (dirs.length > 0) output += "\n";
      regularFiles.forEach((file: any) => {
        const size = file.size ? ` (${formatFileSize(file.size)})` : "";
        output += `[file] ${file.path || file.name}${size}\n`;
      });
    }

    if (output) {
      output += `\n${toolResult.totalFiles || files.length} files, ${toolResult.totalDirectories || dirs.length} directories`;
      return output.trim();
    }
  }

  // For search_files, format the search results nicely
  if (
    canonicalToolName(toolName) === "search_files" &&
    (toolResult?.matches || toolResult?.files)
  ) {
    const matches = toolResult.matches || toolResult.files || [];
    if (Array.isArray(matches) && matches.length > 0) {
      let output = `Found ${matches.length} match${matches.length === 1 ? "" : "es"}:\n\n`;

      matches.forEach((match) => {
        if (typeof match === "string") {
          output += `${match}\n`;
        } else if (match.file || match.path) {
          output += `[file] ${match.file || match.path}\n`;
          if (match.line)
            output += `  Line ${match.line}: ${match.text || match.content || ""}\n`;
          if (match.matches && Array.isArray(match.matches)) {
            match.matches.forEach((m: any) => {
              output += `  Line ${m.line}: ${m.text}\n`;
            });
          }
        }
      });

      return output.trim();
    }
  }

  // For read operations, show the file content
  if (canonicalToolName(toolName) === "read_file") {
    if (typeof toolResult === "string") return toolResult;
    if (toolResult?.content) return toolResult.content;
    if (toolResult?.data) return toolResult.data;
    return extractMeaningfulContent(toolResult);
  }

  // For list operations, use our universal formatArray function
  if (toolName === "list_files" || toolName === "search_files") {
    if (Array.isArray(toolResult)) {
      return formatArray(toolResult);
    }
    if (toolResult?.files && Array.isArray(toolResult.files)) {
      return formatArray(toolResult.files);
    }
    if (toolResult?.results && Array.isArray(toolResult.results)) {
      return formatArray(toolResult.results);
    }
    if (toolResult?.items && Array.isArray(toolResult.items)) {
      return formatArray(toolResult.items);
    }
    return extractMeaningfulContent(toolResult);
  }

  // Default: Extract meaningful content
  return extractMeaningfulContent(toolResult);
}

/**
 * Extract meaningful content from a tool result
 * Filters out technical fields nobody cares about
 * Universal solution that handles all data types intelligently
 */
function extractMeaningfulContent(result: any): string {
  // If it's already a string, return it
  if (typeof result === "string") {
    return result;
  }

  // If it's null/undefined, return empty
  if (!result) {
    return "";
  }

  // If it's an array at the top level, format each item
  if (Array.isArray(result)) {
    return formatArray(result);
  }

  // If it's an object, look for meaningful fields
  if (typeof result === "object") {
    // Fields we actually care about (in priority order)
    const meaningfulFields = [
      "content",
      "output",
      "result",
      "data",
      "text",
      "message",
      "stdout",
      "response",
      "value",
      "body",
      "html",
      "markdown",
    ];

    // Check for meaningful fields
    for (const field of meaningfulFields) {
      if (result[field] !== undefined && result[field] !== null) {
        // If it's a string, return it
        if (typeof result[field] === "string") {
          return result[field];
        }
        // If it's an array, format it properly
        if (Array.isArray(result[field])) {
          return formatArray(result[field]);
        }
        // If it's an object, intelligently extract its content
        if (typeof result[field] === "object") {
          return formatObject(result[field]);
        }
        // Otherwise stringify it nicely
        return JSON.stringify(result[field], null, 2);
      }
    }

    // Fields we DON'T want to show (technical noise)
    const noiseFields = [
      "id",
      "toolId",
      "toolCallId",
      "type",
      "status",
      "timestamp",
      "executionId",
      "workflowId",
      "nodeId",
      "runId",
      "mode",
      "startedAt",
      "finishedAt",
      "elapsedTime",
      "retryOf",
      "observation",
      "args",
      "arguments",
      "metadata",
      "headers",
      "config",
      "settings",
      "options",
      "params",
      "schema",
    ];

    // Filter out the noise
    const filtered: any = {};
    let hasContent = false;

    for (const [key, value] of Object.entries(result)) {
      if (!noiseFields.includes(key) && value !== undefined && value !== null) {
        filtered[key] = value;
        hasContent = true;
      }
    }

    // If we have filtered content, format it intelligently
    if (hasContent) {
      // Special case: if there's only one field left, just show its value
      const keys = Object.keys(filtered);
      if (keys.length === 1) {
        const value = filtered[keys[0]];
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return formatArray(value);
        if (typeof value === "object") return formatObject(value);
        return JSON.stringify(value, null, 2);
      }

      return formatObject(filtered);
    }

    // Last resort: format the whole object
    return formatObject(result);
  }

  // Fallback for other types
  return String(result);
}

/**
 * Normalize tool args/results to canonical shapes so renderers get clean data
 */
export function normalizeToolStep(step: IntermediateStep): IntermediateStep {
  let canonical = canonicalToolName(step.toolName);
  const clone: IntermediateStep = {
    ...step,
    originalToolName: step.originalToolName || step.toolName,
  };

  const rawArgs =
    step.toolArgs ??
    (step as any).toolInput ??
    (step as any).toolArgs ??
    {};
  let args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? { ...rawArgs }
      : {};
  clone.toolArgs = args;
  let result = step.toolResult ?? (step as any).toolOutput;

  const dynamicUnwrap = unwrapDynamicMcpUsePayload({
    wrapperToolName: step.toolName,
    rawArgs,
    rawResult: result
  });
  if (dynamicUnwrap) {
    clone.originalToolName = clone.originalToolName || step.toolName;
    clone.toolName = dynamicUnwrap.toolName || clone.toolName;
    canonical = canonicalToolName(clone.toolName);
    if (dynamicUnwrap.params && Object.keys(dynamicUnwrap.params).length > 0) {
      args = { ...dynamicUnwrap.params };
      clone.toolArgs = args;
    }
    if (dynamicUnwrap.result !== undefined) {
      result = dynamicUnwrap.result;
    }
    if (
      dynamicUnwrap.executionTimeMs !== undefined &&
      clone.executionTime === undefined
    ) {
      clone.executionTime = dynamicUnwrap.executionTimeMs;
    }
  }

  const rawSubagentName =
    step.toolName && step.toolName !== "call_subagent" && step.toolName !== "subagent"
      ? step.toolName
      : undefined;
  const hasN8nSubagentPrompt =
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    "Prompt__User_Message_" in args;
  const explicitNonSubagentKind = extractExplicitNonSubagentOperationKind(clone, args, result);
  if (explicitNonSubagentKind) {
    canonical = explicitNonSubagentKind;
    clone.isSubagent = false;
    if (clone.toolProvider === "subagent") {
      clone.toolProvider = undefined;
    }
    clone.subagentName = undefined;
  } else if (
    canonical === "subagent" ||
    hasN8nSubagentPrompt ||
    clone.isSubagent === true ||
    clone.toolProvider === "subagent"
  ) {
    canonical = "subagent";
    clone.isSubagent = true;
    clone.toolProvider = clone.toolProvider || "subagent";
    clone.subagentName = clone.subagentName || args.subagentName || rawSubagentName;
  }

  // Preserve explicit provider/source for batshit-server-prefixed tools.
  const originalNameLower = (clone.toolName || "").toLowerCase();
  const originalToolLower = (clone.originalToolName || "").toLowerCase();
  if (originalToolLower.startsWith('native_')) {
    clone.toolProvider = clone.toolProvider || 'batshit-server';
    clone.toolSource = clone.toolSource || 'native-tool';
  }
  if (originalNameLower.includes("batshit_server_")) {
    clone.toolProvider = "batshit-server";
    clone.toolSource = clone.toolSource || "workflow";
  }

  const unwrapN8nResponseWrapper = (val: any): any => {
    // n8n MCP Trigger often wraps tool results like:
    // [ { response: [ { type: 'text', text: '...json...' } ] } ]
    // Unwrap to the inner `text` payload so our normalisers can shape it.
    const unwrapFromContainer = (container: any): any | null => {
      if (!container || typeof container !== "object" || Array.isArray(container))
        return null;

      const response =
        (container as any).response ??
        (container as any).responses ??
        (container as any).output ??
        (container as any).result;

      if (!Array.isArray(response) || response.length === 0) return null;
      const first = response[0];
      if (!first || typeof first !== "object") return null;

      if ((first as any).json !== undefined) return (first as any).json;

      const text =
        typeof (first as any).text === "string"
          ? (first as any).text
          : typeof (first as any).content === "string"
            ? (first as any).content
            : null;

      return text ?? null;
    };

    if (Array.isArray(val) && val.length === 1) {
      const unwrapped = unwrapFromContainer(val[0]);
      if (unwrapped !== null) return unwrapped;
    }

    const direct = unwrapFromContainer(val);
    if (direct !== null) return direct;

    return val;
  };

  // Unwrap common n8n "response" wrappers before any parsing/joining.
  result = unwrapN8nResponseWrapper(result);

  // Some callback paths wrap results as `[ { type: "text", text: "..." } ]`.
  // Unwrap those arrays so the canonical normalisers can see the real payload.
  if (Array.isArray(result) && result.length) {
    const allTextItems = result.every(
      (item) => item && typeof item === "object" && "text" in item,
    );
    if (allTextItems) {
      const joinedText = result
        .map((item: any) => (typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      result = joinedText || result[0].text || result;
    }
  }

  // After unwrapping text arrays, attempt a second JSON parse (n8n MCP often double-wraps).
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      // keep as string
    }
  }

  let failureDetails = getToolFailureDetails(result);

  // If we parsed into another text array, unwrap once more.
  if (Array.isArray(result) && result.length) {
    const allTextItems = result.every(
      (item) => item && typeof item === "object" && "text" in item,
    );
    if (allTextItems) {
      const joinedText = result
        .map((item: any) => (typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      result = joinedText || result[0].text || result;
      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch {
          // keep as string
        }
      }
    }
  }

  // Parse result JSON strings where possible
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      // keep as string
    }
  }

  // After JSON parsing, unwrap again (some n8n payloads double-wrap via JSON strings).
  result = unwrapN8nResponseWrapper(result);

  // Re-run unwrap after JSON parse (common: nested "[{\"type\":\"text\",...}]")
  if (Array.isArray(result) && result.length) {
    const allTextItems = result.every(
      (item) => item && typeof item === "object" && "text" in item,
    );
    if (allTextItems) {
      const joinedText = result
        .map((item: any) => (typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      result = joinedText || result[0].text || result;
    }
  }

  failureDetails = failureDetails ?? getToolFailureDetails(result);
  // A search that matched nothing is not a failed tool (`toolStepFoundNothing`).
  if (failureDetails && toolStepFoundNothing(canonical, args, result)) {
    failureDetails = null;
  }
  if (failureDetails) {
    clone.success = false;
    clone.error =
      clone.error || failureDetails.reason || failureDetails.error || toolFailureFallbackMessage(result);
  }

  // Heuristic: if command tool actually represents a file op, remap before shaping
  if (canonical === "execute_command") {
    const commandTextRaw =
      (typeof args.command === "string" && args.command) ||
      (typeof (result as any)?.command === "string" &&
        (result as any).command) ||
      "";
    const commandText = commandTextRaw.toLowerCase();
    const commandHead = commandTextRaw.split(/\r?\n/, 1)[0]?.trim().toLowerCase() || commandText;
    const commandSegments = commandHead
      .split(/&&|\|\|/)
      .map((segment: string) => segment.trim())
      .filter(Boolean);
    const terminalCommandSegment =
      commandSegments.length > 0 ? commandSegments[commandSegments.length - 1] : commandHead;
    const firstToken = terminalCommandSegment.match(/^([a-z0-9_.-]+)/)?.[1] || "";
    const startsWithListCommand =
      firstToken === "ls" || firstToken === "find" || firstToken === "tree";

    const hasFiles =
      Array.isArray((result as any)?.files) ||
      Array.isArray((result as any)?.items) ||
      Array.isArray(result as any);
    // A diff is text. Codex reports a native patch's targets as a `changes` LIST, and reading
    // that as a diff turned every delete, rename, and move into an Edit File card whose "diff"
    // was the JSON of those objects (F-P6-5 follow-up item 4).
    const hasDiff = [
      (result as any)?.diff,
      (result as any)?.changes,
      (result as any)?.patch,
    ].some((value) => typeof value === "string" && value.length > 0);
    const hasContent =
      (result as any)?.content ||
      (result as any)?.data ||
      (result as any)?.text ||
      typeof result === "string";
    const hasPath =
      args.filePath || args.file_path || args.path || (result as any)?.filePath;

    // Parse file path hints from command text (cat/sed/apply_patch/ls/find). A path is taken from
    // the command as written, so it keeps its case; the command names and the patch header match
    // in any case (bug sweep item 8: `/Users/Josh/Hello.md` was stored as `/users/josh/hello.md`).
    const patchMatch = commandTextRaw.match(/update file:\s*([^\n\r]+)/i);
    const sedCatMatch = commandTextRaw.match(
      /\b(?:cat|sed|head|tail)[^\n\r]*?([\w./_-]+\.[\w]+)/i,
    );
    const lsMatch = commandText.match(/\bls\b[^|]*/);

    if (patchMatch) {
      canonical = "edit_file";
      const fp = patchMatch[1]?.trim();
      if (fp) {
        args.filePath = args.filePath || fp;
      }
    } else if (startsWithListCommand || hasFiles || lsMatch) {
      canonical = "list_files";
    } else if (sedCatMatch) {
      canonical = "read_file";
      const fp = sedCatMatch[1]?.trim();
      if (fp) {
        args.filePath = args.filePath || fp;
      }
    } else if (hasDiff) {
      canonical = "edit_file";
    } else if (args.content && hasPath) {
      canonical = "write_file";
    } else if (hasContent && hasPath) {
      canonical = "read_file";
    }
  }

  clone.toolName = canonical;

  switch (canonical) {
    case "read_file": {
      const filePath =
        args.filePath ||
        args.file_path ||
        args.path ||
        result?.filePath ||
        result?.mappedToolInput?.filePath ||
        result?.mappedToolInput?.path ||
        result?.input?.params?.filePath ||
        result?.input?.params?.path ||
        result?.input?.filePath ||
        result?.input?.path ||
        result?.absolutePath ||
        args.input;
      // A shell command read as a file keeps its failure (F-P6-5), and its content is what the
      // command printed: never the whole result object, which the API lane's empty stdout once
      // turned into 31 lines of JSON. A read that printed nothing read nothing, so the first
      // text field the result carries wins even when it is empty; the whole result is a last
      // resort for a read that carries no text at all.
      const command = shellActionCommand(args, result);
      const failed = shellCommandFailed(result, command);
      const content = failed
        ? (typeof result?.content === "string" && result.content.length > 0
            ? result.content
            : failedCommandOutput(result) ?? "")
        : firstReadContent([
            result?.content,
            result?.data,
            result?.text,
            result?.stdout,
            result?.output,
            result?.aggregated_output,
            result?.result,
          ]) ?? result;
      const language = result?.language || detectLanguage(filePath);
      const exitCode = failedCommandExitCode(result, command);
      clone.toolResult = {
        content:
          typeof content === "string"
            ? content
            : JSON.stringify(content, null, 2),
        filePath,
        language,
        lineCount:
          content && typeof content === "string"
            ? content.split("\n").length
            : undefined,
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      clone.toolArgs = { ...args, filePath };
      break;
    }
    case "write_file": {
      const filePath =
        args.filePath ||
        args.file_path ||
        args.path ||
        result?.filePath ||
        result?.mappedToolInput?.filePath ||
        result?.mappedToolInput?.path ||
        result?.absolutePath ||
        args.input;
      const command = shellActionCommand(args, result);
      const failed = shellCommandFailed(result, command);
      // A failed write wrote nothing: keep only what the command meant to write, never what it
      // printed or the file's old content (F-P6-5).
      const content = failed
        ? args.content || args.data || result?.mappedToolInput?.content || ""
        : args.content ||
          args.data ||
          result?.mappedToolInput?.content ||
          result?.content ||
          result?.stdout ||
          result?.output ||
          result;
      const language = result?.language || detectLanguage(filePath);
      clone.toolResult = {
        content:
          typeof content === "string"
            ? content
            : JSON.stringify(content, null, 2),
        filePath,
        language,
        ...shellFailureResultFields(result, command, failed),
      };
      clone.toolArgs = { ...args, filePath };
      break;
    }
    case "edit_file": {
      const filePath =
        args.filePath ||
        args.file_path ||
        args.path ||
        result?.filePath ||
        result?.mappedToolInput?.filePath ||
        result?.mappedToolInput?.path ||
        result?.absolutePath ||
        args.input;
      const command = shellActionCommand(args, result);
      const failed = shellCommandFailed(result, command);
      // A failed edit keeps only a patch or diff the command meant to apply, never what it
      // printed and never Codex's `changes` list (F-P6-5).
      // `changes` counts only as diff TEXT: Codex's list of changed paths is not a diff (item 4).
      const changesText = (value: unknown) =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      const diffCandidate = failed
        ? [result?.diff, result?.patch, args.diff].find(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : result?.diff ||
          // The native wrapper nests the run's result, and so its diff, under `data`, the way
          // the patch sources below read its command.
          (typeof result?.data?.diff === "string" && result.data.diff) ||
          changesText(result?.changes) ||
          result?.patch ||
          result?.output ||
          result?.aggregated_output ||
          args.diff ||
          changesText(args.changes);

      // Prefer an explicit patch body when apply_patch was used
      const patchSources: Array<string | undefined> = [
        typeof result?.input?.command === "string" ? result.input.command : undefined,
        typeof result?.command === "string" ? result.command : undefined,
        typeof result?.data?.command === "string" ? result.data.command : undefined,
        typeof result?.mappedToolInput?.command === "string"
          ? result.mappedToolInput.command
          : undefined,
        typeof result?.data?.mappedToolInput?.command === "string"
          ? result.data.mappedToolInput.command
          : undefined,
        typeof args.command === "string" ? args.command : undefined,
        typeof args.innerCommand === "string" ? args.innerCommand : undefined,
        typeof args.input === "string" ? args.input : undefined,
        typeof args.input?.command === "string" ? args.input.command : undefined,
      ];
      const extractedPatch = extractManagedPatchFromSources(patchSources);

      // If we found a real patch, use it unless the existing diff already looks like one
      const chosenDiff =
        extractedPatch && (!looksLikePatch(diffCandidate) || !diffCandidate)
          ? extractedPatch
          : diffCandidate ?? extractedPatch;

      clone.toolResult = {
        diff: formatDiffOutput(chosenDiff),
        filePath,
        language: result?.language || detectLanguage(filePath),
        ...(failureDetails ?? {}),
        ...shellFailureResultFields(result, command, failed),
      };
      clone.toolArgs = { ...args, filePath };
      break;
    }
    case "list_files": {
      const command = shellActionCommand(args, result);
      const parseListingLines = (
        rawOutput: string
      ): Array<{ name: string; type: "file" | "directory" | "unknown" }> => {
        if (!rawOutput) return []

        return rawOutput
          .split(/\r?\n/)
          .map((line: string) => line.trim())
          .filter(Boolean)
          .map((line: string) => {
            if (/^total\s+\d+/i.test(line)) return null

            const longLs = line.match(
              /^([bcdlps-][rwxstST-]{9}[+@]?)\s+\d+\s+\S+\s+\S+\s+\d+\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/
            )
            if (longLs?.[2]) {
              const name = longLs[2].replace(/\s+->\s+.+$/, '').trim()
              if (!name || name === "." || name === "..") return null
              return {
                name,
                type: longLs[1].startsWith("d") ? "directory" : "file"
              } as const
            }

            const name = line.replace(/^[├└│─\s]+/, "").trim()
            if (!name || name === "." || name === "..") return null
            return {
              name,
              type: name.endsWith("/") ? "directory" : "unknown"
            } as const
          })
          .filter(Boolean) as Array<{ name: string; type: "file" | "directory" | "unknown" }>
      }

      const failed = shellCommandFailed(result, command);
      // A listing's own error lines (`ls: /nope: No such file …`, `bfs: error: …`) are never
      // entries, whatever the exit code said (F-P6-5, and its follow-up: Claude Code reported a
      // `find` that hit a permission error as a success, and its diagnostic was listed as a file).
      const listText = (text: string) => stripShellErrorLines(text, command);
      // `ls` of several directories heads each one's entries with `<dir>:`; that header is not an
      // entry, and the entries under it are that directory's (item 6).
      const parseShellListOutput = (
        rawOutput: string
      ): Array<{ name: string; path?: string; type: "file" | "directory" | "unknown" }> =>
        splitLsSections(rawOutput, command).flatMap((section) =>
          parseListingLines(section.body).map((entry) =>
            section.dir ? { ...entry, path: joinListingSectionPath(section.dir, entry.name) } : entry
          )
        );
      let files =
        result?.files || result?.items || result?.entries || result?.list;
      if (!files && Array.isArray(result)) {
        files = result;
      }
      if (!files && typeof result?.stdout === "string") {
        files = parseShellListOutput(listText(result.stdout))
      }
      if (!files && typeof result === "string") {
        try {
          const parsed = JSON.parse(result);
          if (Array.isArray(parsed)) {
            files = parsed;
          } else if (parsed && typeof parsed === "object" && parsed.files) {
            files = parsed.files;
          } else {
            files = parsed;
          }
        } catch {
          files = parseShellListOutput(listText(result))
        }
      }
      if (!files && typeof result?.output === "string") {
        files = parseShellListOutput(listText(result.output))
      }
      clone.toolResult = {
        files: Array.isArray(files) ? files : result?.files ? result.files : [],
        totalFiles: result?.totalFiles,
        totalDirectories: result?.totalDirectories,
        dirPath:
          args.dirPath ||
          args.directory ||
          args.path ||
          result?.dirPath ||
          result?.mappedToolInput?.dirPath ||
          result?.mappedToolInput?.path ||
          ".",
        ...shellFailureResultFields(result, command, failed),
      };
      break;
    }
    case "execute_command": {
      const stdout =
        result?.stdout || result?.output || result?.aggregated_output || "";
      // A command that never started (sandbox unavailable, policy block, bad patch) has no
      // exit code and no stderr of its own. Its card and its AI view show the failure
      // reason; an exit code appears only when the command reported one (F-P5-1).
      const awaitingApproval =
        step.success === false &&
        !step.error &&
        !failureDetails &&
        !result?.stdout &&
        !result?.output;
      const stderr =
        result?.stderr ||
        result?.error ||
        failureDetails?.reason ||
        (awaitingApproval ? "Awaiting approval before execution." : "");
      const explicitExitCode =
        result?.exitCode ?? result?.code ?? result?.status;
      clone.toolResult = {
        stdout,
        stderr,
        ...(typeof explicitExitCode === "number" ? { exitCode: explicitExitCode } : {}),
        ...(failureDetails?.errorCode ? { errorCode: failureDetails.errorCode } : {}),
        cwd: result?.cwd || args.cwd || args.directory || result?.directory,
        command: result?.command || args.command,
      };
      break;
    }
    case "subagent": {
      // Expect structured `{ input, output }`; fall back to best-effort
      let input =
        args.chatInput ||
        args.message ||
        args.prompt ||
        args.Prompt__User_Message_ ||
        result?.input ||
        "";
      let output = result?.output ?? result?.result ?? result;
      if (typeof output === "string") {
        try {
          output = JSON.parse(output);
        } catch {
          // leave string
        }
      }
      const intermediateSteps = extractNestedIntermediateSteps(result) ?? extractNestedIntermediateSteps(output);
      clone.toolResult = {
        input,
        output,
        subagentId: result?.subagentId || args.subagentId,
        subagentName: result?.subagentName || args.subagentName || clone.subagentName || rawSubagentName,
        agentName: result?.agentName || args.agentName || clone.agentName,
        ...(intermediateSteps ? { intermediateSteps } : {}),
      };
      clone.subagentName = clone.toolResult.subagentName;
      clone.agentName = clone.toolResult.agentName;
      break;
    }
    default:
      // Leave unchanged
      clone.toolResult = result;
  }

  return clone;
}

/**
 * True when a tool step is a shell command stored as a file action (a read, write, edit,
 * listing, or search) whose search matched nothing: D1's one exception to a lane's own failure
 * flag. The API lane's native bash calls every non-zero exit a failure (`success` is
 * `exitCode === 0`), so a step asks this before that flag becomes a failure; a real search error
 * (exit 2 and up), a timeout, and a blocked command still fail, and the bash lane keeps its own
 * exit code either way. `normalizeToolStep` asks it for the stored step, and send-routed asks it
 * (through `toolStepFailureSource`) for its own copies of the step, so the two never disagree.
 */
export function toolStepFoundNothing(toolName: string | undefined, args: unknown, result: unknown): boolean {
  return (
    MAPPED_SHELL_FILE_LANES.has(canonicalToolName(toolName)) &&
    commandFoundNothing(result, shellActionCommand(args, result))
  );
}

/**
 * What a copy of a tool step reads its failure from: the step's result, or nothing when that
 * result's own flag only says a search matched nothing (`toolStepFoundNothing`). send-routed
 * keeps a copy of every tool step (the Execution Viewer's, the saved message's
 * `intermediateSteps`, the `end` event's) and reads its `error` and `success` from this, so a
 * search that matched nothing is an answer there as it is in the stored zip.
 */
export function toolStepFailureSource<T>(toolName: string | undefined, args: unknown, result: T): T | undefined {
  return toolStepFoundNothing(toolName, args, result) ? undefined : result;
}

function plainRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/**
 * The words a failed step gives when its result names no reason of its own (fp65h): a command
 * that ran out of time says so and for how long, and one that exited non-zero gives its exit code;
 * anything else keeps the generic sentence. The API lane's native bash result carries
 * `timedOut: true` or a failing `exitCode` but no reason, so a timed-out command was stored, and
 * shown in the Execution Viewer, as `Tool execution failed.` The stored step
 * (`normalizeToolStep`) and send-routed's copies of it (`toolStepFailureMessage`) both use this,
 * so the zip and the Execution Viewer say the same thing.
 */
export function toolFailureFallbackMessage(result: unknown): string {
  const record = plainRecord(result);
  if (record?.timedOut === true) {
    const durationMs = record.durationMs;
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
      return durationMs >= 1000
        ? `The command timed out after ${Math.round(durationMs / 1000)} s.`
        : `The command timed out after ${Math.round(durationMs)} ms.`;
    }
    return "The command timed out.";
  }
  const exitCode = record?.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0) {
    return `The command failed with exit code ${exitCode}.`;
  }
  return "Tool execution failed.";
}

/** The reason a failed result names itself, in the order send-routed always read it. */
function namedFailureReason(record: Record<string, any>): string | undefined {
  for (const candidate of [record.reason, record.failureMessage, record.error]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (record.error && typeof record.error === "object" && typeof record.error.message === "string") {
    return record.error.message.trim() || undefined;
  }
  if (typeof record.errorCode === "string" && record.errorCode.trim()) return record.errorCode.trim();
  return undefined;
}

/**
 * The error a copy of a tool step carries, or `undefined` when the step did not fail (fp65h).
 * send-routed keeps a copy of every tool step (the Execution Viewer's rows, the saved message's
 * `intermediateSteps`, the `end` event's) and reads its `error` and `success` from this, from the
 * facts the stored zip reads:
 * - a search that matched nothing never failed (`toolStepFailureSource`);
 * - the result's own flag: `success: false`, `blocked`, or a delegated run that failed or timed
 *   out. `status` is a failure signal ONLY on a delegated-run payload (SA-111): ordinary tools
 *   report the status of their SUBJECT (a CI run, a deployment, a queued job), not of the call,
 *   while `/api/subagents/managed-execute` returns `success: true` with the run's own `status`;
 * - a shell command that exited non-zero. Codex and Claude report that as an exit code with no
 *   `success: false`, so a failed Codex command was a Success row. A command stored as a file
 *   action reads its exit code by the zip's rule (`failedCommandExitCode`: exit 1 from a search is
 *   an answer); a bash command, like the API lane's own bash, fails on any non-zero exit. An exit
 *   code on any other tool is its subject's, not a failure of the call.
 * The caller parses a JSON-like result first.
 */
export function toolStepFailureMessage(toolName: string | undefined, args: unknown, result: unknown): string | undefined {
  const record = plainRecord(toolStepFailureSource(toolName, args, result));
  if (!record) return undefined;
  const isDelegatedRun = record.kind === "subagent" || record.kind === "worker";
  if (
    record.success === false ||
    record.blocked === true ||
    (isDelegatedRun && (record.status === "failed" || record.status === "timed_out"))
  ) {
    return namedFailureReason(record) ?? toolFailureFallbackMessage(record);
  }
  const canonical = canonicalToolName(toolName);
  const exitCode = MAPPED_SHELL_FILE_LANES.has(canonical)
    ? failedCommandExitCode(record, shellActionCommand(args, record))
    : canonical === "execute_command" &&
        typeof record.exitCode === "number" &&
        Number.isFinite(record.exitCode) &&
        record.exitCode !== 0
      ? record.exitCode
      : undefined;
  return exitCode === undefined ? undefined : `The command failed with exit code ${exitCode}.`;
}

/**
 * A read's content from the fields a result can carry it in, in order. A string wins even when
 * it is empty — an empty file, or `cat x | grep y` with no match, read nothing — while any other
 * falsy value is skipped as before. `undefined` means the result carries no text at all.
 */
function firstReadContent(candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (typeof candidate === "string" || candidate) return candidate;
  }
  return undefined;
}

/**
 * What a shell command stored as a write, edit, or listing keeps when it failed (F-P6-5): its
 * failing exit code and what it printed, as `commandOutput`. Nothing for a success.
 */
function shellFailureResultFields(
  result: unknown,
  command: string | undefined,
  failed: boolean,
): Record<string, unknown> {
  if (!failed) return {};
  const exitCode = failedCommandExitCode(result, command);
  const commandOutput = failedCommandOutput(result);
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(commandOutput ? { commandOutput } : {}),
  };
}

function looksLikePatch(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    value.includes("*** Begin Patch") ||
    value.startsWith("---") ||
    value.includes("\n@@") ||
    /^[-+]/m.test(value)
  );
}

function formatDiffOutput(diff: unknown): string | undefined {
  if (diff === undefined || diff === null) return undefined;
  if (typeof diff === "string") return diff;
  return JSON.stringify(diff, null, 2);
}

function getToolFailureDetails(result: unknown):
  | {
      success: false;
      blocked?: boolean;
      reason?: string;
      error?: string;
      errorCode?: string;
      failureMessage?: string;
    }
  | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }

  const record = result as Record<string, any>;
  if (record.success !== false && record.blocked !== true) {
    return null;
  }

  const error =
    typeof record.error === "string" && record.error.trim()
      ? record.error.trim()
      : record.error &&
          typeof record.error === "object" &&
          typeof record.error.message === "string"
        ? record.error.message.trim()
        : undefined;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : typeof record.failureMessage === "string" && record.failureMessage.trim()
        ? record.failureMessage.trim()
        : error;

  return {
    success: false,
    ...(record.blocked === true ? { blocked: true } : {}),
    ...(reason ? { reason } : {}),
    ...(error ? { error } : {}),
    ...(typeof record.errorCode === "string" && record.errorCode.trim()
      ? { errorCode: record.errorCode.trim() }
      : {}),
    ...(typeof record.failureMessage === "string" && record.failureMessage.trim()
      ? { failureMessage: record.failureMessage.trim() }
      : {}),
  };
}

/**
 * Format an array intelligently - handles arrays of objects, strings, mixed content
 */
function formatArray(arr: any[]): string {
  if (arr.length === 0) return "";

  // Map each item to a string representation
  const formatted = arr
    .map((item) => {
      if (typeof item === "string") {
        return item;
      } else if (typeof item === "number" || typeof item === "boolean") {
        return String(item);
      } else if (item === null || item === undefined) {
        return "";
      } else if (typeof item === "object") {
        // For objects, try to extract meaningful info
        // Check for common file/path properties
        if (item.name || item.filename || item.path || item.file) {
          // This looks like file info - extract the name/path
          const name = item.name || item.filename || item.path || item.file;
          // If there's additional info worth showing, add it
          if (item.type && item.type !== "file") {
            return `${name} (${item.type})`;
          } else if (item.size !== undefined) {
            return `${name} (${formatBytes(item.size)})`;
          } else {
            return name;
          }
        }

        // Check for common content properties
        if (item.content || item.text || item.message || item.output) {
          return item.content || item.text || item.message || item.output;
        }

        // Check if it's a simple key-value pair we can format nicely
        const keys = Object.keys(item);
        if (keys.length === 1) {
          return `${keys[0]}: ${item[keys[0]]}`;
        } else if (keys.length === 2 && item.key && item.value) {
          return `${item.key}: ${item.value}`;
        }

        // For other objects, create a compact representation
        // Try to create a one-line summary if possible
        const summary = createObjectSummary(item);
        if (summary) return summary;

        // Fall back to JSON but keep it readable
        return JSON.stringify(item, null, 2);
      } else {
        // For any other type, convert to string
        return String(item);
      }
    })
    .filter((item) => item !== ""); // Remove empty strings

  return formatted.join("\n");
}

/**
 * Format an object intelligently
 */
function formatObject(obj: any): string {
  // If it's a simple object with common patterns, format it nicely
  const keys = Object.keys(obj);

  // Single key-value pair
  if (keys.length === 1) {
    const key = keys[0];
    const value = obj[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return `${key}: ${value}`;
    } else if (Array.isArray(value)) {
      return formatArray(value);
    }
  }

  // Check for file-like objects
  if (obj.name || obj.filename || obj.path) {
    const name = obj.name || obj.filename || obj.path;
    const details = [];
    if (obj.type) details.push(`type: ${obj.type}`);
    if (obj.size !== undefined) details.push(`size: ${formatBytes(obj.size)}`);
    if (obj.modified) details.push(`modified: ${obj.modified}`);

    if (details.length > 0) {
      return `${name} (${details.join(", ")})`;
    }
    return name;
  }

  // Try to create a summary
  const summary = createObjectSummary(obj);
  if (summary) return summary;

  // Fall back to formatted JSON
  return JSON.stringify(obj, null, 2);
}

/**
 * Create a one-line summary of an object if possible
 */
function createObjectSummary(obj: any): string | null {
  const keys = Object.keys(obj);

  // For small objects, create inline format
  if (keys.length <= 3) {
    const parts = keys
      .map((key) => {
        const value = obj[key];
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          return `${key}: ${value}`;
        } else if (value === null) {
          return `${key}: null`;
        } else if (Array.isArray(value)) {
          return `${key}: [${value.length} items]`;
        } else if (typeof value === "object") {
          return `${key}: {...}`;
        }
        return null;
      })
      .filter((p) => p !== null);

    if (parts.length === keys.length) {
      return parts.join(", ");
    }
  }

  return null;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

/**
 * Extract filename from path
 */
function extractFilename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split("/").pop() || path;
}

/**
 * Get a description for a tool
 */
function getToolDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    read_file: "File contents",
    write_file: "File written",
    list_files: "Directory listing",
    search_files: "Search results",
    count_lines_of_code: "Lines of code",
    analyze_imports: "Import analysis",
    analyze_dependencies: "Dependencies",
    execute_command: "Command output",
    check_installation: "Installation check",
    call_agent: "Agent execution",
    call_subagent: "Subagent result",
    get_session_context: "Session context",
    update_session_memory: "Memory updated",
    orchestrate_agents: "Orchestration result",
    claude_code_execute: "Claude Code output",
    claude_code_list_sessions: "Claude sessions",
    claude_code_clear_session: "Session cleared",
  };

  return descriptions[toolName] || "Tool result";
}

/**
 * Generate a unique zip ID for a tool result
 */
export function generateToolZipId(
  toolName: string,
  timestamp?: number,
): string {
  const ts = timestamp || Date.now();
  const rand = Math.random().toString(36).substring(2, 11);
  return `tool_${toolName}_${ts}_${rand}`;
}

/**
 * Check if content should be zipped based on agent settings
 */
export function shouldZipToolResult(
  content: string,
  toolName: string,
  agent?: any,
  globalSettings?: any,
): boolean {
  const settings = getToolSettings(toolName, agent || {}, globalSettings);
  if (!content) return false;
  if (settings.zip_disabled) return false;
  if (settings.auto_zip) return true;
  const threshold = settings.zip_threshold ?? 0;
  const tokens = estimateTokens(content);

  return tokens >= threshold;
}
