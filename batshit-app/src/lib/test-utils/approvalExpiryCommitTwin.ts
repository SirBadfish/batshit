import type { ApprovalExpiryCommit } from '$lib/server/services/approvalExpiryCommit'
import type { JsonDocumentStore } from './redisJsonCompareAndWriteTwin'
import { SERVER_REPLAY_FIELDS } from '$lib/utils/serverReplayFields'

/** The default lane's bounded twin of APPROVAL_EXPIRY_COMMIT_SCRIPT.
 * It changes no shared client's eval availability; the actual script is tested on Redis.
 */
export function createApprovalExpiryCommitTwin(store: JsonDocumentStore) {
  return async (input: ApprovalExpiryCommit): Promise<string> => {
    input.signal?.throwIfAborted()
    input.onIssue?.()
    const session = store.read(`session:${input.sessionId}`) as any
    if (session === undefined) return 'MISSING_SESSION'
    if (!session || session.user_id !== input.userId) return 'FORBIDDEN'
    const key = `message:${input.sessionId}:${input.messageId}`
    const message = store.read(key) as any
    if (message === undefined) return 'MISSING_MESSAGE'
    if (JSON.stringify([message]) !== input.expectedRaw) return 'CHANGED'
    if (!message || message.id !== input.messageId || message.session_id !== input.sessionId ||
      message.user_id !== input.userId || message.role !== 'assistant') return 'FORBIDDEN'
    const types: Record<string, string> = { status: 'string', submitted: 'boolean', requestedAt: 'string', expiresAt: 'string', expiredAt: 'string', expiryReason: 'string' }
    const next = structuredClone(message)
    for (const change of input.changes) {
      if (!Number.isInteger(change.index) || change.index < 0) throw new Error('Invalid approval entry index')
      const entry = next.metadata?.toolApprovals?.approvals?.[change.index]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Approval entry no longer exists')
      for (const [field, value] of Object.entries(change.fields)) {
        if (types[field] !== typeof value) throw new Error('Invalid approval state field')
        entry[field] = value
      }
    }
    const replay = next.metadata?.liveFileReadSnapshot
    if (input.retireLiveReplayPauseId && replay && typeof replay === 'object' && replay.pauseId === input.retireLiveReplayPauseId) {
      next.metadata.liveFileReadSnapshot = null
    }
    if (input.retiredCard) {
      if (!next.metadata || typeof next.metadata !== 'object' || Array.isArray(next.metadata)) throw new Error('Invalid approval metadata')
      const marker = next.metadata.retiredApprovalSettled
      if (marker != null && typeof marker !== 'boolean') throw new Error('Invalid retirement marker')
      if (!Array.isArray(input.retiredCard.steerIds) || input.retiredCard.steerIds.some(id => typeof id !== 'string')) throw new Error('Invalid retired steer id')
      const current = next.metadata.steerPromoted
      if (input.retiredCard.steerIds.length && current != null && (typeof current !== 'object' || Array.isArray(current))) throw new Error('Invalid retired steer disposition')
      next.metadata.retiredApprovalSettled = true
      for (const name of SERVER_REPLAY_FIELDS) if (Object.hasOwn(next.metadata, name)) next.metadata[name] = null
      if (input.retiredCard.steerIds.length) next.metadata.steerPromoted = { ...(current ?? {}),
        steerIds: input.retiredCard.steerIds, disposition: 'unanswered', reason: 'approval_expired' }
    }
    store.write(key, next)
    return 'OK'
  }
}
