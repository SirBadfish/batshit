/**
 * BL-622 (rule C7), BL-653: Stop stops what runs. The chat's Stop button shows while a reply or a
 * Compact runs (`workBusy={chatWorkBusy || compactBusy}`), and it used to call the reply's Stop
 * alone, which stopped nothing during a Compact. While only a Compact runs, the Stop ends the
 * Compact through its own route (`POST /api/messages/compact/stop`); while a reply runs, the Stop
 * is the reply's, as before (a Compact beside a reply ends early on its own). Since BL-781 each
 * chat's Compact is its own (`compactRuns.svelte.ts`): `compactBusy` is the chat on screen's.
 */
export type StopTarget = 'compact' | 'reply'

export function resolveStopTarget(state: { compactBusy: boolean; replyBusy: boolean }): StopTarget {
  return state.compactBusy && !state.replyBusy ? 'compact' : 'reply'
}

/**
 * The Compact route's answer for a Compact its Stop ended, or its chat's delete (BL-2357):
 * information, not an error.
 */
export function isStoppedCompactAnswer(status: number, payload: unknown): boolean {
  const body = payload as { code?: unknown; reason?: unknown } | null
  return status === 409 && body?.code === 'ended_early' && (body?.reason === 'stopped' || body?.reason === 'session_deleted')
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
