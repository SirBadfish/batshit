// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin } from '$lib/test-utils/skillSessionCommitTwin'
useSkillSessionCommitTwin()
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { openSkillSessionRead, readSkillSessionRecordForCompile } from '../skillSessions'
import { recoverOpenSkillReadMessages } from '../skillSessionCompile'
import { DatabaseService } from '$lib/services/databaseRedis.server'
import { createZipStateView, type UnzippedItem } from '$lib/services/zipping'
import { skillSourceSha256 } from '../skillReadWindow'

vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))
useRedisTestServer()

const actor = { userId: 'skill-recovery-user', sessionId: 'skill-recovery-chat', agentId: 'skill-recovery-agent' }
const windows = ['First original procedure window.', 'Second original procedure window.']
const zipIds = ['cool_tool_1790000000000_recov1', 'cool_tool_1790000000000_recov2']

beforeEach(async () => {
  for (const [key, value] of initializedBuiltinPluginEntries(actor.userId)) await redis.json.set(key, '$', value)
  await redis.createSession({ id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, title: 'Recovery' } as any)
  await redis.createAgent({ id: actor.agentId, user_id: actor.userId, name: 'Reader', agentType: 'api' } as any)
  await redis.json.set(`slash_command:${actor.userId}:example`, '$', { id: 'example', user_id: actor.userId, name: 'example',
    type: 'skill', skill_id: 'example', is_active: true, can_be_invoked_in_chat: true, enabled_for_all_agents: true })
  await redis.saveMessage({ id: 'original-user', session_id: actor.sessionId, user_id: actor.userId, role: 'user', content: 'Use the skill.', created_at: '2026-10-25T00:00:00Z' } as any)
  for (let index = 0; index < zipIds.length; index += 1) {
    const content = windows[index]
    await redis.json.set(`zip:${zipIds[index]}`, '$', { id: zipIds[index], type: 'cool_tool', description: `Skill example window ${index + 1}`, tokens: 100,
      metadata: { operationKind: 'skill_read', sessionId: actor.sessionId, messageId: 'read-opener', promptTokens: 100, tokenBasis: 'ai_expanded' },
      content: JSON.stringify({ schemaVersion: 1, type: 'tool', toolName: 'native_skill', operationKind: 'skill_read',
        toolArgs: { skillId: 'example', action: 'read', path: 'SKILL.md' }, toolResult: { success: true, action: 'read', skillId: 'example', path: 'SKILL.md', content,
          offset: index === 0 ? 0 : windows[0].length, returnedChars: content.length, originalChars: windows.join('').length, sourceSha256: skillSourceSha256(windows.join('')) } }) })
    await redis.sAdd(`session:${actor.sessionId}:zips`, zipIds[index])
    await openSkillSessionRead({ ...actor, rawZipId: zipIds[index], messageId: 'read-opener' })
  }
  await redis.saveMessage({ id: 'read-opener', session_id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, role: 'assistant',
    content: zipIds.map((id) => `{{batshit-zip:${id}:::Original skill read}}`).join('\n'), metadata: { zipIds }, created_at: '2026-10-25T00:00:01Z' } as any)
  await redis.saveMessage({ id: 'later-user', session_id: actor.sessionId, user_id: actor.userId, role: 'user', content: 'Continue the same task.', created_at: '2026-10-25T00:00:02Z' } as any)
})

async function source() {
  const record = await readSkillSessionRecordForCompile(actor)
  const unzipped = await Promise.all((await redis.sMembers(`unzipped:${actor.sessionId}`)).map((id) => redis.json.get(`unzipped_item:${actor.sessionId}:${id}`))) as unknown as UnzippedItem[]
  const later = await redis.json.get(`message:${actor.sessionId}:later-user`) as any
  return { record, unzipped, messages: [later], agentId: actor.agentId }
}

describe('canonical retained-skill read recovery (no current skill/file loads)', () => {
  it('refuses recovery after current access is revoked without reseeding the catalogue', async () => {
    const input = await source()
    await redis.json.set(`slash_command:${actor.userId}:example`, '$.enabled_for_all_agents', false)
    await redis.json.set(`slash_command:${actor.userId}:example`, '$.enabled_agent_ids', [])
    const { ensureSystemSlashCommands } = await import('../systemSlashCommands')
    vi.mocked(ensureSystemSlashCommands).mockClear()
    await expect(recoverOpenSkillReadMessages(input)).rejects.toThrow('unavailable to its original reader')
    expect(ensureSystemSlashCommands).not.toHaveBeenCalled()
    // Already-present history remains under its established history/zip access rules.
    const original = await redis.json.get(`message:${actor.sessionId}:read-opener`) as any
    await expect(recoverOpenSkillReadMessages({ ...input, messages: [original, ...input.messages] })).resolves.toHaveLength(2)
  })

  it.each(['missing', 'foreign', 'replaced', 'unbound'] as const)('refuses an absent-history read whose original reader is %s', async (change) => {
    const input = await source()
    const reader = await redis.json.get(`agent:${actor.agentId}`) as any
    if (change === 'unbound') delete input.record.entries[0].agentCreatedAt
    else if (change === 'missing') await redis.del(`agent:${actor.agentId}`)
    else await redis.json.set(`agent:${actor.agentId}`, '$', { ...reader,
      ...(change === 'foreign' ? { user_id: 'different-owner' } : { created_at: 'different-incarnation' }) })
    await expect(recoverOpenSkillReadMessages(input)).rejects.toThrow('original reader')
  })

  it.each(['inline', 'appended'] as const)('recovers exact original windows in %s layout with original author and no duplicate', async (layout) => {
    const input = await source()
    const before = await redis.json.get(`skill_sessions:${actor.sessionId}`)
    await redis.json.set(`skill:${actor.userId}:example`, '$', { skill_markdown: 'NEW CURRENT SKILL MUST NOT BE INJECTED' })
    const recovered = await recoverOpenSkillReadMessages(input)
    expect(recovered.map((message) => message.id)).toEqual(['read-opener', 'later-user'])
    expect((recovered[0] as any).agent_id).toBe(actor.agentId)
    expect(await recoverOpenSkillReadMessages({ ...input, messages: recovered })).toEqual(recovered)
    const service = new DatabaseService() as any
    const agent = { id: actor.agentId, user_id: actor.userId, agentType: 'api', zip_ai_view_mode: layout }
    const speakers = await service.buildSpeakerView(recovered, agent)
    const compiled = await service.compileChatHistory(recovered, agent, {}, {
      zipState: createZipStateView(input.unzipped), zipOwner: { sessionId: actor.sessionId, userId: actor.userId }
    }, speakers)
    for (const window of windows) expect(compiled.chatHistory.split(window)).toHaveLength(2)
    expect(compiled.chatHistory).not.toContain('NEW CURRENT SKILL')
    expect(compiled.addressSources.some((piece: any) => piece.source === 'agent_words' && piece.messageId === 'read-opener')).toBe(true)
    for (const window of windows) expect(compiled.addressSources.some((piece: any) => piece.source === 'tool_result' && piece.text.includes(window))).toBe(true)
    expect(await redis.json.get(`skill_sessions:${actor.sessionId}`)).toEqual(before)
  })

  it('preserves group sharing: another agent gets no unshared recovery and only original-author shared data', async () => {
    const input = await source()
    const hidden = await recoverOpenSkillReadMessages({ ...input, agentId: 'other-agent',
      groupToolSharing: { currentAgentId: 'other-agent', sharedTools: [] } })
    expect(hidden).toEqual(input.messages)
    const shared = await recoverOpenSkillReadMessages({ ...input, agentId: 'other-agent',
      groupToolSharing: { currentAgentId: 'other-agent', sharedTools: ['skill_read'] } })
    expect(shared[0]).toMatchObject({ id: 'read-opener', agent_id: actor.agentId })
  })

  it('does not duplicate original results already carried by a verified same-reply API replay', async () => {
    const input = await source()
    expect(await recoverOpenSkillReadMessages({ ...input, replayedMessageIds: new Set(['read-opener']) })).toEqual(input.messages)
  })

  it('fails visibly for missing or changed original persisted sources rather than rereading current SKILL.md', async () => {
    const input = await source()
    const original = await redis.json.get(`zip:${zipIds[0]}`) as any
    await redis.del(`zip:${zipIds[0]}`)
    await expect(recoverOpenSkillReadMessages(input)).rejects.toThrow('cannot be verified')
    await redis.json.set(`zip:${zipIds[0]}`, '$', { ...original, content: original.content.replace(windows[0], 'Different procedure bytes') })
    await expect(recoverOpenSkillReadMessages(input)).rejects.toThrow('changed')
  })
})
