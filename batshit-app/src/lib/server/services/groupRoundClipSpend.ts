/**
 * BL-600 (2026-09-27, Faye's design `2026-09-27-bl401-bl505-schedule-notes-and-woken-turn-clips.md`):
 * a group round spends the chat's Clip countdown ONCE per user message, after its LAST speaker's
 * compile.
 *
 * A "next message only" Clip is attached for exactly one user message, and in a group every
 * speaker of the round answers that message. The single-agent path spends the countdown right
 * after its compile (`consumePostCompileSessionClips` in send-routed). A round cannot: which
 * speaker is the last one is known only when the round ends, because a follow-up is scheduled
 * from the reply before it. So:
 *
 * - each member, at its post-compile point (after the setup Stop check), calls `noteCompiled`; the
 *   FIRST call that reads the chat's Clips records the countdown Clips attached at that moment:
 *   what the user's message this round answers carried, as closely as the single-agent path's own
 *   post-compile read knows it. Later calls add nothing and read nothing;
 * - the round, once it has ended (`drainGroupRoundThenSpend`), spends once, and only those Clips.
 *   A round in which no member reached that point (refused, or stopped before any compile
 *   finished) spends nothing.
 *
 * Only the first record is spent because a round can run for minutes: a Clip the user attaches for
 * their NEXT message during the round (the queued send's Clip) belongs to that next message. A
 * later speaker still compiles with it (every speaker compiles with everything attached, so a
 * Clip attached mid-round is read twice, which the design's C3 accepts), but the round never
 * spends it (review of BL-600, 2026-09-28: recording every speaker's Clips spent it, BL-505's
 * symptom inside a group). A first read that fails fails that member, and the next member's call
 * records instead.
 *
 * Before BL-600 (BL-411) the first member to finish its compile spent the countdown, so the second
 * and later speakers compiled without a one-time Clip. Before BL-411 the round spent it at its
 * start, before any member compiled.
 *
 * Members still run with `consumeSessionClips: false`, so none of them counts the hold countdown,
 * commits memory, or runs the new-message Judge Juice steps (the round counts the hold once, at
 * its start: SA-129 P2).
 */
export interface GroupRoundClipSpend {
  /** A member's compile is done and its run goes on: the first one records the countdown Clips. */
  noteCompiled(): Promise<void>
  /** The round is over: spend the recorded Clips' countdown once. Nothing when nobody compiled. */
  settle(): Promise<void>
}

export function createGroupRoundClipSpend({
  readCountdownClipIds,
  spend,
}: {
  /** The ids of the chat's Clips that carry a countdown, read now. */
  readCountdownClipIds: () => Promise<string[]>
  /** Spend one message from these Clips' countdowns (and tell the chat's tabs). */
  spend: (clipIds: ReadonlySet<string>) => Promise<void>
}): GroupRoundClipSpend {
  let recordedClipIds: ReadonlySet<string> | null = null
  let settled = false
  return {
    async noteCompiled() {
      if (recordedClipIds) return
      recordedClipIds = new Set(await readCountdownClipIds())
    },
    async settle() {
      if (settled) return
      // Set before the spend is awaited, so a spend that fails is not tried a second time.
      settled = true
      if (!recordedClipIds || recordedClipIds.size === 0) return
      await spend(recordedClipIds)
    },
  }
}

/**
 * Run the round, then spend its Clip countdown once, also when the round threw after a speaker
 * compiled: that speaker got the Clip, so leaving the countdown would hand it to the next message
 * a second time. A spend that fails after the round threw is logged and the round's own error is
 * the one the caller sees; a spend that fails after a round that ended normally is the round's
 * visible failure, as a failed spend is a single-agent send's.
 */
export async function drainGroupRoundThenSpend(
  drain: () => Promise<void>,
  clipSpend: GroupRoundClipSpend,
): Promise<void> {
  try {
    await drain()
  } catch (roundError) {
    try {
      await clipSpend.settle()
    } catch (spendError) {
      console.error('[GroupChat] The round failed, and spending its Clip countdown failed too:', spendError)
    }
    throw roundError
  }
  await clipSpend.settle()
}
