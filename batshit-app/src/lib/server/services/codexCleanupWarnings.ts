/**
 * A stopped Codex reply can learn that command cleanup failed after its SSE `end`.
 * Keep that fact beside the reply, not in message metadata: the browser may still save
 * an older copy of the message. The fixed text contains no process details.
 *
 * codex_cleanup_warnings:{sessionId}                  set of reply ids
 * codex_cleanup_warning:{sessionId}:{messageId}      one warning record
 * Both keys live as long as their chat/reply, without a TTL.
 */
import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { isSessionDeleting } from '$lib/server/services/streamAbortRegistry'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import {
  readCodexCleanupWarning,
  type CodexCleanupWarning,
  type CodexCleanupWarningKind
} from '$lib/utils/codexCleanupWarning'

const indexKey = (sessionId: string) => `codex_cleanup_warnings:${sessionId}`
const itemKey = (sessionId: string, messageId: string) =>
  `codex_cleanup_warning:${sessionId}:${messageId}`
const pendingKey = (sessionId: string, messageId: string) => JSON.stringify([sessionId, messageId])
type WarningInput = { userId: string; sessionId: string; messageId: string; kind: CodexCleanupWarningKind }
const pending = new Map<string, { input: WarningInput; timer: ReturnType<typeof setTimeout> }>()
const PENDING_LIFETIME_MS = 60_000

function clearPending(sessionId: string, messageId: string): void {
  const key = pendingKey(sessionId, messageId)
  const entry = pending.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(key)
}

function keepPending(input: WarningInput): void {
  const key = pendingKey(input.sessionId, input.messageId)
  // A late ordinary failure callback cannot downgrade a recovered warning that is still waiting
  // for send-routed's first save of this reply.
  if (pending.get(key)?.input.kind === 'recorded_processes_ended' &&
      input.kind === 'unconfirmed_command_cleanup') return
  clearPending(input.sessionId, input.messageId)
  const timer = setTimeout(() => {
    const current = pending.get(key)
    if (current?.input !== input) return
    clearPending(input.sessionId, input.messageId)
    console.error('[Codex cleanup] Warning could not be attached: its reply was not saved before pending expiry.', {
      sessionId: input.sessionId,
      messageId: input.messageId
    })
  }, PENDING_LIFETIME_MS)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  pending.set(key, { input, timer })
}

export function clearPendingCodexCleanupWarning(sessionId: string, messageId?: string): void {
  if (messageId) {
    clearPending(sessionId, messageId)
    return
  }
  for (const entry of pending.values()) {
    if (entry.input.sessionId === sessionId) clearPending(sessionId, entry.input.messageId)
  }
}

// Atomic with the existence/ownership checks: a deletion cannot pass the message sweep
// and then have a late cleanup callback recreate its annotation. A concurrent save of
// the reply does not touch these keys. Idempotent for repeat cleanup reports.
const WRITE_WARNING_SCRIPT = `
-- BATSHIT_CODEX_CLEANUP_WARNING_V1
if redis.call('TYPE', KEYS[3]).ok ~= 'none' and redis.call('TYPE', KEYS[3]).ok ~= 'set' then
  return redis.error_reply('Codex cleanup warning index has the wrong type')
end
if redis.call('TYPE', KEYS[4]).ok ~= 'none' and redis.call('TYPE', KEYS[4]).ok ~= 'ReJSON-RL' then
  return redis.error_reply('Codex cleanup warning record has the wrong type')
end
local sessionJson = redis.call('JSON.GET', KEYS[1])
if not sessionJson then return -2 end
local session = cjson.decode(sessionJson)
if session.user_id ~= ARGV[1] then return -1 end
local messageJson = redis.call('JSON.GET', KEYS[2])
if not messageJson then return 0 end
local message = cjson.decode(messageJson)
if message.user_id ~= ARGV[1] or message.session_id ~= ARGV[2] or message.id ~= ARGV[3]
  or message.role ~= 'assistant' then return -1 end
if redis.call('EXISTS', KEYS[4]) == 1 then
  local previous = cjson.decode(redis.call('JSON.GET', KEYS[4]))
  if previous.messageId ~= ARGV[3] or
    (previous.kind ~= 'unconfirmed_command_cleanup' and previous.kind ~= 'recorded_processes_ended') then
    return redis.error_reply('Codex cleanup warning record is invalid')
  end
  if previous.kind == 'unconfirmed_command_cleanup' and ARGV[5] == 'recorded_processes_ended' then
    redis.call('JSON.SET', KEYS[4], '$', ARGV[4])
    redis.call('SADD', KEYS[3], ARGV[3])
    return 3
  end
  redis.call('SADD', KEYS[3], ARGV[3])
  return 2
end
redis.call('JSON.SET', KEYS[4], '$', ARGV[4])
redis.call('SADD', KEYS[3], ARGV[3])
return 1
`

async function writeWarning(input: WarningInput): Promise<number> {
  const { userId, sessionId, messageId, kind } = input
  const record: CodexCleanupWarning = { messageId, kind }
  const result = await redis.execute((client) =>
    client.eval(WRITE_WARNING_SCRIPT, {
      keys: [`session:${sessionId}`, `message:${sessionId}:${messageId}`, indexKey(sessionId), itemKey(sessionId, messageId)],
      arguments: [userId, sessionId, messageId, JSON.stringify(record), kind]
    })
  )
  return Number(result)
}

/**
 * Persist a recovered-run notice before clearing its recovery journal.
 * A process-local pending callback is never counted as durable. Missing chat/reply
 * statuses are deliberate terminal outcomes; ownership and Redis failures throw.
 */
export async function recordRecoveredCodexCleanupWarning(input: {
  userId: string
  sessionId: string
  messageId: string
}): Promise<'stored' | 'missing_reply' | 'missing_chat'> {
  const { userId, sessionId, messageId } = input
  if (!userId || !sessionId || !messageId) throw new Error('Codex cleanup warning requires a user, chat, and reply')
  if (isSessionDeleting(sessionId)) throw new Error('Codex cleanup warning chat deletion is in progress')
  const result = await writeWarning({ ...input, kind: 'recorded_processes_ended' })
  if (result === 0) return 'missing_reply'
  if (result === -2) return 'missing_chat'
  if (result === -1) throw new Error('Codex cleanup warning owner or reply does not match')
  if (result !== 1 && result !== 2 && result !== 3) {
    throw new Error(`Unexpected Codex cleanup warning write result: ${result}`)
  }
  clearPending(sessionId, messageId)
  if (result === 1 || result === 3) {
    await publishUserEvent(userId, { type: 'codex_cleanup_warning', sessionId, messageId })
  }
  return 'stored'
}

/** Write and announce once. A deleted chat/reply or wrong owner is a no-op. */
export async function recordCodexCleanupWarning(input: {
  userId: string
  sessionId: string
  messageId: string
  kind?: CodexCleanupWarningKind
}): Promise<void> {
  const { userId, sessionId, messageId } = input
  if (!userId || !sessionId || !messageId || isSessionDeleting(sessionId)) return
  // A fast cleanup failure may arrive before send-routed's canonical final save. No poll and
  // no new message: the next successful save of this exact reply flushes the pending fact.
  keepPending({ ...input, kind: input.kind ?? 'unconfirmed_command_cleanup' })
  await flushPendingCodexCleanupWarning(sessionId, messageId)
}

/** Fast no-op on ordinary saves. Called only after a reply has actually been persisted. */
export async function flushPendingCodexCleanupWarning(sessionId: string, messageId: string): Promise<void> {
  const entry = pending.get(pendingKey(sessionId, messageId))
  if (!entry || isSessionDeleting(sessionId)) return
  const { userId } = entry.input
  const stored = await writeWarning(entry.input)
  // A newer recovered callback can replace this pending entry while EVAL is in flight.
  if ([1, 2, 3, -1, -2].includes(Number(stored)) &&
      pending.get(pendingKey(sessionId, messageId)) === entry) clearPending(sessionId, messageId)
  if (stored === 1 || stored === 3) {
    await publishUserEvent(userId, { type: 'codex_cleanup_warning', sessionId, messageId })
  }
}

export async function loadCodexCleanupWarnings(sessionId: string): Promise<Record<string, CodexCleanupWarning>> {
  const records: Record<string, CodexCleanupWarning> = {}
  if (!sessionId) return records
  return redis.execute(async (client) => {
    for (const id of await client.sMembers(indexKey(sessionId))) {
      const raw = await client.json.get(itemKey(sessionId, id))
      const record = readCodexCleanupWarning(raw, id)
      if (record) records[id] = record
    }
    return records
  })
}

export async function deleteCodexCleanupWarning(sessionId: string, messageId: string): Promise<void> {
  if (!sessionId || !messageId) return
  clearPending(sessionId, messageId)
  await redis.del(itemKey(sessionId, messageId))
  await redis.sRem(indexKey(sessionId), messageId)
}

export async function sweepCodexCleanupWarnings(sessionId: string): Promise<void> {
  if (!sessionId) return
  clearPendingCodexCleanupWarning(sessionId)
  await redis.execute(async (client) => {
    // A failed earlier SADD can leave an item outside the index; sweep by escaped key pattern.
    const keys = await client.keys(`codex_cleanup_warning:${escapeRedisGlob(sessionId)}:*`)
    if (keys.length > 0) await client.del(keys as [string, ...string[]])
    await client.del(indexKey(sessionId))
  })
}
