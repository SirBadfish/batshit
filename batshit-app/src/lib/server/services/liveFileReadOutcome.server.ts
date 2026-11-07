import { randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import type { LiveFileReadSnapshot, LiveReplayUnavailableReason } from './liveFileReadTurn.server'

/**
 * SA-137 P4 (D10): what live file reads did for a chat's newest actual API turn, for the zip badges
 * and the Zip Manager. One record per chat, `live_file_reads:{sessionId}`, and this module is its
 * only writer.
 *
 * - **Reserve** when the route makes a turn's `LiveFileReadTurn` (an actual turn, never a preview):
 *   a new generation becomes `pending`. A pending receipt whose request was issued moves to
 *   `delivered` first, as dated history; an older one that never reached a request is dropped.
 * - **Prepare** after the compile froze the snapshot: the per-copy outcomes, only while this turn's
 *   generation is still the pending one (a later turn's reservation wins; an older compile never
 *   replaces a newer one).
 * - **Issue** at the first model request of the turn (`onApiModelInput`): the request with this
 *   frozen snapshot was sent. Nothing here says the model received or read it.
 *
 * The record holds no file text, credential or read grant: ids, outcomes, reasons and sizes. It
 * lives 24 hours, goes with its chat (`deleteSession`) and with its agent (`deleteAgent`), is never
 * exported (`backupRestoreService`'s runtime-only keys) and a restore deletes it. A record written by
 * another app process (an earlier boot) is unknown, never shown as current. Feature off, no turn is
 * made, so nothing here runs and no key is written (D12).
 */

export const LIVE_FILE_READ_OUTCOME_TTL_SECONDS = 24 * 60 * 60
/** The record's serialized size limit (pending plus delivered). */
export const LIVE_FILE_READ_OUTCOME_MAX_BYTES = 128 * 1024
/** At most this many per-copy entries in one receipt; the rest are counted in `overflow`. */
export const LIVE_FILE_READ_OUTCOME_MAX_COPIES = 512
/** One receipt's copies take at most this many serialized bytes, so two slots fit the record. */
const RECEIPT_COPIES_MAX_BYTES = 56 * 1024

/** This app process. A record written by another one is unknown (`readLiveFileReadOutcome`). */
const BOOT = randomUUID()

export type LiveReadDelivery = 'reserved' | 'prepared' | 'issued'

export type LiveReadReceiptCopy =
  | { zipId: string; status: 'refreshed'; promptTokens: number }
  | { zipId: string; status: 'static'; reason: string }

export interface LiveReadReceipt {
  generation: string
  agentId: string
  /** The reply this turn writes. */
  messageId: string
  reservedAt: string
  delivery: LiveReadDelivery
  compileId?: string
  preparedAt?: string
  issuedAt?: string
  /** An approval resume that had no usable snapshot of its paused call, and why. */
  replayUnavailable?: LiveReplayUnavailableReason
  /**
   * Round 2: that compile was strict, so a `static` copy was not shown (zipped that turn). Absent
   * or false, a static copy showed its stored text (a layout that refreshes nothing).
   */
  strict?: boolean
  copies?: LiveReadReceiptCopy[]
  /** Copies left out of `copies` (over 512 or the size limit): their state is not recorded. */
  overflow?: number
}

export interface LiveFileReadOutcomeRecord {
  v: 1
  userId: string
  sessionId: string
  boot: string
  pending: LiveReadReceipt | null
  delivered: LiveReadReceipt | null
}

export const liveFileReadOutcomeKey = (sessionId: string) => `live_file_reads:${sessionId}`

/**
 * One compare-and-set on the record, in Redis, under the chat's owner check. The receipts are moved
 * and written as the JSON text they arrive in (never decoded and re-encoded by Lua's cjson, which
 * turns an empty array into an object). Answers OK, STALE (another generation is pending, or the
 * step already ran), TOO_LARGE, MISSING_SESSION or FORBIDDEN.
 */
export const LIVE_FILE_READ_OUTCOME_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING_SESSION' end
local ownerRaw = redis.call('JSON.GET', KEYS[1], '$.user_id')
local owner = ownerRaw and cjson.decode(ownerRaw)[1]
if owner ~= ARGV[1] then return 'FORBIDDEN' end
local op = ARGV[2]
local current = nil
local raw = redis.call('JSON.GET', KEYS[2], '$')
if raw then
  local decoded = cjson.decode(raw)[1]
  if type(decoded) == 'table' and decoded.v == 1 and decoded.boot == ARGV[5] and decoded.userId == ARGV[1] then current = decoded end
end
local function inner(path)
  local value = redis.call('JSON.GET', KEYS[2], path)
  if not value then return 'null' end
  return string.sub(value, 2, -2)
end
local function finish(text)
  if string.len(text) > tonumber(ARGV[8]) then return 'TOO_LARGE' end
  redis.call('JSON.SET', KEYS[2], '$', text)
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
  return 'OK'
end
if op == 'reserve' then
  local delivered = 'null'
  if current then
    if type(current.pending) == 'table' and current.pending.delivery == 'issued' then
      delivered = inner('$.pending')
    elseif type(current.delivered) == 'table' then
      delivered = inner('$.delivered')
    end
  end
  return finish('{"v":1,"userId":' .. cjson.encode(ARGV[1]) .. ',"sessionId":' .. cjson.encode(ARGV[6]) ..
    ',"boot":' .. cjson.encode(ARGV[5]) .. ',"pending":' .. ARGV[4] .. ',"delivered":' .. delivered .. '}')
end
if not current or type(current.pending) ~= 'table' or current.pending.generation ~= ARGV[3] then return 'STALE' end
if op == 'prepare' then
  if current.pending.delivery ~= 'reserved' then return 'STALE' end
  local delivered = 'null'
  if type(current.delivered) == 'table' then delivered = inner('$.delivered') end
  return finish('{"v":1,"userId":' .. cjson.encode(ARGV[1]) .. ',"sessionId":' .. cjson.encode(ARGV[6]) ..
    ',"boot":' .. cjson.encode(ARGV[5]) .. ',"pending":' .. ARGV[4] .. ',"delivered":' .. delivered .. '}')
end
if op == 'issue' then
  if current.pending.delivery ~= 'prepared' then return 'STALE' end
  redis.call('JSON.SET', KEYS[2], '$.pending.delivery', '"issued"')
  redis.call('JSON.SET', KEYS[2], '$.pending.issuedAt', cjson.encode(ARGV[4]))
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
  return 'OK'
end
return redis.error_reply('Unknown live file read outcome step')
`

type OutcomeAnswer = 'OK' | 'STALE' | 'TOO_LARGE' | 'MISSING_SESSION' | 'FORBIDDEN'

async function runOutcomeStep(
  owner: { userId: string; sessionId: string },
  op: 'reserve' | 'prepare' | 'issue',
  generation: string,
  payload: string
): Promise<OutcomeAnswer> {
  return redis.execute(async (client: any) => String(await client.eval(LIVE_FILE_READ_OUTCOME_SCRIPT, {
    keys: [`session:${owner.sessionId}`, liveFileReadOutcomeKey(owner.sessionId)],
    arguments: [
      owner.userId,
      op,
      generation,
      payload,
      BOOT,
      owner.sessionId,
      String(LIVE_FILE_READ_OUTCOME_TTL_SECONDS),
      String(LIVE_FILE_READ_OUTCOME_MAX_BYTES)
    ]
  })) as OutcomeAnswer)
}

/** The receipt's per-copy entries within their bounds, and how many were left out. */
export function receiptCopiesOf(snapshot: Pick<LiveFileReadSnapshot, 'copies'>): { copies: LiveReadReceiptCopy[]; overflow: number } {
  const copies: LiveReadReceiptCopy[] = []
  let bytes = 2
  let overflow = 0
  for (const [zipId, outcome] of snapshot.copies) {
    const entry: LiveReadReceiptCopy = outcome.status === 'refreshed'
      ? { zipId, status: 'refreshed', promptTokens: outcome.promptTokens }
      : { zipId, status: 'static', reason: outcome.reason }
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    if (copies.length >= LIVE_FILE_READ_OUTCOME_MAX_COPIES || bytes + size > RECEIPT_COPIES_MAX_BYTES) {
      overflow += 1
      continue
    }
    copies.push(entry)
    bytes += size
  }
  return { copies, overflow }
}

/**
 * One actual turn's receipt. Every step is best effort for the reply (a storage failure never stops
 * a turn) and says so in the console; a failed or late step leaves the record unconfirmed, never a
 * fabricated state: the route shows what the record actually holds.
 */
export class LiveFileReadOutcome {
  private reservation: Promise<boolean> | null = null
  private issued = false

  private constructor(
    private readonly owner: { userId: string; sessionId: string; agentId: string; messageId: string },
    readonly generation: string,
    private readonly reservedAt: string
  ) {}

  /** Reserve a new generation for this turn (call once, when the turn's `LiveFileReadTurn` is made). */
  static reserve(owner: { userId: string; sessionId: string; agentId: string; messageId: string }, now = new Date()): LiveFileReadOutcome {
    const outcome = new LiveFileReadOutcome(owner, randomUUID(), now.toISOString())
    const receipt: LiveReadReceipt = {
      generation: outcome.generation,
      agentId: owner.agentId,
      messageId: owner.messageId,
      reservedAt: outcome.reservedAt,
      delivery: 'reserved'
    }
    outcome.reservation = runOutcomeStep(owner, 'reserve', outcome.generation, JSON.stringify(receipt))
      .then((answer) => {
        if (answer !== 'OK') console.warn(`[SA-137] The live file read receipt was not reserved (${answer}); the chat's badges show it as unknown.`)
        return answer === 'OK'
      })
      .catch((error) => {
        console.warn('[SA-137] The live file read receipt could not be reserved; the chat\'s badges show it as unknown:', error instanceof Error ? error.message : error)
        return false
      })
    return outcome
  }

  /** The compile froze this snapshot: record its outcomes (not that anything was sent). */
  async prepared(
    snapshot: Pick<LiveFileReadSnapshot, 'compileId' | 'copies'> & Partial<Pick<LiveFileReadSnapshot, 'strict'>>,
    replayUnavailable: LiveReplayUnavailableReason | null,
    now = new Date()
  ): Promise<void> {
    if (!(await this.reservation)) return
    const { copies, overflow } = receiptCopiesOf(snapshot)
    const receipt: LiveReadReceipt = {
      generation: this.generation,
      agentId: this.owner.agentId,
      messageId: this.owner.messageId,
      reservedAt: this.reservedAt,
      delivery: 'prepared',
      compileId: snapshot.compileId,
      preparedAt: now.toISOString(),
      ...(replayUnavailable ? { replayUnavailable } : {}),
      ...(snapshot.strict === true ? { strict: true } : {}),
      copies,
      ...(overflow > 0 ? { overflow } : {})
    }
    try {
      const answer = await runOutcomeStep(this.owner, 'prepare', this.generation, JSON.stringify(receipt))
      if (answer !== 'OK') console.warn(`[SA-137] The live file read receipt was not prepared (${answer}).`)
    } catch (error) {
      console.warn('[SA-137] The live file read receipt could not be prepared:', error instanceof Error ? error.message : error)
    }
  }

  /** The turn's first model request was issued with the frozen snapshot. Once per turn. */
  noteIssued(now = new Date()): void {
    if (this.issued) return
    this.issued = true
    void runOutcomeStep(this.owner, 'issue', this.generation, now.toISOString())
      .then((answer) => {
        if (answer !== 'OK') console.warn(`[SA-137] The live file read receipt was not marked sent (${answer}).`)
      })
      .catch((error) => {
        console.warn('[SA-137] The live file read receipt could not be marked sent:', error instanceof Error ? error.message : error)
      })
  }
}

function isReceipt(value: unknown): value is LiveReadReceipt {
  const receipt = value as LiveReadReceipt | null
  if (!receipt || typeof receipt !== 'object') return false
  if (typeof receipt.generation !== 'string' || typeof receipt.agentId !== 'string' || typeof receipt.messageId !== 'string') return false
  if (receipt.delivery !== 'reserved' && receipt.delivery !== 'prepared' && receipt.delivery !== 'issued') return false
  if (receipt.strict !== undefined && typeof receipt.strict !== 'boolean') return false
  if (receipt.copies !== undefined && (!Array.isArray(receipt.copies) || receipt.copies.some((copy) =>
    !copy || typeof copy.zipId !== 'string' ||
    (copy.status === 'refreshed' ? !Number.isSafeInteger(copy.promptTokens) : copy.status !== 'static' || typeof copy.reason !== 'string')))) {
    return false
  }
  return true
}

/**
 * The chat's record as this process wrote it, or null: absent, expired, malformed, another owner,
 * or written by another app process (then nothing in it is current).
 */
export async function readLiveFileReadOutcome(sessionId: string, userId: string): Promise<LiveFileReadOutcomeRecord | null> {
  const raw = (await redis.execute((client: any) => client.json.get(liveFileReadOutcomeKey(sessionId)))) as LiveFileReadOutcomeRecord | null
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || raw.boot !== BOOT || raw.userId !== userId || raw.sessionId !== sessionId) return null
  if (raw.pending !== null && !isReceipt(raw.pending)) return null
  if (raw.delivered !== null && !isReceipt(raw.delivered)) return null
  return raw
}

/**
 * Deleting an agent: its receipts go even where its chats stay. Only the slot that names this agent
 * is cleared (the whole record when nothing else is left); another agent's receipt in the same chat
 * stays. Returns how many records changed.
 */
export async function deleteLiveFileReadOutcomesOfAgent(client: any, agentId: string): Promise<number> {
  const keys: string[] = (await client.keys('live_file_reads:*')) ?? []
  let changed = 0
  for (const key of keys) {
    const record = (await client.json.get(key).catch(() => null)) as LiveFileReadOutcomeRecord | null
    const pendingMine = record?.pending?.agentId === agentId
    const deliveredMine = record?.delivered?.agentId === agentId
    if (!pendingMine && !deliveredMine) continue
    if ((pendingMine || !record?.pending) && (deliveredMine || !record?.delivered)) {
      await client.del(key)
    } else {
      if (pendingMine) await client.json.set(key, '$.pending', null)
      if (deliveredMine) await client.json.set(key, '$.delivered', null)
    }
    changed += 1
  }
  return changed
}

/** Test-only: this process's boot id. */
export function liveFileReadOutcomeBootForTests(): string {
  return BOOT
}
