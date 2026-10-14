/**
 * BL-245 — what a reply that failed (or was stopped) mid-stream leaves in its Execution Viewer
 * snapshot, and the words it shows for the failure.
 *
 * The API lane wrote the run's model calls (`llmCalls`, `llmSummary`) and its tool steps into the
 * snapshot only in the AI SDK's finish callback. A reply that fails mid-stream never gets there:
 * send-routed stops reading the stream at the error, so the SDK never finishes its record of the
 * steps and never calls its finish. Seen on the SA-126 benchmark instance: a GLM 5.3 reply read
 * two files and wrote a script (three tool calls, several billed requests), then DashScope sent
 * an error chunk after 35 minutes, and the snapshot said `failed` with no calls, no summary, and
 * no tool steps. The user could not see what the failed reply cost or did.
 *
 * So send-routed hands every stream part it reads to a recorder, which keeps what each model
 * call showed: the request the SDK sent (`start-step`), the text and tool calls it answered, and,
 * once a call finished (`finish-step`), its usage and finish reason. On a failure the calls are
 * written from that record. A call that never finished has NO usage: it reads unknown, never zero.
 *
 * Second fact (same bug): a provider can send its error as a stream chunk. A lane whose chunk
 * schema does not also accept the error shape (the `@ai-sdk/alibaba` provider behind DashScope)
 * fails to parse it and reports a type validation error with the whole chunk inside it, so the
 * chat said "Failed to stream response" around a Zod message. `providerStreamErrorFrom` returns
 * the provider's own `error.message` from such a chunk, with its code kept beside it.
 */

import { isContextExhaustionError } from '$lib/server/services/contextExhaustion'

export type RecordedStreamStep = {
  request?: unknown
  response?: unknown
  usage?: unknown
  providerMetadata?: unknown
  finishReason: string | null
  toolCalls: Array<{ toolCallId?: string; toolName: string; input?: unknown }>
  toolResults: Array<{ toolCallId?: string; toolName?: string }>
  text: string
  /** The SDK finished this call (`finish-step`): its usage and finish reason are the provider's. */
  finished: boolean
}

export type StreamStepRecorder = {
  observe: (chunk: unknown) => void
  /**
   * Every call the stream began, in order. One still open when the stream ended (the call that
   * failed, or the one a Stop cut) gets `unfinishedReason`; it never had usage, which only a
   * finished call reports.
   */
  steps: (unfinishedReason: string) => RecordedStreamStep[]
}

export function createStreamStepRecorder(): StreamStepRecorder {
  const recorded: RecordedStreamStep[] = []
  let current: RecordedStreamStep | null = null

  const open = (): RecordedStreamStep => {
    const step: RecordedStreamStep = {
      finishReason: null,
      toolCalls: [],
      toolResults: [],
      text: '',
      finished: false
    }
    recorded.push(step)
    current = step
    return step
  }

  return {
    observe(chunk) {
      if (!chunk || typeof chunk !== 'object') return
      const part = chunk as Record<string, any>
      switch (part.type) {
        case 'start-step': {
          open().request = part.request
          break
        }
        case 'text-delta': {
          if (typeof part.text === 'string') (current ?? open()).text += part.text
          break
        }
        case 'tool-call': {
          if (typeof part.toolName !== 'string') break
          ;(current ?? open()).toolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input
          })
          break
        }
        case 'tool-result':
        case 'tool-error': {
          ;(current ?? open()).toolResults.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName
          })
          break
        }
        case 'finish-step': {
          const step = current ?? open()
          step.usage = part.usage
          step.finishReason = typeof part.finishReason === 'string' ? part.finishReason : null
          step.response = part.response
          step.providerMetadata = part.providerMetadata
          step.finished = true
          break
        }
        default:
          break
      }
    },
    steps(unfinishedReason) {
      return recorded.map((step) =>
        step.finished
          ? { ...step, toolCalls: [...step.toolCalls], toolResults: [...step.toolResults] }
          : {
              ...step,
              toolCalls: [...step.toolCalls],
              toolResults: [...step.toolResults],
              finishReason: unfinishedReason
            }
      )
    }
  }
}

/**
 * A provider error sent as a stream chunk: its own sentence as the message, and its own code
 * kept beside it (BL-245 review). The code is what the context-exhaustion check may need: a
 * provider can say `context_length_exceeded` in its code while its sentence says nothing the
 * classifier knows, and that turn must still continue.
 */
export class ProviderStreamError extends Error {
  readonly providerCode: string | null

  constructor(message: string, providerCode: string | null, cause: unknown) {
    super(message, { cause })
    this.name = 'ProviderStreamError'
    this.providerCode = providerCode
  }
}

/**
 * The provider's own error when a stream error is a chunk the SDK could not parse (a type
 * validation error carries that chunk as `value`). `null` when there is none.
 */
export function providerStreamErrorFrom(rawError: unknown): ProviderStreamError | null {
  if (!rawError || typeof rawError !== 'object') return null
  const candidate = rawError as Record<string, any>
  const chunk = candidate.value && typeof candidate.value === 'object' ? candidate.value : null
  const providerError =
    chunk?.error && typeof chunk.error === 'object' ? (chunk.error as Record<string, any>) : null
  const message = typeof providerError?.message === 'string' ? providerError.message.trim() : ''
  if (!message) return null
  const code =
    typeof providerError?.code === 'string' || typeof providerError?.code === 'number'
      ? String(providerError.code)
      : null
  return new ProviderStreamError(message, code, rawError)
}

/**
 * Did this failed stream run out of context? Its message, and, for a provider error chunk, the
 * provider's own code (BL-245 review: reading the sentence alone dropped the code the classifier
 * used to find inside the whole chunk).
 */
export function isContextExhaustedStreamFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (isContextExhaustionError(message)) return true
  return error instanceof ProviderStreamError && error.providerCode !== null
    ? isContextExhaustionError(error.providerCode)
    : false
}

/**
 * BL-245 review — ONE writer of a run's model calls. The finish path (the SDK's finish callback)
 * and the failure path (send-routed's catch) can both be under way: the loop waits at most 2 s
 * for the finish callback, and the snapshot merge keeps both writers' rows (their fingerprints
 * differ), so the calls showed twice. Whichever claims first writes the calls; the other writes
 * none. The claim is synchronous, taken before either awaits its write.
 */
export function createLlmCaptureClaim(): { claim: (by: 'finish' | 'failure') => boolean; readonly claimedBy: 'finish' | 'failure' | null } {
  let claimedBy: 'finish' | 'failure' | null = null
  return {
    claim(by) {
      if (claimedBy !== null) return false
      claimedBy = by
      return true
    },
    get claimedBy() {
      return claimedBy
    }
  }
}
