import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * SA-116 DL-116-07 — the managed CLI helper forwards the assistant message id.
 *
 * Black-box, because that is where the claim lives: the helper is a separate process, its
 * identity comes from `--flags` and env, and the thing that must be true is what lands in
 * the HTTP body of a real `/api/controls/use` call. A unit test of the payload builder
 * would not have caught an env variable the profile forgot to forward, which is exactly the
 * failure this closes.
 *
 * The helper is spawned against a throwaway HTTP server standing in for Batshit.
 */

const HELPER = path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs')

let server: http.Server
let baseUrl: string
const received: Array<{ url: string; body: any; headers: Record<string, any> }> = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body: any = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { raw }
      }
      received.push({ url: req.url ?? '', body, headers: req.headers as Record<string, any> })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function callHelper(
  toolName: string,
  args: Record<string, any>,
  env: Record<string, string>
): Promise<void> {
  received.length = 0
  const child = spawn(
    process.execPath,
    [HELPER, '--agent=agent-1', '--user=user-1', `--url=${baseUrl}`, '--runtime=codex'],
    {
      env: {
        ...process.env,
        // SA-117 DL-117-06/07: the managed run exports its credential and NOT the instance
        // token — `codexBridge.ts` and `claudeBridge.ts` delete that from the child env.
        BATSHIT_AGENT_TOKEN: 'arc_testcredential.bsac_testsecret',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )

  const done = new Promise<void>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('mode4 helper did not answer in time'))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        let message: any = null
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message?.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolve()
          return
        }
      }
    })
    child.on('error', reject)
  })

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    }) + '\n'
  )
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    }) + '\n'
  )

  await done
}

describe('the mode4 controls helper', () => {
  it('sends BATSHIT_MESSAGE_ID as messageId on a control call, so a pause can raise a card', async () => {
    await callHelper(
      'mcp_fabric_use',
      { controlId: 'sys.memory.delete', input: { memoryId: 'mem_1' } },
      {
        BATSHIT_SESSION_ID: 'session-1',
        BATSHIT_MESSAGE_ID: 'msg_20260910-120000_0002'
      }
    )

    const call = received.find((entry) => entry.url === '/api/controls/use')
    expect(call).toBeTruthy()
    expect(call?.body?.messageId).toBe('msg_20260910-120000_0002')
    expect(call?.body?.sessionId).toBe('session-1')
  }, 30000)

  it('sends it on a cli: ref too, so a risky user CLI tool gets the same card', async () => {
    await callHelper(
      'batshit_tool_use',
      { ref: 'cli:repo_snapshot', input: { query: 'x' } },
      {
        BATSHIT_SESSION_ID: 'session-1',
        BATSHIT_MESSAGE_ID: 'msg_20260910-120000_0002'
      }
    )

    const call = received.find((entry) => entry.url === '/api/cli-tools/execute')
    expect(call).toBeTruthy()
    expect(call?.body?.messageId).toBe('msg_20260910-120000_0002')
    expect(call?.body?.sessionId).toBe('session-1')
  }, 30000)

  it('sends no messageId when the env variable is an un-expanded placeholder', async () => {
    // The Claude profile passes env through a `${VAR}` map. A placeholder is not an id, and
    // sending it would spend a Redis read being rejected.
    await callHelper(
      'mcp_fabric_use',
      { controlId: 'sys.memory.delete', input: { memoryId: 'mem_1' } },
      {
        BATSHIT_SESSION_ID: 'session-1',
        BATSHIT_MESSAGE_ID: '${BATSHIT_MESSAGE_ID}'
      }
    )

    const call = received.find((entry) => entry.url === '/api/controls/use')
    expect(call).toBeTruthy()
    expect(call?.body?.messageId).toBeUndefined()
  }, 30000)

  /* ---------------------------------------------------------------------- *
   * SA-117 P2 (DL-117-08) — the helper's handshake, black-box on the wire.
   * ---------------------------------------------------------------------- */

  it('presents the run credential and stops claiming an identity in the body', async () => {
    await callHelper(
      'mcp_fabric_use',
      { controlId: 'sys.memory.delete', input: { memoryId: 'mem_1' } },
      { BATSHIT_SESSION_ID: 'session-1' }
    )

    const call = received.find((entry) => entry.url === '/api/controls/use')
    expect(call).toBeTruthy()
    expect(call?.headers['x-batshit-agent-token']).toBe('arc_testcredential.bsac_testsecret')
    // The instance token and the user header went with it. On the service lane that header
    // was simply whatever the caller typed, which is the claim SA-117 stopped believing.
    expect(call?.headers['x-batshit-service-token']).toBeUndefined()
    expect(call?.headers['x-batshit-user-id']).toBeUndefined()
    // DL-117-04: the body names neither, because a differing one is now a 400 and the
    // server reads both off the credential anyway.
    expect(call?.body).not.toHaveProperty('userId')
    expect(call?.body).not.toHaveProperty('agentId')
    // What the body still carries: the call itself.
    expect(call?.body?.controlId).toBe('sys.memory.delete')
    expect(call?.body?.sessionId).toBe('session-1')
  }, 30000)

  it('fails loudly at startup with no credential, instead of starting and erroring per call', async () => {
    const child = spawn(
      process.execPath,
      [HELPER, '--agent=agent-1', '--user=user-1', `--url=${baseUrl}`, '--runtime=codex'],
      {
        env: (() => {
          const next = { ...process.env }
          delete next.BATSHIT_AGENT_TOKEN
          delete next.BATSHIT_TOKEN
          return next
        })(),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('BATSHIT_AGENT_TOKEN')
  }, 30000)

  it('treats an un-expanded ${VAR} placeholder as no credential at all', async () => {
    // The Claude profile writes a literal `${BATSHIT_AGENT_TOKEN}` map entry. An unset
    // variable arrives as its own placeholder, and a placeholder is not a credential — the
    // same rule the message id already followed.
    const child = spawn(
      process.execPath,
      [HELPER, '--agent=agent-1', '--user=user-1', `--url=${baseUrl}`, '--runtime=claude'],
      {
        env: { ...process.env, BATSHIT_AGENT_TOKEN: '${BATSHIT_AGENT_TOKEN}' },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('BATSHIT_AGENT_TOKEN')
  }, 30000)
})
