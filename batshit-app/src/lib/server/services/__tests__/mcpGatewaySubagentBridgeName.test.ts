/**
 * BL-271 — a user MCP gateway never gets the Subagent bridge's server name.
 *
 * A gateway's managed server name is `batshit_gateway_<slug>` (`buildManagedGatewayId`), and a
 * CLI primary's Subagent bridge is `batshit_gateway_<bounded segment>`
 * (`buildCliSubagentMcpServerName`). A gateway named "Cody Subagents" got the slug
 * `cody_subagents`, which is exactly agent `cody`'s bridge: the Claude profile silently dropped
 * the user's gateway and the Codex sync threw on a duplicate table.
 *
 * The fix is at save and never touches the name the user typed: the slug (Batshit's hidden
 * internal id for the gateway, never shown) skips every shape a bridge name can take, exactly
 * as it already skips another gateway's slug. The shapes are agent-independent, so an agent
 * made later cannot collide either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  execute: vi.fn(),
  json: {} as Record<string, unknown>
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { mcpGatewayService } from '../mcpGatewayService'
import { buildManagedGatewayId } from '../codexProfileManager'
import { createJsonCompareAndWriteTwinsForMap } from '$lib/test-utils/redisJsonCompareAndWriteTwin'
import {
  buildCliSubagentMcpServerName,
  isCliSubagentBridgeServerName
} from '$lib/utils/cliSubagentToolNames'

let fakeJson: Map<string, any>

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
  // BL-1371: the service's registry writes are the facade's compare-and-set over the same store.
  Object.assign(redisMock.json, createJsonCompareAndWriteTwinsForMap(json))
  fakeJson = json
  return { json }
}

function customGateway(name: string) {
  return {
    name,
    type: 'custom' as const,
    url: 'https://example.test/mcp',
    enabled: true,
    created_at: '2026-09-27T00:00:00.000Z'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  createFakeRedis()
})

describe('BL-271: a gateway slug never equals a Subagent bridge server name', () => {
  it('a gateway named "Cody Subagents" keeps its name and gets a slug that is not agent cody\'s bridge', async () => {
    const bridge = buildCliSubagentMcpServerName({ id: 'cody' })
    expect(bridge).toBe('batshit_gateway_cody_subagents')

    const saved = await mcpGatewayService.create('josh', customGateway('Cody Subagents'))

    expect(saved.name).toBe('Cody Subagents')
    expect(buildManagedGatewayId(saved.id, saved.slug)).not.toBe(bridge)
    expect(isCliSubagentBridgeServerName(buildManagedGatewayId(saved.id, saved.slug))).toBe(false)
  })

  it('also skips the shortened bridge shape of a long agent name, and an agent made later cannot collide', async () => {
    const longAgent = { id: 'fixtureqa-codex-primary' }
    const bridge = buildCliSubagentMcpServerName(longAgent)!
    const segment = bridge.slice('batshit_gateway_'.length)
    expect(segment).toMatch(/^[a-z0-9_]+_[0-9a-f]{6}$/)

    // A user who types that very segment as a gateway name.
    const saved = await mcpGatewayService.create('josh', customGateway(segment))
    expect(saved.name).toBe(segment)
    expect(buildManagedGatewayId(saved.id, saved.slug)).not.toBe(bridge)
  })

  it('leaves an ordinary gateway name exactly as the slug it always had', async () => {
    const saved = await mcpGatewayService.create('josh', customGateway('Hugging Face'))
    expect(saved.slug).toBe('hugging_face')
  })

  it('every bridge name Batshit can build is recognized as one', () => {
    const ids = [
      'cody',
      'a',
      'abcdef',
      'abcdefg',
      'fixtureqa-codex-primary',
      'Zb Parity Primary',
      '---',
      '_x_',
      'agent_with_a_very_long_identifier_0123456789',
      'subagent'
    ]
    for (const id of ids) {
      for (const slug of [null, id, `${id}-slug`]) {
        const name = buildCliSubagentMcpServerName({ id, slug })!
        expect(isCliSubagentBridgeServerName(name), `${id} / ${slug} -> ${name}`).toBe(true)
      }
    }
  })

  // Review of BL-271: a gateway saved (or restored) before the fix can still hold such a slug.
  it('gives a slug saved before the fix a new one the first time the gateways are read, and says so', async () => {
    const { logger } = await import('$lib/utils/logger')
    fakeJson.set('mcp_gateways:josh', {
      gateways: [
        { id: 'gw-old', name: 'Cody Subagents', slug: 'cody_subagents', type: 'custom', url: 'https://example.test/mcp', enabled: true },
        { id: 'gw-ok', name: 'Hugging Face', slug: 'hugging_face', type: 'custom', url: 'https://example.test/mcp', enabled: true }
      ]
    })

    const listed = await mcpGatewayService.list('josh')

    const old = listed.find((gateway) => gateway.id === 'gw-old')!
    expect(old.name).toBe('Cody Subagents')
    expect(old.slug).toBe('cody_subagents_1')
    expect(listed.find((gateway) => gateway.id === 'gw-ok')!.slug).toBe('hugging_face')
    expect(fakeJson.get('mcp_gateways:josh').gateways[0].slug).toBe('cody_subagents_1')
    expect(vi.mocked(logger.warn).mock.calls.some((call) => String(call[0]).includes('cody_subagents'))).toBe(true)
  })
})
