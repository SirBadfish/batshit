import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// BL-602, on a real STDIO MCP server process: a start that runs past the gateway's startup
// timeout must end the server process. Before the fix the timeout only rejected; the pending
// client and its process stayed open, and a server that answered late left a started client
// nobody would ever close.

const require = createRequire(import.meta.url)
const workDir = mkdtempSync(join(tmpdir(), 'bl602-stdio-'))
const serverScript = join(workDir, 'late-server.cjs')
const pidFiles: string[] = []

const mocks = vi.hoisted(() => ({ pidFile: { value: '' }, script: { value: '' } }))

vi.mock('../mcpGatewayStdio', () => ({
  resolveStdioGatewayProcessConfig: vi.fn(async () => ({
    command: process.execPath,
    args: [mocks.script.value, mocks.pidFile.value],
    cwd: undefined,
    env: {},
    // The shortest a gateway may set; the server below answers only after 1.5 s.
    startupTimeoutMs: 1_000,
    toolCallTimeoutMs: 60_000
  }))
}))
vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { stdioMCPGatewayClient } from '../stdioMCPGatewayClient'

const gateway = {
  id: 'gw-late',
  name: 'Late',
  type: 'stdio',
  enabled: true,
  stdioConfig: { command: 'node' }
} as any

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function usePidFile(name: string): string {
  const file = join(workDir, name)
  pidFiles.push(file)
  mocks.pidFile.value = file
  return file
}

async function startedPid(file: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 5_000 })
  return Number(readFileSync(file, 'utf8'))
}

describe('STDIO gateway start that times out (BL-602)', () => {
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
        `const { ListToolsRequestSchema } = require(${JSON.stringify(typesPath)})`,
        `fs.writeFileSync(process.argv[2], String(process.pid))`,
        // A slow start: the server connects (and answers initialize) only after 1.5 s.
        `setTimeout(() => {`,
        `  const server = new Server({ name: 'late', version: '1.0.0' }, { capabilities: { tools: {} } })`,
        `  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))`,
        `  server.connect(new StdioServerTransport())`,
        `}, 1500)`
      ].join('\n')
    )
    mocks.script.value = serverScript
  })

  afterAll(() => {
    for (const file of pidFiles) {
      if (!existsSync(file)) continue
      const pid = Number(readFileSync(file, 'utf8'))
      if (processIsAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    rmSync(workDir, { recursive: true, force: true })
  })

  it('createClient: the timeout ends the server process and leaves no started client', async () => {
    const pidFile = usePidFile('create.pid')
    const startedAt = Date.now()
    await expect(stdioMCPGatewayClient.createClient({ gateway })).rejects.toThrow(
      /STDIO client startup timed out after 1000ms/
    )
    // The error comes at the timeout, not after the close.
    expect(Date.now() - startedAt).toBeLessThan(2_500)
    const pid = await startedPid(pidFile)
    // stdin end, then SIGTERM 2 s later; the late answer at 1.5 s must not keep it.
    await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 6_000 })
  }, 15_000)

  it('discoverTools: the timeout ends the server process', async () => {
    const pidFile = usePidFile('discover.pid')
    await expect(stdioMCPGatewayClient.discoverTools({ gateway })).rejects.toThrow(
      /STDIO tool discovery timed out after 1000ms/
    )
    const pid = await startedPid(pidFile)
    await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 6_000 })
  }, 15_000)

  it('healthCheck: the timeout ends the server process', async () => {
    const pidFile = usePidFile('health.pid')
    await expect(stdioMCPGatewayClient.healthCheck({ gateway })).resolves.toMatchObject({
      available: false,
      error: expect.stringMatching(/STDIO health check timed out after 1000ms/)
    })
    const pid = await startedPid(pidFile)
    await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 6_000 })
  }, 15_000)
})
