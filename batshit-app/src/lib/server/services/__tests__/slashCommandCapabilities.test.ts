import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMocks = vi.hoisted(() => ({
  keys: vi.fn(),
  jsonGet: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    keys: redisMocks.keys,
    execute: (callback: any) => callback({ keys: redisMocks.keys }),
    json: {
      get: redisMocks.jsonGet
    }
  }
}))

vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn(), assertBuiltinCommandCatalogue: vi.fn() }))
vi.mock('../agentPlugins', () => ({ builtinPluginSkill: () => undefined, listAgentPlugins: async () => [], projectPluginCommand: async (_user: string, command: unknown) => command }))

import {
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities,
  listAllSlashCapabilities,
  resolveSkillAccessForActor
} from '../slashCommandCapabilities'
import { splitFrontmatter } from '../skillFrontmatter'
import { ensureSystemSlashCommands, assertBuiltinCommandCatalogue } from '../systemSlashCommands'

beforeEach(() => { vi.mocked(ensureSystemSlashCommands).mockReset().mockResolvedValue(undefined) })

function skillCommand(overrides: Record<string, unknown>) {
  return {
    id: 'sample-creator',
    name: 'sample-creator',
    displayName: 'Artifact Creator',
    type: 'skill',
    is_active: true,
    is_system: true,
    can_be_attached_to_agents: true,
    can_be_invoked_in_chat: true,
    invocation_pattern: '/sample-creator',
    skill_id: 'sample_creator',
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

describe('independent slashCommandCapabilities (grouped built-ins use agentPlugins.redis.test)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads both capability catalogs without entering bootstrap or mutation-conflict admission', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true })])
    vi.mocked(ensureSystemSlashCommands).mockImplementation(() => { throw new Error('SLASH_COMMAND_CONFLICT: catalogue entered mutation admission') })
    expect(await getEnabledAgentSlashCapabilities('user-1', 'agent-1')).toHaveLength(1)
    expect(await listAllSlashCapabilities('user-1')).toHaveLength(1)
    expect(ensureSystemSlashCommands).not.toHaveBeenCalled()
    expect(assertBuiltinCommandCatalogue).toHaveBeenCalledTimes(2)
  })

  it.each([3, 10, 25])('keeps all %s enabled skills with full identities and bounded single-line descriptions', async count => {
    seedCommands([
      ...Array.from({ length: count }, (_, i) => skillCommand({ id: `catalog-${i}`, name: `catalog-${i}`,
        displayName: `Catalog ${String(i).padStart(2, '0')}`, invocation_pattern: `/catalog-${i}`, skill_id: `catalog_skill_${i}`,
        enabled_agent_ids: ['agent-1'], description: 'A long skill description.\n'.repeat(30) })),
      skillCommand({ id: 'not-enabled', name: 'not-enabled', skill_id: 'not_enabled', enabled_agent_ids: ['another-agent'] })
    ])
    const capabilities = await getEnabledAgentSlashCapabilities('user-1', 'agent-1')
    expect(capabilities).toHaveLength(count)
    const lines = buildSkillsCommandsDcmLines(capabilities)
    const entries = lines.filter(line => /^- \/catalog-/.test(line))
    expect(entries).toHaveLength(count)
    for (let i = 0; i < count; i++) {
      const line = entries.find(entry => entry.startsWith(`- /catalog-${i} |`))!
      expect(line).toContain(`skillId=catalog_skill_${i}`)
      expect(line).not.toContain('\n')
      const description = line.split(' — ')[1]
      expect(description.length).toBeLessThanOrEqual(240)
      expect(description.endsWith('…')).toBe(true)
    }
    expect(lines.join('\n')).not.toContain('not_enabled')
  })

  it('omits both the catalog and usage when no skill or prompt is enabled', () => {
    expect(buildSkillsCommandsDcmLines([])).toEqual([])
  })

  it('offers the live API skill call and ref in catalog guidance', () => {
    const capabilities = [{ id: 'one', name: 'one', displayName: 'One', type: 'skill' as const, invocation: '/one', isSystem: false, skillId: 'one' }]
    const api = buildSkillsCommandsDcmLines(capabilities).join('\n')
    expect(api).toContain('native_batshit_tool_use with ref="batshit:sys.skill.use"')
    expect(api).not.toContain('native_skill')
  })

  it('includes chat-invocable global system skills alongside agent-enabled commands', async () => {
    redisMocks.keys.mockResolvedValue([
      'slash_command:user-1:sample-installer',
      'slash_command:user-1:agent-browser',
      'slash_command:user-1:disabled-skill'
    ])

    redisMocks.jsonGet.mockImplementation(async (key: string) => {
      if (key.endsWith('sample-installer')) {
        return {
          id: 'sample-installer',
          name: 'sample-installer',
          displayName: 'TTS/STT Engine Installer',
          type: 'skill',
          is_active: true,
          is_system: true,
          can_be_attached_to_agents: false,
          can_be_invoked_in_chat: true,
          invocation_pattern: '/sample-installer',
          skill_id: 'sample_installer',
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
        id: 'sample-installer',
        invocation: '/sample-installer',
        skillId: 'sample_installer',
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
      '- /sample-installer | skill | skillId=sample_installer — Canonical speech setup'
    )
    expect(dcmLines).toContain('- /agent-browser | skill | skillId=agent_browser')
    expect(dcmLines).toContain(
      '- An enabled skill is permission to use that skill when it clearly matches the user\'s request. You may proactively invoke any listed skill by calling native_batshit_tool_use with ref="batshit:sys.skill.use" and input containing its listed skillId and action="invoke"; the user does not need to type the slash command first. Use judgment; skip skills for simple requests that do not need the skill workflow.'
    )
    // BL-75: the list is also the limit, and the agent is told so.
    expect(dcmLines).toContain(
      '- Plugin skills share the plugin’s access setting in Settings -> Plugins & shit -> Plugins. Only skills enabled for you can be loaded: native_batshit_tool_use with ref="batshit:sys.skill.use" refuses any other skill. If the user wants a skill that is not listed here, tell them to turn it on for you in Settings -> Agents -> Access, or for every agent in Settings -> Plugins & shit.'
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

  // BL-469: a SKILL.md with a folded or literal description listed `— >` or `— |`.
  it('lists the text of a folded or literal SKILL.md description on one line', async () => {
    const folded = splitFrontmatter(`---
name: typesafe-system-one
description: >
  TypeSafe AI's System One models (flagship: Jev): typed questions
  about any text.
---
# TypeSafe
`).frontmatter.description as string
    const literal = splitFrontmatter(`---
name: release-notes
description: |
  Drafts release notes.
    Use it when: a release is tagged.

  Never publishes.
---
# Release Notes
`).frontmatter.description as string

    seedCommands([
      skillCommand({
        id: 'typesafe-system-one',
        name: 'typesafe-system-one',
        displayName: 'TypeSafe',
        invocation_pattern: '/typesafe-system-one',
        skill_id: 'typesafe_system_one',
        is_system: false,
        enabled_for_all_agents: true,
        skill_summary: folded
      }),
      skillCommand({
        id: 'release-notes',
        name: 'release-notes',
        displayName: 'Release Notes',
        invocation_pattern: '/release-notes',
        skill_id: 'release_notes',
        is_system: false,
        enabled_for_all_agents: true,
        description: literal
      })
    ])

    const lines = buildSkillsCommandsDcmLines(await getEnabledAgentSlashCapabilities('user-1', 'agent-1'))

    expect(lines.slice(0, 3)).toEqual([
      'skills_commands:',
      '- /release-notes | skill | skillId=release_notes — Drafts release notes. Use it when: a release is tagged. Never publishes.',
      "- /typesafe-system-one | skill | skillId=typesafe_system_one — TypeSafe AI's System One models (flagship: Jev): typed questions about any text."
    ])
  })

  it('leaves out the dash when a description is only whitespace', () => {
    const lines = buildSkillsCommandsDcmLines([
      {
        id: 'blank',
        name: 'blank',
        displayName: 'Blank',
        type: 'skill',
        invocation: '/blank',
        description: ' \n\t ',
        isSystem: false,
        skillId: 'blank'
      }
    ])

    expect(lines[1]).toBe('- /blank | skill | skillId=blank')
  })
})

describe('resolveSkillAccessForActor (BL-75)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const agent = { kind: 'agent', agentId: 'agent-1' } as const

  it('lets an agent load a skill that is on for it, and returns the normalized id', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['agent-1'] })])

    const result = await resolveSkillAccessForActor('user-1', '  Sample-Creator ', agent)

    expect(result).toEqual(
      expect.objectContaining({ ok: true, skillId: 'sample_creator' })
    )
  })

  it('lets every agent load a skill that is on for all agents', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true })])

    const result = await resolveSkillAccessForActor('user-1', 'sample_creator', {
      kind: 'agent',
      agentId: 'agent-99'
    })

    expect(result.ok).toBe(true)
  })

  it('refuses a skill that is off for this agent and says where to turn it on', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['agent-2'] })])

    const result = await resolveSkillAccessForActor('user-1', 'sample_creator', agent)

    expect(result).toEqual({
      ok: false,
      code: 'SKILL_NOT_ENABLED',
      skillId: 'sample_creator',
      message: expect.stringContaining('Skill "Artifact Creator" (sample_creator) is not enabled for this agent')
    })
    if (!result.ok) {
      expect(result.message).toContain('Settings -> Agents -> Access')
      expect(result.message).toContain('Settings -> Plugins & shit')
    }
  })

  it('refuses a skill whose command is switched off or not chat-invocable', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true, is_active: false })])
    expect((await resolveSkillAccessForActor('user-1', 'sample_creator', agent)).ok).toBe(false)

    seedCommands([skillCommand({ enabled_for_all_agents: true, can_be_invoked_in_chat: false })])
    expect((await resolveSkillAccessForActor('user-1', 'sample_creator', agent)).ok).toBe(false)
  })

  it('keeps the legacy rule the list uses: a command with no access field is on', async () => {
    const legacy = skillCommand({})
    delete (legacy as Record<string, unknown>).enabled_agent_ids
    seedCommands([legacy])

    expect((await resolveSkillAccessForActor('user-1', 'sample_creator', agent)).ok).toBe(true)
  })

  it('allows a skill when any one of its commands is on for the agent', async () => {
    seedCommands([
      skillCommand({ id: 'sample-creator-off', enabled_agent_ids: [] }),
      skillCommand({ id: 'sample-creator-on', enabled_agent_ids: ['agent-1'] })
    ])

    const result = await resolveSkillAccessForActor('user-1', 'sample_creator', agent)

    expect(result).toEqual(
      expect.objectContaining({ ok: true, command: expect.objectContaining({ id: 'sample-creator-on' }) })
    )
  })

  it('refuses a skill that no skill command lists, even when a prompt shares its id', async () => {
    seedCommands([
      skillCommand({ id: 'prompt-twin', type: 'prompt', enabled_for_all_agents: true })
    ])

    const result = await resolveSkillAccessForActor('user-1', 'sample_creator', agent)

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'SKILL_NOT_LISTED', skillId: 'sample_creator' })
    )
  })

  it('checks a subagent against its own list, not its parent agent', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['agent-1'] })])

    const result = await resolveSkillAccessForActor('user-1', 'sample_creator', {
      kind: 'agent',
      agentId: 'research_bot',
      delegated: true
    })

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'SKILL_NOT_ENABLED' }))
    if (!result.ok) expect(result.message).toContain('not enabled for this subagent')
  })

  it('refuses a caller with no agent identity without reading any command', async () => {
    seedCommands([skillCommand({ enabled_for_all_agents: true })])

    const result = await resolveSkillAccessForActor('user-1', 'sample_creator', {
      kind: 'none',
      lane: 'service'
    })

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'AGENT_IDENTITY_REQUIRED' }))
    expect(redisMocks.keys).not.toHaveBeenCalled()
  })

  it.each([[' A-B ', 'A-B'], [7, '7'], [{ toString: 'A-B' }, 'A-B'], ['bad\ud800', 'bad�']])('never turns malformed saved %j into another load/DCM identity %s (BL1614)', async (saved, actorId) => {
    const row = skillCommand({ enabled_agent_ids: [saved, 'bystander'] })
    seedCommands([row])
    expect((await resolveSkillAccessForActor('user-1', 'sample_creator', { kind: 'agent', agentId: actorId })).ok).toBe(false)
    expect(await getEnabledAgentSlashCapabilities('user-1', actorId)).toEqual([])
    expect((await resolveSkillAccessForActor('user-1', 'sample_creator', { kind: 'agent', agentId: 'bystander' })).ok).toBe(true)
    expect(row.enabled_agent_ids).toEqual([saved, 'bystander'])
  })

  it('keeps exact A-B/a_b distinct and preserves a legitimate legacy reference for both loads and DCM', async () => {
    seedCommands([skillCommand({ enabled_agent_ids: ['A-B', 'odd.id'] })])
    for (const id of ['A-B', 'odd.id']) {
      expect((await resolveSkillAccessForActor('user-1', 'sample_creator', { kind: 'agent', agentId: id })).ok).toBe(true)
      expect(await getEnabledAgentSlashCapabilities('user-1', id)).toHaveLength(1)
    }
    expect((await resolveSkillAccessForActor('user-1', 'sample_creator', { kind: 'agent', agentId: 'a_b' })).ok).toBe(false)
    expect(await getEnabledAgentSlashCapabilities('user-1', 'a_b')).toEqual([])
  })

})
