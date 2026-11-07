/**
 * SA-139 (D13, V10): every field the Claude plan connection reads from Claude Code, by message kind,
 * with its type. Recorded real events of the pinned version (`__tests__/fixtures/claude-plan/recorded/`)
 * must satisfy it, the test double must satisfy it, and Automation B's weekly drift check runs one real
 * reply against it on the pin. A field Claude Code renames or drops fails here before a user sees it.
 */

type WireType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
/** A trailing `?` allows the field to be absent; `|null` allows null; when present it must have the type. */
type WireExpect = WireType | `${WireType}?` | `${WireType}|null` | `${WireType}|null?`

/** `a.b[].c` reads `c` of every item of array `b`; a key may contain `/` (`_meta.claudecode/toolUseId`). */
export type WireContract = Readonly<Record<string, Readonly<Record<string, WireExpect>>>>

/** stdout (stream-json). The kind is `type`, `/subtype` and, for stream events, `:event.type` plus the block or delta type. */
export const CLAUDE_PLAN_STDOUT_CONTRACT: WireContract = Object.freeze({
  'control_response': {
    'response.subtype': 'string', 'response.request_id': 'string',
    'response.response.claude_code_version': 'string', 'response.response.account': 'object',
    'response.response.account.subscriptionType': 'string', 'response.response.account.apiProvider': 'string',
    'response.response.models': 'array', 'response.response.models[].value': 'string',
    // Read for the effort check (D12): a rename must fail here, not read as "takes no effort".
    'response.response.models[].supportsEffort': 'boolean?', 'response.response.models[].supportedEffortLevels': 'array?',
    'response.response.models[].supportedEffortLevels[]': 'string?'
  },
  'system/init': {
    apiKeySource: 'string', claude_code_version: 'string', permissionMode: 'string', model: 'string',
    tools: 'array', mcp_servers: 'array', 'mcp_servers[].name': 'string', 'mcp_servers[].status': 'string',
    messaging_socket_path: 'string'
  },
  // P3 Part 1 reads a mid-step result's words and typed kind (D7; Faye S15 keeps them in the drift check).
  'result/success': { is_error: 'boolean', 'usage.output_tokens': 'number', result: 'string', api_error: 'string?', api_error_status: 'number|null?' },
  'result/error_during_execution': { is_error: 'boolean', errors: 'array' },
  'result/error_max_turns': { is_error: 'boolean', errors: 'array' },
  'result/error_max_budget_usd': { is_error: 'boolean', errors: 'array' },
  'result/error_max_structured_output_retries': { is_error: 'boolean', errors: 'array' },
  // P3 Part 1: the plan-limit state (a request served from extra usage also reads "rejected").
  'rate_limit_event': { 'rate_limit_info.status': 'string', 'rate_limit_info.isUsingOverage': 'boolean?', 'rate_limit_info.overageStatus': 'string?' },
  'stream_event:message_start': {
    parent_tool_use_id: 'null', 'event.message.id': 'string', 'event.message.model': 'string',
    'event.message.usage.input_tokens': 'number', 'event.message.usage.cache_read_input_tokens': 'number',
    'event.message.usage.cache_creation_input_tokens': 'number'
  },
  'stream_event:content_block_start.text': { 'event.index': 'number', 'event.content_block.text': 'string' },
  'stream_event:content_block_start.thinking': { 'event.index': 'number', 'event.content_block.thinking': 'string' },
  'stream_event:content_block_start.tool_use': { 'event.index': 'number', 'event.content_block.id': 'string', 'event.content_block.name': 'string' },
  'stream_event:content_block_delta.text_delta': { 'event.index': 'number', 'event.delta.text': 'string' },
  'stream_event:content_block_delta.thinking_delta': { 'event.index': 'number', 'event.delta.thinking': 'string' },
  'stream_event:content_block_delta.input_json_delta': { 'event.index': 'number', 'event.delta.partial_json': 'string' },
  'stream_event:content_block_stop': { 'event.index': 'number' },
  'stream_event:message_delta': { 'event.delta.stop_reason': 'string', 'event.usage.output_tokens': 'number' },
  'stream_event:message_stop': {},
  'user:tool_result': { 'message.content[].tool_use_id': 'string' },
  // P3 Part 2: the --replay-user-messages echo that shows a person's steer joined the next model call.
  // `message.content` is read too (a string or text blocks, matched exactly to what was written); the
  // checker has no string-or-array type, so a change there shows as `steer_not_delivered` refusals.
  'user:replay': { isReplay: 'boolean', 'message.role': 'string' },
  // Read only by its subtype (a retry before or after visible output); documented, never forced live.
  'system/api_retry': {}
})

/** Kinds the docs define that a short live recording cannot produce on demand (no forced failure). */
export const CLAUDE_PLAN_DOCUMENTED_ONLY_KINDS: ReadonlySet<string> = new Set([
  'system/api_retry',
  // Error results (D7): read from the pin's own result writers; a live recording cannot force them.
  'result/error_during_execution', 'result/error_max_turns', 'result/error_max_budget_usd', 'result/error_max_structured_output_retries'
])

/**
 * Kinds added to the contract after the committed recordings were made. The next live recording
 * (`BATSHIT_LIVE_CLAUDE_PLAN_RECORD`) must cover them, and then this list is emptied.
 */
// `user:replay` is covered by `recorded/steer.*`; its first echo is the opening prompt's, so the steer's own
// echo is proven by the Faye M4 test in `claudePlanWireContract.test.ts`, not by kind coverage alone.
export const CLAUDE_PLAN_NOT_YET_RECORDED_KINDS: ReadonlySet<string> = new Set([])

/** Hook inputs (stdin of each hook), by `hook_event_name`. */
export const CLAUDE_PLAN_HOOK_CONTRACT: WireContract = Object.freeze({
  SessionStart: { hook_event_name: 'string', source: 'string' },
  UserPromptSubmit: { hook_event_name: 'string', prompt: 'string' },
  PreToolUse: { hook_event_name: 'string', tool_use_id: 'string', tool_name: 'string', tool_input: 'object' },
  PostToolBatch: { hook_event_name: 'string', tool_calls: 'array', 'tool_calls[].tool_use_id': 'string' }
})

/** MCP requests Claude Code sends the bridge, by method. */
export const CLAUDE_PLAN_MCP_CONTRACT: WireContract = Object.freeze({
  initialize: { 'params.protocolVersion': 'string' },
  'tools/list': {},
  'tools/call': { 'params.name': 'string', 'params.arguments': 'object', 'params._meta.claudecode/toolUseId': 'string' }
})

/** The contract kind of one stdout event, or null for kinds the connection never reads. */
export function claudePlanStdoutKind(event: any): string | null {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'stream_event') {
    const inner = event.event ?? {}
    const detail = inner.content_block?.type ?? (inner.type === 'content_block_delta' ? inner.delta?.type : undefined)
    const kind = `stream_event:${inner.type}${detail ? `.${detail}` : ''}`
    return kind in CLAUDE_PLAN_STDOUT_CONTRACT ? kind : null
  }
  if (event.type === 'user') {
    if (event.isReplay === true) return 'user:replay'
    return Array.isArray(event.message?.content) && event.message.content.some((block: any) => block?.type === 'tool_result') ? 'user:tool_result' : null
  }
  const kind = event.subtype ? `${event.type}/${event.subtype}` : String(event.type)
  return kind in CLAUDE_PLAN_STDOUT_CONTRACT ? kind : null
}

function typeOf(value: unknown): WireType | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as WireType
}

function valuesAt(value: unknown, parts: string[]): unknown[] {
  if (!parts.length) return [value]
  const [head, ...rest] = parts
  const many = head.endsWith('[]')
  const key = many ? head.slice(0, -2) : head
  const next = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  if (!many) return valuesAt(next, rest)
  if (!Array.isArray(next)) return [undefined]
  const items = key === 'content' ? next.filter(item => (item as any)?.type === 'tool_result') : next
  return items.length ? items.flatMap(item => valuesAt(item, rest)) : [undefined]
}

/** The fields of `sample` that the contract for `kind` expects but finds missing or of another type. */
export function checkClaudePlanWire(contract: WireContract, kind: string, sample: unknown): string[] {
  const fields = contract[kind]
  if (!fields) return [`no contract for ${kind}`]
  const problems: string[] = []
  for (const [field, expected] of Object.entries(fields)) {
    const optional = expected.endsWith('?')
    const bare = optional ? expected.slice(0, -1) : expected
    const nullable = bare.endsWith('|null')
    const type = nullable ? bare.slice(0, -'|null'.length) : bare
    for (const value of valuesAt(sample, field.split('.'))) {
      const actual = typeOf(value)
      if (actual !== type && !(optional && actual === 'undefined') && !(nullable && actual === 'null')) { problems.push(`${kind} ${field}: expected ${expected}, got ${actual}`); break }
    }
  }
  return problems
}
