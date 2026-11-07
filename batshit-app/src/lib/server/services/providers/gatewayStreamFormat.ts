import { wrapLanguageModel } from 'ai'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'

/**
 * BL-1782: the Vercel AI Gateway answers in a stream format the installed AI SDK cannot read, and
 * a tool call in that answer never runs.
 *
 * `@ai-sdk/gateway` 4.0.97 asks the Gateway for language-model specification v4 and passes every
 * stream part it receives through unchanged, but the Gateway's `finish` part has the older shape:
 * `finishReason` a plain string (`"tool-calls"`) and `usage` flat numbers (v4:
 * `finishReason: { unified, raw }`, `usage.inputTokens: { total, ... }`). `ai` 7.0.119 reads
 * `finishReason.unified`, gets nothing, and refuses to run the queued tool calls of that model
 * call (`isToolExecutionAllowedFinishReason`), so the step ends with no finish reason and no tool
 * run: with nothing else written the reply failed as "The model provider returned an empty
 * response."; with words before the call it was saved as a finished reply whose tool call silently
 * never ran. A call that asked for approval is different: the SDK raises its card at the call,
 * before the finish, and Approve runs the tool before the next model call, so that flow works.
 *
 * Two halves, one owner:
 *
 * - `observeGatewayStreamFormat` wraps every Gateway model (`ProviderManager.buildModel`, the one
 *   place one is built). It only logs: when a model call's `finish` part has no readable finish
 *   reason and the call asked for a tool Batshit runs, it logs the model id, the number of such
 *   calls and the part's shape (field names and types, never the part's values), once for that
 *   call. It changes and converts nothing.
 * - One rule over a step's tool parts (`unrunToolCallNames`): a step that finished with no
 *   readable reason while a tool call Batshit runs got no result, no error, no denial and no
 *   approval card left that call unrun. `createGatewayStreamFormatCheck` applies it to the SDK's
 *   result stream, where the SDK's own outcome of each call is visible; both consumers of an API
 *   run's stream use it (send-routed's loop, `processNativeMode` for API Subagents and Workers).
 *   `isGatewayStreamFormatStep` applies the same rule to a finished step (`StepResult.content`),
 *   for send-routed's finish callback, which must leave such a run to the failure recorder.
 *   Only the Gateway's answers are known to end a step that way.
 */

export const GATEWAY_STREAM_FORMAT_ERROR_CODE = 'GATEWAY_STREAM_FORMAT' as const

/** The sentence the chat shows (the BL-1782 decision, 2026-10-18), naming the tool calls that did not run. */
export function describeGatewayStreamFormatFailure(toolNames: readonly string[]): string {
  const calls = toolNames.length === 1 ? `the tool call ${toolNames[0]}` : `the tool calls ${toolNames.join(', ')}`
  return `The Vercel AI Gateway replied in a stream format this Batshit version cannot read, so ${calls} did not run; use a direct provider connection for this model.`
}

/** `code` and `status` are what send-routed's failure path reads (`getFailureCode`, `getFailureStatus`). */
export class GatewayStreamFormatError extends Error {
  readonly code = GATEWAY_STREAM_FORMAT_ERROR_CODE
  readonly status = 502
  readonly toolNames: readonly string[]

  constructor(toolNames: readonly string[]) {
    super(describeGatewayStreamFormatFailure(toolNames))
    this.name = 'GatewayStreamFormatError'
    this.toolNames = [...toolNames]
  }
}

/** A v4 finish reason: `{ unified: string, raw?: string }`. */
function isReadableFinishReason(finishReason: unknown): boolean {
  return (
    typeof finishReason === 'object' &&
    finishReason !== null &&
    typeof (finishReason as { unified?: unknown }).unified === 'string'
  )
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * The finish part's field names and value types, one level into `finishReason` and `usage` (where
 * the two shapes differ). No value of the part is copied: its counts, ids and provider metadata stay
 * out of the log.
 */
export function describeFinishPartShape(part: unknown): Record<string, unknown> {
  if (typeof part !== 'object' || part === null) return { part: typeName(part) }
  const shape: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(part as Record<string, unknown>)) {
    if ((field === 'finishReason' || field === 'usage') && typeName(value) === 'object') {
      shape[field] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([inner, innerValue]) => [inner, typeName(innerValue)])
      )
    } else {
      shape[field] = typeName(value)
    }
  }
  return shape
}

/** Wraps a Gateway language model (specification v4) with the log-only observer; anything else is returned as it came. */
export function observeGatewayStreamFormat<T>(model: T): T {
  if (
    typeof model !== 'object' ||
    model === null ||
    (model as { specificationVersion?: unknown }).specificationVersion !== 'v4'
  ) {
    return model
  }
  const gatewayModel = model as unknown as LanguageModelV4
  return wrapLanguageModel({
    model: gatewayModel,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream }) => {
        const result = await doStream()
        // Per model call: the tool calls it asked for that Batshit runs (not the provider).
        let toolCalls = 0
        const stream = result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === 'tool-call' && part.providerExecuted !== true) toolCalls += 1
              if (part.type === 'finish' && toolCalls > 0 && !isReadableFinishReason(part.finishReason)) {
                console.warn(
                  '[ProviderManager] BL-1782: the AI Gateway sent a finish part this AI SDK cannot read; a tool call of this model call runs only through an approval card',
                  { modelId: gatewayModel.modelId, toolCalls, finishPartShape: describeFinishPartShape(part) }
                )
              }
              controller.enqueue(part)
            }
          })
        )
        return { ...result, stream }
      }
    }
  }) as unknown as T
}

/** The part types of a step that bear on its tool calls, in the stream and in `StepResult.content`. */
const TOOL_PART_TYPES = new Set([
  'tool-call',
  'tool-result',
  'tool-error',
  'tool-output-denied',
  'tool-approval-request',
  'tool-approval-response'
])

function partToolCallId(part: Record<string, any>): unknown {
  return part.toolCall?.toolCallId ?? part.toolCallId
}

/**
 * The tool calls Batshit runs that a step left unrun, in call order: none when the step finished
 * with a readable reason (a string). `parts` are the step's parts in order, from the result stream
 * or from `StepResult.content` (which records approvals and errors but not `tool-output-denied`).
 */
function unrunToolCallNames(parts: Iterable<unknown>, finishReason: unknown): string[] {
  if (typeof finishReason === 'string') return []
  const waiting = new Map<string, string>()
  for (const chunk of parts) {
    if (!chunk || typeof chunk !== 'object') continue
    const part = chunk as Record<string, any>
    const toolCallId = partToolCallId(part)
    if (typeof toolCallId !== 'string') continue
    switch (part.type) {
      case 'tool-call':
        if (part.providerExecuted !== true) waiting.set(toolCallId, typeof part.toolName === 'string' ? part.toolName : 'unknown')
        break
      case 'tool-result':
      case 'tool-error':
      case 'tool-output-denied':
        waiting.delete(toolCallId)
        break
      case 'tool-approval-request':
        // A card: Approve runs the call before the next model call, whatever this step's finish
        // said. An automatic approval is no card: it queues the call to run at this step's finish.
        if (part.isAutomatic !== true) waiting.delete(toolCallId)
        break
      case 'tool-approval-response':
        // An automatic denial (step content keeps it; the stream also sends `tool-output-denied`).
        if (part.approved === false) waiting.delete(toolCallId)
        break
    }
  }
  return [...waiting.values()]
}

/** Did this finished SDK step (`StepResult`: own `content` and `finishReason`) leave a Batshit-run tool call unrun? */
export function isGatewayStreamFormatStep(step: unknown): boolean {
  if (!step || typeof step !== 'object') return false
  const { content, finishReason } = step as { content?: unknown; finishReason?: unknown }
  return Array.isArray(content) && unrunToolCallNames(content, finishReason).length > 0
}

export interface GatewayStreamFormatCheck {
  /** Every part of the SDK's result stream, in order: the failure of the step this part finished, or null. */
  observe(part: unknown): GatewayStreamFormatError | null
}

/** One per run's result stream (the SDK's `result.stream`, with `start-step` / `finish-step`). */
export function createGatewayStreamFormatCheck(): GatewayStreamFormatCheck {
  // This step's tool parts so far, in order.
  let stepParts: unknown[] = []
  return {
    observe(chunk) {
      if (!chunk || typeof chunk !== 'object') return null
      const part = chunk as Record<string, any>
      if (part.type === 'start-step') {
        stepParts = []
        return null
      }
      if (part.type === 'finish-step') {
        const unrun = unrunToolCallNames(stepParts, part.finishReason)
        stepParts = []
        return unrun.length > 0 ? new GatewayStreamFormatError(unrun) : null
      }
      if (TOOL_PART_TYPES.has(part.type)) stepParts.push(part)
      return null
    }
  }
}
