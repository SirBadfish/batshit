/**
 * BL-622 (rule C7), BL-653: Stop stops what runs. The chat's Stop button shows while a reply or a
 * Compact runs (`workBusy={chatWorkBusy || compactBusy}`), and it used to call the reply's Stop
 * alone, which stopped nothing during a Compact. While only a Compact runs, the Stop ends the
 * Compact through its own route (`POST /api/messages/compact/stop`); while a reply runs, the Stop
 * is the reply's, as before (a Compact beside a reply ends early on its own).
 */
export type StopTarget = 'compact' | 'reply'

export function resolveStopTarget(state: { compactBusy: boolean; replyBusy: boolean }): StopTarget {
  return state.compactBusy && !state.replyBusy ? 'compact' : 'reply'
}

/** The Compact route's answer for a Compact its Stop ended: information, not an error. */
export function isStoppedCompactAnswer(status: number, payload: unknown): boolean {
  const body = payload as { code?: unknown; reason?: unknown } | null
  return status === 409 && body?.code === 'ended_early' && body?.reason === 'stopped'
}

/**
 * BL-653 (Faye's review, 2026-09-28): which chat's Compact the Stop ends, and whether a Stop came
 * while this Compact ran. `compactBusy` is one flag for the whole page, so the Stop can be pressed
 * in another chat than the Compact's; it must name the chat whose Compact runs, not the open one.
 * A Stop during the first phase (the compact plan) must not be lost: the preview answers 200 with
 * the plan and never reads its run's stop, so the page remembers the Stop and starts no summary
 * request after the preview. The Stop is remembered for this Compact only (`begin` forgets it).
 */
export type CompactStopTracker = {
  /** A Compact starts (before its first phase): forget a Stop of an earlier Compact. */
  begin: () => void
  /** A phase with a request starts in this chat (the plan, then the summary). */
  enterPhase: (sessionId: string) => void
  /** That phase's request ended. */
  leavePhase: () => void
  /** The Stop was pressed: remember it and answer the chat whose Compact runs (null: none). */
  requestStop: () => string | null
  /** A Stop was pressed during this Compact. */
  readonly stopRequested: boolean
}

export function createCompactStopTracker(): CompactStopTracker {
  let runningSessionId: string | null = null
  let stopRequested = false
  return {
    begin: () => {
      stopRequested = false
    },
    enterPhase: (sessionId) => {
      runningSessionId = sessionId
    },
    leavePhase: () => {
      runningSessionId = null
    },
    requestStop: () => {
      stopRequested = true
      return runningSessionId
    },
    get stopRequested() {
      return stopRequested
    }
  }
}

/** The words for a stopped Compact, the same as the Compact route's own answer. */
export const STOPPED_COMPACT_MESSAGE = 'Compact stopped. It wrote nothing.'

/**
 * BL-653: a Stop of an Auto Compact holds Auto Compact for that chat until the page handles an
 * `end` of a reply in that chat. Without it the trigger fired again within a second: its
 * once-per-state key holds the token count, and any estimate update after the Stop made a new key.
 * A token update never releases the hold; any `end` of that chat does (a Compact cannot start beside
 * a running turn, so in practice it is the chat's next reply, but the hold does not check when the
 * reply started). The hold lives in the tab: a reload clears it. A pressed Compact never reads it.
 */
export type AutoCompactStopHolds = Readonly<Record<string, true>>

/** The holds after a Compact of this chat ended by the user's Stop (only an Auto Compact holds). */
export function holdAutoCompactAfterStop(
  holds: AutoCompactStopHolds,
  sessionId: string,
  mode: 'manual' | 'auto'
): AutoCompactStopHolds {
  if (mode !== 'auto' || holds[sessionId]) return holds
  return { ...holds, [sessionId]: true }
}

/** The holds after a reply of this chat ended. */
export function releaseAutoCompactHoldOnReplyEnd(
  holds: AutoCompactStopHolds,
  sessionId: string | null | undefined
): AutoCompactStopHolds {
  if (!sessionId || !holds[sessionId]) return holds
  const next = { ...holds }
  delete next[sessionId]
  return next
}

/** Auto Compact may not start in this chat now. */
export function isAutoCompactHeldAfterStop(holds: AutoCompactStopHolds, sessionId: string): boolean {
  return holds[sessionId] === true
}
