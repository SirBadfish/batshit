/**
 * BL-450: a tool call that FAILED on the API lane.
 *
 * The AI SDK reports three failures with a `tool-error` part instead of a `tool-result`: a call
 * whose arguments the tool's schema refused, a call to a tool that does not exist (both arrive
 * as an `invalid` `tool-call` followed by a `dynamic` `tool-error` whose `error` is a message),
 * and an `execute` that threw (an MCP gateway error; `error` is the thrown value). send-routed's
 * stream loop had no case for it, so the call's card never received a result, the page kept the
 * message in tool processing and held back every later word, and nothing was saved for the call.
 *
 * Each failure is turned into the ordinary failed tool result here, so it goes through the same
 * path as any other failed call: a zip, a card, a step, and an Execution Viewer row that say the
 * call failed and why (`{ success: false, error }` is what `toolStepFailureMessage` and the stored
 * zip already read as a failure). Pure, so it is tested against the installed SDK's real parts.
 */

export type ToolErrorPartLike = {
  type: 'tool-error'
  toolCallId?: unknown
  toolName?: unknown
  input?: unknown
  error?: unknown
  providerMetadata?: unknown
}

export type FailedToolResultPart = {
  type: 'tool-result'
  toolCallId?: string
  toolName?: string
  input: unknown
  output: { success: false; error: string }
}

const NO_MESSAGE = 'The tool call failed without an error message.'

/** The words a `tool-error` part's `error` gives: a message, an Error's message, or its JSON. */
export function toolErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim() || NO_MESSAGE
  if (error instanceof Error) return error.message.trim() || error.name || NO_MESSAGE
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch {
      // fall through
    }
  }
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  return NO_MESSAGE
}

/** A `tool-error` part as the failed `tool-result` every reader already handles. */
export function toolErrorAsFailedToolResult(part: ToolErrorPartLike): FailedToolResultPart {
  return {
    type: 'tool-result',
    ...(typeof part.toolCallId === 'string' && part.toolCallId ? { toolCallId: part.toolCallId } : {}),
    ...(typeof part.toolName === 'string' && part.toolName ? { toolName: part.toolName } : {}),
    input: part.input ?? {},
    output: { success: false, error: toolErrorMessage(part.error) }
  }
}

/**
 * Whether a step's content ended at a TOOL boundary: it carries a tool's answer, a result or a
 * failure. A steer lands only at a tool boundary (SA-114); a step whose only call failed is one
 * too, because the model reads the failure and takes another step.
 */
export function stepContentReachedToolBoundary(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((part: any) => part?.type === 'tool-result' || part?.type === 'tool-error')
}
