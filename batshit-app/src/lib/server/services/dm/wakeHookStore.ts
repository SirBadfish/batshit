/**
 * SA-113 P3 (DL-113-09) — wake-up webhook records.
 *
 * The Portable Skill Token store is the pattern this copies: a random secret shown once,
 * only its sha256 kept, a timing-safe compare on use, and revoke rather than delete so a
 * revoked credential can never be re-validated by a stale index.
 *
 * The ONE deliberate difference is where the token is looked up. A Portable Skill Token is
 * presented alone, so that store keeps a hash → token index and finds the record from the
 * secret. A wake token is presented WITH its hook id in the URL, so this store reads the
 * named record and compares. That is stronger, not weaker: there is no hash index to keep
 * in step, a token stolen from one hook cannot be replayed against another, and a rotate
 * cannot leave a dangling index entry behind.
 *
 * `wake_hook:{hookId}` is the record (RedisJSON); `wake_hooks:{userId}` is a SET of ids.
 * Both are already registered in the backup `dms` group (`backupRestoreService.ts`), which
 * reads the SET to find the records — do not change the index to a ZSET without changing
 * `collectCandidateKeys` with it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { WAKE_HOOK_NAME_MAX_CHARS } from '$lib/utils/dmControl'
import {
  WAKE_HOOK_DELIVERY_MODES,
  toWakeHookSummary,
  type WakeHookDeliveryMode,
  type WakeHookRecord,
  type WakeHookSummary,
  type WakeHookValidation
} from '$lib/types/wakeHook'

const HOOK_ID_BYTES = 12
const TOKEN_SECRET_BYTES = 32
const TOKEN_PREFIX_LENGTH = 12
const TOKEN_SUFFIX_LENGTH = 6

export const WAKE_HOOK_KEY_PREFIX = 'wake_hook:'
export const WAKE_HOOKS_INDEX_PREFIX = 'wake_hooks:'

/**
 * A hook id is `whk_` plus base64url, and NOTHING else may be turned into a key.
 *
 * The id arrives as a URL path segment, so it is attacker-controlled text. This guard is
 * hygiene, and worth having for exactly these reasons: a malformed id answers "no such
 * hook" without a key read at all; the charset and length are bounded, so no wildcard,
 * control character, or unbounded string ever reaches a key name or a log line built from
 * one; and a typo is a clean miss instead of anything escaping `validateWakeHookToken` —
 * which sits outside the route's try/catch — as a 500 that would break "every failure the
 * same 403".
 *
 * What it is NOT: a fix for the two key spaces colliding. This header used to claim that
 * `wake_hook:` + `s:{userId}` is byte-identical to `wake_hooks:{userId}`, the index SET.
 * SA-116 P1 checked the arithmetic and it is false — the record prefix ends in `:` where the
 * index prefix has `s`, so no id can turn one key into the other. `scheduleKeys.ts` and
 * `controlApprovals.ts` follow the same shape and are equally safe.
 */
const HOOK_ID_PATTERN = /^whk_[A-Za-z0-9_-]{1,64}$/

export function isWellFormedHookId(hookId: unknown): hookId is string {
  return typeof hookId === 'string' && HOOK_ID_PATTERN.test(hookId)
}

export function wakeHookKey(hookId: string): string {
  return `${WAKE_HOOK_KEY_PREFIX}${hookId}`
}

export function wakeHooksIndexKey(userId: string): string {
  return `${WAKE_HOOKS_INDEX_PREFIX}${userId}`
}

export class WakeHookError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'WakeHookError'
  }
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

function generateHookId(): string {
  return `whk_${randomBytes(HOOK_ID_BYTES).toString('base64url')}`
}

function generateHookToken(): string {
  return `bswh_${randomBytes(TOKEN_SECRET_BYTES).toString('base64url')}`
}

function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Constant-time compare of two hex digests.
 *
 * The digests are equal length by construction, so the length check below only guards a
 * malformed stored value; it is not the comparison. Comparing the HASHES rather than the
 * secrets means a mismatch costs the same time regardless of how many leading characters
 * an attacker guessed right.
 */
function hashesMatch(expected: string, actual: string): boolean {
  try {
    const expectedBuffer = Buffer.from(expected, 'hex')
    const actualBuffer = Buffer.from(actual, 'hex')
    if (expectedBuffer.length === 0 || expectedBuffer.length !== actualBuffer.length) return false
    return timingSafeEqual(expectedBuffer, actualBuffer)
  } catch {
    return false
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!text) throw new WakeHookError('A wake-up webhook needs a name.')
  return text.slice(0, WAKE_HOOK_NAME_MAX_CHARS)
}

function normalizeDeliverDefault(value: unknown): WakeHookDeliveryMode {
  if (value === undefined || value === null) return 'wake'
  if (typeof value === 'string' && WAKE_HOOK_DELIVERY_MODES.includes(value as WakeHookDeliveryMode)) {
    return value as WakeHookDeliveryMode
  }
  throw new WakeHookError('A wake-up webhook delivers either "wait" or "wake".')
}

function normalizeExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const text = typeof value === 'string' ? value.trim() : ''
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) {
    throw new WakeHookError('That expiry date could not be read. Use an ISO date like 2027-01-31.')
  }
  return new Date(parsed).toISOString()
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getWakeHook(hookId: string): Promise<WakeHookRecord | null> {
  const normalized = typeof hookId === 'string' ? hookId.trim() : ''
  // A malformed id is "no such hook", never a key read: see `isWellFormedHookId`.
  if (!isWellFormedHookId(normalized)) return null
  const record = (await redis.json.get(wakeHookKey(normalized))) as WakeHookRecord | null
  return record && typeof record === 'object' ? record : null
}

/** Every live hook for this user, newest first. Revoked hooks are pruned from the index. */
export async function listWakeHooks(userId: string): Promise<WakeHookSummary[]> {
  const ids = await redis.execute(async (client) => {
    const members = await client.sMembers(wakeHooksIndexKey(userId))
    return Array.isArray(members) ? (members as string[]) : []
  })

  const summaries: WakeHookSummary[] = []
  for (const id of ids) {
    const record = await getWakeHook(id)
    if (!record || record.userId !== userId) {
      await redis.execute(async (client) => client.sRem(wakeHooksIndexKey(userId), [id]))
      continue
    }
    summaries.push(toWakeHookSummary(record))
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function writeHook(record: WakeHookRecord): Promise<void> {
  await redis.json.set(wakeHookKey(record.id), '$', record as never)
}

/**
 * Create a hook and return its token ONCE.
 *
 * The recipient agent is checked here rather than at call time, so an Admin mistake is
 * visible while the user is still looking at the form. The route re-checks anyway, because
 * an agent can be deleted or turned off after the hook exists.
 */
export async function createWakeHook(options: {
  userId: string
  agentId: unknown
  name: unknown
  deliverDefault?: unknown
  expiresAt?: unknown
}): Promise<{ token: string; record: WakeHookSummary }> {
  const agentId = typeof options.agentId === 'string' ? options.agentId.trim() : ''
  if (!agentId) throw new WakeHookError('Choose which agent this webhook writes to.')
  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  if (!agent || (agent.user_id && agent.user_id !== options.userId)) {
    throw new WakeHookError(`Agent "${agentId}" was not found.`, 404)
  }

  const secret = generateHookToken()
  const createdAt = nowIso()
  const record: WakeHookRecord = {
    id: generateHookId(),
    userId: options.userId,
    agentId,
    name: normalizeName(options.name),
    tokenHash: hashToken(secret),
    tokenPrefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
    tokenSuffix: secret.slice(-TOKEN_SUFFIX_LENGTH),
    deliverDefault: normalizeDeliverDefault(options.deliverDefault),
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: null,
    useCount: 0,
    expiresAt: normalizeExpiresAt(options.expiresAt),
  }

  await writeHook(record)
  await redis.execute(async (client) =>
    client.sAdd(wakeHooksIndexKey(record.userId), record.id)
  )
  return { token: secret, record: toWakeHookSummary(record) }
}

async function requireOwnedHook(userId: string, hookId: string): Promise<WakeHookRecord> {
  const record = await getWakeHook(hookId)
  if (!record || record.userId !== userId) {
    throw new WakeHookError('That wake-up webhook was not found.', 404)
  }
  return record
}

/**
 * Write named fields onto an EXISTING hook, never the whole record.
 *
 * F-P3-2 again, for the two writers it was not applied to. `writeHook` is
 * `JSON.SET key $ record`, and a root-path write CREATES a missing key — so a revoke
 * landing between `requireOwnedHook`'s read and the write brought the hook back with its
 * original `tokenHash` and `enabled: true`, while the owner's index no longer listed it.
 * The result was a live credential nothing in the UI could revoke a second time. The same
 * window silently undid a concurrent pause.
 *
 * A path write cannot create the root, so a revoked hook is a no-op here instead of a
 * resurrection, exactly as in `recordWakeHookUse`. RedisJSON raises on the missing key and
 * that is reported as the 404 it is.
 */
async function patchHookFields(
  hookId: string,
  fields: Record<string, unknown>
): Promise<WakeHookRecord> {
  const key = wakeHookKey(hookId)
  try {
    for (const [field, value] of Object.entries(fields)) {
      await redis.json.set(key, `$.${field}`, value as never)
    }
  } catch {
    throw new WakeHookError('That wake-up webhook was not found.', 404)
  }
  const record = await getWakeHook(hookId)
  if (!record) throw new WakeHookError('That wake-up webhook was not found.', 404)
  return record
}

export async function updateWakeHook(options: {
  userId: string
  hookId: string
  name?: unknown
  deliverDefault?: unknown
  enabled?: unknown
  expiresAt?: unknown
}): Promise<WakeHookSummary> {
  await requireOwnedHook(options.userId, options.hookId)
  const updated = await patchHookFields(options.hookId, {
    ...(options.name === undefined ? {} : { name: normalizeName(options.name) }),
    ...(options.deliverDefault === undefined
      ? {}
      : { deliverDefault: normalizeDeliverDefault(options.deliverDefault) }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled === true }),
    ...(options.expiresAt === undefined
      ? {}
      : { expiresAt: normalizeExpiresAt(options.expiresAt) }),
    updatedAt: nowIso()
  })
  return toWakeHookSummary(updated)
}

/**
 * Issue a new token for an existing hook. The old hash is replaced in the same write, so
 * the previous token stops working at once — a rotate is a revoke that keeps the URL.
 */
export async function rotateWakeHookToken(options: {
  userId: string
  hookId: string
}): Promise<{ token: string; record: WakeHookSummary }> {
  await requireOwnedHook(options.userId, options.hookId)
  const secret = generateHookToken()
  const updated = await patchHookFields(options.hookId, {
    tokenHash: hashToken(secret),
    tokenPrefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
    tokenSuffix: secret.slice(-TOKEN_SUFFIX_LENGTH),
    updatedAt: nowIso()
  })
  return { token: secret, record: toWakeHookSummary(updated) }
}

/**
 * Revoke a hook for good.
 *
 * The record is DELETED rather than tombstoned, because `wake_hook:{id}` is the only thing
 * the route reads: leaving a revoked record behind would mean one more state that has to
 * be checked correctly on every call. The id is removed from the index in the same act.
 */
export async function revokeWakeHook(options: {
  userId: string
  hookId: string
}): Promise<void> {
  const record = await requireOwnedHook(options.userId, options.hookId)
  await redis.del(wakeHookKey(record.id))
  await redis.execute(async (client) =>
    client.sRem(wakeHooksIndexKey(record.userId), [record.id])
  )
}

/* ------------------------------------------------------------------ *
 * Use
 * ------------------------------------------------------------------ */

/**
 * Validate a bearer token against ONE named hook.
 *
 * Every failure returns a reason for the server log, and the route turns all of them into
 * the same 403 — a caller must not be able to tell "no such hook" from "wrong token",
 * which is what makes hook ids safe to hand to n8n in a URL.
 */
export async function validateWakeHookToken(
  hookId: string,
  secret: string | null | undefined
): Promise<WakeHookValidation> {
  const token = typeof secret === 'string' ? secret.trim() : ''
  if (!token) return { valid: false, reason: 'missing' }

  const record = await getWakeHook(hookId)
  if (!record) return { valid: false, reason: 'invalid' }
  if (!hashesMatch(record.tokenHash, hashToken(token))) {
    return { valid: false, reason: 'invalid' }
  }
  if (!record.enabled) return { valid: false, reason: 'disabled' }
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    return { valid: false, reason: 'expired' }
  }
  return { valid: true, record }
}

/**
 * Bump the usage counters after a call the route accepted. Never fails the call.
 *
 * **Path-scoped on purpose (F-P3-2).** This used to read the record and write the whole
 * thing back, which raced every other writer of the same key. A rotate landing inside that
 * window was undone — the OLD token validated again and the new one was refused, silently.
 * A revoke landing inside it was resurrected: the key came back with a valid hash and no
 * index entry, so the hook authenticated and was not listed anywhere. Two field writes
 * touch only what they own (precedent: `memory/memoryEpisodes.ts`), and RedisJSON refuses
 * a path write when the root key is gone, which makes a revoked hook a no-op instead of a
 * resurrection.
 */
export async function recordWakeHookUse(hookId: string): Promise<void> {
  try {
    const key = wakeHookKey(hookId)
    await redis.json.set(key, '$.lastUsedAt', nowIso() as never)
    await redis.json.numIncrBy(key, '$.useCount', 1)
  } catch {
    // A hook revoked between the call and this bump is the expected case, and the call it
    // is recording already succeeded. Nothing here is worth a warning.
  }
}

/* ------------------------------------------------------------------ *
 * Agent deletion (DL-113-02)
 * ------------------------------------------------------------------ */

/**
 * Delete every hook pointing at a deleted agent.
 *
 * A hook whose agent is gone is a live credential that can only ever produce a 404, so it
 * goes with the agent — the same reason its inbox does. Hooks belonging to OTHER agents of
 * the same user are untouched.
 */
export async function sweepAgentWakeHooks(agentId: string): Promise<number> {
  const record = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  const userId = typeof record?.user_id === 'string' ? record.user_id : null
  if (!userId) return 0

  const ids = await redis.execute(async (client) => {
    const members = await client.sMembers(wakeHooksIndexKey(userId))
    return Array.isArray(members) ? (members as string[]) : []
  })

  let deleted = 0
  for (const id of ids) {
    const hook = await getWakeHook(id)
    if (!hook || hook.agentId !== agentId) continue
    await redis.del(wakeHookKey(id))
    await redis.execute(async (client) => client.sRem(wakeHooksIndexKey(userId), [id]))
    deleted += 1
  }
  return deleted
}
