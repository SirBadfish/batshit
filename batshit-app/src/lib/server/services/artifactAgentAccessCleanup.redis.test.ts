import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { readArtifactAgentAccess } from '$lib/utils/agentAccessIds'
import { isArtifactAccessCleanupUnknown, removeArtifactAgentReferences } from './artifactAgentAccessCleanup'

// Actual RedisJSON/Lua only; the default fake is not a cleanup interpreter.
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'artifact_access_cleanup_fixture'
const ID = 'artifact_access_cleanup_fixture'
const AGENT = 'odd.id-A'
const KEY = `artifact:${ID}`
useRedisTestServer()
afterEach(async () => { vi.restoreAllMocks(); await redis.del(KEY) })
const seed = async (fields: Record<string, unknown> = {}) => redis.json.set(KEY, '$', { id: ID, user_id: USER, title: 'kept', metadata: { sibling: { nested: [] } }, ...fields })
const read = async () => await redis.json.get(KEY) as Record<string, any>
const context = () => ({ checkBeforeIssue: vi.fn(), onChanged: vi.fn() })
const cleanup = (ctx = context()) => removeArtifactAgentReferences({ userId: USER, artifactId: ID, agentId: AGENT }, ctx)

describe.runIf(REAL)('unexposed exact Artifact reference cleanup on actual RedisJSON', () => {
  it.each(['agent_allowlist', 'agentAllowlist', 'assigned_agent_ids', 'assignedAgentIds'])('removes metadata %s and keeps last-member scope restrictive', async alias => {
    await seed({ metadata: { [alias]: [AGENT], sibling: { nested: [] } } })
    const ctx = context()
    expect(await cleanup(ctx)).toEqual({ status: 'changed', removed: 1, scopePinned: true, notification: 'recorded' })
    expect(ctx.onChanged).toHaveBeenCalledExactlyOnceWith({ removed: 1, scopePinned: true })
    const saved = await read()
    expect(saved.metadata).toEqual({ [alias]: [], sibling: { nested: [] } })
    expect(Object.hasOwn(saved, 'agent_allowlist')).toBe(false)
    expect(Object.hasOwn(saved, 'agent_use_enabled')).toBe(false)
    expect(readArtifactAgentAccess(saved)).toMatchObject({ ids: [], scope: 'selected' })
  })

  it('scrubs all five paths including shadowed duplicate references without re-encoding bystanders', async () => {
    const entries = [AGENT, 'other', 7, [], { keep: [] }, AGENT]
    await seed({ agent_allowlist: entries, agent_use_enabled: true, metadata: {
      agent_allowlist: entries, agentAllowlist: entries, assigned_agent_ids: entries, assignedAgentIds: entries, sibling: { nested: [] }
    } })
    expect(await cleanup()).toMatchObject({ status: 'changed', removed: 10, scopePinned: false })
    const saved = await read()
    const kept = ['other', 7, [], { keep: [] }]
    expect(saved.agent_allowlist).toEqual(kept)
    for (const alias of ['agent_allowlist', 'agentAllowlist', 'assigned_agent_ids', 'assignedAgentIds']) expect(saved.metadata[alias]).toEqual(kept)
    expect(saved.metadata.sibling).toEqual({ nested: [] })
    expect(saved.agent_use_enabled).toBe(true)
    expect(saved.title).toBe('kept')
    expect(Object.hasOwn(saved, 'agent_access_scope')).toBe(false)
  })

  it('removes an owned whitespace-bearing legacy ID literally without changing its trimmed bystander', async () => {
    const legacy = ` ${AGENT} `
    await seed({ agent_allowlist: [legacy, AGENT], metadata: { assignedAgentIds: [legacy, legacy] } })
    expect(await removeArtifactAgentReferences({ userId: USER, artifactId: ID, agentId: legacy }, context()))
      .toMatchObject({ status: 'changed', removed: 3, scopePinned: false })
    const saved = await read()
    expect(saved.agent_allowlist).toEqual([AGENT])
    expect(saved.metadata.assignedAgentIds).toEqual([])
  })

  it('preserves named all and master-enabled/selected intent instead of normalizing scope', async () => {
    for (const fields of [{ agent_access_scope: ' ALL ' }, { agent_access_scope: 'selected' }, { agent_use_enabled: true }]) {
      await seed({ ...fields, metadata: { agentAllowlist: [AGENT] } })
      expect(await cleanup()).toMatchObject({ status: 'changed', scopePinned: false })
      const saved = await read()
      for (const [key, value] of Object.entries(fields)) expect(saved[key]).toBe(value)
      if (!Object.hasOwn(fields, 'agent_access_scope')) expect(Object.hasOwn(saved, 'agent_access_scope')).toBe(false)
    }
  })

  it('preserves a direct empty array override and non-array legacy values literally', async () => {
    await seed({ agent_allowlist: [], metadata: { agent_allowlist: 'wrong-shape', agentAllowlist: [AGENT], assigned_agent_ids: null, assignedAgentIds: { kept: [] } } })
    expect(await cleanup()).toMatchObject({ status: 'changed', removed: 1, scopePinned: false })
    const saved = await read()
    expect(saved).toMatchObject({ agent_allowlist: [], metadata: { agent_allowlist: 'wrong-shape', agentAllowlist: [], assigned_agent_ids: null, assignedAgentIds: { kept: [] } } })
    expect(readArtifactAgentAccess(saved).scope).toBe('all')
    expect(Object.hasOwn(saved, 'agent_access_scope')).toBe(false)
  })

  it('returns confirmed no-op and known missing/owner refusals without notification', async () => {
    const ctx = context()
    expect(await cleanup(ctx)).toEqual({ status: 'refused', reason: 'artifact_missing' })
    await seed({ metadata: { agentAllowlist: ['other'] } })
    const before = await read()
    expect(await cleanup(ctx)).toEqual({ status: 'unchanged' })
    expect(await read()).toEqual(before)
    await seed({ user_id: 'other', metadata: { agentAllowlist: [AGENT] } })
    expect(await cleanup(ctx)).toEqual({ status: 'refused', reason: 'artifact_not_owned' })
    expect(ctx.onChanged).not.toHaveBeenCalled()
  })

  it('refuses a concurrent access edit instead of adopting it as a new basis', async () => {
    await seed({ metadata: { agentAllowlist: [AGENT] } })
    const execute = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementation((work: any) => execute((client: any) => work(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: unknown) => {
        if (script.includes('JSON.ARRPOP')) await target.json.set(KEY, '$.metadata.agentAllowlist', [AGENT, 'late'])
        return target.eval(script, options)
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))) as any)
    expect(await cleanup()).toEqual({ status: 'refused', reason: 'conflict' })
    expect((await read()).metadata.agentAllowlist).toEqual([AGENT, 'late'])
  })

  it('checks caller custody after client acquisition and before physical issue', async () => {
    await seed({ agent_allowlist: [AGENT] })
    const ctx = context()
    const refusal = new Error('original caller lifecycle expired')
    let checks = 0
    ctx.checkBeforeIssue.mockImplementation(() => { if (++checks === 4) throw refusal })
    await expect(cleanup(ctx)).rejects.toBe(refusal)
    expect((await read()).agent_allowlist).toEqual([AGENT])
    expect(ctx.onChanged).not.toHaveBeenCalled()
  })

  it('keeps issued answer loss unknown without replay or a fabricated known-change notification', async () => {
    await seed({ agent_allowlist: [AGENT], agent_access_scope: 'selected' })
    const execute = redis.execute.bind(redis)
    let issued = 0
    vi.spyOn(redis, 'execute').mockImplementation((work: any) => execute((client: any) => work(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: unknown) => {
        const answer = await target.eval(script, options)
        if (script.includes('JSON.ARRPOP')) { issued++; throw new Error('lost actual result') }
        return answer
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))) as any)
    const ctx = context()
    const error = await cleanup(ctx).catch(error => error)
    expect(isArtifactAccessCleanupUnknown(error)).toBe(true)
    expect(issued).toBe(1)
    expect(ctx.onChanged).not.toHaveBeenCalled()
    expect((await read()).agent_allowlist).toEqual([])
  })

  it('retains known changed state if its synchronous stage notification fails', async () => {
    await seed({ metadata: { assignedAgentIds: [AGENT] } })
    const ctx = context()
    ctx.onChanged.mockImplementation(() => { throw new Error('ledger unavailable') })
    expect(await cleanup(ctx)).toEqual({ status: 'changed', removed: 1, scopePinned: true, notification: 'failed' })
    expect((await read()).metadata.assignedAgentIds).toEqual([])
  })
})
