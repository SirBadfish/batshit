import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'

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

  const client = { keys, json: { get } }
  return {
    redis: {
      json: { get, set,
        getRaw: vi.fn(async (key: string, jsonPath: string) => {
          if (jsonPath !== '$') throw new Error(`Unsupported source-discovery raw fixture path: ${jsonPath}`)
          const row = await get(key)
          return row === null ? null : JSON.stringify([row])
        })
      },
      keys, del,
      execute: vi.fn(async (operation: (raw: typeof client) => unknown) => operation(client))
    }
  }
})

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: {
    list: vi.fn(async () => [])
  }
}))
// Source preparation proof only; actual revision/merge Lua lives in its real-Redis owner file.
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal => ({
  ...await importOriginal<typeof import('../slashCommandRevision')>(),
  captureSkillSourceWriteBasis: vi.fn(async () => Object.freeze({})),
  saveSkillSourceRecord: vi.fn(async (source: { user_id: string; id: string }) => { mockState.store.set(`skill_source:${source.user_id}:${source.id}`, source); return source }),
  updateSkillSourceScan: vi.fn(async (userId: string, id: string, update: object) => {
    const source = { ...mockState.store.get(`skill_source:${userId}:${id}`), ...update }
    mockState.store.set(`skill_source:${userId}:${id}`, source); return source
  }),
  deleteSkillSourceRecord: vi.fn(async (userId: string, id: string) => mockState.store.delete(`skill_source:${userId}:${id}`)),
  captureSlashCommandWriteBasis: vi.fn(async () => Object.freeze({})),
  saveSlashCommandRecord: vi.fn(async (userId: string, write: { record: { id: string } }) => {
    mockState.store.set(`slash_command:${userId}:${write.record.id}`, write.record)
    return write.record
  })
}))

let originalHome = process.env.HOME
const originalBatshitHome = process.env.BATSHIT_HOME_DIR
let tempHome = ''
let tempRoot = ''
let builtinSnapshot = new Map<string, unknown>()
const customKeys = (prefix: string) => [...mockState.store.keys()].filter(key => key.startsWith(prefix) && !builtinSnapshot.has(key))

beforeEach(async () => {
  const builtins = initializedBuiltinPluginEntries('user-1')
  mockState.store = new Map<string, any>(builtins)
  builtinSnapshot = new Map(builtins.map(([key, row]) => [key, structuredClone(row)]))
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-source-home-'))
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-source-root-'))
  process.env.HOME = tempHome
  process.env.BATSHIT_HOME_DIR = path.join(tempHome, '.batshit')
  vi.resetModules()
})

afterEach(async () => {
  try {
    for (const [key, row] of builtinSnapshot) expect(mockState.store.get(key)).toEqual(row)
  } finally {
    process.env.HOME = originalHome
    if (originalBatshitHome === undefined) delete process.env.BATSHIT_HOME_DIR
    else process.env.BATSHIT_HOME_DIR = originalBatshitHome
    await fs.rm(tempHome, { recursive: true, force: true })
    await fs.rm(tempRoot, { recursive: true, force: true })
    tempHome = ''
    tempRoot = ''
  }
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

    const skillKeys = customKeys('skill:user-1:')
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

    expect(second.commands[0].enabled_agent_ids).toEqual(['agent-one', 'agent-two'])
    expect(second.commands[0].enabled_for_all_agents).toBe(false)
  })

  it('preserves colliding exact source/attachment IDs through source edits and a rescan', async () => {
    await writeSkill(tempRoot, 'exact-identity', 'Exact identity')
    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const source = await upsertSkillSource({ userId: 'user-1', rootPath: tempRoot, enabledAgentIds: ['A-B', 'a_b'] })
    expect(source.enabled_agent_ids).toEqual(['A-B', 'a_b'])
    const edited = await upsertSkillSource({ userId: 'user-1', id: source.id, rootPath: tempRoot, label: 'Edited label' })
    expect(edited.enabled_agent_ids).toEqual(['A-B', 'a_b'])
    const scan = await scanSkillSource({ userId: 'user-1', sourceId: source.id, attachAgentId: 'C-D' })
    expect(scan.commands[0].enabled_agent_ids).toEqual(['A-B', 'a_b', 'C-D'])
  })

  it('source routes reject malformed requested identities before creating or scanning records', async () => {
    const { POST: create } = await import('../../../../routes/api/skill-sources/+server')
    const { POST: scan } = await import('../../../../routes/api/skill-sources/[id]/+server')
    const event = (body: unknown) => ({ params: { id: 'none' }, locals: { user: { id: 'user-1' } },
      request: new Request('http://localhost/api/skill-sources', { method: 'POST', body: JSON.stringify(body) }) })
    for (const enabledAgentIds of [[12], [{}], ['A/B'], null, 'A-B']) {
      expect((await create(event({ rootPath: tempRoot, enabledAgentIds }) as never)).status).toBe(400)
      expect([...mockState.store]).toEqual([...builtinSnapshot])
    }
    for (const attachAgentId of [12, {}, 'A/B', '']) {
      expect((await create(event({ rootPath: tempRoot, attachAgentId }) as never)).status).toBe(400)
      expect((await scan(event({ attachAgentId }) as never)).status).toBe(400)
      expect([...mockState.store]).toEqual([...builtinSnapshot])
    }
  })

  it('refuses malformed saved command lists instead of turning string characters into grants (BL1617)', async () => {
    await writeSkill(tempRoot, 'saved-state', 'Saved state')
    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const source = await upsertSkillSource({ userId: 'user-1', rootPath: tempRoot, enabledAgentIds: ['A-B'] })
    const first = await scanSkillSource({ userId: 'user-1', sourceId: source.id })
    const key = `slash_command:user-1:${first.commands[0].id}`
    const bystander = { id: 'bystander', type: 'skill', skill_id: 'other', enabled_agent_ids: ['a', 'b', 'a_b'] }
    mockState.store.set('slash_command:user-1:bystander', bystander)
    for (const enabled_agent_ids of ['ab', [' A-B '], [12]]) {
      const malformed = { ...first.commands[0], enabled_agent_ids }
      mockState.store.set(key, malformed)
      await expect(scanSkillSource({ userId: 'user-1', sourceId: source.id })).rejects.toThrow('saved agent access')
      expect(mockState.store.get(key)).toEqual(malformed)
      expect(mockState.store.get('slash_command:user-1:bystander')).toEqual(bystander)
    }
  })

  it('refuses nonexact saved source IDs rather than trimming them into assignments (BL1617)', async () => {
    await writeSkill(tempRoot, 'source-state', 'Source state')
    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const source = await upsertSkillSource({ userId: 'user-1', rootPath: tempRoot, enabledAgentIds: ['A-B'] })
    mockState.store.set(`skill_source:user-1:${source.id}`, { ...source, enabled_agent_ids: [' A-B '] })
    await expect(scanSkillSource({ userId: 'user-1', sourceId: source.id })).rejects.toThrow('saved agent access')
    expect(customKeys('slash_command:')).toEqual([])
  })

  it('keeps an absent saved command list absent during rescan (universal legacy access)', async () => {
    await writeSkill(tempRoot, 'legacy-state', 'Legacy state')
    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const source = await upsertSkillSource({ userId: 'user-1', rootPath: tempRoot, enabledAgentIds: ['A-B'] })
    const first = await scanSkillSource({ userId: 'user-1', sourceId: source.id })
    const key = `slash_command:user-1:${first.commands[0].id}`
    const legacy = { ...first.commands[0] }
    delete legacy.enabled_agent_ids
    mockState.store.set(key, legacy)
    const next = await scanSkillSource({ userId: 'user-1', sourceId: source.id })
    expect(Object.hasOwn(next.commands[0], 'enabled_agent_ids')).toBe(false)
    expect(Object.hasOwn(mockState.store.get(key), 'enabled_agent_ids')).toBe(false)
  })

  it.each(['not_written', 'unknown'] as const)('does not follow a %s alias result with another bookkeeping write or hide prior file work', async outcome => {
    await writeSkill(tempRoot, 'partial-stage', 'Partial stage')
    const { scanSkillSource, upsertSkillSource } = await import('../skillSourceDiscovery')
    const { saveSlashCommandRecord, updateSkillSourceScan, SlashCommandMutationError } = await import('../slashCommandRevision')
    const source = await upsertSkillSource({ userId: 'user-1', rootPath: tempRoot, enabledAgentIds: ['A-B'] })
    vi.mocked(updateSkillSourceScan).mockClear()
    vi.mocked(saveSlashCommandRecord).mockClear()
    vi.mocked(saveSlashCommandRecord).mockRejectedValueOnce(new SlashCommandMutationError(
      outcome === 'unknown' ? 'SLASH_COMMAND_UNCONFIRMED' : 'SLASH_COMMAND_CONFLICT',
      outcome === 'unknown' ? 'The alias outcome is unconfirmed; do not retry.' : 'The command changed; reload.', outcome))
    await expect(scanSkillSource({ userId: 'user-1', sourceId: source.id })).rejects.toMatchObject({
      outcome, status: outcome === 'unknown' ? 503 : 409, message: expect.stringContaining('Earlier skill import/file updates may already have completed.')
    })
    expect(saveSlashCommandRecord).toHaveBeenCalledTimes(1)
    expect(updateSkillSourceScan).not.toHaveBeenCalled()
    expect(mockState.store.get(`skill_source:user-1:${source.id}`).enabled_agent_ids).toEqual(['A-B'])
    // The actual import/upsert owner already prepared its skill metadata/files. No rollback claim.
    expect([...mockState.store.keys()].some(key => key.startsWith('skill:user-1:'))).toBe(true)
  })


  it.each(['POST', 'DELETE'] as const)('the source %s route preserves a typed unknown503 without replay', async method => {
    await writeSkill(tempRoot, 'route-stage', 'Route stage')
    const { upsertSkillSource } = await import('../skillSourceDiscovery')
    const owner = await import('../slashCommandRevision')
    const source = await upsertSkillSource({ userId: 'user-1', rootPath: tempRoot })
    const write = method === 'POST' ? owner.saveSlashCommandRecord : owner.deleteSkillSourceRecord
    vi.mocked(write).mockClear()
    vi.mocked(write).mockRejectedValueOnce(new owner.SlashCommandMutationError('SLASH_COMMAND_UNCONFIRMED', 'The write may have reached storage; do not retry.', 'unknown'))
    const route = await import('../../../../routes/api/skill-sources/[id]/+server')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await route[method]({ params: { id: source.id }, locals: { user: { id: 'user-1' } },
        request: new Request('http://localhost/source', { method, ...(method === 'POST' ? { body: '{}' } : {}) }) } as never)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'SLASH_COMMAND_UNCONFIRMED', error: expect.stringContaining('do not retry') })
      expect(write).toHaveBeenCalledTimes(1)
    } finally { quiet.mockRestore() }
  })

})
