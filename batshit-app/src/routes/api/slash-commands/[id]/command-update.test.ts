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
  deleteSkillIfOrphaned: vi.fn(),
  getSkill: vi.fn(),
  normalizeSkillId: vi.fn((value: string) => value),
  upsertSkill: vi.fn()
}))

import { PUT } from './+server'
import { redis } from '$lib/server/redis'
import { getSkill, upsertSkill } from '$lib/server/services/skillRegistry'

const baseCommand = {
  id: 'cmd-prompt',
  user_id: 'user-1',
  name: 'helper',
  displayName: 'Helper',
  description: '',
  type: 'prompt' as const,
  prompt_template: 'Template',
  instructions: '',
  parameters: [],
  invocation_pattern: '/helper',
  can_be_attached_to_agents: false,
  can_be_invoked_in_chat: true,
  enabled_for_all_agents: false,
  enabled_agent_ids: [],
  category: 'general',
  tags: [],
  icon: '✨',
  usage_count: 0,
  last_used_at: undefined,
  is_active: true,
  is_system: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
}

function buildEvent(body: Record<string, unknown>): RequestEvent {
  const request = new Request('http://localhost/api/slash-commands/cmd-prompt', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  return {
    params: { id: 'cmd-prompt' },
    request,
    locals: { user: { id: 'user-1' } }
  } as unknown as RequestEvent
}

describe('PUT /api/slash-commands/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(redis.json.get).mockResolvedValue(baseCommand as any)
    vi.mocked(redis.json.set).mockResolvedValue(true as any)
  })

  it('rejects attempts to change command type after creation', async () => {
    const response = await PUT(buildEvent({ type: 'skill' }))

    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error).toContain('cannot be changed')
    expect(redis.json.set).not.toHaveBeenCalled()
  })

  it('allows updating existing command fields when type is unchanged', async () => {
    const response = await PUT(buildEvent({ name: 'helper-updated' }))

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.slashCommand.type).toBe('prompt')
    expect(payload.slashCommand.name).toBe('helper-updated')
    expect(redis.json.set).toHaveBeenCalledTimes(1)
  })

  it('blocks built-in skills from editing repo-backed fields', async () => {
    vi.mocked(redis.json.get).mockResolvedValue({
      ...baseCommand,
      is_system: true
    } as any)

    const response = await PUT(buildEvent({ name: 'helper-updated' }))

    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.error).toContain('status and access settings')
    expect(payload.error).toContain('name')
    expect(redis.json.set).not.toHaveBeenCalled()
  })

  it('allows built-in skills to update status and access fields', async () => {
    vi.mocked(redis.json.get).mockResolvedValue({
      ...baseCommand,
      id: 'voice-engine-installer',
      name: 'voice-engine-installer',
      displayName: 'TTS/STT Engine Installer',
      type: 'skill',
      skill_id: 'voice_engine_installer',
      invocation_pattern: '/voice-engine-installer',
      is_system: true,
      enabled_for_all_agents: false,
      enabled_agent_ids: []
    } as any)

    const response = await PUT(
      buildEvent({
        is_active: false,
        enabled_for_all_agents: true,
        enabled_agent_ids: []
      })
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.slashCommand.is_active).toBe(false)
    expect(payload.slashCommand.enabled_for_all_agents).toBe(true)
    expect(payload.slashCommand.can_be_attached_to_agents).toBe(true)
    expect(payload.slashCommand.is_system).toBe(true)
    expect(redis.json.set).toHaveBeenCalledTimes(1)
  })

  it('allows built-in skills to change trust level only', async () => {
    vi.mocked(redis.json.get).mockResolvedValue({
      ...baseCommand,
      id: 'artifact-creator',
      name: 'artifact-creator',
      displayName: 'Artifact Creator',
      type: 'skill',
      skill_id: 'artifact_creator',
      invocation_pattern: '/artifact-creator',
      is_system: true,
      trust_level: 'trusted'
    } as any)
    vi.mocked(getSkill).mockResolvedValue({
      id: 'artifact_creator',
      name: 'artifact-creator',
      displayName: 'Artifact Creator',
      description: 'Build artifacts',
      source: 'system',
      source_ref: '/repo/system-skills/artifacts',
      dependencies: [],
      metadata: {},
      allowed_tools: ['native_fabric_use'],
      trust_level: 'trusted',
      has_scripts: false,
      has_references: true,
      has_assets: false,
      is_active: true
    } as any)
    vi.mocked(upsertSkill).mockResolvedValue({
      id: 'artifact_creator',
      source: 'system',
      source_ref: '/repo/system-skills/artifacts',
      description: 'Build artifacts',
      dependencies: [],
      metadata: {},
      allowed_tools: ['native_fabric_use'],
      trust_level: 'untrusted',
      has_scripts: false,
      has_references: true,
      has_assets: false
    } as any)

    const response = await PUT(buildEvent({ skill: { trustLevel: 'untrusted' } }))

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.slashCommand.trust_level).toBe('untrusted')
    expect(upsertSkill).toHaveBeenCalledTimes(1)
  })

  it('blocks built-in skills from editing repo-backed identity fields', async () => {
    vi.mocked(redis.json.get).mockResolvedValue({
      ...baseCommand,
      id: 'artifact-creator',
      name: 'artifact-creator',
      displayName: 'Artifact Creator',
      type: 'skill',
      skill_id: 'artifact_creator',
      invocation_pattern: '/artifact-creator',
      is_system: true
    } as any)

    const response = await PUT(buildEvent({ displayName: 'New Name' }))

    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.error).toContain('status and access settings')
    expect(payload.error).toContain('displayName')
    expect(redis.json.set).not.toHaveBeenCalled()
  })

  it('stores the all-agents flag and marks the command attachable', async () => {
    const response = await PUT(buildEvent({ enabled_for_all_agents: true, enabled_agent_ids: [] }))

    expect(response.status).toBe(200)
    expect(redis.json.set).toHaveBeenCalledTimes(1)

    const payload = await response.json()
    expect(payload.slashCommand.enabled_for_all_agents).toBe(true)
    expect(payload.slashCommand.enabled_agent_ids).toEqual([])
    expect(payload.slashCommand.can_be_attached_to_agents).toBe(true)
  })
})
