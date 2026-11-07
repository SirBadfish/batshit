// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin, useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
import { commitSkillSessionState, prepareSkillSessionCommit, SkillSessionCommitError,
  type SkillSessionCommitInput, type SkillSessionSourceGuard } from '../skillSessionCommit'
import type { SkillSessionRecord } from '$lib/utils/skillSessions'

/** Default lane proves the finite twin/caller contract. test:redis executes the actual Lua on
 * the coordinator's existing isolated Redis8+JSON DB15 lane; no server is created here. */
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
useSkillSessionRedisTestServer()
useSkillSessionCommitTwin()
let sequence = 0
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function fixture(customNames = false) {
  const suffix = `${process.pid}-${++sequence}`
  const userId = `commit-user-${suffix}`, sessionId = customNames ? `My task 雪 ${suffix}` : `commit-chat-${suffix}`, agentId = `commit-agent-${suffix}`
  const taskId = customNames ? '依頼 message' : 'task', replyId = customNames ? `Reply ${'界'.repeat(300)}` : 'reply'
  const zipId = `commit-read-${suffix}`, rawZipId = `cool_tool_1790000000000_commit${sequence}x`
  const keys = { lifecycle: `skill_sessions:${sessionId}`, session: `session:${sessionId}`, agent: `agent:${agentId}`,
    master: 'batshit:typesafe_config', command: `slash_command:${userId}:example`, plugin: `agent_plugin:${userId}:example`,
    revision: `slash_command_revision:${userId}`, list: `messages:${sessionId}`, task: `message:${sessionId}:${taskId}`, reply: `message:${sessionId}:${replyId}`,
    open: `unzipped_item:${sessionId}:${zipId}`, closed: `rezipped_item:${sessionId}:${zipId}`, raw: `zip:${rawZipId}` }
  const entry = { agentId, skillId: 'example', name: 'Example', generation: 1, revision: 1, status: 'open' as const,
    openedAt: 1, openedMessageId: replyId, reads: [{ zipId, rawZipId, messageId: replyId, path: 'SKILL.md' }] }
  const old: SkillSessionRecord = { version: 1, userId, sessionId, entries: [entry] }
  const hold = { zipId, sessionId, permanent: true, source: 'agent' as const, agentId, unzippedAt: 1,
    skillSession: { skillId: 'example', generation: 1, automatic: true } }
  const docs: Array<[string, unknown]> = [
    [keys.lifecycle, old], [keys.session, { id: sessionId, user_id: userId, agent_id: agentId }],
    [keys.agent, { id: agentId, user_id: userId, jev_juice_skill_tool_hints: 'manage', unrelated: { keep: ['one', 'two'] } }],
    [keys.master, { enabled: true, unrelated: { keep: 'master data' } }],
    [keys.command, { id: 'example', user_id: userId, skill_id: 'example', enabled_for_all_agents: true }],
    [keys.plugin, { id: 'example', user_id: userId, enabled_agent_ids: [agentId] }],
    [keys.task, { id: taskId, session_id: sessionId, user_id: userId, role: 'user', content: 'Do the whole task.' }],
    [keys.reply, { id: replyId, session_id: sessionId, user_id: userId, role: 'assistant', content: 'The whole task is complete.' }],
    [keys.open, hold], [keys.raw, { id: rawZipId, type: 'cool_tool', metadata: { sessionId, messageId: replyId, untouched: { keep: 7 } }, content: '# Skill' }]
  ]
  for (const [key, value] of docs) await redis.json.set(key, '$', value)
  await redis.set(keys.revision, 'a'.repeat(64))
  await redis.rPush(keys.list, taskId); await redis.rPush(keys.list, replyId)
  await redis.sAdd(`unzipped:${sessionId}`, zipId)
  await redis.sAdd(`unzipped:${sessionId}`, 'unrelated-result')
  const guards: SkillSessionSourceGuard[] = []
  for (const key of [...docs.map(([key]) => key), keys.closed]) guards.push({ kind: 'json', key, raw: await redis.json.getRaw(key, '$') })
  guards.push({ kind: 'string', key: keys.revision, raw: await redis.execute(client => client.get(keys.revision)) },
    { kind: 'list', key: keys.list, values: await redis.lRange(keys.list, 0, -1) })
  const record: SkillSessionRecord = { ...old, entries: [{ ...entry, status: 'closed', closedBy: 'inferred', revision: 2 }] }
  const input: SkillSessionCommitInput = { record, changes: [{ zipId, closeBy: 'inferred' }], guards,
    lifecycle: captureSettingsLifecycle([keys.session, keys.agent]) }
  return { userId, sessionId, agentId, zipId, rawZipId, keys, old, hold, input }
}

/** Pause the existing client-acquisition seam, after captured policy but before physical EVAL. */
async function race(input: SkillSessionCommitInput, mutate: (client: any) => Promise<void>) {
  const entered = deferred(), release = deferred()
  const original = redis.execute
  ;(redis as any).execute = (operation: (client: any) => unknown) => original.call(redis, async (client: any) => {
    entered.resolve(); await release.promise
    return operation(client)
  })
  const pending = commitSkillSessionState(input)
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('The commit settled before the physical-issue barrier.') })])
    await original.call(redis, mutate)
    release.resolve()
    return await pending
  } finally {
    release.resolve()
    ;(redis as any).execute = original
  }
}

describe('skill-session atomic publication owner', () => {
  it('keeps supported space/Unicode chat IDs and long exact message identities usable', async () => {
    const f = await fixture(true)
    expect(await commitSkillSessionState(f.input)).toEqual({ status: 'applied' })
    expect(await redis.json.get(f.keys.lifecycle)).toEqual(f.input.record)
  })

  it.runIf(!REAL)('can close every actual window of a lifecycle beyond 1,024 reads without a new aggregate cap', async () => {
    const f = await fixture()
    const old = structuredClone(f.old)
    const extra: SkillSessionSourceGuard[] = []
    for (let index = 1; index <= 1024; index += 1) {
      const zipId = `batch-read-${index}`
      old.entries[0].reads.push({ zipId, rawZipId: `cool_tool_1790000000000_batch${index}x`, messageId: 'reply', path: 'SKILL.md' })
      const key = `unzipped_item:${f.sessionId}:${zipId}`
      await redis.json.set(key, '$', { ...f.hold, zipId })
      await redis.sAdd(`unzipped:${f.sessionId}`, zipId)
      extra.push({ kind: 'json', key, raw: await redis.json.getRaw(key, '$') },
        { kind: 'json', key: `rezipped_item:${f.sessionId}:${zipId}`, raw: null })
    }
    await redis.json.set(f.keys.lifecycle, '$', old)
    const originalLifecycleRaw = await redis.json.getRaw(f.keys.lifecycle, '$')
    f.input.guards = [...f.input.guards.map(guard => guard.key === f.keys.lifecycle
      ? { kind: 'json' as const, key: guard.key, raw: originalLifecycleRaw } : guard), ...extra]
    f.input.record = { ...old, entries: [{ ...old.entries[0], revision: 2, status: 'closed', closedBy: 'inferred' }] }
    f.input.changes = old.entries[0].reads.map(read => ({ zipId: read.zipId, closeBy: 'inferred' }))
    expect(await commitSkillSessionState(f.input)).toEqual({ status: 'applied' })
    expect(await redis.sMembers(`unzipped:${f.sessionId}`)).toEqual(['unrelated-result'])
    expect(await redis.sMembers(`rezipped:${f.sessionId}`)).toHaveLength(1025)
  })
  it('publishes all close state with lifecycle metadata and preserves unrelated raw sources and set members', async () => {
    const f = await fixture()
    const before = await Promise.all([f.keys.agent, f.keys.master, f.keys.command, f.keys.plugin, f.keys.raw].map(key => redis.json.getRaw(key, '$')))
    expect(await commitSkillSessionState(f.input)).toEqual({ status: 'applied' })
    expect(await redis.json.get(f.keys.lifecycle)).toEqual(f.input.record)
    expect(await redis.json.get(f.keys.open)).toBeNull()
    expect(await redis.json.get(f.keys.closed)).toMatchObject({ zipId: f.zipId, source: 'inferred', reason: 'skill_closed', toldAgent: true })
    expect(await redis.sMembers(`unzipped:${f.sessionId}`)).toEqual(['unrelated-result'])
    expect(await Promise.all([f.keys.agent, f.keys.master, f.keys.command, f.keys.plugin, f.keys.raw].map(key => redis.json.getRaw(key, '$')))).toEqual(before)
  })

  it('records admission with an already populated unzip set, preserving the existing member and other zip metadata', async () => {
    const f = await fixture()
    f.input.record = { ...f.old, entries: [{ ...f.old.entries[0], revision: 2 }] }
    f.input.changes = [{ zipId: f.zipId, rawZipId: f.rawZipId, transcriptSha256: 'b'.repeat(64), hold: f.hold }]
    expect(await commitSkillSessionState(f.input)).toEqual({ status: 'applied' })
    expect((await redis.json.get(f.keys.raw) as any).metadata).toMatchObject({ untouched: { keep: 7 }, skillSessionAdmission: {
      agentId: f.agentId, skillId: 'example', generation: 1, automatic: true, transcriptSha256: 'b'.repeat(64) } })
    expect((await redis.sMembers(`unzipped:${f.sessionId}`)).sort()).toEqual([f.zipId, 'unrelated-result'].sort())
    expect(await redis.execute(client => client.type(`rezipped:${f.sessionId}`))).toBe('none')
  })

  it.runIf(REAL)('preserves exact unrelated large-integer source bytes while applying only the owned admission leaf (actual RedisJSON)', async () => {
    const f = await fixture()
    await redis.execute(async client => {
      await client.sendCommand(['JSON.SET', f.keys.agent, '$', `{"id":${JSON.stringify(f.agentId)},"user_id":${JSON.stringify(f.userId)},"jev_juice_skill_tool_hints":"manage","unrelated":9007199254740993}`])
      await client.sendCommand(['JSON.SET', f.keys.raw, '$', `{"id":${JSON.stringify(f.rawZipId)},"type":"cool_tool","metadata":{"sessionId":${JSON.stringify(f.sessionId)},"messageId":"reply","unrelated":9007199254740993},"content":"# Skill"}`])
    })
    const actorRaw = await redis.json.getRaw(f.keys.agent, '$')
    const zipLeaf = await redis.json.getRaw(f.keys.raw, '$.metadata.unrelated')
    f.input.guards = await Promise.all(f.input.guards.map(async guard => guard.kind === 'json' && [f.keys.agent, f.keys.raw].includes(guard.key)
      ? { ...guard, raw: await redis.json.getRaw(guard.key, '$') } : guard))
    f.input.record = { ...f.old, entries: [{ ...f.old.entries[0], revision: 2 }] }
    f.input.changes = [{ zipId: f.zipId, rawZipId: f.rawZipId, transcriptSha256: 'b'.repeat(64), hold: f.hold }]
    expect(await commitSkillSessionState(f.input)).toEqual({ status: 'applied' })
    expect(await redis.json.getRaw(f.keys.agent, '$')).toBe(actorRaw)
    expect(await redis.json.getRaw(f.keys.raw, '$.metadata.unrelated')).toBe(zipLeaf)
    expect(actorRaw).toContain('9007199254740993')
    expect(zipLeaf).toBe('[9007199254740993]')
  })

  it.each(['mode_off', 'master_off', 'access_revoked', 'new_user_message', 'deleted_session'] as const)('refuses %s after initial approval and before physical commit, with no lifecycle/zip writes', async (change) => {
    const f = await fixture()
    const lifecycle = await redis.json.getRaw(f.keys.lifecycle, '$')
    const open = await redis.json.getRaw(f.keys.open, '$')
    const result = await race(f.input, async client => {
      if (change === 'mode_off') await client.json.set(f.keys.agent, '$.jev_juice_skill_tool_hints', 'off')
      else if (change === 'master_off') await client.json.set(f.keys.master, '$.enabled', false)
      else if (change === 'access_revoked') await client.json.set(f.keys.command, '$.enabled_for_all_agents', false)
      else if (change === 'new_user_message') await client.rPush(f.keys.list, 'new-user-message')
      else await client.del(f.keys.session)
    })
    expect(result.status).toBe('changed')
    expect(await redis.json.getRaw(f.keys.lifecycle, '$')).toBe(lifecycle)
    expect(await redis.json.getRaw(f.keys.open, '$')).toBe(open)
    expect(await redis.json.get(f.keys.closed)).toBeNull()
    expect(await redis.sMembers(`unzipped:${f.sessionId}`)).toContain(f.zipId)
  })

  it('preflights a wrong set type before its first write', async () => {
    const f = await fixture()
    await redis.execute(async client => { await client.del(`rezipped:${f.sessionId}`); await client.set(`rezipped:${f.sessionId}`, 'wrong-kind') })
    expect(await commitSkillSessionState(f.input)).toEqual({ status: 'changed', reason: 'set_type' })
    expect(await redis.json.get(f.keys.open)).toEqual(f.hold)
    expect(await redis.json.get(f.keys.closed)).toBeNull()
    expect(await redis.json.get(f.keys.lifecycle)).toEqual(f.old)
  })

  it('rejects another owner key and unknown/missing guard values before issuing any command', async () => {
    const f = await fixture()
    expect(() => prepareSkillSessionCommit({ ...f.input, guards: [...f.input.guards, { kind: 'json', key: 'agent:foreign', raw: null }] })).toThrow('finite owner inventory')
    expect(() => prepareSkillSessionCommit({ ...f.input, guards: f.input.guards.filter(guard => guard.key !== f.keys.closed) })).toThrow('original root preimage')
    expect(() => prepareSkillSessionCommit({ ...f.input, guards: [...f.input.guards, { kind: 'json', key: f.keys.closed, raw: undefined } as any] })).toThrow('unknown')
    expect(await redis.json.get(f.keys.lifecycle)).toEqual(f.old)
  })

  it('an actual lifecycle replacement or synchronous deletion fence prevents physical issuance', async () => {
    const f = await fixture()
    await withSettingsRecordReplacement(f.keys.session, async () => {})
    await expect(commitSkillSessionState(f.input)).rejects.toThrow('Settings identity')
    const second = await fixture()
    second.input.beforeIssue = () => { throw new Error('The chat is being deleted.') }
    await expect(commitSkillSessionState(second.input)).rejects.toThrow('being deleted')
    expect(await redis.json.get(f.keys.lifecycle)).toEqual(f.old)
    expect(await redis.json.get(second.keys.lifecycle)).toEqual(second.old)
  })

  it.runIf(!REAL)('retains unknown/partial custody and never reports success or retries an issued ambiguous command', async () => {
    for (const answer of [new Error('lost reply after issue'), ['PARTIAL', '2', 'command_error']]) {
      const f = await fixture()
      const original = redis.execute
      let issued = 0
      ;(redis as any).execute = (operation: (client: any) => unknown) => original.call(redis, async (client: any) => operation(new Proxy(Object.create(null), {
        get(_target, key) { if (key === 'eval') return async () => { issued += 1; if (answer instanceof Error) throw answer; return answer }
          const value = Reflect.get(client, key, client); return typeof value === 'function' ? value.bind(client) : value }
      })))
      try {
        await expect(commitSkillSessionState(f.input)).rejects.toMatchObject({ name: 'SkillSessionCommitError', outcome: answer instanceof Error ? 'unknown' : 'partial' })
        await expect(commitSkillSessionState(f.input)).rejects.toBeInstanceOf(SkillSessionCommitError)
        expect(issued).toBe(1)
      } finally { (redis as any).execute = original }
    }
  })
})
