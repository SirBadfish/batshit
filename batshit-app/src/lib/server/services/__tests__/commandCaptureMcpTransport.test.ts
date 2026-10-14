import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

it('actual managed helper strips private HTTP capture and isolates concurrent MCP calls', async () => {
  const observed: Array<{ text: string; originalTextChars: number }> = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    expect(request.headers['x-batshit-agent-token']).toBe('test-run-credential')
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/native-tools/dispatch') {
      const marker = body.input.command === 'first' ? 'A' : 'B'
      // Interleaved responses make a process-global capture variable unsafe.
      await new Promise(resolve => setTimeout(resolve, marker === 'A' ? 30 : 5))
      response.setHeader('x-batshit-command-model-capture', '1')
      response.end(JSON.stringify({
        result: { success: true, data: { success: true, stdout: `visible-${marker}`, stderr: '', exitCode: 0 } },
        modelCapture: { text: `${marker.repeat(140_000)}-RAW-TAIL`, originalTextChars: 140_009 }
      }))
    } else if (request.url === '/api/native-tools/guard-result') {
      observed.push(body)
      response.end(JSON.stringify({ success: true, text: `guarded-${body.text[0]}` }))
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
    args: [path.resolve('scripts/mode4-controls-mcp.cjs')],
    env: {
      PATH: process.env.PATH ?? '', BATSHIT_USER_ID: 'test-user', BATSHIT_AGENT_ID: 'test-agent',
      BATSHIT_SESSION_ID: 'test-session', BATSHIT_MESSAGE_ID: 'test-message',
      BATSHIT_AGENT_TOKEN: 'test-run-credential', BATSHIT_CLI_HELPER_BASE_URL: `http://127.0.0.1:${address.port}`
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'command-capture-test', version: '1' })
  try {
    await client.connect(transport)
    const [a, b] = await Promise.all(['first', 'second'].map(command => client.callTool({
      name: 'batshit_server_bash_execute', arguments: { command }
    })))
    expect(a.content).toEqual([{ type: 'text', text: 'guarded-A' }])
    expect(b.content).toEqual([{ type: 'text', text: 'guarded-B' }])
    expect(observed.map(row => row.text[0]).sort()).toEqual(['A', 'B'])
    for (const row of observed) {
      expect(row.text).toHaveLength(140_009)
      expect(row.originalTextChars).toBe(140_009)
      expect(row.text).toMatch(/-RAW-TAIL$/)
    }
    expect(JSON.stringify([a, b])).not.toMatch(/modelCapture|RAW-TAIL|visible-/)
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 15_000)
