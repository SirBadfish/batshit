/**
 * Delegation limits (Josh, 2026-10-24) — what watches a Subagent or Worker run while it works.
 *
 * Batshit matches Claude Code and Codex: a delegated run has no time limit and no tool-step
 * limit unless its Subagent sets one. What it does have is a STALL GUARD, Claude Code's
 * watchdog (`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, 10 minutes): a run that shows no progress
 * for 10 minutes is stopped, and the caller is told why. `subagentRunner.ts` owns the policy;
 * this module is the watch it hands each lane.
 *
 * Progress is anything the run's own stream reports: a model token or reasoning line, a tool
 * call starting, a tool result. Time spent INSIDE a running tool call is not silence (decision
 * 2): a 20-minute build or test is the run working, and the tool keeps its own limit (the Bash
 * tool's timeout, say). So a started tool call pauses the guard until its result arrives.
 *
 * Only lanes with a progress signal get a watch. The n8n Workflow lane is one HTTP call whose
 * answer is the whole result, so Batshit cannot see progress inside it and gives it none.
 */

/** Claude Code's stall watchdog default (`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS = 600000`). */
export const DELEGATED_RUN_STALL_MS = 10 * 60_000

/** What a lane reports while it runs. Every method is cheap and safe to call often. */
export interface DelegatedRunProgress {
  /** The run did something: a token, a reasoning line, a step boundary, any stream event. */
  activity(): void
  /** A tool call started. Until `toolEnded` with the same id, the run is never stalled. */
  toolStarted(toolCallId: string | null | undefined): void
  /** A tool call ended (its result, its error, or its refusal). Counts as activity too. */
  toolEnded(toolCallId: string | null | undefined): void
}

/** The progress sink for a run nothing watches (n8n, or a caller outside the runner). */
export const UNWATCHED_DELEGATED_RUN: DelegatedRunProgress = Object.freeze({
  activity() {},
  toolStarted() {},
  toolEnded() {},
})

export interface DelegatedStallWatch extends DelegatedRunProgress {
  /** Stops the timer for good; later reports do nothing. */
  dispose(): void
}

/**
 * Start a stall guard. `onStall` runs once, when `stallMs` pass with no activity and no tool
 * call open. The clock starts now, so a run that never says anything at all is caught too.
 */
export function createDelegatedStallWatch(options: {
  stallMs: number
  onStall: () => void
}): DelegatedStallWatch {
  const openToolCalls = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let over = false

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const arm = () => {
    clear()
    if (over || openToolCalls.size > 0) return
    timer = setTimeout(() => {
      timer = undefined
      if (over || openToolCalls.size > 0) return
      over = true
      options.onStall()
    }, options.stallMs)
  }

  arm()
  return {
    activity() {
      if (!over) arm()
    },
    toolStarted(toolCallId) {
      if (over) return
      // A call with no id could never be matched to its end, which would pause the guard for
      // the rest of the run; it counts as activity only.
      if (typeof toolCallId === 'string' && toolCallId.length > 0) openToolCalls.add(toolCallId)
      arm()
    },
    toolEnded(toolCallId) {
      if (over) return
      if (typeof toolCallId === 'string') openToolCalls.delete(toolCallId)
      arm()
    },
    dispose() {
      over = true
      openToolCalls.clear()
      clear()
    },
  }
}

/**
 * The API lane's report: one AI SDK stream part. A `tool-call` opens its call, its
 * `tool-result`, `tool-error` or `tool-output-denied` closes it, and every other part (text,
 * reasoning, a step boundary, a tool's streamed input) is activity.
 *
 * A call the provider runs itself (`providerExecuted`, a provider's own web search, say) is
 * activity only: its result may never arrive in the stream (`gatewayStreamFormat.ts` reads it
 * the same way), and an open call that never closes would switch the guard off for the rest
 * of the run.
 */
export function reportDelegatedStreamPart(progress: DelegatedRunProgress, part: unknown): void {
  const record = part && typeof part === 'object' ? (part as Record<string, unknown>) : null
  const type = typeof record?.type === 'string' ? record.type : ''
  const toolCallId = typeof record?.toolCallId === 'string' ? record.toolCallId : null
  if (record?.providerExecuted === true) {
    progress.activity()
    return
  }
  if (type === 'tool-call') {
    progress.toolStarted(toolCallId)
    return
  }
  if (type === 'tool-result' || type === 'tool-error' || type === 'tool-output-denied') {
    progress.toolEnded(toolCallId)
    return
  }
  progress.activity()
}

/** How many tool calls the AI SDK steps so far made (the API lane's tool-step count). */
export function countDelegatedToolCalls(steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<unknown> }>): number {
  let count = 0
  for (const step of steps) count += Array.isArray(step?.toolCalls) ? step.toolCalls.length : 0
  return count
}

/**
 * The API lane's `stopWhen` (decision 3). With no limit the loop runs until the model stops
 * calling tools (`() => false` is the AI SDK's own `isLoopFinished()`); with one, it ends at
 * the end of the step whose tool calls reach it, so a step that called several tools at once
 * finishes them all.
 */
export function delegatedRunStopCondition(maxToolSteps: number | null) {
  if (maxToolSteps === null) return () => false
  return ({ steps }: { steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<unknown> }> }) =>
    countDelegatedToolCalls(steps) >= maxToolSteps
}
