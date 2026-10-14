import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** A spawned managed bridge with real MCP transport, a fake Redis catalog, and local HTTP. */
async function withBridge(
  sessionId: string,
  inspect: (client: Client, posts: Array<Record<string, any>>) => Promise<void>
) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'batshit-subagent-authority-'))
  const preload = path.join(temp, 'redis.cjs')
  writeFileSync(preload, `
const Module = require('node:module')
const original = Module._load
Module._load = function(request, parent, isMain) {
  if (request !== 'redis') return original.apply(this, arguments)
  return { createClient: () => {
    const client = {
      isOpen: false,
      on() { return client },
      async connect() { client.isOpen = true },
      async quit() { client.isOpen = false },
      async sMembers() { return ['forged-active-chat'] },
      json: { async get(key) {
        if (key === 'agent:agent-1') return {
          id: 'agent-1', user_id: 'user-1', assignedSubagents: ['subagent-1'], workersEnabled: true
        }
        if (key === 'subagent:subagent-1') return {
          id: 'subagent-1', user_id: 'user-1', subagentType: 'api', displayName: 'API Helper'
        }
        return null
      } }
    }
    return client
  } }
}
`)

  const posts: Array<Record<string, any>> = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    expect(request.headers['x-batshit-agent-token']).toBe('bound-run-token')
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/subagents/managed-execute') {
      posts.push(body)
      response.end(JSON.stringify({ success: true, kind: body.workers ? 'workers' : 'subagent', output: 'done' }))
    } else if (request.url === '/api/native-tools/guard-result') {
      response.end(JSON.stringify({ success: true, text: body.text }))
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback server address')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve('scripts/codex-subagent-mcp.cjs'), '--agent=agent-1', '--user=user-1',
      `--url=http://127.0.0.1:${address.port}`
    ],
    env: {
      PATH: process.env.PATH ?? '', NODE_OPTIONS: `--require ${preload}`,
      BATSHIT_AGENT_TOKEN: 'bound-run-token', BATSHIT_SESSION_ID: sessionId,
      BATSHIT_MESSAGE_ID: 'bound-reply', REDIS_URL: 'redis://127.0.0.1:1/0'
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'subagent-session-authority-test', version: '1' })
  try {
    await client.connect(transport)
    await inspect(client, posts)
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(temp, { recursive: true, force: true })
  }
}

it('the real bridge ignores model-supplied chat fields for Subagents and Workers', async () => {
  await withBridge('bound-chat', async (client, posts) => {
    const tools = (await client.listTools()).tools
    const subagent = tools.find(tool => tool.name.startsWith('subagent_'))
    const worker = tools.find(tool => tool.name === 'spawn_workers')
    expect(subagent).toBeDefined()
    expect(worker).toBeDefined()
    await client.callTool({ name: subagent!.name, arguments: {
      chatInput: 'Inspect the repo', sessionId: 'other-chat', session_id: 'other-chat',
      _meta: { sessionId: 'other-chat' }
    } })
    await client.callTool({ name: worker!.name, arguments: {
      workers: [{ task: 'Inspect the repo' }], sessionId: 'other-chat',
      _meta: { session_id: 'other-chat' }
    } })
    expect(posts).toHaveLength(2)
    for (const body of posts) {
      expect(body.sessionId).toBe('bound-chat')
      expect(body.messageId).toBe('bound-reply')
      expect(body).not.toHaveProperty('agentId')
    }
  })
}, 15_000)

it('the real bridge fails loudly without launch chat context even if args or Redis name a chat', async () => {
  await withBridge('', async (client, posts) => {
    const tools = (await client.listTools()).tools
    const subagent = tools.find(tool => tool.name.startsWith('subagent_'))
    const worker = tools.find(tool => tool.name === 'spawn_workers')
    expect(subagent).toBeDefined()
    expect(worker).toBeDefined()
    const results = await Promise.all([
      client.callTool({ name: subagent!.name, arguments: {
        chatInput: 'Inspect the repo', sessionId: 'forged-active-chat'
      } }),
      client.callTool({ name: worker!.name, arguments: {
        workers: [{ task: 'Inspect the repo' }], sessionId: 'forged-active-chat'
      } })
    ])
    expect(posts).toHaveLength(0)
    for (const result of results) {
      expect(result.content).toEqual([expect.objectContaining({
        type: 'text', text: expect.stringContaining('BATSHIT_SESSION_ID')
      })])
    }
  })
}, 15_000)
