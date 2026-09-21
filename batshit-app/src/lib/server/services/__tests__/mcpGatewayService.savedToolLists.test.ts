/**
 * Josh's rule (2026-09-18): a saved tool list is kept "unless the user updates the tool
 * settings". The gateway service is the one writer of those settings, so it throws a
 * gateway's saved copies away on create, delete, and every update except the record keeping
 * that a lookup or a test writes back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  execute: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { mcpGatewayService } from '../mcpGatewayService'
import { mcpToolListCache } from '../mcpToolListCache'

function createFakeRedis() {
  const json = new Map<string, any>()
  const client = {
    json: {
      get: vi.fn(async (key: string) => (json.has(key) ? structuredClone(json.get(key)) : null)),
      set: vi.fn(async (key: string, _path: string, value: any) => {
        json.set(key, structuredClone(value))
        return 'OK'
      })
    },
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    sMembers: vi.fn(async () => [])
  }
  redisMock.execute.mockImplementation(async (fn: (c: typeof client) => any) => fn(client))
  return { json }
}

const USER = 'josh'

const STDIO = {
  id: 'gw-stdio',
  name: 'Filesystem',
  type: 'stdio' as const,
  enabled: true,
  stdioConfig: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], cwdPolicy: 'none' as const },
  created_at: '2026-09-01T00:00:00.000Z'
}
const CUSTOM = {
  id: 'gw-custom',
  name: 'HuggingFace',
  type: 'custom' as const,
  url: 'https://huggingface.co/mcp',
  authKeyName: 'huggingface',
  enabled: true,
  created_at: '2026-09-01T00:00:00.000Z'
}

async function saveCopy(gatewayId: string) {
  await mcpToolListCache.read({ userId: USER, gatewayId, inputs: { probe: true } }, async () => ({
    ok: true,
    tools: []
  }))
}

/** True when the next read has to ask the tool server again. */
async function asksAgain(gatewayId: string): Promise<boolean> {
  const lookup = vi.fn(async () => ({ ok: true as const, tools: [] }))
  await mcpToolListCache.read({ userId: USER, gatewayId, inputs: { probe: true } }, lookup)
  return lookup.mock.calls.length === 1
}

beforeEach(async () => {
  vi.clearAllMocks()
  mcpToolListCache.clearAll()
  createFakeRedis()
  // Through the service, so the stored records are the normalized ones real gateways have.
  await mcpGatewayService.create(USER, structuredClone(STDIO))
  await mcpGatewayService.create(USER, structuredClone(CUSTOM))
  await saveCopy(STDIO.id)
  await saveCopy(CUSTOM.id)
})

describe('the gateway service throws saved tool lists away when the tool settings change', () => {
  it('keeps the copy when nothing was written (the positive control)', async () => {
    expect(await asksAgain(STDIO.id)).toBe(false)
    expect(await asksAgain(CUSTOM.id)).toBe(false)
  })

  it('an edit to how Batshit reaches a gateway clears that gateway only', async () => {
    await mcpGatewayService.update(USER, CUSTOM.id, { url: 'https://huggingface.co/mcp/v2' })
    expect(await asksAgain(CUSTOM.id)).toBe(true)
    expect(await asksAgain(STDIO.id)).toBe(false)
  })

  it('a STDIO launch edit clears the copy', async () => {
    await mcpGatewayService.update(USER, STDIO.id, {
      stdioConfig: { ...STDIO.stdioConfig, args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example'] }
    })
    expect(await asksAgain(STDIO.id)).toBe(true)
  })

  it('switching a gateway off clears the copy, so switching it back on asks fresh', async () => {
    await mcpGatewayService.setEnabled(USER, CUSTOM.id, false)
    expect(await asksAgain(CUSTOM.id)).toBe(true)
  })

  it('keeps the copy through the record keeping a Refresh writes back', async () => {
    await mcpGatewayService.updateDiscoveredTools(USER, CUSTOM.id, ['hub_search', 'space_search'])
    expect(await asksAgain(CUSTOM.id)).toBe(false)
  })

  it('keeps the copy through the result a STDIO test or refresh writes back', async () => {
    await mcpGatewayService.update(USER, STDIO.id, {
      stdioConfig: {
        ...STDIO.stdioConfig,
        lastTestStatus: 'passed',
        lastTestAt: '2026-09-18T10:00:00.000Z',
        lastError: null,
        toolCount: 14
      }
    })
    expect(await asksAgain(STDIO.id)).toBe(false)
  })

  it('deleting a gateway throws its copies away', async () => {
    await mcpGatewayService.delete(USER, CUSTOM.id)
    expect(await asksAgain(CUSTOM.id)).toBe(true)
    expect(await asksAgain(STDIO.id)).toBe(false)
  })

  it('creating a gateway clears anything left under its id', async () => {
    await mcpGatewayService.delete(USER, CUSTOM.id)
    await saveCopy(CUSTOM.id)
    await mcpGatewayService.create(USER, { ...CUSTOM, url: 'https://huggingface.co/mcp/v3' })
    expect(await asksAgain(CUSTOM.id)).toBe(true)
  })
})
