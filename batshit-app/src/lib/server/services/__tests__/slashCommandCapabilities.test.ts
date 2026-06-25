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
  getEnabledAgentSlashCapabilities
} from '../slashCommandCapabilities'

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
