import { sha256Hex } from './sha256'
import { sanitizeFinishedReplyContent } from './replyEndContent'

/** Match the chat's existing display cleaner, which is idempotent on reload. */
export const groupReplyContentHash = (content: string) => sha256Hex(sanitizeFinishedReplyContent(content))

/** SA-120 AMD-120-09: a server-owned receipt on the saved user message, not an assistant reply. */
export interface GroupReplySkipped {
  source: 'jev'
  messageId: string
  groupTurnId: string
  eventIndex: 1
  snapshotId: string
  contentHash: string
  confidence: number
  at: string
}

export function readGroupReplySkipped(metadata: unknown, messageId: string, content: string): GroupReplySkipped | null {
  if (!metadata || typeof metadata !== 'object') return null
  const mark = (metadata as Record<string, unknown>).groupReplySkipped
  if (!mark || typeof mark !== 'object') return null
  const value = mark as GroupReplySkipped
  return value.source === 'jev' && value.messageId === messageId && value.eventIndex === 1 &&
    typeof value.groupTurnId === 'string' && value.groupTurnId.length > 0 &&
    typeof value.snapshotId === 'string' && value.snapshotId.length > 0 &&
    typeof value.contentHash === 'string' && value.contentHash === groupReplyContentHash(content) &&
    typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) &&
    typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence > 0.5 && value.confidence <= 1
    ? value : null
}

// SA-120 P10b: the mark is stored on the user's message and keeps no judge (its snapshot row names it), so these
// sentences say "the judge", which is right for every judge. The Execution Viewer line names the model.
export function groupReplySkippedText(mark: GroupReplySkipped): string {
  return `Reply skipped by the judge (${Math.round(mark.confidence * 100)}% confidence)`
}

export const GROUP_REPLY_SKIPPED_DETAIL = 'The judge decided that this message needed no reply. No agent was run for this group turn. The judge can be wrong; send another message or name an agent to ask for a reply.'
