/**
 * BL-1959 (2026-10-21): a Stop during a running tool call must still record the call.
 *
 * The AI SDK (7.0.119, pinned in `lateToolResults.test.ts`) answers a Stop that lands while a tool
 * runs by waiting for that tool's `execute` to settle and then ending the stream with an `abort`
 * part, without the call's `tool-result`: the result the tool returned (a stopped command, and since
 * SA-126 item 2 a patch it had already applied) reached no one, so the stopped reply was saved with
 * no step and no zip, and its bubble said it was stopped before it said anything. A call an
 * approval click resumes streams no `tool-call` part at all (only its result), and a tool that never
 * settles keeps the SDK's stream open after the Stop.
 *
 * Two halves, so the existing save path records the call unchanged (BL-775: the server saves the
 * rebuild of the recorded stream events, then publishes `end`):
 *
 * - `trackToolExecution` remembers each running `execute` (its name, input and result) under the
 *   run's own Stop signal, the `abortSignal` the SDK hands every tool of that run (`vercelBrain.ts`
 *   wraps every API tool's `execute` with it). Keyed by that signal, one run never sees another's
 *   calls, and a run's record goes with its signal.
 * - `withToolResultsOnStop` wraps the stream send-routed reads. When the stream ends in a Stop (an
 *   `abort` part, a throw while the signal is aborted, or no part for `STOPPED_TOOL_WAIT_MS` after
 *   the Stop while one of the run's calls still runs), it first hands on, as ordinary `tool-result`
 *   (or `tool-error`) parts, every call of the run the stream left unanswered, so send-routed's own
 *   `tool-result` case stores each one like any other (its zips, its step, the events the save
 *   rebuilds). A call still running at that wait's end is handed on as stopped with no result, the
 *   stream is ended there, and `onEarlyEnd` releases the reader's wait for the SDK's finish (the SDK
 *   calls `onAbort` only when that tool settles).
 *
 * Nothing else about a Stop changes: no part is added to a stream that was not stopped, a call the
 * stream already answered is never answered again, a call whose `execute` never started (a card
 * still waiting, a provider-run tool) is not invented, and a call with no tool call id is not
 * tracked.
 *
 * BL-1978: a call can already have changed the user's files before its `execute` settles (a managed
 * patch applies, then the commands after it run; a sandbox backend can take up to 5 s to end them).
 * It reports that with `noteToolProgress`, and if it is still running when the stream is ended, the
 * stopped-with-no-result part carries what it reported, so the saved record keeps the applied edit.
 */

/**
 * The run's own Stop signal, carried beside a replaced `abortSignal`. A tool wrapper that hands an
 * inner `execute` another signal (`planClientTools` merges the ChatGPT plan lease into it) passes
 * the run's signal on under this key, so the call is still tracked under the run that streams it
 * (second review pass of BL-1959).
 */
export const RUN_ABORT_SIGNAL = Symbol.for('batshit.runAbortSignal')

/** The run's Stop signal from a tool's execution options: the carried one, else `abortSignal`. */
export function runAbortSignalOf(options: unknown): AbortSignal | undefined {
  const record = options && typeof options === 'object' ? (options as Record<PropertyKey, unknown>) : null
  // A wrapper that carried the key decided the run's signal, even when it had none to carry.
  if (record && RUN_ABORT_SIGNAL in record) return record[RUN_ABORT_SIGNAL] instanceof AbortSignal ? (record[RUN_ABORT_SIGNAL] as AbortSignal) : undefined
  return record?.abortSignal instanceof AbortSignal ? record.abortSignal : undefined
}

/** How long after a Stop a stream may stay silent before its running calls are recorded as stopped. */
export const STOPPED_TOOL_WAIT_MS = 3_000

/** Total time to settle and consume an already-ended managed API context-error stream. */
export const CONTEXT_ERROR_DRAIN_WAIT_MS = 3_000

/** The words a call that never returned after the Stop is saved with. */
export const STOPPED_WITHOUT_RESULT_REASON = 'The reply was stopped while this ran, and it returned no result.'

type Execution = {
  toolName: unknown
  input: unknown
  settled: boolean
  output?: unknown
  error?: unknown
  failed?: boolean
}

/** Each run's executions, under the run's Stop signal: gone with the signal. */
const runs = new WeakMap<AbortSignal, Map<string, Execution>>()

/** What each run's running calls reported of themselves (BL-1978), under the same signal. */
const reportedByRun = new WeakMap<AbortSignal, Map<string, Record<string, unknown>>>()

/**
 * BL-1978: a running call of the run whose Stop signal is `abortSignal` reports facts its result
 * would carry, before its `execute` settles. They are used only if the call is still running when
 * the stream is ended (`withToolResultsOnStop`); a call that settles is saved from its own result.
 * Later reports of the same call are merged over earlier ones.
 */
export function noteToolProgress(
  abortSignal: AbortSignal | null | undefined,
  toolCallId: unknown,
  facts: Record<string, unknown>
): void {
  if (!abortSignal || typeof toolCallId !== 'string' || !toolCallId) return
  let reported = reportedByRun.get(abortSignal)
  if (!reported) {
    reported = new Map()
    reportedByRun.set(abortSignal, reported)
  }
  reported.set(toolCallId, { ...(reported.get(toolCallId) ?? {}), ...facts })
}

/**
 * Remembers one running tool execution of the run whose Stop signal is `abortSignal`. `value` is
 * what the tool's `execute` returned; only a promise is tracked (a streaming tool's async iterable
 * is the SDK's to read).
 */
export function trackToolExecution(
  abortSignal: AbortSignal | null | undefined,
  toolCallId: unknown,
  toolName: unknown,
  input: unknown,
  value: unknown
): void {
  if (!abortSignal || typeof toolCallId !== 'string' || !toolCallId) return
  if (!value || typeof (value as PromiseLike<unknown>).then !== 'function') return
  let executions = runs.get(abortSignal)
  if (!executions) {
    executions = new Map()
    runs.set(abortSignal, executions)
  }
  const entry: Execution = { toolName, input, settled: false }
  executions.set(toolCallId, entry)
  Promise.resolve(value as PromiseLike<unknown>).then(
    (output) => Object.assign(entry, { settled: true, output }),
    (error) => Object.assign(entry, { settled: true, failed: true, error })
  )
}

const STOP_SILENCE = Symbol('stop-silence')
const CONTEXT_DRAIN_END = Symbol('context-drain-end')

/**
 * The stream send-routed reads, with BL-1959's Stop rule: see the file comment. `abortSignal` is
 * the run's own Stop signal (the one the SDK was given, and so the one its tools were tracked
 * under).
 */
export async function* withToolResultsOnStop<Part extends { type: string }>(
  stream: AsyncIterable<Part>,
  abortSignal: AbortSignal | null | undefined,
  options: {
    waitMs?: number
    onEarlyEnd?: () => void
    // Only the route's normalized context-error owner supplies this after the yielded error.
    // It resumes iteration ONLY when the actual SDK global end is known; on refusal the same
    // deadline bounds closing. This is one total deadline, never renewed per part.
    contextErrorDrainDeadline?: () => number | undefined
  } = {}
): AsyncGenerator<Part> {
  const waitMs = options.waitMs ?? STOPPED_TOOL_WAIT_MS
  const executions = () => (abortSignal ? runs.get(abortSignal) : undefined)
  const reported = () => (abortSignal ? reportedByRun.get(abortSignal) : undefined)

  // Resolves `waitMs` after the Stop, never when there is none.
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopSilence = new Promise<typeof STOP_SILENCE>((resolve) => {
    if (!abortSignal) return
    const arm = () => {
      silenceTimer = setTimeout(() => resolve(STOP_SILENCE), waitMs)
      silenceTimer.unref?.()
    }
    if (abortSignal.aborted) arm()
    else {
      onAbort = arm
      abortSignal.addEventListener('abort', arm, { once: true })
    }
  })

  /** The parts that record every call of the run the stream left unanswered, in start order. */
  const unanswered = (): Part[] => {
    const parts: Part[] = []
    const tracked = executions()
    if (!tracked) return parts
    for (const [toolCallId, entry] of [...tracked]) {
      tracked.delete(toolCallId)
      const facts = reported()?.get(toolCallId)
      reported()?.delete(toolCallId)
      const base = { toolCallId, toolName: entry.toolName, input: entry.input }
      parts.push((!entry.settled
        ? {
            type: 'tool-result',
            ...base,
            // BL-1978: what the call already did (an applied patch) stays in its record.
            output: { ...facts, success: false, blocked: false, stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON }
          }
        : entry.failed
          ? { type: 'tool-error', ...base, error: entry.error }
          : { type: 'tool-result', ...base, output: entry.output }) as unknown as Part)
    }
    return parts
  }

  /** A call of the run whose `execute` is still running. */
  const stillRunning = () => [...(executions()?.values() ?? [])].some((entry) => !entry.settled)

  const iterator = stream[Symbol.asyncIterator]()
  // Whether the stream ended itself (done or thrown). When the reader leaves early instead
  // (send-routed's `break`, or a throw in its loop body), the stream is closed here, as a
  // `for await` over it would close it: a CLI adapter finishes its run in that close. After the
  // early end below, its read is still waiting on the tool, so that close is not waited for.
  let streamEnded = false
  let readAbandoned = false
  let silence: Promise<typeof STOP_SILENCE> = stopSilence
  let contextDeadline: number | undefined
  let contextTimer: ReturnType<typeof setTimeout> | undefined
  let contextEnd: Promise<typeof CONTEXT_DRAIN_END> | undefined
  const contextDrainEnd = () => {
    const deadline = options.contextErrorDrainDeadline?.()
    if (contextDeadline === undefined && deadline !== undefined) {
      contextDeadline = deadline
      contextEnd = new Promise<typeof CONTEXT_DRAIN_END>((resolve) => {
        contextTimer = setTimeout(() => resolve(CONTEXT_DRAIN_END), Math.max(0, deadline - performance.now()))
        contextTimer.unref?.()
      })
    }
    return contextEnd
  }
  try {
    while (true) {
      const drainEnd = contextDrainEnd()
      if (contextDeadline !== undefined && (abortSignal?.aborted || performance.now() >= contextDeadline)) {
        readAbandoned = true
        options.onEarlyEnd?.()
        if (abortSignal?.aborted) yield* unanswered()
        return
      }
      const pending = iterator.next()
      let next: IteratorResult<Part> | typeof STOP_SILENCE | typeof CONTEXT_DRAIN_END
      try {
        next = await Promise.race(drainEnd ? [pending, silence, drainEnd] : [pending, silence])
        // Only a call of this run ends the stream early; any other stream (a CLI lane's, a model
        // still answering the Stop) is read to its own end, as before.
        if (next === STOP_SILENCE && !stillRunning()) {
          silence = new Promise<never>(() => {})
          next = drainEnd ? await Promise.race([pending, drainEnd]) : await pending
        }
      } catch (error) {
        streamEnded = true
        // The SDK can end a stopped stream by throwing the Stop's reason.
        if (abortSignal?.aborted) yield* unanswered()
        throw error
      }
      // Check the clock as well: an already-queued next() must not beat an expired timer.
      if (next === CONTEXT_DRAIN_END || contextDeadline !== undefined && performance.now() >= contextDeadline) {
        readAbandoned = true
        options.onEarlyEnd?.()
        if (abortSignal?.aborted) yield* unanswered()
        return
      }
      if (next === STOP_SILENCE) {
        // A tool still running after the Stop keeps the SDK's stream open: record the run's calls
        // (that one as stopped with no result) and end the stream here, so the reply is saved.
        readAbandoned = true
        options.onEarlyEnd?.()
        yield* unanswered()
        return
      }
      if (next.done) {
        streamEnded = true
        return
      }
      const part = next.value as Part & Record<string, unknown>
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
      if ((part.type === 'tool-result' || part.type === 'tool-error') && toolCallId) {
        executions()?.delete(toolCallId)
        reported()?.delete(toolCallId)
      } else if (part.type === 'abort') {
        yield* unanswered()
      }
      yield part
    }
  } finally {
    if (silenceTimer) clearTimeout(silenceTimer)
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort)
    try {
      if (readAbandoned) void Promise.resolve(iterator.return?.()).catch(() => {})
      else if (!streamEnded) {
        // A context-error refusal must not hang on iterator.return(), either. Ordinary/CLI
        // closes keep their awaited cleanup; no timeout alone certifies a consumed finish.
        const drainEnd = contextDrainEnd()
        const closing = iterator.return?.()
        if (drainEnd) {
          if (await Promise.race([closing, drainEnd]) === CONTEXT_DRAIN_END) options.onEarlyEnd?.()
        } else await closing
      }
    } finally {
      if (contextTimer) clearTimeout(contextTimer)
    }
  }
}
