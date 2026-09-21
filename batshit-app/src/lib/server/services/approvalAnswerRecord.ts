/**
 * An approval click is answered ONCE (bug sweep, 2026-09-18).
 *
 * Called by send-routed for every approval click, under that click's turn lock, after the
 * three-minute sweep and BEFORE the resumed run starts. It reads the card's message, refuses
 * a click that names an approval a click already answered, and otherwise records this click's
 * answers there (`recordApprovalAnswers` in `toolApprovalState.ts` has the rule and the why).
 *
 * The record is written before anything runs, so a resume that then fails, is stopped, or dies
 * with the server still leaves the approval answered: a stopped or failed resume never runs the
 * approved command a second time. A write that fails refuses the click (fail closed): an answer
 * Batshit cannot record is not spent.
 */

import { redis } from '$lib/server/redis'
import {
  findAnsweredApprovalIds,
  readAnsweredApprovalIds,
  recordApprovalAnswers
} from './toolApprovalState'

export type ApprovalAnswerOutcome =
  | { ok: true; recorded: boolean }
  | { ok: false; reason: 'already_answered'; approvalIds: string[] }
  | { ok: false; reason: 'record_failed'; error: unknown }

export async function answerApprovalsOnce(options: {
  userId: string
  sessionId: string
  /** The card's message: the click posts it as `messageId`. */
  messageId: string | null | undefined
  /** The answers as the resumed run receives them (a late Approve is already a denial). */
  responses: ReadonlyArray<{ approvalId?: unknown; approved?: unknown }>
  now?: () => Date
}): Promise<ApprovalAnswerOutcome> {
  const messageId = typeof options.messageId === 'string' ? options.messageId.trim() : ''
  if (!messageId || options.responses.length === 0) return { ok: true, recorded: false }

  let stored: any
  try {
    stored = await redis.execute(async (client) =>
      client.json.get(`message:${options.sessionId}:${messageId}`)
    )
  } catch (error) {
    return { ok: false, reason: 'record_failed', error }
  }
  // No card message: the resume has nothing to continue either, and fails on its own terms.
  if (!stored || typeof stored !== 'object') return { ok: true, recorded: false }

  const metadata =
    stored.metadata && typeof stored.metadata === 'object'
      ? (stored.metadata as Record<string, any>)
      : {}
  const alreadyAnswered = findAnsweredApprovalIds(
    options.responses,
    readAnsweredApprovalIds(metadata)
  )
  if (alreadyAnswered.length > 0) {
    return { ok: false, reason: 'already_answered', approvalIds: alreadyAnswered }
  }

  const decidedAt = (options.now?.() ?? new Date()).toISOString()
  try {
    // `updateMessage` REPLACES metadata, so the whole stored metadata goes back with the record
    // added (the same read-then-merge `settleControlApprovalCard` does).
    await redis.updateMessage(
      messageId,
      options.sessionId,
      { metadata: recordApprovalAnswers(metadata, options.responses, decidedAt) },
      options.userId
    )
  } catch (error) {
    return { ok: false, reason: 'record_failed', error }
  }
  return { ok: true, recorded: true }
}
