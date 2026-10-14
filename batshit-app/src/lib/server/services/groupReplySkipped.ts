import { redis } from '$lib/server/redis'
import { executionViewerService } from './executionViewerService'
import { isSavedUserMessageForSend } from './queuedSendRules'
import { neutralizeAllZipReferenceSyntax } from '$lib/utils/zipReferenceSafety'
import { groupReplyContentHash, type GroupReplySkipped } from '$lib/utils/groupReplySkipped'
import type { GroupSpeakerOutcome, GroupSpeakerSelectionMetadata } from './groupSpeaker.jev'

/**
 * Only this writer stamps a user-event skip. Existing message and EV keys own deletion and
 * backup; no new key family. The path-only Lua write rechecks identity/content atomically,
 * so an edit/delete during the EV write cannot stamp another turn or recreate a message.
 */
const RECEIPT_OUTCOME_WAIT_MS = 1000

function receiptConfidenceMatches(expected: number, actual: unknown): boolean {
  // RedisJSON 8.10.1 round-trips 0.9299999999999999 as 0.93. In the valid
  // (0.5, 1] domain, one binary64 step is EPSILON / 2. Allow only that last-bit
  // representation difference here; never round a decision or cross its floor.
  return typeof actual === 'number' && Number.isFinite(actual) && Number.isFinite(expected) &&
    actual > 0.5 && actual <= 1 && expected > 0.5 && expected <= 1 &&
    Math.abs(actual - expected) <= Number.EPSILON / 2
}

const STAMP_GROUP_REPLY_SKIPPED = `
local session = redis.call('JSON.GET', KEYS[1])
local message = redis.call('JSON.GET', KEYS[2])
if not session or not message then return 0 end
local s = cjson.decode(session)
local m = cjson.decode(message)
if s.user_id ~= ARGV[1] or m.user_id ~= ARGV[1] or m.session_id ~= ARGV[2]
  or m.id ~= ARGV[3] or m.role ~= 'user' or m.content ~= ARGV[4]
  or not redis.call('LPOS', KEYS[3], ARGV[3]) then return 0 end
if redis.call('JSON.TYPE', KEYS[2], '$.metadata')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[2], '$.metadata', '{}')
end
redis.call('JSON.SET', KEYS[2], '$.metadata.groupReplySkipped', ARGV[5])
return 1
`

export async function recordSkippedGroupUserReply(input: {
  userId: string
  sessionId: string
  messageId: string | null
  content: string
  groupTurnId: string
  eventIndex: number
  outcome: GroupSpeakerOutcome
  signal?: AbortSignal
}): Promise<{ outcome: 'skipped' | 'refused' | 'stopped' | 'unconfirmed'; evidenceRecorded: boolean }> {
  const { outcome, messageId } = input
  const confidence = outcome.decision?.noReplyConfidence
  if (!messageId || input.eventIndex !== 1 || outcome.record.status !== 'ok' ||
    outcome.decision?.outcome !== 'no_reply' || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence <= 0.5 || confidence > 1) return { outcome: input.signal?.aborted ? 'stopped' : 'refused', evidenceRecorded: false }
  let snapshotId: string | null = null
  let evidenceRecorded = false
  try {
    const [session, saved] = await redis.execute((client) => Promise.all([
      client.json.get(`session:${input.sessionId}`),
      client.json.get(`message:${input.sessionId}:${messageId}`)
    ])) as [Record<string, unknown> | null, Record<string, unknown> | null]
    if (session?.user_id !== input.userId || !isSavedUserMessageForSend(saved, { ...input, userMessageId: messageId }) ||
      typeof saved?.content !== 'string' ||
      neutralizeAllZipReferenceSyntax(saved.content) !== input.content.replace(/\n{3,}/g, '\n\n').trim() || input.signal?.aborted) return { outcome: input.signal?.aborted ? 'stopped' : 'refused', evidenceRecorded: false }
    snapshotId = `gs_${crypto.randomUUID()}`
    const mark: GroupReplySkipped = {
      source: 'jev', messageId, groupTurnId: input.groupTurnId, eventIndex: 1,
      snapshotId, contentHash: groupReplyContentHash(saved.content), confidence, at: new Date().toISOString()
    }
    const selection: GroupSpeakerSelectionMetadata = {
      by: 'jev', reason: 'no_reply', noReplyConfidence: confidence,
      needsReply: outcome.decision.needsReply,
      skipped: outcome.decision.skipped.map((reading) => ({ agentId: reading.agentId, agentName: reading.name, addsValue: reading.addsValue }))
    }
    // A skipped user event has no speaker snapshot to append to. Reuse P9's no-run shape,
    // through the normal bounded/sanitized EV writer, before making the visible skip durable.
    await executionViewerService.recordSnapshot({
      id: snapshotId, sessionId: input.sessionId, userId: input.userId,
      agentId: null, agentName: 'Group', agentType: 'group_speaker', createdAt: mark.at,
      userMessage: saved.content, structuredInput: null,
      executionMetadata: {
        typesafeCalls: [{ ...outcome.record, decision: `${outcome.record.decision?.replace('→ user reply skipped', '→ no reply proposed')}; receipt pending` }],
        groupChat: { groupTurnId: input.groupTurnId, eventIndex: 1, sourceMessageId: messageId, noReplyReceipt: 'pending' }
      }
    })
    evidenceRecorded = true
    let stamped: unknown
    let stampTimer: ReturnType<typeof setTimeout> | undefined
    const stampAbort = new AbortController()
    try {
      stamped = await Promise.race([
        redis.execute((client) => input.signal?.aborted ? Promise.resolve(0) : client.withCommandOptions({ timeout: RECEIPT_OUTCOME_WAIT_MS, abortSignal: stampAbort.signal }).eval(STAMP_GROUP_REPLY_SKIPPED, {
          keys: [`session:${input.sessionId}`, `message:${input.sessionId}:${messageId}`, `messages:${input.sessionId}`],
          arguments: [input.userId, input.sessionId, messageId, saved.content as string, JSON.stringify(mark)]
        })),
        new Promise<never>((_resolve, reject) => { stampTimer = setTimeout(() => { stampAbort.abort(); reject(new Error('Group skip write outcome deadline')) }, RECEIPT_OUTCOME_WAIT_MS) })
      ])
    } catch (error) {
      // redis.execute has no transaction outcome fence. A socket error rejects commands
      // waiting for a reply even when Redis applied them. One exact read can confirm this
      // stamp; a missing mark cannot prove an earlier mutation will never apply.
      console.warn('[Judge Juice] Group skip write outcome is uncertain', { sessionId: input.sessionId, messageId, snapshotId, error })
      let readTimer: ReturnType<typeof setTimeout> | undefined
      const readAbort = new AbortController()
      try {
        const current = await Promise.race([
          redis.execute((client) => client.withCommandOptions({ timeout: RECEIPT_OUTCOME_WAIT_MS, abortSignal: readAbort.signal }).json.get(`message:${input.sessionId}:${messageId}`)),
          new Promise<never>((_resolve, reject) => { readTimer = setTimeout(() => { readAbort.abort(); reject(new Error('Group skip reconciliation deadline')) }, RECEIPT_OUTCOME_WAIT_MS) })
        ]) as Record<string, any> | null
        const receipt = current?.metadata?.groupReplySkipped
        if (current?.user_id === input.userId && current?.session_id === input.sessionId && current?.id === messageId &&
          current?.role === 'user' && current?.content === saved.content &&
          receipt && Object.entries(mark).every(([key, value]) => key === 'confidence'
            ? receiptConfidenceMatches(mark.confidence, receipt.confidence)
            : receipt[key] === value)) stamped = 1
      } catch (readError) {
        console.warn('[Judge Juice] Group skip reconciliation unavailable', { sessionId: input.sessionId, messageId, snapshotId, error: readError })
      } finally {
        clearTimeout(readTimer)
        readAbort.abort()
      }
      if (stamped !== 1) {
        await patchReceipt('unconfirmed')
        return { outcome: 'unconfirmed', evidenceRecorded: true }
      }
    } finally {
      clearTimeout(stampTimer)
      stampAbort.abort()
    }
    if (stamped !== 0 && stamped !== 1) {
      await patchReceipt('unconfirmed')
      return { outcome: 'unconfirmed', evidenceRecorded: true }
    }
    if (stamped === 1) {
      await patchReceipt('saved')
      return { outcome: 'skipped', evidenceRecorded: true }
    }
    const receipt = input.signal?.aborted ? 'stopped' : 'refused'
    await patchReceipt(receipt)
    return { outcome: receipt, evidenceRecorded: true }

    async function patchReceipt(receipt: 'saved' | 'stopped' | 'refused' | 'unconfirmed') {
      const explanation = receipt === 'stopped' ? 'turn stopped; skip receipt not saved; no agent run'
        : receipt === 'refused' ? 'skip receipt refused; no speaker selected by this entry'
          : 'skip receipt unconfirmed; turn ended without an agent or automatic replay'
      let patchTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([executionViewerService.updateSnapshot(input.sessionId, snapshotId!, {
          executionMetadata: {
            typesafeCalls: [receipt === 'saved' ? outcome.record : { ...outcome.record, decision: `${outcome.record.decision?.replace('→ user reply skipped', '→ no reply proposed')}; ${explanation}` }],
            groupChat: { groupTurnId: input.groupTurnId, eventIndex: 1, sourceMessageId: messageId, noReplyReceipt: receipt,
              ...(receipt === 'saved' ? { speakerSelection: selection } : {}) }
          }
        }), new Promise<never>((_resolve, reject) => { patchTimer = setTimeout(() => reject(new Error('Group skip EV outcome deadline')), RECEIPT_OUTCOME_WAIT_MS) })])
      } catch (error) {
        // A timed-out patch may still run; it only updates this no-run snapshot's indexed
        // path (never recreates a deleted EV root). Keep pending evidence honest meanwhile.
        // A saved mark is authoritative even if this patch fails or times out. No caller/
        // Voice completion is attached to this late write, and no agent fallback is allowed.
        console.warn('[Judge Juice] Could not update group no-reply outcome', { sessionId: input.sessionId, messageId, snapshotId, receipt, error })
      } finally {
        clearTimeout(patchTimer)
      }
    }
  } catch (error) {
    console.warn('[Judge Juice] Could not save group no-reply evidence', { sessionId: input.sessionId, messageId, snapshotId, error })
  }
  return { outcome: input.signal?.aborted ? 'stopped' : 'refused', evidenceRecorded }
}
