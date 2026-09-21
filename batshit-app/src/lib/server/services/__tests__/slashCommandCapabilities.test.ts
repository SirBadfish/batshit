import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMocks = vi.hoisted(() => ({
  keys: vi.fn(),
  jsonGet: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    keys: redisMocks.keys,
    json: {
      get: redisMocks.jsonGet
    }
  }
}))

import {
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities,
  resolveSkillAccessForActor
} from '../slashCommandCapabilities'

function skillCommand(overrides: Record<string, unknown>) {
  return {
    id: 'artifact-creator',
    name: 'artifact-creator',
    displayName: 'Artifact Creator',
    type: 'skill',
    is_active: true,
    is_system: true,
    can_be_attached_to_agents: true,
    can_be_invoked_in_chat: true,
    invocation_pattern: '/artifact-creator',
    skill_id: 'artifact_creator',
    enabled_for_all_agents: false,
    enabled_agent_ids: [],
    ...overrides
  }
}

function seedCommands(commands: Array<Record<string, unknown>>) {
  redisMocks.keys.mockResolvedValue(commands.map((command) => `slash_command:user-1:${command.id}`))
  redisMocks.jsonGet.mockImplementation(async (key: string) =>
    commands.find((command) => key === `slash_command:user-1:${command.id}`) ?? null
  )
}

describe('slashCommandCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('includes chat-invocable global system skills alongside agent-enabled commands', async () => {
    redisMocks.keys.mockResolvedValue([
      'slash_command:user-1:voice-engine-installer',
      'slash_command:user-1:agent-browser',
      'slash_command:user-1:disabled-skill'
    ])

    redisMocks.jsonGet.mockImplementation(async (key: string) => {
      if (key.endsWith('voice-engine-installer')) {
        return {
          id: 'voice-engine-installer',
          name: 'voice-engine-installer',
          displayName: 'TTS/STT Engine Installer',
          type: 'skill',
          is_active: true,
          is_system: true,
          can_be_attached_to_agents: false,
          can_be_invoked_in_chat: true,
          invocation_pattern: '/voice-engine-installer',
          skill_id: 'voice_engine_installer',
          description: 'Canonical speech setup'
        }
      }

      if (key.endsWith('agent-browser')) {
        return {
          id: 'agent-browser',
          name: 'agent-browser',
          displayName: 'Agent Browser',
          type: 'skill',
          is_active: true,
          is_system: false,
          can_be_attached_to_agents: true,
          can_be_invoked_in_chat: true,
          invocation_pattern: '/agent-browser',
          skill_id: 'agent_browser',
          enabled_agent_ids: ['agent-1']
        }
      }

      return {
        id: 'disabled-skill',
        name: 'disabled-skill',
        displayName: 'Disabled Skill',
        type: 'skill',
        is_active: true,
        is_system: false,
        can_be_attached_to_agents: true,
        can_be_invoked_in_chat: true,
        invocation_pattern: '/disabled-skill',
        skill_id: 'disabled_skill',
        enabled_agent_ids: []
      }
    })

    const capabilities = await getEnabledAgentSlashCapabilities('user-1', 'agent-1')

    expect(capabilities).toEqual([
      expect.objectContaining({
        id: 'voice-engine-installer',
        invocation: '/voice-engine-installer',
        skillId: 'voice_engine_installer',
        isSystem: true
      }),
      expect.objectContaining({
        id: 'agent-browser',
        invocation: '/agent-browser',
        skillId: 'agent_browser',
        isSystem: false
      })
    ])

    const dcmLines = buildSkillsCommandsDcmLines(capabilities)
    expect(dcmLines).toContain(
      '- /voice-engine-installer | skill | skillId=voice_engine_installer — Canonical speech setup'
    )
    expect(dcmLines).toContain('- /agent-browser | skill | skillId=agent_browser')
    expect(dcmLines).toContain(
      '- An enabled skill is permission to use that skill when it clearly matches the user\'s request. You may proactively invoke any listed skill by calling native_skill with its listed skillId and action="invoke"; the user does not need to type the slash command first. Use judgment; skip skills for simple requests that do not need the skill workflow.'
    )
    // BL-75: the list is also the limit, and the agent is told so.
    expect(dcmLines).toContain(
      '- Only skills enabled for you can be loaded: native_skill refuses any other skill. If the user wants a skill that is not listed here, tell them to turn it on for you in Settings -> Agents -> Access, or for every agent in Settings -> Skills & Prompts.'
    )
  })

  it('includes commands marked for all agents even when no explicit agent allowlist exists', async () => {
    redisMocks.keys.mockResolvedValue(['slash_command:user-1:global-helper'])

    redisMocks.jsonGet.mockResolvedValue({
      id: 'global-helper',
      name: 'global-helper',
      displayName: 'Global Helper',
      type: 'prompt',
      is_active: true,
      is_system: false,
      can_be_attached_to_agents: true,
      can_be_invoked_in_chat: true,
      invocation_pattern: '/global-helper',
      enabled_for_all_agents: true,
      enabled_agent_ids: []
    })

    const capabilities = await getEnabledAgentSlashCapabilities('user-1', 'agent-99')

    expect(capabilities).toEqual([
      expect.objectContaining({
        id: 'global-helper',
        invocation: '/global-helper',
        isSystem: false
      })
    ])
  })
})

describe('resolveSkillAccessForActor (BL-75)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const agent = { kind: 'agent', agentId: 'agent-1' } as const

  it('lets an agent load a skill that is on for it, and returns the normalized id', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['agent-1'] })])

    const result = await resolveSkillAccessForActor('user-1', '  Artifact-Creator ', agent)

    expect(result).toEqual(
      expect.objectContaining({ ok: true, skillId: 'artifact_creator' })
    )
  })

  it('lets every agent load a skill that is on for all agents', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true })])

    const result = await resolveSkillAccessForActor('user-1', 'artifact_creator', {
      kind: 'agent',
      agentId: 'agent-99'
    })

    expect(result.ok).toBe(true)
  })

  it('refuses a skill that is off for this agent and says where to turn it on', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['agent-2'] })])

    const result = await resolveSkillAccessForActor('user-1', 'artifact_creator', agent)

    expect(result).toEqual({
      ok: false,
      code: 'SKILL_NOT_ENABLED',
      skillId: 'artifact_creator',
      message: expect.stringContaining('Skill "Artifact Creator" (artifact_creator) is not enabled for this agent')
    })
    if (!result.ok) {
      expect(result.message).toContain('Settings -> Agents -> Access')
      expect(result.message).toContain('Settings -> Skills & Prompts')
    }
  })

  it('refuses a skill whose command is switched off or not chat-invocable', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true, is_active: false })])
    expect((await resolveSkillAccessForActor('user-1', 'artifact_creator', agent)).ok).toBe(false)

    seedCommands([skillCommand({ enabled_for_all_agents: true, can_be_invoked_in_chat: false })])
    expect((await resolveSkillAccessForActor('user-1', 'artifact_creator', agent)).ok).toBe(false)
  })

  it('keeps the legacy rule the list uses: a command with no access field is on', async () => {
    const legacy = skillCommand({})
    delete (legacy as Record<string, unknown>).enabled_agent_ids
    seedCommands([legacy])

    expect((await resolveSkillAccessForActor('user-1', 'artifact_creator', agent)).ok).toBe(true)
  })

  it('allows a skill when any one of its commands is on for the agent', async () => {
    seedCommands([
      skillCommand({ id: 'artifact-creator-off', enabled_agent_ids: [] }),
      skillCommand({ id: 'artifact-creator-on', enabled_agent_ids: ['agent-1'] })
    ])

    const result = await resolveSkillAccessForActor('user-1', 'artifact_creator', agent)

    expect(result).toEqual(
      expect.objectContaining({ ok: true, command: expect.objectContaining({ id: 'artifact-creator-on' }) })
    )
  })

  it('refuses a skill that no skill command lists, even when a prompt shares its id', async () => {
    seedCommands([
      skillCommand({ id: 'prompt-twin', type: 'prompt', enabled_for_all_agents: true })
    ])

    const result = await resolveSkillAccessForActor('user-1', 'artifact_creator', agent)

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'SKILL_NOT_LISTED', skillId: 'artifact_creator' })
    )
  })

  it('checks a subagent against its own list, not its parent agent', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['agent-1'] })])

    const result = await resolveSkillAccessForActor('user-1', 'artifact_creator', {
      kind: 'agent',
      agentId: 'research_bot',
      delegated: true
    })

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'SKILL_NOT_ENABLED' }))
    if (!result.ok) expect(result.message).toContain('not enabled for this subagent')
  })

  it('refuses a caller with no agent identity without reading any command', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true })])

    const result = await resolveSkillAccessForActor('user-1', 'artifact_creator', {
      kind: 'none',
      lane: 'service'
    })

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'AGENT_IDENTITY_REQUIRED' }))
    expect(redisMocks.keys).not.toHaveBeenCalled()
  })
})
