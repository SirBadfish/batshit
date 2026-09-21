import { describe, expect, it, vi } from 'vitest'

import type { MCPGateway } from '$lib/types/database'
import {
  MCP_TOOL_LIST_FAILURE_SAVED_MS,
  MCP_TOOL_LIST_SAVED_MS,
  createMcpToolListCache,
  fingerprintSecret,
  gatewayToolSettingsChanged,
  type ToolListLookup
} from '../mcpToolListCache'
import type { ToolWithName } from '../mcpGatewayTypes'

function tool(name: string): ToolWithName {
  return { name, description: `${name} tool`, inputSchema: { type: 'object' } } as unknown as ToolWithName
}

function listed(...names: string[]): ToolListLookup {
  return { ok: true, tools: names.map(tool) }
}

function names(lookup: ToolListLookup): string[] {
  return lookup.ok ? lookup.tools.map((entry) => entry.name) : []
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup() {
  let clock = 1_700_000_000_000
  const cache = createMcpToolListCache({ now: () => clock })
  return {
    cache,
    advance(ms: number) {
      clock += ms
    }
  }
}

const KEY = { userId: 'josh', gatewayId: 'gw-n8n', inputs: { type: 'n8n-instance-mcp', url: 'http://127.0.0.1:5678/mcp-server/http', token: 'fp-1' } }

describe('mcpToolListCache', () => {
  it('uses the numbers Josh was told: a good list for five minutes, a failure for thirty seconds', () => {
    expect(MCP_TOOL_LIST_SAVED_MS).toBe(300_000)
    expect(MCP_TOOL_LIST_FAILURE_SAVED_MS).toBe(30_000)
  })

  it('answers from the saved copy until five minutes have passed, then asks again', async () => {
    const { cache, advance } = setup()
    const lookup = vi.fn(async () => listed('read_file', 'write_file'))

    const first = await cache.read(KEY, lookup)
    expect(first.source).toBe('live')
    expect(names(first.lookup)).toEqual(['read_file', 'write_file'])

    advance(299_999)
    const second = await cache.read(KEY, lookup)
    expect(second.source).toBe('saved')
    expect(names(second.lookup)).toEqual(['read_file', 'write_file'])
    expect(second.fetchedAt).toBe(first.fetchedAt)
    expect(lookup).toHaveBeenCalledTimes(1)

    advance(1)
    const third = await cache.read(KEY, lookup)
    expect(third.source).toBe('live')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed lookup for thirty seconds only, and reports it as a failure every time', async () => {
    const { cache, advance } = setup()
    const lookup = vi.fn(async (): Promise<ToolListLookup> => ({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8080' }))

    const first = await cache.read(KEY, lookup)
    expect(first).toMatchObject({ source: 'live', lookup: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8080' } })

    advance(29_999)
    const second = await cache.read(KEY, lookup)
    expect(second).toMatchObject({ source: 'saved', lookup: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8080' } })
    expect(lookup).toHaveBeenCalledTimes(1)

    advance(1)
    await cache.read(KEY, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('keeps a separate copy when anything the lookup used differs, whatever the key order', async () => {
    const { cache } = setup()
    const lookup = vi.fn(async () => listed('a'))

    await cache.read(KEY, lookup)
    await cache.read({ ...KEY, inputs: { token: 'fp-1', url: KEY.inputs.url, type: KEY.inputs.type } }, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)

    await cache.read({ ...KEY, inputs: { ...KEY.inputs, token: 'fp-2' } }, lookup)
    await cache.read({ ...KEY, inputs: { ...KEY.inputs, url: 'http://127.0.0.1:5678/mcp/other' } }, lookup)
    await cache.read({ ...KEY, inputs: { ...KEY.inputs, nested: { args: ['a', 'b'] } } }, lookup)
    await cache.read({ ...KEY, inputs: { ...KEY.inputs, nested: { args: ['b', 'a'] } } }, lookup)
    expect(lookup).toHaveBeenCalledTimes(5)
  })

  it("keeps each user's and each gateway's copies apart", async () => {
    const { cache } = setup()
    const lookup = vi.fn(async () => listed('a'))

    await cache.read(KEY, lookup)
    await cache.read({ ...KEY, userId: 'someone-else' }, lookup)
    await cache.read({ ...KEY, gatewayId: 'gw-other' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('shares one running lookup between callers that arrive together', async () => {
    const { cache } = setup()
    const pending = deferred<ToolListLookup>()
    const lookup = vi.fn(() => pending.promise)

    const first = cache.read(KEY, lookup)
    const second = cache.read(KEY, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)

    pending.resolve(listed('a'))
    const [a, b] = await Promise.all([first, second])
    expect(a.source).toBe('live')
    expect(b.source).toBe('joined')
    expect(names(b.lookup)).toEqual(['a'])
  })

  it("asks again after a gateway's copies are cleared, and leaves other gateways alone", async () => {
    const { cache } = setup()
    const lookup = vi.fn(async () => listed('a'))
    const other = { ...KEY, gatewayId: 'gw-docker' }

    await cache.read(KEY, lookup)
    await cache.read({ ...KEY, inputs: { ...KEY.inputs, token: 'fp-2' } }, lookup)
    await cache.read(other, lookup)
    expect(lookup).toHaveBeenCalledTimes(3)

    cache.clearGateway('josh', 'gw-n8n')
    await cache.read(KEY, lookup)
    await cache.read({ ...KEY, inputs: { ...KEY.inputs, token: 'fp-2' } }, lookup)
    expect(lookup).toHaveBeenCalledTimes(5)
    expect((await cache.read(other, lookup)).source).toBe('saved')
    expect(lookup).toHaveBeenCalledTimes(5)
  })

  it("asks again after a user's copies are cleared, and leaves other users alone", async () => {
    const { cache } = setup()
    const lookup = vi.fn(async () => listed('a'))
    const otherUser = { ...KEY, userId: 'someone-else' }

    await cache.read(KEY, lookup)
    await cache.read({ ...KEY, gatewayId: 'gw-docker' }, lookup)
    await cache.read(otherUser, lookup)

    cache.clearUser('josh')
    await cache.read(KEY, lookup)
    await cache.read({ ...KEY, gatewayId: 'gw-docker' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(5)
    expect((await cache.read(otherUser, lookup)).source).toBe('saved')
  })

  it('never saves the answer of a lookup that started before a clear', async () => {
    for (const clear of ['gateway', 'user', 'all'] as const) {
      const { cache } = setup()
      const pending = deferred<ToolListLookup>()
      const running = cache.read(KEY, () => pending.promise)

      if (clear === 'gateway') cache.clearGateway('josh', 'gw-n8n')
      if (clear === 'user') cache.clearUser('josh')
      if (clear === 'all') cache.clearAll()
      pending.resolve(listed('from-before-the-edit'))
      // The caller that asked before the edit still gets its answer...
      expect(names((await running).lookup)).toEqual(['from-before-the-edit'])

      // ...but nobody after the edit is handed it.
      const lookup = vi.fn(async () => listed('after-the-edit'))
      const next = await cache.read(KEY, lookup)
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(names(next.lookup)).toEqual(['after-the-edit'])
    }
  })

  it('a caller arriving after a clear does not join the lookup that started before it', async () => {
    const { cache } = setup()
    const pending = deferred<ToolListLookup>()
    const running = cache.read(KEY, () => pending.promise)

    cache.clearGateway('josh', 'gw-n8n')
    const lookup = vi.fn(async () => listed('after-the-edit'))
    const next = await cache.read(KEY, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(names(next.lookup)).toEqual(['after-the-edit'])

    pending.resolve(listed('from-before-the-edit'))
    await running
    expect(names((await cache.read(KEY, lookup)).lookup)).toEqual(['after-the-edit'])
  })

  it('a fresh read asks even when a copy is saved, and its answer replaces the copy', async () => {
    const { cache } = setup()
    await cache.read(KEY, async () => listed('old'))

    const refreshed = await cache.read(KEY, async () => listed('new'), { fresh: true })
    expect(refreshed.source).toBe('live')
    expect(names(refreshed.lookup)).toEqual(['new'])

    const lookup = vi.fn(async () => listed('unused'))
    const next = await cache.read(KEY, lookup)
    expect(lookup).not.toHaveBeenCalled()
    expect(names(next.lookup)).toEqual(['new'])
  })

  it('an older lookup still running cannot overwrite the answer of a fresh read', async () => {
    const { cache } = setup()
    const slow = deferred<ToolListLookup>()
    const olderRead = cache.read(KEY, () => slow.promise)

    await cache.read(KEY, async () => listed('new'), { fresh: true })
    slow.resolve(listed('old'))
    await olderRead

    const lookup = vi.fn(async () => listed('unused'))
    expect(names((await cache.read(KEY, lookup)).lookup)).toEqual(['new'])
    expect(lookup).not.toHaveBeenCalled()
  })

  it('does not save a lookup that throws, and every waiting caller sees the throw', async () => {
    const { cache } = setup()
    const pending = deferred<ToolListLookup>()
    const first = cache.read(KEY, () => pending.promise)
    const second = cache.read(KEY, () => pending.promise)

    pending.reject(new Error('lookup crashed'))
    await expect(first).rejects.toThrow('lookup crashed')
    await expect(second).rejects.toThrow('lookup crashed')

    const lookup = vi.fn(async () => listed('a'))
    await cache.read(KEY, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('hands out a copy of the saved list, so a caller cannot change what the next caller gets', async () => {
    const { cache } = setup()
    const first = await cache.read(KEY, async () => listed('a'))
    if (first.lookup.ok) first.lookup.tools.push(tool('added-by-a-caller'))

    const second = await cache.read(KEY, async () => listed('unused'))
    expect(names(second.lookup)).toEqual(['a'])
  })

  it('throws expired copies away when it saves a new one', async () => {
    const { cache, advance } = setup()
    await cache.read(KEY, async () => listed('a'))
    await cache.read({ ...KEY, gatewayId: 'gw-docker' }, async () => ({ ok: false, error: 'down' }))
    expect(cache.size()).toBe(2)

    advance(MCP_TOOL_LIST_SAVED_MS)
    await cache.read({ ...KEY, gatewayId: 'gw-stdio' }, async () => listed('b'))
    expect(cache.size()).toBe(1)
  })
})

describe('fingerprintSecret', () => {
  it('gives no fingerprint for a missing secret', () => {
    expect(fingerprintSecret(undefined)).toBeNull()
    expect(fingerprintSecret(null)).toBeNull()
    expect(fingerprintSecret('')).toBeNull()
  })

  it('tells two secrets apart without containing either', () => {
    const one = fingerprintSecret('n8n-token-one-secret')
    const two = fingerprintSecret('n8n-token-two-secret')
    expect(one).toBe(fingerprintSecret('n8n-token-one-secret'))
    expect(one).not.toBe(two)
    expect(one).not.toContain('n8n-token-one-secret')
    expect(one).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('gatewayToolSettingsChanged', () => {
  const base: MCPGateway = {
    id: 'gw-stdio',
    name: 'Filesystem',
    type: 'stdio',
    enabled: true,
    stdioConfig: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      cwdPolicy: 'project',
      envRefs: [{ envVar: 'TOKEN', savedKeyRef: 'fs_token' }],
      startupTimeoutMs: 10_000,
      toolCallTimeoutMs: 60_000,
      lastTestStatus: 'passed',
      lastTestAt: '2026-09-18T08:00:00.000Z',
      lastError: null,
      toolCount: 14
    },
    discoveredTools: ['read_file'],
    lastDiscovery: 1,
    metadata: { dockerProfile: 'default' },
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-18T08:00:00.000Z'
  }

  it('ignores the record keeping a lookup or a test writes', () => {
    expect(
      gatewayToolSettingsChanged(base, {
        ...base,
        discoveredTools: ['read_file', 'write_file'],
        lastDiscovery: 2,
        updated_at: '2026-09-18T09:00:00.000Z',
        stdioConfig: {
          ...base.stdioConfig!,
          lastTestStatus: 'failed',
          lastTestAt: '2026-09-18T09:00:00.000Z',
          lastError: 'spawn npx ENOENT',
          toolCount: 0
        }
      })
    ).toBe(false)
  })

  it('sees every other change as the user changing the tool settings', () => {
    const edits: Array<Partial<MCPGateway>> = [
      { url: 'http://127.0.0.1:9000/mcp' },
      { type: 'custom' },
      { enabled: false },
      { authKeyName: 'huggingface' },
      { name: 'Files' },
      { metadata: { dockerProfile: 'work' } },
      { stdioConfig: { ...base.stdioConfig!, command: 'node' } },
      { stdioConfig: { ...base.stdioConfig!, args: ['server.js'] } },
      { stdioConfig: { ...base.stdioConfig!, cwdPolicy: 'none' } },
      { stdioConfig: { ...base.stdioConfig!, envRefs: [] } },
      { stdioConfig: { ...base.stdioConfig!, startupTimeoutMs: 20_000 } }
    ]
    for (const edit of edits) {
      expect(gatewayToolSettingsChanged(base, { ...base, ...edit }), JSON.stringify(edit)).toBe(true)
    }
  })

  it('counts a new or a deleted gateway as a change', () => {
    expect(gatewayToolSettingsChanged(null, base)).toBe(true)
    expect(gatewayToolSettingsChanged(base, null)).toBe(true)
  })
})
