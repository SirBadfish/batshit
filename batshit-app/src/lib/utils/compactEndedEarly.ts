/**
 * BL-622 (rule C5 of `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`): how the chat page
 * answers a Compact that ended early after its summary call (409 `ended_early`) and wrote nothing.
 *
 * A Compact yields: when a reply started in the chat during its summary call, when another
 * Compact finished first, or when a message it summarized became protected, the server writes
 * nothing. An Auto Compact says nothing and runs again by itself (the page clears its
 * once-per-state key after a wait, as for a `turn_running` refusal). A Compact the user pressed is
 * told in one short sentence what happened.
 *
 * A Compact the chat's Stop ended (`reason: 'stopped'`) is not handled here: the page reads it
 * first (`isStoppedCompactAnswer` in `compactStopTarget.ts`), shows the server's own words
 * ("Compact stopped. It wrote nothing.") and holds Auto Compact until the chat's next reply ends.
 *
 * BL-755: `compaction_changed` means another Compact's event already landed in the chat's record —
 * this tab's copy of `contextCompaction` is now behind it. Its quiet retry must not reuse that
 * stale selection (it can summarize what little is left, or find nothing and be refused with
 * `no_compaction_candidates`), so this is the one reason whose retry needs a metadata refresh
 * first; the page does that refresh (`refreshMetadata: true`).
 */

export type CompactEndedEarlyReason =
  | 'turn_started'
  | 'compaction_changed'
  | 'message_protected'

export type CompactEndedEarlyHandling =
  | { kind: 'retry_quietly'; reason: CompactEndedEarlyReason; refreshMetadata: boolean }
  | { kind: 'tell_user'; reason: CompactEndedEarlyReason; message: string }

export const COMPACT_ENDED_EARLY_MESSAGES: Record<CompactEndedEarlyReason, string> = {
  turn_started: 'Compact stopped: you sent a message. Press Compact again after the reply.',
  compaction_changed: 'Compact stopped: another Compact finished in this chat first.',
  message_protected: 'Compact stopped: a message it summarized is now protected. Press Compact again to leave it out.'
}

/** `null` when the answer is not an early end this module handles. */
export function resolveCompactEndedEarly(
  mode: 'auto' | 'manual',
  status: number,
  payload: unknown
): CompactEndedEarlyHandling | null {
  if (status !== 409) return null
  const body = payload as { code?: unknown; reason?: unknown } | null
  if (body?.code !== 'ended_early') return null
  const reason = body.reason
  if (
    reason !== 'turn_started' &&
    reason !== 'compaction_changed' &&
    reason !== 'message_protected'
  ) {
    return null
  }
  if (mode === 'auto') {
    return { kind: 'retry_quietly', reason, refreshMetadata: reason === 'compaction_changed' }
  }
  return { kind: 'tell_user', reason, message: COMPACT_ENDED_EARLY_MESSAGES[reason] }
}
