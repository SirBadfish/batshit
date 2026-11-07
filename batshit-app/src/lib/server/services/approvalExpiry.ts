import { redis } from '$lib/server/redis'
import { analyzeApprovalState, buildApprovalHistoryMessages, type ApprovalStateSnapshot } from './toolApprovalState'
import { commitApprovalExpiry } from './approvalExpiryCommit'
import { hasPendingCompactApproval } from '$lib/utils/contextCompaction'
import { isRetiredSavedApproval } from '$lib/utils/controlApprovalPresentation'
import { SERVER_REPLAY_FIELDS } from '$lib/utils/serverReplayFields'

const HISTORY_LIMIT = 300
const MAX_ATTEMPTS = 3

export class RetiredApprovalUnconfirmedError extends Error {
  readonly status = 503
  readonly code = 'retired_approval_unconfirmed'
  constructor() { super('The old approval may have been cleared. Reload the chat before trying again.') }
}

function messageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

/**
 * SA-137 (D7): the pause whose live-file-read snapshot ends with this expiry: only when this write
 * closes one of that pause's own approvals (`approvalIds`, sealed in the snapshot) and none of them
 * stays pending. An older card's entry on the same record never clears a current pause's snapshot.
 * The in-process timer clears it at the same moment while the server lives; this is the same rule
 * after a restart, so an expired card's resume runs without live reads either way.
 */
function liveReplayPauseRetiredBy(stored: any, changes: ApprovalStateSnapshot['updates'][number]['changes']): string | null {
  const replay = stored?.metadata?.liveFileReadSnapshot
  const approvals = stored?.metadata?.toolApprovals?.approvals
  if (typeof replay?.pauseId !== 'string' || !replay.pauseId || !Array.isArray(replay.approvalIds) || !Array.isArray(approvals)) return null
  const own = new Set<unknown>(replay.approvalIds)
  const status = approvals.map((entry: any) => entry?.status)
  let closesOwn = false
  for (const change of changes) {
    if (typeof change.fields.status !== 'string') continue
    status[change.index] = change.fields.status
    if (own.has(approvals[change.index]?.approvalId) && change.fields.status !== 'pending') closesOwn = true
  }
  const ownStillPending = approvals.some((entry: any, index: number) => own.has(entry?.approvalId) && status[index] === 'pending')
  return closesOwn && !ownStillPending ? replay.pauseId : null
}

function carriesApprovalHints(value: any): boolean {
  const approvals = value?.metadata?.toolApprovals?.approvals
  return Array.isArray(approvals) && approvals.length > 0
}

/** Approval authority is the stored assistant record, including an empty/settled summary.
 * Request history supplies bounded ID hints only, so an older visible card beyond the recent
 * window still gets a point read. It can never supply saved metadata or recreate a record.
 */
export async function sweepApprovalState(options: {
  userId: string
  sessionId: string
  persistedMessages: unknown
  requestMessages: unknown
  cardMessageId?: string | null
  signal?: AbortSignal | null
  nowMs?: number
}): Promise<Pick<ApprovalStateSnapshot, 'byId' | 'newlyExpired'>> {
  const ids = new Set<string>()
  for (const source of [options.persistedMessages, options.requestMessages]) {
    if (!Array.isArray(source)) continue
    for (const message of source.slice(-HISTORY_LIMIT)) {
      // The summary is a discovery hint only. Its state/payload never reaches the analysis.
      // Ordinary history with no cards needs no extra Redis read per message.
      if (!carriesApprovalHints(message)) continue
      const id = messageId(message)
      if (id) ids.add(id)
    }
  }
  if (options.cardMessageId?.trim()) ids.add(options.cardMessageId.trim())
  const result: Pick<ApprovalStateSnapshot, 'byId' | 'newlyExpired'> = { byId: new Map(), newlyExpired: [] }
  const nowMs = options.nowMs ?? Date.now()
  for (const id of ids) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      options.signal?.throwIfAborted()
      const raw = await redis.json.getRaw(`message:${options.sessionId}:${id}`, '$')
      if (raw === null) break
      const rows: unknown = JSON.parse(raw)
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Approval history returned a malformed saved record.')
      const stored = rows[0]
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) break
      if (stored.id !== id || stored.session_id !== options.sessionId || stored.user_id !== options.userId || stored.role !== 'assistant') break
      const snapshot = analyzeApprovalState(buildApprovalHistoryMessages([], [stored]), nowMs)
      if (snapshot.updates.length > 0) {
        options.signal?.throwIfAborted()
        // The commit owner checks again after asynchronous client acquisition, at EVAL issue.
        const outcome = await commitApprovalExpiry({
          userId: options.userId, sessionId: options.sessionId, messageId: id, expectedRaw: raw,
          changes: snapshot.updates[0].changes,
          retireLiveReplayPauseId: liveReplayPauseRetiredBy(stored, snapshot.updates[0].changes),
          signal: options.signal
        })
        if (outcome === 'CHANGED') {
          if (attempt + 1 === MAX_ATTEMPTS) throw new Error('Approval history kept changing; its expiry could not be saved.')
          continue
        }
        if (outcome === 'MISSING_MESSAGE') break
        if (outcome !== 'OK') throw new Error(`Approval expiry was refused: ${outcome}.`)
      }
      // Only the snapshot confirmed by the write can announce/retire a newly expired card.
      for (const [approvalId, record] of snapshot.byId) result.byId.set(approvalId, record)
      result.newlyExpired.push(...snapshot.newlyExpired)
      break
    }
  }
  return result
}

/** Settle only a requested historical CLI card, under the caller's session-turn lock.
 * The stored message and exact raw preimage own the decision; mixed live entries are untouched.
 */
export async function retireSavedCliApprovals(options: {
  userId: string; sessionId: string; messageId: string; approvalIds: readonly string[]; signal?: AbortSignal | null
}): Promise<{ card: Record<string, any>; controlApprovalIds: string[]; retiredApprovalIds: string[]; hasPending: boolean } | null> {
  const wanted = new Set(options.approvalIds.map(id => id.trim()).filter(Boolean))
  if (!wanted.size || !options.messageId) return null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted()
    const raw = await redis.json.getRaw(`message:${options.sessionId}:${options.messageId}`, '$')
    if (raw === null) return null
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Approval history returned a malformed saved record.')
    const card = rows[0] as Record<string, any> | null
    if (!card || card.id !== options.messageId || card.session_id !== options.sessionId ||
      card.user_id !== options.userId || card.role !== 'assistant') return null
    const entries = card.metadata?.toolApprovals?.approvals
    const source = card.metadata?.toolApprovals?.source
    if (!Array.isArray(entries) || !entries.some((entry: any) =>
      typeof entry?.approvalId === 'string' && wanted.has(entry.approvalId.trim()) && isRetiredSavedApproval(entry, source, card.metadata))) return null
    const controlApprovalIds: string[] = []
    const at = new Date().toISOString()
    const changes: ApprovalStateSnapshot['updates'][number]['changes'] = []
    for (const [index, entry] of entries.entries()) {
      if (!isRetiredSavedApproval(entry, source, card.metadata) || typeof entry.approvalId !== 'string') continue
      if (typeof entry.control?.approvalId === 'string') controlApprovalIds.push(entry.control.approvalId)
      if (entry.status !== undefined && entry.status !== 'pending') continue
      changes.push({ index, fields: { status: 'expired', submitted: false, expiredAt: at, expiryReason: 'run_ended' } })
    }
    const retiredIds = (value: Record<string, any>) => value.metadata.toolApprovals.approvals
      .filter((entry: any) => isRetiredSavedApproval(entry, source, value.metadata) && entry.status === 'expired' && typeof entry.approvalId === 'string')
      .map((entry: any) => entry.approvalId as string)
    const result = structuredClone(card)
    for (const change of changes) Object.assign(result.metadata.toolApprovals.approvals[change.index], change.fields)
    const hasPending = hasPendingCompactApproval([result])
    const metadata = card.metadata as Record<string, any>
    const steerIds = [...new Set([
      ...(Array.isArray(metadata.steerPromoted?.steerIds) ? metadata.steerPromoted.steerIds : []),
      ...(Array.isArray(metadata.steers) ? metadata.steers.filter((entry: any) => entry?.source !== 'dm').map((entry: any) => entry?.steerId) : [])
    ].filter((id): id is string => typeof id === 'string'))]
    const retiredCard = hasPending ? undefined : { steerIds }
    if (!changes.length && (!retiredCard || metadata.retiredApprovalSettled === true)) {
      return { card, controlApprovalIds, retiredApprovalIds: retiredIds(card), hasPending }
    }
    let issued = false
    let outcome: string
    try {
      outcome = await commitApprovalExpiry({ userId: options.userId, sessionId: options.sessionId,
        messageId: options.messageId, expectedRaw: raw, changes,
        retireLiveReplayPauseId: liveReplayPauseRetiredBy(card, changes), retiredCard, signal: options.signal,
        onIssue: () => { issued = true } })
    } catch (error) {
      if (issued) throw new RetiredApprovalUnconfirmedError()
      throw error
    }
    if (outcome === 'CHANGED') continue
    if (outcome !== 'OK') throw new Error(`Retired approval settlement was refused: ${outcome}.`)
    // The committed preimage plus exact leaf changes determine the resulting status. No
    // request/body metadata or re-encoded record is written to storage.
    if (liveReplayPauseRetiredBy(card, changes)) result.metadata.liveFileReadSnapshot = null
    if (retiredCard) {
      result.metadata.retiredApprovalSettled = true
      for (const name of SERVER_REPLAY_FIELDS) if (Object.hasOwn(result.metadata, name)) result.metadata[name] = null
      if (steerIds.length) result.metadata.steerPromoted = { ...(result.metadata.steerPromoted ?? {}),
        steerIds, disposition: 'unanswered', reason: 'approval_expired' }
    }
    return { card: result, controlApprovalIds, retiredApprovalIds: retiredIds(result), hasPending }
  }
  throw new Error('The approval card kept changing; its retirement could not be saved.')
}
