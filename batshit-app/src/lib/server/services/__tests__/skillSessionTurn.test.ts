// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin } from '$lib/test-utils/skillSessionCommitTwin'
useSkillSessionCommitTwin()
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { openSkillSessionRead, readOpenSkillSessions } from '../skillSessions'
import { buildSkillSessionTurn, skillTurnHasUnfinishedTools } from '../skillSessionTurn'
import { SKILL_SESSION_COMMIT_SCRIPT } from '../skillSessionCommit'
import { withSettingsRecordReplacement } from '../appActions/settings/lifecycle'

const mocks = vi.hoisted(() => ({ compute: vi.fn(), append: vi.fn(async (..._args: any[]) => true), publish: vi.fn(async () => {}) }))
vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))
vi.mock('../skillSessions.jev', () => ({ computeSkillSessionCloses: mocks.compute }))
vi.mock('../typesafe/typesafeEvidence', async (original) => ({ ...await original<any>(), appendTypesafeCallRecords: mocks.append }))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: mocks.publish }))
useRedisTestServer()

const actor = { userId: 'skill-turn-user', sessionId: 'skill-turn-chat', agentId: 'skill-turn-agent' }
const rawZipId = 'cool_tool_1790000000000_turn1'
const post = { lineageComplete: true, messageId: 'final-reply', request: 'Review the result and finish.', reply: 'The work is finished.', recentUserIntent: ['Keep the original task in view.'],
  earlierParts: [{ text: 'The first part before approval.', zipIds: [], toolSteps: [], inlineControls: [], memorySaveAttempted: false }],
  toolSteps: [], origin: 'trusted_resume' as const }

beforeEach(async () => {
  vi.clearAllMocks()
  for (const [key, value] of initializedBuiltinPluginEntries(actor.userId)) await redis.json.set(key, '$', value)
  await redis.createSession({ id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, title: 'Skill turn' } as any)
  await redis.createAgent({ id: actor.agentId, user_id: actor.userId, name: 'Reader', agentType: 'api', jev_juice_skill_tool_hints: 'manage' } as any)
  await redis.json.set('batshit:typesafe_config', '$', { enabled: true })
  await redis.json.set(`slash_command:${actor.userId}:example`, '$', { id: 'example', user_id: actor.userId,
    name: 'example', type: 'skill', skill_id: 'example', enabled_for_all_agents: true, is_active: true, can_be_invoked_in_chat: true })
  await redis.saveMessage({ id: 'original-user', session_id: actor.sessionId, user_id: actor.userId, role: 'user', content: 'Create the full requested artifact, then review it.', created_at: '2026-10-25T00:00:00Z' } as any)
  await redis.saveMessage({ id: 'opened-reply', session_id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId,
    role: 'assistant', content: `{{batshit-zip:${rawZipId}:::Example}}`, metadata: { zipIds: [rawZipId] }, created_at: '2026-10-25T00:00:01Z' } as any)
  await redis.json.set(`zip:${rawZipId}`, '$', { id: rawZipId, type: 'cool_tool', tokens: 50,
    metadata: { sessionId: actor.sessionId, messageId: 'opened-reply', operationKind: 'skill_read', promptTokens: 50, tokenBasis: 'ai_expanded' },
    content: JSON.stringify({ schemaVersion: 1, type: 'tool', toolName: 'skill_read', operationKind: 'skill_read',
      toolArgs: { action: 'invoke', skillId: 'example' }, toolResult: { success: true, action: 'invoke', skillId: 'example', content: '# Procedure',
        sourceSha256: 'a'.repeat(64), offset: 0, returnedChars: 11, originalChars: 11 } }) })
  await redis.sAdd(`session:${actor.sessionId}:zips`, rawZipId)
  await openSkillSessionRead({ ...actor, rawZipId, messageId: 'opened-reply' })
  await redis.saveMessage({ id: 'current-user', session_id: actor.sessionId, user_id: actor.userId, role: 'user', content: post.request, created_at: '2026-10-25T00:00:02Z' } as any)
  await redis.saveMessage({ id: 'earlier-part', session_id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId,
    role: 'assistant', content: post.earlierParts[0].text, intermediateSteps: [], metadata: { response_failed: true }, created_at: '2026-10-25T00:00:03Z' } as any)
  await redis.saveMessage({ id: post.messageId, session_id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId,
    role: 'assistant', content: post.reply, intermediateSteps: [], created_at: '2026-10-25T00:00:04Z' } as any)
  mocks.compute.mockImplementation(async (input) => ({ record: { feature: 'skill_tool_hints', model: 'jev-test', status: 'ok', detail: '',
    latencyMs: 1, usage: null, deadlineHit: false, questionCount: 2 }, note: null, skipped: [],
    decision: { close: [{ candidate: input.candidates[0], completed: 0.99, again: 0.01 }], kept: [], summary: 'close' } }))
})

describe('skill session whole-reply application and tell', () => {
  it.each(['earlier-part', post.messageId])('never certifies a whole reply from an own-copy stream gap in %s', async (messageId) => {
    await redis.json.set(`message:${actor.sessionId}:${messageId}`, '$.metadata', { response_failed: messageId === 'earlier-part', replySavedFromOwnCopy: true })
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
    expect(mocks.compute).not.toHaveBeenCalled()
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect(mocks.append.mock.calls[0][2][0].detail).toContain('No judge request was sent')
  })

  it('records a stale lifecycle fence as a known refusal before issue rather than an unconfirmed write', async () => {
    const decide = mocks.compute.getMockImplementation()!
    let afterJudgment = false
    let replaced = false
    mocks.compute.mockImplementation(async (input) => { const answer = await decide(input); afterJudgment = true; return answer })
    const originalGet = vi.mocked(redis.json.getRaw).getMockImplementation()!
    const read = vi.spyOn(redis.json, 'getRaw').mockImplementation(async (key, path) => {
      if (afterJudgment && !replaced && key === `message:${actor.sessionId}:${post.messageId}`) {
        replaced = true
        // Invalidates the already captured actor lease after policy/access checks, with
        // no Redis change that could independently trip the raw-source CAS.
        await withSettingsRecordReplacement(`agent:${actor.agentId}`, async () => {})
      }
      return originalGet(key, path)
    })
    try {
      await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
      expect(replaced).toBe(true)
      expect(await readOpenSkillSessions(actor)).toHaveLength(1)
      const detail = mocks.append.mock.calls[0][2][0].detail
      expect(detail).toContain('refused')
      expect(detail).not.toContain('unconfirmed')
      expect(mocks.publish).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
  })

  it.each(['mode', 'master', 'access', 'user'] as const)('rejects %s changed after policy checks at the actual atomic issue boundary', async (change) => {
    const originalExecute = redis.execute
    let injected = false
    const issue = vi.spyOn(redis, 'execute').mockImplementation(async (operation: any) => originalExecute(async (client: any) =>
      operation(new Proxy(client, { get(target, property) {
        if (property !== 'eval') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (script: string, options: any) => {
          if (script === SKILL_SESSION_COMMIT_SCRIPT && !injected) {
            injected = true
            if (change === 'mode') await redis.json.set(`agent:${actor.agentId}`, '$.jev_juice_skill_tool_hints', 'off')
            else if (change === 'master') await redis.json.set('batshit:typesafe_config', '$.enabled', false)
            else if (change === 'access') await redis.json.set(`slash_command:${actor.userId}:example`, '$.is_active', false)
            else await redis.saveMessage({ id: 'atomic-new-user', session_id: actor.sessionId, user_id: actor.userId, role: 'user',
              content: 'Continue using the open skill.', created_at: '2026-10-25T00:00:09Z' } as any)
          }
          return target.eval(script, options)
        }
      } }))))
    try {
      await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
      expect(injected).toBe(true)
      expect(await readOpenSkillSessions(actor)).toHaveLength(1)
      expect(mocks.append.mock.calls[0][2][0].detail).toContain('refused')
      expect(mocks.publish).not.toHaveBeenCalled()
    } finally { issue.mockRestore() }
  })

  it('missing verified resume lineage suppresses the judgment and leaves older skills open', async () => {
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn({ ...post, lineageComplete: false, request: 'Approval received.' })
    expect(mocks.compute).not.toHaveBeenCalled()
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect(mocks.append.mock.calls[0][2][0].detail).toContain('whole reply lineage')
  })

  it('a strict original-source read failure cannot become a partial task', async () => {
    const read = vi.isMockFunction(redis.json.getRaw) ? vi.mocked(redis.json.getRaw).getMockImplementation()! : redis.json.getRaw.bind(redis.json)
    const spy = vi.spyOn(redis.json, 'getRaw').mockImplementation(async (key: string, ...args: any[]) => {
      if (key === `message:${actor.sessionId}:original-user`) throw new Error('Injected source read failure')
      return (read as any)(key, ...args)
    })
    try {
      await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
      expect(mocks.compute).not.toHaveBeenCalled()
      expect(await readOpenSkillSessions(actor)).toHaveLength(1)
      expect(mocks.append.mock.calls[0][2][0].detail).toContain('No judge request was sent')
    } finally { spy.mockRestore() }
  })

  it('a newer saved user turn arriving during judgment defeats an otherwise unchanged close', async () => {
    const decide = mocks.compute.getMockImplementation()!
    mocks.compute.mockImplementation(async (input) => {
      await redis.saveMessage({ id: 'new-user-intent', session_id: actor.sessionId, user_id: actor.userId, role: 'user',
        content: 'Keep using this skill for the next step.', created_at: '2026-10-25T00:00:05Z' } as any)
      return decide(input)
    })
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect(mocks.append.mock.calls[0][2][0].detail).toContain('refused')
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('logs a missed evidence attachment without changing the already stored closure outcome', async () => {
    mocks.append.mockResolvedValueOnce(false)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
      expect(await readOpenSkillSessions(actor)).toEqual([])
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not attach'), expect.any(Object))
    } finally { warning.mockRestore() }
  })
  it('uses the original task plus all reply parts, applies shared close, records actual outcome and tells once', async () => {
    const turn = buildSkillSessionTurn({ ...actor, isGroupTurn: false })
    await turn.runPostTurn(post)
    const input = mocks.compute.mock.calls[0][0]
    expect(input.candidates[0].taskRequest).toBe('Create the full requested artifact, then review it.')
    expect(input.candidates[0].readWindowsComplete).toBe(true)
    expect(input.evidence.reply).toContain('The first part before approval.')
    expect(input.evidence.reply).toContain('The work is finished.')
    expect(input.evidence.origin).toBe('trusted_resume')
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(mocks.append.mock.calls[0][2][0].detail).toContain('example: closed')
    expect(mocks.publish).toHaveBeenCalledWith(actor.userId, expect.objectContaining({ type: 'zip_state_changed', source: 'inferred' }))
    const next = buildSkillSessionTurn({ ...actor, isGroupTurn: false })
    expect((await next.hintProvider({} as any)).join('\n')).toContain('example')
    await next.markTold()
    expect(await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).hintProvider({} as any)).toEqual([])
  })

  it('a user pin arriving during judgment defeats the close and is recorded as refused', async () => {
    const decide = mocks.compute.getMockImplementation()!
    mocks.compute.mockImplementation(async (input) => {
      await redis.json.set(`unzipped_item:${actor.sessionId}:${rawZipId}`, '$', { zipId: rawZipId, sessionId: actor.sessionId,
        source: 'user', permanent: true, unzippedAt: 3 })
      return decide(input)
    })
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect(mocks.append.mock.calls[0][2][0].detail).toContain('refused')
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('turning management off while judgment waits prevents mutation', async () => {
    const decide = mocks.compute.getMockImplementation()!
    mocks.compute.mockImplementation(async (input) => {
      await redis.json.set(`agent:${actor.agentId}`, '$.jev_juice_skill_tool_hints', 'off')
      return decide(input)
    })
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
    expect(await readOpenSkillSessions(actor)).toHaveLength(1)
    expect(mocks.append.mock.calls[0][2][0].detail).toContain('management is off')
  })

  it('OFF, groups and wake origins never request the close judgment', async () => {
    await buildSkillSessionTurn({ ...actor, isGroupTurn: true }).runPostTurn(post)
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn({ ...post, origin: 'wake' })
    await redis.json.set(`agent:${actor.agentId}`, '$.jev_juice_skill_tool_hints', 'off')
    await buildSkillSessionTurn({ ...actor, isGroupTurn: false }).runPostTurn(post)
    expect(mocks.compute).not.toHaveBeenCalled()
  })

  it('treats failed, partial and running tool/delegate outcomes as unfinished evidence', () => {
    expect(skillTurnHasUnfinishedTools([{ toolResult: { success: false } }])).toBe(true)
    expect(skillTurnHasUnfinishedTools([{ toolResult: { result: { workers: [{ status: 'partial' }] } } }])).toBe(true)
    expect(skillTurnHasUnfinishedTools([{ toolName: 'native_bash_execute', toolResult: { success: true } }])).toBe(false)
  })
})
