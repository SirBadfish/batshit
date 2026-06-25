import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => {
  return {
    store: new Map<string, any>()
  }
})

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

vi.mock('$lib/server/redis', () => {
  const get = vi.fn(async (key: string) => {
    return mockState.store.get(key) ?? null
  })

  const set = vi.fn(async (key: string, redisPath: string, value: any) => {
    if (redisPath !== '$') {
      throw new Error(`Unsupported JSON path in mock: ${redisPath}`)
    }
    mockState.store.set(key, value)
    return true
  })

  const keys = vi.fn(async (pattern: string) => {
    const matcher = patternToRegex(pattern)
    return Array.from(mockState.store.keys()).filter((key) => matcher.test(key))
  })

  const del = vi.fn(async (key: string) => {
    mockState.store.delete(key)
    return true
  })

  return {
    redis: {
      json: {
        get,
        set
      },
      keys,
      del
    }
  }
})

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: {
    list: vi.fn(async () => [])
  }
}))

let originalHome = process.env.HOME
let tempHome = ''
let tempRoot = ''

beforeEach(async () => {
  mockState.store = new Map<string, any>()
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-source-home-'))
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-source-root-'))
  process.env.HOME = tempHome
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  await fs.rm(tempHome, { recursive: true, force: true })
  await fs.rm(tempRoot, { recursive: true, force: true })
  tempHome = ''
  tempRoot = ''
})

async function writeSkill(root: string, name: string, description: string) {
  const skillDir = path.join(root, name)
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true })
  await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), `# ${name} Guide\n`, 'utf8')
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nUse this skill for ${description.toLowerCase()}.\n`,
    'utf8'
  )
  return skillDir
}

describe('skillSourceDiscovery', () => {
  it('scans a folder of SKILL.md bundles into Batshit skill slash commands', async () => {
    await writeSkill(tempRoot, 'codex-helper', 'Codex helper workflows')
    await writeSkill(tempRoot, 'claude-helper', 'Claude helper workflows')

    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const source = await upsertSkillSource({
      userId: 'user-1',
      label: 'Local Skills',
      rootPath: tempRoot,
      trustLevel: 'trusted',
      enabledForAllAgents: true
    })

    const scan = await scanSkillSource({
      userId: 'user-1',
      sourceId: source.id
    })

    expect(scan.scanned).toBe(2)
    expect(scan.commands).toHaveLength(2)
    expect(scan.commands.map((command) => command.invocation_pattern).sort()).toEqual([
      '/claude-helper',
      '/codex-helper'
    ])
    expect(scan.commands.every((command) => command.enabled_for_all_agents === true)).toBe(true)

    const skillKeys = Array.from(mockState.store.keys()).filter((key) => key.startsWith('skill:user-1:'))
    expect(skillKeys).toHaveLength(2)
    for (const key of skillKeys) {
      const stored = mockState.store.get(key)
      expect(stored.skill_markdown).toBe('')
      expect(stored.bundle_files).toEqual([])
      expect(stored.source).toBe('local')
      expect(stored.metadata.batshit_source_id).toBe(source.id)
    }
  })

  it('preserves existing selected-agent access while rescanning discovered skills', async () => {
    await writeSkill(tempRoot, 'agent-browser', 'Browser automation')

    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const source = await upsertSkillSource({
      userId: 'user-1',
      label: 'Project Skills',
      rootPath: tempRoot,
      scope: 'project',
      trustLevel: 'untrusted',
      enabledAgentIds: ['agent-one']
    })

    const first = await scanSkillSource({
      userId: 'user-1',
      sourceId: source.id
    })
    const commandId = first.commands[0].id
    const commandKey = `slash_command:user-1:${commandId}`
    mockState.store.set(commandKey, {
      ...mockState.store.get(commandKey),
      enabled_agent_ids: ['agent-one', 'agent-two']
    })

    const second = await scanSkillSource({
      userId: 'user-1',
      sourceId: source.id
    })

    expect(second.commands[0].enabled_agent_ids).toEqual(['agent_one', 'agent_two'])
    expect(second.commands[0].enabled_for_all_agents).toBe(false)
  })
})
