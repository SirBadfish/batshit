import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn()
}))

vi.mock('$lib/server/services/skillRuntimeToolService', () => ({
  executeSkillRuntimeAction: vi.fn()
}))

const redisRecords = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => redisRecords.get(key) ?? null),
    keys: vi.fn(async () => []),
    json: { get: vi.fn(async () => null) }
  }
}))

import { POST } from './+server'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { executeSkillRuntimeAction } from '$lib/server/services/skillRuntimeToolService'

function buildEvent(body: Record<string, unknown>): RequestEvent {
  const request = new Request('http://localhost/api/skills/runtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  return {
    request,
    locals: { user: { id: 'user-1' } }
  } as unknown as RequestEvent
}

describe('POST /api/skills/runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisRecords.clear()
  })

  it('returns the shared skill runtime payload for authorized callers', async () => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue({
      userId: 'user-1',
      auth: 'agent',
      agentId: 'agent-1',
      sessionId: 'session-1',
      credentialId: 'arc_test',
      delegated: false
    })
    vi.mocked(executeSkillRuntimeAction).mockResolvedValue({
      success: true,
      action: 'invoke',
      skill: {
        id: 'speech_setup',
        name: 'Speech Setup',
        description: 'Canonical speech setup',
        references: ['references/runtime-preflight.md'],
        scripts: []
      },
      skillMarkdown: '# Speech Setup',
      warnings: [],
      dependencyStatuses: []
    } as any)

    const response = await POST(
      buildEvent({
        userId: 'user-1',
        skillId: 'speech_setup',
        action: 'invoke'
      })
    )

    expect(response.status).toBe(200)
    const payload = await response.json()

    expect(resolveNativeToolUser).toHaveBeenCalled()
    expect(executeSkillRuntimeAction).toHaveBeenCalledWith({
      userId: 'user-1',
      skillId: 'speech_setup',
      actor: { kind: 'agent', agentId: 'agent-1' },
      action: 'invoke',
      path: undefined,
      maxChars: undefined
    })
    expect(payload.auth).toBe('agent')
    expect(payload.skill.id).toBe('speech_setup')
  })

  describe('whose skill access applies (BL-75)', () => {
    function blockedResult(errorCode: string) {
      return {
        success: false,
        action: 'invoke',
        error: 'refused',
        errorCode,
        blocked: true,
        skillId: 'speech_setup'
      } as any
    }

    async function actorFor(auth: Record<string, unknown>, body: Record<string, unknown> = {}) {
      vi.mocked(resolveNativeToolUser).mockResolvedValue({ userId: 'user-1', ...auth } as any)
      vi.mocked(executeSkillRuntimeAction).mockResolvedValue(blockedResult('SKILL_NOT_ENABLED'))
      const response = await POST(buildEvent({ skillId: 'speech_setup', action: 'invoke', ...body }))
      const call = vi.mocked(executeSkillRuntimeAction).mock.calls.at(-1)?.[0] as any
      return { response, actor: call?.actor }
    }

    it('uses the Subagent a delegated credential names, not its runtime id', async () => {
      const { actor } = await actorFor({
        auth: 'agent',
        agentId: 'subagent_cli_research',
        delegated: true,
        scopeAgentId: 'research_bot'
      })
      expect(actor).toEqual({ kind: 'agent', agentId: 'research_bot', delegated: true })
    })

    it('gives a delegated credential with no scope no skill access', async () => {
      const { actor } = await actorFor({
        auth: 'agent',
        agentId: 'subagent_cli_research',
        delegated: true
      })
      expect(actor).toEqual({ kind: 'none', lane: 'agent-unscoped-delegated' })
    })

    it.each(['service', 'portable-skill', 'n8n-callback'])(
      'gives the %s lane no agent identity, and answers the refusal with 403',
      async (lane) => {
        vi.mocked(resolveNativeToolUser).mockResolvedValue({ userId: 'user-1', auth: lane } as any)
        vi.mocked(executeSkillRuntimeAction).mockResolvedValue(blockedResult('AGENT_IDENTITY_REQUIRED'))

        const response = await POST(
          buildEvent({ skillId: 'speech_setup', action: 'invoke', agentId: 'agent-1' })
        )

        const call = vi.mocked(executeSkillRuntimeAction).mock.calls.at(-1)?.[0] as any
        expect(call.actor).toEqual({ kind: 'none', lane })
        expect(response.status).toBe(403)
      }
    )

    it('answers an access refusal with 403, not 400', async () => {
      const { response } = await actorFor({ auth: 'agent', agentId: 'agent-1', delegated: false })
      expect(response.status).toBe(403)
      expect((await response.json()).errorCode).toBe('SKILL_NOT_ENABLED')
    })

    it('lets a signed-in user name one of their own agents or subagents', async () => {
      redisRecords.set('agent:agent-1', { id: 'agent-1', user_id: 'user-1' })
      redisRecords.set('subagent:research_bot', { id: 'research_bot', user_id: 'user-1' })

      expect((await actorFor({ auth: 'session' }, { agentId: 'agent-1' })).actor).toEqual({
        kind: 'agent',
        agentId: 'agent-1'
      })
      expect((await actorFor({ auth: 'session' }, { agentId: 'research_bot' })).actor).toEqual({
        kind: 'agent',
        agentId: 'research_bot',
        delegated: true
      })
    })

    it('refuses a signed-in call that names no agent, or someone else\'s', async () => {
      redisRecords.set('agent:agent-9', { id: 'agent-9', user_id: 'user-2' })
      vi.mocked(resolveNativeToolUser).mockResolvedValue({ userId: 'user-1', auth: 'session' })

      const missing = await POST(buildEvent({ skillId: 'speech_setup', action: 'invoke' }))
      expect(missing.status).toBe(400)

      const foreign = await POST(
        buildEvent({ skillId: 'speech_setup', action: 'invoke', agentId: 'agent-9' })
      )
      expect(foreign.status).toBe(400)
      expect(executeSkillRuntimeAction).not.toHaveBeenCalled()
    })
  })

  it('rejects unauthorized requests', async () => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue(null)

    const response = await POST(
      buildEvent({
        skillId: 'speech_setup',
        action: 'list'
      })
    )

    expect(response.status).toBe(401)
    const payload = await response.json()
    expect(payload.error).toBe('Unauthorized')
  })
})
