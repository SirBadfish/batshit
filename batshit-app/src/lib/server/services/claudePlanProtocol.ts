import { getErrorMessage, type JSONSchema7, type LanguageModelV4CallOptions, type LanguageModelV4FinishReason, type LanguageModelV4Prompt, type LanguageModelV4ToolResultOutput, type LanguageModelV4Usage } from '@ai-sdk/provider'
// The SDK's own helpers (the copy `ai` 7.0.119 uses), so an image here gets the media type the SDK's next prompt gives it.
import { detectMediaType, isFullMediaType } from '@ai-sdk/provider-utils'
import { isContextExhaustionError } from './contextExhaustion'

/**
 * SA-139 P2: the Claude plan connection's pure rules, with no process or socket: how Batshit's tools
 * are named and offered to Claude Code, how a tool result becomes the MCP result Claude reads, how the
 * first prompt becomes one stream-json user message, and how Claude Code's stream events read as
 * usage and finish reasons. Every input it cannot carry exactly is refused by name, never turned
 * into a placeholder (Ashe M4).
 */

export const CLAUDE_PLAN_MCP_SERVER = 'batshit'
export const CLAUDE_PLAN_APPROVAL_REFUSAL = 'This call came with an automatic approval decision, which the Claude plan connection does not take: only a card the person answers. Nothing that needed approval ran, and the reply stopped here.'
export const CLAUDE_PLAN_TOOL_PREFIX = `mcp__${CLAUDE_PLAN_MCP_SERVER}__`
/**
 * The Claude API takes tool names matching `^[a-zA-Z0-9_-]{1,128}$` (platform.claude.com, "Define tools",
 * read 2026-10-27), and Claude Code leaves out an MCP tool whose full name is over 128 characters (MCP docs,
 * read 2026-10-26): the wire name `mcp__batshit__<name>` must fit both.
 */
export const CLAUDE_PLAN_WIRE_NAME_LIMIT = 128
/** The documented ceiling for `anthropic/maxResultSizeChars`; Batshit's own guard cuts far below it. */
export const CLAUDE_PLAN_MAX_RESULT_SIZE_CHARS = 500_000
/**
 * The longest hook `additionalContext` Claude Code 2.1.296 passes on whole: a longer one is saved to a file
 * and Claude sees a 2,000-character preview and a path it cannot open (`--tools ""`) (bundle: the hook
 * executor runs every `additionalContext` through its large-output saver, threshold `1e4`). A step's
 * note longer than this is refused by name (SA-139 P3 Part 2 review), never cut. Recheck when the pin moves.
 */
export const CLAUDE_PLAN_HOOK_NOTE_LIMIT = 10_000
/** The terminal control Claude Code keeps while any MCP tool remains (tools reference, P0 §4). */
export const CLAUDE_PLAN_END_CONVERSATION_TOOL = 'EndConversation'

/**
 * Tools that change nothing (D4): only these get `readOnlyHint: true`, which lets Claude Code run a
 * batch of them together. A tool that writes, runs a command or calls out never gets it. The typed
 * `read_file` (`TYPED_READ_FILE_TOOL`, pinned by a test) reads the project and writes nothing.
 */

export type ClaudePlanErrorCode =
  | 'unsupported_input'
  | 'unsupported_tool'
  | 'unsupported_resume'
  | 'unsupported_addition'
  | 'unsupported_approval'
  | 'tools_changed'
  | 'startup_refused'
  | 'startup_timeout'
  | 'integrity'
  | 'retry_after_output'
  | 'run_ended'
  | 'run_failed'
  | 'plan_limit'
  | 'context_exhausted'
  | 'addition_too_long'
  | 'steer_not_delivered'
  | 'resume_changed'
  | 'end_conversation'
  | 'stopped'

/** Every refusal and failure of the connection reads as one of these, with a sentence a person can act on. */
export class ClaudePlanRunError extends Error {
  constructor(public readonly code: ClaudePlanErrorCode, message: string) {
    super(message)
    this.name = 'ClaudePlanRunError'
  }
}

export type ClaudePlanPreparedTool = Readonly<{
  /** Batshit's own tool name (the AI SDK key). */
  name: string
  /** The name Claude Code shows the model: `mcp__batshit__<name>`. */
  wireName: string
  description: string
  inputSchema: JSONSchema7
  readOnly: boolean
}>

const TOOL_NAME = /^[A-Za-z0-9_-]+$/

/** Preparation refuses what cannot be named exactly; a name is never truncated or rewritten (D4). */
export function prepareClaudePlanTools(tools: LanguageModelV4CallOptions['tools'], readOnly: ReadonlySet<string> = new Set()): ClaudePlanPreparedTool[] {
  const prepared: ClaudePlanPreparedTool[] = []
  for (const tool of tools ?? []) {
    if (tool.type !== 'function') {
      throw new ClaudePlanRunError('unsupported_tool', `The Claude plan connection cannot offer the provider tool ${tool.name}. Turn it off for this agent.`)
    }
    const wireName = `${CLAUDE_PLAN_TOOL_PREFIX}${tool.name}`
    if (!TOOL_NAME.test(tool.name) || wireName.length > CLAUDE_PLAN_WIRE_NAME_LIMIT) {
      throw new ClaudePlanRunError('unsupported_tool', `The tool name "${tool.name}" cannot be offered to Claude Code: it must be letters, digits, "_" or "-", and at most ${CLAUDE_PLAN_WIRE_NAME_LIMIT - CLAUDE_PLAN_TOOL_PREFIX.length} characters.`)
    }
    prepared.push(Object.freeze({
      name: tool.name,
      wireName,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      readOnly: readOnly.has(tool.name)
    }))
  }
  return prepared
}

/** Exactly what `tools/list` answers for one prepared tool. */
export function toMcpToolListing(tool: ClaudePlanPreparedTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly },
    _meta: { 'anthropic/maxResultSizeChars': CLAUDE_PLAN_MAX_RESULT_SIZE_CHARS }
  }
}

/** A stable fingerprint of the offered tools: a later step that offers different tools is refused (D8 is P3). */
export function claudePlanToolsFingerprint(tools: readonly ClaudePlanPreparedTool[]): string {
  return JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.inputSchema]))
}

/** The longest description, so the run can lift Claude Code's 4,096-character cut above it (D4, P0 §C). */
export function claudePlanDescriptionLimit(tools: readonly ClaudePlanPreparedTool[]): number {
  const longest = tools.reduce((max, tool) => Math.max(max, tool.description.length), 0)
  return Math.max(8192, longest + 1024)
}

/** The bare Batshit name for a streamed `mcp__batshit__<name>`; anything else is not Batshit's. */
export function mapClaudePlanWireName(wireName: string, tools: readonly ClaudePlanPreparedTool[]): ClaudePlanPreparedTool | null {
  return tools.find(tool => tool.wireName === wireName) ?? null
}

/**
 * BL-2368: Claude Code 2.1.296's own answer to a call whose name is none of its tools (recorded live,
 * `recorded/misnamed`): it runs no hook and nothing else, and records exactly this text, with
 * `is_error: true`, as the call's result before the message ends. Only this answer lets such a call
 * pass the run's integrity check; any other record of it ends the run.
 */
export function claudeCodeNoSuchToolText(name: string): string {
  return `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`
}

const NOTE_NAME_LIMIT = CLAUDE_PLAN_WIRE_NAME_LIMIT
/** At most this many wrong names are named in one note, so Batshit's own note can never pass the hook limit. */
const NOTE_NAME_COUNT = 5

/** BL-2368: the failure the SDK records for a call by a tool's bare name (no name on this connection). */
export function claudePlanUnlistedCallFailure(bareName: string): string {
  return `Claude asked for ${bareName}, which is no tool name on the Claude plan connection (its tools are named ${CLAUDE_PLAN_TOOL_PREFIX}<name>), so Claude Code ran nothing and neither did Batshit.`
}

/**
 * BL-2368: the step's note after calls to unlisted names, so Claude learns the form its tools take here
 * (Claude Code's own error names only the wrong name). A listed tool whose bare name is the wrong one, or
 * ends it after a `__` (`batshit__batshit__native_batshit_tool_use`), is offered as the likely meaning.
 * Each name once, at most five, so the note stays far below `CLAUDE_PLAN_HOOK_NOTE_LIMIT`.
 */
export function claudePlanUnlistedToolNote(names: readonly string[], tools: readonly ClaudePlanPreparedTool[]): string {
  const unique = [...new Set(names)]
  const lines = unique.slice(0, NOTE_NAME_COUNT).map(name => {
    const shown = name.length > NOTE_NAME_LIMIT ? `${name.slice(0, NOTE_NAME_LIMIT)}…` : name
    const meant = tools.filter(tool => name !== tool.wireName && (name === tool.name || name.endsWith(`__${tool.name}`)))
      .sort((a, b) => b.name.length - a.name.length)[0]
    return `Batshit: no tool is named ${shown}, so that call ran nothing. Batshit's tools are listed here as ${CLAUDE_PLAN_TOOL_PREFIX}<name>; call one by its exact listed name${meant ? ` (perhaps ${meant.wireName})` : ''}.`
  })
  if (unique.length > NOTE_NAME_COUNT) lines.push(`Batshit: ${unique.length - NOTE_NAME_COUNT} more wrong names; their calls ran nothing too.`)
  return lines.join('\n')
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type ClaudePlanToolAnswer = { isError: boolean; content: McpContent[] }

/** The SDK's download contract (`experimental_download`): one entry per request, null when refused. */
export type ClaudePlanDownload = (requests: Array<{ url: URL; isUrlSupportedByModel: boolean }>) =>
  PromiseLike<Array<{ data: Uint8Array; mediaType?: string | undefined } | null>>

function base64Of(data: Uint8Array | string): string {
  return typeof data === 'string' ? data : Buffer.from(data).toString('base64')
}

/**
 * An image as the SDK's next prompt holds it: the media type its bytes name wins over the declared one
 * (`ai` 7.0.119 `convertPartToLanguageModelPart`), so Claude and the record agree on the type.
 */
function imageContent(data: Uint8Array | string, declared: string): McpContent {
  if (typeof data === 'string' && data.startsWith('data:')) {
    throw new ClaudePlanRunError('unsupported_input', 'A tool returned an image as a data URL, which the AI SDK refuses as inline data. Nothing was sent.')
  }
  const mimeType = detectMediaType({ data, topLevelType: 'image' }) ?? declared
  return { type: 'image', data: base64Of(data), mimeType }
}

/**
 * A tool result as the MCP result Claude Code hands the model. The SAME conversion runs on what
 * Batshit releases and on what the SDK later records, so a mismatch is a real integrity failure.
 */
export function toClaudePlanToolAnswer(output: LanguageModelV4ToolResultOutput): ClaudePlanToolAnswer {
  switch (output.type) {
    case 'text': return { isError: false, content: [{ type: 'text', text: output.value }] }
    case 'json': return { isError: false, content: [{ type: 'text', text: JSON.stringify(output.value) }] }
    case 'error-text': return { isError: true, content: [{ type: 'text', text: output.value }] }
    case 'error-json': return { isError: true, content: [{ type: 'text', text: JSON.stringify(output.value) }] }
    case 'execution-denied':
      return { isError: true, content: [{ type: 'text', text: output.reason ? `The call was not run: ${output.reason}` : 'The call was not run.' }] }
    case 'content':
      return {
        isError: false,
        content: output.value.map((part): McpContent => {
          if (part.type === 'text') return { type: 'text', text: part.text }
          if (part.type === 'file' && part.mediaType.startsWith('image/') && part.data.type === 'data') {
            return imageContent(part.data.data, part.mediaType)
          }
          if (part.type === 'file' && part.data.type === 'text') return { type: 'text', text: part.data.text }
          throw new ClaudePlanRunError('unsupported_input', `A tool returned a ${part.type === 'file' ? part.mediaType : part.type} part the Claude plan connection cannot hand to Claude. Nothing was sent.`)
        })
      }
    default:
      throw new ClaudePlanRunError('unsupported_input', 'A tool returned a result shape the Claude plan connection cannot hand to Claude. Nothing was sent.')
  }
}

/**
 * The answer Batshit releases for a tool's model-facing output: an image given as a link is first
 * downloaded through the same download the SDK's next prompt uses (the API lane's guarded handler or
 * the SDK default), and refused by name when that download is refused or fails.
 */
export async function prepareClaudePlanToolAnswer(output: LanguageModelV4ToolResultOutput, download: ClaudePlanDownload): Promise<ClaudePlanToolAnswer> {
  if (output.type !== 'content') return toClaudePlanToolAnswer(output)
  const links = output.value.filter(part => part.type === 'file' && part.data.type === 'url') as Array<{ type: 'file'; mediaType: string; data: { type: 'url'; url: URL } }>
  if (!links.length) return toClaudePlanToolAnswer(output)
  const fetched = await download(links.map(part => ({ url: part.data.url, isUrlSupportedByModel: false })))
  const value = output.value.map(part => {
    if (part.type !== 'file' || part.data.type !== 'url') return part
    const index = links.indexOf(part as (typeof links)[number])
    const file = fetched[index]
    if (!file) throw new ClaudePlanRunError('unsupported_input', `Batshit could not fetch the image ${part.data.url.toString()} for Claude. Nothing was sent.`)
    const mediaType = file.mediaType && (!part.mediaType || !isFullMediaType(part.mediaType)) ? file.mediaType : part.mediaType
    return { ...part, mediaType, data: { type: 'data' as const, data: file.data } }
  })
  return toClaudePlanToolAnswer({ type: 'content', value })
}

/**
 * Two answers carry the same result: same error flag, text exactly, images by count and media type
 * (a link downloaded twice can differ by bytes, so bytes are not compared). Empty text items are
 * dropped on both sides. A side that names no image media type matches any. `imageTypes: false`
 * compares images by count only: Claude Code may resize a large image and re-encode it (Faye S8).
 */
export function sameClaudePlanToolAnswer(a: ClaudePlanToolAnswer, b: ClaudePlanToolAnswer, options: { imageTypes?: boolean } = {}): boolean {
  if (a.isError !== b.isError) return false
  const items = (answer: ClaudePlanToolAnswer) => answer.content.filter(item => !(item.type === 'text' && item.text === ''))
  const left = items(a)
  const right = items(b)
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    if (item.type !== other.type) return false
    if (item.type === 'text') return item.text === (other as typeof item).text
    if (options.imageTypes === false) return true
    const otherType = (other as typeof item).mimeType
    return !item.mimeType || !otherType || item.mimeType === otherType
  })
}

/** A `tool_result` as Claude Code recorded it (stream-json `user` event), in answer form. */
export function recordedClaudePlanToolAnswer(block: any): ClaudePlanToolAnswer {
  const raw = block?.content
  const content: McpContent[] = typeof raw === 'string' ? [{ type: 'text', text: raw }]
    : Array.isArray(raw) ? raw.map((item: any): McpContent => item?.type === 'text' ? { type: 'text', text: String(item.text ?? '') }
      : item?.type === 'image' ? { type: 'image', data: String(item.source?.data ?? item.data ?? ''), mimeType: String(item.source?.media_type ?? item.mimeType ?? '') }
        : { type: 'text', text: `\u0000${String(item?.type)}` })
      : []
  return { isError: block?.is_error === true, content }
}

/** The SDK's model text for a call it refused before running (`tool-error` of an invalid call). */
export function claudePlanSdkErrorAnswer(error: unknown): ClaudePlanToolAnswer {
  return { isError: true, content: [{ type: 'text', text: getErrorMessage(error) }] }
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function toClaudeBlock(part: any): ClaudeContentBlock {
  if (part?.type === 'text') return { type: 'text', text: String(part.text ?? '') }
  if (part?.type === 'file') {
    const media = String(part.mediaType ?? '')
    const data = part.data
    if (data?.type === 'text') return { type: 'text', text: String(data.text ?? '') }
    if (data?.type === 'data' && IMAGE_TYPES.has(media)) {
      return { type: 'image', source: { type: 'base64', media_type: media, data: base64Of(data.data) } }
    }
    if (data?.type === 'data' && media === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Of(data.data) } }
    }
    throw new ClaudePlanRunError('unsupported_input', `This message holds a ${media || 'file'} attachment the Claude plan connection cannot hand to Claude (images and PDFs only). Nothing was sent.`)
  }
  throw new ClaudePlanRunError('unsupported_input', `This message holds a ${part?.type ?? 'unknown'} part the Claude plan connection cannot hand to Claude. Nothing was sent.`)
}

export type ClaudePlanOpening = { systemPrompt: string; content: ClaudeContentBlock[] }

/**
 * The first prompt of a reply: Batshit's compiled system entries, then its compiled user turn
 * (plus any first-step additions, in order) as ONE stream-json user message. A prompt that already
 * holds assistant or tool messages is an approval resume, which P3 carries.
 */
export function buildClaudePlanOpening(prompt: LanguageModelV4Prompt): ClaudePlanOpening {
  const system: string[] = []
  const content: ClaudeContentBlock[] = []
  let seenUser = false
  for (const message of prompt) {
    if (message.role === 'system') {
      if (seenUser) throw new ClaudePlanRunError('unsupported_input', 'Batshit compiled a system entry after the user turn, which the Claude plan connection cannot place. Nothing was sent.')
      system.push(message.content)
      continue
    }
    if (message.role !== 'user') {
      throw new ClaudePlanRunError('unsupported_resume', 'This reply continues earlier model output (an approval resume), which the Claude plan connection cannot carry yet. Nothing ran.')
    }
    seenUser = true
    for (const part of message.content) content.push(toClaudeBlock(part))
  }
  if (!seenUser || content.length === 0) throw new ClaudePlanRunError('unsupported_input', 'Batshit compiled no user turn for Claude. Nothing was sent.')
  return { systemPrompt: system.join('\n\n'), content }
}

/**
 * D17 (Josh, 2026-10-27; BL-2368): Batshit's prompt names its tools bare, and Claude Code lists them as
 * `mcp__batshit__<name>`. This one fixed line says so. It is the adapter's, as the prefix is: the compiler
 * never writes it, so no API-lane prompt holds it.
 */
export const CLAUDE_PLAN_TOOL_NAMES_LINE = `On this connection your tools are listed as ${CLAUDE_PLAN_TOOL_PREFIX}<name>; call each one by its listed name.`

/**
 * The run's system text: the line first, so it sits in the Batshit zone and never after Awareness, which
 * closes the compiled prompt (context pipeline §2.0). It never changes, so the prefix stays stable. A run
 * that offers no tools (Compact) gets none.
 */
export function claudePlanSystemText(systemPrompt: string, tools: readonly ClaudePlanPreparedTool[]): string {
  if (tools.length === 0) return systemPrompt
  return systemPrompt ? `${CLAUDE_PLAN_TOOL_NAMES_LINE}\n\n${systemPrompt}` : CLAUDE_PLAN_TOOL_NAMES_LINE
}

export function claudePlanFinishReason(stopReason: unknown): LanguageModelV4FinishReason {
  const raw = typeof stopReason === 'string' ? stopReason : undefined
  switch (raw) {
    case 'tool_use': return { unified: 'tool-calls', raw }
    case 'end_turn':
    case 'stop_sequence': return { unified: 'stop', raw }
    // As the API lane's Anthropic provider maps them (`@ai-sdk/anthropic` `mapAnthropicStopReason`).
    case 'max_tokens':
    case 'model_context_window_exceeded': return { unified: 'length', raw }
    case 'refusal': return { unified: 'content-filter', raw }
    default: return { unified: 'other', raw }
  }
}

/**
 * Faye S14 (P3 Part 1 read): the plan limit answers as the ChatGPT plan's limit does (HTTP 429, with its
 * code), so it reads like every other model's limit. Other run failures keep the stream's own answer.
 */
export function claudePlanRunHttpStatus(error: unknown): number | null {
  return error instanceof ClaudePlanRunError && error.code === 'plan_limit' ? 429 : null
}

/** Claude Code's own words (already cut short), kept only where they cannot be read as a context overflow. */
function claudeCodeSays(clipped: string): string {
  return clipped && !isContextExhaustionError(clipped) ? ` Claude Code says: "${clipped}"` : ''
}

const RESULT_SUBTYPE_FAILURES: Readonly<Record<string, string>> = {
  error_max_turns: 'Claude Code stopped at a turn limit (error_max_turns). Batshit sets no such limit, so this is not expected. The reply stopped here, and nothing more ran.',
  error_during_execution: 'Claude Code hit an error while it ran this reply (error_during_execution). The reply stopped here, and nothing more ran. Send the message again to retry.',
  error_max_budget_usd: 'Claude Code stopped at a spending cap (error_max_budget_usd). Batshit sets no such cap, so this is not expected. The reply stopped here, and nothing more ran.',
  error_max_structured_output_retries: 'Claude Code stopped while it retried a structured answer (error_max_structured_output_retries). Batshit asks for no structured answer, so this is not expected. The reply stopped here, and nothing more ran.'
}

/**
 * A refused request by its rate-limit state alone, for an error that carries no typed kind (review A1, B S1).
 * On the pin a request served from extra usage also reads `status: "rejected"`, with `isUsingOverage: true`
 * (stream-json's `rate_limit_info` is `{ status, resetsAt, rateLimitType, isUsingOverage }`); only a 429 with
 * no extra usage in play is the plan's limit.
 */
function refusedByPlanLimit(result: any, rateLimit: any): boolean {
  return result?.api_error === undefined && result?.api_error_status === 429 && rateLimit?.status === 'rejected' &&
    rateLimit?.isUsingOverage !== true && (rateLimit?.overageStatus == null || rateLimit.overageStatus === 'rejected')
}

/**
 * D7, Faye S2: a `result` that arrives while a step is still open ends the run, and each kind reads as
 * its own failure. A plan usage limit (Claude Code's typed `api_error: "usage_limit_reached"`, or an
 * untyped 429 under a rejected rate-limit state with no extra usage in play) is checked first and
 * worded in Batshit's own words, so the context-exhaustion classifier (`contextExhaustion.ts`) never
 * matches it and send-routed never continues it by itself. Context exhaustion keeps Claude Code's
 * words, which that classifier matches, so the API lane's existing continuation applies (a fresh
 * request, which starts a fresh run). Any other error keeps Claude Code's words only where they cannot
 * match it. Claude Code's words are cut to 300 characters before they are classified, so what is
 * kept is what matched. An error subtype's `errors[]` (stack traces and paths) is never shown.
 */
export function claudePlanResultFailure(result: any, rateLimit: unknown = null): ClaudePlanRunError {
  const subtype = typeof result?.subtype === 'string' ? result.subtype : 'result'
  const clipped = typeof result?.result === 'string' ? result.result.trim().slice(0, 300) : ''
  if (subtype === 'success') {
    if (result?.is_error === true && (result.api_error === 'usage_limit_reached' || refusedByPlanLimit(result, rateLimit))) {
      return new ClaudePlanRunError('plan_limit', `Your Claude plan's usage limit is reached, so Claude did not answer. Batshit does not retry by itself: send the message again after the limit resets, or choose another model.${claudeCodeSays(clipped)}`)
    }
    if (result?.is_error === true && isContextExhaustionError(clipped)) {
      return new ClaudePlanRunError('context_exhausted', `Claude's context window is full for this reply. Claude Code says: "${clipped}"`)
    }
    if (result?.is_error === true) {
      return new ClaudePlanRunError('run_failed', `Claude Code reported an error and ended the run. The reply stopped here, and nothing more ran.${claudeCodeSays(clipped)}`)
    }
    return new ClaudePlanRunError('run_failed', 'Claude Code ended the run before this step finished. The reply stopped here, and nothing more ran.')
  }
  return new ClaudePlanRunError('run_failed', RESULT_SUBTYPE_FAILURES[subtype] ?? `Claude Code ended the run (${subtype.slice(0, 80)}). The reply stopped here, and nothing more ran.`)
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * One model call's usage: input from `message_start`, output from the final `message_delta` (the start's
 * output count is partial). `output_tokens_details.thinking_tokens` is the billed output spent on
 * reasoning (Anthropic's extended-thinking docs, read 2026-10-27), so text is the rest. Missing counts
 * stay unknown, never zero.
 */
export function claudePlanUsage(start: any, delta: any): LanguageModelV4Usage {
  const noCache = count(start?.input_tokens)
  const cacheRead = count(start?.cache_read_input_tokens)
  const cacheWrite = count(start?.cache_creation_input_tokens)
  const output = count(delta?.output_tokens)
  const reasoning = count(delta?.output_tokens_details?.thinking_tokens)
  return {
    inputTokens: {
      total: noCache !== undefined && cacheRead !== undefined && cacheWrite !== undefined ? noCache + cacheRead + cacheWrite : undefined,
      noCache,
      cacheRead,
      cacheWrite
    },
    outputTokens: { total: output, text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined, reasoning },
    raw: { ...(start && typeof start === 'object' ? start : {}), ...(delta && typeof delta === 'object' ? delta : {}) }
  }
}
