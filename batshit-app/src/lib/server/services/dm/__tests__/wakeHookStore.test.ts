import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  createWakeHook,
  getWakeHook,
  recordWakeHookUse,
  listWakeHooks,
  revokeWakeHook,
  rotateWakeHookToken,
  sweepAgentWakeHooks,
  updateWakeHook,
  validateWakeHookToken,
  wakeHooksIndexKey,
  WakeHookError
} from '../wakeHookStore'

/**
 * SA-113 P3 (DL-113-09) — the wake-up webhook records.
 *
 * The rules that matter here are all security rules: the plain token is never stored, the
 * hook id alone is not a credential, a revoked or rotated token stops working at once, and
 * a hook cannot outlive the agent it writes to.
 */

useRedisTestServer()

const USER = 'user-hooks'
const OTHER_USER = 'user-other'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'

async function seedAgent(id: string, userId = USER, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: id.replace('agent-', '').replace(/^./, (c) => c.toUpperCase()),
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true,
    ...overrides
  } as any)
}

beforeEach(async () => {
  await seedAgent(COOPER)
  await seedAgent(FAYE)
})

describe('creating a hook', () => {
  it('returns the token ONCE and stores only its fingerprint', async () => {
    const { token, record } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly build'
    })

    expect(token.startsWith('bswh_')).toBe(true)
    // The summary the Admin card receives can never leak the secret.
    expect(JSON.stringify(record)).not.toContain(token)
    expect((record as Record<string, unknown>).tokenHash).toBeUndefined()

    const stored = await getWakeHook(record.id)
    expect(stored?.tokenHash).toBeTruthy()
    expect(stored?.tokenHash).not.toBe(token)
    expect(JSON.stringify(stored)).not.toContain(token)
    // Enough of the token to tell two apart in a list, never enough to use one.
    expect(token.startsWith(record.tokenPrefix)).toBe(true)
    expect(token.endsWith(record.tokenSuffix)).toBe(true)
  })

  it('defaults to waking and can be created as a wait hook', async () => {
    const waking = await createWakeHook({ userId: USER, agentId: COOPER, name: 'Wakes' })
    expect(waking.record.deliverDefault).toBe('wake')

    const waiting = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Waits',
      deliverDefault: 'wait'
    })
    expect(waiting.record.deliverDefault).toBe('wait')
  })

  // SA-114 P4: `steer` is a real DM delivery mode now, but NOT on this lane. A wake-up
  // webhook is an outside program with no view of whether the agent is mid-reply, and
  // DL-114-13 gives the steer door to `sys.dm.send` only. So the example below still fails
  // — it changed from "not built yet" to "not this lane", which is why the sentence names
  // the two a hook takes rather than the one it does not.
  it('refuses a nameless hook, a delivery mode a hook cannot use, and a missing agent', async () => {
    await expect(createWakeHook({ userId: USER, agentId: COOPER, name: '  ' })).rejects.toThrow(
      /needs a name/i
    )
    await expect(
      createWakeHook({ userId: USER, agentId: COOPER, name: 'x', deliverDefault: 'steer' })
    ).rejects.toThrow(/"wait" or "wake"/i)
    await expect(
      createWakeHook({ userId: USER, agentId: 'agent-missing', name: 'x' })
    ).rejects.toThrow(/not found/i)
  })

  it('refuses an agent belonging to somebody else', async () => {
    await seedAgent('agent-theirs', OTHER_USER)
    await expect(
      createWakeHook({ userId: USER, agentId: 'agent-theirs', name: 'Not mine' })
    ).rejects.toThrow(/not found/i)
  })

  it('rejects an unreadable expiry rather than quietly dropping it', async () => {
    await expect(
      createWakeHook({ userId: USER, agentId: COOPER, name: 'x', expiresAt: 'next tuesday' })
    ).rejects.toThrow(/could not be read/i)
  })
})

describe('validating a call', () => {
  it('accepts the right token on the right hook', async () => {
    const { token, record } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly build'
    })
    const result = await validateWakeHookToken(record.id, token)
    expect(result.valid).toBe(true)
  })

  it('refuses a missing, wrong, or unknown token', async () => {
    const { token, record } = await createWakeHook({ userId: USER, agentId: COOPER, name: 'A' })

    expect(await validateWakeHookToken(record.id, null)).toMatchObject({ reason: 'missing' })
    expect(await validateWakeHookToken(record.id, '   ')).toMatchObject({ reason: 'missing' })
    expect(await validateWakeHookToken(record.id, 'bswh_nope')).toMatchObject({
      reason: 'invalid'
    })
    expect(await validateWakeHookToken('whk_nope', token)).toMatchObject({ reason: 'invalid' })
  })

  it('refuses one hook\'s token presented at another hook', async () => {
    const first = await createWakeHook({ userId: USER, agentId: COOPER, name: 'First' })
    const second = await createWakeHook({ userId: USER, agentId: FAYE, name: 'Second' })

    // The token is bound to the hook in the URL, so a stolen token cannot be replayed
    // against a different hook to reach a different agent.
    expect(await validateWakeHookToken(second.record.id, first.token)).toMatchObject({
      reason: 'invalid'
    })
  })

  it('refuses a paused hook and an expired hook', async () => {
    const { token, record } = await createWakeHook({ userId: USER, agentId: COOPER, name: 'A' })

    await updateWakeHook({ userId: USER, hookId: record.id, enabled: false })
    expect(await validateWakeHookToken(record.id, token)).toMatchObject({ reason: 'disabled' })

    await updateWakeHook({ userId: USER, hookId: record.id, enabled: true })
    await updateWakeHook({
      userId: USER,
      hookId: record.id,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })
    expect(await validateWakeHookToken(record.id, token)).toMatchObject({ reason: 'expired' })
  })

  it('stops the old token the moment one is rotated', async () => {
    const { token: original, record } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'A'
    })
    const rotated = await rotateWakeHookToken({ userId: USER, hookId: record.id })

    expect(await validateWakeHookToken(record.id, original)).toMatchObject({ reason: 'invalid' })
    expect(await validateWakeHookToken(record.id, rotated.token)).toMatchObject({ valid: true })
    // Same id, so an n8n workflow only changes its credential, not its URL.
    expect(rotated.record.id).toBe(record.id)
  })

  it('stops the token the moment a hook is revoked', async () => {
    const { token, record } = await createWakeHook({ userId: USER, agentId: COOPER, name: 'A' })
    await revokeWakeHook({ userId: USER, hookId: record.id })

    expect(await validateWakeHookToken(record.id, token)).toMatchObject({ reason: 'invalid' })
    expect(await getWakeHook(record.id)).toBeNull()
    expect(await listWakeHooks(USER)).toHaveLength(0)
  })
})

describe('recording a call (F-P3-2)', () => {
  it('bumps the counters with path-scoped writes, never the whole record', async () => {
    await seedAgent(COOPER)
    const { record, token } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly'
    })

    // `redis.json.set` is already a `vi.fn` in the Redis fake, so spying on it inherits
    // the calls `createWakeHook` just made. Clear first, or the create's own `$` write
    // fails the very assertion this test exists for.
    const setSpy = vi.spyOn(redis.json, 'set')
    const incrSpy = vi.spyOn(redis.json, 'numIncrBy')
    setSpy.mockClear()
    incrSpy.mockClear()
    try {
      await recordWakeHookUse(record.id)

      // A whole-record write here is what let a concurrent rotate or revoke be undone.
      for (const call of setSpy.mock.calls) {
        expect(call[1]).not.toBe('$')
      }
      expect(setSpy).toHaveBeenCalledWith(`wake_hook:${record.id}`, '$.lastUsedAt', expect.any(String))
      expect(incrSpy).toHaveBeenCalledWith(`wake_hook:${record.id}`, '$.useCount', 1)
    } finally {
      setSpy.mockRestore()
      incrSpy.mockRestore()
    }

    const after = await getWakeHook(record.id)
    expect(after?.useCount).toBe(1)
    expect(after?.lastUsedAt).toBeTruthy()
    // Everything the bump did not own survived — the credential above all.
    expect(after?.name).toBe('Nightly')
    expect(await validateWakeHookToken(record.id, token)).toMatchObject({ valid: true })
  })

  /**
   * The window is real: the route validates, delivers (a wake can take seconds), and only
   * then records the use. Both tests below hand the recorder a snapshot taken BEFORE the
   * competing write, which is exactly what a read-modify-write would have been holding.
   */
  function serveStaleHookRecord(hookId: string, snapshot: unknown) {
    const realGet = redis.json.get.bind(redis.json)
    return vi
      .spyOn(redis.json, 'get')
      .mockImplementation(async (key: string, ...rest: any[]) =>
        key === `wake_hook:${hookId}`
          ? JSON.parse(JSON.stringify(snapshot))
          : (realGet as any)(key, ...rest)
      )
  }

  it('cannot resurrect a hook revoked inside its own window', async () => {
    await seedAgent(COOPER)
    const { record, token } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly'
    })

    const stale = await getWakeHook(record.id)
    await revokeWakeHook({ userId: USER, hookId: record.id })

    const getSpy = serveStaleHookRecord(record.id, stale)
    try {
      await recordWakeHookUse(record.id)
    } finally {
      getSpy.mockRestore()
    }

    expect(await getWakeHook(record.id)).toBeNull()
    expect(await validateWakeHookToken(record.id, token)).toMatchObject({ valid: false })
    expect(await listWakeHooks(USER)).toHaveLength(0)
  })

  it('cannot undo a rotate that landed inside its own window', async () => {
    await seedAgent(COOPER)
    const { record, token: oldToken } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly'
    })

    const stale = await getWakeHook(record.id)
    const { token: newToken } = await rotateWakeHookToken({ userId: USER, hookId: record.id })

    const getSpy = serveStaleHookRecord(record.id, stale)
    try {
      await recordWakeHookUse(record.id)
    } finally {
      getSpy.mockRestore()
    }

    expect(await validateWakeHookToken(record.id, newToken)).toMatchObject({ valid: true })
    expect(await validateWakeHookToken(record.id, oldToken)).toMatchObject({ valid: false })
  })

  /**
   * The same window, for the two writers it had NOT been applied to.
   *
   * `updateWakeHook` and `rotateWakeHookToken` both read the record and then wrote the whole
   * thing back with `JSON.SET $`, and a root-path write CREATES a missing key. A revoke
   * landing between their read and their write therefore brought the hook back with its
   * original `tokenHash` and `enabled: true`, while the owner's index no longer listed it —
   * a live credential with nothing left in the UI to revoke a second time.
   */
  it('update cannot resurrect a hook revoked inside its own window', async () => {
    await seedAgent(COOPER)
    const { record, token } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly'
    })

    const stale = await getWakeHook(record.id)
    await revokeWakeHook({ userId: USER, hookId: record.id })

    const getSpy = serveStaleHookRecord(record.id, stale)
    try {
      await expect(
        updateWakeHook({ userId: USER, hookId: record.id, name: 'Renamed' })
      ).rejects.toBeInstanceOf(WakeHookError)
    } finally {
      getSpy.mockRestore()
    }

    expect(await getWakeHook(record.id)).toBeNull()
    expect(await validateWakeHookToken(record.id, token)).toMatchObject({ valid: false })
    expect(await listWakeHooks(USER)).toHaveLength(0)
  })

  it('rotate cannot resurrect a hook revoked inside its own window', async () => {
    await seedAgent(COOPER)
    const { record } = await createWakeHook({
      userId: USER,
      agentId: COOPER,
      name: 'Nightly'
    })

    const stale = await getWakeHook(record.id)
    await revokeWakeHook({ userId: USER, hookId: record.id })

    let rotatedToken: string | null = null
    const getSpy = serveStaleHookRecord(record.id, stale)
    try {
      rotatedToken = (await rotateWakeHookToken({ userId: USER, hookId: record.id })).token
    } catch {
      // Refusing outright is the other acceptable outcome; what must not happen is a key.
    } finally {
      getSpy.mockRestore()
    }

    expect(await getWakeHook(record.id)).toBeNull()
    if (rotatedToken) {
      expect(await validateWakeHookToken(record.id, rotatedToken)).toMatchObject({ valid: false })
    }
    expect(await listWakeHooks(USER)).toHaveLength(0)
  })
})

describe('hook id validation', () => {
  it('treats an id shaped like the index key as no such hook, not a key read', async () => {
    await seedAgent(COOPER)
    await createWakeHook({ userId: USER, agentId: COOPER, name: 'Nightly' })

    // `wake_hook:` + `s:{userId}` === `wake_hooks:{userId}`, which is a SET. Reading it as
    // RedisJSON raised WRONGTYPE and escaped the route as a 500 instead of the uniform 403.
    await expect(getWakeHook(`s:${USER}`)).resolves.toBeNull()
    await expect(getWakeHook(wakeHooksIndexKey(USER))).resolves.toBeNull()
    await expect(validateWakeHookToken(`s:${USER}`, 'bswh_anything')).resolves.toMatchObject({
      valid: false
    })
  })
})

describe('ownership', () => {
  it('refuses to update, rotate, or revoke another user\'s hook', async () => {
    const { record } = await createWakeHook({ userId: USER, agentId: COOPER, name: 'Mine' })

    await expect(
      updateWakeHook({ userId: OTHER_USER, hookId: record.id, name: 'Theirs' })
    ).rejects.toThrow(WakeHookError)
    await expect(
      rotateWakeHookToken({ userId: OTHER_USER, hookId: record.id })
    ).rejects.toThrow(/not found/i)
    await expect(revokeWakeHook({ userId: OTHER_USER, hookId: record.id })).rejects.toThrow(
      /not found/i
    )

    expect(await getWakeHook(record.id)).not.toBeNull()
  })

  it('lists only this user\'s hooks, newest first', async () => {
    await createWakeHook({ userId: USER, agentId: COOPER, name: 'Older' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await createWakeHook({ userId: USER, agentId: FAYE, name: 'Newer' })
    await seedAgent('agent-theirs', OTHER_USER)
    await createWakeHook({ userId: OTHER_USER, agentId: 'agent-theirs', name: 'Not mine' })

    expect((await listWakeHooks(USER)).map((hook) => hook.name)).toEqual(['Newer', 'Older'])
    expect((await listWakeHooks(OTHER_USER)).map((hook) => hook.name)).toEqual(['Not mine'])
  })

  it('prunes an index entry whose record is gone', async () => {
    const { record } = await createWakeHook({ userId: USER, agentId: COOPER, name: 'Dangling' })
    await redis.del(`wake_hook:${record.id}`)

    expect(await listWakeHooks(USER)).toHaveLength(0)
    const members = await redis.execute(async (client) =>
      client.sMembers(wakeHooksIndexKey(USER))
    )
    expect(members).toHaveLength(0)
  })
})

describe('agent deletion (DL-113-02)', () => {
  it('deletes the deleted agent\'s hooks and leaves the others alone', async () => {
    const cooperHook = await createWakeHook({ userId: USER, agentId: COOPER, name: 'Cooper hook' })
    const fayeHook = await createWakeHook({ userId: USER, agentId: FAYE, name: 'Faye hook' })

    const deleted = await sweepAgentWakeHooks(COOPER)

    expect(deleted).toBe(1)
    expect(await getWakeHook(cooperHook.record.id)).toBeNull()
    expect(await getWakeHook(fayeHook.record.id)).not.toBeNull()
    expect((await listWakeHooks(USER)).map((hook) => hook.name)).toEqual(['Faye hook'])
  })

  it('does nothing when the agent record is already gone', async () => {
    // The sweep reads `agent.user_id` to find the hook index, which is why
    // `redis.deleteAgent` calls it BEFORE deleting the agent record. If that order ever
    // flips, the sweep silently finds nothing instead of failing.
    const { record } = await createWakeHook({ userId: USER, agentId: COOPER, name: 'Orphan' })
    await redis.del(`agent:${COOPER}`)

    expect(await sweepAgentWakeHooks(COOPER)).toBe(0)
    expect(await getWakeHook(record.id)).not.toBeNull()
  })
})
