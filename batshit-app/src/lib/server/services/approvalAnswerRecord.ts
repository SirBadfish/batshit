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

declare const p5AnswerBrand: unique symbol
export type P5ApprovalAnswerWrite = Readonly<{ readonly [p5AnswerBrand]: true }>
const p5AnswerResults = new WeakMap<object, P5ApprovalAnswerWrite>()
const p5AnswerWrites = new WeakMap<object, { userId: string; sessionId: string; messageId: string;
  approvalIds: readonly string[]; consumed: boolean }>()
export function observeP5ApprovalAnswerWrite(outcome: ApprovalAnswerOutcome): P5ApprovalAnswerWrite | undefined { return p5AnswerResults.get(outcome) }
export function readP5ApprovalAnswerWrite(receipt: P5ApprovalAnswerWrite) {
  const owner = p5AnswerWrites.get(receipt)
  if (!owner || owner.consumed) throw new Error('The actual approval answer write is unavailable or already claimed.')
  return Object.freeze({ userId: owner.userId, sessionId: owner.sessionId, messageId: owner.messageId, approvalIds: owner.approvalIds })
}
export function consumeP5ApprovalAnswerWrite(receipt: P5ApprovalAnswerWrite): void {
  readP5ApprovalAnswerWrite(receipt); p5AnswerWrites.get(receipt)!.consumed = true
}

export async function answerApprovalsOnce(options: {
  userId: string
  sessionId: string
  /** The card's message: the click posts it as `messageId`. */
  messageId: string | null | undefined
  /** The answers as the resumed run receives them (a late Approve is already a denial). */
  responses: ReadonlyArray<{ approvalId?: unknown; approved?: unknown }>
  now?: () => Date
  /** Server-owned provenance check, run on this exact stored record before any write. */
  beforeRecord?: (record: { metadata?: unknown }) => Promise<void> | void
  /** Own the asynchronous persistence against account invalidation. */
  mutate?: (write: () => Promise<void>) => Promise<void>
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
  await options.beforeRecord?.(stored)

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
  let knownWrite: P5ApprovalAnswerWrite | undefined
  const result = (outcome: ApprovalAnswerOutcome): ApprovalAnswerOutcome => {
    if (knownWrite) p5AnswerResults.set(outcome, knownWrite)
    return outcome
  }
  const write = async () => {
    // `updateMessage` REPLACES metadata, so the whole stored metadata goes back with the record
    // added (the same read-then-merge `settleControlApprovalCard` does).
    const next = recordApprovalAnswers(metadata, options.responses, decidedAt)
    const acknowledge = () => {
      if (knownWrite) return
      knownWrite = Object.freeze({}) as P5ApprovalAnswerWrite
      const prior = readAnsweredApprovalIds(metadata)
      p5AnswerWrites.set(knownWrite, { userId: options.userId, sessionId: options.sessionId, messageId,
        approvalIds: Object.freeze([...readAnsweredApprovalIds(next)].filter(id => !prior.has(id))), consumed: false })
    }
    await redis.updateMessage(
      messageId,
      options.sessionId,
      { metadata: next },
      options.userId,
      { onJsonWriteAcknowledged: acknowledge }
    )
    // A fulfilled ordinary writer remains its existing acknowledgement. The
    // earlier observer additionally preserves the real partial-failure truth.
    acknowledge()
  }
  try {
    if (options.mutate) await options.mutate(write)
    else await write()
  } catch (error) {
    return result({ ok: false, reason: 'record_failed', error })
  }
  return result({ ok: true, recorded: true })
}
