import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  AGENT_RUN_CREDENTIAL_TTL_SECONDS,
  AgentRunCredentialError,
  agentRunCredentialKey,
  agentRunCredentialsIndexKey,
  getRunCredential,
  isWellFormedRunCredentialId,
  listAgentRunCredentialIds,
  mintRunCredential,
  parseRunCredentialPresentation,
  recordRunCredentialUse,
  revokeRunCredential,
  sweepAgentRunCredentials,
  validateRunCredential
} from '../agentRunCredentials'

/**
 * SA-117 P1 (DL-117-02) — the run credential store.
 *
 * Every rule here is a security rule: the secret is never stored, an id alone is not a
 * credential, one run's secret cannot be replayed against another run, a revoked or expired
 * credential stops working at once and cannot be brought back by a counter bump, and a
 * credential cannot outlive the agent it names.
 *
 * Runs on BOTH lanes. `npm test` exercises the in-memory RedisJSON fake; `npm run test:redis`
 * (this file is in the curated CI list) exercises real Redis 8 on DB15. The fake has lied about
 * RedisJSON path semantics before — the deep dive §14.1 lists four — and the path-scoped
 * counter rules below are exactly the kind it lies about, so both lanes are the requirement,
 * not a nicety.
 */

useRedisTestServer()

const USER = 'user-credentials'
const OTHER_USER = 'user-other'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'

async function seedAgent(id: string, userId = USER) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: id.replace('agent-', '').replace(/^./, (c) => c.toUpperCase()),
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5'
  } as any)
}

async function mint(overrides: Record<string, unknown> = {}) {
  return await mintRunCredential({
    userId: USER,
    agentId: COOPER,
    sessionId: 'sess-1',
    runtime: 'codex',
    ...overrides
  } as any)
}

async function indexMembers(agentId: string): Promise<string[]> {
  const members = await redis.execute(async (client) =>
    client.sMembers(agentRunCredentialsIndexKey(agentId))
  )
  return (Array.isArray(members) ? (members as string[]) : []).sort()
}

beforeEach(async () => {
  await seedAgent(COOPER)
  await seedAgent(FAYE)
})

describe('minting a run credential', () => {
  it('returns the token ONCE and stores only its fingerprint', async () => {
    const { credentialId, token, record } = await mint({ messageId: 'msg-7' })

    expect(isWellFormedRunCredentialId(credentialId)).toBe(true)
    expect(token).toBe(`${credentialId}.${token.slice(credentialId.length + 1)}`)

    const [presentedId, secret] = [token.slice(0, token.indexOf('.')), token.slice(token.indexOf('.') + 1)]
    expect(presentedId).toBe(credentialId)
    expect(secret.startsWith('bsac_')).toBe(true)

    const stored = await getRunCredential(credentialId)
    expect(stored).not.toBeNull()
    // The secret half appears nowhere in the record — not whole, and not in the hash.
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(stored?.tokenHash).toBeTruthy()
    expect(stored?.tokenHash).not.toBe(secret)
    // PR #106 review F-19: NO fragment of the secret either. This record used to carry a
    // 12-character prefix and a 6-character suffix copied from the wake-hook store — 13 of
    // the secret's 43 random characters in plaintext beside its hash, for a record no UI
    // ever shows and no code ever read.
    expect(stored).not.toHaveProperty('tokenPrefix')
    expect(stored).not.toHaveProperty('tokenSuffix')
    expect(JSON.stringify(stored)).not.toContain(secret.slice(0, 12))
    expect(JSON.stringify(stored)).not.toContain(secret.slice(-6))

    expect(stored).toMatchObject({
      userId: USER,
      agentId: COOPER,
      sessionId: 'sess-1',
      messageId: 'msg-7',
      runtime: 'codex',
      lastUsedAt: null,
      useCount: 0
    })
    // The record the minter hands back is the same one on disk, secret excluded.
    expect(record.id).toBe(credentialId)
  })

  it('indexes the credential under the agent and sets the 24-hour backstop', async () => {
    const { credentialId } = await mint()

    expect(await indexMembers(COOPER)).toEqual([credentialId])

    const ttl = await redis.ttl(agentRunCredentialKey(credentialId))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(AGENT_RUN_CREDENTIAL_TTL_SECONDS)
  })

  it('refuses a missing agent, another user’s agent, and a runtime that is not a CLI lane', async () => {
    await expect(mint({ agentId: 'agent-missing' })).rejects.toThrow(/was not found/i)

    await seedAgent('agent-theirs', OTHER_USER)
    await expect(mint({ agentId: 'agent-theirs' })).rejects.toThrow(/was not found/i)

    await expect(mint({ runtime: 'api' })).rejects.toThrow(/"codex" or "claude"/i)
    await expect(mint({ runtime: undefined })).rejects.toThrow(AgentRunCredentialError)
  })

  it('refuses an empty user, agent, or session rather than minting an unbound credential', async () => {
    await expect(mint({ userId: '   ' })).rejects.toThrow(/needs a user id/i)
    await expect(mint({ agentId: '' })).rejects.toThrow(/needs an agent id/i)
    await expect(mint({ sessionId: null })).rejects.toThrow(/needs a session id/i)
  })
})

describe('reading a presentation', () => {
  it('splits the two halves and refuses every shape that is not one', () => {
    expect(parseRunCredentialPresentation('arc_abc.bsac_secret')).toEqual({
      credentialId: 'arc_abc',
      secret: 'bsac_secret'
    })

    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'arc_abc',
      'arc_abc.',
      '.bsac_secret',
      'bsac_secret',
      // A well-formed secret behind an id that is not `arc_`-shaped: refused before any read.
      'whk_abc.bsac_secret',
      'arc_.bsac_secret',
      `arc_${'x'.repeat(65)}.bsac_secret`
    ]) {
      expect(parseRunCredentialPresentation(bad as any)).toBeNull()
    }
  })
})

describe('validating a call', () => {
  it('accepts the credential it minted and reports the bound identity', async () => {
    const { credentialId, token } = await mint()

    const result = await validateRunCredential(token)
    expect(result.valid).toBe(true)
    expect(result.valid && result.record).toMatchObject({
      id: credentialId,
      userId: USER,
      agentId: COOPER,
      sessionId: 'sess-1'
    })
  })

  it('refuses a missing, malformed, unknown, or wrong-secret presentation', async () => {
    const { credentialId, token } = await mint()
    const secret = token.slice(token.indexOf('.') + 1)

    expect(await validateRunCredential(null)).toMatchObject({ reason: 'missing' })
    expect(await validateRunCredential('   ')).toMatchObject({ reason: 'missing' })
    expect(await validateRunCredential('nonsense')).toMatchObject({ reason: 'malformed' })
    expect(await validateRunCredential(`${credentialId}.`)).toMatchObject({ reason: 'malformed' })
    expect(await validateRunCredential(`arc_unknown.${secret}`)).toMatchObject({
      reason: 'invalid'
    })
    expect(await validateRunCredential(`${credentialId}.bsac_wrong`)).toMatchObject({
      reason: 'invalid'
    })
  })

  it('refuses one run’s secret presented at another run’s id', async () => {
    const first = await mint()
    const second = await mint({ agentId: FAYE, sessionId: 'sess-2' })
    const firstSecret = first.token.slice(first.token.indexOf('.') + 1)

    // The secret is bound to the id it was minted with, so a secret scraped out of one run's
    // child environment cannot be replayed against a different run to reach a different agent.
    expect(await validateRunCredential(`${second.credentialId}.${firstSecret}`)).toMatchObject({
      reason: 'invalid'
    })
  })

  it('refuses an expired record even while the key still exists', async () => {
    const { credentialId, token } = await mint()

    // The 24-hour EXPIRE is the backstop, not the check. A key the expiry cycle has not reaped
    // yet — or one written back by a restore — must still be refused on the FIELD.
    await redis.json.set(
      agentRunCredentialKey(credentialId),
      '$.expiresAt',
      new Date(Date.now() - 1000).toISOString() as never
    )

    expect(await redis.exists(agentRunCredentialKey(credentialId))).toBeTruthy()
    expect(await validateRunCredential(token)).toMatchObject({ reason: 'expired' })
  })

  it('refuses a revoked credential re-presented, and says nothing about why', async () => {
    const { credentialId, token } = await mint()
    expect(await validateRunCredential(token)).toMatchObject({ valid: true })

    await revokeRunCredential(credentialId)

    const afterRevoke = await validateRunCredential(token)
    expect(afterRevoke).toMatchObject({ valid: false, reason: 'invalid' })
    // DL-117-02's same-403 rule, at the store's own level: a revoked credential and an id that
    // never existed answer identically, so the header cannot be used to probe live runs.
    expect(afterRevoke).toEqual(await validateRunCredential(`arc_neverexisted.${token}`))
    expect(await getRunCredential(credentialId)).toBeNull()
    expect(await indexMembers(COOPER)).toEqual([])
  })
})

describe('the id guard', () => {
  it('treats a collision-shaped id as no such credential, without a key read', async () => {
    await mint()

    // `agent_run_credential:` + `s:{agentId}` is NOT `agent_run_credentials:{agentId}` — the
    // prefixes differ at the character after `credential` — so this is hygiene rather than a
    // collision fix. What it buys is that an attacker-controlled header value never becomes a
    // key name or a log line, and a junk id is a clean miss instead of a WRONGTYPE error
    // escaping the auth resolver as a 500 and breaking "every failure the same refusal".
    // The fake's `redis.json.get` is itself a `vi.fn`, so the spy inherits every read this
    // file has already made. Clear it, or "no key read" is measured against the whole suite.
    const getSpy = vi.spyOn(redis.json, 'get')
    getSpy.mockClear()
    try {
      await expect(getRunCredential(`s:${COOPER}`)).resolves.toBeNull()
      await expect(getRunCredential(agentRunCredentialsIndexKey(COOPER))).resolves.toBeNull()
      await expect(getRunCredential('arc_bad!chars')).resolves.toBeNull()
      await expect(
        validateRunCredential(`s:${COOPER}.bsac_anything`)
      ).resolves.toMatchObject({ valid: false })
      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it('never turns a malformed id into a write either', async () => {
    const setSpy = vi.spyOn(redis.json, 'set')
    setSpy.mockClear()
    try {
      await recordRunCredentialUse(`s:${COOPER}`)
      await recordRunCredentialUse('not-an-id')
      expect(setSpy).not.toHaveBeenCalled()
    } finally {
      setSpy.mockRestore()
    }
    expect(await revokeRunCredential('not-an-id')).toBe(false)
  })
})

describe('recording a use', () => {
  it('bumps the counters with path-scoped writes, never the whole record', async () => {
    const { credentialId, token } = await mint()

    // `redis.json.set` is already a `vi.fn` in the Redis fake, so a spy inherits the calls the
    // mint just made. Clear first, or the create's own `$` write fails the very assertion this
    // test exists for.
    const setSpy = vi.spyOn(redis.json, 'set')
    const incrSpy = vi.spyOn(redis.json, 'numIncrBy')
    setSpy.mockClear()
    incrSpy.mockClear()
    try {
      await recordRunCredentialUse(credentialId)

      for (const call of setSpy.mock.calls) {
        expect(call[1]).not.toBe('$')
      }
      expect(setSpy).toHaveBeenCalledWith(
        agentRunCredentialKey(credentialId),
        '$.lastUsedAt',
        expect.any(String)
      )
      expect(incrSpy).toHaveBeenCalledWith(
        agentRunCredentialKey(credentialId),
        '$.useCount',
        1
      )
    } finally {
      setSpy.mockRestore()
      incrSpy.mockRestore()
    }

    const after = await getRunCredential(credentialId)
    expect(after?.useCount).toBe(1)
    expect(after?.lastUsedAt).toBeTruthy()
    // Everything the bump did not own survived — the credential above all.
    expect(after?.agentId).toBe(COOPER)
    expect(await validateRunCredential(token)).toMatchObject({ valid: true })
  })

  /**
   * The window is real. `resolveNativeToolUser` validates and then bumps, and the call it
   * authorized can run for a long time; a Stop that revokes the credential lands inside that
   * gap. A read-modify-write would have been holding the pre-revoke snapshot.
   */
  it('cannot resurrect a credential revoked inside its own window (a path write after a delete)', async () => {
    const { credentialId, token } = await mint()

    const stale = await getRunCredential(credentialId)
    await revokeRunCredential(credentialId)

    // On the fake lane `redis.json.get` is already a `vi.fn`, so spying on it REPLACES its
    // implementation and a `bind()` taken beforehand is the spy itself — the first read of
    // any other key would recurse until the stack overflowed (SA-114 P4 review). Dormant
    // today because the recorder reads nothing, so read the original off the mock first.
    const currentGet = redis.json.get as any
    const originalGet: (key: string, path?: string) => Promise<any> =
      typeof currentGet.getMockImplementation === 'function' &&
      currentGet.getMockImplementation()
        ? currentGet.getMockImplementation()
        : currentGet.bind(redis.json)
    const getSpy = vi
      .spyOn(redis.json, 'get')
      .mockImplementation(async (key: string, path?: string) =>
        key === agentRunCredentialKey(credentialId)
          ? JSON.parse(JSON.stringify(stale))
          : originalGet(key, path)
      )
    try {
      await recordRunCredentialUse(credentialId)
    } finally {
      getSpy.mockRestore()
    }

    expect(await getRunCredential(credentialId)).toBeNull()
    expect(await validateRunCredential(token)).toMatchObject({ valid: false })
    expect(await indexMembers(COOPER)).toEqual([])
  })
})

describe('revoking at run end', () => {
  it('is idempotent, and without an agent hint leaves a reaped member for the read-side prune', async () => {
    const { credentialId } = await mint()

    expect(await revokeRunCredential(credentialId)).toBe(true)
    // A bridge revokes from a `finally`, which can run twice on an abort-then-timeout path.
    expect(await revokeRunCredential(credentialId)).toBe(false)

    const reaped = await mint()
    await redis.del(agentRunCredentialKey(reaped.credentialId))
    expect(await revokeRunCredential(reaped.credentialId)).toBe(false)
    // The record is gone, so an id alone cannot say which index it sat in; the read-side
    // prune (and the agent sweep) still clean it.
    expect(await listAgentRunCredentialIds(COOPER)).toEqual([])
    expect(await indexMembers(COOPER)).toEqual([])
  })

  /**
   * PR #106 review F-19 — the prune-on-read has a production caller now.
   *
   * `listAgentRunCredentialIds` prunes, and two comments named it as what keeps the index
   * bounded — but nothing outside its own test ever called it. `revokeRunCredential`
   * removes the member at a clean run end; a crash-then-restart never reaches that
   * `finally`, so one dead member per orphaned run stayed until the whole agent was
   * deleted. The mint is the honest place to pay for it: once per run, on an index that
   * holds live runs only.
   */
  it('prunes dead members on the next mint, so a crashed run does not leak one forever', async () => {
    const orphan = await mint({ sessionId: 'sess-crashed' })
    // The app died mid-run: no `finally`, no revoke. Twenty-four hours later the TTL reaps
    // the record and leaves its index member behind.
    await redis.del(agentRunCredentialKey(orphan.credentialId))
    expect(await indexMembers(COOPER)).toEqual([orphan.credentialId])

    const next = await mint({ sessionId: 'sess-after-restart' })

    expect(await indexMembers(COOPER)).toEqual([next.credentialId])
  })

  it('leaves another agent’s index alone when it prunes', async () => {
    const faye = await mint({ agentId: FAYE, sessionId: 'sess-faye' })
    await mint({ sessionId: 'sess-cooper' })
    // The index is per agent, so a mint for Cooper must not walk Faye's.
    expect(await indexMembers(FAYE)).toEqual([faye.credentialId])
  })

  it('prunes the index after a TTL reap when the caller says which agent (F-P1-5)', async () => {
    // A bridge revokes from its `finally` with the agent id in hand — the same id it minted
    // for. After a 24 h reap (an app that crashed mid-run) the record is gone, so without the
    // hint the member outlives the credential until something happens to list or sweep it.
    const reaped = await mint()
    await redis.del(agentRunCredentialKey(reaped.credentialId))
    expect(await indexMembers(COOPER)).toEqual([reaped.credentialId])

    expect(await revokeRunCredential(reaped.credentialId, { agentId: COOPER })).toBe(false)
    expect(await indexMembers(COOPER)).toEqual([])
  })

  it('leaves the other live runs of the same agent alone', async () => {
    const first = await mint({ sessionId: 'sess-1' })
    const second = await mint({ sessionId: 'sess-2' })

    await revokeRunCredential(first.credentialId)

    expect(await validateRunCredential(first.token)).toMatchObject({ valid: false })
    expect(await validateRunCredential(second.token)).toMatchObject({ valid: true })
    expect(await indexMembers(COOPER)).toEqual([second.credentialId])
  })
})

describe('agent deletion (DL-117-09)', () => {
  it('deletes the deleted agent’s credentials and their index, and only theirs', async () => {
    const cooperRun = await mint()
    const fayeRun = await mint({ agentId: FAYE, sessionId: 'sess-2', runtime: 'claude' })

    const deleted = await sweepAgentRunCredentials(COOPER)

    expect(deleted).toBe(1)
    expect(await getRunCredential(cooperRun.credentialId)).toBeNull()
    expect(await validateRunCredential(cooperRun.token)).toMatchObject({ valid: false })
    expect(await indexMembers(COOPER)).toEqual([])

    expect(await getRunCredential(fayeRun.credentialId)).not.toBeNull()
    expect(await validateRunCredential(fayeRun.token)).toMatchObject({ valid: true })
    expect(await indexMembers(FAYE)).toEqual([fayeRun.credentialId])
  })

  it('works from the agent index alone, with the agent record already gone', async () => {
    // Unlike the hook and schedule sweeps this one does NOT read `agent.user_id`, so it is the
    // one sweep that still works if the destructive order in `deleteAgent` is ever flipped.
    // That is not a licence to flip it — the other three break — but it is why this sweep has
    // no "agent already gone" blind spot to test around.
    const { credentialId } = await mint()
    await redis.del(`agent:${COOPER}`)

    expect(await sweepAgentRunCredentials(COOPER)).toBe(1)
    expect(await getRunCredential(credentialId)).toBeNull()
  })

  it('does nothing for an agent that never ran, and for an empty id', async () => {
    expect(await sweepAgentRunCredentials(FAYE)).toBe(0)
    expect(await sweepAgentRunCredentials('  ')).toBe(0)
  })
})
/* -------------------------------------------------------------------------- *
 * SA-117 P2 (F-P2-1) — the delegated mint, found by the live Worker spawn.
 *
 * `subagentRunner.ts` launches a Subagent or Worker on a managed CLI lane with a runtime id
 * it derives from the subagent's slug (`subagent_cli_<slug>`). Nothing is stored under
 * `agent:{that id}`, so P2's first cut threw on every Worker spawn: "Agent
 * subagent_cli_worker_… was not found for this user, so no run credential was minted."
 * -------------------------------------------------------------------------- */

describe('a delegated run credential', () => {
  it('mints with no agent record, and marks the credential as delegated', async () => {
    const minted = await mintRunCredential({
      userId: USER,
      agentId: 'subagent_cli_worker_agent_cooper_1',
      sessionId: 'sess-worker',
      runtime: 'codex',
      delegated: true
    })

    expect(minted.record.delegated).toBe(true)
    const stored = await getRunCredential(minted.credentialId)
    expect(stored?.delegated).toBe(true)
    expect(stored?.agentId).toBe('subagent_cli_worker_agent_cooper_1')

    const validation = await validateRunCredential(minted.token)
    expect(validation.valid).toBe(true)
    if (!validation.valid) return
    expect(validation.record.delegated).toBe(true)
  })

  it('still refuses a delegated id that collides with ANOTHER user\'s stored agent', async () => {
    // The record check does not disappear for a delegated mint — it only stops requiring a
    // record to exist. This is the one way a per-run runtime id could ever have named a real
    // agent, and it stays closed.
    await redis.createAgent({
      id: 'subagent_cli_collision',
      user_id: 'somebody-else',
      displayName: 'Collision',
      agentType: 'api',
      primary_model_provider: 'anthropic',
      primary_model_name: 'claude-sonnet-4-5'
    } as never)

    await expect(
      mintRunCredential({
        userId: USER,
        agentId: 'subagent_cli_collision',
        sessionId: 'sess-worker',
        runtime: 'codex',
        delegated: true
      })
    ).rejects.toThrow(/was not found for this user/)
  })

  it('marks an ordinary primary run as NOT delegated', async () => {
    const minted = await mintRunCredential({
      userId: USER,
      agentId: COOPER,
      sessionId: 'sess-primary',
      runtime: 'codex'
    })
    expect(minted.record.delegated).toBe(false)
  })

  it('still refuses a non-delegated mint for an agent that does not exist', async () => {
    await expect(
      mintRunCredential({
        userId: USER,
        agentId: 'agent-that-never-was',
        sessionId: 'sess-primary',
        runtime: 'codex'
      })
    ).rejects.toThrow(/was not found for this user/)
  })
})
