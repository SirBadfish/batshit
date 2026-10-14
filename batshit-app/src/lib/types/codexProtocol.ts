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

/**
 * Indicates the type of a file change. `move` is a bare rename, which only the app-server lane
 * reports (as `update` with a `move_path`); a rename that also changed lines stays `update`.
 */
export type PatchChangeKind = 'add' | 'delete' | 'update' | 'move'

/** A single file change inside a patch. */
export type FileUpdateChange = {
  path: string
  kind: PatchChangeKind
  /** App-server lane only: where a renamed file went (the app server's `move_path`). */
  to?: string
  /**
   * App-server lane only: Codex's own record of this file's change. Unified hunks for an update,
   * the whole text for an add or a delete; a rename's ends `\n\nMoved to: <path>`.
   */
  diff?: string
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

/**
 * What a web search step did, as the exec stream writes it (the Responses API action, snake_case
 * `type`). The app server writes the same action camelCase (`openPage`, `findInPage`, with `null`
 * for a missing field); `codexAppServerLane` maps it to this shape (BL-460).
 */
export type WebSearchAction =
  | { type: 'search'; query?: string; queries?: string[] }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string }
  | { type: 'other' }

/** Captures a web search request. Completes when results are returned to the agent. */
export type WebSearchItem = {
  id: string
  type: 'web_search'
  query: string
  /** The search, the opened page, or the find in a page; the event adapter reads its URL and queries. */
  action?: WebSearchAction
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
  /** The turn's input tokens, including cache reads and writes. */
  input_tokens: number
  /** The number of cached input tokens used during the turn. */
  cached_input_tokens: number
  /** Cache writes included in input tokens, when reported by the app-server lane. */
  cache_write_input_tokens?: number
  /** The number of output tokens used during the turn. */
  output_tokens: number
  /** The number of reasoning output tokens used during the turn. */
  reasoning_output_tokens: number
}

/**
 * Emitted when a turn is completed. Typically right after the assistant's response.
 *
 * BL-1376: `codex exec` always sends all four counts. The app-server lane sends only the counts
 * Codex reported (`mapAppServerUsage`): `null` when the turn got no `thread/tokenUsage/updated`,
 * and a count Codex left out stays out. A missing count is unknown, never a zero.
 */
export type TurnCompletedEvent = {
  type: 'turn.completed'
  usage: Partial<Usage> | null
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

/**
 * SA-114 P2 (DL-114-06, AMD-114-02) — Batshit-synthetic: the app server confirmed a steer.
 *
 * Codex has no event for "the model has your mid-turn message". What it does emit, within
 * milliseconds of accepting a `turn/steer`, is a `userMessage` item carrying the exact text
 * that was steered — and `codexAppServerLane` recognises that item as the one it just sent
 * and pushes this in its place. It is synthetic in the same way `turn.started` is when the
 * app-server lane maps a notification onto the exec-JSONL shape: nothing in `codex exec`
 * emits it, because `codex exec` cannot be steered at all.
 */
export type SteerDeliveredEvent = {
  type: 'steer.delivered'
  steer_ids: string[]
}

/**
 * BL-759 — Batshit-synthetic: Codex is retrying a dropped model response by itself.
 *
 * The app server says so with an `error` notification whose `willRetry` is `true` (BL-457), and
 * then starts the answer again as a NEW item, never completing the one that dropped.
 * `codexAppServerLane` pushes this in the notice's place so the event adapter can take back every
 * agent message that started and never completed. `message` and `details` are Codex's own words
 * (`Reconnecting... 1/5`, and why). Nothing in `codex exec` emits it: that transport reports a
 * retry as a plain `error` line (BL-457's known gap).
 */
export type StreamRetryEvent = {
  type: 'stream.retry'
  message: string | null
  details: string | null
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
  | SteerDeliveredEvent
  | StreamRetryEvent
