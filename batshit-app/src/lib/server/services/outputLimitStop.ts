/**
 * A reply whose last model request stopped at the OUTPUT limit (BL-239, 2026-09-24).
 *
 * The AI SDK ends such a stream normally: the last request's finish reason is `length`, nothing
 * throws, and the tool loop stops because that request made no tool call. send-routed then
 * treated the reply as finished. On the SA-126 benchmark instance GLM 5.3 thought for 65,534
 * tokens, hit dashscope-intl's default output limit of 65,536, and the whole saved reply was the
 * letter "I", shown with no notice; only the Execution Viewer said `length`. A reply that stopped
 * before writing anything at all was reported as "The model provider returned an empty response",
 * which sends the user looking in the wrong place.
 *
 * Both now become a failed turn of their own kind, `output_limit`, through the same metadata the
 * failure banner, the compile note, and the zip recovery hold already read (`response_failed`,
 * `error_message`, `failure_kind`). The rule is here; send-routed's pins are in
 * `send-routed-output-limit-contract.test.ts`. API lane only: the CLI tools meet their own output
 * limits inside their own loops, and their adapters never report a `length` finish.
 */

export const OUTPUT_LIMIT_FAILURE_KIND = 'output_limit' as const

/** The error code of a turn that reached the output limit before it wrote any reply. */
export const OUTPUT_LIMIT_ERROR_CODE = 'MODEL_OUTPUT_LIMIT' as const

/** Did the run's last model request stop at the output limit? (`finish.finishReason`) */
export function isOutputLimitFinish(finishReason: unknown): boolean {
  return finishReason === 'length'
}

function limitPhrase(outputTokens: number | null | undefined): string {
  return typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
    ? `its output limit of ${Math.round(outputTokens).toLocaleString('en-US')} tokens`
    : 'its output limit'
}

/**
 * The sentence the banner shows and the next compile passes on. `outputTokens` is the last
 * request's output count, which at a `length` stop is the limit itself; `wroteReply` says whether
 * any reply text or tool work came before the stop.
 */
export function describeOutputLimitStop(input: {
  outputTokens: number | null | undefined
  wroteReply: boolean
}): string {
  const limit = limitPhrase(input.outputTokens)
  return input.wroteReply
    ? `The model reached ${limit} before this reply was finished. Ask the agent to continue, or raise Max Tokens in its model preset.`
    : `The model reached ${limit} before it wrote a reply (its thinking counts toward the limit). Ask again, or raise Max Tokens in its model preset.`
}

/**
 * Metadata for a reply that DID write something before the stop. It joins the reply's own end
 * metadata (never replaces it), so the `end` event and the saved message carry the same facts.
 */
export function outputLimitFailureMetadata(
  message: string,
  failedAt: string = new Date().toISOString(),
): {
  response_failed: true
  failure_kind: typeof OUTPUT_LIMIT_FAILURE_KIND
  error_message: string
  error_code: typeof OUTPUT_LIMIT_ERROR_CODE
  failed_at: string
} {
  return {
    response_failed: true,
    failure_kind: OUTPUT_LIMIT_FAILURE_KIND,
    error_message: message,
    error_code: OUTPUT_LIMIT_ERROR_CODE,
    failed_at: failedAt,
  }
}
