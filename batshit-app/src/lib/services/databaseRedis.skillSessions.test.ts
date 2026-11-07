import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin } from '$lib/test-utils/skillSessionCommitTwin'
useSkillSessionCommitTwin()
import { DatabaseService } from './databaseRedis.server'
import { compileForAI } from './messageCompiler'
import { createZipStateView, type UnzippedItem } from './zipping'
import type { SkillSessionRecord } from '$lib/utils/skillSessions'
import { readFileSync } from 'node:fs'
import path from 'node:path'

useRedisTestServer()
const actor = { userId: 'skill-compile-user', sessionId: 'skill-compile-chat', agentId: 'skill-compile-agent' }
const record: SkillSessionRecord = { version: 1, userId: actor.userId, sessionId: actor.sessionId, entries: [{
  agentId: actor.agentId, skillId: 'example', name: 'Example', status: 'open', generation: 1, revision: 1,
  openedAt: 1, openedMessageId: 'opened-reply', reads: [{ rawZipId: 'cool_tool_1790000000000_sxxx', zipId: 'cool_tool_1790000000000_sxxx', messageId: 'opened-reply', path: 'SKILL.md' }]
}] }

beforeEach(async () => {
  await redis.createSession({ id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, title: 'Skill compile' } as any)
  for (const id of [actor.agentId, 'other-agent']) await redis.createAgent({ id, user_id: actor.userId, name: id, agentType: 'api' } as any)
  await redis.json.set(`skill_sessions:${actor.sessionId}`, '$', record as any)
  await redis.rPush(`messages:${actor.sessionId}`, 'opened-reply')
  await redis.rPush(`messages:${actor.sessionId}`, 'later-user')
})

async function dcm(agentId = actor.agentId) {
  return (await (new DatabaseService() as any).buildDynamicInfoBlock({
    ...actor, agentId, agentRecord: { id: agentId },
    toolIndex: { text: '', discoverable: [], resolvedGatewayIds: null, setupBlocks: [], sources: [],
      hintBudget: { limit: 3000, budgetedTokens: 0, featureTokens: 0 } },
    skillsCommandsDcm: { lines: [], capabilities: [] }
  })).text as string
}

describe('skill lifecycle in the canonical DCM and saved-read compile', () => {
  it('renders the approved skill sentence once through packaged placeholders and blank fallback, preserving custom text', async () => {
    const service = new DatabaseService() as any
    const template = readFileSync(path.resolve(process.cwd(), '../docs/batshit_System_Prompts/batshit_tool_prompt_zips.md'), 'utf8')
    const sentence = 'Reading a skill opens it in this chat and keeps its reads in context. When its task is done, close it by putting its skill id in Tool Notes release.'
    for (const runtimeFlavor of ['vercel', 'claude']) {
      const options = { notesEnabled: true, agent: {}, zipViewMode: 'appended', runtimeFlavor }
      await redis.execute((client) => client.set('batshit:tool_guidance_zip_prompt', template))
      const packaged = await service.resolveToolZipGuidancePrompt(options)
      expect(packaged.split(sentence)).toHaveLength(2)
      await redis.del('batshit:tool_guidance_zip_prompt')
      const fallback = await service.resolveToolZipGuidancePrompt(options)
      expect(fallback.split(sentence)).toHaveLength(2)
      const custom = 'User custom zip guidance stays exact.'
      await redis.execute((client) => client.set('batshit:tool_guidance_zip_prompt', custom))
      expect(await service.resolveToolZipGuidancePrompt(options)).toBe(custom)
    }
  })

  it('builds live DCM only for this chat/agent and writes nothing', async () => {
    const before = await redis.json.get(`skill_sessions:${actor.sessionId}`)
    expect(await dcm()).toContain('Example (example, open 1 messages)')
    expect(await dcm('other-agent')).not.toContain('open_skills')
    expect(await redis.json.get(`skill_sessions:${actor.sessionId}`)).toEqual(before)
    await redis.json.set(`skill_sessions:${actor.sessionId}`, '$', { ...record, entries: record.entries.map((entry) => ({ ...entry, status: 'closed' })) } as any)
    expect(await dcm()).not.toContain('open_skills')
  })

  it('keeps a skill read open beyond any former buffer, then compresses immediately on Close', async () => {
    const zipId = record.entries[0].reads[0].zipId
    const content = `{{batshit-zip:${zipId}:::Skill example}}`
    const zip = { id: zipId, type: 'cool_tool', tokens: 100, content: JSON.stringify({
      schemaVersion: 1, type: 'tool', toolName: 'skill_read', operationKind: 'skill_read',
      toolArgs: { skillId: 'example', action: 'read', path: 'SKILL.md' },
      toolResult: { skillId: 'example', action: 'read', content: 'Unique procedure text' }
    }), metadata: { operationKind: 'skill_read', promptTokens: 100, tokenBasis: 'ai_expanded' } }
    const held: UnzippedItem = { zipId, sessionId: actor.sessionId, permanent: true, source: 'agent',
      unzippedAt: 1, agentId: actor.agentId, path: 'skill:example:SKILL.md',
      skillSession: { skillId: 'example', generation: 1, automatic: true } }
    const message = { id: 'opened-reply', role: 'assistant', agent_id: actor.agentId, content, metadata: { zipIds: [zipId] } }
    const open = await compileForAI(content, 0, 100, { id: actor.agentId }, message, {}, {
      agentMessagesFromEnd: 99, zipViewMode: 'inline', zipResolver: async () => zip as any,
      zipState: createZipStateView([held])
    })
    expect(open).toContain('Unique procedure text')
    expect(open).not.toContain('Compresses')
    const closed = await compileForAI(content, 0, 1, { id: actor.agentId }, message, {}, {
      agentMessagesFromEnd: 0, zipViewMode: 'inline', zipResolver: async () => zip as any,
      zipState: createZipStateView([], [zipId], { [zipId]: 'agent' })
    })
    expect(closed).not.toContain('Unique procedure text')
    expect(closed).toContain(zipId)
  })
})
