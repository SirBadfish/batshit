/**
 * BL-550: the STDIO record keeping (`lastTestStatus`, `lastTestAt`, `lastError`, `toolCount`)
 * belongs to the Refresh and Test check. A settings save that sends the launch keeps the stored
 * record keeping, whatever its copy says (`update`), and the check writes only its own fields
 * (`recordStdioCheckResult`, whose Lua runs on real Redis in `check-keeps-launch-edit.test.ts`;
 * here only the call it makes and how it reads the answer).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({ execute: vi.fn(), json: {} as Record<string, unknown> }))

vi.mock('$lib/server/redis', () => ({ redis: redisMock }))
vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { RECORD_STDIO_CHECK_SCRIPT, mcpGatewayService } from '../mcpGatewayService'
import { mcpToolListCache } from '../mcpToolListCache'
import { createJsonCompareAndWriteTwinsForMap } from '$lib/test-utils/redisJsonCompareAndWriteTwin'

const USER = 'bl550_user'
const KEY = `mcp_gateways:${USER}`
const STDIO = {
  id: 'gw-stdio',
  name: 'Filesystem',
  type: 'stdio' as const,
  enabled: true,
  stdioConfig: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    cwdPolicy: 'none' as const
  },
  created_at: '2026-10-01T00:00:00.000Z'
}

function createFakeRedis(evalAnswer: unknown = 'OK') {
  const json = new Map<string, any>()
  const client = {
    json: {
      get: vi.fn(async (key: string) => (json.has(key) ? structuredClone(json.get(key)) : null)),
      set: vi.fn(async (key: string, _path: string, value: any) => {
        json.set(key, structuredClone(value))
        return 'OK'
      })
    },
    eval: vi.fn(async () => evalAnswer)
  }
  redisMock.execute.mockImplementation(async (fn: (c: typeof client) => any) => fn(client))
  // BL-1371: the service's registry writes are the facade's compare-and-set over the same store.
  Object.assign(redisMock.json, createJsonCompareAndWriteTwinsForMap(json))
  return { json, client }
}

function storedStdio(json: Map<string, any>) {
  return json.get(KEY).gateways.find((gateway: any) => gateway.id === STDIO.id).stdioConfig
}

beforeEach(() => {
  vi.clearAllMocks()
  mcpToolListCache.clearAll()
})

describe('BL-550: a settings save never writes the check result', () => {
  it('keeps the stored result when the save carries an older one', async () => {
    const { json } = createFakeRedis()
    await mcpGatewayService.create(USER, structuredClone(STDIO))
    // What a Refresh stored while the settings form still held the gateway it loaded.
    storedStdio(json).lastTestStatus = 'passed'
    storedStdio(json).lastTestAt = '2026-10-11T15:00:00.000Z'
    storedStdio(json).lastError = null
    storedStdio(json).toolCount = 14

    await mcpGatewayService.update(USER, STDIO.id, {
      stdioConfig: {
        ...STDIO.stdioConfig,
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example'],
        lastTestStatus: 'never',
        lastError: 'old failure',
        toolCount: 3
      }
    })

    expect(storedStdio(json)).toMatchObject({
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example'],
      lastTestStatus: 'passed',
      lastTestAt: '2026-10-11T15:00:00.000Z',
      lastError: null,
      toolCount: 14
    })
  })

  it('writes no result at all when none is stored, whatever the save carries', async () => {
    const { json } = createFakeRedis()
    await mcpGatewayService.create(USER, structuredClone(STDIO))

    await mcpGatewayService.update(USER, STDIO.id, {
      stdioConfig: { ...STDIO.stdioConfig, lastTestStatus: 'passed', toolCount: 5, lastError: null }
    })

    const stored = storedStdio(json)
    expect(stored).not.toHaveProperty('lastTestStatus')
    expect(stored).not.toHaveProperty('toolCount')
    expect(stored).not.toHaveProperty('lastError')
  })

  it('a save without the launch leaves the stored launch and result alone', async () => {
    const { json } = createFakeRedis()
    await mcpGatewayService.create(USER, structuredClone(STDIO))
    storedStdio(json).lastTestStatus = 'failed'

    await mcpGatewayService.update(USER, STDIO.id, { name: 'Files' })

    expect(storedStdio(json)).toMatchObject({ args: STDIO.stdioConfig.args, lastTestStatus: 'failed' })
  })
})

describe('BL-550: recordStdioCheckResult sends only the check fields', () => {
  it('sends the gateway id and each given field as JSON text, the error first, skipping fields left out', async () => {
    const { client } = createFakeRedis('OK')

    const answer = await mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, {
      lastTestStatus: 'failed',
      lastTestAt: '2026-10-11T15:00:00.000Z',
      lastError: 'spawn npx ENOENT',
      toolCount: undefined
    })

    expect(answer).toBe('OK')
    expect(client.eval).toHaveBeenCalledWith(RECORD_STDIO_CHECK_SCRIPT, {
      keys: [KEY],
      arguments: [
        STDIO.id,
        'lastError',
        '"spawn npx ENOENT"',
        'lastTestStatus',
        '"failed"',
        'lastTestAt',
        '"2026-10-11T15:00:00.000Z"'
      ]
    })
  })

  it('stores the error trimmed, an empty one as none, and a lone UTF-16 half as U+FFFD', async () => {
    const { client } = createFakeRedis('OK')

    await mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastError: '  timed out \n' })
    await mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastError: '   ' })
    await mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastError: 'bad \uD800 byte' })

    const sentErrors = client.eval.mock.calls.map((call: any[]) => call[1].arguments[2])
    expect(sentErrors).toEqual(['"timed out"', 'null', JSON.stringify('bad � byte')])
  })

  it('writes a cleared error as JSON null and a count as a number', async () => {
    const { client } = createFakeRedis('OK')

    await mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastError: null, toolCount: 2 })

    expect((client.eval.mock.calls[0] as any[])[1].arguments).toEqual([
      STDIO.id,
      'lastError',
      'null',
      'toolCount',
      '2'
    ])
  })

  it('refuses a field that is not a check field before it reaches Redis', async () => {
    const { client } = createFakeRedis('OK')

    await expect(
      mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { args: ['x'] } as any)
    ).rejects.toThrow('args is not a STDIO check field')
    expect(client.eval).not.toHaveBeenCalled()
  })

  it('reads MISSING as "not found" and NOT_STDIO as nothing written', async () => {
    createFakeRedis('MISSING')
    await expect(
      mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastTestStatus: 'passed' })
    ).rejects.toThrow(`Gateway with ID ${STDIO.id} not found`)

    createFakeRedis('NOT_STDIO')
    await expect(
      mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastTestStatus: 'passed' })
    ).resolves.toBe('NOT_STDIO')

    createFakeRedis(null)
    await expect(
      mcpGatewayService.recordStdioCheckResult(USER, STDIO.id, { lastTestStatus: 'passed' })
    ).rejects.toThrow('answered null')
  })

  it('the script names no field of its own: it writes only the names it is given', () => {
    for (const launchField of ['command', 'args', 'cwdPolicy', 'cwdValue', 'envRefs', 'startupTimeoutMs']) {
      expect(RECORD_STDIO_CHECK_SCRIPT).not.toContain(launchField)
    }
    expect(RECORD_STDIO_CHECK_SCRIPT).not.toMatch(/JSON\.SET', KEYS\[1\], '\$'/)
  })
})
