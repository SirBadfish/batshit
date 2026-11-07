// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))
import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin, useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { adaptCoolToolsToZipSystem } from '$lib/server/coolToolZipAdapter'
import { VercelAIBrain } from '../vercelBrain'
import { createSkillReadDelivery } from '../skillReadDelivery'
import { closeSkillSession, readOpenSkillSessions, readSkillSessionRecordForCompile } from '../skillSessions'
useSkillSessionRedisTestServer()
useSkillSessionCommitTwin()
const actor = { userId: 'skill-delivery-user', sessionId: 'skill-delivery-chat', agentId: 'skill-delivery-agent', agentCreatedAt: '2026-10-25T00:00:00.000Z' }
const messageId = 'skill-delivery-reply'
let serial = 0
beforeEach(async () => {
  serial = 0
  for (const [key, value] of initializedBuiltinPluginEntries(actor.userId)) await redis.json.set(key, '$', value)
  await redis.createSession({ id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, title: 'Delivery' } as any)
  await redis.createAgent({ id: actor.agentId, created_at: actor.agentCreatedAt, user_id: actor.userId, name: 'Reader', agentType: 'api' } as any)
  await redis.json.set(`slash_command:${actor.userId}:example`, '$', { id: 'example', user_id: actor.userId, type: 'skill', name: 'Example', skill_id: 'example', enabled_for_all_agents: true, is_active: true, can_be_invoked_in_chat: true })
})
const args = { skillId: 'example', action: 'read', path: 'references/example.md' }
const raw = () => ({ success: true, ...args, skillName: 'Example', content: 'exact actual read', offset: 0, returnedChars: 17, originalChars: 100, sourceSha256: 'a'.repeat(64), operationKind: 'skill_read', rendererFamily: 'skill_read' })
function owner() {
  const ids = new Map<string, string>()
  const persist = vi.fn(async (step, beforeSkillReadPersist) => {
    if (!ids.has(step.toolCallId)) ids.set(step.toolCallId, `cool_tool_1790000000000_deliver${++serial}x`)
    return adaptCoolToolsToZipSystem([step], actor.sessionId, messageId, {}, undefined, { reservedZipIdsByToolCallId: ids,
      skillSessionActor: { userId: actor.userId, agentId: actor.agentId, agentCreatedAt: actor.agentCreatedAt }, beforeSkillReadPersist })
  })
  const delivery = createSkillReadDelivery({ actor, messageId, persist })
  const send = (output: any, id = 'call-1', before = { type: 'text', value: 'exact actual read' }, after = before) =>
    delivery.delivered({ toolName: 'native_skill', toolCallId: id, input: args, output, before, after })
  return { delivery, persist, send, ids }
}
describe('actual native skill delivery admission', () => {
  it('a known-absent fallback chat may read empty state, while a writer or existing lifecycle still refuses its absent owner', async () => {
    const session = await redis.json.get(`session:${actor.sessionId}`)
    await redis.del(`session:${actor.sessionId}`)
    expect((await readSkillSessionRecordForCompile(actor)).entries).toEqual([])
    expect(await readOpenSkillSessions(actor)).toEqual([])
    await expect(owner().delivery.execute(args, async () => raw())).rejects.toThrow('owner or chat is unavailable')
    await redis.json.set(`skill_sessions:${actor.sessionId}`, '$', { version: 1, userId: actor.userId, sessionId: actor.sessionId, entries: [] })
    await expect(readSkillSessionRecordForCompile(actor)).rejects.toThrow('chat is unavailable')
    await redis.json.set(`skill_sessions:${actor.sessionId}`, '$', null)
    await expect(readSkillSessionRecordForCompile(actor)).rejects.toThrow('existing skill session state is unreadable')
    await redis.json.set(`session:${actor.sessionId}`, '$', session)
    await expect(owner().delivery.execute(args, async () => raw())).rejects.toThrow('existing skill session state is unreadable')
    const original = redis.json.getRaw.bind(redis.json)
    const fault = vi.spyOn(redis.json, 'getRaw').mockImplementation(async (key, path) => {
      if (key === `skill_sessions:${actor.sessionId}`) throw new Error('Original lifecycle read failed')
      return original(key, path)
    })
    try { await expect(readSkillSessionRecordForCompile(actor)).rejects.toThrow('Original lifecycle read failed') }
    finally { fault.mockRestore() }
  })
  it('persists before model delivery, then same-call finalize and replay cannot reopen Close', async () => {
    const turn = owner()
    const result = await turn.delivery.execute(args, async () => raw())
    expect(await readOpenSkillSessions(actor)).toEqual([])
    await turn.send(result)
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    const keys = (await redis.sMembers(`session:${actor.sessionId}:zips`)).sort()
    await closeSkillSession({ ...actor, skillId: 'example', source: 'user' })
    await turn.send(result)
    expect(turn.persist).toHaveBeenCalledTimes(1)
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect((await redis.sMembers(`session:${actor.sessionId}:zips`)).sort()).toEqual(keys)
  })
  it('the real SDK wrapper finishes guard and persistence before execute resolves, then reuses its formatter receipt', async () => {
    const turn = owner()
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({ native_skill: {
      execute: () => turn.delivery.execute(args, async () => raw()),
      toModelOutput: () => ({ type: 'text', value: 'exact actual read' })
    } }, { ...actor, messageId }, turn.delivery)
    const result = await wrapped.native_skill.execute(args, { toolCallId: 'actual-sdk-id' })
    expect(turn.persist).toHaveBeenCalledTimes(1)
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect(await wrapped.native_skill.toModelOutput({ toolCallId: 'actual-sdk-id', input: args, output: result }))
      .toEqual({ type: 'text', value: 'exact actual read' })
    expect(turn.persist).toHaveBeenCalledTimes(1)
    result.content = 'a changed replay'
    await expect(wrapped.native_skill.toModelOutput({ toolCallId: 'actual-sdk-id', input: args, output: result })).rejects.toThrow('changed during SDK replay')
  })
  it('unavailable complete guidance refuses before storing or opening a new read', async () => {
    const persist = vi.fn()
    const delivery = createSkillReadDelivery({ actor, messageId, persist,
      previewContext: async () => { throw new Error('Required skill guidance is unavailable.') } })
    const output = await delivery.execute(args, async () => raw())
    const model = { type: 'text', value: 'exact actual read' }
    await expect(delivery.delivered({ toolName: 'native_skill', toolCallId: 'missing-metadata', input: args, output, before: model, after: model }))
      .rejects.toThrow('guidance is unavailable')
    expect(persist).not.toHaveBeenCalled()
    expect(await readOpenSkillSessions(actor)).toEqual([])
  })
  it('reparsed lookalikes and failed reads cannot mint delivery authority', async () => {
    const turn = owner()
    const result = await turn.delivery.execute(args, async () => raw())
    await turn.send(JSON.parse(JSON.stringify(result)))
    const failed = await turn.delivery.execute(args, async () => ({ ...raw(), success: false, error: 'refused' }))
    await turn.send(failed)
    expect(turn.persist).not.toHaveBeenCalled()
    expect(await readOpenSkillSessions(actor)).toEqual([])
  })
  it('a changed final guarded model view refuses before any read persistence', async () => {
    const turn = owner()
    const result = await turn.delivery.execute(args, async () => raw())
    await expect(turn.send(result, 'cut', { type: 'text', value: 'original' }, { type: 'text', value: 'cut' })).rejects.toThrow('smaller window')
    expect(turn.persist).not.toHaveBeenCalled()
    expect(await readOpenSkillSessions(actor)).toEqual([])
  })
  it('Close during the source read wins over its late admission', async () => {
    const turn = owner()
    await turn.send(await turn.delivery.execute(args, async () => raw()), 'first')
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    let entered!: () => void
    const sourceEntered = new Promise<void>(resolve => { entered = resolve })
    const reading = turn.delivery.execute({ ...args, skillId: ' example ' }, async () => { entered(); await gate; return raw() })
    await sourceEntered
    await closeSkillSession({ ...actor, skillId: 'example', source: 'user' })
    resume()
    await expect(turn.send(await reading, 'late')).rejects.toThrow('closed while')
    expect(turn.persist).toHaveBeenCalledTimes(1)
    expect(await readOpenSkillSessions(actor)).toEqual([])
  })
  it('parallel actual reads from the same initial choice admit both windows', async () => {
    const turn = owner()
    const [one, two] = await Promise.all([turn.delivery.execute(args, async () => raw()), turn.delivery.execute(args, async () => ({ ...raw(), offset: 17 }))])
    await Promise.all([turn.send(one, 'one'), turn.send(two, 'two')])
    const [open] = await readOpenSkillSessions(actor)
    expect(open.reads).toHaveLength(2)
  })
})
