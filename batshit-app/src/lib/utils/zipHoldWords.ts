/**
 * SA-129 P2 (DL-02, DL-03, D1): the words for a HOLD, in one place, for every reader.
 *
 * One state, two doorways: the user holds a result from the chat or the Zip Manager ("Hold", or
 * "Hold for N messages"), an agent holds a file it read by naming its path in the Tool Notes
 * block, and either one lets go with "Release". This module owns what each side reads:
 *
 * - the one steady line an expanded, held file read carries in the prompt (never a countdown,
 *   because a line that changed on every send would re-bill the prompt cache from there);
 * - the `Current Zip State` line of the DCM, which is cache-free and may carry the live count;
 * - the badge and Zip Manager words for the user.
 *
 * The automatic "recovery hold" (a run that died mid-task keeps its results open) is a different
 * thing and keeps its own name.
 */

import type { UnzippedItem } from '$lib/services/zipping'
import { DEAD_COPY_REASON_TEXT, describeHeldPath, type DeadCopyReason } from './zipDeadCopies'
import { TOOL_RESULT_SIZE_REASON_TEXT, type ToolResultSizeGuard } from './toolResultSizeGuard'

/** An expanded read the agent that is being compiled for holds. */
export const HELD_BY_YOU_HINT = 'Held by you: stays open until you release it.'
/** An expanded read the user holds until they release it. */
export const HELD_BY_USER_HINT = 'Held by the user: stays open until they release it.'
/** An expanded read another agent holds (a chat that changed agents). */
export const HELD_BY_ANOTHER_AGENT_HINT = 'Held by another agent: stays open until it is released.'

/** An expanded read the user holds for a number of messages. Steady: the length, never what is left. */
export function heldByUserForMessagesHint(duration: number): string {
  return `Held by the user for ${duration} message${duration === 1 ? '' : 's'}.`
}

/** A user hold record: every record a browser wrote, and every record that predates sources. */
export function isUserHold(item: Pick<UnzippedItem, 'source'> | null | undefined): boolean {
  if (!item) return false
  return item.source !== 'agent' && item.source !== 'inferred'
}

/** An agent's hold: a `source: 'agent'` record that names the file it holds. */
export function isAgentHold(item: Pick<UnzippedItem, 'source' | 'path'> | null | undefined): boolean {
  return Boolean(item && item.source === 'agent' && typeof item.path === 'string' && item.path)
}

/**
 * The line an expanded `read_file` or `skill_read` transcript carries while someone holds it
 * (DL-03), or null when the record is not a hold: a Judge Juice open (the DCM tells the agent) or
 * a parked zip-control unzip.
 */
export function describeHeldReadHint(
  item: UnzippedItem | null | undefined,
  compilingAgentId: string | null
): string | null {
  if (!item) return null
  if (isAgentHold(item)) {
    return item.agentId && compilingAgentId && item.agentId === compilingAgentId
      ? HELD_BY_YOU_HINT
      : HELD_BY_ANOTHER_AGENT_HINT
  }
  if (!isUserHold(item)) return null
  if (!item.permanent && typeof item.duration === 'number' && item.duration > 0) {
    return heldByUserForMessagesHint(item.duration)
  }
  return HELD_BY_USER_HINT
}

/**
 * One `Current Zip State` line of the DCM. The DCM is the cache-free tail of the prompt, so it
 * may carry the live count of a "Hold for N messages" and whether a held copy was compressed as a
 * dead copy (an agent's hold stays on a copy it edited since, until its next whole read).
 */
export function describeUnzippedItemForDcm(
  item: UnzippedItem,
  options: { agentId: string | null; deadCopy?: DeadCopyReason | null; sizeGuard?: ToolResultSizeGuard }
): string {
  const line = describeStoredUnzippedItemForDcm(item, options)
  return options.sizeGuard ? `${line} | compressed (${TOOL_RESULT_SIZE_REASON_TEXT[options.sizeGuard]})` : line
}

function describeStoredUnzippedItemForDcm(
  item: UnzippedItem,
  options: { agentId: string | null; deadCopy?: DeadCopyReason | null }
): string {
  const label = item.name || item.description || 'zip'
  if (isAgentHold(item)) {
    const path = describeHeldPath(item.path as string)
    const mine = Boolean(item.agentId && options.agentId && item.agentId === options.agentId)
    const holder = mine ? 'held by you' : 'held by another agent'
    const until = mine ? 'until you release it' : 'until it is released'
    const dead = options.deadCopy
      ? ` | compressed (${DEAD_COPY_REASON_TEXT[options.deadCopy]}); the hold moves to ${mine ? 'your' : 'its'} next whole read`
      : ''
    return `- ${path} | ${item.zipId} | ${holder} | ${until}${dead}`
  }
  if (item.source === 'inferred') {
    // SA-120 P5: Batshit opened it on a Judge Juice judgment: temporary, never a hold.
    return `- ${label} | ${item.zipId} | batshit-inferred | temp ${item.messageCount ?? 0}/${item.duration ?? '?'}`
  }
  if (item.source === 'agent') {
    // The parked zip-control unzip (DL-06): no path, so it neither follows a file nor releases.
    return `- ${label} | ${item.zipId} | agent zip control | ${item.permanent ? 'permanent' : `temp ${item.messageCount ?? 0}/${item.duration ?? '?'}`}`
  }
  if (!item.permanent && typeof item.duration === 'number') {
    const left = Math.max(0, item.duration - (item.messageCount ?? 0))
    return `- ${label} | ${item.zipId} | held by the user | for ${item.duration} messages, ${left} left`
  }
  return `- ${label} | ${item.zipId} | held by the user | until they release it`
}

// ---------------------------------------------------------------------------------------------
// The user's words (the chat badge and the Zip Manager)

/**
 * Who holds it, as the user reads it: "Held by you", "Held by you (N messages left)",
 * "Held by <agent name>". Null when the record is not a hold.
 */
export function describeHoldForUser(
  item: Pick<UnzippedItem, 'source' | 'path' | 'permanent' | 'duration' | 'messageCount' | 'agentId'> | null | undefined,
  agentName: string | null | undefined
): string | null {
  if (!item) return null
  if (isAgentHold(item)) return `Held by ${agentName?.trim() || 'the agent'}`
  if (!isUserHold(item)) return null
  if (!item.permanent && typeof item.duration === 'number') {
    const left = Math.max(0, item.duration - (item.messageCount ?? 0))
    return `Held by you (${left} message${left === 1 ? '' : 's'} left)`
  }
  return 'Held by you'
}
