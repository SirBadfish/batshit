import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'

const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  skillWrite: vi.fn(async () => 'OK'),
  artifactWrite: vi.fn(async () => ({ id: 'artifact_test' }))
}))
vi.mock('$lib/server/redis', () => {
  const get = vi.fn(async (key: string) => state.records.get(key) ?? null)
  const keys = vi.fn(async (pattern: string) => {
    if (!pattern.endsWith('*') || pattern.slice(0, -1).includes('*')) throw new Error(`Unsupported access fixture pattern: ${pattern}`)
    return [...state.records.keys()].filter(key => key.startsWith(pattern.slice(0, -1)))
  })
  const client = { keys, json: { get } }
  return { redis: {
    exists: vi.fn(async (key: string) => state.records.has(key)),
    json: { get,
      getRaw: vi.fn(async (key: string, jsonPath: string) => {
        if (jsonPath !== '$') throw new Error(`Unsupported access raw fixture path: ${jsonPath}`)
        const row = await get(key)
        return row === null ? null : JSON.stringify([row])
      }),
      set: vi.fn(async (key: string, _path: string, value: unknown) => { state.records.set(key, value); return true })
    },
    execute: vi.fn(async (operation: (raw: typeof client) => unknown) => operation(client))
  } }
})

vi.mock('$lib/server/services/agentAccessLists', async importOriginal => ({
  ...await importOriginal<typeof import('../agentAccessLists')>(),
  setSlashCommandAgentAccess: state.skillWrite
}))
vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: class { setAgentAccess = state.artifactWrite }
}))
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal => ({
  ...await importOriginal<typeof import('../slashCommandRevision')>(),
  captureSlashCommandWriteBasis: vi.fn(async () => Object.freeze({})),
  saveSlashCommandRecord: vi.fn(async (userId: string, write: { record: { id: string } }) => {
    state.records.set(`slash_command:${userId}:${write.record.id}`, write.record)
    return write.record
  })
}))

import { redis } from '$lib/server/redis'
import { withSettingsRestoreFence } from '../appActions/settings/lifecycle'
import * as access from '../agentAccessLists'
import { resolveNewAgentId } from '../agentIdRules'
import { PUT as skillPut } from '../../../../routes/api/slash-commands/[id]/agent-access/+server'
import { PUT as artifactPut } from '../../../../routes/api/artifacts/[id]/agent-access/+server'
import { POST as createCommand } from '../../../../routes/api/slash-commands/+server'

const USER = 'access_exact_owner'
let builtinSnapshot = new Map<string, unknown>()
async function put(kind: 'skill' | 'artifact', agentId: unknown) {
  const handler = kind === 'skill' ? skillPut : artifactPut
  return handler({
    params: { id: kind === 'skill' ? 'command_test' : 'artifact_test' },
    request: new Request('http://localhost/access', { method: 'PUT', body: JSON.stringify({ agentId, enabled: true }) }),
    locals: { user: { id: USER } }
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.records.clear()
  const builtins = initializedBuiltinPluginEntries(USER)
  builtinSnapshot = new Map(builtins.map(([key, row]) => [key, structuredClone(row)]))
  for (const [key, row] of builtins) state.records.set(key, row)
  for (const id of ['A-B', 'a_b']) state.records.set(`agent:${id}`, { id, user_id: USER })
  state.records.set(`slash_command:${USER}:command_test`, { id: 'command_test', enabled_agent_ids: [] })
})

afterEach(() => {
  for (const [key, row] of builtinSnapshot) expect(state.records.get(key)).toEqual(row)
})

describe('exact access IDs (BL1614)', () => {
  it('keeps two separately valid stored IDs distinct instead of creating an alias', () => {
    expect(resolveNewAgentId('agent', 'A-B', '')).toEqual({ ok: true, id: 'A-B' })
    expect(resolveNewAgentId('agent', 'a_b', '')).toEqual({ ok: true, id: 'a_b' })
    expect(access.parseAgentAccessChange({ agentId: 'A-B', enabled: false })).toEqual({ agentId: 'A-B', enabled: false })
  })

  it.each(['skill', 'artifact'] as const)('the %s route passes only the exact selected subject to its write owner', async kind => {
    expect((await put(kind, 'A-B')).status).toBe(200)
    if (kind === 'skill') {
      expect(state.skillWrite).toHaveBeenCalledExactlyOnceWith(USER, 'command_test', 'A-B', true, expect.any(Object))
      expect(state.artifactWrite).not.toHaveBeenCalled()
    } else {
      expect(state.artifactWrite).toHaveBeenCalledExactlyOnceWith('artifact_test', USER, 'A-B', true)
      expect(state.skillWrite).not.toHaveBeenCalled()
    }
  })

  it.each(['skill', 'artifact'] as const)('the %s route rejects malformed IDs before any owner write', async kind => {
    for (const value of ['A/B', 'a b', '*', 12, {}, null, '']) expect((await put(kind, value)).status).toBe(400)
    expect(state.skillWrite).not.toHaveBeenCalled()
    expect(state.artifactWrite).not.toHaveBeenCalled()
  })

  it('validates new lists without coercing malformed entries or migrating stored IDs', () => {
    expect(access.parseAccessAgentIds(['A-B', 'a_b', ' A-B '])).toEqual(['A-B', 'a_b'])
    for (const value of [null, 'A-B', ['A/B'], [12], [''], [null], [{}]]) {
      expect(() => access.parseAccessAgentIds(value)).toThrow('agent')
    }
  })

  it('the create route stores exact incoming IDs and refuses malformed lists without a record', async () => {
    const create = (id: string, enabled_agent_ids: unknown) => createCommand({ locals: { user: { id: USER } },
      request: new Request('http://localhost/api/slash-commands', { method: 'POST',
        body: JSON.stringify({ id, name: id, type: 'prompt', enabled_agent_ids }) }) } as never)
    const response = await create('exact_command', ['A-B', 'a_b'])
    expect(response.status).toBe(200)
    expect((await response.json()).slashCommand.enabled_agent_ids).toEqual(['A-B', 'a_b'])
    for (const list of [['A/B'], [12], null, 'A-B']) {
      expect((await create('bad_command', list)).status).toBe(400)
      expect(state.records.has(`slash_command:${USER}:bad_command`)).toBe(false)
    }
  })

  it('reads exact legacy references and removes them literally without admitting a new legacy grant', () => {
    expect(access.readSavedAccessAgentIds(['odd.id', 'A-B', 'a_b'])).toEqual(['odd.id', 'A-B', 'a_b'])
    expect(access.parseAgentAccessChange({ agentId: 'odd.id', enabled: false })).toEqual({ agentId: 'odd.id', enabled: false })
    expect(access.parseAgentAccessChange({ agentId: 'odd.id', enabled: true })).toHaveProperty('error')
    for (const value of [[' A-B '], [7], ['bad\ud800']]) expect(() => access.readSavedAccessAgentIds(value)).toThrow('unreadable')
  })


  it('returns the typed no-effect409 during a real held restore before reading the body or Redis', async () => {
    const readBody = vi.fn(async () => ({ agentId: 'A-B', enabled: true }))
    await withSettingsRestoreFence(async () => {
      const response = await skillPut({ params: { id: 'command_test' }, locals: { user: { id: USER } }, request: { json: readBody } } as never)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'SLASH_COMMAND_CONFLICT' })
    })
    expect(readBody).not.toHaveBeenCalled()
    expect(redis.exists).not.toHaveBeenCalled()
    expect(redis.json.get).not.toHaveBeenCalled()
    expect(redis.json.set).not.toHaveBeenCalled()
    expect(state.skillWrite).not.toHaveBeenCalled()
  })

})
