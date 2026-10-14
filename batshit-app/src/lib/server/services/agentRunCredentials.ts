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

// Vite may reload this module while the app process stays alive. A global value keeps runs
// minted before that reload usable; a new app process gets a fresh random value. Redis records
// deliberately do not carry enough authority to survive that process ending.
const SERVER_INSTANCE_ID_KEY = Symbol.for('batshit.agentRunCredentials.serverInstanceId')
const processGlobals = globalThis as unknown as Record<symbol, unknown>
const serverInstanceId = typeof processGlobals[SERVER_INSTANCE_ID_KEY] === 'string'
  ? processGlobals[SERVER_INSTANCE_ID_KEY] as string
  : (processGlobals[SERVER_INSTANCE_ID_KEY] = randomBytes(32).toString('base64url')) as string

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
export type AgentRunProcessOwner = { userId: string; kind: 'agent' | 'subagent'; id: string }

export type AgentRunCredentialRecord = {
  id: string
  /** Random app-process identity; absent on old records, which cannot authenticate. */
  serverInstanceId: string
  userId: string
  agentId: string
  sessionId: string
  /** Physical commands belong to this stored owner, never a delegated virtual runtime id. */
  processOwner?: AgentRunProcessOwner | null
  /** Stored primary agent governing Native Bash; a Worker names its owning agent. */
  commandParentAgentId?: string | null
  /** Delegated run's own Bash toggle snapshot; absent grants no Bash. */
  delegatedBashEnabled?: boolean | null
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
  /**
   * BL-75 — whose skill access governs this run's `native_skill` loads.
   *
   * Set on a DELEGATED run only: the Subagent's record id, a `base` Worker's base id, or a
   * built-in Worker's `worker_…` id — the id the run's `skills_commands` list was built for.
   * `agentId` cannot do this job there, because it is the `subagent_cli_…` runtime id, which
   * no access list names. A primary run leaves it `null`, and its own `agentId` governs. A
   * record written before BL-75 has no field, which reads as `null`: a delegated one then has
   * no skill access at all, and it expires with its run anyway.
   */
  scopeAgentId?: string | null
  /**
   * BL-81 — what a DELEGATED run may use through the control routes: the control ids its DCM
   * index offered it (`resolveDelegatedRunAllowedControlIds`), computed by the runner from the
   * scope that index was built from. Server-vouched the way a Portable Skill Token's allowed
   * controls are: `/api/controls/use` refuses every other control for this credential, and
   * `/api/controls/find` lists nothing else. `null` on a primary run, whose own settings govern
   * as before. A delegated record written before BL-81 has no field and is allowed nothing
   * (`readDelegatedAllowedControlIds`); it expires with its run anyway.
   */
  allowedControlIds?: string[] | null
  /** BL-638: the server-resolved MCP gateways selected for this turn, including `[]`. */
  mcpGatewayScope?: string[] | null
  /**
   * BL-686: the saved CLI tools this run may reach, resolved when the run starts (the agent's
   * saved list, a Subagent's own list, or the user's Tool Grid list), including `[]`.
   */
  cliToolScope?: string[] | null
  /** BL-494 P2: the managed helper profile actually offered Fetch Zip for this run. */
  fetchZipAllowed?: boolean
  /** User setting read from this run's managed profile; null uses conservative paging. */
  codexToolOutputTokenLimit?: number | null
  /**
   * sha256 hex of the secret half. **No fragment of the secret itself is stored.**
   *
   * This record used to carry `tokenPrefix` (12 chars) and `tokenSuffix` (6), copied from
   * `wakeHookStore.ts` — where they earn their place, because that store HAS a settings
   * surface that shows the user which token a row is. A run credential is shown to nobody
   * (DL-117-02) and nothing ever read the fields, so all they did was put 13 of the
   * secret's 43 random characters in plaintext beside its hash for the life of the run
   * (PR #106 review F-19). A record written before SA-118 still parses; the extra keys are
   * ignored.
   */
  tokenHash: string
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
      // `mintRunCredential` is what calls this in production (PR #106 review F-19), so the
      // prune happens once per run rather than never.
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
 * BL-75 — check the skill scope a mint names, the way the agent itself is checked: a caller
 * bug here would hand a run another subagent's skills, so it fails the run start loudly.
 *
 * A delegated run must name one, and it must be this user's subagent record, or a built-in
 * Worker's `worker_…` id (which is never stored, and which no access list names except
 * through Enable For All Agents). A primary run names none, or its own agent.
 */
async function resolveCredentialScopeAgentId(options: {
  userId: string
  agentId: string
  delegated: boolean
  scopeAgentId: unknown
}): Promise<string | null> {
  const scope = typeof options.scopeAgentId === 'string' ? options.scopeAgentId.trim() : ''
  if (!options.delegated) {
    if (scope && scope !== options.agentId) {
      throw new AgentRunCredentialError(
        `A primary run of "${options.agentId}" cannot carry the skill scope of "${scope}", so no run credential was minted.`
      )
    }
    return null
  }
  if (!scope) {
    throw new AgentRunCredentialError(
      'A Subagent or Worker run needs the id whose skills it may load, so no run credential was minted.'
    )
  }
  const subagent = (await redis.get(`subagent:${scope}`)) as Record<string, any> | null
  // The same owner rule as the agent check above: a record that names another user is refused.
  if (subagent ? Boolean(subagent.user_id && subagent.user_id !== options.userId) : !scope.startsWith('worker_')) {
    throw new AgentRunCredentialError(
      `Subagent "${scope}" was not found for this user, so no run credential was minted.`,
      404
    )
  }
  return scope
}

/**
 * BL-81 — check the control scope a mint names, the way the skill scope is checked: a caller
 * that forgets it would start a run that can use nothing it was offered, so it fails the run
 * start loudly instead. A delegated run must name a list (an empty one is a real answer:
 * nothing); a primary run names none, because its own settings govern it as they always have.
 */
function resolveCredentialAllowedControlIds(options: {
  agentId: string
  delegated: boolean
  allowedControlIds: unknown
}): string[] | null {
  const list = options.allowedControlIds
  if (!options.delegated) {
    if (list !== undefined && list !== null) {
      throw new AgentRunCredentialError(
        `A primary run of "${options.agentId}" carries no delegated control scope, so no run credential was minted.`
      )
    }
    return null
  }
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
    throw new AgentRunCredentialError(
      'A Subagent or Worker run needs the control ids its instructions offer it, so no run credential was minted.'
    )
  }
  return Array.from(new Set(list.map((entry) => entry.trim()).filter((entry) => entry.length > 0)))
}

/**
 * BL-81 — what a validated credential lets a DELEGATED run use through the control routes.
 *
 * `null` for a primary run: it has no delegated scope, and its own settings govern. For a
 * delegated run, the list it was minted with, or `[]` when the record predates BL-81 (or its
 * field is anything but a list of strings): a delegated call with no list is allowed nothing.
 */
export function readDelegatedAllowedControlIds(
  record: Pick<AgentRunCredentialRecord, 'delegated' | 'allowedControlIds'>
): string[] | null {
  if (record.delegated !== true) return null
  const list = record.allowedControlIds
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

/** Old or malformed credentials cannot name any MCP gateway. Always return a fresh list. */
export function readRunCredentialMcpGatewayScope(
  record: Pick<AgentRunCredentialRecord, 'mcpGatewayScope'>
): string[] {
  const scope = record.mcpGatewayScope
  if (!Array.isArray(scope) || scope.some((entry) => typeof entry !== 'string')) return []
  return Array.from(new Set(scope.map((entry) => entry.trim()).filter(Boolean)))
}

/** BL-686: old or malformed credentials cannot name any saved CLI tool. A fresh list. */
export function readRunCredentialCliToolScope(
  record: Pick<AgentRunCredentialRecord, 'cliToolScope'>
): string[] {
  const scope = record.cliToolScope
  if (!Array.isArray(scope) || scope.some((entry) => typeof entry !== 'string')) return []
  return Array.from(new Set(scope.map((entry) => entry.trim()).filter(Boolean)))
}

/** A legacy or malformed record grants no physical command owner. */
export function readRunCredentialProcessOwner(
  record: Pick<AgentRunCredentialRecord, 'userId' | 'agentId' | 'delegated' | 'processOwner'>
): AgentRunProcessOwner | null {
  const owner = record.processOwner
  if (!owner || owner.userId !== record.userId ||
    (owner.kind !== 'agent' && owner.kind !== 'subagent') ||
    typeof owner.id !== 'string' || !owner.id.trim()) return null
  if (!record.delegated && (owner.kind !== 'agent' || owner.id !== record.agentId)) return null
  return { userId: owner.userId, kind: owner.kind, id: owner.id }
}

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
 * disappear; for a delegated mint it is stricter: the per-run id must name NO stored agent at
 * all, this user's own included (BL-81 follow-up). A record at that id would be the agent the
 * dispatch path loads for the run (`context.agent_id` is bound to the credential's `agentId`,
 * then read as `agent:{id}`), handing a Subagent or Worker that agent's settings and
 * permissions. Refusing the mint is the only place that closes it before the run starts.
 */
export async function mintRunCredential(options: {
  userId: string
  agentId: string
  sessionId: string
  messageId?: string | null
  runtime: unknown
  /** A Subagent or Worker run, whose `agentId` is a per-run runtime id (F-P2-1). */
  delegated?: boolean
  /** Server-vouched physical owner of a delegated run; a Worker names its parent agent. */
  processOwner?: AgentRunProcessOwner | null
  /** Primary agent that governs Native Bash for this run. */
  commandParentAgentId?: string | null
  delegatedBashEnabled?: boolean | null
  /**
   * BL-75 — the Subagent or Worker whose skill access governs a delegated run. Required when
   * `delegated`, and it must be this user's subagent or a built-in Worker's `worker_…` id. A
   * primary run may omit it or repeat its own `agentId`; anything else is refused.
   */
  scopeAgentId?: string | null
  /**
   * BL-81 — the control ids a delegated run's DCM index offered it. Required when `delegated`
   * (an empty list is a real answer: nothing); refused on a primary run.
   */
  allowedControlIds?: string[] | null
  /** Server-resolved gateway selection for this run; absent means no gateways. */
  mcpGatewayScope?: string[] | null
  /** BL-686: server-resolved saved CLI tools for this run; absent means none. */
  cliToolScope?: string[] | null
  /** Snapshot of the server-resolved helper profile. Missing/old credentials mean false. */
  fetchZipAllowed?: boolean
  /** User setting read from this run's managed profile; null uses conservative paging. */
  codexToolOutputTokenLimit?: number | null
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
  if (delegated && agent) {
    throw new AgentRunCredentialError(
      `A Subagent or Worker run's id "${agentId}" names a stored agent, so no run credential was ` +
        'minted: a delegated run must never borrow an agent\'s record. Rename that agent or the ' +
        'Subagent, then run it again.',
      409
    )
  }
  if ((!agent && !delegated) || (agent?.user_id && agent.user_id !== userId)) {
    throw new AgentRunCredentialError(
      `Agent "${agentId}" was not found for this user, so no run credential was minted.`,
      404
    )
  }
  let processOwner: AgentRunProcessOwner | null
  let commandParentAgentId: string | null
  if (!delegated) {
    processOwner = { userId, kind: 'agent', id: agentId }
    commandParentAgentId = agentId
    if (options.processOwner && (options.processOwner.userId !== userId ||
      options.processOwner.kind !== 'agent' || options.processOwner.id !== agentId)) {
      throw new AgentRunCredentialError('A primary run cannot borrow another command owner.')
    }
    if (options.commandParentAgentId != null && options.commandParentAgentId !== agentId) {
      throw new AgentRunCredentialError('A primary run cannot borrow another command parent.')
    }
  } else if (options.processOwner == null) {
    // Older/auth-only delegated credentials have no physical command authority. Both command
    // routes refuse them, while their existing non-command helper scope stays intact.
    processOwner = null
    if (options.commandParentAgentId != null) {
      throw new AgentRunCredentialError('A delegated run without an owner cannot name a command parent.')
    }
    commandParentAgentId = null
  } else {
    const owner = options.processOwner
    if (owner.userId !== userId || !['agent', 'subagent'].includes(owner.kind) ||
      typeof owner.id !== 'string' || !owner.id.trim()) {
      throw new AgentRunCredentialError('A delegated run needs a valid server-owned command owner.')
    }
    const stored = (await redis.get(`${owner.kind}:${owner.id}`)) as { user_id?: string } | null
    if (!stored || stored.user_id !== userId) {
      throw new AgentRunCredentialError('The delegated command owner was deleted or belongs to another user.')
    }
    processOwner = { userId, kind: owner.kind, id: owner.id }
    if (options.commandParentAgentId == null) {
      // Auth-only fixture credentials may have an owner but cannot enter Native Bash.
      commandParentAgentId = null
    } else {
      const parentId = requireIdentifier(options.commandParentAgentId, 'a command parent agent id')
      if (owner.kind === 'agent' && owner.id !== parentId) {
        throw new AgentRunCredentialError('A Worker command owner must be its parent agent.')
      }
      const parent = (await redis.get(`agent:${parentId}`)) as { user_id?: string } | null
      if (!parent || parent.user_id !== userId) {
        throw new AgentRunCredentialError('The delegated command parent was deleted or belongs to another user.')
      }
      commandParentAgentId = parentId
    }
  }
  const scopeAgentId = await resolveCredentialScopeAgentId({
    userId,
    agentId,
    delegated,
    scopeAgentId: options.scopeAgentId
  })
  const allowedControlIds = resolveCredentialAllowedControlIds({
    agentId,
    delegated,
    allowedControlIds: options.allowedControlIds
  })
  const mcpGatewayScope = readRunCredentialMcpGatewayScope({
    mcpGatewayScope: options.mcpGatewayScope
  })
  const cliToolScope = readRunCredentialCliToolScope({ cliToolScope: options.cliToolScope })
  const fetchZipAllowed = options.fetchZipAllowed === true
  if (delegated && fetchZipAllowed) {
    throw new AgentRunCredentialError(
      'A managed CLI Subagent or Worker cannot be granted Fetch Zip.'
    )
  }

  const codexToolOutputTokenLimit = options.codexToolOutputTokenLimit ?? null
  if (codexToolOutputTokenLimit !== null && (runtime !== 'codex' ||
    !Number.isSafeInteger(codexToolOutputTokenLimit) || codexToolOutputTokenLimit < 0)) {
    throw new AgentRunCredentialError('The Codex tool output limit must be a non-negative integer from the managed profile.')
  }

  const secret = generateCredentialSecret()
  const createdAt = Date.now()
  const record: AgentRunCredentialRecord = {
    id: generateCredentialId(),
    serverInstanceId,
    userId,
    agentId,
    sessionId,
    processOwner,
    commandParentAgentId,
    delegatedBashEnabled: delegated ? options.delegatedBashEnabled === true : null,
    messageId,
    runtime,
    delegated,
    scopeAgentId,
    allowedControlIds,
    mcpGatewayScope,
    cliToolScope,
    fetchZipAllowed,
    codexToolOutputTokenLimit,
    tokenHash: hashSecret(secret),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + AGENT_RUN_CREDENTIAL_TTL_SECONDS * 1000).toISOString(),
    lastUsedAt: null,
    useCount: 0
  }

  await redis.json.set(agentRunCredentialKey(record.id), '$', record as never)
  await redis.expire(agentRunCredentialKey(record.id), AGENT_RUN_CREDENTIAL_TTL_SECONDS)
  // PR #106 review F-19 — prune BEFORE adding this run's member, so the claim that the
  // index is pruned on read is true of something that actually runs. `revokeRunCredential`
  // removes the member at a clean run end, but a crash-then-restart never reaches that
  // `finally`, and until SA-118 `listAgentRunCredentialIds` had no production caller at all
  // — so one dead member per orphaned run stayed until the whole agent was deleted. The
  // index is per agent and holds live runs only, so this is a few reads, once per run.
  await listAgentRunCredentialIds(record.agentId)
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
  // A bridge that outlived an app restart can still hold the right secret while its Redis
  // record remains. Missing (legacy) and prior-process identities both fail closed here.
  if (record.serverInstanceId !== serverInstanceId) {
    return { valid: false, reason: 'invalid' }
  }
  if (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) {
    return { valid: false, reason: 'expired' }
  }
  // A delegated runtime id has no stored agent record. Its helper credential must still die
  // when the actual Subagent (or a Worker's parent agent) is deleted, even if the bridge
  // crashed before revocation. Primary runs also recheck their stored agent here.
  const owner = readRunCredentialProcessOwner(record)
  if (!owner) {
    // Old/auth-only delegated records can still authenticate non-command helpers. Both
    // command routes refuse them. A present but malformed owner grants no authority at all.
    if (record.delegated !== true || record.processOwner != null) {
      return { valid: false, reason: 'invalid' }
    }
  } else {
    const storedOwner = (await redis.get(`${owner.kind}:${owner.id}`)) as { user_id?: string } | null
    if (!storedOwner || storedOwner.user_id !== record.userId) {
      return { valid: false, reason: 'invalid' }
    }
  }
  const parentId = record.commandParentAgentId
  if (!record.delegated && parentId !== record.agentId) return { valid: false, reason: 'invalid' }
  if (record.delegated && parentId != null &&
    (typeof parentId !== 'string' || !parentId.trim() || !owner ||
      (owner.kind === 'agent' && owner.id !== parentId))) {
    return { valid: false, reason: 'invalid' }
  }
  if (typeof parentId === 'string') {
    const parent = (await redis.get(`agent:${parentId}`)) as { user_id?: string } | null
    if (!parent || parent.user_id !== record.userId) return { valid: false, reason: 'invalid' }
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
 * member waits for the NEXT MINT for that agent (which calls `listAgentRunCredentialIds`) or
 * for the agent sweep. Those two are the prunes; there is no third.
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
