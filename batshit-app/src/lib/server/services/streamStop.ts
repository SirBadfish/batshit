/**
 * A stopped stream is INTERRUPTED, whatever else it ended with (2026-09-18).
 *
 * send-routed's stream handler reads the run's stream to its end and then judges what it got.
 * The AI SDK ends an aborted stream in one of two ways: its `stream` throws the abort reason
 * (the string `'user'`), or it enqueues an `abort` part and completes normally. In the second
 * case the handler went on as if the reply had finished: it read the result's `steps`, which
 * reject with the reason (`Failed to parse tool approval requests user`), and judged a reply
 * with no words yet as a provider failure (`The model provider returned an empty response`);
 * only the catch's abort check then turned it back into the interrupted answer. Every Stop also
 * logged `[Send-Routed] Batshit agent streaming error: …` (the reason on the API lane, the
 * lane's `AbortError` on Codex). The stored message and the answer were right; the log said
 * the provider failed. Measured: `_local/sconn-proof/stopapi-before-*.json`.
 */

/** Thrown after the stream loop so a stopped run takes the handler's interrupted path. */
export class StreamStoppedError extends Error {
  constructor() {
    super('The stream was stopped.')
    this.name = 'AbortError'
  }
}

export type StreamEnd =
  | { kind: 'stopped' }
  | { kind: 'failed'; error: Error }
  | { kind: 'finished' }

/**
 * What the stream's end means. A Stop wins over an error the stream also reported, because the
 * error is usually the Stop itself. Only a stream that was not stopped goes on to be judged for
 * approvals and for an empty reply, so a real empty reply is still reported.
 */
export function judgeStreamEnd(input: { stopped: boolean; runtimeError: Error | null }): StreamEnd {
  if (input.stopped) return { kind: 'stopped' }
  if (input.runtimeError) return { kind: 'failed', error: input.runtimeError }
  return { kind: 'finished' }
}

/** Was this caught error the Stop (or thrown because of it), rather than a provider failure? */
export function isStopError(error: unknown, signals: Array<AbortSignal | null | undefined>): boolean {
  return (
    (error as { name?: unknown } | null)?.name === 'AbortError' ||
    signals.some((signal) => signal?.aborted === true)
  )
}
