import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// BL-454, end to end on a real STDIO MCP server: the real `@ai-sdk/mcp` client and the real
// STDIO transport. A Stop mid-call must end the per-call server process before its slow tool
// lands its side effect; before the fix it ran on to the tool-call timeout.

const require = createRequire(import.meta.url)
const workDir = mkdtempSync(join(tmpdir(), 'bl454-stdio-'))
const pidFile = join(workDir, 'pid')
const sideEffectFile = join(workDir, 'side-effect')
const serverScript = join(workDir, 'slow-server.cjs')

const mocks = vi.hoisted(() => ({ list: vi.fn(), scriptPath: { value: '' } }))

vi.mock('../mcpGatewayService', () => ({ mcpGatewayService: { list: mocks.list } }))
vi.mock('../dockerMCPGatewayClient', () => ({ dockerMCPGatewayClient: { discoverTools: vi.fn() } }))
vi.mock('../n8nMCPGatewayClient', () => ({ n8nMCPGatewayClient: { discoverTools: vi.fn() } }))
vi.mock('../dockerGatewayConfig', () => ({
  buildDockerGatewayHeaders: () => ({}),
  buildDockerGatewayUrl: (path: string) => `http://localhost:8811${path}`
}))
vi.mock('../mcpGatewayPolicy', () => ({
  getBlockedBatshitServerGatewayReason: () => 'blocked',
  isBlockedBatshitServerGatewayUrl: () => false
}))
vi.mock('../runtimeUrlRewrites', () => ({ rewriteN8nGatewayUrlForRuntime: (url: string) => url }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: vi.fn() } }))
vi.mock('../mcpGatewayStdio', () => ({
  resolveStdioGatewayProcessConfig: vi.fn(async () => ({
    command: process.execPath,
    args: [mocks.scriptPath.value],
    cwd: undefined,
    env: {},
    startupTimeoutMs: 10_000,
    toolCallTimeoutMs: 60_000
  }))
}))
vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { mcpGatewayDiscovery } from '../mcpGatewayDiscovery'

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('STDIO gateway process on a Stop (BL-454)', () => {
  beforeAll(() => {
    const serverPath = require.resolve('@modelcontextprotocol/sdk/server/index.js')
    const stdioPath = require.resolve('@modelcontextprotocol/sdk/server/stdio.js')
    const typesPath = require.resolve('@modelcontextprotocol/sdk/types.js')
    writeFileSync(
      serverScript,
      [
        `const fs = require('fs')`,
        `const { Server } = require(${JSON.stringify(serverPath)})`,
        `const { StdioServerTransport } = require(${JSON.stringify(stdioPath)})`,
        `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(typesPath)})`,
        `const server = new Server({ name: 'slow', version: '1.0.0' }, { capabilities: { tools: {} } })`,
        `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'remote_write', description: 'Slow write', inputSchema: { type: 'object', properties: {} } }] }))`,
        `server.setRequestHandler(CallToolRequestSchema, async () => {`,
        `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
        `  await new Promise((resolve) => setTimeout(resolve, 20000))`,
        `  fs.writeFileSync(${JSON.stringify(sideEffectFile)}, 'landed')`,
        `  return { content: [{ type: 'text', text: 'late' }] }`,
        `})`,
        `server.connect(new StdioServerTransport())`
      ].join('\n')
    )
    mocks.scriptPath.value = serverScript
    mocks.list.mockResolvedValue([
      {
        id: 'gw-slow',
        name: 'Slow',
        type: 'stdio',
        enabled: true,
        stdioConfig: { command: 'node', cwdPolicy: 'project' }
      }
    ])
  })

  afterAll(() => {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (processIsAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    rmSync(workDir, { recursive: true, force: true })
  })

  it('a Stop ends the per-call server process before its side effect lands', async () => {
    const { tools } = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-slow'], undefined, {
      skipFiltering: true
    })
    const wrapped = tools.remote_write as any
    expect(typeof wrapped?.execute).toBe('function')

    const controller = new AbortController()
    const call = wrapped.execute({}, { abortSignal: controller.signal, toolCallId: 't1', messages: [] })
    const settled = call.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(processIsAlive(pid)).toBe(true)

    const stoppedAt = Date.now()
    controller.abort(new Error('stopped'))
    expect(await settled).toMatch(/aborted/i)
    // The call answers at once; the process close runs on behind it.
    expect(Date.now() - stoppedAt).toBeLessThan(1_500)
    // The transport ends stdin, then SIGTERMs after 2 s; nowhere near the 20 s tool.
    await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 6_000 })
    expect(Date.now() - stoppedAt).toBeLessThan(6_000)
    expect(existsSync(sideEffectFile)).toBe(false)
  }, 30_000)
})
