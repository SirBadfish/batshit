import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

it('cuts final escaped memory MCP text without creating a raw copy or crossing another call', async () => {
  const guardPosts: string[] = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    expect(request.headers['x-batshit-agent-token']).toBe('memory-test-run')
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/controls/use') {
      const memory = body.controlId === 'sys.memory.search'
      await new Promise(resolve => setTimeout(resolve, memory ? 20 : 5))
      if (memory) response.setHeader('x-batshit-memory-no-retain', '1')
      response.end(JSON.stringify({
        success: true,
        controlId: body.controlId,
        result: { text: '\u0001'.repeat(22_000) }
      }))
      return
    }
    if (request.url === '/api/native-tools/guard-result') {
      guardPosts.push(body.text)
      response.end(JSON.stringify({ success: true, text: 'ordinary guarded' }))
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback server address')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('scripts/mode4-controls-mcp.cjs')],
    env: {
      PATH: process.env.PATH ?? '', BATSHIT_USER_ID: 'test-user', BATSHIT_AGENT_ID: 'test-agent',
      BATSHIT_SESSION_ID: 'test-session', BATSHIT_MESSAGE_ID: 'test-message',
      BATSHIT_AGENT_TOKEN: 'memory-test-run', BATSHIT_CLI_HELPER_BASE_URL: `http://127.0.0.1:${address.port}`
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'memory-no-retain-test', version: '1' })
  try {
    await client.connect(transport)
    const [memory, ordinary] = await Promise.all([
      client.callTool({ name: 'batshit_tool_use', arguments: {
        ref: 'fabric:sys.memory.search', input: { query: 'one' }
      } }),
      client.callTool({ name: 'batshit_tool_use', arguments: {
        ref: 'fabric:sys.dm.read', input: { dmId: 'one' }
      } })
    ])
    const memoryText = memory.content.find((part: any) => part.type === 'text')?.text ?? ''
    expect(memoryText.length).toBeLessThanOrEqual(100_000)
    expect(memoryText).toContain('Search again with a narrower query')
    expect(memoryText).not.toMatch(/zipId|Fetch Zip|retained-copy/)
    expect(ordinary.content).toEqual([{ type: 'text', text: 'ordinary guarded' }])
    expect(guardPosts).toHaveLength(1)
    expect(guardPosts[0]).toContain('sys.dm.read')
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 15_000)
