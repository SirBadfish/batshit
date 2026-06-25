/**
 * Vendored Codex CLI JSONL protocol types.
 *
 * Batshit runs Codex through `codex exec --json` and parses the emitted JSON
 * lines directly. These shapes used to come from `@openai/codex-sdk`, but that
 * dependency dragged ~188MB of platform binaries into every build, so Batshit
 * now owns a trimmed copy of only the event/item shapes the bridge and event
 * adapter actually consume.
 *
 * Source of truth: the `codex exec --json` event stream (same contract the
 * official SDK types describe). If Codex adds new event or item types, extend
 * these unions alongside `CodexEventAdapter`.
 */

/** The status of a command execution. */
export type CommandExecutionStatus = 'in_progress' | 'completed' | 'failed'

/** A command executed by the agent. */
export type CommandExecutionItem = {
  id: string
  type: 'command_execution'
  /** The command line executed by the agent. */
  command: string
  /** Aggregated stdout and stderr captured while the command was running. */
  aggregated_output: string
  /** Set when the command exits; omitted while still running. */
  exit_code?: number
  /** Current status of the command execution. */
  status: CommandExecutionStatus
}

/** Indicates the type of a file change. */
export type PatchChangeKind = 'add' | 'delete' | 'update'

/** A single file change inside a patch. */
export type FileUpdateChange = {
  path: string
  kind: PatchChangeKind
}

/** The status of a file change. */
export type PatchApplyStatus = 'completed' | 'failed'

/** A set of file changes by the agent. Emitted once the patch succeeds or fails. */
export type FileChangeItem = {
  id: string
  type: 'file_change'
  /** Individual file changes that comprise the patch. */
  changes: FileUpdateChange[]
  /** Whether the patch ultimately succeeded or failed. */
  status: PatchApplyStatus
}

/** The status of an MCP tool call. */
export type McpToolCallStatus = 'in_progress' | 'completed' | 'failed'

/**
 * Represents a call to an MCP tool. The item starts when the invocation is
 * dispatched and completes when the MCP server reports success or failure.
 */
export type McpToolCallItem = {
  id: string
  type: 'mcp_tool_call'
  /** Name of the MCP server handling the request. */
  server: string
  /** The tool invoked on the MCP server. */
  tool: string
  /** Arguments forwarded to the tool invocation. */
  arguments: unknown
  /** Result payload returned by the MCP server for successful calls. */
  result?: {
    content: unknown[]
    structured_content: unknown
  }
  /** Error message reported for failed calls. */
  error?: {
    message: string
  }
  /** Current status of the tool invocation. */
  status: McpToolCallStatus
}

/** Response from the agent. Either natural-language text or JSON when structured output is requested. */
export type AgentMessageItem = {
  id: string
  type: 'agent_message'
  text: string
}

/** Agent's reasoning summary. */
export type ReasoningItem = {
  id: string
  type: 'reasoning'
  text: string
}

/** Captures a web search request. Completes when results are returned to the agent. */
export type WebSearchItem = {
  id: string
  type: 'web_search'
  query: string
}

/** Describes a non-fatal error surfaced as an item. */
export type ErrorItem = {
  id: string
  type: 'error'
  message: string
}

/** An item in the agent's to-do list. */
export type TodoItem = {
  text: string
  completed: boolean
}

/**
 * Tracks the agent's running to-do list. Starts when the plan is issued,
 * updates as steps change, and completes when the turn ends.
 */
export type TodoListItem = {
  id: string
  type: 'todo_list'
  items: TodoItem[]
}

/** Canonical union of thread items and their type-specific payloads. */
export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem

/** Emitted when a new thread is started as the first event. */
export type ThreadStartedEvent = {
  type: 'thread.started'
  /** The identifier of the new thread. */
  thread_id: string
}

/** Emitted when a turn is started by sending a new prompt to the model. */
export type TurnStartedEvent = {
  type: 'turn.started'
}

/** Describes the usage of tokens during a turn. */
export type Usage = {
  /** The number of input tokens used during the turn. */
  input_tokens: number
  /** The number of cached input tokens used during the turn. */
  cached_input_tokens: number
  /** The number of output tokens used during the turn. */
  output_tokens: number
  /** The number of reasoning output tokens used during the turn. */
  reasoning_output_tokens: number
}

/** Emitted when a turn is completed. Typically right after the assistant's response. */
export type TurnCompletedEvent = {
  type: 'turn.completed'
  usage: Usage
}

/** Fatal error payload attached to a failed turn. */
export type ThreadError = {
  message: string
}

/** Indicates that a turn failed with an error. */
export type TurnFailedEvent = {
  type: 'turn.failed'
  error: ThreadError
}

/** Emitted when a new item is added to the thread. Typically the item is initially "in progress". */
export type ItemStartedEvent = {
  type: 'item.started'
  item: ThreadItem
}

/** Emitted when an item is updated. */
export type ItemUpdatedEvent = {
  type: 'item.updated'
  item: ThreadItem
}

/** Signals that an item has reached a terminal state — either success or failure. */
export type ItemCompletedEvent = {
  type: 'item.completed'
  item: ThreadItem
}

/** Represents an unrecoverable error emitted directly by the event stream. */
export type ThreadErrorEvent = {
  type: 'error'
  message: string
}

/** Top-level JSONL events emitted by `codex exec --json`. */
export type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadErrorEvent
