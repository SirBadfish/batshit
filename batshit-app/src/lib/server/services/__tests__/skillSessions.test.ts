// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin, useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
useSkillSessionCommitTwin()
import { openSkillSessionRead, readOpenSkillSessions, closeSkillSession, captureSkillSessionSnapshot, retainSkillSessionRead, deleteAgentSkillSessions,
  holdSkillSessionRead, closeSkillSessionFromZipAction, projectSkillSessionsForPendingMessage } from '../skillSessions'
import { buildOpenSkillsDcmLines, readSkillSessionRecord } from '$lib/utils/skillSessions'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { normalizeId } from '$lib/utils/idNormalizer'
import { applyAgentHoldChanges, markAgentBeingDeleted, advanceZipCountdowns } from '../zipHolds'
import { finalizeReplyControl } from '../replyControlFinalize'
import { POST as userHold } from '../../../../routes/api/unzipping/+server'
import { DELETE as userRelease } from '../../../../routes/api/unzipping/[zipId]/+server'
import { GET as listSkills, POST as userClose } from '../../../../routes/api/skill-sessions/+server'

// This suite owns no skill files and never seeds system packages into the real home directory.
vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: vi.fn(async () => {}) }))
useSkillSessionRedisTestServer()

const actor = { userId: 'skill-test-user', sessionId: 'skill-test-chat', agentId: 'skill-test-agent' }
let sequence = 0

beforeEach(async () => {
  for (const [key, value] of initializedBuiltinPluginEntries(actor.userId)) await redis.json.set(key, '$', value)
  await redis.createSession({ id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, title: 'Skill test' } as any)
  await redis.createAgent({ id: actor.agentId, user_id: actor.userId, name: 'Skill reader', agentType: 'api', jev_juice_skill_tool_hints: 'manage' } as any)
  await redis.json.set('batshit:typesafe_config', '$', { enabled: true })
  await redis.json.set(`slash_command:${actor.userId}:example`, '$', {
    id: 'example', user_id: actor.userId, type: 'skill', name: 'example', skill_id: 'example',
    enabled_for_all_agents: true, is_active: true, can_be_invoked_in_chat: true
  })
})

async function read(extra: Record<string, any> = {}, who = actor) {
  const rawZipId = `cool_tool_1790000000000_s${String(++sequence).padStart(4, '0')}x`
  const messageId = `skill-reply-${sequence}`
  const result = { success: true, action: 'read', skillId: 'example', skillName: 'Example', path: 'references/long.md', content: 'one window', ...extra }
  await redis.json.set(`zip:${rawZipId}`, '$', {
    id: rawZipId, type: 'cool_tool', tokens: 50, content: JSON.stringify({
      schemaVersion: 1, type: 'tool', toolName: 'skill_read', operationKind: 'skill_read',
      toolArgs: { skillId: 'example', action: 'read', path: result.path }, toolResult: result
    }), metadata: { sessionId: who.sessionId, messageId, operationKind: 'skill_read', promptTokens: 50, tokenBasis: 'ai_expanded' }
  })
  await redis.sAdd(`session:${who.sessionId}:zips`, rawZipId)
  return { rawZipId, messageId, zipId: normalizeId(rawZipId), ...who }
}

const item = (id: string) => redis.json.get(`unzipped_item:${actor.sessionId}:${id}`) as Promise<any>

describe('Primary skill lifecycle (fake normally; actual RedisJSON under test:redis)', () => {
  it('ordinary user Hold/Release uses one lifecycle owner and preserves other explicit holds', async () => {
    const target = await read()
    const automatic = await read({ path: 'references/second.md' })
    const explicit = await read({ path: 'references/kept.md' })
    for (const result of [target, automatic, explicit]) await openSkillSessionRead(result)
    await retainSkillSessionRead({ ...actor, zipId: explicit.zipId })
    const held = await userHold({ locals: { user: { id: actor.userId } }, request: new Request('http://test/api/unzipping', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zipId: target.zipId, sessionId: actor.sessionId,
        permanent: true, unzippedAt: 1, source: 'inferred', agentId: 'forged', path: 'forged',
        skillSession: { skillId: 'forged', generation: 666, automatic: true },
        skillSessionUserHold: { agentId: 'forged', skillId: 'forged', generation: 666, holdRevision: 666 },
        skillSessionContext: { skillId: 'forged' } })
    }) } as any)
    expect(held.status).toBe(200)
    const saved = await item(target.zipId)
    expect(saved.source).toBe('user')
    expect(saved.agentId).toBeUndefined()
    expect(saved.path).toBeUndefined()
    expect(saved.skillSession).toBeUndefined()
    expect(saved.skillSessionUserHold).toMatchObject({ agentId: actor.agentId, skillId: 'example', generation: 1 })
    const response = await userRelease({ locals: { user: { id: actor.userId } }, params: { zipId: target.zipId },
      url: new URL(`http://test/api/unzipping/${target.zipId}?sessionId=${actor.sessionId}&mode=automatic`) } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'skill_closed', skillClosure: {
      skillId: 'example', preservedZipIds: [explicit.zipId], reason: 'release'
    } })
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await item(target.zipId)).toBeNull()
    expect(await item(automatic.zipId)).toBeNull()
    expect((await item(explicit.zipId)).skillSession).toBeUndefined()
    const released = await applyAgentHoldChanges({ ...actor, projectPath: null, currentReply: null,
      blocks: [{ hold: [], release: ['example/references/kept.md'] }] })
    expect(released.errors).toEqual([])
    expect(released.released).toHaveLength(1)
  })

  it('FIRST scheduled expiry closes the skill and detaches/counts another temporary user pin', async () => {
    const first = await read()
    const second = await read({ path: 'references/second.md' })
    await openSkillSessionRead(first)
    await openSkillSessionRead(second)
    for (const [result, duration] of [[first, 1], [second, 5]] as const) {
      await holdSkillSessionRead({ userId: actor.userId, sessionId: actor.sessionId, zipId: result.zipId,
        item: { zipId: result.zipId, sessionId: actor.sessionId, source: 'user', permanent: false, duration, messageCount: 0, unzippedAt: 1 } })
    }
    const state = await redis.json.get(`skill_sessions:${actor.sessionId}`) as any
    const projection = projectSkillSessionsForPendingMessage(state, [await item(first.zipId), await item(second.zipId)], true)
    expect(projection.record.entries[0].status).toBe('closed')
    expect(projection.unzipped).toHaveLength(1)
    expect(projection.unzipped[0]).toMatchObject({ zipId: second.zipId, messageCount: 1 })
    expect(projection.unzipped[0].skillSessionUserHold).toBeUndefined()
    expect((await redis.json.get(`skill_sessions:${actor.sessionId}`) as any).entries[0].status).toBe('open')
    await advanceZipCountdowns(actor.sessionId)
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await item(first.zipId)).toBeNull()
    expect(await item(second.zipId)).toMatchObject({ source: 'user', messageCount: 1 })
    expect((await item(second.zipId)).skillSessionUserHold).toBeUndefined()
    expect(await redis.json.get(`rezipped_item:${actor.sessionId}:${first.zipId}`)).toMatchObject({ source: 'user', reason: 'user_skill_hold_expired' })
  })

  it('old-generation and superseded timers cannot close a newer required read', async () => {
    const old = await read({ offset: 0, returnedChars: 50, originalChars: 100, sourceSha256: 'a'.repeat(64) })
    await openSkillSessionRead(old)
    const timed = await holdSkillSessionRead({ userId: actor.userId, sessionId: actor.sessionId, zipId: old.zipId,
      item: { zipId: old.zipId, sessionId: actor.sessionId, permanent: false, duration: 1, messageCount: 0, unzippedAt: 1 } })
    const whole = await read({ offset: 0, returnedChars: 100, originalChars: 100, sourceSha256: 'b'.repeat(64) })
    await openSkillSessionRead(whole)
    await advanceZipCountdowns(actor.sessionId)
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect((await item(whole.zipId)).skillSession.automatic).toBe(true)
    await closeSkillSession({ ...actor, skillId: 'example', provenance: 'user' })
    const fresh = await read()
    await openSkillSessionRead(fresh)
    expect(await closeSkillSessionFromZipAction({ userId: actor.userId, sessionId: actor.sessionId,
      zipId: old.zipId, reason: 'expiry', expectedExpiry: timed!.skillSessionUserHold })).toBeNull()
    expect((await readOpenSkillSessions(actor))[0].generation).toBe(2)
  })

  it('real Tool Notes finalization retains every window of the explicitly held skill file', async () => {
    const first = await read({ offset: 0, originalChars: 100, returnedChars: 50, sourceSha256: 'a'.repeat(64) })
    const second = await read({ offset: 50, originalChars: 100, returnedChars: 50, sourceSha256: 'a'.repeat(64) })
    await openSkillSessionRead(first)
    await openSkillSessionRead(second)
    const [before] = await captureSkillSessionSnapshot(actor)
    const finalized = await finalizeReplyControl({ ...actor, messageId: 'retain-reply', agent: { id: actor.agentId }, globalZipSettings: {},
      content: '<batshit-tool-notes>{"hold":["example/references/long.md"]}</batshit-tool-notes>',
      replyZipIds: [], projectPath: null, countsAsMessage: true })
    expect(finalized.metadata.controlErrors).toBeUndefined()
    expect(finalized.metadata.zipHolds.held).toHaveLength(2)
    expect(finalized.zipStateChanged).toBe('agent')
    expect((await item(first.zipId)).skillSession.automatic).toBe(false)
    expect((await item(second.zipId)).skillSession.automatic).toBe(false)
    expect((await captureSkillSessionSnapshot(actor))[0].revision).toBeGreaterThan(before.revision)
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'inferred', expected: before })).status).toBe('refused')
    const next = await read({ offset: 0, originalChars: 100, returnedChars: 100, sourceSha256: 'b'.repeat(64) })
    await openSkillSessionRead(next)
    expect((await item(next.zipId)).skillSession.automatic).toBe(false)
    expect(await item(first.zipId)).toBeNull()
    expect(await item(second.zipId)).toBeNull()
    expect((await readOpenSkillSessions(actor))[0].reads.map((read) => read.zipId)).toEqual([next.zipId])
  })

  it('a new whole read replaces old windows while preserving a user-pinned original copy', async () => {
    const first = await read({ offset: 0, originalChars: 100, returnedChars: 50, sourceSha256: 'a'.repeat(64) })
    const second = await read({ offset: 50, originalChars: 100, returnedChars: 50, sourceSha256: 'a'.repeat(64) })
    await openSkillSessionRead(first)
    await openSkillSessionRead(second)
    await redis.json.set(`unzipped_item:${actor.sessionId}:${first.zipId}`, '$', { zipId: first.zipId, sessionId: actor.sessionId,
      source: 'user', permanent: true, unzippedAt: 3 })
    const whole = await read({ offset: 0, originalChars: 100, returnedChars: 100, sourceSha256: 'b'.repeat(64) })
    await openSkillSessionRead(whole)
    expect((await readOpenSkillSessions(actor))[0].reads.map((read) => read.zipId)).toEqual([first.zipId, whole.zipId])
    expect((await item(first.zipId)).source).toBe('user')
    expect(await item(second.zipId)).toBeNull()
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'agent' })).status).toBe('refused')
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('message and session deletion sweep lifecycle metadata on actual DB15', async () => {
    const first = await read()
    await openSkillSessionRead(first)
    await redis.saveMessage({ id: first.messageId, session_id: actor.sessionId, user_id: actor.userId,
      agent_id: actor.agentId, role: 'assistant', content: `{{batshit-zip:${first.rawZipId}:::Example}}`,
      created_at: new Date().toISOString(), metadata: { zipIds: [first.rawZipId] } } as any)
    await redis.deleteMessage(first.messageId, actor.sessionId, actor.userId)
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await item(first.zipId)).toBeNull()
    expect((await redis.json.get(`skill_sessions:${actor.sessionId}`) as any).entries[0].status).toBe('closed')
    await redis.deleteSession(actor.sessionId)
    expect(await redis.json.get(`skill_sessions:${actor.sessionId}`)).toBeNull()
  })

  it('deleting an agent releases its skill holds atomically and removes only its lifecycle rows', async () => {
    const first = await read()
    await openSkillSessionRead(first)
    const released = await deleteAgentSkillSessions(actor.agentId, actor.userId)
    expect(released).toEqual([{ sessionId: actor.sessionId, zipId: first.zipId }])
    expect(await item(first.zipId)).toBeNull()
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect((await redis.json.get(`skill_sessions:${actor.sessionId}`) as any).entries).toEqual([])
  })

  it('retains separately versioned windows instead of assembling old/new skill sources', async () => {
    const old = await read({ offset: 0, originalChars: 100, returnedChars: 50, sourceSha256: 'a'.repeat(64) })
    const current = await read({ offset: 50, originalChars: 100, returnedChars: 50, sourceSha256: 'b'.repeat(64) })
    await openSkillSessionRead(old)
    await openSkillSessionRead(current)
    expect((await readOpenSkillSessions(actor))[0].reads.map((window) => [window.offset, window.sourceSha256])).toEqual([
      [0, 'a'.repeat(64)], [50, 'b'.repeat(64)]
    ])
  })
  it('holds every admitted window, and an explicit bare-id release compresses all immediately', async () => {
    const first = await read({ offset: 0, contentTruncated: true, originalChars: 24000 })
    const second = await read({ offset: 12000, originalChars: 24000 })
    expect(await openSkillSessionRead(first)).toBe(true)
    expect(await openSkillSessionRead(second)).toBe(true)
    const sessions = await readOpenSkillSessions(actor)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].reads.map((r) => r.zipId)).toEqual([first.zipId, second.zipId])
    expect((await item(first.zipId)).skillSession.automatic).toBe(true)
    expect((await item(second.zipId)).permanent).toBe(true)
    const result = await applyAgentHoldChanges({ ...actor, projectPath: null, blocks: [{ hold: [], release: ['example'] }], currentReply: null })
    expect(result.errors).toEqual([])
    expect(result.released).toHaveLength(2)
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await redis.sMembers(`rezipped:${actor.sessionId}`)).toEqual(expect.arrayContaining([first.zipId, second.zipId]))
  })

  it('does not reopen a closed skill when an old admission is replayed, but a new read reopens', async () => {
    const first = await read()
    await openSkillSessionRead(first)
    await closeSkillSession({ ...actor, skillId: 'example', provenance: 'agent' })
    expect(await openSkillSessionRead(first)).toBe(false)
    const fresh = await read()
    await openSkillSessionRead(fresh)
    expect((await readOpenSkillSessions(actor))[0].generation).toBe(2)
    expect(await openSkillSessionRead(first)).toBe(false)
  })

  it('an explicit hold protects automatic reads from an inferred close', async () => {
    const first = await read()
    await openSkillSessionRead(first)
    const [snapshot] = await captureSkillSessionSnapshot(actor)
    await retainSkillSessionRead({ ...actor, zipId: first.zipId })
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'inferred', expected: snapshot })).status).toBe('refused')
    const [current] = await captureSkillSessionSnapshot(actor)
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'inferred', expected: current })).status).toBe('refused')
    expect((await item(first.zipId)).skillSession.automatic).toBe(false)
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'agent' })).status).toBe('closed')
  })

  it('a later actual read invalidates an earlier inferred close snapshot', async () => {
    await openSkillSessionRead(await read())
    const [snapshot] = await captureSkillSessionSnapshot(actor)
    await openSkillSessionRead(await read({ offset: 12 }))
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'inferred', expected: snapshot })).status).toBe('refused')
  })

  it('inferred closure can close an unchanged automatic session only while management/master remain on', async () => {
    await openSkillSessionRead(await read())
    const [snapshot] = await captureSkillSessionSnapshot(actor)
    await redis.json.set('batshit:typesafe_config', '$.enabled', false)
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'inferred', expected: snapshot })).status).toBe('refused')
    await redis.json.set('batshit:typesafe_config', '$.enabled', true)
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'inferred', expected: snapshot })).status).toBe('closed')
  })

  it('preserves user pins on agent close, while human Close deliberately closes the targeted skill', async () => {
    const first = await read()
    await openSkillSessionRead(first)
    await redis.json.set(`unzipped_item:${actor.sessionId}:${first.zipId}`, '$', {
      zipId: first.zipId, sessionId: actor.sessionId, source: 'user', permanent: true, unzippedAt: 3
    })
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'agent' })).status).toBe('refused')
    expect((await closeSkillSession({ ...actor, skillId: 'example', provenance: 'user' })).status).toBe('closed')
    expect(await item(first.zipId)).toBeNull()
  })

  it('refuses the 25,000-token transcript before creating lifecycle or hold state', async () => {
    const first = await read()
    await redis.json.set(`zip:${first.rawZipId}`, '$.metadata.promptTokens', 25000)
    await expect(openSkillSessionRead(first)).rejects.toThrow('too large to hold')
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await item(first.zipId)).toBeNull()
  })

  it('never opens for an absent/deleting actor or a zip from another reply', async () => {
    const first = await read()
    await expect(openSkillSessionRead({ ...first, messageId: 'someone-elses-reply' })).rejects.toThrow('does not belong')
    const release = markAgentBeingDeleted(actor.agentId)
    try { await expect(openSkillSessionRead(first)).rejects.toThrow('unavailable') } finally { release() }
  })

  it('keeps separate group actors isolated and closes only the chosen row', async () => {
    const other = { ...actor, agentId: 'skill-other-agent' }
    await redis.createAgent({ id: other.agentId, user_id: actor.userId, name: 'Other', agentType: 'cli' } as any)
    await openSkillSessionRead(await read())
    const otherRead = await read({}, other)
    await openSkillSessionRead(otherRead)
    await closeSkillSession({ ...actor, skillId: 'example', provenance: 'user' })
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await readOpenSkillSessions(other)).toHaveLength(1)
    expect((await item(otherRead.zipId)).agentId).toBe(other.agentId)
  })

  it('does not turn unreadable lifecycle data into an empty list', async () => {
    await redis.json.set(`skill_sessions:${actor.sessionId}`, '$', { version: 9 })
    await expect(readOpenSkillSessions(actor)).rejects.toThrow('unreadable')
  })

  it('keeps human list/Close usable for an unavailable original reader without allowing recovery or new reads', async () => {
    const first = await read()
    await openSkillSessionRead(first)
    await redis.del(`agent:${actor.agentId}`)
    const list = await listSkills({ url: new URL(`http://localhost/api/skill-sessions?sessionId=${actor.sessionId}`),
      locals: { user: { id: actor.userId } } } as any)
    expect(list.status).toBe(200)
    const { skills } = await list.json()
    expect(skills).toHaveLength(1)
    const response = await userClose({ request: new Request('http://localhost/api/skill-sessions', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: actor.sessionId, ...skills[0] }) }),
      locals: { user: { id: actor.userId } } } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'closed' })
    expect(await redis.json.get(`unzipped_item:${actor.sessionId}:${first.zipId}`)).toBeNull()
  })

  it('has DCM lines only while open and calculates age from the chat message list', async () => {
    expect(buildOpenSkillsDcmLines([])).toEqual([])
    const first = await read()
    await openSkillSessionRead(first)
    await redis.rPush(`messages:${actor.sessionId}`, first.messageId)
    await redis.rPush(`messages:${actor.sessionId}`, 'next-user')
    const sessions = await readOpenSkillSessions(actor)
    expect(sessions[0].openMessages).toBe(1)
    expect(buildOpenSkillsDcmLines(sessions).join('\n')).toContain('release')
    expect(readSkillSessionRecord(await redis.json.get(`skill_sessions:${actor.sessionId}`), actor.sessionId)?.entries).toHaveLength(1)
  })
})
