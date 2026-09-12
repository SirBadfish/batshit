/**
 * SA-117 P1 (DL-117-01, DL-117-02) — the run credential for a managed CLI run.
 *
 * **What problem this solves.** Before this, a managed CLI helper proved one thing — "I hold
 * the instance `BATSHIT_TOKEN`" — and then *said* which agent it was, in the request body.
 * The helper is honest (its agent id is fixed at launch), but anything else holding that
 * token could name any of the user's agents and read that agent's DMs or memories. A run
 * credential is minted by Batshit when a run starts, is bound to that user, that agent, and
 * that session, and is revoked when the run ends — so the server reads the acting agent from
 * the credential instead of from the body.
 *
 * **`wakeHookStore.ts` is the store this copies, and the reason is the presentation shape.**
 * A Portable Skill Token is presented ALONE, so `portableSkillTokens.ts` keeps a hash → record
 * index and finds the record from the secret. A wake token is presented WITH its hook id in
 * the URL, so that store reads the NAMED record and compares. A run credential is presented as
 * `x-batshit-agent-token: <credentialId>.<secret>` — the id travels with the secret — so it is
 * the named-record shape too. That is stronger, not weaker: there is no hash index to keep in
 * step, a secret stolen from one run cannot be replayed against another run's id, and a revoke
 * cannot leave a dangling index entry that re-validates a dead credential.
 *
 * The half of `portableSkillTokens.ts` NOT copied is its root-path `json.set(key, '$', …)` for
 * `lastUsedAt`, which is the exact race `wakeHookStore.ts` documents as having resurrected
 * revoked credentials. Every write here that is not the create is path-scoped.
 *
 * **Keys.** `agent_run_credential:{credentialId}` is the record (RedisJSON);
 * `agent_run_credentials:{agentId}` is a **SET** of that agent's live credential ids.
 *
 * Each family is registered in THREE other places, and missing any one is a silent leak
 * (`dmKeys.ts` and `scheduleKeys.ts` are the precedent for listing them here as a checklist):
 *
 *   1. `redis.deleteAgent` (`redis.ts`) — a credential naming a deleted agent goes with it,
 *      via `sweepAgentRunCredentials`, called BEFORE the agent record is removed because the
 *      sweep reads the agent-scoped index and nothing else can find it afterwards.
 *   2. the backup inventory (`backupRestoreService.ts`) — deliberately **ABSENT** from
 *      `collectCandidateKeys` and from both prefix lists in `isRestorableKeyForUser`, the same
 *      way `subagent_lock:` is absent (DL-117-09). This is transient run state: a restored
 *      credential would authenticate as an agent for a run that ended before the backup was
 *      even taken. Both halves are pinned by `backupRestoreService.test.ts`.
 *   3. this file.
 *
 * **`deleteSession` deliberately owes nothing.** A run credential is agent-scoped, lives
 * minutes to hours, is revoked by its own bridge at run end, and is backstopped by a 24-hour
 * Redis `EXPIRE`. That is the same recorded exception DMs and schedules take.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { redis } from '$lib/server/redis'

const CREDENTIAL_ID_BYTES = 12
const TOKEN_SECRET_BYTES = 32
const TOKEN_PREFIX_LENGTH = 12
const TOKEN_SUFFIX_LENGTH = 6

export const AGENT_RUN_CREDENTIAL_KEY_PREFIX = 'agent_run_credential:'
export const AGENT_RUN_CREDENTIALS_INDEX_PREFIX = 'agent_run_credentials:'

/** The header the managed CLI helpers present the credential on (DL-117-01). */
export const AGENT_RUN_CREDENTIAL_HEADER = 'x-batshit-agent-token'

/** The child-process environment variable that carries it to the helper (DL-117-01). */
export const AGENT_RUN_CREDENTIAL_ENV_VAR = 'BATSHIT_AGENT_TOKEN'

/**
 * 24 hours, as a BACKSTOP only — not the lifetime.
 *
 * A run credential is revoked by the bridge that minted it when the run ends. This expiry is
 * what catches the run that never got to its `finally`: a killed app, a crashed bridge, a
 * machine that lost power mid-turn. `expiresAt` on the record carries the same instant so a
 * key the TTL has not reaped yet — a restored dump, a Redis whose expiry cycle lagged — is
 * still refused by `validateRunCredential` rather than trusted because it still exists.
 */
export const AGENT_RUN_CREDENTIAL_TTL_SECONDS = 60 * 60 * 24

export const AGENT_RUN_CREDENTIAL_RUNTIMES = ['codex', 'claude'] as const
export type AgentRunCredentialRuntime = (typeof AGENT_RUN_CREDENTIAL_RUNTIMES)[number]

export type AgentRunCredentialRecord = {
  id: string
  userId: string
  agentId: string
  sessionId: string
  /** The assistant message the run is writing, when the bridge knows it. */
  messageId?: string | null
  runtime: AgentRunCredentialRuntime
  /**
   * SA-117 P2 (F-P2-1) — a DELEGATED run: a Subagent or a Worker on a managed CLI lane.
   *
   * Its `agentId` is a per-run runtime id the server derived from the subagent's slug
   * (`subagent_cli_…`), not a stored agent, so there is no `agent:{id}` record to check it
   * against — and no inbox, no memories and no schedules behind it either. The flag exists
   * so `requireActingAgentIdentity` can refuse it: a delegated run legitimately needs the
   * helper (tool search, tool use, CLI tools, bash), and just as legitimately has no
   * identity to act as. Without it, the `agent` lane would have vouched for a name that
   * belongs to nobody.
   */
  delegated: boolean
  /** sha256 hex of the secret half. The secret itself is stored nowhere. */
  tokenHash: string
  tokenPrefix: string
  tokenSuffix: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  useCount: number
}

/** Why a presentation was refused. FOR THE SERVER LOG ONLY — see `validateRunCredential`. */
export type AgentRunCredentialRefusalReason =
  | 'missing'
  | 'malformed'
  | 'invalid'
  | 'expired'

export type AgentRunCredentialValidation =
  | { valid: true; record: AgentRunCredentialRecord }
  | { valid: false; reason: AgentRunCredentialRefusalReason }

/**
 * A credential id is `arc_` plus base64url, and NOTHING else may be turned into a key.
 *
 * The id arrives inside an attacker-controlled request header, so this guard is hygiene, and
 * worth having for exactly these reasons: a malformed id answers "no such credential" without
 * a key read at all; the charset and length are bounded, so no wildcard, control character, or
 * unbounded string ever reaches a key name or a log line built from one; and a typo is a clean
 * miss instead of a Redis error escaping the auth resolver as a 500 — which would break "every
 * failure the same 403" from the outside even though the code below is uniform.
 *
 * What it is NOT: a fix for the two key spaces colliding. `agent_run_credential:{X}` cannot
 * equal `agent_run_credentials:{Y}` for any X and Y, because that needs `:{X}` to equal
 * `s:{Y}` and those differ in their first character. SA-116 P1 checked the same arithmetic for
 * `wake_hook:`/`wake_hooks:`, `schedule:`/`schedules:`, and `control_approval:`/
 * `control_approvals:`; all four families are the same shape and all four are safe. DL-117-02
 * repeats the older, wrong collision claim — it is wrong there too, and the guard stays for the
 * reasons above.
 */
const RUN_CREDENTIAL_ID_PATTERN = /^arc_[A-Za-z0-9_-]{1,64}$/

export function isWellFormedRunCredentialId(credentialId: unknown): credentialId is string {
  return typeof credentialId === 'string' && RUN_CREDENTIAL_ID_PATTERN.test(credentialId)
}

/** The record itself (RedisJSON). */
export function agentRunCredentialKey(credentialId: string): string {
  return `${AGENT_RUN_CREDENTIAL_KEY_PREFIX}${credentialId}`
}

/** SET of this agent's live credential ids. A SET, like `wake_hooks:` and `schedules:`. */
export function agentRunCredentialsIndexKey(agentId: string): string {
  return `${AGENT_RUN_CREDENTIALS_INDEX_PREFIX}${agentId}`
}

export class AgentRunCredentialError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'AgentRunCredentialError'
  }
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

function generateCredentialId(): string {
  return `arc_${randomBytes(CREDENTIAL_ID_BYTES).toString('base64url')}`
}

function generateCredentialSecret(): string {
  return `bsac_${randomBytes(TOKEN_SECRET_BYTES).toString('base64url')}`
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Constant-time compare of two hex digests.
 *
 * The digests are equal length by construction, so the length check only guards a malformed
 * stored value; it is not the comparison. Comparing the HASHES rather than the secrets means a
 * mismatch costs the same time no matter how many leading characters an attacker guessed right.
 * `nativeToolAuth.ts`'s `tokenMatches` compares raw secrets after a length check, so it leaks
 * the instance token's LENGTH; both credential stores compare hashes for this reason.
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

function requireIdentifier(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new AgentRunCredentialError(`A run credential needs ${field}.`)
  return text
}

function normalizeRuntime(value: unknown): AgentRunCredentialRuntime {
  if (
    typeof value === 'string' &&
    AGENT_RUN_CREDENTIAL_RUNTIMES.includes(value as AgentRunCredentialRuntime)
  ) {
    return value as AgentRunCredentialRuntime
  }
  throw new AgentRunCredentialError('A run credential is minted for "codex" or "claude".')
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getRunCredential(
  credentialId: string
): Promise<AgentRunCredentialRecord | null> {
  const normalized = typeof credentialId === 'string' ? credentialId.trim() : ''
  // A malformed id is "no such credential", never a key read: see the pattern's comment.
  if (!isWellFormedRunCredentialId(normalized)) return null
  const record = (await redis.json.get(
    agentRunCredentialKey(normalized)
  )) as AgentRunCredentialRecord | null
  return record && typeof record === 'object' ? record : null
}

/** Every live credential id this agent holds. Records that are gone are pruned from the index. */
export async function listAgentRunCredentialIds(agentId: string): Promise<string[]> {
  const indexKey = agentRunCredentialsIndexKey(agentId)
  const ids = await redis.execute(async (client) => {
    const members = await client.sMembers(indexKey)
    return Array.isArray(members) ? (members as string[]) : []
  })

  const live: string[] = []
  for (const id of ids) {
    const record = await getRunCredential(id)
    if (!record || record.agentId !== agentId) {
      // A credential the TTL reaped leaves its index member behind; prune on read so the
      // index cannot grow without bound across a long-lived agent's thousands of runs.
      await redis.execute(async (client) => client.sRem(indexKey, [id]))
      continue
    }
    live.push(id)
  }
  return live
}

/* ------------------------------------------------------------------ *
 * Mint
 * ------------------------------------------------------------------ */

/**
 * Mint one credential for one managed CLI run, and return the token ONCE.
 *
 * The token is `<credentialId>.<secret>`. Neither half contains a `.` (both are base64url
 * after a fixed ASCII prefix), so splitting on the first `.` is unambiguous. It is returned to
 * the bridge, which puts it straight into the child process environment — it is shown to
 * nobody, stored nowhere, and there is no rotate: a fresh run is a fresh credential (DL-117-01).
 *
 * The agent is checked here, one read, on purpose. The pair `(userId, agentId)` IS the
 * authorization this credential carries, so minting a credential whose two halves do not agree
 * would be an authorization hole created by a bug in the caller rather than by an attacker.
 * Failing the run start loudly is the correct outcome; a run with no credential must not start
 * and then silently fall back to naming itself.
 *
 * **`delegated: true` is the one case with no record to read** (F-P2-1, found live). A Subagent
 * or Worker run on a managed CLI lane is launched with a runtime id the server derived from the
 * subagent's slug — `subagent_cli_…` — and nothing is stored under `agent:{that id}`. The
 * credential is still minted, because that run's helper still needs to authenticate, and the
 * flag travels on the record so the acting-identity gate can refuse it. The check does NOT
 * disappear: if a record happens to exist at that id it must still belong to this user, which
 * closes the only way a delegated id could ever name a real agent.
 */
export async function mintRunCredential(options: {
  userId: string
  agentId: string
  sessionId: string
  messageId?: string | null
  runtime: unknown
  /** A Subagent or Worker run, whose `agentId` is a per-run runtime id (F-P2-1). */
  delegated?: boolean
}): Promise<{ credentialId: string; token: string; record: AgentRunCredentialRecord }> {
  const userId = requireIdentifier(options.userId, 'a user id')
  const agentId = requireIdentifier(options.agentId, 'an agent id')
  const sessionId = requireIdentifier(options.sessionId, 'a session id')
  const runtime = normalizeRuntime(options.runtime)
  const messageId =
    typeof options.messageId === 'string' && options.messageId.trim().length > 0
      ? options.messageId.trim()
      : null

  const delegated = options.delegated === true
  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  if ((!agent && !delegated) || (agent?.user_id && agent.user_id !== userId)) {
    throw new AgentRunCredentialError(
      `Agent "${agentId}" was not found for this user, so no run credential was minted.`,
      404
    )
  }

  const secret = generateCredentialSecret()
  const createdAt = Date.now()
  const record: AgentRunCredentialRecord = {
    id: generateCredentialId(),
    userId,
    agentId,
    sessionId,
    messageId,
    runtime,
    delegated,
    tokenHash: hashSecret(secret),
    tokenPrefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
    tokenSuffix: secret.slice(-TOKEN_SUFFIX_LENGTH),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + AGENT_RUN_CREDENTIAL_TTL_SECONDS * 1000).toISOString(),
    lastUsedAt: null,
    useCount: 0
  }

  await redis.json.set(agentRunCredentialKey(record.id), '$', record as never)
  await redis.expire(agentRunCredentialKey(record.id), AGENT_RUN_CREDENTIAL_TTL_SECONDS)
  await redis.execute(async (client) =>
    client.sAdd(agentRunCredentialsIndexKey(record.agentId), record.id)
  )

  return { credentialId: record.id, token: `${record.id}.${secret}`, record }
}

/* ------------------------------------------------------------------ *
 * Present and validate
 * ------------------------------------------------------------------ */

/**
 * Split a presented header into its two halves without touching Redis.
 *
 * Returns `null` for anything that is not `<well-formed arc_ id>.<non-empty secret>`, which is
 * the `malformed` refusal — reported the same as every other refusal.
 */
export function parseRunCredentialPresentation(
  presented: string | null | undefined
): { credentialId: string; secret: string } | null {
  const text = typeof presented === 'string' ? presented.trim() : ''
  if (!text) return null
  const separator = text.indexOf('.')
  if (separator <= 0 || separator >= text.length - 1) return null
  const credentialId = text.slice(0, separator)
  const secret = text.slice(separator + 1)
  if (!isWellFormedRunCredentialId(credentialId) || secret.length === 0) return null
  return { credentialId, secret }
}

/**
 * Validate a presented credential against ONE named record.
 *
 * **The same-403 rule (DL-117-02).** A missing header, a malformed one, an unknown id, a wrong
 * secret, and an expired record all answer with `valid: false` and a `reason` that exists for
 * the SERVER LOG. The caller must turn every one of them into the identical refusal: a caller
 * must not be able to tell "no such credential" from "wrong secret", which is what stops the
 * header being an oracle for probing which runs are live. `wakeHookStore.ts` states the same
 * rule for the same reason.
 *
 * Expiry is checked on the FIELD, not only by trusting the key's absence — see
 * `AGENT_RUN_CREDENTIAL_TTL_SECONDS`.
 */
export async function validateRunCredential(
  presented: string | null | undefined
): Promise<AgentRunCredentialValidation> {
  const text = typeof presented === 'string' ? presented.trim() : ''
  if (!text) return { valid: false, reason: 'missing' }

  const parts = parseRunCredentialPresentation(text)
  if (!parts) return { valid: false, reason: 'malformed' }

  const record = await getRunCredential(parts.credentialId)
  if (!record) return { valid: false, reason: 'invalid' }
  if (!hashesMatch(record.tokenHash, hashSecret(parts.secret))) {
    return { valid: false, reason: 'invalid' }
  }
  if (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) {
    return { valid: false, reason: 'expired' }
  }
  return { valid: true, record }
}

/**
 * Bump the usage counters after a call the resolver accepted. Never fails the call.
 *
 * **Path-scoped on purpose.** `wakeHookStore.ts`'s F-P3-2 is the whole reason this is two field
 * writes rather than a read-modify-write: `json.set(key, '$', record)` CREATES a missing key, so
 * a revoke landing between the read and the write brought the credential back with its original
 * `tokenHash` — a live credential for a run that had already ended, with no index member left
 * for the sweep to find. A path write cannot create the root, so a revoked credential is a
 * no-op here instead of a resurrection.
 */
export async function recordRunCredentialUse(credentialId: string): Promise<void> {
  if (!isWellFormedRunCredentialId(credentialId)) return
  try {
    const key = agentRunCredentialKey(credentialId)
    await redis.json.set(key, '$.lastUsedAt', nowIso() as never)
    await redis.json.numIncrBy(key, '$.useCount', 1)
  } catch {
    // A credential revoked between the accepted call and this bump is the expected case — a
    // Stop at exactly the wrong moment — and the call it is recording already succeeded.
  }
}

/* ------------------------------------------------------------------ *
 * Revoke
 * ------------------------------------------------------------------ */

/**
 * Revoke one credential for good, at run end.
 *
 * The record is DELETED rather than tombstoned, for the reason `wakeHookStore.ts` gives: the
 * named record is the only thing `validateRunCredential` reads, so leaving a revoked record
 * behind would add one more state that has to be checked correctly on every single call.
 * `invalid` already covers a missing record, a wrong secret, and a revoked credential alike.
 *
 * Idempotent: revoking twice is a no-op, and bridges call this from a `finally`, so it must
 * not throw on a run that already cleaned up.
 *
 * A record the TTL already reaped (an app that crashed mid-run) cannot say which agent's index
 * it sat in, so the caller that knows — the bridge, which minted it for one agent — passes
 * `agentId` and the member is pruned here too (SA-117 P1 review, F-P1-5). Without the hint the
 * member waits for `listAgentRunCredentialIds` or the agent sweep to prune it on read.
 */
export async function revokeRunCredential(
  credentialId: string,
  options: { agentId?: string | null } = {}
): Promise<boolean> {
  if (!isWellFormedRunCredentialId(credentialId)) return false
  const record = await getRunCredential(credentialId)
  await redis.del(agentRunCredentialKey(credentialId))
  const hintedAgentId =
    typeof options.agentId === 'string' && options.agentId.trim() ? options.agentId.trim() : null
  const indexAgentId = record?.agentId ?? hintedAgentId
  if (indexAgentId) {
    await redis.execute(async (client) =>
      client.sRem(agentRunCredentialsIndexKey(indexAgentId), [credentialId])
    )
  }
  return Boolean(record)
}

/* ------------------------------------------------------------------ *
 * Agent deletion (DL-117-09)
 * ------------------------------------------------------------------ */

/**
 * Delete every run credential naming a deleted agent.
 *
 * A credential whose agent is gone is a live credential that authenticates as nobody, so it
 * goes with the agent — the same reason its inbox, its hooks, and its schedules do. Credentials
 * belonging to OTHER agents of the same user are untouched.
 *
 * Unlike the hook and schedule sweeps this does NOT read `agent.user_id`: the index is already
 * agent-scoped. It still runs BEFORE the agent record is deleted in `redis.deleteAgent`, beside
 * the three sweeps that do need the record, so the destructive order stays one rule rather
 * than two.
 */
export async function sweepAgentRunCredentials(agentId: string): Promise<number> {
  const normalized = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalized) return 0

  const indexKey = agentRunCredentialsIndexKey(normalized)
  const ids = await redis.execute(async (client) => {
    const members = await client.sMembers(indexKey)
    return Array.isArray(members) ? (members as string[]) : []
  })

  let deleted = 0
  for (const id of ids) {
    const record = await getRunCredential(id)
    await redis.del(agentRunCredentialKey(id))
    await redis.execute(async (client) => client.sRem(indexKey, [id]))
    if (record) deleted += 1
  }
  await redis.del(indexKey)
  return deleted
}
