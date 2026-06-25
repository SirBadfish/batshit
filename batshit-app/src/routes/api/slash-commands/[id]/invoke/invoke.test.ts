import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

vi.mock('$lib/server/redis', () => ({
  redis: {
    json: {
      get: vi.fn(),
      set: vi.fn()
    }
  }
}))

vi.mock('$lib/server/services/skillRegistry', () => ({
  evaluateSkillDependencies: vi.fn(),
  getSkill: vi.fn()
}))

vi.mock('$lib/server/services/systemSlashCommands', () => ({
  bootstrapSystemSlashCommands: vi.fn(),
  expectedSystemSkillIdForCommand: vi.fn()
}))

import { POST } from './+server'
import { redis } from '$lib/server/redis'
import { evaluateSkillDependencies, getSkill } from '$lib/server/services/skillRegistry'
import {
  bootstrapSystemSlashCommands,
  expectedSystemSkillIdForCommand
} from '$lib/server/services/systemSlashCommands'

const baseCommand = {
  id: 'cmd-skill',
  user_id: 'user-1',
  name: 'artifact-skill',
  displayName: 'Artifact Skill',
  description: 'Test skill command',
  type: 'skill' as const,
  is_active: true,
  is_system: false,
  can_be_invoked_in_chat: true,
  usage_count: 0,
  parameters: [],
  skill_id: 'artifacts_general',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
}

function buildEvent(body: Record<string, unknown>): RequestEvent {
  const request = new Request('http://localhost/api/slash-commands/cmd-skill/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  return {
    params: { id: 'cmd-skill' },
    request,
    locals: { user: { id: 'user-1' } }
  } as unknown as RequestEvent
}

describe('POST /api/slash-commands/[id]/invoke (skill)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(redis.json.get).mockResolvedValue(baseCommand as any)
    vi.mocked(redis.json.set).mockResolvedValue(true as any)
    vi.mocked(evaluateSkillDependencies).mockResolvedValue({ statuses: [] } as any)
    vi.mocked(bootstrapSystemSlashCommands).mockResolvedValue({} as any)
    vi.mocked(expectedSystemSkillIdForCommand).mockReturnValue(null)
    vi.mocked(getSkill).mockResolvedValue({
      id: 'artifacts_general',
      name: 'artifact-skill',
      displayName: 'Artifact Skill',
      description: 'General artifact skill',
      skill_markdown: '# SKILL',
      allowed_tools: ['mcp__artifacts__create'],
      standards_status: 'full',
      standards_issues: []
    } as any)
  })

  it('returns prompt_inline expansion with minimal skill marker', async () => {
    const response = await POST(
      buildEvent({
        agentId: 'agent-1',
        rawArgs: ''
      })
    )

    expect(response.status).toBe(200)
    const payload = await response.json()

    expect(payload.expansionKind).toBe('prompt_inline')
    expect(payload.expansion).toContain('[Skill: Artifact Skill')
    expect(payload.expansion).toContain('skillId=artifacts_general')
    expect(payload.skillSession).toBeUndefined()
  })

  it('includes rawArgs in the expansion', async () => {
    const response = await POST(
      buildEvent({
        agentId: 'agent-1',
        rawArgs: 'Build me a weather widget'
      })
    )

    expect(response.status).toBe(200)
    const payload = await response.json()

    expect(payload.expansionKind).toBe('prompt_inline')
    expect(payload.expansion).toContain('Build me a weather widget')
  })

  it('prefers live skill dependencies for unified artifacts skill', async () => {
    vi.mocked(redis.json.get).mockResolvedValue({
      ...baseCommand,
      id: 'artifact-creator',
      name: 'artifact-creator',
      skill_id: 'artifact_creator',
      skill_dependencies: [{ id: 'comfyui', label: 'ComfyUI MCP', required: true }]
    } as any)

    vi.mocked(getSkill).mockResolvedValue({
      id: 'artifact_creator',
      name: 'artifact-creator',
      displayName: 'Artifact Creator',
      description: 'Unified artifacts skill',
      skill_markdown: '# SKILL',
      allowed_tools: ['native_fabric_use'],
      dependencies: [
        { id: 'n8n_mcp', label: 'n8n MCP', required: false },
        { id: 'huggingface', label: 'HuggingFace MCP', required: false }
      ],
      standards_status: 'full',
      standards_issues: []
    } as any)

    const response = await POST(
      buildEvent({
        agentId: 'agent-1',
        rawArgs: 'Build me an image tool'
      })
    )

    expect(response.status).toBe(200)
    expect(evaluateSkillDependencies).toHaveBeenCalledWith('user-1', [
      { id: 'n8n_mcp', label: 'n8n MCP', required: false },
      { id: 'huggingface', label: 'HuggingFace MCP', required: false }
    ])
  })

  it('repairs built-in commands when their backing skill record is missing', async () => {
    const staleCommand = {
      ...baseCommand,
      id: 'artifact-creator',
      name: 'artifact-creator',
      displayName: 'Artifact Creator',
      is_system: true,
      skill_id: 'artifact_creator'
    }
    const repairedCommand = {
      ...staleCommand,
      skill_id: 'artifact_creator'
    }

    vi.mocked(redis.json.get)
      .mockResolvedValueOnce(staleCommand as any)
      .mockResolvedValueOnce(repairedCommand as any)
    vi.mocked(expectedSystemSkillIdForCommand).mockReturnValue('artifact_creator')
    vi.mocked(getSkill)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'artifact_creator',
        name: 'artifact-creator',
        displayName: 'Artifact Creator',
        description: 'Unified artifacts skill',
        skill_markdown: '# SKILL',
        allowed_tools: ['native_fabric_use'],
        dependencies: [],
        standards_status: 'full',
        standards_issues: []
      } as any)

    const response = await POST(
      buildEvent({
        agentId: 'agent-1',
        rawArgs: 'Build a tiny artifact'
      })
    )

    expect(response.status).toBe(200)
    expect(bootstrapSystemSlashCommands).toHaveBeenCalledWith('user-1')
    const payload = await response.json()
    expect(payload.expansion).toContain('skillId=artifact_creator')
    expect(payload.expansion).toContain('Build a tiny artifact')
  })

  it('allows invocation for commands enabled for all agents', async () => {
    vi.mocked(redis.json.get).mockResolvedValue({
      ...baseCommand,
      enabled_for_all_agents: true,
      enabled_agent_ids: []
    } as any)

    const response = await POST(
      buildEvent({
        agentId: 'agent-42',
        rawArgs: 'Use the global route'
      })
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.expansion).toContain('Use the global route')
  })
})
